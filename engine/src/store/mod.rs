//! SQLite persistence for conversations, turns, clarifications and settings.

use std::path::Path;
use std::sync::Mutex;

use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::types::*;

const SCHEMA: &str = include_str!("schema.sql");
const SCHEMA_VERSION: i64 = 6;

/// Columns and data a version 1 database lacks. `turns_fts` itself comes from
/// the schema; this only fills it from the turns that already exist.
const MIGRATE_V1_TO_V2: &str = "
    ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE conversations ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
    INSERT INTO turns_fts (turn_id, conversation_id, text)
        SELECT id, conversation_id, text FROM turns WHERE status IN ('done', 'error', 'cancelled');
    UPDATE schema_version SET version = 2;
";

/// Version 3 adds the project folder a conversation is bound to.
const MIGRATE_V2_TO_V3: &str = "
    ALTER TABLE conversations ADD COLUMN project_dir TEXT;
    UPDATE schema_version SET version = 3;
";

/// Version 4 adds the agent's working mode inside that folder.
const MIGRATE_V3_TO_V4: &str = "
    ALTER TABLE conversations ADD COLUMN mode TEXT;
    UPDATE schema_version SET version = 4;
";

/// Version 5 adds projects. The `projects` table itself comes from the
/// schema; this makes every folder an existing conversation is bound to a
/// project, dated by its first conversation.
const MIGRATE_V4_TO_V5: &str = "
    INSERT OR IGNORE INTO projects (path, created_at)
        SELECT project_dir, MIN(created_at) FROM conversations
        WHERE project_dir IS NOT NULL GROUP BY project_dir;
    UPDATE schema_version SET version = 5;
";

/// Version 6 records which outside session a conversation continued.
const MIGRATE_V5_TO_V6: &str = "
    ALTER TABLE conversations ADD COLUMN origin_file TEXT;
    ALTER TABLE conversations ADD COLUMN origin_until INTEGER;
    UPDATE schema_version SET version = 6;
";

pub struct Store {
    conn: Mutex<Connection>,
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Short random id with a type prefix, e.g. `conv_3fa85f64a1b2`.
pub fn new_id(prefix: &str) -> String {
    let hex = uuid::Uuid::new_v4().simple().to_string();
    format!("{}_{}", prefix, &hex[..12])
}

impl Store {
    pub fn open(path: &Path) -> Result<Store> {
        let conn = Connection::open(path).with_context(|| format!("open {}", path.display()))?;
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")?;
        // The version is read before the schema runs so a version 1 file is
        // told apart from a brand new one, whose tables the schema creates
        // with every column already present.
        let version: Option<i64> = conn
            .query_row("SELECT version FROM schema_version LIMIT 1", [], |r| r.get(0))
            .optional()
            .unwrap_or(None);
        conn.execute_batch(SCHEMA)?;
        match version {
            None => {
                conn.execute("INSERT INTO schema_version (version) VALUES (?1)", params![SCHEMA_VERSION])?;
            }
            Some(1) => {
                conn.execute_batch(MIGRATE_V1_TO_V2)?;
                conn.execute_batch(MIGRATE_V2_TO_V3)?;
                conn.execute_batch(MIGRATE_V3_TO_V4)?;
                conn.execute_batch(MIGRATE_V4_TO_V5)?;
                conn.execute_batch(MIGRATE_V5_TO_V6)?;
            }
            Some(2) => {
                conn.execute_batch(MIGRATE_V2_TO_V3)?;
                conn.execute_batch(MIGRATE_V3_TO_V4)?;
                conn.execute_batch(MIGRATE_V4_TO_V5)?;
                conn.execute_batch(MIGRATE_V5_TO_V6)?;
            }
            Some(3) => {
                conn.execute_batch(MIGRATE_V3_TO_V4)?;
                conn.execute_batch(MIGRATE_V4_TO_V5)?;
                conn.execute_batch(MIGRATE_V5_TO_V6)?;
            }
            Some(4) => {
                conn.execute_batch(MIGRATE_V4_TO_V5)?;
                conn.execute_batch(MIGRATE_V5_TO_V6)?;
            }
            Some(5) => conn.execute_batch(MIGRATE_V5_TO_V6)?,
            Some(v) if v > SCHEMA_VERSION => {
                return Err(anyhow!(
                    "database schema version {} is newer than this build supports ({})",
                    v,
                    SCHEMA_VERSION
                ));
            }
            Some(_) => {}
        }
        Ok(Store { conn: Mutex::new(conn) })
    }

    pub fn in_memory() -> Result<Store> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        conn.execute_batch(SCHEMA)?;
        conn.execute("INSERT INTO schema_version (version) VALUES (?1)", params![SCHEMA_VERSION])?;
        Ok(Store { conn: Mutex::new(conn) })
    }

    fn with<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let conn = self.conn.lock().map_err(|_| anyhow!("store lock poisoned"))?;
        f(&conn)
    }

    // ── settings ────────────────────────────────────────────────────────

    pub fn settings(&self) -> Result<Settings> {
        self.with(|c| {
            let raw: Option<String> = c
                .query_row("SELECT value FROM settings WHERE key = 'settings'", [], |r| r.get(0))
                .optional()?;
            Ok(raw
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default())
        })
    }

    pub fn save_settings(&self, settings: &Settings) -> Result<()> {
        let json = serde_json::to_string(settings)?;
        self.with(|c| {
            c.execute(
                "INSERT INTO settings (key, value) VALUES ('settings', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![json],
            )?;
            Ok(())
        })
    }

    // ── projects ────────────────────────────────────────────────────────

    /// Adds `path` as a project; adding one that exists already returns it unchanged.
    pub fn add_project(&self, path: &str) -> Result<Project> {
        self.with(|c| {
            c.execute(
                "INSERT OR IGNORE INTO projects (path, created_at) VALUES (?1, ?2)",
                params![path, now_ms()],
            )?;
            Ok(())
        })?;
        self.list_projects()?
            .into_iter()
            .find(|p| p.path == path)
            .ok_or_else(|| anyhow!("no project {}", path))
    }

    /// Projects, most recently active first. A project is active when it is
    /// added and whenever one of its conversations is updated.
    pub fn list_projects(&self) -> Result<Vec<Project>> {
        self.with(|c| {
            let mut stmt = c.prepare(
                "SELECT p.path, p.created_at,
                        MAX(p.created_at, COALESCE((SELECT MAX(updated_at) FROM conversations WHERE project_dir = p.path), 0)) AS active
                 FROM projects p ORDER BY active DESC, p.path",
            )?;
            let rows = stmt.query_map([], |r| {
                let path: String = r.get(0)?;
                Ok(Project {
                    name: project_name(&path),
                    path,
                    created_at: r.get(1)?,
                    last_active_at: r.get(2)?,
                })
            })?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
    }

    /// Removes the project only. Its conversations keep their folder and are
    /// still listed, outside any project.
    pub fn remove_project(&self, path: &str) -> Result<()> {
        self.with(|c| {
            c.execute("DELETE FROM projects WHERE path = ?1", params![path])?;
            Ok(())
        })
    }

    // ── conversations ───────────────────────────────────────────────────

    pub fn create_conversation(&self, agent: AgentId, model: &str, web_search: bool, project_dir: Option<&str>) -> Result<Conversation> {
        let id = new_id("conv");
        let now = now_ms();
        self.with(|c| {
            c.execute(
                "INSERT INTO conversations (id, title, agent, model, web_search, project_dir, created_at, updated_at)
                 VALUES (?1, 'New conversation', ?2, ?3, ?4, ?5, ?6, ?6)",
                params![id, agent.as_str(), model, web_search as i64, project_dir, now],
            )?;
            Ok(())
        })?;
        self.get_conversation(&id)
    }

    /// Conversations, pinned first and newest first within each group. `query`
    /// keeps those whose title or any finished turn matches (full-text, every
    /// word as a prefix); `tag` keeps those carrying that tag.
    pub fn list_conversations(&self, query: Option<&str>, tag: Option<&str>) -> Result<Vec<ConversationSummary>> {
        let fts = query.and_then(fts_expression);
        let tag = tag.map(|t| t.trim().to_lowercase()).filter(|t| !t.is_empty());
        self.with(|c| {
            let mut sql = format!("{} WHERE 1 = 1", SUMMARY_SELECT);
            let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
            if let Some(expr) = &fts {
                let like = format!("%{}%", query.unwrap_or("").trim().replace('%', "\\%").replace('_', "\\_"));
                sql.push_str(
                    " AND (c.title LIKE ? ESCAPE '\\' COLLATE NOCASE
                           OR c.id IN (SELECT conversation_id FROM turns_fts WHERE turns_fts MATCH ?))",
                );
                args.push(Box::new(like));
                args.push(Box::new(expr.clone()));
            }
            if let Some(t) = &tag {
                sql.push_str(" AND EXISTS (SELECT 1 FROM json_each(c.tags) WHERE json_each.value = ?)");
                args.push(Box::new(t.clone()));
            }
            sql.push_str(" ORDER BY c.pinned DESC, c.updated_at DESC");
            let mut stmt = c.prepare(&sql)?;
            let refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|a| a.as_ref()).collect();
            let rows = stmt.query_map(refs.as_slice(), row_summary)?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
    }

    pub fn set_pinned(&self, id: &str, pinned: bool) -> Result<ConversationSummary> {
        self.with(|c| {
            c.execute("UPDATE conversations SET pinned = ?2 WHERE id = ?1", params![id, pinned as i64])?;
            Ok(())
        })?;
        self.get_summary(id)
    }

    /// Replace a conversation's tags. Tags are trimmed, lower-cased and
    /// de-duplicated; empty ones are dropped.
    pub fn set_tags(&self, id: &str, tags: &[String]) -> Result<ConversationSummary> {
        let json = serde_json::to_string(&normalize_tags(tags))?;
        self.with(|c| {
            c.execute("UPDATE conversations SET tags = ?2 WHERE id = ?1", params![id, json])?;
            Ok(())
        })?;
        self.get_summary(id)
    }

    /// Every tag in use, most used first.
    pub fn list_tags(&self) -> Result<Vec<String>> {
        self.with(|c| {
            let mut stmt = c.prepare(
                "SELECT json_each.value, COUNT(*) AS n FROM conversations, json_each(conversations.tags)
                 GROUP BY json_each.value ORDER BY n DESC, json_each.value",
            )?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
    }

    /// Full-text hits for `query`, best match first, at most `limit` rows.
    /// A conversation whose title matches contributes one row with no turn.
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>> {
        let Some(expr) = fts_expression(query) else {
            return Ok(Vec::new());
        };
        let like = format!("%{}%", query.trim().replace('%', "\\%").replace('_', "\\_"));
        self.with(|c| {
            let mut out = Vec::new();
            let mut stmt = c.prepare(
                "SELECT c.id, c.title, c.agent, c.updated_at FROM conversations c
                 WHERE c.title LIKE ?1 ESCAPE '\\' COLLATE NOCASE
                 ORDER BY c.updated_at DESC LIMIT ?2",
            )?;
            let titles = stmt.query_map(params![like, limit as i64], |r| {
                let agent: String = r.get(2)?;
                Ok(SearchHit {
                    conversation_id: r.get(0)?,
                    title: r.get(1)?,
                    agent: AgentId::parse(&agent).unwrap_or(AgentId::Claude),
                    turn_id: None,
                    role: None,
                    clarification_id: None,
                    snippet: String::new(),
                    updated_at: r.get(3)?,
                })
            })?;
            out.extend(titles.collect::<Result<Vec<_>, _>>()?);
            let mut stmt = c.prepare(
                "SELECT c.id, c.title, c.agent, t.id, t.role, t.clarification_id,
                        snippet(turns_fts, 2, char(1), char(2), '…', 14), c.updated_at
                 FROM turns_fts
                 JOIN turns t ON t.id = turns_fts.turn_id
                 JOIN conversations c ON c.id = t.conversation_id
                 WHERE turns_fts MATCH ?1
                 ORDER BY bm25(turns_fts) LIMIT ?2",
            )?;
            let hits = stmt.query_map(params![expr, limit as i64], |r| {
                let agent: String = r.get(2)?;
                let role: String = r.get(4)?;
                Ok(SearchHit {
                    conversation_id: r.get(0)?,
                    title: r.get(1)?,
                    agent: AgentId::parse(&agent).unwrap_or(AgentId::Claude),
                    turn_id: r.get(3)?,
                    role: Role::parse(&role),
                    clarification_id: r.get(5)?,
                    snippet: r.get(6)?,
                    updated_at: r.get(7)?,
                })
            })?;
            out.extend(hits.collect::<Result<Vec<_>, _>>()?);
            Ok(out)
        })
    }

    pub fn get_summary(&self, id: &str) -> Result<ConversationSummary> {
        self.with(|c| {
            c.query_row(&format!("{} WHERE c.id = ?1", SUMMARY_SELECT), params![id], row_summary)
            .optional()?
            .ok_or_else(|| anyhow!("no conversation {}", id))
        })
    }

    pub fn get_conversation(&self, id: &str) -> Result<Conversation> {
        let summary = self.get_summary(id)?;
        self.with(|c| {
            let (agent_session_id, continued_from): (Option<String>, Option<String>) = c.query_row(
                "SELECT agent_session_id, origin_file FROM conversations WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            let mut stmt = c.prepare(
                "SELECT id, conversation_id, seq, role, text, prompt_text, status, clarification_id,
                        model, error, usage_json, created_at, completed_at
                 FROM turns WHERE conversation_id = ?1 ORDER BY seq",
            )?;
            let mut turns = stmt
                .query_map(params![id], row_turn)?
                .collect::<Result<Vec<_>, _>>()?;
            let mut stmt = c.prepare(&format!(
                "{} WHERE a.turn_id IN (SELECT id FROM turns WHERE conversation_id = ?1) ORDER BY a.created_at",
                ATTACHMENT_SELECT
            ))?;
            for att in stmt.query_map(params![id], row_attachment)? {
                let att = att?;
                if let Some(t) = turns.iter_mut().find(|t| Some(&t.id) == att.turn_id.as_ref()) {
                    t.attachments.push(att);
                }
            }
            let mut stmt = c.prepare(
                "SELECT id, conversation_id, number, anchor_block_id, quote, parent_id, open, created_at
                 FROM clarifications WHERE conversation_id = ?1 ORDER BY number",
            )?;
            let clarifications = stmt
                .query_map(params![id], row_clarification)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(Conversation {
                summary,
                agent_session_id,
                continued_from,
                running: false,
                pending_request: None,
                turns,
                clarifications,
            })
        })
    }

    pub fn agent_session_id(&self, id: &str) -> Result<Option<String>> {
        self.with(|c| {
            Ok(c.query_row(
                "SELECT agent_session_id FROM conversations WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )?)
        })
    }

    /// Marks a conversation as continuing the session in `file`, taken over at `until`.
    pub fn set_origin(&self, id: &str, file: &str, until: i64) -> Result<()> {
        self.with(|c| {
            c.execute(
                "UPDATE conversations SET origin_file = ?2, origin_until = ?3 WHERE id = ?1",
                params![id, file, until],
            )?;
            Ok(())
        })
    }

    /// The outside session file a conversation continued and when it took over, if any.
    pub fn origin(&self, id: &str) -> Result<Option<(String, i64)>> {
        self.with(|c| {
            let row: (Option<String>, Option<i64>) = c.query_row(
                "SELECT origin_file, origin_until FROM conversations WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            Ok(row.0.map(|f| (f, row.1.unwrap_or(i64::MAX))))
        })
    }

    /// Every agent session id a conversation holds, whichever agent it belongs to.
    pub fn agent_session_ids(&self) -> Result<std::collections::HashSet<String>> {
        self.with(|c| {
            let mut stmt = c.prepare("SELECT agent_session_id FROM conversations WHERE agent_session_id IS NOT NULL")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            Ok(rows.collect::<Result<_, _>>()?)
        })
    }

    pub fn set_agent_session_id(&self, id: &str, session_id: &str) -> Result<()> {
        self.with(|c| {
            c.execute(
                "UPDATE conversations SET agent_session_id = ?2 WHERE id = ?1",
                params![id, session_id],
            )?;
            Ok(())
        })
    }

    pub fn rename_conversation(&self, id: &str, title: &str) -> Result<ConversationSummary> {
        self.with(|c| {
            c.execute(
                "UPDATE conversations SET title = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, title, now_ms()],
            )?;
            Ok(())
        })?;
        self.get_summary(id)
    }

    /// Replace the placeholder title with one derived from the first message.
    /// Returns true when the title changed.
    pub fn set_title_if_placeholder(&self, id: &str, title: &str) -> Result<bool> {
        self.with(|c| {
            let n = c.execute(
                "UPDATE conversations SET title = ?2 WHERE id = ?1 AND title = 'New conversation'",
                params![id, title],
            )?;
            Ok(n > 0)
        })
    }

    pub fn set_model(&self, id: &str, model: &str) -> Result<ConversationSummary> {
        self.with(|c| {
            c.execute("UPDATE conversations SET model = ?2 WHERE id = ?1", params![id, model])?;
            Ok(())
        })?;
        self.get_summary(id)
    }

    /// Sets the working mode; None means read-only.
    pub fn set_mode(&self, id: &str, mode: Option<&str>) -> Result<ConversationSummary> {
        self.with(|c| {
            c.execute("UPDATE conversations SET mode = ?2 WHERE id = ?1", params![id, mode])?;
            Ok(())
        })?;
        self.get_summary(id)
    }

    pub fn set_web_search(&self, id: &str, enabled: bool) -> Result<ConversationSummary> {
        self.with(|c| {
            c.execute(
                "UPDATE conversations SET web_search = ?2 WHERE id = ?1",
                params![id, enabled as i64],
            )?;
            Ok(())
        })?;
        self.get_summary(id)
    }

    pub fn touch_conversation(&self, id: &str) -> Result<()> {
        self.with(|c| {
            c.execute(
                "UPDATE conversations SET updated_at = ?2 WHERE id = ?1",
                params![id, now_ms()],
            )?;
            Ok(())
        })
    }

    pub fn delete_conversation(&self, id: &str) -> Result<()> {
        self.with(|c| {
            c.execute("DELETE FROM conversations WHERE id = ?1", params![id])?;
            Ok(())
        })
    }

    // ── turns ───────────────────────────────────────────────────────────

    pub fn turn_count(&self, conversation_id: &str) -> Result<i64> {
        self.with(|c| {
            Ok(c.query_row(
                "SELECT COUNT(*) FROM turns WHERE conversation_id = ?1",
                params![conversation_id],
                |r| r.get(0),
            )?)
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_turn(
        &self,
        conversation_id: &str,
        role: Role,
        text: &str,
        prompt_text: Option<&str>,
        status: TurnStatus,
        clarification_id: Option<&str>,
        model: Option<&str>,
    ) -> Result<Turn> {
        let id = new_id("turn");
        let now = now_ms();
        self.with(|c| {
            let seq: i64 = c.query_row(
                "SELECT COALESCE(MAX(seq), 0) + 1 FROM turns WHERE conversation_id = ?1",
                params![conversation_id],
                |r| r.get(0),
            )?;
            let completed_at = status.is_terminal().then_some(now);
            c.execute(
                "INSERT INTO turns (id, conversation_id, seq, role, text, prompt_text, status,
                                    clarification_id, model, created_at, completed_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    id,
                    conversation_id,
                    seq,
                    role.as_str(),
                    text,
                    prompt_text,
                    status.as_str(),
                    clarification_id,
                    model,
                    now,
                    completed_at
                ],
            )?;
            c.execute(
                "UPDATE conversations SET updated_at = ?2 WHERE id = ?1",
                params![conversation_id, now],
            )?;
            Ok(())
        })?;
        self.get_turn(&id)
    }

    pub fn get_turn(&self, id: &str) -> Result<Turn> {
        self.with(|c| {
            c.query_row(
                "SELECT id, conversation_id, seq, role, text, prompt_text, status, clarification_id,
                        model, error, usage_json, created_at, completed_at
                 FROM turns WHERE id = ?1",
                params![id],
                row_turn,
            )
            .optional()?
            .ok_or_else(|| anyhow!("no turn {}", id))
        })
    }

    /// Store the text produced so far and mark the turn as streaming.
    pub fn update_turn_text(&self, id: &str, text: &str) -> Result<()> {
        self.with(|c| {
            c.execute(
                "UPDATE turns SET text = ?2, status = CASE WHEN status = 'pending' THEN 'streaming' ELSE status END
                 WHERE id = ?1",
                params![id, text],
            )?;
            Ok(())
        })
    }

    pub fn set_turn_model(&self, id: &str, model: &str) -> Result<()> {
        self.with(|c| {
            c.execute("UPDATE turns SET model = ?2 WHERE id = ?1", params![id, model])?;
            Ok(())
        })
    }

    /// Final write for an assistant turn.
    pub fn finish_turn(
        &self,
        id: &str,
        text: &str,
        status: TurnStatus,
        error: Option<&str>,
        usage: Option<&Usage>,
    ) -> Result<Turn> {
        let usage_json = usage.map(serde_json::to_string).transpose()?;
        self.with(|c| {
            c.execute(
                "UPDATE turns SET text = ?2, status = ?3, error = ?4, usage_json = ?5, completed_at = ?6
                 WHERE id = ?1",
                params![id, text, status.as_str(), error, usage_json, now_ms()],
            )?;
            Ok(())
        })?;
        self.get_turn(id)
    }

    /// Mark turns that never finished (the app exited mid-turn) as errors.
    pub fn fail_unfinished_turns(&self, message: &str) -> Result<usize> {
        self.with(|c| {
            Ok(c.execute(
                "UPDATE turns SET status = 'error', error = ?1, completed_at = ?2
                 WHERE status IN ('pending', 'streaming')",
                params![message, now_ms()],
            )?)
        })
    }

    // ── attachments ─────────────────────────────────────────────────────

    #[allow(clippy::too_many_arguments)]
    pub fn create_attachment(
        &self,
        id: &str,
        name: &str,
        mime: &str,
        kind: AttachmentKind,
        size: u64,
        path: &str,
    ) -> Result<Attachment> {
        self.with(|c| {
            c.execute(
                "INSERT INTO attachments (id, name, mime, kind, size, path, turn_id, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7)",
                params![id, name, mime, kind.as_str(), size as i64, path, now_ms()],
            )?;
            Ok(())
        })?;
        self.get_attachment(id)
    }

    pub fn get_attachment(&self, id: &str) -> Result<Attachment> {
        self.with(|c| {
            c.query_row(&format!("{} WHERE a.id = ?1", ATTACHMENT_SELECT), params![id], row_attachment)
                .optional()?
                .ok_or_else(|| anyhow!("no attachment {}", id))
        })
    }

    /// Bind staged attachments to the user turn that sends them.
    pub fn link_attachments(&self, turn_id: &str, ids: &[String]) -> Result<()> {
        self.with(|c| {
            for id in ids {
                c.execute("UPDATE attachments SET turn_id = ?2 WHERE id = ?1", params![id, turn_id])?;
            }
            Ok(())
        })
    }

    pub fn delete_attachment(&self, id: &str) -> Result<()> {
        self.with(|c| {
            c.execute("DELETE FROM attachments WHERE id = ?1", params![id])?;
            Ok(())
        })
    }

    /// Attachments never sent with a turn and older than `max_age_ms`.
    pub fn stale_attachments(&self, max_age_ms: i64) -> Result<Vec<Attachment>> {
        self.with(|c| {
            let mut stmt = c.prepare(&format!("{} WHERE a.turn_id IS NULL AND a.created_at < ?1", ATTACHMENT_SELECT))?;
            let rows = stmt.query_map(params![now_ms() - max_age_ms], row_attachment)?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
    }

    pub fn attachments_of_conversation(&self, conversation_id: &str) -> Result<Vec<Attachment>> {
        self.with(|c| {
            let mut stmt = c.prepare(&format!(
                "{} WHERE a.turn_id IN (SELECT id FROM turns WHERE conversation_id = ?1)",
                ATTACHMENT_SELECT
            ))?;
            let rows = stmt.query_map(params![conversation_id], row_attachment)?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
    }

    // ── clarifications ──────────────────────────────────────────────────

    pub fn create_clarification(
        &self,
        conversation_id: &str,
        anchor_block_id: &str,
        quote: &str,
        parent_id: Option<&str>,
    ) -> Result<Clarification> {
        let id = new_id("cl");
        self.with(|c| {
            let number: i64 = c.query_row(
                "SELECT COALESCE(MAX(number), 0) + 1 FROM clarifications WHERE conversation_id = ?1",
                params![conversation_id],
                |r| r.get(0),
            )?;
            c.execute(
                "INSERT INTO clarifications (id, conversation_id, number, anchor_block_id, quote, parent_id, open, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7)",
                params![id, conversation_id, number, anchor_block_id, quote, parent_id, now_ms()],
            )?;
            Ok(())
        })?;
        self.get_clarification(&id)
    }

    pub fn get_clarification(&self, id: &str) -> Result<Clarification> {
        self.with(|c| {
            c.query_row(
                "SELECT id, conversation_id, number, anchor_block_id, quote, parent_id, open, created_at
                 FROM clarifications WHERE id = ?1",
                params![id],
                row_clarification,
            )
            .optional()?
            .ok_or_else(|| anyhow!("no clarification {}", id))
        })
    }

    pub fn set_clarification_open(&self, id: &str, open: bool) -> Result<()> {
        self.with(|c| {
            c.execute(
                "UPDATE clarifications SET open = ?2 WHERE id = ?1",
                params![id, open as i64],
            )?;
            Ok(())
        })
    }
}

const SUMMARY_SELECT: &str = "SELECT c.id, c.title, c.agent, c.model, c.web_search, c.created_at, c.updated_at,
        (SELECT COUNT(*) FROM clarifications k WHERE k.conversation_id = c.id), c.pinned, c.tags, c.project_dir, c.mode
     FROM conversations c";

const ATTACHMENT_SELECT: &str =
    "SELECT a.id, a.name, a.mime, a.kind, a.size, a.path, a.turn_id, a.created_at FROM attachments a";

fn row_summary(r: &Row<'_>) -> rusqlite::Result<ConversationSummary> {
    let agent: String = r.get(2)?;
    let tags: String = r.get(9)?;
    Ok(ConversationSummary {
        id: r.get(0)?,
        title: r.get(1)?,
        agent: AgentId::parse(&agent).unwrap_or(AgentId::Claude),
        model: r.get(3)?,
        web_search: r.get::<_, i64>(4)? != 0,
        created_at: r.get(5)?,
        updated_at: r.get(6)?,
        clarification_count: r.get::<_, i64>(7)? as u32,
        pinned: r.get::<_, i64>(8)? != 0,
        tags: serde_json::from_str(&tags).unwrap_or_default(),
        project_dir: r.get(10)?,
        mode: r.get(11)?,
    })
}

fn row_attachment(r: &Row<'_>) -> rusqlite::Result<Attachment> {
    let kind: String = r.get(3)?;
    Ok(Attachment {
        id: r.get(0)?,
        name: r.get(1)?,
        mime: r.get(2)?,
        kind: AttachmentKind::parse(&kind).unwrap_or(AttachmentKind::Text),
        size: r.get::<_, i64>(4)? as u64,
        path: r.get(5)?,
        turn_id: r.get(6)?,
        created_at: r.get(7)?,
    })
}

/// Last segment of a project path, used as its display name.
pub fn project_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

/// Lower-cased, trimmed, unique tags in their original order.
pub fn normalize_tags(tags: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in tags {
        let t = t.trim().to_lowercase();
        if !t.is_empty() && !out.contains(&t) {
            out.push(t);
        }
    }
    out
}

/// Turn free text into an FTS5 MATCH expression: every word becomes a quoted
/// prefix term, and all words must match. Quotes inside words are dropped so
/// user input can never break the expression's syntax.
pub fn fts_expression(query: &str) -> Option<String> {
    let terms: Vec<String> = query
        .split_whitespace()
        .map(|w| w.replace('"', ""))
        .filter(|w| !w.is_empty())
        .map(|w| format!("\"{}\"*", w))
        .collect();
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" "))
    }
}

fn row_turn(r: &Row<'_>) -> rusqlite::Result<Turn> {
    let role: String = r.get(3)?;
    let status: String = r.get(6)?;
    let usage_json: Option<String> = r.get(10)?;
    Ok(Turn {
        id: r.get(0)?,
        conversation_id: r.get(1)?,
        seq: r.get(2)?,
        role: Role::parse(&role).unwrap_or(Role::Assistant),
        text: r.get(4)?,
        prompt_text: r.get(5)?,
        status: TurnStatus::parse(&status).unwrap_or(TurnStatus::Error),
        clarification_id: r.get(7)?,
        model: r.get(8)?,
        error: r.get(9)?,
        usage: usage_json.and_then(|s| serde_json::from_str(&s).ok()),
        created_at: r.get(11)?,
        completed_at: r.get(12)?,
        attachments: Vec::new(),
    })
}

fn row_clarification(r: &Row<'_>) -> rusqlite::Result<Clarification> {
    Ok(Clarification {
        id: r.get(0)?,
        conversation_id: r.get(1)?,
        number: r.get::<_, i64>(2)? as u32,
        anchor_block_id: r.get(3)?,
        quote: r.get(4)?,
        parent_id: r.get(5)?,
        open: r.get::<_, i64>(6)? != 0,
        created_at: r.get(7)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conversation_turn_clarification_roundtrip() {
        let s = Store::in_memory().unwrap();
        let conv = s.create_conversation(AgentId::Pi, "", true, None).unwrap();
        assert_eq!(conv.summary.title, "New conversation");
        let u = s
            .create_turn(&conv.summary.id, Role::User, "hello", None, TurnStatus::Done, None, None)
            .unwrap();
        let a = s
            .create_turn(&conv.summary.id, Role::Assistant, "", None, TurnStatus::Pending, None, None)
            .unwrap();
        assert_eq!((u.seq, a.seq), (1, 2));
        s.update_turn_text(&a.id, "par").unwrap();
        assert_eq!(s.get_turn(&a.id).unwrap().status, TurnStatus::Streaming);
        let usage = Usage { input_tokens: Some(3), ..Default::default() };
        let done = s.finish_turn(&a.id, "partial answer", TurnStatus::Done, None, Some(&usage)).unwrap();
        assert_eq!(done.status, TurnStatus::Done);
        assert_eq!(done.usage.unwrap().input_tokens, Some(3));

        let cl = s.create_clarification(&conv.summary.id, &format!("{}:0", a.id), "answer", None).unwrap();
        assert_eq!(cl.number, 1);
        let cl2 = s.create_clarification(&conv.summary.id, &format!("{}:0", a.id), "partial", Some(&cl.id)).unwrap();
        assert_eq!(cl2.number, 2);
        s.set_clarification_open(&cl.id, false).unwrap();

        let full = s.get_conversation(&conv.summary.id).unwrap();
        assert_eq!(full.turns.len(), 2);
        assert_eq!(full.clarifications.len(), 2);
        assert!(!full.clarifications[0].open);
        assert_eq!(full.summary.clarification_count, 2);

        assert!(s.set_title_if_placeholder(&conv.summary.id, "Hello").unwrap());
        assert!(!s.set_title_if_placeholder(&conv.summary.id, "Other").unwrap());
        assert_eq!(s.list_conversations(Some("PARTIAL"), None).unwrap().len(), 1);
        assert_eq!(s.list_conversations(Some("nothing-here"), None).unwrap().len(), 0);
        assert_eq!(s.list_conversations(None, None).unwrap()[0].title, "Hello");

        s.delete_conversation(&conv.summary.id).unwrap();
        assert!(s.get_turn(&a.id).is_err());
    }

    #[test]
    fn settings_roundtrip_and_unfinished_turns() {
        let s = Store::in_memory().unwrap();
        assert_eq!(s.settings().unwrap().default_agent, AgentId::Claude);
        let mut st = Settings { theme: Theme::Dark, ..Default::default() };
        st.default_model.insert(AgentId::Claude, "haiku".into());
        s.save_settings(&st).unwrap();
        let back = s.settings().unwrap();
        assert_eq!(back.theme, Theme::Dark);
        assert_eq!(back.default_model[&AgentId::Claude], "haiku");

        let conv = s.create_conversation(AgentId::Claude, "haiku", false, Some("/tmp/proj")).unwrap();
        assert_eq!(conv.summary.project_dir.as_deref(), Some("/tmp/proj"));
        s.create_turn(&conv.summary.id, Role::Assistant, "", None, TurnStatus::Streaming, None, None).unwrap();
        assert_eq!(s.fail_unfinished_turns("closed").unwrap(), 1);
        let t = &s.get_conversation(&conv.summary.id).unwrap().turns[0];
        assert_eq!(t.status, TurnStatus::Error);
        assert_eq!(t.error.as_deref(), Some("closed"));
    }

    #[test]
    fn projects_order_by_activity_and_outlive_removal() {
        let s = Store::in_memory().unwrap();
        let a = s.add_project("/work/alpha").unwrap();
        assert_eq!(a.name, "alpha");
        s.add_project("/work/beta").unwrap();
        // Adding again keeps the original row.
        assert_eq!(s.add_project("/work/alpha").unwrap().created_at, a.created_at);
        assert_eq!(s.list_projects().unwrap().len(), 2);

        let conv = s.create_conversation(AgentId::Claude, "", true, Some("/work/alpha")).unwrap();
        s.with(|c| {
            c.execute("UPDATE conversations SET updated_at = ?2 WHERE id = ?1", params![conv.summary.id, now_ms() + 60_000])?;
            Ok(())
        })
        .unwrap();
        let list = s.list_projects().unwrap();
        assert_eq!(list[0].path, "/work/alpha");
        assert!(list[0].last_active_at > list[0].created_at);

        s.remove_project("/work/alpha").unwrap();
        assert_eq!(s.list_projects().unwrap().len(), 1);
        let kept = s.get_summary(&conv.summary.id).unwrap();
        assert_eq!(kept.project_dir.as_deref(), Some("/work/alpha"));
    }

    #[test]
    fn migrates_version_4_folders_into_projects() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("v4.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(SCHEMA).unwrap();
            conn.execute_batch(
                "DROP TABLE projects;
                 ALTER TABLE conversations DROP COLUMN origin_file;
                 ALTER TABLE conversations DROP COLUMN origin_until;
                 INSERT INTO schema_version VALUES (4);
                 INSERT INTO conversations (id, title, agent, project_dir, created_at, updated_at) VALUES
                    ('c1', 'One', 'claude', '/work/alpha', 5, 5),
                    ('c2', 'Two', 'pi', '/work/alpha', 3, 9),
                    ('c3', 'Three', 'claude', NULL, 1, 1);",
            )
            .unwrap();
        }
        let s = Store::open(&path).unwrap();
        let list = s.list_projects().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!((list[0].path.as_str(), list[0].created_at, list[0].last_active_at), ("/work/alpha", 3, 9));
    }
}

#[cfg(test)]
mod search_tests {
    use super::*;

    #[test]
    fn fts_expression_quotes_every_word() {
        assert_eq!(fts_expression("  store \"buffer\" "), Some("\"store\"* \"buffer\"*".into()));
        assert_eq!(fts_expression("   "), None);
    }

    #[test]
    fn search_pins_tags_and_snippets() {
        let s = Store::in_memory().unwrap();
        let a = s.create_conversation(AgentId::Claude, "", true, None).unwrap();
        let b = s.create_conversation(AgentId::Pi, "", true, None).unwrap();
        s.create_turn(&a.summary.id, Role::User, "Explain the store buffer", None, TurnStatus::Done, None, None).unwrap();
        let reply = s.create_turn(&a.summary.id, Role::Assistant, "", None, TurnStatus::Pending, None, None).unwrap();
        // Streaming text is not indexed until the turn finishes.
        s.update_turn_text(&reply.id, "A store buffer holds pending writes").unwrap();
        assert!(s.search("pending", 10).unwrap().is_empty());
        s.finish_turn(&reply.id, "A store buffer holds pending writes", TurnStatus::Done, None, None).unwrap();
        let hits = s.search("pend", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].turn_id.as_deref(), Some(reply.id.as_str()));
        assert!(hits[0].snippet.contains("\u{1}pending\u{2}"));
        s.rename_conversation(&b.summary.id, "Pending work").unwrap();
        let hits = s.search("pending", 10).unwrap();
        assert_eq!(hits.len(), 2);
        assert!(hits.iter().any(|h| h.turn_id.is_none() && h.conversation_id == b.summary.id));

        s.set_pinned(&b.summary.id, true).unwrap();
        s.touch_conversation(&a.summary.id).unwrap();
        let list = s.list_conversations(None, None).unwrap();
        assert_eq!(list[0].id, b.summary.id);
        assert!(list[0].pinned);

        let tagged = s.set_tags(&a.summary.id, &["CPU".into(), " cpu ".into(), "memory".into(), "".into()]).unwrap();
        assert_eq!(tagged.tags, vec!["cpu", "memory"]);
        assert_eq!(s.list_conversations(None, Some("cpu")).unwrap().len(), 1);
        assert_eq!(s.list_conversations(Some("buffer"), Some("cpu")).unwrap().len(), 1);
        assert_eq!(s.list_conversations(Some("buffer"), Some("nope")).unwrap().len(), 0);
        assert_eq!(s.list_tags().unwrap(), vec!["cpu", "memory"]);

        let att = s.create_attachment("att_1", "notes.txt", "text/plain", AttachmentKind::Text, 5, "/tmp/x").unwrap();
        assert!(att.turn_id.is_none());
        assert_eq!(s.stale_attachments(-1).unwrap().len(), 1);
        let user = s.create_turn(&a.summary.id, Role::User, "see file", None, TurnStatus::Done, None, None).unwrap();
        s.link_attachments(&user.id, &["att_1".into()]).unwrap();
        assert!(s.stale_attachments(-1).unwrap().is_empty());
        let conv = s.get_conversation(&a.summary.id).unwrap();
        assert_eq!(conv.turns[2].attachments[0].name, "notes.txt");
        assert_eq!(s.attachments_of_conversation(&a.summary.id).unwrap().len(), 1);
        s.delete_conversation(&a.summary.id).unwrap();
        assert!(s.get_attachment("att_1").is_err());
        assert!(s.search("buffer", 10).unwrap().is_empty());
    }

    #[test]
    fn migrates_version_1_database() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("old.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE schema_version (version INTEGER NOT NULL);
                 INSERT INTO schema_version VALUES (1);
                 CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, agent TEXT NOT NULL,
                    model TEXT NOT NULL DEFAULT '', web_search INTEGER NOT NULL DEFAULT 1, agent_session_id TEXT,
                    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
                 CREATE TABLE turns (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                    seq INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', prompt_text TEXT, status TEXT NOT NULL,
                    clarification_id TEXT, model TEXT, error TEXT, usage_json TEXT, created_at INTEGER NOT NULL, completed_at INTEGER,
                    UNIQUE (conversation_id, seq));
                 CREATE TABLE clarifications (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, number INTEGER NOT NULL,
                    anchor_block_id TEXT NOT NULL, quote TEXT NOT NULL, parent_id TEXT, open INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
                 CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO conversations VALUES ('c1', 'Old chat', 'claude', '', 1, NULL, 1, 1);
                 INSERT INTO turns (id, conversation_id, seq, role, text, status, created_at)
                    VALUES ('t1', 'c1', 1, 'assistant', 'migrated content', 'done', 1);",
            )
            .unwrap();
        }
        let s = Store::open(&path).unwrap();
        let list = s.list_conversations(None, None).unwrap();
        assert_eq!(list[0].title, "Old chat");
        assert!(!list[0].pinned);
        assert!(list[0].project_dir.is_none());
        assert_eq!(s.search("migrated", 10).unwrap().len(), 1);
        // Reopening a migrated file is a no-op.
        drop(s);
        let s = Store::open(&path).unwrap();
        assert_eq!(s.search("migrated", 10).unwrap().len(), 1);
    }
}
