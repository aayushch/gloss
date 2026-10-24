// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

//! Pi keeps a project's sessions in `~/.pi/agent/sessions/--<slug>--/`,
//! where the slug is the folder path without its first character when that
//! is `/` or `\`, and with every other `/`, `\` and `:` replaced by `-`
//! (`/Users/me/app` → `--Users-me-app--`, `C:\Users\me\app` →
//! `--C--Users-me-app--`), as Pi's `getDefaultSessionDirPath` does. Gloss
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
    let rest = project.strip_prefix(['/', '\\']).unwrap_or(project);
    format!("--{}--", rest.replace(['/', '\\', ':'], "-"))
}

pub(super) fn files(home: &Path, project: &str) -> Vec<PathBuf> {
    files_in(&home.join("sessions").join(slug(project)), "jsonl")
}

pub(super) fn scan(path: &Path) -> Option<Scanned> {
    let lines = head_lines(path, HEAD_BYTES);
    let header = lines
        .iter()
        .find(|v| str_at(v, "type") == Some("session"))?;
    let name = lines
        .iter()
        .rev()
        .filter(|v| str_at(v, "type") == Some("session_info"))
        .find_map(|v| str_at(v, "name"))
        .map(str::to_string);
    let prompt = lines.iter().find_map(|v| {
        let m = v.get("message")?;
        if str_at(v, "type") == Some("message") && str_at(m, "role") == Some("user") {
            first_text(m.get("content")?)
                .filter(|t| !is_slash_command(t))
                .map(str::to_string)
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
            created_at: str_at(header, "timestamp")
                .and_then(parse_time)
                .unwrap_or(0),
            updated_at: 0,
        },
    })
}

/// Every turn: `message` records from the user are prompts; the
/// assistant's hold `text` and `toolCall` parts. Tool results and thinking
/// are left out.
pub(super) fn turns(path: &Path) -> Vec<crate::types::SessionTurn> {
    let mut out = Turns::default();
    for v in all_lines(path) {
        if str_at(&v, "type") != Some("message") {
            continue;
        }
        let at = time_of(&v);
        let Some(m) = v.get("message") else { continue };
        let content = m.get("content").unwrap_or(&serde_json::Value::Null);
        match str_at(m, "role") {
            Some("user") => out.prompt(first_text(content).unwrap_or(""), at),
            Some("assistant") => {
                if let Some(s) = content.as_str() {
                    out.text(s, at);
                }
                for part in content.as_array().into_iter().flatten() {
                    match str_at(part, "type") {
                        Some("text") => out.text(str_at(part, "text").unwrap_or(""), at),
                        Some("toolCall") => out.tool(
                            str_at(part, "name").unwrap_or("tool"),
                            part.get("arguments").unwrap_or(&serde_json::Value::Null),
                            at,
                        ),
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    out.done()
}
