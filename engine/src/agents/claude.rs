//! Claude Code adapter (`claude -p --input-format stream-json --output-format stream-json`).
//!
//! The prompt goes in as one stream-json user message on stdin and stdin
//! stays open: with `--permission-prompt-tool stdio` Claude Code writes a
//! `control_request` line whenever a tool call needs approval or it asks the
//! user a question, and waits for the matching `control_response` on stdin.

use std::path::PathBuf;

use anyhow::{Context, Result};
use serde_json::Value;

use super::*;
use crate::env::ShellEnv;

#[derive(Default)]
pub struct Claude {
    /// Text has been produced in the current turn; a later `message_start`
    /// then marks a new assistant message that needs a paragraph break.
    produced_text: bool,
    break_pending: bool,
    thinking_announced: bool,
}

fn resolve(env: &ShellEnv) -> Option<PathBuf> {
    env.path_lookup("claude")
}

/// One `user` message in Claude Code's stream-json input format: the prompt
/// text followed by every image as a base64 block.
fn stream_json_message(req: &SpawnRequest) -> Result<Vec<u8>> {
    use base64::Engine as _;
    let mut content = vec![serde_json::json!({ "type": "text", "text": req.prompt })];
    for img in &req.images {
        let bytes = std::fs::read(&img.path).with_context(|| format!("read attachment {}", img.path.display()))?;
        content.push(serde_json::json!({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": img.mime,
                "data": base64::engine::general_purpose::STANDARD.encode(bytes),
            }
        }));
    }
    let msg = serde_json::json!({ "type": "user", "message": { "role": "user", "content": content } });
    let mut out = serde_json::to_vec(&msg)?;
    out.push(b'\n');
    Ok(out)
}

/// Tools pre-approved in every conversation: reading inside the folder and
/// the web tools. Edits and commands are never pre-approved; the permission
/// mode decides whether they run, prompt, or are refused.
const READ_TOOLS: &[&str] = &["Read", "Glob", "Grep", "LS"];
const EDIT_TOOLS: &[&str] = &["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"];
const WEB_TOOLS: &[&str] = &["WebSearch", "WebFetch"];

/// What each permission mode lets Claude do without asking, for the mode
/// picker. The list of modes itself comes from `claude --help`; a mode the
/// table does not know is shown by its id.
const MODE_NOTES: &[(&str, &str, &str, bool)] = &[
    ("manual", "Manual", "Asks before every edit and command", true),
    ("default", "Manual", "Asks before every edit and command", true),
    ("acceptEdits", "Accept edits", "Edits files without asking; asks before commands", true),
    ("auto", "Auto", "A safety classifier approves actions instead of you", true),
    ("plan", "Plan", "Reads and plans only; no edits", false),
    ("dontAsk", "Don't ask", "Refuses anything that would need approval", false),
];

/// Aliases Claude Code accepts for `--model`. The settings file's `model`
/// value picks the default when it names one of them.
const MODELS: &[(&str, &str, &str)] = &[
    ("fable", "Claude Fable 5.1", "Most capable · slower"),
    ("opus", "Claude Opus 5.5", "Capable · balanced"),
    ("sonnet", "Claude Sonnet 5.5", "Balanced"),
    ("haiku", "Claude Haiku 5.5", "Fastest · cheapest"),
];

impl AgentAdapter for Claude {
    fn id(&self) -> AgentId {
        AgentId::Claude
    }

    fn info(&self, env: &ShellEnv) -> AgentInfo {
        let path = resolve(env);
        let version = path.as_ref().and_then(|p| probe_version(env, p, &["--version"])).map(|v| {
            // "2.1.296 (Claude Code)" → "2.1.296"
            v.split_whitespace().next().unwrap_or(&v).to_string()
        });
        AgentInfo {
            id: AgentId::Claude,
            name: display_name(AgentId::Claude).into(),
            command: command_name(AgentId::Claude).into(),
            monogram: monogram(AgentId::Claude).into(),
            available: path.is_some(),
            path: path.map(|p| p.to_string_lossy().to_string()),
            version,
            supports_model_select: true,
            supports_web_search: true,
            modes: self.modes(env),
            supports_requests: self.supports_requests(),
        }
    }

    fn models(&self, _env: &ShellEnv) -> Vec<ModelInfo> {
        let configured = read_json_file(&home_file(".claude/settings.json"))
            .and_then(|v| str_of(&v, "model").map(str::to_string))
            .unwrap_or_default()
            .to_lowercase();
        let default_alias = MODELS
            .iter()
            .map(|(id, _, _)| *id)
            .find(|id| configured.contains(id))
            .unwrap_or("sonnet");
        MODELS
            .iter()
            .map(|(id, name, note)| ModelInfo {
                id: id.to_string(),
                name: name.to_string(),
                note: Some(note.to_string()),
                context: None,
                is_default: *id == default_alias,
            })
            .collect()
    }

    fn modes(&self, env: &ShellEnv) -> Vec<AgentMode> {
        let Some(path) = resolve(env) else { return Vec::new() };
        let Some(help) = help_text(env, &path, &["--help"]) else { return Vec::new() };
        flag_choices(&help, "--permission-mode")
            .into_iter()
            // Every run is `--restricted`, which refuses bypassPermissions.
            .filter(|id| id != "bypassPermissions")
            .map(|id| {
                let note = MODE_NOTES.iter().find(|(m, ..)| *m == id);
                AgentMode {
                    label: note.map(|n| n.1.to_string()).unwrap_or_else(|| id.clone()),
                    description: note.map(|n| n.2.to_string()).unwrap_or_default(),
                    writes: note.map(|n| n.3).unwrap_or(true),
                    id,
                }
            })
            .collect()
    }

    fn supports_requests(&self) -> bool {
        true
    }

    fn encode_answer(&self, request: &AgentRequest, answer: &RequestAnswer) -> Option<Vec<u8>> {
        let input = request.raw.get("input").cloned().unwrap_or_else(|| serde_json::json!({}));
        let response = match answer {
            RequestAnswer::Permission { allow: true, set_mode, .. } => {
                let mut r = serde_json::json!({ "behavior": "allow", "updatedInput": input });
                if let Some(mode) = set_mode {
                    r["updatedPermissions"] = serde_json::json!([{ "type": "setMode", "mode": mode, "destination": "session" }]);
                }
                r
            }
            RequestAnswer::Permission { allow: false, message, .. } => serde_json::json!({
                "behavior": "deny",
                "message": message.clone().filter(|m| !m.trim().is_empty()).unwrap_or_else(|| "The user declined this action.".into()),
            }),
            RequestAnswer::Question { answers } => {
                let mut updated = input;
                updated["answers"] = serde_json::to_value(answers).ok()?;
                serde_json::json!({ "behavior": "allow", "updatedInput": updated })
            }
        };
        let line = serde_json::json!({
            "type": "control_response",
            "response": { "subtype": "success", "request_id": request.id, "response": response }
        });
        let mut out = serde_json::to_vec(&line).ok()?;
        out.push(b'\n');
        Some(out)
    }

    fn build_command(&self, req: &SpawnRequest, env: &ShellEnv) -> Result<CommandSpec> {
        let program = require_binary(env, AgentId::Claude, resolve)?;
        let stdin = Some(stream_json_message(req)?);
        let mut args: Vec<String> = vec![
            "-p".into(),
            "--input-format".into(),
            "stream-json".into(),
            "--output-format".into(),
            "stream-json".into(),
            "--verbose".into(),
            "--include-partial-messages".into(),
            "--strict-mcp-config".into(),
            "--permission-prompt-tool".into(),
            "stdio".into(),
            "--permission-prompts".into(),
            "host".into(),
        ];
        // Read-only (no mode) runs as manual: nothing but reads is
        // pre-approved and no edit tool exists, so the only prompt that can
        // reach the user is a question.
        let mode = req.mode.as_deref().filter(|_| req.project).unwrap_or("default");
        args.extend(["--permission-mode".into(), mode.into()]);
        match &req.agent_session_id {
            Some(sid) => args.extend(["--resume".into(), sid.clone()]),
            None => args.extend(["--session-id".into(), req.new_session_id.clone()]),
        }
        if let Some(model) = req.model.as_deref().filter(|m| !m.is_empty()) {
            args.extend(["--model".into(), model.to_string()]);
        }
        // Tool policy. Questions are always possible. Inside a project
        // folder `--restricted` confines the file tools to the folder and
        // skips the project's own settings files and hooks; the read tools
        // are pre-approved, and the edit tools exist only once a mode is
        // chosen, with the mode deciding whether they prompt.
        let mut tools: Vec<&str> = vec!["AskUserQuestion"];
        let mut allowed: Vec<&str> = Vec::new();
        if req.project {
            args.push("--restricted".into());
            tools.extend(READ_TOOLS);
            allowed.extend(READ_TOOLS);
            if req.mode.is_some() {
                tools.extend(EDIT_TOOLS);
            }
        }
        if req.web_search {
            tools.extend(WEB_TOOLS);
            allowed.extend(WEB_TOOLS);
        }
        args.extend(["--tools".into(), tools.join(",")]);
        if !allowed.is_empty() {
            args.push("--allowedTools".into());
            args.extend(allowed.iter().map(|t| t.to_string()));
        }
        if !req.system_note.is_empty() {
            args.extend(["--append-system-prompt".into(), req.system_note.clone()]);
        }
        if let Some(title) = req.title.as_deref().filter(|t| !t.is_empty()) {
            if req.agent_session_id.is_none() {
                args.extend(["-n".into(), title.to_string()]);
            }
        }
        Ok(CommandSpec {
            program,
            args,
            env: vec![],
            cwd: req.cwd.clone(),
            stdin,
            interactive: true,
        })
    }

    fn parse_line(&mut self, line: &str) -> Vec<AgentEvent> {
        let Some(v) = parse_json(line) else {
            return vec![activity(ActivityKind::Status, line.trim())];
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
            "stream_event" => self.stream_event(v.get("event").unwrap_or(&Value::Null)),
            "assistant" => self.assistant_message(&v),
            "control_request" => control_request(&v).into_iter().map(AgentEvent::Request).collect(),
            "result" => self.result(&v),
            _ => vec![],
        }
    }
}

/// A `control_request` line turned into something the user can answer. A
/// question tool call becomes a question card; any other tool call becomes
/// a permission card with the call described in words.
fn control_request(v: &Value) -> Option<AgentRequest> {
    let id = str_of(v, "request_id")?.to_string();
    let request = v.get("request")?;
    let input = request.get("input").cloned().unwrap_or(Value::Null);
    let tool = str_of(request, "tool_name").unwrap_or_else(|| str_of(request, "subtype").unwrap_or("request"));
    let kind = if tool == "AskUserQuestion" {
        let questions = input
            .get("questions")
            .and_then(Value::as_array)
            .map(|qs| {
                qs.iter()
                    .map(|q| Question {
                        question: str_of(q, "question").unwrap_or("").to_string(),
                        header: str_of(q, "header").unwrap_or("").to_string(),
                        multi_select: q.get("multiSelect").and_then(Value::as_bool).unwrap_or(false),
                        options: q
                            .get("options")
                            .and_then(Value::as_array)
                            .map(|os| {
                                os.iter()
                                    .map(|o| QuestionOption {
                                        label: str_of(o, "label").unwrap_or("").to_string(),
                                        description: str_of(o, "description").unwrap_or("").to_string(),
                                    })
                                    .collect()
                            })
                            .unwrap_or_default(),
                    })
                    .collect()
            })
            .unwrap_or_default();
        RequestKind::Question { questions }
    } else {
        let suggestions = request
            .get("permission_suggestions")
            .and_then(Value::as_array)
            .map(|ss| {
                ss.iter()
                    .filter(|s| str_of(s, "type") == Some("setMode"))
                    .filter_map(|s| str_of(s, "mode"))
                    .map(|m| ModeSuggestion {
                        mode: m.to_string(),
                        label: MODE_NOTES.iter().find(|(id, ..)| *id == m).map(|n| n.1.to_string()).unwrap_or_else(|| m.to_string()),
                    })
                    .collect()
            })
            .unwrap_or_default();
        RequestKind::Permission {
            tool: tool.to_string(),
            title: tool_label(tool, Some(&input)),
            detail: permission_detail(tool, &input),
            suggestions,
        }
    };
    Some(AgentRequest { id, kind, raw: request.clone() })
}

/// The part of a tool call worth showing before approving it: the content
/// to write, the replacement for an edit, the command to run.
fn permission_detail(tool: &str, input: &Value) -> Option<String> {
    let cut = |s: &str| crate::prompt::truncate(s, 2000);
    let text = match tool {
        "Write" => str_of(input, "content").map(cut),
        "Edit" | "MultiEdit" => {
            let old = str_of(input, "old_string").unwrap_or("");
            let new = str_of(input, "new_string").unwrap_or("");
            if old.is_empty() && new.is_empty() {
                None
            } else {
                Some(cut(&format!("- {}\n+ {}", old, new)))
            }
        }
        "Bash" => {
            let cmd = str_of(input, "command").unwrap_or("");
            let desc = str_of(input, "description").unwrap_or("");
            Some(cut(&if desc.is_empty() { cmd.to_string() } else { format!("{}\n{}", cmd, desc) }))
        }
        _ => serde_json::to_string_pretty(input).ok().map(|s| cut(&s)),
    };
    text.filter(|t| !t.trim().is_empty())
}

impl Claude {
    fn stream_event(&mut self, ev: &Value) -> Vec<AgentEvent> {
        match str_of(ev, "type").unwrap_or("") {
            "message_start" => {
                if self.produced_text {
                    self.break_pending = true;
                }
                self.thinking_announced = false;
                vec![]
            }
            "content_block_start" => {
                let block_type = ev
                    .get("content_block")
                    .and_then(|b| str_of(b, "type"))
                    .unwrap_or("");
                if block_type == "thinking" && !self.thinking_announced {
                    self.thinking_announced = true;
                    return vec![activity(ActivityKind::Thinking, "Thinking")];
                }
                vec![]
            }
            "content_block_delta" => {
                let delta = ev.get("delta").unwrap_or(&Value::Null);
                if str_of(delta, "type") == Some("text_delta") {
                    let text = str_of(delta, "text").unwrap_or("");
                    if text.is_empty() {
                        return vec![];
                    }
                    let mut out = Vec::new();
                    if self.break_pending {
                        self.break_pending = false;
                        out.push(AgentEvent::Append("\n\n".into()));
                    }
                    self.produced_text = true;
                    out.push(AgentEvent::Append(text.to_string()));
                    return out;
                }
                vec![]
            }
            _ => vec![],
        }
    }

    /// Complete assistant messages duplicate the streamed text, so only tool
    /// calls are read from them.
    fn assistant_message(&mut self, v: &Value) -> Vec<AgentEvent> {
        let blocks = v
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(Value::as_array);
        let Some(blocks) = blocks else { return vec![] };
        blocks
            .iter()
            .filter(|b| str_of(b, "type") == Some("tool_use"))
            .map(|b| {
                let name = str_of(b, "name").unwrap_or("tool");
                activity(ActivityKind::Tool, tool_label(name, b.get("input")))
            })
            .collect()
    }

    fn result(&mut self, v: &Value) -> Vec<AgentEvent> {
        let mut out = Vec::new();
        let usage = v.get("usage").unwrap_or(&Value::Null);
        let input = u64_of(usage, "input_tokens").unwrap_or(0)
            + u64_of(usage, "cache_creation_input_tokens").unwrap_or(0)
            + u64_of(usage, "cache_read_input_tokens").unwrap_or(0);
        out.push(AgentEvent::Usage(Usage {
            input_tokens: Some(input),
            output_tokens: u64_of(usage, "output_tokens"),
            cost_usd: v.get("total_cost_usd").and_then(Value::as_f64),
            duration_ms: u64_of(v, "duration_ms"),
        }));
        if let Some(model) = v
            .get("modelUsage")
            .and_then(Value::as_object)
            .and_then(|m| m.keys().next())
        {
            out.push(AgentEvent::Model(model.clone()));
        }
        let is_error = v.get("is_error").and_then(Value::as_bool).unwrap_or(false)
            || str_of(v, "subtype").is_some_and(|s| s != "success");
        if is_error {
            let msg = str_of(v, "result")
                .map(str::to_string)
                .or_else(|| {
                    v.get("errors")
                        .and_then(Value::as_array)
                        .map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("; "))
                })
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| format!("Claude Code reported {}", str_of(v, "subtype").unwrap_or("an error")));
            out.push(AgentEvent::Error(msg));
        } else if let Some(text) = str_of(v, "result") {
            if !self.produced_text && !text.is_empty() {
                out.push(AgentEvent::SetFull(text.to_string()));
            }
        }
        out.push(AgentEvent::Done);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::super::testutil::*;
    use super::*;

    #[test]
    fn streams_deltas_and_reads_result() {
        let mut a = Claude::default();
        let events = run(&mut a, &fixture("claude_pong.jsonl"));
        assert!(events.iter().any(|e| matches!(e, AgentEvent::Session { id, model: Some(m) }
            if id == "32bead75-3df0-42d1-a069-faae5a2370fe" && m == "claude-haiku-5-5")));
        assert_eq!(text_of(&events), "pong");
        let usage = events.iter().find_map(|e| match e { AgentEvent::Usage(u) => Some(u.clone()), _ => None }).unwrap();
        assert_eq!(usage.output_tokens, Some(4));
        assert!(usage.cost_usd.unwrap() > 0.0);
        assert!(events.iter().any(|e| matches!(e, AgentEvent::Model(m) if m == "claude-haiku-5-5")));
        assert_eq!(events.last(), Some(&AgentEvent::Done));
        // No SetFull: the deltas already carried the text.
        assert!(!events.iter().any(|e| matches!(e, AgentEvent::SetFull(_))));
    }

    #[test]
    fn resume_without_partials_uses_result_text() {
        let mut a = Claude::default();
        let events = run(&mut a, &fixture("claude_resume.jsonl"));
        assert_eq!(text_of(&events), "pong");
    }

    #[test]
    fn tool_use_and_message_breaks() {
        let mut a = Claude::default();
        let lines = [
            r#"{"type":"stream_event","event":{"type":"message_start"}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Looking."}}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"WebSearch","input":{"query":"node lts"}}]}}"#,
            r#"{"type":"stream_event","event":{"type":"message_start"}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"thinking"}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Node 24."}}}"#,
            r#"{"type":"result","subtype":"success","is_error":false,"result":"Looking.\n\nNode 24.","usage":{}}"#,
        ];
        let events = run(&mut a, &lines.join("\n"));
        assert_eq!(text_of(&events), "Looking.\n\nNode 24.");
        assert!(events.iter().any(|e| matches!(e, AgentEvent::Activity { kind: ActivityKind::Tool, label } if label == "WebSearch: node lts")));
        assert!(events.iter().any(|e| matches!(e, AgentEvent::Activity { kind: ActivityKind::Thinking, .. })));
    }

    #[test]
    fn error_result_is_surfaced() {
        let mut a = Claude::default();
        let events = run(&mut a, r#"{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Not logged in","usage":{}}"#);
        assert!(events.iter().any(|e| matches!(e, AgentEvent::Error(m) if m == "Not logged in")));
    }

    #[test]
    fn command_line_first_turn_and_resume() {
        let env = ShellEnv::from_process();
        if resolve(&env).is_none() {
            return;
        }
        let a = Claude::default();
        let spec = a.build_command(&req("hi"), &env).unwrap();
        let args = spec.args.join(" ");
        assert!(args.contains("--session-id 11111111-2222-3333-4444-555555555555"));
        assert!(args.contains("--tools AskUserQuestion,WebSearch,WebFetch --allowedTools WebSearch WebFetch"));
        assert!(args.contains("--permission-prompt-tool stdio --permission-prompts host --permission-mode default"));
        assert!(args.contains("--input-format stream-json"));
        assert!(args.contains("-n Title"));
        assert!(spec.interactive);
        let prompt = String::from_utf8(spec.stdin.clone().unwrap()).unwrap();
        assert!(prompt.contains("\"hi\""));
        assert!(!spec.args.contains(&"hi".to_string()));
        let mut r = req("again");
        r.agent_session_id = Some("abc".into());
        r.web_search = false;
        r.model = Some("haiku".into());
        let spec = a.build_command(&r, &env).unwrap();
        assert!(spec.args.windows(2).any(|w| w == ["--resume", "abc"]));
        assert!(spec.args.windows(2).any(|w| w == ["--tools", "AskUserQuestion"]));
        assert!(!spec.args.contains(&"--allowedTools".to_string()));
        assert!(spec.args.windows(2).any(|w| w == ["--model", "haiku"]));
        assert!(!spec.args.contains(&"-n".to_string()));
    }

    #[test]
    fn control_requests_become_cards_and_answers_go_back_as_control_responses() {
        let line = r#"{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Write","input":{"file_path":"/p/a.txt","content":"hi"},"permission_suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}]}}"#;
        let mut a = Claude::default();
        let ev = a.parse_line(line);
        let AgentEvent::Request(req) = &ev[0] else { panic!("expected a request") };
        assert_eq!(req.id, "r1");
        let RequestKind::Permission { tool, detail, suggestions, .. } = &req.kind else { panic!() };
        assert_eq!(tool, "Write");
        assert_eq!(detail.as_deref(), Some("hi"));
        assert_eq!(suggestions[0].mode, "acceptEdits");
        let bytes = a
            .encode_answer(req, &RequestAnswer::Permission { allow: true, message: None, set_mode: Some("acceptEdits".into()) })
            .unwrap();
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["type"], "control_response");
        assert_eq!(v["response"]["request_id"], "r1");
        assert_eq!(v["response"]["response"]["behavior"], "allow");
        assert_eq!(v["response"]["response"]["updatedInput"]["content"], "hi");
        assert_eq!(v["response"]["response"]["updatedPermissions"][0]["mode"], "acceptEdits");
        let bytes = a.encode_answer(req, &RequestAnswer::Permission { allow: false, message: Some("no".into()), set_mode: None }).unwrap();
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["response"]["response"]["behavior"], "deny");
        assert_eq!(v["response"]["response"]["message"], "no");

        let line = r#"{"type":"control_request","request_id":"r2","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{"questions":[{"question":"Which?","header":"Pick","options":[{"label":"A","description":"a"},{"label":"B","description":"b"}],"multiSelect":false}]}}}"#;
        let ev = a.parse_line(line);
        let AgentEvent::Request(req) = &ev[0] else { panic!() };
        let RequestKind::Question { questions } = &req.kind else { panic!() };
        assert_eq!(questions[0].options.len(), 2);
        let answers = std::collections::HashMap::from([("Which?".to_string(), "B".to_string())]);
        let bytes = a.encode_answer(req, &RequestAnswer::Question { answers }).unwrap();
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["response"]["response"]["updatedInput"]["answers"]["Which?"], "B");
        assert_eq!(v["response"]["response"]["updatedInput"]["questions"][0]["question"], "Which?");
    }

    #[test]
    fn modes_come_from_the_help_text() {
        let env = ShellEnv::from_process();
        if resolve(&env).is_none() {
            return;
        }
        let modes = Claude::default().modes(&env);
        assert!(modes.iter().any(|m| m.id == "acceptEdits"));
        assert!(!modes.iter().any(|m| m.id == "bypassPermissions"));
    }

    #[test]
    fn command_line_in_a_project_folder_has_read_only_file_tools() {
        let env = ShellEnv::from_process();
        if resolve(&env).is_none() {
            return;
        }
        let mut r = req("hi");
        r.project = true;
        let spec = Claude::default().build_command(&r, &env).unwrap();
        let args = spec.args.join(" ");
        assert!(args.contains("--restricted"));
        assert!(args.contains("--permission-mode default"));
        assert!(args.contains("--tools AskUserQuestion,Read,Glob,Grep,LS,WebSearch,WebFetch --allowedTools Read Glob Grep LS WebSearch WebFetch"));
        assert!(!args.contains("Bash"));
        assert!(!args.contains("Edit"));
        r.mode = Some("acceptEdits".into());
        let spec = Claude::default().build_command(&r, &env).unwrap();
        let args = spec.args.join(" ");
        assert!(args.contains("--permission-mode acceptEdits"));
        assert!(args.contains("--tools AskUserQuestion,Read,Glob,Grep,LS,Edit,Write,MultiEdit,NotebookEdit,Bash,WebSearch,WebFetch"));
        assert!(args.contains("--allowedTools Read Glob Grep LS WebSearch WebFetch"));
        assert!(!args.contains("--allowedTools Read Glob Grep LS Edit"));
    }

    #[test]
    fn images_go_through_stream_json_stdin() {
        let env = ShellEnv::from_process();
        if resolve(&env).is_none() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let mut r = req_with_image("what colour?");
        r.cwd = dir.path().to_path_buf();
        let img = r.cwd.join("attachments").join("att_1").join("red.png");
        std::fs::create_dir_all(img.parent().unwrap()).unwrap();
        std::fs::write(&img, b"\x89PNG").unwrap();
        r.images[0].path = img;
        let spec = Claude::default().build_command(&r, &env).unwrap();
        assert!(spec.args.windows(2).any(|w| w == ["--input-format", "stream-json"]));
        assert!(!spec.args.contains(&"what colour?".to_string()));
        let stdin = String::from_utf8(spec.stdin.unwrap()).unwrap();
        let v: serde_json::Value = serde_json::from_str(stdin.trim()).unwrap();
        assert_eq!(v["type"], "user");
        assert_eq!(v["message"]["content"][0]["text"], "what colour?");
        assert_eq!(v["message"]["content"][1]["source"]["media_type"], "image/png");
        assert_eq!(v["message"]["content"][1]["source"]["data"], "iVBORw==");
    }
}
