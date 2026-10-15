//! Gemini CLI adapter (`gemini -p -o stream-json`).

use std::path::PathBuf;

use anyhow::Result;
use serde_json::Value;

use super::*;
use crate::env::ShellEnv;

#[derive(Default)]
pub struct Gemini {
    produced_text: bool,
}

fn resolve(env: &ShellEnv) -> Option<PathBuf> {
    env.path_lookup("gemini")
}

/// Printed on stdout when the cwd is not trusted; the run exits without an answer.
const UNTRUSTED_MSG: &str = "not running in a trusted directory";

/// Startup diagnostics Gemini prints to stdout that mean nothing to the user.
fn is_noise(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with("[STARTUP]")
        || t.starts_with("at ")
        || t.starts_with("Ripgrep is not available")
        || t.is_empty()
}

const FALLBACK_MODELS: &[(&str, &str, &str)] = &[
    ("gemini-2.5-pro", "Gemini 2.5 Pro", "Most capable"),
    ("gemini-2.5-flash", "Gemini 2.5 Flash", "Fast"),
    ("gemini-2.5-flash-lite", "Gemini 2.5 Flash Lite", "Fastest · cheapest"),
];

impl AgentAdapter for Gemini {
    fn id(&self) -> AgentId {
        AgentId::Gemini
    }

    fn info(&self, env: &ShellEnv) -> AgentInfo {
        let path = resolve(env);
        let version = path.as_ref().and_then(|p| probe_version(env, p, &["--version"]));
        AgentInfo {
            id: AgentId::Gemini,
            name: display_name(AgentId::Gemini).into(),
            command: command_name(AgentId::Gemini).into(),
            monogram: monogram(AgentId::Gemini).into(),
            available: path.is_some(),
            path: path.map(|p| p.to_string_lossy().to_string()),
            version,
            supports_model_select: true,
            // Search is built in and always on in plan mode; there is no flag to
            // turn it off, so the toggle would be a lie.
            supports_web_search: false,
        }
    }

    fn models(&self, _env: &ShellEnv) -> Vec<ModelInfo> {
        let configured = read_json_file(&home_file(".gemini/settings.json"))
            .and_then(|v| v.get("model").and_then(|m| str_of(m, "name").map(str::to_string)));
        let mut out: Vec<ModelInfo> = FALLBACK_MODELS
            .iter()
            .map(|(id, name, note)| ModelInfo {
                id: id.to_string(),
                name: name.to_string(),
                note: Some(note.to_string()),
                context: Some("1M".into()),
                is_default: false,
            })
            .collect();
        match configured {
            Some(c) => {
                if let Some(m) = out.iter_mut().find(|m| m.id == c) {
                    m.is_default = true;
                } else {
                    out.insert(
                        0,
                        ModelInfo {
                            id: c.clone(),
                            name: c,
                            note: Some("From ~/.gemini/settings.json".into()),
                            context: None,
                            is_default: true,
                        },
                    );
                }
            }
            None => out[0].is_default = true,
        }
        out
    }

    fn build_command(&self, req: &SpawnRequest, env: &ShellEnv) -> Result<CommandSpec> {
        let program = require_binary(env, AgentId::Gemini, resolve)?;
        // Gemini's headless runner expands `@path` references in the prompt
        // into file content, images included, as long as the path is inside
        // the workspace (the cwd).
        let mut prompt = req.prompt.clone();
        for img in &req.images {
            prompt.push_str("\n\n@");
            prompt.push_str(&req.relative_image_path(img));
        }
        let mut args: Vec<String> = vec![
            "-p".into(),
            prompt,
            "-o".into(),
            "stream-json".into(),
            "--approval-mode".into(),
            "plan".into(),
        ];
        match &req.agent_session_id {
            Some(sid) => args.extend(["--resume".into(), sid.clone()]),
            None => args.extend(["--session-id".into(), req.new_session_id.clone()]),
        }
        if let Some(model) = req.model.as_deref().filter(|m| !m.is_empty()) {
            args.extend(["-m".into(), model.to_string()]);
        }
        Ok(CommandSpec {
            program,
            args,
            env: vec![("GEMINI_CLI_TRUST_WORKSPACE".into(), "true".into())],
            cwd: req.cwd.clone(),
            stdin: None,
        })
    }

    fn parse_line(&mut self, line: &str) -> Vec<AgentEvent> {
        let Some(v) = parse_json(line) else {
            if line.contains(UNTRUSTED_MSG) {
                return vec![AgentEvent::Error(
                    "Gemini CLI refused to run: the Gloss workspace is not a trusted directory".into(),
                )];
            }
            if is_noise(line) {
                return vec![];
            }
            return vec![activity(ActivityKind::Status, crate::prompt::truncate(line.trim(), 160))];
        };
        match str_of(&v, "type").unwrap_or("") {
            "init" => match str_of(&v, "session_id") {
                Some(id) => vec![AgentEvent::Session {
                    id: id.to_string(),
                    model: str_of(&v, "model").map(str::to_string),
                }],
                None => vec![],
            },
            "message" => {
                if str_of(&v, "role") != Some("assistant") {
                    return vec![];
                }
                let content = str_of(&v, "content").unwrap_or("");
                if content.is_empty() {
                    return vec![];
                }
                let is_delta = v.get("delta").and_then(Value::as_bool).unwrap_or(false);
                if is_delta || !self.produced_text {
                    self.produced_text = true;
                    vec![AgentEvent::Append(content.to_string())]
                } else {
                    vec![AgentEvent::SetFull(content.to_string())]
                }
            }
            "tool_use" => {
                let name = str_of(&v, "tool_name").unwrap_or("tool");
                vec![activity(ActivityKind::Tool, tool_label(name, v.get("parameters")))]
            }
            "result" => {
                let mut out = Vec::new();
                let stats = v.get("stats").unwrap_or(&Value::Null);
                out.push(AgentEvent::Usage(Usage {
                    input_tokens: u64_of(stats, "input_tokens"),
                    output_tokens: u64_of(stats, "output_tokens"),
                    cost_usd: None,
                    duration_ms: u64_of(stats, "duration_ms"),
                }));
                if str_of(&v, "status") == Some("error") {
                    let msg = v
                        .get("error")
                        .and_then(|e| str_of(e, "message"))
                        .unwrap_or("Gemini CLI reported an error")
                        .to_string();
                    out.push(AgentEvent::Error(msg));
                }
                out.push(AgentEvent::Done);
                out
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
    fn captures_session_skips_noise_and_surfaces_api_error() {
        let mut a = Gemini::default();
        let events = run(&mut a, &fixture("gemini_error.txt"));
        assert_eq!(events[0], AgentEvent::Session {
            id: "3a744804-df5f-4f68-8095-61b78c4120f5".into(),
            model: Some("gemini-3-flash-preview".into()),
        });
        // Startup diagnostics and stack frames never reach the UI.
        assert!(!events.iter().any(|e| matches!(e, AgentEvent::Activity { label, .. } if label.contains("STARTUP") || label.trim_start().starts_with("at "))));
        // The stack trace header does, as a status line.
        assert!(events.iter().any(|e| matches!(e, AgentEvent::Activity { kind: ActivityKind::Status, label } if label.starts_with("Error when talking to Gemini API"))));
        assert!(events.iter().any(|e| matches!(e, AgentEvent::Error(m) if m.contains("API key not valid"))));
        assert_eq!(text_of(&events), "");
        assert_eq!(events.last(), Some(&AgentEvent::Done));
    }

    #[test]
    fn deltas_append_and_full_message_replaces() {
        let mut a = Gemini::default();
        let lines = [
            r#"{"type":"init","session_id":"s1","model":"gemini-2.5-flash"}"#,
            r#"{"type":"message","role":"user","content":"hi"}"#,
            r#"{"type":"message","role":"assistant","content":"po","delta":true}"#,
            r#"{"type":"message","role":"assistant","content":"ng","delta":true}"#,
            r#"{"type":"tool_use","tool_name":"google_web_search","tool_id":"t1","parameters":{"query":"x"}}"#,
            r#"{"type":"message","role":"assistant","content":"pong"}"#,
            r#"{"type":"result","status":"success","stats":{"input_tokens":10,"output_tokens":2,"duration_ms":500}}"#,
        ];
        let events = run(&mut a, &lines.join("\n"));
        assert_eq!(text_of(&events), "pong");
        assert!(events.iter().any(|e| matches!(e, AgentEvent::SetFull(t) if t == "pong")));
        assert!(events.iter().any(|e| matches!(e, AgentEvent::Activity { kind: ActivityKind::Tool, label } if label == "google_web_search: x")));
        let usage = events.iter().find_map(|e| match e { AgentEvent::Usage(u) => Some(u.clone()), _ => None }).unwrap();
        assert_eq!(usage.input_tokens, Some(10));
        assert!(!events.iter().any(|e| matches!(e, AgentEvent::Error(_))));
    }

    #[test]
    fn untrusted_directory_is_an_error() {
        let mut a = Gemini::default();
        let events = a.parse_line("Gemini CLI is not running in a trusted directory. Run gemini interactively to trust it.");
        assert!(matches!(&events[0], AgentEvent::Error(m) if m.contains("trusted")));
    }

    #[test]
    fn command_line_sets_trust_env() {
        let env = ShellEnv::from_process();
        if resolve(&env).is_none() {
            return;
        }
        let spec = Gemini::default().build_command(&req("hi"), &env).unwrap();
        assert!(spec.env.contains(&("GEMINI_CLI_TRUST_WORKSPACE".to_string(), "true".to_string())));
        assert!(spec.args.windows(2).any(|w| w == ["--approval-mode", "plan"]));
        assert!(spec.args.contains(&"--session-id".to_string()));
    }
}
