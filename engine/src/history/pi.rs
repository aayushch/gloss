//! Pi keeps a project's sessions in `~/.pi/agent/sessions/--<slug>--/`,
//! where the slug is the folder path without its leading `/` and with every
//! other `/` replaced by `-` (`/Users/me/app` → `--Users-me-app--`). Gloss
//! runs Pi with its own session folder, so these are sessions run outside
//! Gloss.
//!
//! Each session is a JSONL file: a header `{ type: "session", id, cwd,
//! timestamp }`, then records such as `{ type: "message", message: { role,
//! content } }`. A `session_info` record, when present, carries a `name`.

use std::path::{Path, PathBuf};

use super::*;
use crate::types::AgentId;

const HEAD_BYTES: u64 = 512 * 1024;

pub(super) fn slug(project: &str) -> String {
    format!("--{}--", project.trim_start_matches('/').replace('/', "-"))
}

pub(super) fn files(home: &Path, project: &str) -> Vec<PathBuf> {
    files_in(&home.join("sessions").join(slug(project)), "jsonl")
}

pub(super) fn scan(path: &Path) -> Option<Scanned> {
    let lines = head_lines(path, HEAD_BYTES);
    let header = lines.iter().find(|v| str_at(v, "type") == Some("session"))?;
    let name = lines
        .iter()
        .rev()
        .filter(|v| str_at(v, "type") == Some("session_info"))
        .find_map(|v| str_at(v, "name"))
        .map(str::to_string);
    let prompt = lines.iter().find_map(|v| {
        let m = v.get("message")?;
        if str_at(v, "type") == Some("message") && str_at(m, "role") == Some("user") {
            first_text(m.get("content")?).filter(|t| !is_slash_command(t)).map(str::to_string)
        } else {
            None
        }
    });
    let title = name.or(prompt).and_then(|t| title_of(&t))?;
    Some(Scanned {
        cwd: str_at(header, "cwd").map(str::to_string),
        project_hash: None,
        session: ExternalSession {
            agent: AgentId::Pi,
            id: str_at(header, "id")?.to_string(),
            title,
            origin: None,
            file: path.to_string_lossy().to_string(),
            created_at: str_at(header, "timestamp").and_then(parse_time).unwrap_or(0),
            updated_at: 0,
        },
    })
}
