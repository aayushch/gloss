//! Gemini CLI keeps a project's sessions in `~/.gemini/tmp/<dir>/chats/`.
//! Current versions name `<dir>` after the folder, as listed in
//! `~/.gemini/projects.json` (`{ "projects": { "<path>": "<dir>" } }`), and
//! write a `.project_root` file holding the path into it. Older versions
//! used the SHA-256 of the path as `<dir>`. All three are checked.
//!
//! A session is `session-<time>-<id>.jsonl`: a header line
//! `{ sessionId, projectHash, startTime, lastUpdated, kind }`, then one line
//! per message `{ type: "user" | "gemini" | "info", content }`, with
//! `{ "$set": {...} }` lines updating the header. Older versions wrote one
//! `.json` object with the messages in a `messages` array. `projectHash` is
//! the SHA-256 of the folder path, which ties a file to its folder.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::*;
use crate::types::AgentId;

const HEAD_BYTES: u64 = 512 * 1024;

pub(super) fn project_hash(project: &str) -> String {
    Sha256::digest(project.as_bytes()).iter().map(|b| format!("{:02x}", b)).collect()
}

pub(super) fn files(home: &Path, project: &str) -> Vec<PathBuf> {
    let tmp = home.join("tmp");
    let mut dirs: Vec<PathBuf> = Vec::new();
    let listed = std::fs::read_to_string(home.join("projects.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("projects")?.get(project)?.as_str().map(str::to_string));
    if let Some(name) = listed {
        dirs.push(tmp.join(name));
    }
    if let Ok(entries) = std::fs::read_dir(&tmp) {
        for dir in entries.flatten().map(|e| e.path()) {
            let root = std::fs::read_to_string(dir.join(".project_root")).unwrap_or_default();
            if same_dir(root.trim(), project) && !dirs.contains(&dir) {
                dirs.push(dir);
            }
        }
    }
    let hashed = tmp.join(project_hash(project));
    if !dirs.contains(&hashed) {
        dirs.push(hashed);
    }
    let mut out = Vec::new();
    for dir in dirs {
        let chats = dir.join("chats");
        out.extend(files_in(&chats, "jsonl"));
        out.extend(files_in(&chats, "json"));
    }
    out.retain(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("session-")));
    out
}

pub(super) fn scan(path: &Path) -> Option<Scanned> {
    let records: Vec<serde_json::Value> = if path.extension().and_then(|e| e.to_str()) == Some("json") {
        let whole: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
        let mut out = vec![whole.clone()];
        if let Some(messages) = whole.get("messages").and_then(|m| m.as_array()) {
            out.extend(messages.iter().cloned());
        }
        out
    } else {
        head_lines(path, HEAD_BYTES)
    };
    let header = records.first()?;
    // Subagent sessions are written beside the main ones; only `main` is a conversation.
    if str_at(header, "kind").is_some_and(|k| k != "main") {
        return None;
    }
    let prompt = records
        .iter()
        .skip(1)
        .filter(|v| str_at(v, "type") == Some("user"))
        .filter_map(|v| first_text(v.get("content")?))
        .find(|t| !is_slash_command(t))
        .map(str::to_string);
    let summary = records
        .iter()
        .rev()
        .find_map(|v| str_at(v, "summary").or_else(|| str_at(v.get("$set")?, "summary")))
        .map(str::to_string);
    let title = summary.or(prompt).and_then(|t| title_of(&t))?;
    Some(Scanned {
        cwd: None,
        project_hash: str_at(header, "projectHash").map(str::to_string),
        session: ExternalSession {
            agent: AgentId::Gemini,
            id: str_at(header, "sessionId")?.to_string(),
            title,
            origin: None,
            file: path.to_string_lossy().to_string(),
            created_at: str_at(header, "startTime").and_then(parse_time).unwrap_or(0),
            updated_at: 0,
        },
    })
}

/// Every turn: `user` messages are prompts, `gemini` messages are replies
/// with their `toolCalls`. Info and error messages are left out.
pub(super) fn turns(path: &Path) -> Vec<crate::types::SessionTurn> {
    let records = if path.extension().and_then(|e| e.to_str()) == Some("json") {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .and_then(|v| v.get("messages").and_then(|m| m.as_array()).cloned())
            .unwrap_or_default()
    } else {
        all_lines(path)
    };
    let mut out = Turns::default();
    for v in records {
        let at = time_of(&v);
        let content = v.get("content").unwrap_or(&serde_json::Value::Null);
        match str_at(&v, "type") {
            Some("user") => out.prompt(&all_text(content), at),
            Some("gemini") => {
                out.text(&all_text(content), at);
                for call in v.get("toolCalls").and_then(|c| c.as_array()).into_iter().flatten() {
                    out.tool(str_at(call, "name").unwrap_or("tool"), call.get("args").unwrap_or(&serde_json::Value::Null), at);
                }
            }
            _ => {}
        }
    }
    out.done()
}

/// Message content as one text: a string as it is, or the `text` of every part.
fn all_text(content: &serde_json::Value) -> String {
    match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(parts) => parts.iter().filter_map(|p| str_at(p, "text")).collect::<Vec<_>>().join("\n\n"),
        _ => String::new(),
    }
}
