//! Reads the agents' own session history for a project folder, so a project
//! can list sessions that were run outside Gloss (in a terminal, an editor or
//! a script). Every agent files its sessions by the folder it ran in; each
//! submodule knows where one agent keeps them and how to read a title from
//! them. Cursor is not read: its sessions are opaque blobs in SQLite.
//!
//! Nothing here writes to the agents' files. Parsing is tolerant: lines that
//! are not JSON, or records of a kind not handled, are skipped.

mod claude;
mod codex;
mod gemini;
mod pi;

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use crate::env::ShellEnv;
use crate::types::{AgentId, ExternalSession, Role, SessionOrigin, SessionTurn};

/// The folder name Claude Code files a project's sessions under.
pub fn claude_slug(project: &str) -> String {
    claude::slug(project)
}

/// Where each agent keeps its history.
#[derive(Clone, Debug)]
pub struct AgentHomes {
    /// `~/.claude`, or `$CLAUDE_CONFIG_DIR`.
    pub claude: PathBuf,
    /// `~/.codex`, or `$CODEX_HOME`.
    pub codex: PathBuf,
    /// `~/.gemini`.
    pub gemini: PathBuf,
    /// `~/.pi/agent`, or `$PI_CODING_AGENT_DIR`.
    pub pi: PathBuf,
}

impl AgentHomes {
    pub fn from_env(env: &ShellEnv) -> AgentHomes {
        let home = dirs::home_dir().unwrap_or_default();
        let var = |key: &str| env.vars.get(key).filter(|v| !v.is_empty()).map(PathBuf::from);
        AgentHomes {
            claude: var("CLAUDE_CONFIG_DIR").unwrap_or_else(|| home.join(".claude")),
            codex: var("CODEX_HOME").unwrap_or_else(|| home.join(".codex")),
            gemini: home.join(".gemini"),
            pi: var("PI_CODING_AGENT_DIR").unwrap_or_else(|| home.join(".pi").join("agent")),
        }
    }

    /// Every home under one folder, as `<root>/.claude` and so on. For tests.
    pub fn under(root: &Path) -> AgentHomes {
        AgentHomes {
            claude: root.join(".claude"),
            codex: root.join(".codex"),
            gemini: root.join(".gemini"),
            pi: root.join(".pi").join("agent"),
        }
    }
}

/// What one session file says about itself.
#[derive(Clone, Debug)]
struct Scanned {
    /// The folder the session ran in, when the file records it.
    cwd: Option<String>,
    /// SHA-256 of that folder's path, which Gemini records instead of the path.
    project_hash: Option<String>,
    session: ExternalSession,
}

/// A file's modification time and length when it was read, and what it held.
type CacheEntry = (SystemTime, u64, Option<Scanned>);

/// Session files already read, keyed by path. An entry is reused while the
/// file's modification time and length are unchanged, so listing a project
/// again only stats files that have not been written since. `None` records a
/// file that holds no usable session (an empty one, for example).
#[derive(Default)]
pub struct SessionIndex {
    cache: Mutex<HashMap<PathBuf, CacheEntry>>,
}

impl SessionIndex {
    /// Sessions of every supported agent that ran in `project`, newest first.
    /// `project` is the canonical path Gloss stores for the project.
    pub fn list(&self, homes: &AgentHomes, project: &str) -> Vec<ExternalSession> {
        let mut out = Vec::new();
        out.extend(self.collect(claude::files(&homes.claude, project), project, claude::scan));
        out.extend(self.collect(codex::files(&homes.codex), project, codex::scan));
        out.extend(self.collect(gemini::files(&homes.gemini, project), project, gemini::scan));
        out.extend(self.collect(pi::files(&homes.pi, project), project, pi::scan));
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        out
    }

    /// Scans each file through the cache and keeps the sessions whose
    /// recorded folder (or folder hash) is `project`'s. A file that records
    /// neither is kept, since its location already ties it to the project.
    fn collect(&self, files: Vec<PathBuf>, project: &str, scan: fn(&Path) -> Option<Scanned>) -> Vec<ExternalSession> {
        let hash = gemini::project_hash(project);
        let mut out = Vec::new();
        for file in files {
            let Ok(meta) = std::fs::metadata(&file) else { continue };
            let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            let len = meta.len();
            let scanned = {
                let cache = self.cache.lock().unwrap();
                match cache.get(&file) {
                    Some((m, l, s)) if *m == modified && *l == len => Some(s.clone()),
                    _ => None,
                }
            };
            let scanned = match scanned {
                Some(s) => s,
                None => {
                    let s = scan(&file).map(|mut s| {
                        s.session.updated_at = millis(modified);
                        if s.session.created_at == 0 {
                            s.session.created_at = s.session.updated_at;
                        }
                        s
                    });
                    self.cache.lock().unwrap().insert(file.clone(), (modified, len, s.clone()));
                    s
                }
            };
            if let Some(s) = scanned {
                let cwd_ok = s.cwd.as_deref().is_none_or(|c| same_dir(c, project));
                let hash_ok = s.project_hash.as_deref().is_none_or(|h| h == hash);
                if cwd_ok && hash_ok {
                    out.push(s.session);
                }
            }
        }
        out
    }
}

/// Every turn of a session file, in order. Cursor sessions are not read and
/// give no turns.
pub fn read_turns(agent: AgentId, file: &Path) -> Vec<SessionTurn> {
    match agent {
        AgentId::Claude => claude::turns(file),
        AgentId::Codex => codex::turns(file),
        AgentId::Gemini => gemini::turns(file),
        AgentId::Pi => pi::turns(file),
        AgentId::Cursor => Vec::new(),
    }
}

/// Collects turns from records read in order. A prompt always starts a new
/// turn; reply text and tool calls join the reply in progress, so an agent
/// that writes one record per text block or tool call still gives one reply
/// per prompt.
#[derive(Default)]
struct Turns {
    list: Vec<SessionTurn>,
}

impl Turns {
    fn prompt(&mut self, text: &str, at: i64) {
        let text = text.trim();
        if !text.is_empty() {
            self.list.push(SessionTurn { role: Role::User, text: text.to_string(), tools: Vec::new(), at });
        }
    }

    fn reply(&mut self, at: i64) -> &mut SessionTurn {
        if self.list.last().is_none_or(|t| t.role != Role::Assistant) {
            self.list.push(SessionTurn { role: Role::Assistant, text: String::new(), tools: Vec::new(), at });
        }
        self.list.last_mut().expect("pushed above")
    }

    fn text(&mut self, text: &str, at: i64) {
        let text = text.trim();
        if text.is_empty() {
            return;
        }
        let turn = self.reply(at);
        if !turn.text.is_empty() {
            turn.text.push_str("\n\n");
        }
        turn.text.push_str(text);
    }

    fn tool(&mut self, name: &str, args: &serde_json::Value, at: i64) {
        let label = tool_label(name, args);
        self.reply(at).tools.push(label);
    }

    fn done(self) -> Vec<SessionTurn> {
        self.list
    }
}

/// A short label for a tool call: the tool's name and its main argument, a
/// file's name rather than its full path, cut to one line of 60 characters.
fn tool_label(name: &str, args: &serde_json::Value) -> String {
    // Some agents send the arguments as a JSON string.
    let parsed;
    let args = match args.as_str().map(serde_json::from_str::<serde_json::Value>) {
        Some(Ok(v)) => {
            parsed = v;
            &parsed
        }
        _ => args,
    };
    let main = ["file_path", "path", "absolute_path", "command", "cmd", "pattern", "query", "url", "description", "prompt"]
        .iter()
        .find_map(|k| match args.get(*k)? {
            serde_json::Value::String(s) => Some((*k, s.clone())),
            // Codex sends a shell command as an argv array; the script is last.
            serde_json::Value::Array(a) => a.iter().rev().find_map(|x| x.as_str()).map(|s| (*k, s.to_string())),
            _ => None,
        });
    let Some((key, value)) = main else { return name.to_string() };
    let value = if key.contains("path") {
        Path::new(&value).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or(value)
    } else {
        value.split_whitespace().collect::<Vec<_>>().join(" ")
    };
    let short: String = value.chars().take(60).collect();
    let more = if value.chars().count() > 60 { "…" } else { "" };
    format!("{} {}{}", name, short, more)
}

/// Every JSON line of a file. Lines that are not JSON are skipped.
fn all_lines(path: &Path) -> Vec<serde_json::Value> {
    let Ok(file) = std::fs::File::open(path) else { return Vec::new() };
    BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter_map(|l| serde_json::from_str(&l).ok())
        .collect()
}

/// The time of a record's `timestamp` field, or 0.
fn time_of(v: &serde_json::Value) -> i64 {
    str_at(v, "timestamp").and_then(parse_time).unwrap_or(0)
}

/// True when two folder paths name the same folder, ignoring a trailing slash.
fn same_dir(a: &str, b: &str) -> bool {
    a.trim_end_matches('/') == b.trim_end_matches('/')
}

fn millis(t: SystemTime) -> i64 {
    t.duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Unix milliseconds of an RFC 3339 timestamp such as `2026-05-07T01:29:31.413Z`.
fn parse_time(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|t| t.timestamp_millis())
}

/// Files in `dir` (not below it) with extension `ext`.
fn files_in(dir: &Path, ext: &str) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().and_then(|e| e.to_str()) == Some(ext))
        .collect()
}

/// The JSON lines among the first `budget` bytes of a file. A line cut off
/// by the budget is dropped, as is any line that is not JSON.
fn head_lines(path: &Path, budget: u64) -> Vec<serde_json::Value> {
    let Ok(file) = std::fs::File::open(path) else { return Vec::new() };
    let mut out = Vec::new();
    let mut read = 0u64;
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { break };
        read += line.len() as u64 + 1;
        if read > budget {
            break;
        }
        if let Ok(v) = serde_json::from_str(&line) {
            out.push(v);
        }
    }
    out
}

/// The JSON lines among the last `budget` bytes of a file. The first line
/// is usually cut off by the budget, so it fails to parse and is dropped.
fn tail_lines(path: &Path, budget: u64) -> Vec<serde_json::Value> {
    let Ok(mut file) = std::fs::File::open(path) else { return Vec::new() };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if file.seek(SeekFrom::Start(len.saturating_sub(budget))).is_err() {
        return Vec::new();
    }
    let mut buf = Vec::new();
    if file.read_to_end(&mut buf).is_err() {
        return Vec::new();
    }
    String::from_utf8_lossy(&buf)
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

/// One-line title from free text: whitespace collapsed, at most 80 characters.
/// None when nothing is left.
fn title_of(text: &str) -> Option<String> {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.is_empty() {
        return None;
    }
    if flat.chars().count() <= 80 {
        return Some(flat);
    }
    let cut: String = flat.chars().take(79).collect();
    Some(format!("{}…", cut.trim_end()))
}

/// The first text part of a message `content`, which agents write either as
/// a plain string or as an array of `{ "type": "text", "text": … }` parts.
fn first_text(content: &serde_json::Value) -> Option<&str> {
    match content {
        serde_json::Value::String(s) => Some(s.as_str()),
        serde_json::Value::Array(parts) => parts.iter().find_map(|p| {
            let typed_text = p.get("type").and_then(|t| t.as_str()).is_none_or(|t| t == "text" || t == "input_text");
            if typed_text {
                p.get("text").and_then(|t| t.as_str())
            } else {
                None
            }
        }),
        _ => None,
    }
}

/// True for a slash command such as `/login` or `/model gpt-5`, which
/// Gemini CLI and Pi record as a user message. A path like `/src/main.rs` is
/// not one: its first word has a second `/`.
fn is_slash_command(text: &str) -> bool {
    let first = text.split_whitespace().next().unwrap_or("");
    first.len() > 1 && first.starts_with('/') && !first[1..].contains('/') && first[1..].starts_with(|c: char| c.is_ascii_alphabetic())
}

fn str_at<'a>(v: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(|x| x.as_str())
}

/// Origin from a free-form label an agent records (an entrypoint, an
/// originator or a source name).
fn origin_of(label: &str) -> Option<SessionOrigin> {
    let l = label.to_ascii_lowercase();
    if l.contains("vscode") || l.contains("jetbrains") || l.contains("ide") {
        Some(SessionOrigin::Ide)
    } else if l.contains("desktop") {
        Some(SessionOrigin::Desktop)
    } else if l.contains("sdk") || l.contains("exec") || l.contains("headless") {
        Some(SessionOrigin::Headless)
    } else if l == "cli" || l.contains("cli") || l.contains("tui") {
        Some(SessionOrigin::Terminal)
    } else {
        None
    }
}

#[cfg(test)]
mod tests;
