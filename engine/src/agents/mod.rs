//! Adapters that turn each CLI agent into the same two operations: build the
//! command line for one turn, and translate its output lines into events.

pub mod claude;
pub mod codex;
pub mod cursor;
pub mod gemini;
pub mod pi;
pub mod process;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use anyhow::{anyhow, Result};
use serde_json::Value;

use crate::env::{run_capture, ShellEnv};
use crate::types::*;
pub use process::CommandSpec;

/// Everything an adapter needs to spawn one turn.
#[derive(Clone, Debug)]
pub struct SpawnRequest {
    /// Final prompt text, framing included.
    pub prompt: String,
    /// The agent's session id from an earlier turn; None on the first turn.
    pub agent_session_id: Option<String>,
    /// Id Gloss would like the agent to use for a new session. Only agents
    /// whose CLI accepts a session id flag honour it.
    pub new_session_id: String,
    /// Model id for this turn; None means the agent's default.
    pub model: Option<String>,
    pub web_search: bool,
    pub cwd: PathBuf,
    pub pi_session_dir: PathBuf,
    /// Short note added to the agent's system prompt where the CLI allows it.
    pub system_note: String,
    /// Conversation title, for agents that can name their session.
    pub title: Option<String>,
    /// Image attachments for this turn. Text attachments are already part of
    /// `prompt`; images take whichever route each CLI offers.
    pub images: Vec<ImageAttachment>,
}

/// An image file to send with the prompt.
#[derive(Clone, Debug)]
pub struct ImageAttachment {
    /// Absolute path of the stored copy, inside the cwd of the spawn.
    pub path: PathBuf,
    pub mime: String,
}

impl SpawnRequest {
    /// Path of an image relative to the spawn cwd, for CLIs that resolve
    /// `@path` references against it; the absolute path when it is elsewhere.
    pub fn relative_image_path(&self, img: &ImageAttachment) -> String {
        img.path
            .strip_prefix(&self.cwd)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| img.path.to_string_lossy().to_string())
    }
}

/// Normalised output of an agent, produced line by line.
#[derive(Clone, Debug, PartialEq)]
pub enum AgentEvent {
    /// The agent reported its own session id (and possibly the model).
    Session { id: String, model: Option<String> },
    /// More assistant text.
    Append(String),
    /// The complete assistant text so far, as the agent sees it.
    SetFull(String),
    Activity { kind: ActivityKind, label: String },
    Usage(Usage),
    Model(String),
    /// The agent reported a failure; the turn ends as an error with this message.
    Error(String),
    /// The agent signalled the end of the turn.
    Done,
}

pub trait AgentAdapter: Send {
    fn id(&self) -> AgentId;
    fn info(&self, env: &ShellEnv) -> AgentInfo;
    fn models(&self, env: &ShellEnv) -> Vec<ModelInfo>;
    fn build_command(&self, req: &SpawnRequest, env: &ShellEnv) -> Result<CommandSpec>;
    /// Translate one stdout line. Unknown JSON is ignored (empty vec).
    fn parse_line(&mut self, line: &str) -> Vec<AgentEvent>;
    /// Called once stdout is exhausted, for buffered state.
    fn finish(&mut self) -> Vec<AgentEvent> {
        Vec::new()
    }
}

pub fn adapter_for(id: AgentId) -> Box<dyn AgentAdapter> {
    match id {
        AgentId::Claude => Box::new(claude::Claude::default()),
        AgentId::Codex => Box::new(codex::Codex::default()),
        AgentId::Gemini => Box::new(gemini::Gemini::default()),
        AgentId::Pi => Box::new(pi::Pi::default()),
        AgentId::Cursor => Box::new(cursor::Cursor::default()),
    }
}

pub fn all_adapters() -> Vec<Box<dyn AgentAdapter>> {
    AgentId::ALL.into_iter().map(adapter_for).collect()
}

// ── shared helpers ──────────────────────────────────────────────────────

/// Resolve the agent binary or fail with a message the UI can show.
pub(crate) fn require_binary(env: &ShellEnv, id: AgentId, resolver: fn(&ShellEnv) -> Option<PathBuf>) -> Result<PathBuf> {
    resolver(env).ok_or_else(|| {
        anyhow!(
            "{} is not installed or not on PATH (looked for `{}`)",
            display_name(id),
            command_name(id)
        )
    })
}

pub fn display_name(id: AgentId) -> &'static str {
    match id {
        AgentId::Claude => "Claude Code",
        AgentId::Codex => "Codex CLI",
        AgentId::Gemini => "Gemini CLI",
        AgentId::Pi => "Pi",
        AgentId::Cursor => "Cursor Agent",
    }
}

pub fn command_name(id: AgentId) -> &'static str {
    match id {
        AgentId::Claude => "claude",
        AgentId::Codex => "codex",
        AgentId::Gemini => "gemini",
        AgentId::Pi => "pi",
        AgentId::Cursor => "cursor-agent",
    }
}

pub fn monogram(id: AgentId) -> &'static str {
    match id {
        AgentId::Claude => "cc",
        AgentId::Codex => "cx",
        AgentId::Gemini => "gm",
        AgentId::Pi => "pi",
        AgentId::Cursor => "cu",
    }
}

/// `--version` output per binary path, cached by path and modification time
/// so the Settings sheet does not start a Node process on every refresh.
type VersionKey = (PathBuf, Option<SystemTime>);
static VERSION_CACHE: Mutex<Option<HashMap<VersionKey, Option<String>>>> = Mutex::new(None);

pub(crate) fn probe_version(env: &ShellEnv, path: &Path, args: &[&str]) -> Option<String> {
    let mtime = std::fs::metadata(path).and_then(|m| m.modified()).ok();
    let key = (path.to_path_buf(), mtime);
    if let Some(cache) = VERSION_CACHE.lock().unwrap().as_ref() {
        if let Some(v) = cache.get(&key) {
            return v.clone();
        }
    }
    let out = run_capture(
        &path.to_string_lossy(),
        args,
        Some(&env.vars),
        Duration::from_secs(3),
    )
    .map(|b| String::from_utf8_lossy(&b).trim().to_string())
    .filter(|s| !s.is_empty());
    let mut guard = VERSION_CACHE.lock().unwrap();
    guard
        .get_or_insert_with(HashMap::new)
        .insert(key, out.clone());
    out
}

/// Run a CLI and return its stdout as text, with a short timeout.
pub(crate) fn capture_text(env: &ShellEnv, path: &Path, args: &[&str], timeout: Duration) -> Option<String> {
    run_capture(&path.to_string_lossy(), args, Some(&env.vars), timeout)
        .map(|b| String::from_utf8_lossy(&b).to_string())
}

pub(crate) fn parse_json(line: &str) -> Option<Value> {
    let t = line.trim();
    if !t.starts_with('{') {
        return None;
    }
    serde_json::from_str(t).ok()
}

pub(crate) fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

pub(crate) fn u64_of(v: &Value, key: &str) -> Option<u64> {
    v.get(key).and_then(|x| x.as_u64().or_else(|| x.as_f64().map(|f| f as u64)))
}

pub(crate) fn activity(kind: ActivityKind, label: impl Into<String>) -> AgentEvent {
    AgentEvent::Activity {
        kind,
        label: label.into(),
    }
}

/// One-line description of a tool call for the activity line, from the tool
/// name and whichever of the usual argument keys is present.
pub(crate) fn tool_label(name: &str, input: Option<&Value>) -> String {
    let detail = input.and_then(|i| {
        ["query", "url", "command", "file_path", "path", "pattern", "prompt", "description"]
            .iter()
            .find_map(|k| i.get(k).and_then(Value::as_str))
            .map(str::to_string)
    });
    match detail {
        Some(d) => format!("{}: {}", name, crate::prompt::truncate(d.trim(), 80)),
        None => name.to_string(),
    }
}

/// Read a JSON file into a Value, if it exists and parses.
pub(crate) fn read_json_file(path: &std::path::Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

pub(crate) fn home_file(rel: &str) -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(rel)
}

#[cfg(test)]
pub(crate) mod testutil {
    use super::*;

    pub fn fixture(name: &str) -> String {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name);
        std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("fixture {}: {}", p.display(), e))
    }

    pub fn run(adapter: &mut dyn AgentAdapter, text: &str) -> Vec<AgentEvent> {
        let mut out = Vec::new();
        for line in text.lines() {
            out.extend(adapter.parse_line(line));
        }
        out.extend(adapter.finish());
        out
    }

    pub fn text_of(events: &[AgentEvent]) -> String {
        let mut s = String::new();
        for e in events {
            match e {
                AgentEvent::Append(t) => s.push_str(t),
                AgentEvent::SetFull(t) => s = t.clone(),
                _ => {}
            }
        }
        s
    }

    pub fn req(prompt: &str) -> SpawnRequest {
        SpawnRequest {
            prompt: prompt.into(),
            agent_session_id: None,
            new_session_id: "11111111-2222-3333-4444-555555555555".into(),
            model: None,
            web_search: true,
            cwd: std::env::temp_dir(),
            pi_session_dir: std::env::temp_dir(),
            system_note: "note".into(),
            title: Some("Title".into()),
            images: vec![],
        }
    }

    /// A request carrying one image stored at `<cwd>/attachments/att_1/red.png`.
    pub fn req_with_image(prompt: &str) -> SpawnRequest {
        let mut r = req(prompt);
        r.images.push(ImageAttachment {
            path: r.cwd.join("attachments").join("att_1").join("red.png"),
            mime: "image/png".into(),
        });
        r
    }
}
