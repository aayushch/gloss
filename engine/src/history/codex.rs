//! Codex keeps every session in one tree, whatever folder it ran in:
//! `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`. Finding a
//! project's sessions means reading the first record of each file; the
//! index caches that, so later listings only stat the files.
//!
//! Records read here:
//! - `session_meta` (always first): `payload.id`, `payload.cwd`,
//!   `payload.timestamp`, `payload.source` (`cli`, `exec`, `vscode`) and
//!   `payload.originator`.
//! - `event_msg` with `payload.type` `user_message`: the user's prompt as
//!   typed, in `payload.message`. The `response_item` user messages also
//!   hold injected context, so they are not used for the title.

use std::path::{Path, PathBuf};

use super::*;
use crate::types::AgentId;

/// The first record carries the agent's whole system prompt, so the head
/// read has to be generous to reach the first user message.
const HEAD_BYTES: u64 = 1024 * 1024;

pub(super) fn files(home: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    walk(&home.join("sessions"), 0, &mut out);
    out
}

/// Rollout files under `dir`, down to the day folders three levels below.
fn walk(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for path in entries.flatten().map(|e| e.path()) {
        if path.is_dir() && depth < 3 {
            walk(&path, depth + 1, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl")
            && path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("rollout-"))
        {
            out.push(path);
        }
    }
}

pub(super) fn scan(path: &Path) -> Option<Scanned> {
    let lines = head_lines(path, HEAD_BYTES);
    let meta = lines.iter().find(|v| str_at(v, "type") == Some("session_meta"))?.get("payload")?;
    let prompt = lines.iter().find_map(|v| {
        let p = v.get("payload")?;
        if str_at(v, "type") == Some("event_msg") && str_at(p, "type") == Some("user_message") {
            str_at(p, "message").map(str::to_string)
        } else {
            None
        }
    });
    let title = title_of(&prompt?)?;
    let origin = str_at(meta, "source").and_then(origin_of).or_else(|| str_at(meta, "originator").and_then(origin_of));
    Some(Scanned {
        project_hash: None,
        cwd: str_at(meta, "cwd").map(str::to_string),
        session: ExternalSession {
            agent: AgentId::Codex,
            id: str_at(meta, "id")?.to_string(),
            title,
            origin,
            file: path.to_string_lossy().to_string(),
            created_at: str_at(meta, "timestamp").and_then(parse_time).unwrap_or(0),
            updated_at: 0,
        },
    })
}
