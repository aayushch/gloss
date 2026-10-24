// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

//! Cursor Agent adapter (`cursor-agent -p --output-format stream-json`).

use std::path::PathBuf;
use std::time::Duration;

use anyhow::Result;
use serde_json::Value;

use super::*;
use crate::env::ShellEnv;

#[derive(Default)]
pub struct Cursor {
    text: String,
    thinking_announced: bool,
}

/// Cursor installs `cursor-agent` and also a generic `agent` symlink. The
/// generic name is only accepted when it resolves into a cursor-agent install
/// or prints Cursor's date-stamped build id for `--version`.
/// The words that follow `key` in the help text, up to the end of that
/// sentence, with the line-wrapping whitespace collapsed.
fn help_sentence(help: &str, key: &str) -> String {
    let Some(i) = help.find(key) else {
        return String::new();
    };
    let rest: String = help[i + key.len()..]
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let end = rest
        .find(". ")
        .or_else(|| rest.find(" (default"))
        .or_else(|| rest.find(" --"))
        .unwrap_or(rest.len().min(140));
    rest[..end].trim().trim_end_matches('.').to_string()
}

fn resolve(env: &ShellEnv) -> Option<PathBuf> {
    if let Some(p) = env.path_lookup("cursor-agent") {
        return Some(p);
    }
    env.path_lookup_all("agent")
        .into_iter()
        .find(|p| is_cursor_agent(env, p))
}

fn is_cursor_agent(env: &ShellEnv, candidate: &std::path::Path) -> bool {
    if std::fs::canonicalize(candidate)
        .map(|r| r.to_string_lossy().contains("cursor-agent"))
        .unwrap_or(false)
    {
        return true;
    }
    probe_version(env, candidate, &["--version"])
        .map(|v| looks_like_cursor_version(&v))
        .unwrap_or(false)
}

/// e.g. "2026.10.01-e373342"
fn looks_like_cursor_version(v: &str) -> bool {
    let v = v.trim();
    let Some((date, hash)) = v.split_once('-') else {
        return false;
    };
    date.split('.').count() == 3
        && date.chars().all(|c| c.is_ascii_digit() || c == '.')
        && !hash.is_empty()
        && hash.chars().all(|c| c.is_ascii_hexdigit())
}

impl AgentAdapter for Cursor {
    fn id(&self) -> AgentId {
        AgentId::Cursor
    }

    fn info(&self, env: &ShellEnv) -> AgentInfo {
        let path = resolve(env);
        let version = path
            .as_ref()
            .and_then(|p| probe_version(env, p, &["--version"]));
        AgentInfo {
            id: AgentId::Cursor,
            name: display_name(AgentId::Cursor).into(),
            command: command_name(AgentId::Cursor).into(),
            monogram: monogram(AgentId::Cursor).into(),
            available: path.is_some(),
            path: path.map(|p| p.to_string_lossy().to_string()),
            version,
            // Passing --model rewrites the user's default in ~/.cursor/cli-config.json.
            supports_model_select: false,
            supports_web_search: false,
            modes: self.modes(env),
            supports_requests: self.supports_requests(),
        }
    }

    /// `cursor-agent --list-models` prints "id - Name" lines after a header; the
    /// line marked "(current" is the default.
    fn models(&self, env: &ShellEnv) -> Vec<ModelInfo> {
        let Some(path) = resolve(env) else {
            return vec![];
        };
        let Some(out) = capture_text(env, &path, &["--list-models"], Duration::from_secs(10))
        else {
            return vec![];
        };
        parse_cursor_models(&out)
    }

    fn modes(&self, env: &ShellEnv) -> Vec<AgentMode> {
        let Some(path) = resolve(env) else {
            return Vec::new();
        };
        let Some(help) = help_text(env, &path, &["--help"]) else {
            return Vec::new();
        };
        let mut out: Vec<AgentMode> = flag_choices(&help, "--mode")
            .into_iter()
            .filter(|id| id != "ask")
            .map(|id| AgentMode {
                label: id.clone(),
                description: help_sentence(&help, &format!("{}:", id)),
                writes: false,
                id,
            })
            .collect();
        if help.contains("--mode") {
            out.push(AgentMode {
                id: "agent".into(),
                label: "Agent".into(),
                description: "Edits files without asking; commands are rejected".into(),
                writes: true,
            });
        }
        if help.contains("--force") {
            out.push(AgentMode {
                id: "force".into(),
                label: "Agent, run commands".into(),
                description: help_sentence(&help, "--force"),
                writes: true,
            });
        }
        out
    }

    fn build_command(&self, req: &SpawnRequest, env: &ShellEnv) -> Result<CommandSpec> {
        let program = require_binary(env, AgentId::Cursor, resolve)?;
        let mut args: Vec<String> = vec![
            "-p".into(),
            "--trust".into(),
            "--output-format".into(),
            "stream-json".into(),
            "--stream-partial-output".into(),
        ];
        // Ask mode is read-only. The agent mode has no flag of its own: it is
        // what runs without `--mode`, and `--force` on top lets it run
        // commands, which print mode otherwise rejects.
        match req.mode.as_deref().filter(|_| req.project) {
            None => args.extend(["--mode".into(), "ask".into()]),
            Some("agent") => {}
            Some("force") => args.push("--force".into()),
            Some(other) => args.extend(["--mode".into(), other.into()]),
        }
        if let Some(sid) = &req.agent_session_id {
            args.push(format!("--resume={}", sid));
        }
        // Cursor has no attachment flag; in ask mode it still reads files,
        // images included, so the prompt names each image's path.
        let mut prompt = req.prompt.clone();
        if !req.images.is_empty() {
            prompt.push_str("\n\nAttached image files. Open each one with your file reading tool before answering:");
            for img in &req.images {
                prompt.push_str("\n- ");
                prompt.push_str(&img.path.to_string_lossy());
            }
        }
        args.push(prompt);
        Ok(CommandSpec {
            program,
            args,
            env: vec![],
            cwd: req.cwd.clone(),
            stdin: None,
            interactive: false,
        })
    }

    fn parse_line(&mut self, line: &str) -> Vec<AgentEvent> {
        let Some(v) = parse_json(line) else {
            return vec![activity(
                ActivityKind::Status,
                crate::prompt::truncate(line.trim(), 160),
            )];
        };
        match str_of(&v, "type").unwrap_or("") {
            "system" => {
                if str_of(&v, "subtype") == Some("init") {
                    if let Some(id) = str_of(&v, "session_id") {
                        return vec![AgentEvent::Session {
                            id: id.to_string(),
                            model: str_of(&v, "model").map(str::to_string),
                        }];
                    }
                }
                vec![]
            }
            "thinking" => {
                if str_of(&v, "subtype") == Some("delta") && !self.thinking_announced {
                    self.thinking_announced = true;
                    return vec![activity(ActivityKind::Thinking, "Thinking")];
                }
                vec![]
            }
            "assistant" => {
                let blocks = v
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(Value::as_array);
                let Some(blocks) = blocks else { return vec![] };
                let chunk: String = blocks
                    .iter()
                    .filter(|b| str_of(b, "type") == Some("text"))
                    .filter_map(|b| str_of(b, "text"))
                    .collect();
                if chunk.is_empty() {
                    return vec![];
                }
                // Partial output arrives as deltas; a final complete message
                // that merely repeats what was streamed is not appended twice.
                if !self.text.is_empty() && chunk == self.text {
                    return vec![];
                }
                self.text.push_str(&chunk);
                vec![AgentEvent::Append(chunk)]
            }
            "tool_call" => {
                let payload = v.get("tool_call").and_then(Value::as_object);
                let kind = payload
                    .and_then(|p| p.keys().find(|k| k.ends_with("ToolCall")).cloned())
                    .map(|k| k.trim_end_matches("ToolCall").to_string())
                    .unwrap_or_else(|| "tool".into());
                if str_of(&v, "subtype") == Some("started") {
                    let args = payload
                        .and_then(|p| p.get(&format!("{}ToolCall", kind)))
                        .and_then(|b| b.get("args"));
                    return vec![activity(ActivityKind::Tool, tool_label(&kind, args))];
                }
                vec![]
            }
            "result" => {
                let mut out = Vec::new();
                let usage = v.get("usage").unwrap_or(&Value::Null);
                out.push(AgentEvent::Usage(Usage {
                    input_tokens: u64_of(usage, "inputTokens"),
                    output_tokens: u64_of(usage, "outputTokens"),
                    cost_usd: None,
                    duration_ms: u64_of(&v, "duration_ms"),
                }));
                let is_error = v.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                if is_error {
                    out.push(AgentEvent::Error(
                        str_of(&v, "result")
                            .unwrap_or("Cursor reported an error")
                            .to_string(),
                    ));
                } else if self.text.is_empty() {
                    if let Some(r) = str_of(&v, "result").filter(|r| !r.is_empty()) {
                        self.text = r.to_string();
                        out.push(AgentEvent::SetFull(r.to_string()));
                    }
                }
                out.push(AgentEvent::Done);
                out
            }
            _ => vec![],
        }
    }
}

fn parse_cursor_models(out: &str) -> Vec<ModelInfo> {
    let mut models = Vec::new();
    for line in out.lines() {
        let line = line.trim();
        let Some((id, rest)) = line.split_once(" - ") else {
            continue;
        };
        if id.contains(' ') || id.is_empty() {
            continue;
        }
        let is_default = rest.contains("(current") || rest.contains("default)");
        let name = rest.split('(').next().unwrap_or(rest).trim().to_string();
        models.push(ModelInfo {
            id: id.to_string(),
            name,
            note: None,
            context: None,
            is_default,
        });
    }
    models
}

#[cfg(test)]
mod tests {
    use super::super::testutil::*;
    use super::*;

    #[test]
    fn parses_recorded_ask_run() {
        let mut a = Cursor::default();
        let events = run(&mut a, &fixture("cursor_pong.jsonl"));
        assert_eq!(
            events[0],
            AgentEvent::Session {
                id: "171eba98-f068-4012-bde9-e2104051430b".into(),
                model: Some("Auto".into())
            }
        );
        assert!(events.iter().any(|e| matches!(
            e,
            AgentEvent::Activity {
                kind: ActivityKind::Thinking,
                ..
            }
        )));
        assert_eq!(text_of(&events), "pong");
        let usage = events
            .iter()
            .find_map(|e| match e {
                AgentEvent::Usage(u) => Some(u.clone()),
                _ => None,
            })
            .unwrap();
        assert_eq!(usage.input_tokens, Some(8808));
        assert_eq!(events.last(), Some(&AgentEvent::Done));
    }

    #[test]
    fn repeated_complete_message_is_not_duplicated() {
        let mut a = Cursor::default();
        let lines = [
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"po"}]}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ng"}]}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"pong"}]}}"#,
            r#"{"type":"result","subtype":"success","is_error":false,"result":"pong","usage":{}}"#,
        ];
        let events = run(&mut a, &lines.join("\n"));
        assert_eq!(text_of(&events), "pong");
    }

    #[test]
    fn model_list_and_version_shape() {
        let models = parse_cursor_models(
            "Available models\n\nauto - Auto (current, default)\ngpt-5.2 - GPT-5.2\n",
        );
        assert_eq!(models.len(), 2);
        assert!(models[0].is_default);
        assert_eq!(models[0].name, "Auto");
        assert_eq!(models[1].id, "gpt-5.2");
        assert!(looks_like_cursor_version("2026.10.01-e373342"));
        assert!(!looks_like_cursor_version("1.2.3"));
    }

    #[test]
    fn command_line_never_passes_model() {
        let env = ShellEnv::from_process();
        if resolve(&env).is_none() {
            return;
        }
        let mut r = req("hi");
        r.model = Some("gpt-5.2".into());
        r.agent_session_id = Some("c1".into());
        let spec = Cursor::default().build_command(&r, &env).unwrap();
        assert!(!spec.args.iter().any(|a| a.contains("--model")));
        assert!(spec.args.contains(&"--resume=c1".to_string()));
        assert!(spec.args.windows(2).any(|w| w == ["--mode", "ask"]));
        let mut r = req("hi");
        r.project = true;
        r.mode = Some("force".into());
        let spec = Cursor::default().build_command(&r, &env).unwrap();
        assert!(spec.args.contains(&"--force".to_string()));
        assert!(!spec.args.contains(&"--mode".to_string()));
    }
}
