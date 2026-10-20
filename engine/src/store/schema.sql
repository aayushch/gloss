-- Gloss conversation store. Timestamps are unix milliseconds.

CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    agent TEXT NOT NULL,
    -- Model id passed to the agent for new turns; '' means the agent's default.
    model TEXT NOT NULL DEFAULT '',
    web_search INTEGER NOT NULL DEFAULT 1,
    -- The agent's own session/thread id, set once the first turn reports it.
    agent_session_id TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    -- JSON array of lower-cased tag strings.
    tags TEXT NOT NULL DEFAULT '[]',
    -- Absolute path of the folder the agent runs in; NULL means the Gloss workspace.
    project_dir TEXT,
    -- The agent's working mode inside project_dir (a CLI mode id); NULL means read-only.
    mode TEXT,
    -- For a conversation that continued a session started outside Gloss: the
    -- agent's history file, and when Gloss took the session over.
    origin_file TEXT,
    origin_until INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Folders the user added as projects. A conversation belongs to the project
-- whose path equals its project_dir.
CREATE TABLE IF NOT EXISTS projects (
    -- Canonical absolute path of the folder.
    path TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS turns (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    prompt_text TEXT,
    status TEXT NOT NULL,
    clarification_id TEXT,
    model TEXT,
    error TEXT,
    usage_json TEXT,
    created_at INTEGER NOT NULL,
    completed_at INTEGER,
    UNIQUE (conversation_id, seq)
);

CREATE INDEX IF NOT EXISTS turns_by_conversation ON turns (conversation_id, seq);

CREATE TABLE IF NOT EXISTS clarifications (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    anchor_block_id TEXT NOT NULL,
    quote TEXT NOT NULL,
    parent_id TEXT,
    open INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    -- JSON WebAnchor for an ask made on a web page; NULL for in-app clarifications.
    web_anchor TEXT,
    -- 'anchored', 'fuzzy' or 'orphan': how the extension last placed the anchor.
    anchor_state TEXT
);

CREATE INDEX IF NOT EXISTS clarifications_by_conversation ON clarifications (conversation_id, number);

-- Web pages asked about from the browser extension. Each page owns one
-- conversation; the asks made on it are that conversation's clarifications.
CREATE TABLE IF NOT EXISTS pages (
    -- Canonical URL (see pages::url_key).
    url_key TEXT PRIMARY KEY,
    -- The URL as the browser last reported it.
    url TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    favicon_url TEXT,
    conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
    -- The readable text last sent to the agent and its hash, so the text is
    -- sent again only when the page changed.
    text TEXT,
    text_hash TEXT,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    kind TEXT NOT NULL,
    size INTEGER NOT NULL,
    path TEXT NOT NULL,
    -- NULL while the attachment is staged in the composer and not yet sent.
    turn_id TEXT REFERENCES turns(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS attachments_by_turn ON attachments (turn_id);

-- Full-text index over finished turns. It keeps its own copy of the text so
-- it does not depend on the rowid of `turns`, which has a text primary key.
-- Triggers keep it in step: a turn is indexed once its status is terminal.
CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
    turn_id UNINDEXED,
    conversation_id UNINDEXED,
    text,
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS turns_fts_insert AFTER INSERT ON turns
WHEN new.status IN ('done', 'error', 'cancelled')
BEGIN
    INSERT INTO turns_fts (turn_id, conversation_id, text) VALUES (new.id, new.conversation_id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS turns_fts_update AFTER UPDATE OF text, status ON turns
WHEN new.status IN ('done', 'error', 'cancelled')
BEGIN
    DELETE FROM turns_fts WHERE turn_id = old.id;
    INSERT INTO turns_fts (turn_id, conversation_id, text) VALUES (new.id, new.conversation_id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS turns_fts_delete AFTER DELETE ON turns
BEGIN
    DELETE FROM turns_fts WHERE turn_id = old.id;
END;
