//! Codex CLI adapter (`codex exec --json`).

use std::path::PathBuf;

use anyhow::Result;
use serde_json::Value;

use super::*;
use crate::env::ShellEnv;

#[derive(Default)]
pub struct Codex {
    produced_text: bool,
}

fn resolve(env: &ShellEnv) -> Option<PathBuf> {
    env.path_lookup("codex")
}

const FALLBACK_MODELS: &[(&str, &str)] = &[
    ("gpt-5.4", "Latest frontier agentic coding model"),
    ("gpt-5.4-mini", "Smaller · faster"),
    ("gpt-5.3-codex", "Tuned for code"),
];

impl AgentAdapter for Codex {
    fn id(&self) -> AgentId {
        AgentId::Codex
    }

    fn info(&self, env: &ShellEnv) -> AgentInfo {
        let path = resolve(env);
        let version = path.as_ref().and_then(|p| probe_version(env, p, &["--version"])).map(|v| {
            // "codex-cli 0.118.0" → "0.118.0"
            v.split_whitespace().last().unwrap_or(&v).to_string()
        });
        AgentInfo {
            id: AgentId::Codex,
            name: display_name(AgentId::Codex).into(),
            command: command_name(AgentId::Codex).into(),
            monogram: monogram(AgentId::Codex).into(),
            available: path.is_some(),
            path: path.map(|p| p.to_string_lossy().to_string()),
            version,
            supports_model_select: true,
            supports_web_search: true,
        }
    }

    /// Codex caches the model catalogue it fetched last in
    /// `~/.codex/models_cache.json`; `config.toml`'s top-level `model` names the default.
    fn models(&self, _env: &ShellEnv) -> Vec<ModelInfo> {
        let configured = std::fs::read_to_string(home_file(".codex/config.toml"))
            .ok()
            .and_then(|toml| {
                toml.lines()
                    .map(str::trim)
                    .take_while(|l| !l.starts_with('['))
                    .find_map(|l| {
                        let (k, v) = l.split_once('=')?;
                        (k.trim() == "model").then(|| v.trim().trim_matches('"').to_string())
                    })
            });
        let mut out: Vec<ModelInfo> = read_json_file(&home_file(".codex/models_cache.json"))
            .and_then(|v| v.get("models").and_then(Value::as_array).cloned())
            .map(|models| {
                models
                    .iter()
                    .filter(|m| str_of(m, "visibility").unwrap_or("list") == "list")
                    .filter_map(|m| {
                        let slug = str_of(m, "slug")?;
                        Some(ModelInfo {
                            id: slug.to_string(),
                            name: str_of(m, "display_name").unwrap_or(slug).to_string(),
                            note: str_of(m, "description").map(str::to_string),
                            context: None,
                            is_default: false,
                        })
                    })
                    .collect()
            })
            .filter(|v: &Vec<ModelInfo>| !v.is_empty())
            .unwrap_or_else(|| {
                FALLBACK_MODELS
                    .iter()
                    .map(|(id, note)| ModelInfo {
                        id: id.to_string(),
                        name: id.to_string(),
                        note: Some(note.to_string()),
                        context: None,
                        is_default: false,
                    })
                    .collect()
            });
        let idx = configured
            .and_then(|c| out.iter().position(|m| m.id == c))
            .unwrap_or(0);
        if let Some(m) = out.get_mut(idx) {
            m.is_default = true;
        }
        out
    }

    fn build_command(&self, req: &SpawnRequest, env: &ShellEnv) -> Result<CommandSpec> {
        let program = require_binary(env, AgentId::Codex, resolve)?;
        let mut args: Vec<String> = vec!["exec".into()];
        if let Some(tid) = &req.agent_session_id {
            args.extend(["resume".into(), tid.clone()]);
        }
        args.extend([
            "--json".into(),
            "--sandbox".into(),
            "read-only".into(),
            "--ask-for-approval".into(),
            "never".into(),
        ]);
        if req.web_search {
            args.push("--search".into());
        }
        if let Some(model) = req.model.as_deref().filter(|m| !m.is_empty()) {
            args.extend(["--model".into(), model.to_string()]);
        }
        for img in &req.images {
            args.extend(["--image".into(), img.path.to_string_lossy().to_string()]);
        }
        args.push(req.prompt.clone());
        Ok(CommandSpec {
            program,
            args,
            env: vec![],
            cwd: req.cwd.clone(),
            stdin: None,
        })
    }

    fn parse_line(&mut self, line: &str) -> Vec<AgentEvent> {
        let Some(v) = parse_json(line) else {
            return vec![activity(ActivityKind::Status, crate::prompt::truncate(line.trim(), 160))];
        };
        match str_of(&v, "type").unwrap_or("") {
            "thread.started" => match str_of(&v, "thread_id") {
                Some(id) => vec![AgentEvent::Session { id: id.to_string(), model: None }],
                None => vec![],
            },
            "item.started" | "item.updated" | "item.completed" => {
                let completed = str_of(&v, "type") == Some("item.completed");
                let item = v.get("item").unwrap_or(&Value::Null);
                self.item(item, completed)
            }
            "turn.completed" => {
                let usage = v.get("usage").unwrap_or(&Value::Null);
                vec![
                    AgentEvent::Usage(Usage {
                        input_tokens: u64_of(usage, "input_tokens"),
                        output_tokens: u64_of(usage, "output_tokens"),
                        cost_usd: None,
                        duration_ms: None,
                    }),
                    AgentEvent::Done,
                ]
            }
            "turn.failed" | "error" => {
                let msg = str_of(&v, "message")
                    .map(str::to_string)
                    .or_else(|| v.get("error").and_then(|e| str_of(e, "message")).map(str::to_string))
                    .unwrap_or_else(|| "Codex reported an error".into());
                vec![AgentEvent::Error(msg)]
            }
            _ => vec![],
        }
    }
}

impl Codex {
    fn item(&mut self, item: &Value, completed: bool) -> Vec<AgentEvent> {
        match str_of(item, "type").unwrap_or("") {
            "agent_message" => {
                if !completed {
                    return vec![];
                }
                let text = str_of(item, "text").unwrap_or("");
                if text.is_empty() {
                    return vec![];
                }
                let mut out = Vec::new();
                if self.produced_text {
                    out.push(AgentEvent::Append("\n\n".into()));
                }
                self.produced_text = true;
                out.push(AgentEvent::Append(text.to_string()));
                out
            }
            "reasoning" => {
                if completed {
                    vec![]
                } else {
                    vec![activity(ActivityKind::Thinking, "Thinking")]
                }
            }
            "command_execution" => {
                if completed {
                    return vec![];
                }
                let cmd = str_of(item, "command").unwrap_or("");
                vec![activity(ActivityKind::Tool, format!("shell: {}", crate::prompt::truncate(cmd, 80)))]
            }
            "web_search" => {
                if completed {
                    return vec![];
                }
                let q = str_of(item, "query").unwrap_or("");
                vec![activity(ActivityKind::Tool, if q.is_empty() { "Web search".to_string() } else { format!("Web search: {}", crate::prompt::truncate(q, 80)) })]
            }
            "mcp_tool_call" => {
                if completed {
                    return vec![];
                }
                vec![activity(ActivityKind::Tool, str_of(item, "tool").unwrap_or("tool"))]
            }
            _ => vec![],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::testutil::*;
    use super::*;

    #[test]
    fn parses_recorded_exec_stream() {
        let mut a = Codex::default();
        let events = run(&mut a, &fixture("codex_exec.jsonl"));
        assert_eq!(events[0], AgentEvent::Session { id: "019d5324-d8b3-7353-b3a8-a96df1f97ac1".into(), model: None });
        let text = text_of(&events);
        assert!(text.starts_with("I’m going to map the repository structure"));
        assert!(text.contains("\n\nI’ve confirmed this is a multi-part repo"));
        assert!(events.iter().any(|e| matches!(e, AgentEvent::Activity { kind: ActivityKind::Tool, label } if label.starts_with("shell: /bin/bash -lc pwd"))));
    }

    #[test]
    fn turn_completed_and_errors() {
        let mut a = Codex::default();
        let events = run(&mut a, "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":12,\"output_tokens\":3}}\n{\"type\":\"error\",\"message\":\"boom\"}");
        assert!(matches!(&events[0], AgentEvent::Usage(u) if u.input_tokens == Some(12)));
        assert_eq!(events[1], AgentEvent::Done);
        assert_eq!(events[2], AgentEvent::Error("boom".into()));
    }

    #[test]
    fn command_line_shapes() {
        let env = ShellEnv::from_process();
        let a = Codex::default();
        // Codex is not required to be installed; test the args through a fake PATH entry.
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("codex");
        std::fs::write(&fake, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let mut env = env;
        let mut dirs = vec![dir.path().to_path_buf()];
        dirs.extend(env.path_dirs());
        let joined = std::env::join_paths(&dirs).unwrap().to_string_lossy().into_owned();
        env.vars.insert("PATH".into(), joined);
        let spec = a.build_command(&req("hi"), &env).unwrap();
        assert_eq!(spec.args[..2], ["exec", "--json"]);
        assert!(spec.args.contains(&"--search".to_string()));
        assert_eq!(spec.args.last().unwrap(), "hi");
        let mut r = req("more");
        r.agent_session_id = Some("t1".into());
        r.web_search = false;
        let spec = a.build_command(&r, &env).unwrap();
        assert_eq!(spec.args[..3], ["exec", "resume", "t1"]);
        assert!(!spec.args.contains(&"--search".to_string()));
        let spec = a.build_command(&req_with_image("look"), &env).unwrap();
        assert!(spec.args.windows(2).any(|w| w[0] == "--image" && w[1].ends_with("red.png")));
        assert_eq!(spec.args.last().unwrap(), "look");
    }
}
