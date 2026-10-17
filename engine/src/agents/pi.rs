//! Pi adapter (`pi -p --mode json`).

use std::path::PathBuf;
use std::time::Duration;

use anyhow::Result;
use serde_json::Value;

use super::*;
use crate::env::ShellEnv;

#[derive(Default)]
pub struct Pi {
    produced_text: bool,
    thinking_announced: bool,
    tool_announced: bool,
}

fn resolve(env: &ShellEnv) -> Option<PathBuf> {
    env.path_lookup("pi")
}

impl AgentAdapter for Pi {
    fn id(&self) -> AgentId {
        AgentId::Pi
    }

    fn info(&self, env: &ShellEnv) -> AgentInfo {
        let path = resolve(env);
        let version = path.as_ref().and_then(|p| probe_version(env, p, &["--version"]));
        AgentInfo {
            id: AgentId::Pi,
            name: display_name(AgentId::Pi).into(),
            command: command_name(AgentId::Pi).into(),
            monogram: monogram(AgentId::Pi).into(),
            available: path.is_some(),
            path: path.map(|p| p.to_string_lossy().to_string()),
            version,
            supports_model_select: true,
            supports_web_search: false,
        }
    }

    /// `pi --list-models` prints a table whose rows are provider, model,
    /// context, max-out, thinking, images separated by runs of spaces.
    fn models(&self, env: &ShellEnv) -> Vec<ModelInfo> {
        let Some(path) = resolve(env) else { return vec![] };
        let Some(out) = capture_text(env, &path, &["--list-models"], Duration::from_secs(8)) else {
            return vec![];
        };
        let settings = read_json_file(&home_file(".pi/agent/settings.json"));
        let default_id = settings.as_ref().and_then(|s| {
            Some(format!("{}/{}", str_of(s, "defaultProvider")?, str_of(s, "defaultModel")?))
        });
        parse_pi_models(&out, default_id.as_deref())
    }

    fn build_command(&self, req: &SpawnRequest, env: &ShellEnv) -> Result<CommandSpec> {
        let program = require_binary(env, AgentId::Pi, resolve)?;
        let mut args: Vec<String> = vec!["-p".into(), "--mode".into(), "json".into()];
        // Inside a project folder Pi gets its read-only file tools; elsewhere none.
        if req.project {
            args.extend(["--tools".into(), "read,grep,find,ls".into()]);
        } else {
            args.push("--no-tools".into());
        }
        args.extend(["--session-dir".into(), req.pi_session_dir.to_string_lossy().to_string()]);
        match &req.agent_session_id {
            Some(sid) => args.extend(["--session".into(), sid.clone()]),
            None => args.extend(["--session-id".into(), req.new_session_id.clone()]),
        }
        if let Some(model) = req.model.as_deref().filter(|m| !m.is_empty()) {
            args.extend(["--model".into(), model.to_string()]);
        }
        if !req.system_note.is_empty() {
            args.extend(["--append-system-prompt".into(), req.system_note.clone()]);
        }
        if let Some(title) = req.title.as_deref().filter(|t| !t.is_empty()) {
            if req.agent_session_id.is_none() {
                args.extend(["--name".into(), title.to_string()]);
            }
        }
        // `@path` arguments ahead of the message attach files; Pi sends
        // images to the model as image content.
        for img in &req.images {
            args.push(format!("@{}", req.relative_image_path(img)));
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
            "session" => match str_of(&v, "id") {
                Some(id) => vec![AgentEvent::Session { id: id.to_string(), model: None }],
                None => vec![],
            },
            "message_start" => {
                let msg = v.get("message").unwrap_or(&Value::Null);
                if str_of(msg, "role") == Some("assistant") {
                    self.thinking_announced = false;
                    self.tool_announced = false;
                    if let Some(model) = str_of(msg, "model") {
                        let full = match str_of(msg, "provider") {
                            Some(p) => format!("{}/{}", p, model),
                            None => model.to_string(),
                        };
                        return vec![AgentEvent::Model(full)];
                    }
                }
                vec![]
            }
            "message_update" => {
                let ame = v.get("assistantMessageEvent").unwrap_or(&Value::Null);
                match str_of(ame, "type").unwrap_or("") {
                    "text_delta" => {
                        let d = str_of(ame, "delta").unwrap_or("");
                        if d.is_empty() {
                            return vec![];
                        }
                        self.produced_text = true;
                        vec![AgentEvent::Append(d.to_string())]
                    }
                    "thinking_start" if !self.thinking_announced => {
                        self.thinking_announced = true;
                        vec![activity(ActivityKind::Thinking, "Thinking")]
                    }
                    "toolcall_start" if !self.tool_announced => {
                        self.tool_announced = true;
                        vec![activity(ActivityKind::Tool, "Calling a tool")]
                    }
                    _ => vec![],
                }
            }
            "message_end" => {
                let msg = v.get("message").unwrap_or(&Value::Null);
                if str_of(msg, "role") != Some("assistant") {
                    return vec![];
                }
                let mut out = Vec::new();
                let text = text_blocks(msg);
                if !text.is_empty() {
                    out.push(AgentEvent::SetFull(text));
                    self.produced_text = true;
                }
                if let Some(u) = msg.get("usage") {
                    let cost = u.get("cost").and_then(|c| c.get("total")).and_then(Value::as_f64);
                    out.push(AgentEvent::Usage(Usage {
                        input_tokens: u64_of(u, "input"),
                        output_tokens: u64_of(u, "output"),
                        cost_usd: cost.filter(|c| *c > 0.0),
                        duration_ms: None,
                    }));
                }
                out
            }
            "tool_execution_start" => {
                let name = str_of(&v, "toolName").unwrap_or("tool");
                vec![activity(ActivityKind::Tool, tool_label(name, v.get("args")))]
            }
            "agent_end" => vec![AgentEvent::Done],
            _ => vec![],
        }
    }
}

fn text_blocks(msg: &Value) -> String {
    msg.get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| str_of(b, "type") == Some("text"))
                .filter_map(|b| str_of(b, "text"))
                .collect::<String>()
        })
        .unwrap_or_default()
}

fn parse_pi_models(table: &str, default_id: Option<&str>) -> Vec<ModelInfo> {
    let mut out = Vec::new();
    for line in table.lines().skip(1) {
        let cols: Vec<&str> = line.split("  ").map(str::trim).filter(|c| !c.is_empty()).collect();
        if cols.len() < 2 || cols[0] == "provider" {
            continue;
        }
        let id = format!("{}/{}", cols[0], cols[1]);
        let thinking = cols.get(4).copied().unwrap_or("");
        out.push(ModelInfo {
            is_default: default_id == Some(id.as_str()),
            name: cols[1].to_string(),
            note: Some(format!("{}{}", cols[0], if thinking == "yes" { " · thinking" } else { "" })),
            context: cols.get(2).map(|c| c.to_string()),
            id,
        });
    }
    if !out.is_empty() && !out.iter().any(|m| m.is_default) {
        out[0].is_default = true;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::testutil::*;
    use super::*;

    #[test]
    fn streams_text_and_reads_usage() {
        let mut a = Pi::default();
        let events = run(&mut a, &fixture("pi_pong.jsonl"));
        assert_eq!(events[0], AgentEvent::Session { id: "875aec79-f129-4a57-8f71-0f83c27d2706".into(), model: None });
        assert!(events.iter().any(|e| matches!(e, AgentEvent::Model(m) if m == "lmstudio/qwen/qwen3.6-35b-a3b")));
        assert_eq!(text_of(&events), "pong");
        assert!(events.iter().any(|e| matches!(e, AgentEvent::Usage(_))));
        assert_eq!(events.last(), Some(&AgentEvent::Done));
    }

    #[test]
    fn parses_model_table() {
        let table = "provider  model                 context  max-out  thinking  images\nlmstudio  qwen/qwen3.6-35b-a3b  128K     65K      no        no\nanthropic  claude-sonnet-4-5  200K  64K  yes  yes\n";
        let models = parse_pi_models(table, Some("anthropic/claude-sonnet-4-5"));
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "lmstudio/qwen/qwen3.6-35b-a3b");
        assert_eq!(models[0].context.as_deref(), Some("128K"));
        assert!(models[1].is_default);
        assert_eq!(models[1].note.as_deref(), Some("anthropic · thinking"));
    }

    #[test]
    fn command_line_uses_session_dir() {
        let env = ShellEnv::from_process();
        if resolve(&env).is_none() {
            return;
        }
        let spec = Pi::default().build_command(&req("hi"), &env).unwrap();
        assert!(spec.args.contains(&"--session-dir".to_string()));
        assert!(spec.args.contains(&"--no-tools".to_string()));
        let mut r = req("hi");
        r.project = true;
        let spec = Pi::default().build_command(&r, &env).unwrap();
        assert!(spec.args.windows(2).any(|w| w == ["--tools", "read,grep,find,ls"]));
        assert!(!spec.args.contains(&"--no-tools".to_string()));
        assert!(spec.args.windows(2).any(|w| w == ["--session-id", "11111111-2222-3333-4444-555555555555"]));
        assert_eq!(spec.args.last().unwrap(), "hi");
        let spec = Pi::default().build_command(&req_with_image("hi"), &env).unwrap();
        let n = spec.args.len();
        assert_eq!(&spec.args[n - 2..], ["@attachments/att_1/red.png", "hi"]);
    }
}
