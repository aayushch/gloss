//! Data types shared between the engine, the Tauri shell and (mirrored by
//! hand) the Svelte frontend in `ui/src/lib/api/types.ts`. Every type here is
//! serialised with serde using camelCase field names so the JSON matches the
//! TypeScript side one to one. Keep the two files in sync.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Identifies one of the supported CLI agents.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Hash, Debug)]
#[serde(rename_all = "snake_case")]
pub enum AgentId {
    Claude,
    Codex,
    Gemini,
    Pi,
    Cursor,
}

impl AgentId {
    pub const ALL: [AgentId; 5] = [
        AgentId::Claude,
        AgentId::Codex,
        AgentId::Gemini,
        AgentId::Pi,
        AgentId::Cursor,
    ];

    /// The string form used in the database and in JSON.
    pub fn as_str(self) -> &'static str {
        match self {
            AgentId::Claude => "claude",
            AgentId::Codex => "codex",
            AgentId::Gemini => "gemini",
            AgentId::Pi => "pi",
            AgentId::Cursor => "cursor",
        }
    }

    pub fn parse(s: &str) -> Option<AgentId> {
        AgentId::ALL.into_iter().find(|a| a.as_str() == s)
    }
}

impl std::fmt::Display for AgentId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// What the Settings sheet shows for one agent: whether the binary was found,
/// where, which version, and which features its CLI exposes.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub id: AgentId,
    /// Human name, e.g. "Claude Code".
    pub name: String,
    /// Binary name as typed on a shell, e.g. "claude".
    pub command: String,
    /// Two-letter mark shown in the agent picker, e.g. "cc".
    pub monogram: String,
    pub available: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    /// False when passing a model flag has side effects the user would not
    /// want (Cursor rewrites its default model); the UI then shows a fixed label.
    pub supports_model_select: bool,
    /// False when the CLI has no web search tool at all (Pi).
    pub supports_web_search: bool,
    /// Working modes the CLI offers for a project-bound conversation, read
    /// from its own help output. Empty when the CLI is missing or has none;
    /// read-only is always available and is not listed here.
    pub modes: Vec<AgentMode>,
    /// True when the adapter relays the agent's permission prompts and
    /// questions to the user instead of answering them itself.
    pub supports_requests: bool,
}

/// One way of running an agent inside a project folder, as the CLI names it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentMode {
    /// Value passed to the CLI's mode flag.
    pub id: String,
    pub label: String,
    /// What the mode lets the agent do without asking, in the CLI's own words where it has them.
    pub description: String,
    /// True when the agent may change files in this mode.
    pub writes: bool,
}

/// Something the agent needs from the user before it can go on: approval for
/// a tool call, or answers to questions it asked.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRequest {
    pub id: String,
    #[serde(flatten)]
    pub kind: RequestKind,
    /// The CLI's own payload for the request, kept to build the answer; the
    /// frontend does not need it.
    #[serde(skip)]
    pub raw: serde_json::Value,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RequestKind {
    /// The agent wants to run a tool the current mode does not pre-approve.
    Permission {
        /// Tool name as the CLI reports it, e.g. "Write" or "Bash".
        tool: String,
        /// Short line for the card, e.g. the file or the command.
        title: String,
        /// Longer preview, e.g. the content to be written.
        detail: Option<String>,
        /// Modes the CLI suggests switching to so this kind of call stops prompting.
        suggestions: Vec<ModeSuggestion>,
    },
    /// The agent asked the user one or more questions.
    Question { questions: Vec<Question> },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModeSuggestion {
    pub mode: String,
    pub label: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub question: String,
    /// Short chip the agent gave the question, if any.
    pub header: String,
    pub options: Vec<QuestionOption>,
    pub multi_select: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    pub label: String,
    pub description: String,
}

/// The user's reply to an `AgentRequest`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RequestAnswer {
    Permission {
        allow: bool,
        /// Why the call was refused, passed to the agent.
        message: Option<String>,
        /// A suggested mode the user accepted along with the call; the
        /// conversation switches to it for later turns too.
        set_mode: Option<String>,
    },
    /// Chosen labels (or typed text) per question, keyed by the question text.
    Question { answers: std::collections::HashMap<String, String> },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    /// Value passed to the CLI's model flag.
    pub id: String,
    pub name: String,
    pub note: Option<String>,
    /// Context window as a short label, e.g. "200k", when known.
    pub context: Option<String>,
    pub is_default: bool,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Theme {
    Light,
    Dark,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub default_agent: AgentId,
    /// Default model per agent, used for new conversations. A missing entry
    /// means "the agent's own default".
    pub default_model: HashMap<AgentId, String>,
    pub theme: Theme,
    /// Whether new conversations start with web search enabled.
    pub web_search: bool,
    /// Whether the browser extension sends a page's readable text to the
    /// agent along with the highlighted passage.
    #[serde(default = "default_true")]
    pub send_page_text: bool,
    /// Hosts the extension never asks about: exact names or `*.example.com`.
    #[serde(default)]
    pub page_deny_list: Vec<String>,
    /// The rail's "install the browser extension" card was dismissed.
    #[serde(default)]
    pub extension_banner_seen: bool,
    /// Run the loopback listener the Safari extension connects to.
    #[serde(default = "default_safari_bridge")]
    pub safari_bridge: bool,
    /// Agent for new page conversations; None means `default_agent`.
    #[serde(default)]
    pub page_agent: Option<AgentId>,
}

fn default_true() -> bool {
    true
}

/// Safari exists on macOS only, so the listener is off elsewhere by default.
fn default_safari_bridge() -> bool {
    cfg!(target_os = "macos")
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            default_agent: AgentId::Claude,
            default_model: HashMap::new(),
            theme: Theme::Light,
            web_search: true,
            send_page_text: true,
            page_deny_list: Vec::new(),
            extension_banner_seen: false,
            safari_bridge: default_safari_bridge(),
            page_agent: None,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    User,
    Assistant,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::User => "user",
            Role::Assistant => "assistant",
        }
    }
    pub fn parse(s: &str) -> Option<Role> {
        match s {
            "user" => Some(Role::User),
            "assistant" => Some(Role::Assistant),
            _ => None,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum TurnStatus {
    /// Created, agent process not yet producing output.
    Pending,
    /// Agent is producing output.
    Streaming,
    Done,
    Error,
    Cancelled,
}

impl TurnStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            TurnStatus::Pending => "pending",
            TurnStatus::Streaming => "streaming",
            TurnStatus::Done => "done",
            TurnStatus::Error => "error",
            TurnStatus::Cancelled => "cancelled",
        }
    }
    pub fn parse(s: &str) -> Option<TurnStatus> {
        match s {
            "pending" => Some(TurnStatus::Pending),
            "streaming" => Some(TurnStatus::Streaming),
            "done" => Some(TurnStatus::Done),
            "error" => Some(TurnStatus::Error),
            "cancelled" => Some(TurnStatus::Cancelled),
            _ => None,
        }
    }
    pub fn is_terminal(self) -> bool {
        matches!(self, TurnStatus::Done | TurnStatus::Error | TurnStatus::Cancelled)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cost_usd: Option<f64>,
    pub duration_ms: Option<u64>,
}

/// One message in a conversation. Clarification questions and their replies
/// are ordinary turns with `clarification_id` set; the transcript renders them
/// inside the clarification's well instead of in the main column.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub id: String,
    pub conversation_id: String,
    /// Position in the conversation, increasing, unique per conversation.
    pub seq: i64,
    pub role: Role,
    /// User turns: the text as typed. Assistant turns: markdown produced so far.
    pub text: String,
    /// User turns only: the exact prompt handed to the agent when it differs
    /// from `text` (clarifications carry the quoted excerpt and a framing note).
    pub prompt_text: Option<String>,
    pub status: TurnStatus,
    pub clarification_id: Option<String>,
    /// Assistant turns: the model that answered, as reported by the agent.
    pub model: Option<String>,
    pub error: Option<String>,
    pub usage: Option<Usage>,
    /// Unix milliseconds.
    pub created_at: i64,
    pub completed_at: Option<i64>,
    /// User turns only: files sent with the message.
    #[serde(default)]
    pub attachments: Vec<Attachment>,
    /// True when `text` was cut to fit a transport limit (the browser bridge
    /// caps a reply); the full text is in Gloss.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

/// A thread anchored to a highlighted span of an assistant turn.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Clarification {
    pub id: String,
    pub conversation_id: String,
    /// Display number, 1-based, in creation order within the conversation.
    pub number: u32,
    /// Block the quote lives in: `<turnId>:<blockIndex>`. The frontend assigns
    /// block indexes when it parses an assistant turn's markdown.
    pub anchor_block_id: String,
    /// The highlighted text, matched against the block's plain text at render time.
    pub quote: String,
    /// Set when the anchor block belongs to another clarification's reply.
    pub parent_id: Option<String>,
    pub open: bool,
    pub created_at: i64,
    /// For an ask made on a web page: where the quote sits in the page.
    /// `anchor_block_id` is empty for those.
    #[serde(default)]
    pub web_anchor: Option<WebAnchor>,
    /// Whether the extension last found the web anchor on the page.
    #[serde(default)]
    pub anchor_state: Option<AnchorState>,
}

/// The highlighted text with a little of what surrounds it, in the W3C Web
/// Annotation `TextQuoteSelector` shape. The extension matches `exact` and
/// uses the prefix and suffix to tell repeated passages apart.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextQuoteSelector {
    pub exact: String,
    #[serde(default)]
    pub prefix: String,
    #[serde(default)]
    pub suffix: String,
}

/// Character offsets of the quote in the page's normalised text, the
/// W3C `TextPositionSelector`. Only a hint: pages change.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextPositionSelector {
    pub start: u32,
    pub end: u32,
}

/// Where a web-page ask is anchored. The engine stores it as JSON without
/// interpreting it; the extension creates it from a selection and resolves
/// it again when the page is reopened.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WebAnchor {
    pub quote: TextQuoteSelector,
    #[serde(default)]
    pub position: Option<TextPositionSelector>,
    /// CSS path of the block element that contained the selection start.
    #[serde(default)]
    pub container: Option<String>,
}

/// How the extension last managed to place an anchor on its page.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum AnchorState {
    /// The exact quote was found.
    Anchored,
    /// Only an approximate match was found.
    Fuzzy,
    /// The passage is no longer on the page.
    Orphan,
}

impl AnchorState {
    pub fn as_str(self) -> &'static str {
        match self {
            AnchorState::Anchored => "anchored",
            AnchorState::Fuzzy => "fuzzy",
            AnchorState::Orphan => "orphan",
        }
    }
    pub fn parse(s: &str) -> Option<AnchorState> {
        match s {
            "anchored" => Some(AnchorState::Anchored),
            "fuzzy" => Some(AnchorState::Fuzzy),
            "orphan" => Some(AnchorState::Orphan),
            _ => None,
        }
    }
}

/// Text around the highlighted passage, sent with a web-page ask so the
/// agent sees the passage in context.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AskContext {
    #[serde(default)]
    pub before: String,
    #[serde(default)]
    pub after: String,
}

/// A web page the user asked about from the browser. Each page owns one
/// conversation, whose clarifications are the asks made on it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    /// Canonical URL, see `pages::url_key`.
    pub url_key: String,
    /// The URL as last seen in the browser.
    pub url: String,
    pub title: String,
    pub favicon_url: Option<String>,
    pub conversation_id: String,
    /// Asks anchored on the page.
    pub ask_count: u32,
    /// Asks whose passage the extension could not find on the page any more.
    pub orphan_count: u32,
    pub first_seen: i64,
    pub last_seen: i64,
    /// When the page's conversation last changed.
    pub updated_at: i64,
}

/// A page with its conversation: the asks are the clarifications that carry
/// a `web_anchor`; turns without a clarification are questions about the
/// page as a whole.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PageDetail {
    pub page: Page,
    pub conversation: Conversation,
}

/// What the browser knows about the page it is on.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PageMeta {
    pub url: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub favicon_url: Option<String>,
}

/// A question asked from the browser, about a highlighted passage when
/// `anchor` is set and about the whole page otherwise.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PageAskRequest {
    pub page: PageMeta,
    #[serde(default)]
    pub anchor: Option<WebAnchor>,
    #[serde(default)]
    pub context: AskContext,
    pub question: String,
    /// The page's readable text, when the extension may send it.
    #[serde(default)]
    pub page_text: Option<String>,
    /// True in a private window; such asks are refused.
    #[serde(default)]
    pub private: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PageAskResult {
    pub url_key: String,
    pub conversation_id: String,
    pub clarification: Option<Clarification>,
    pub user_turn: Turn,
    pub assistant_turn: Turn,
}

/// Everything the engine tells its listeners about: the Tauri shell forwards
/// these to the window, and every bridge session forwards them to its browser.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AppEvent {
    Turn(Box<TurnEventEnvelope>),
    /// A page's asks changed (created, removed, opened, closed) or the page
    /// was deleted; listeners re-fetch it.
    Page {
        #[serde(rename = "urlKey")]
        url_key: String,
        deleted: bool,
    },
    Settings(Box<Settings>),
    /// The browser asked Gloss to show a page; the window comes to the front.
    Focus {
        #[serde(rename = "urlKey")]
        url_key: String,
        #[serde(rename = "clarificationId")]
        clarification_id: Option<String>,
    },
    /// A browser extension connected or disconnected; the window re-reads
    /// the connected extensions to see whether one is older than the
    /// extension this Gloss ships.
    Extensions,
    Shutdown,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub id: String,
    pub title: String,
    pub agent: AgentId,
    /// Model id for new turns; empty string means the agent's default.
    pub model: String,
    pub web_search: bool,
    /// Pinned conversations sort above the rest of the list.
    pub pinned: bool,
    /// User-assigned labels, lower-cased and unique, in the order they were given.
    pub tags: Vec<String>,
    pub clarification_count: u32,
    /// Absolute path of the folder the agent runs in, with read-only file
    /// tools; None means the private Gloss workspace with no file tools.
    pub project_dir: Option<String>,
    /// The agent's working mode inside the project folder, one of the ids in
    /// `AgentInfo::modes`; None is read-only. Ignored without a project folder.
    pub mode: Option<String>,
    /// Set when the conversation belongs to a web page (its `url_key`).
    #[serde(default)]
    pub page_key: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A folder the user added as a project. Conversations whose `project_dir`
/// equals `path` belong to it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    /// Canonical absolute path of the folder.
    pub path: String,
    /// The folder's last path segment.
    pub name: String,
    pub created_at: i64,
    /// The later of `created_at` and the newest update to one of its conversations.
    pub last_active_at: i64,
}

/// Where an agent session that Gloss did not start was run from, as far as
/// the agent's own files say.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionOrigin {
    /// The agent's interactive command-line interface.
    Terminal,
    /// An editor extension, such as VS Code's.
    Ide,
    /// The agent's desktop app.
    Desktop,
    /// A non-interactive run (`-p`, `exec`), from a script or another app.
    Headless,
}

/// An agent session found in the agent's own history files for a project
/// folder, and not owned by any Gloss conversation.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSession {
    pub agent: AgentId,
    /// The agent's own session id, the one its resume flag takes.
    pub id: String,
    /// The session's title as the agent named it, or else its first prompt.
    pub title: String,
    /// None when the agent's files do not record where the session ran.
    pub origin: Option<SessionOrigin>,
    /// The file the session was read from.
    pub file: String,
    pub created_at: i64,
    /// When the session file was last written.
    pub updated_at: i64,
}

/// One turn of a session read from an agent's own history file: the user's
/// prompt, or the agent's reply with the tools it called collapsed to labels.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionTurn {
    pub role: Role,
    pub text: String,
    /// One short label per tool call, such as "Edit engine.rs" or "Bash cargo test".
    pub tools: Vec<String>,
    /// Unix milliseconds; 0 when the file records no time.
    pub at: i64,
}

/// What kind of file an attachment is, which decides how it reaches the agent:
/// images go through each CLI's image route, text is inlined into the prompt.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentKind {
    Image,
    Text,
}

impl AttachmentKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AttachmentKind::Image => "image",
            AttachmentKind::Text => "text",
        }
    }
    pub fn parse(s: &str) -> Option<AttachmentKind> {
        match s {
            "image" => Some(AttachmentKind::Image),
            "text" => Some(AttachmentKind::Text),
            _ => None,
        }
    }
}

/// A file the user attached to a prompt. The bytes live under the Gloss
/// workspace so every agent can reach them by path; `turn_id` is set once the
/// attachment has been sent with a user turn.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    /// File name as the user saw it.
    pub name: String,
    pub mime: String,
    pub kind: AttachmentKind,
    pub size: u64,
    /// Absolute path of the stored copy.
    pub path: String,
    pub turn_id: Option<String>,
    pub created_at: i64,
}

/// One full-text search hit. `turn_id` is None when only the conversation
/// title matched.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub conversation_id: String,
    pub title: String,
    pub agent: AgentId,
    pub turn_id: Option<String>,
    pub role: Option<Role>,
    pub clarification_id: Option<String>,
    /// Excerpt around the match. Matched words are wrapped in `\u{1}` and
    /// `\u{2}` so the UI can highlight them without parsing markup.
    pub snippet: String,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    #[serde(flatten)]
    pub summary: ConversationSummary,
    /// The agent's own session/thread id once the first turn has started.
    pub agent_session_id: Option<String>,
    /// The agent's history file this conversation continued, when it took
    /// over a session started outside Gloss. Turns from that file before the
    /// takeover come from `conversation_history`.
    pub continued_from: Option<String>,
    /// True while an agent process is running for this conversation.
    pub running: bool,
    /// The request the running agent is waiting on, so a reopened
    /// conversation shows the card again.
    pub pending_request: Option<AgentRequest>,
    pub turns: Vec<Turn>,
    pub clarifications: Vec<Clarification>,
}

/// Where a new user turn should go.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ClarificationTarget {
    /// Start a new clarification anchored at the given block and quote.
    New {
        #[serde(rename = "anchorBlockId")]
        anchor_block_id: String,
        quote: String,
        #[serde(rename = "parentId")]
        parent_id: Option<String>,
    },
    /// Follow up inside an existing clarification.
    Existing {
        #[serde(rename = "clarificationId")]
        clarification_id: String,
    },
    /// Start a clarification anchored on a web page, from the browser.
    Web {
        quote: String,
        anchor: WebAnchor,
        #[serde(default)]
        context: AskContext,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SendTurnRequest {
    pub conversation_id: String,
    pub text: String,
    pub clarification: Option<ClarificationTarget>,
    /// Ids of staged attachments (see `Engine::add_attachment`) to send along.
    #[serde(default)]
    pub attachments: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SendTurnResult {
    pub user_turn: Turn,
    pub assistant_turn: Turn,
    /// Present when the request created a new clarification.
    pub clarification: Option<Clarification>,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum ActivityKind {
    Thinking,
    Tool,
    Status,
}

/// Streamed progress of one assistant turn, emitted as the Tauri event
/// `turn-event` wrapped in a `TurnEventEnvelope`.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TurnEvent {
    /// The agent process is up. `session_id` is the agent's own id.
    Started {
        #[serde(rename = "sessionId")]
        session_id: Option<String>,
        model: Option<String>,
    },
    /// Append `text` to the assistant turn.
    Delta { text: String },
    /// Replace the whole assistant text (used when an agent re-sends complete
    /// messages that do not extend what was streamed so far).
    Replace { text: String },
    /// Something the agent is doing besides writing text, for the activity line.
    Activity { kind: ActivityKind, label: String },
    /// The agent is waiting for the user: approval for a tool call or answers
    /// to questions. The turn stays running until `answer_request` is called.
    Request { request: AgentRequest },
    /// The request was answered (or the turn ended); the card goes away.
    RequestResolved {
        #[serde(rename = "requestId")]
        request_id: String,
    },
    /// Final row for the turn with status Done.
    Done { turn: Turn },
    /// Final row with status Error; `error` repeats `turn.error` for convenience.
    Failed { error: String, turn: Turn },
    /// Final row with status Cancelled.
    Cancelled { turn: Turn },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TurnEventEnvelope {
    pub conversation_id: String,
    pub turn_id: String,
    pub event: TurnEvent,
}
