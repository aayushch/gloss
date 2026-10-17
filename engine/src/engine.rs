//! The engine: ties the store, the shell environment and the agent adapters
//! together and runs turns.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::agents::{self, AgentEvent, ImageAttachment, SpawnRequest};
use crate::attach;
use crate::env::ShellEnv;
use crate::paths::GlossPaths;
use crate::prompt;
use crate::store::Store;
use crate::types::*;

/// Receives streamed turn progress. The Tauri shell forwards it to the
/// webview; the CLI prints it.
pub type EventSink = Arc<dyn Fn(TurnEventEnvelope) + Send + Sync>;

/// How long an agent may stay silent before its turn is stopped.
pub const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(300);

pub struct Engine {
    pub paths: GlossPaths,
    pub env: ShellEnv,
    pub store: Store,
    /// One cancellation token per conversation with a live agent process.
    running: Mutex<HashMap<String, RunningTurn>>,
    idle_timeout: Duration,
}

impl Engine {
    /// Open the store under `paths`, capturing the login-shell environment.
    pub fn open(paths: GlossPaths) -> Result<Engine> {
        Engine::open_with_env(paths, ShellEnv::capture())
    }

    pub fn open_with_env(paths: GlossPaths, env: ShellEnv) -> Result<Engine> {
        paths.ensure().with_context(|| format!("create {}", paths.home.display()))?;
        let store = Store::open(&paths.db)?;
        let failed = store.fail_unfinished_turns("Gloss was closed while the agent was running")?;
        if failed > 0 {
            warn!(count = failed, "marked unfinished turns from a previous run as errors");
        }
        // Attachments staged in a composer that was never sent are dropped
        // after a day, so an abandoned draft does not keep files forever.
        for att in store.stale_attachments(24 * 60 * 60 * 1000)? {
            remove_attachment_files(&att);
            store.delete_attachment(&att.id)?;
        }
        purge_old_artifact_files(&paths.artifacts, Duration::from_secs(7 * 24 * 60 * 60));
        Ok(Engine {
            paths,
            env,
            store,
            running: Mutex::new(HashMap::new()),
            idle_timeout: DEFAULT_IDLE_TIMEOUT,
        })
    }

    pub fn with_idle_timeout(mut self, timeout: Duration) -> Engine {
        self.idle_timeout = timeout;
        self
    }

    // ── agents & models ─────────────────────────────────────────────────

    pub fn list_agents(&self) -> Vec<AgentInfo> {
        agents::all_adapters().iter().map(|a| a.info(&self.env)).collect()
    }

    pub fn list_models(&self, agent: AgentId) -> Vec<ModelInfo> {
        agents::adapter_for(agent).models(&self.env)
    }

    // ── settings ────────────────────────────────────────────────────────

    pub fn settings(&self) -> Result<Settings> {
        self.store.settings()
    }

    pub fn update_settings(&self, settings: Settings) -> Result<Settings> {
        self.store.save_settings(&settings)?;
        Ok(settings)
    }

    pub fn set_theme(&self, theme: Theme) -> Result<()> {
        let mut s = self.store.settings()?;
        s.theme = theme;
        self.store.save_settings(&s)
    }

    // ── conversations ───────────────────────────────────────────────────

    pub fn list_conversations(&self, query: Option<&str>, tag: Option<&str>) -> Result<Vec<ConversationSummary>> {
        self.store.list_conversations(query, tag)
    }

    pub fn search(&self, query: &str) -> Result<Vec<SearchHit>> {
        self.store.search(query, 60)
    }

    pub fn set_pinned(&self, id: &str, pinned: bool) -> Result<ConversationSummary> {
        self.store.set_pinned(id, pinned)
    }

    pub fn set_tags(&self, id: &str, tags: &[String]) -> Result<ConversationSummary> {
        self.store.set_tags(id, tags)
    }

    pub fn list_tags(&self) -> Result<Vec<String>> {
        self.store.list_tags()
    }

    // ── attachments ─────────────────────────────────────────────────────

    /// Store a file the user picked so it can be sent with a later turn. The
    /// copy lives under the workspace's attachments directory, one directory
    /// per attachment so names never collide.
    pub fn add_attachment(&self, name: &str, mime: &str, bytes: &[u8]) -> Result<Attachment> {
        let (kind, mime) = attach::classify(name, mime, bytes)
            .ok_or_else(|| anyhow!("{} is not an image or a text file; only those can be attached", name))?;
        let limit = match kind {
            AttachmentKind::Image => attach::MAX_IMAGE_BYTES,
            AttachmentKind::Text => attach::MAX_TEXT_BYTES,
        };
        if bytes.len() as u64 > limit {
            return Err(anyhow!("{} is larger than the {} MB limit", name, limit / (1024 * 1024)).context("attachment too large"));
        }
        let id = crate::store::new_id("att");
        let dir = self.paths.attachments.join(&id);
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(attach::safe_name(name));
        std::fs::write(&path, bytes).with_context(|| format!("write {}", path.display()))?;
        self.store
            .create_attachment(&id, name, &mime, kind, bytes.len() as u64, &path.to_string_lossy())
    }

    /// Drop a staged attachment the user removed from the composer. Sent
    /// attachments stay with their turn.
    pub fn remove_attachment(&self, id: &str) -> Result<()> {
        let att = self.store.get_attachment(id)?;
        if att.turn_id.is_some() {
            return Err(anyhow!("attachment {} was already sent", id));
        }
        remove_attachment_files(&att);
        self.store.delete_attachment(id)
    }

    /// The stored bytes of an attachment, for previews in the UI.
    pub fn attachment_bytes(&self, id: &str) -> Result<(Attachment, Vec<u8>)> {
        let att = self.store.get_attachment(id)?;
        let bytes = std::fs::read(&att.path).with_context(|| format!("read {}", att.path))?;
        Ok((att, bytes))
    }

    // ── artifacts ───────────────────────────────────────────────────────

    /// Write an artifact's content to its own directory under the artifacts
    /// folder and return the path, so the system can open it with the default
    /// application. The directory name is random so two artifacts with the
    /// same name never collide.
    pub fn write_artifact_file(&self, name: &str, contents: &str) -> Result<std::path::PathBuf> {
        let dir = self.paths.artifacts.join(crate::store::new_id("art"));
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(attach::safe_name(name));
        std::fs::write(&path, contents).with_context(|| format!("write {}", path.display()))?;
        Ok(path)
    }

    pub fn get_conversation(&self, id: &str) -> Result<Conversation> {
        let mut c = self.store.get_conversation(id)?;
        c.running = self.is_running(id);
        c.pending_request = self.pending_request(id);
        Ok(c)
    }

    /// `project_dir`, when given, must be an existing directory; it is stored
    /// in canonical form and the agent runs inside it with read-only file
    /// tools for every turn of the conversation.
    pub fn create_conversation(
        &self,
        agent: AgentId,
        model: Option<String>,
        web_search: Option<bool>,
        project_dir: Option<String>,
    ) -> Result<Conversation> {
        let settings = self.store.settings()?;
        let model = model
            .or_else(|| settings.default_model.get(&agent).cloned())
            .unwrap_or_default();
        let web = web_search.unwrap_or(settings.web_search);
        let project = match project_dir.map(|d| d.trim().to_string()).filter(|d| !d.is_empty()) {
            None => None,
            Some(dir) => {
                let path = std::path::Path::new(&dir);
                if !path.is_absolute() {
                    return Err(anyhow!("project folder must be an absolute path: {}", dir));
                }
                if !path.is_dir() {
                    return Err(anyhow!("project folder does not exist or is not a directory: {}", dir));
                }
                let canonical = std::fs::canonicalize(path).with_context(|| format!("resolve {}", dir))?;
                Some(canonical.to_string_lossy().to_string())
            }
        };
        self.store.create_conversation(agent, &model, web, project.as_deref())
    }

    pub fn rename_conversation(&self, id: &str, title: &str) -> Result<ConversationSummary> {
        let title = title.trim();
        if title.is_empty() {
            return Err(anyhow!("title cannot be empty"));
        }
        self.store.rename_conversation(id, title)
    }

    pub fn delete_conversation(&self, id: &str) -> Result<()> {
        self.cancel_turn(id);
        for att in self.store.attachments_of_conversation(id)? {
            remove_attachment_files(&att);
        }
        self.store.delete_conversation(id)
    }

    pub fn set_conversation_model(&self, id: &str, model: &str) -> Result<ConversationSummary> {
        self.store.set_model(id, model)
    }

    pub fn set_conversation_web_search(&self, id: &str, enabled: bool) -> Result<ConversationSummary> {
        self.store.set_web_search(id, enabled)
    }

    pub fn set_clarification_open(&self, id: &str, open: bool) -> Result<()> {
        self.store.set_clarification_open(id, open)
    }

    pub fn is_running(&self, conversation_id: &str) -> bool {
        self.running.lock().unwrap().contains_key(conversation_id)
    }

    /// Stop the agent process for a conversation, if one is running.
    pub fn cancel_turn(&self, conversation_id: &str) {
        if let Some(run) = self.running.lock().unwrap().get(conversation_id) {
            run.cancel.cancel();
        }
    }

    /// The request the running turn is waiting on, if any.
    pub fn pending_request(&self, conversation_id: &str) -> Option<AgentRequest> {
        self.running
            .lock()
            .unwrap()
            .get(conversation_id)
            .and_then(|r| r.pending.as_ref().map(|(_, req)| req.clone()))
    }

    /// Hands the user's answer to the waiting agent. A permission answer
    /// that accepts a suggested mode also switches the conversation to it,
    /// so the next turn starts in that mode.
    pub fn answer_request(&self, conversation_id: &str, request_id: &str, answer: RequestAnswer) -> Result<()> {
        let (turn_id, request, stdin, waiting, sink) = {
            let mut running = self.running.lock().unwrap();
            let run = running
                .get_mut(conversation_id)
                .ok_or_else(|| anyhow!("no turn is running in this conversation"))?;
            match &run.pending {
                Some((_, req)) if req.id == request_id => {}
                _ => return Err(anyhow!("the agent is not waiting on request {}", request_id)),
            }
            let (turn_id, request) = run.pending.take().expect("checked above");
            (turn_id, request, run.stdin.clone(), run.waiting.clone(), run.sink.clone())
        };
        let agent = self.store.get_summary(conversation_id)?.agent;
        let bytes = agents::adapter_for(agent)
            .encode_answer(&request, &answer)
            .ok_or_else(|| anyhow!("{} cannot take answers", agent))?;
        if let RequestAnswer::Permission { set_mode: Some(mode), allow: true, .. } = &answer {
            self.store.set_mode(conversation_id, Some(mode))?;
        }
        stdin
            .ok_or_else(|| anyhow!("the agent's input is closed"))?
            .send(bytes)
            .map_err(|_| anyhow!("the agent has already exited"))?;
        waiting.store(false, std::sync::atomic::Ordering::Relaxed);
        sink(TurnEventEnvelope {
            conversation_id: conversation_id.to_string(),
            turn_id,
            event: TurnEvent::RequestResolved { request_id: request_id.to_string() },
        });
        Ok(())
    }

    /// Sets the working mode of a project-bound conversation. `None` is
    /// read-only; anything else must be a mode the agent's CLI offers.
    pub fn set_conversation_mode(&self, id: &str, mode: Option<String>) -> Result<ConversationSummary> {
        let summary = self.store.get_summary(id)?;
        let mode = mode.map(|m| m.trim().to_string()).filter(|m| !m.is_empty() && m != "read-only");
        if let Some(m) = &mode {
            if summary.project_dir.is_none() {
                return Err(anyhow!("only a conversation bound to a project folder has a mode"));
            }
            let offered = agents::adapter_for(summary.agent).modes(&self.env);
            if !offered.iter().any(|o| &o.id == m) {
                return Err(anyhow!("{} has no mode named {}", summary.agent, m));
            }
        }
        self.store.set_mode(id, mode.as_deref())
    }

    // ── turns ───────────────────────────────────────────────────────────

    /// Record the user's turn, create the pending assistant turn and start the
    /// agent in the background. Progress arrives through `sink`.
    pub async fn send_turn(self: &Arc<Self>, req: SendTurnRequest, sink: EventSink) -> Result<SendTurnResult> {
        let text = req.text.trim().to_string();
        if text.is_empty() {
            return Err(anyhow!("message is empty"));
        }
        let conv = self.store.get_conversation(&req.conversation_id)?;
        let agent = conv.summary.agent;

        // Reserve the conversation before touching the store so two sends
        // racing each other cannot both start a process.
        let cancel = CancellationToken::new();
        let (stdin_tx, stdin_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        let waiting = Arc::new(std::sync::atomic::AtomicBool::new(false));
        {
            let mut running = self.running.lock().unwrap();
            if running.contains_key(&req.conversation_id) {
                return Err(anyhow!("a turn is already running in this conversation"));
            }
            running.insert(
                req.conversation_id.clone(),
                RunningTurn { cancel: cancel.clone(), stdin: Some(stdin_tx), waiting: waiting.clone(), pending: None, sink: sink.clone() },
            );
        }
        let interaction = agents::process::Interaction { input: stdin_rx, waiting };

        let result = self.start_turn(&conv, agent, text, req.clarification, &req.attachments, cancel.clone(), interaction, sink);
        if result.is_err() {
            self.running.lock().unwrap().remove(&req.conversation_id);
        }
        result
    }

    #[allow(clippy::too_many_arguments)]
    fn start_turn(
        self: &Arc<Self>,
        conv: &Conversation,
        agent: AgentId,
        text: String,
        target: Option<ClarificationTarget>,
        attachment_ids: &[String],
        cancel: CancellationToken,
        interaction: agents::process::Interaction,
        sink: EventSink,
    ) -> Result<SendTurnResult> {
        let conv_id = conv.summary.id.clone();
        // A bound folder that has gone missing is reported before anything is
        // recorded, so the user can act on it rather than get a failed turn.
        let project_dir = conv.summary.project_dir.as_deref().map(std::path::PathBuf::from);
        if let Some(dir) = &project_dir {
            if !dir.is_dir() {
                return Err(anyhow!("the project folder {} is missing; it may have been moved or deleted", dir.display()));
            }
        }
        let note = prompt::system_note(conv.summary.project_dir.as_deref());
        let attachments = self.staged_attachments(attachment_ids)?;
        // No agent session yet means this spawn starts the agent's conversation,
        // even when an earlier attempt failed before the agent reported one.
        let is_first_turn = conv.agent_session_id.is_none();

        let (clarification, clarification_id, body) = match target {
            None => (None, None, text.clone()),
            Some(ClarificationTarget::New { anchor_block_id, quote, parent_id }) => {
                let cl = self.store.create_clarification(&conv_id, &anchor_block_id, &quote, parent_id.as_deref())?;
                let body = prompt::clarification_prompt(&quote, &text);
                (Some(cl.clone()), Some(cl.id), body)
            }
            Some(ClarificationTarget::Existing { clarification_id }) => {
                let cl = self.store.get_clarification(&clarification_id)?;
                let body = prompt::follow_up_prompt(&cl.quote, &text);
                (None, Some(cl.id), body)
            }
        };
        // Text attachments become part of the prompt itself; images are
        // handed to the adapter, which picks the CLI's image route.
        let mut body = body;
        let mut images = Vec::new();
        for att in &attachments {
            match att.kind {
                AttachmentKind::Text => {
                    let contents = std::fs::read_to_string(&att.path).with_context(|| format!("read {}", att.path))?;
                    body.push_str("\n\n");
                    body.push_str(&attach::inline_text(&att.name, &contents));
                }
                AttachmentKind::Image => images.push(ImageAttachment {
                    path: std::path::PathBuf::from(&att.path),
                    mime: att.mime.clone(),
                }),
            }
        }
        let full_prompt = prompt::compose_prompt(agent, is_first_turn, &body, &note);
        let prompt_text = (full_prompt != text).then(|| full_prompt.clone());

        let mut user_turn = self.store.create_turn(
            &conv_id,
            Role::User,
            &text,
            prompt_text.as_deref(),
            TurnStatus::Done,
            clarification_id.as_deref(),
            None,
        )?;
        if !attachments.is_empty() {
            self.store.link_attachments(&user_turn.id, attachment_ids)?;
            user_turn.attachments = attachments.into_iter().map(|a| Attachment { turn_id: Some(user_turn.id.clone()), ..a }).collect();
        }
        let assistant_turn = self.store.create_turn(
            &conv_id,
            Role::Assistant,
            "",
            None,
            TurnStatus::Pending,
            clarification_id.as_deref(),
            None,
        )?;
        if clarification_id.is_none() {
            let title = prompt::title_from_message(&text, 60);
            self.store.set_title_if_placeholder(&conv_id, &title)?;
        }
        let title = self.store.get_summary(&conv_id)?.title;

        let spawn_req = SpawnRequest {
            prompt: full_prompt,
            agent_session_id: conv.agent_session_id.clone(),
            new_session_id: uuid::Uuid::new_v4().to_string(),
            model: Some(conv.summary.model.clone()).filter(|m| !m.is_empty()),
            web_search: conv.summary.web_search,
            project: project_dir.is_some(),
            mode: if project_dir.is_some() { conv.summary.mode.clone() } else { None },
            cwd: project_dir.unwrap_or_else(|| self.paths.workspace.clone()),
            pi_session_dir: self.paths.pi_sessions.clone(),
            system_note: note,
            title: Some(title),
            images,
        };

        let engine = Arc::clone(self);
        let turn_id = assistant_turn.id.clone();
        tokio::spawn(async move {
            engine.run_turn(conv_id, turn_id, agent, spawn_req, cancel, interaction, sink).await;
        });

        Ok(SendTurnResult {
            user_turn,
            assistant_turn,
            clarification,
        })
    }

    /// Staged attachments by id, in the order given; sending one twice is an error.
    fn staged_attachments(&self, ids: &[String]) -> Result<Vec<Attachment>> {
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            let att = self.store.get_attachment(id)?;
            if att.turn_id.is_some() {
                return Err(anyhow!("attachment {} was already sent", att.name));
            }
            out.push(att);
        }
        Ok(out)
    }

    async fn run_turn(
        self: Arc<Self>,
        conv_id: String,
        turn_id: String,
        agent: AgentId,
        req: SpawnRequest,
        cancel: CancellationToken,
        interaction: agents::process::Interaction,
        sink: EventSink,
    ) {
        let emit = |event: TurnEvent| {
            sink(TurnEventEnvelope {
                conversation_id: conv_id.clone(),
                turn_id: turn_id.clone(),
                event,
            })
        };

        let mut adapter = agents::adapter_for(agent);
        let mut state = TurnState::new(&self.store, &conv_id, &turn_id);

        let outcome = match adapter.build_command(&req, &self.env) {
            Err(e) => Err(e.to_string()),
            Ok(spec) => {
                info!(agent = %agent, program = %spec.program.display(), "spawning agent");
                let waiting = interaction.waiting.clone();
                let run = agents::process::run_lines_with(
                    &spec,
                    &self.env.vars,
                    self.idle_timeout,
                    cancel.clone(),
                    Some(interaction),
                    |line| {
                        for ev in adapter.parse_line(line) {
                            // An agent reading a stream of input only exits
                            // once that stream ends, so its stdin is closed
                            // as soon as it reports the turn finished.
                            if matches!(ev, AgentEvent::Done) {
                                if let Some(run) = self.running.lock().unwrap().get_mut(&conv_id) {
                                    run.stdin = None;
                                }
                            }
                            if let AgentEvent::Request(request) = ev {
                                // Park the request on the running turn so an
                                // answer can find it, and stop the idle clock.
                                if let Some(run) = self.running.lock().unwrap().get_mut(&conv_id) {
                                    run.pending = Some((turn_id.clone(), request.clone()));
                                }
                                waiting.store(true, std::sync::atomic::Ordering::Relaxed);
                                emit(TurnEvent::Request { request });
                                continue;
                            }
                            state.apply(ev, &emit);
                        }
                    },
                )
                .await;
                for ev in adapter.finish() {
                    state.apply(ev, &emit);
                }
                run.map_err(|e| format!("could not start {}: {}", spec.program.display(), e))
            }
        };

        let (status, error) = match outcome {
            Err(msg) => (TurnStatus::Error, Some(msg)),
            Ok(o) if o.cancelled => (TurnStatus::Cancelled, None),
            Ok(o) => match state.error.take() {
                Some(msg) => (TurnStatus::Error, Some(msg)),
                None if o.succeeded() => (TurnStatus::Done, None),
                None => (TurnStatus::Error, Some(o.describe())),
            },
        };

        let final_turn = self
            .store
            .finish_turn(&turn_id, &state.text, status, error.as_deref(), state.usage.as_ref())
            .and_then(|_| {
                if let Some(m) = &state.model {
                    self.store.set_turn_model(&turn_id, m)?;
                }
                self.store.touch_conversation(&conv_id)?;
                self.store.get_turn(&turn_id)
            });
        self.running.lock().unwrap().remove(&conv_id);

        match final_turn {
            Ok(turn) => emit(match status {
                TurnStatus::Done => TurnEvent::Done { turn },
                TurnStatus::Cancelled => TurnEvent::Cancelled { turn },
                _ => TurnEvent::Failed {
                    error: error.unwrap_or_else(|| "unknown error".into()),
                    turn,
                },
            }),
            Err(e) => warn!(error = %e, "could not persist final turn state"),
        }
    }
}

/// A turn in progress: how to stop it, how to reach the agent's stdin, and
/// the request it is waiting on, if any, with the id of its assistant turn.
struct RunningTurn {
    cancel: CancellationToken,
    stdin: Option<tokio::sync::mpsc::UnboundedSender<Vec<u8>>>,
    waiting: Arc<std::sync::atomic::AtomicBool>,
    pending: Option<(String, AgentRequest)>,
    sink: EventSink,
}

/// Mutable state of one running turn: the assembled text and what the agent
/// reported about itself.
struct TurnState<'a> {
    store: &'a Store,
    conv_id: &'a str,
    turn_id: &'a str,
    text: String,
    model: Option<String>,
    usage: Option<Usage>,
    error: Option<String>,
    last_persist: Instant,
    dirty: bool,
}

impl<'a> TurnState<'a> {
    fn new(store: &'a Store, conv_id: &'a str, turn_id: &'a str) -> Self {
        TurnState {
            store,
            conv_id,
            turn_id,
            text: String::new(),
            model: None,
            usage: None,
            error: None,
            last_persist: Instant::now(),
            dirty: false,
        }
    }

    fn apply(&mut self, ev: AgentEvent, emit: &dyn Fn(TurnEvent)) {
        match ev {
            AgentEvent::Session { id, model } => {
                if let Err(e) = self.store.set_agent_session_id(self.conv_id, &id) {
                    warn!(error = %e, "could not store agent session id");
                }
                if self.model.is_none() {
                    self.model = model.clone();
                }
                emit(TurnEvent::Started { session_id: Some(id), model });
            }
            AgentEvent::Append(t) => {
                if t.is_empty() {
                    return;
                }
                self.text.push_str(&t);
                self.dirty = true;
                emit(TurnEvent::Delta { text: t });
            }
            AgentEvent::SetFull(full) => {
                if full == self.text {
                    return;
                }
                if let Some(rest) = full.strip_prefix(self.text.as_str()) {
                    if !rest.is_empty() {
                        emit(TurnEvent::Delta { text: rest.to_string() });
                    }
                    self.text = full;
                } else if self.text.starts_with(&full) {
                    // The agent re-sent a shorter prefix of what was streamed;
                    // the longer streamed text stands.
                    return;
                } else {
                    self.text = full.clone();
                    emit(TurnEvent::Replace { text: full });
                }
                self.dirty = true;
            }
            AgentEvent::Activity { kind, label } => emit(TurnEvent::Activity { kind, label }),
            // Requests are routed to the running turn by the caller, never applied here.
            AgentEvent::Request(_) => {}
            AgentEvent::Usage(u) => self.usage = Some(u),
            AgentEvent::Model(m) => self.model = Some(m),
            AgentEvent::Error(msg) => {
                if self.error.is_none() {
                    self.error = Some(msg);
                }
            }
            AgentEvent::Done => {}
        }
        if self.dirty && self.last_persist.elapsed() >= Duration::from_millis(500) {
            if let Err(e) = self.store.update_turn_text(self.turn_id, &self.text) {
                warn!(error = %e, "could not persist streamed text");
            }
            self.last_persist = Instant::now();
            self.dirty = false;
        }
    }
}

/// Delete an attachment's directory. Missing files are not an error.
fn remove_attachment_files(att: &Attachment) {
    if let Some(dir) = std::path::Path::new(&att.path).parent() {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// Delete artifact directories whose files are older than `max_age`. They
/// exist only so the system could open the artifact; the content itself
/// stays in the conversation. Errors are ignored: a leftover file is harmless.
fn purge_old_artifact_files(dir: &std::path::Path, max_age: Duration) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|t| now.duration_since(t).unwrap_or_default() > max_age)
            .unwrap_or(false);
        if old {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// Convenience for callers that only need the store, e.g. the CLI's `list`.
pub fn open_store(paths: &GlossPaths) -> Result<Store> {
    paths.ensure()?;
    Store::open(&paths.db)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect() -> (EventSink, Arc<Mutex<Vec<TurnEvent>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let e2 = events.clone();
        let sink: EventSink = Arc::new(move |env: TurnEventEnvelope| e2.lock().unwrap().push(env.event));
        (sink, events)
    }

    #[test]
    fn set_full_reconciles_with_streamed_text() {
        let store = Store::in_memory().unwrap();
        let conv = store.create_conversation(AgentId::Pi, "", false, None).unwrap();
        let turn = store.create_turn(&conv.summary.id, Role::Assistant, "", None, TurnStatus::Pending, None, None).unwrap();
        let (sink, events) = collect();
        let emit = |e: TurnEvent| sink(TurnEventEnvelope { conversation_id: "c".into(), turn_id: "t".into(), event: e });
        let mut st = TurnState::new(&store, &conv.summary.id, &turn.id);
        st.apply(AgentEvent::Append("po".into()), &emit);
        st.apply(AgentEvent::SetFull("pong".into()), &emit);
        st.apply(AgentEvent::SetFull("po".into()), &emit);
        st.apply(AgentEvent::SetFull("other".into()), &emit);
        assert_eq!(st.text, "other");
        let evs = events.lock().unwrap();
        assert!(matches!(&evs[0], TurnEvent::Delta { text } if text == "po"));
        assert!(matches!(&evs[1], TurnEvent::Delta { text } if text == "ng"));
        assert!(matches!(&evs[2], TurnEvent::Replace { text } if text == "other"));
        assert_eq!(evs.len(), 3);
    }

    #[tokio::test]
    async fn send_turn_with_missing_binary_fails_cleanly() {
        let dir = tempfile::tempdir().unwrap();
        let mut env = ShellEnv::from_process();
        env.vars.insert("PATH".into(), "/nonexistent".into());
        let engine = Arc::new(Engine::open_with_env(GlossPaths::at(dir.path()), env).unwrap());
        let conv = engine.create_conversation(AgentId::Codex, None, None, None).unwrap();
        let (sink, events) = collect();
        let res = engine
            .send_turn(
                SendTurnRequest { conversation_id: conv.summary.id.clone(), text: "hello there".into(), clarification: None, attachments: vec![] },
                sink,
            )
            .await
            .unwrap();
        assert_eq!(res.user_turn.role, Role::User);
        assert!(res.user_turn.prompt_text.unwrap().starts_with(prompt::SYSTEM_NOTE));
        // Wait for the background task to finish.
        for _ in 0..50 {
            if !engine.is_running(&conv.summary.id) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let evs = events.lock().unwrap();
        assert!(matches!(evs.last(), Some(TurnEvent::Failed { error, .. }) if error.contains("not installed")));
        let full = engine.get_conversation(&conv.summary.id).unwrap();
        assert_eq!(full.summary.title, "hello there");
        assert_eq!(full.turns[1].status, TurnStatus::Error);
    }

    #[tokio::test]
    async fn clarification_creates_thread_and_frames_prompt() {
        let dir = tempfile::tempdir().unwrap();
        let mut env = ShellEnv::from_process();
        env.vars.insert("PATH".into(), "/nonexistent".into());
        let engine = Arc::new(Engine::open_with_env(GlossPaths::at(dir.path()), env).unwrap());
        let conv = engine.create_conversation(AgentId::Claude, Some("haiku".into()), Some(false), None).unwrap();
        let (sink, _) = collect();
        let res = engine
            .send_turn(
                SendTurnRequest {
                    conversation_id: conv.summary.id.clone(),
                    text: "why?".into(),
                    clarification: Some(ClarificationTarget::New {
                        anchor_block_id: "turn_x:0".into(),
                        quote: "the store buffer".into(),
                        parent_id: None,
                    }),
                    attachments: vec![],
                },
                sink,
            )
            .await
            .unwrap();
        let cl = res.clarification.unwrap();
        assert_eq!(cl.number, 1);
        assert_eq!(res.user_turn.clarification_id.as_deref(), Some(cl.id.as_str()));
        assert!(res.user_turn.prompt_text.unwrap().contains("> \"the store buffer\"\n\nwhy?"));
        // A clarification does not retitle the conversation.
        assert_eq!(engine.get_conversation(&conv.summary.id).unwrap().summary.title, "New conversation");
    }

    #[test]
    fn project_folder_must_exist_and_is_stored_canonical() {
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::open_with_env(GlossPaths::at(dir.path()), ShellEnv::from_process()).unwrap();
        let project = dir.path().join("proj");
        std::fs::create_dir(&project).unwrap();
        let err = engine.create_conversation(AgentId::Pi, None, None, Some("proj".into())).unwrap_err();
        assert!(err.to_string().contains("absolute"));
        let missing = dir.path().join("nope").to_string_lossy().to_string();
        let err = engine.create_conversation(AgentId::Pi, None, None, Some(missing)).unwrap_err();
        assert!(err.to_string().contains("does not exist"));
        let dotted = format!("{}/./proj/", dir.path().display());
        let conv = engine.create_conversation(AgentId::Pi, None, None, Some(dotted)).unwrap();
        assert_eq!(
            conv.summary.project_dir.as_deref(),
            Some(std::fs::canonicalize(&project).unwrap().to_string_lossy().as_ref())
        );
        let plain = engine.create_conversation(AgentId::Pi, None, None, Some("  ".into())).unwrap();
        assert!(plain.summary.project_dir.is_none());
    }

    #[test]
    fn artifact_files_are_written_and_purged() {
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::open_with_env(GlossPaths::at(dir.path()), ShellEnv::from_process()).unwrap();
        let path = engine.write_artifact_file("my page.html", "<p>hi</p>").unwrap();
        assert!(path.starts_with(&engine.paths.artifacts));
        assert!(path.ends_with("my_page.html"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "<p>hi</p>");
        purge_old_artifact_files(&engine.paths.artifacts, Duration::from_secs(3600));
        assert!(path.exists());
        purge_old_artifact_files(&engine.paths.artifacts, Duration::ZERO);
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn attachments_inline_text_and_travel_with_the_turn() {
        let dir = tempfile::tempdir().unwrap();
        let mut env = ShellEnv::from_process();
        env.vars.insert("PATH".into(), "/nonexistent".into());
        let engine = Arc::new(Engine::open_with_env(GlossPaths::at(dir.path()), env).unwrap());
        let conv = engine.create_conversation(AgentId::Pi, None, Some(false), None).unwrap();
        let txt = engine.add_attachment("notes (draft).md", "", b"# Notes\nline\n").unwrap();
        assert_eq!(txt.kind, AttachmentKind::Text);
        assert!(txt.path.ends_with("notes__draft_.md"));
        let img = engine.add_attachment("pic.png", "image/png", b"\x89PNG\r\n").unwrap();
        assert_eq!(img.kind, AttachmentKind::Image);
        assert!(engine.add_attachment("x.pdf", "application/pdf", b"%PDF\0").is_err());

        let (sink, _) = collect();
        let res = engine
            .send_turn(
                SendTurnRequest {
                    conversation_id: conv.summary.id.clone(),
                    text: "summarise".into(),
                    clarification: None,
                    attachments: vec![txt.id.clone(), img.id.clone()],
                },
                sink,
            )
            .await
            .unwrap();
        let prompt = res.user_turn.prompt_text.unwrap();
        assert!(prompt.contains("<attachment name=\"notes (draft).md\">\n# Notes\nline\n</attachment>"));
        assert_eq!(res.user_turn.attachments.len(), 2);
        assert_eq!(res.user_turn.attachments[1].turn_id.as_deref(), Some(res.user_turn.id.as_str()));
        // A sent attachment cannot be removed or sent again.
        assert!(engine.remove_attachment(&txt.id).is_err());
        assert!(engine.staged_attachments(std::slice::from_ref(&img.id)).is_err());
        for _ in 0..50 {
            if !engine.is_running(&conv.summary.id) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let stored = engine.get_conversation(&conv.summary.id).unwrap();
        assert_eq!(stored.turns[0].attachments.len(), 2);

        let staged = engine.add_attachment("tmp.txt", "text/plain", b"x").unwrap();
        let staged_path = staged.path.clone();
        engine.remove_attachment(&staged.id).unwrap();
        assert!(!std::path::Path::new(&staged_path).exists());
        engine.delete_conversation(&conv.summary.id).unwrap();
        assert!(!std::path::Path::new(&img.path).exists());
    }
}
