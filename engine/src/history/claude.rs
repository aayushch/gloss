//! Claude Code keeps one JSONL file per session in
//! `~/.claude/projects/<slug>/<session id>.jsonl`, where the slug is the
//! folder path with every character other than a letter or digit replaced by
//! `-`. Subagent transcripts live in subfolders and are not read.
//!
//! Each line is a record with a `type`. Those read here:
//! - `user`: a message from the user, or a tool result sent back as one.
//!   It also carries `cwd`, `entrypoint` (`cli`, `sdk-cli`, `claude-vscode`…)
//!   and `timestamp`.
//! - `custom-title`: a name the user gave the session (`customTitle`).
//! - `ai-title`: a name Claude generated (`aiTitle`).
//!
//! Title records are repeated through the file and the last one counts, so
//! titles are taken from the file's tail, then its head.

use std::path::{Path, PathBuf};

use super::*;
use crate::types::AgentId;

/// How much of a session file is read from each end.
const HEAD_BYTES: u64 = 512 * 1024;
const TAIL_BYTES: u64 = 256 * 1024;

/// User messages that start with one of these are wrappers Claude Code
/// writes around slash commands, shell escapes and notices, not prompts.
const NOT_PROMPTS: &[&str] = &[
    "<command-",
    "<local-command",
    "<bash-",
    "<system-reminder",
    "<task-notification",
    "<user-memory-input",
    "Caveat:",
    "[Request interrupted",
];

pub(super) fn slug(project: &str) -> String {
    project.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

pub(super) fn files(home: &Path, project: &str) -> Vec<PathBuf> {
    files_in(&home.join("projects").join(slug(project)), "jsonl")
}

pub(super) fn scan(path: &Path) -> Option<Scanned> {
    let head = head_lines(path, HEAD_BYTES);
    let mut id = None;
    let mut cwd = None;
    let mut entrypoint = None;
    let mut created = None;
    let mut prompt = None;
    let mut custom = None;
    let mut ai = None;
    for v in &head {
        id = id.or_else(|| str_at(v, "sessionId").map(str::to_string));
        match str_at(v, "type") {
            Some("user") => {
                cwd = cwd.or_else(|| str_at(v, "cwd").map(str::to_string));
                entrypoint = entrypoint.or_else(|| str_at(v, "entrypoint").map(str::to_string));
                created = created.or_else(|| str_at(v, "timestamp").and_then(parse_time));
                if prompt.is_none() {
                    prompt = prompt_of(v);
                }
            }
            Some("custom-title") => custom = str_at(v, "customTitle").map(str::to_string).or(custom),
            Some("ai-title") => ai = str_at(v, "aiTitle").map(str::to_string).or(ai),
            _ => {}
        }
    }
    let file_len = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if file_len > HEAD_BYTES {
        for v in tail_lines(path, TAIL_BYTES) {
            match str_at(&v, "type") {
                Some("custom-title") => custom = str_at(&v, "customTitle").map(str::to_string).or(custom),
                Some("ai-title") => ai = str_at(&v, "aiTitle").map(str::to_string).or(ai),
                _ => {}
            }
        }
    }
    // A file with no prompt and no title is a session that was opened and
    // left without a message.
    let title = custom.or(ai).or(prompt).and_then(|t| title_of(&t))?;
    let id = id.or_else(|| path.file_stem().map(|s| s.to_string_lossy().to_string()))?;
    Some(Scanned {
        project_hash: None,
        cwd,
        session: ExternalSession {
            agent: AgentId::Claude,
            id,
            title,
            origin: entrypoint.as_deref().and_then(origin_of),
            file: path.to_string_lossy().to_string(),
            created_at: created.unwrap_or(0),
            updated_at: 0,
        },
    })
}

/// The prompt text of a `user` record, or None for a tool result, a
/// sidechain or meta message, or a command wrapper.
fn prompt_of(v: &serde_json::Value) -> Option<String> {
    if v.get("isMeta").and_then(|x| x.as_bool()) == Some(true) || v.get("isSidechain").and_then(|x| x.as_bool()) == Some(true) {
        return None;
    }
    let content = v.get("message")?.get("content")?;
    if let Some(parts) = content.as_array() {
        if parts.iter().any(|p| str_at(p, "type") == Some("tool_result")) {
            return None;
        }
    }
    let text = first_text(content)?.trim();
    if text.is_empty() || NOT_PROMPTS.iter().any(|p| text.starts_with(p)) {
        return None;
    }
    Some(text.to_string())
}
