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
use crate::history::{self, AgentHomes, SessionIndex};
use crate::pages;
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
    /// Where each agent keeps its own session history.
    pub homes: AgentHomes,
    /// Session files already read from those homes.
    sessions: SessionIndex,
    /// One cancellation token per conversation with a live agent process.
    running: Mutex<HashMap<String, RunningTurn>>,
    idle_timeout: Duration,
    /// Everything that happens, for the shell window and the browser bridge.
    events: tokio::sync::broadcast::Sender<AppEvent>,
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
            homes: AgentHomes::from_env(&env),
            sessions: SessionIndex::default(),
            env,
            store,
            running: Mutex::new(HashMap::new()),
            idle_timeout: DEFAULT_IDLE_TIMEOUT,
            events: tokio::sync::broadcast::channel(4096).0,
        })
    }

    /// A receiver of every `AppEvent` from now on. A slow receiver that
    /// falls more than the channel's capacity behind skips events.
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<AppEvent> {
        self.events.subscribe()
    }

    /// Tells every subscriber. Nothing happens when there is none.
    pub fn publish(&self, event: AppEvent) {
        let _ = self.events.send(event);
    }

    /// Publishes a `Page` event when the conversation belongs to a page.
    fn publish_page_change(&self, conversation_id: &str) {
        if let Ok(Some(page)) = self.store.page_of_conversation(conversation_id) {
            self.publish(AppEvent::Page { url_key: page.url_key, deleted: false });
        }
    }

    /// Reads agent history from `homes` instead of the user's home folders.
    pub fn with_agent_homes(mut self, homes: AgentHomes) -> Engine {
        self.homes = homes;
        self
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
        self.publish(AppEvent::Settings(Box::new(settings.clone())));
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

    // ── projects ────────────────────────────────────────────────────────

    /// Adds an existing directory as a project, stored by its canonical path.
    pub fn add_project(&self, path: &str) -> Result<Project> {
        let dir = canonical_dir(path)?;
        self.store.add_project(&dir)
    }

    pub fn list_projects(&self) -> Result<Vec<Project>> {
        self.store.list_projects()
    }

    /// Sessions that Claude Code, Codex, Gemini CLI and Pi recorded for the
    /// project folder, newest first, leaving out any a Gloss conversation
    /// holds. Reads the agents' files; never writes them.
    pub fn list_project_sessions(&self, path: &str) -> Result<Vec<ExternalSession>> {
        let owned = self.store.agent_session_ids()?;
        let mut list = self.sessions.list(&self.homes, path);
        list.retain(|s| !owned.contains(&s.id));
        Ok(list)
    }

    /// The outside session `agent`/`id` of a project, as `list_project_sessions` lists it.
    fn project_session(&self, path: &str, agent: AgentId, id: &str) -> Result<ExternalSession> {
        self.list_project_sessions(path)?
            .into_iter()
            .find(|s| s.agent == agent && s.id == id)
            .ok_or_else(|| anyhow!("{} has no {} session {} outside Gloss", path, agent, id))
    }

    /// The turns of an outside session of the project, read from the agent's
    /// file. Only sessions the project lists can be read, so this never opens
    /// a file outside the agents' history for that folder.
    pub fn read_project_session(&self, path: &str, agent: AgentId, id: &str) -> Result<Vec<SessionTurn>> {
        let s = self.project_session(path, agent, id)?;
        Ok(history::read_turns(agent, std::path::Path::new(&s.file)))
    }

    /// Takes over an outside session of the project: a new conversation in the
    /// project that resumes the same agent session, so its turns are written
    /// to the same history file the terminal (or editor) used. The turns
    /// before now stay in that file and come from `conversation_history`.
    pub fn continue_project_session(&self, path: &str, agent: AgentId, id: &str) -> Result<Conversation> {
        let s = self.project_session(path, agent, id)?;
        let conv = self.create_conversation(agent, None, None, Some(path.to_string()))?;
        let conv_id = conv.summary.id.clone();
        self.store.set_agent_session_id(&conv_id, &s.id)?;
        self.store.set_origin(&conv_id, &s.file, crate::store::now_ms())?;
        self.store.rename_conversation(&conv_id, &s.title)?;
        self.get_conversation(&conv_id)
    }

    /// Where Pi keeps this conversation's session: the folder of the outside
    /// session it continued, or else Gloss's own Pi session folder.
    fn pi_session_dir(&self, conv_id: &str, agent: AgentId) -> Result<std::path::PathBuf> {
        if agent == AgentId::Pi {
            if let Some((file, _)) = self.store.origin(conv_id)? {
                if let Some(dir) = std::path::Path::new(&file).parent() {
                    return Ok(dir.to_path_buf());
                }
            }
        }
        Ok(self.paths.pi_sessions.clone())
    }

    /// For a conversation that continued an outside session: the session's
    /// turns from before Gloss took it over. Empty for any other conversation.
    pub fn conversation_history(&self, id: &str) -> Result<Vec<SessionTurn>> {
        let Some((file, until)) = self.store.origin(id)? else { return Ok(Vec::new()) };
        let agent = self.store.get_summary(id)?.agent;
        let mut turns = history::read_turns(agent, std::path::Path::new(&file));
        // Turns written after the takeover are this conversation's own, which
        // the store already holds. A turn with no recorded time (0) is kept.
        turns.retain(|t| t.at < until);
        Ok(turns)
    }

    /// Removes a project from the list. Its conversations are kept.
    pub fn remove_project(&self, path: &str) -> Result<()> {
        self.store.remove_project(path)
    }

    /// `project_dir`, when given, must be an existing directory; it is stored
    /// in canonical form, added as a project if it is not one yet, and the
    /// agent runs inside it with read-only file tools for every turn of the
    /// conversation.
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
            Some(dir) => Some(canonical_dir(&dir)?),
        };
        if let Some(dir) = &project {
            self.store.add_project(dir)?;
        }
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
        let page = self.store.page_of_conversation(id)?;
        self.store.delete_conversation(id)?;
        if let Some(page) = page {
            self.publish(AppEvent::Page { url_key: page.url_key, deleted: true });
        }
        Ok(())
    }

    pub fn set_conversation_model(&self, id: &str, model: &str) -> Result<ConversationSummary> {
        self.store.set_model(id, model)
    }

    pub fn set_conversation_web_search(&self, id: &str, enabled: bool) -> Result<ConversationSummary> {
        self.store.set_web_search(id, enabled)
    }

    pub fn set_clarification_open(&self, id: &str, open: bool) -> Result<()> {
        self.store.set_clarification_open(id, open)?;
        let cl = self.store.get_clarification(id)?;
        self.publish_page_change(&cl.conversation_id);
        Ok(())
    }

    /// Removes a clarification with its thread and nested clarifications,
    /// and the files of any attachment those turns carried.
    pub fn delete_clarification(&self, id: &str) -> Result<()> {
        let cl = self.store.get_clarification(id)?;
        for att in self.store.delete_clarification(id)? {
            remove_attachment_files(&att);
        }
        self.publish_page_change(&cl.conversation_id);
        Ok(())
    }

    // ── pages ───────────────────────────────────────────────────────────

    /// The page a browser URL maps to: its key, and its detail when Gloss
    /// has it. With `touch`, a known page's URL, title, favicon and
    /// last-seen time are refreshed from `meta`.
    pub fn get_page_by_url(&self, meta: &PageMeta, touch: bool) -> Result<(String, Option<PageDetail>)> {
        let url_key = pages::url_key(&meta.url)?;
        let Some(page) = self.store.get_page(&url_key)? else { return Ok((url_key, None)) };
        let page = if touch {
            self.store
                .upsert_page(&url_key, &meta.url, &meta.title, meta.favicon_url.as_deref(), &page.conversation_id)?
        } else {
            page
        };
        let conversation = self.get_conversation(&page.conversation_id)?;
        Ok((url_key, Some(PageDetail { page, conversation })))
    }

    pub fn get_page(&self, url_key: &str) -> Result<Option<PageDetail>> {
        let Some(page) = self.store.get_page(url_key)? else { return Ok(None) };
        let conversation = self.get_conversation(&page.conversation_id)?;
        Ok(Some(PageDetail { page, conversation }))
    }

    pub fn list_pages(&self, limit: usize) -> Result<Vec<Page>> {
        self.store.list_pages(limit)
    }

    /// Removes a page and its conversation.
    pub fn delete_page(&self, url_key: &str) -> Result<()> {
        let Some(page) = self.store.get_page(url_key)? else { return Err(anyhow!("no page {}", url_key)) };
        self.delete_conversation(&page.conversation_id)
    }

    /// Records how the extension placed each anchor on its page.
    pub fn report_anchors(&self, states: &[(String, AnchorState)]) -> Result<()> {
        let mut pages_changed = std::collections::HashSet::new();
        for (id, state) in states {
            let Ok(cl) = self.store.get_clarification(id) else { continue };
            if cl.anchor_state != Some(*state) {
                self.store.set_anchor_state(id, *state)?;
                pages_changed.insert(cl.conversation_id);
            }
        }
        for conv in pages_changed {
            self.publish_page_change(&conv);
        }
        Ok(())
    }

    /// A question from the browser about a page. The page's conversation is
    /// created on the first ask, with the page's title; the readable text is
    /// handed to the agent when it is new or has changed since last time.
    pub async fn page_ask(self: &Arc<Self>, req: PageAskRequest, sink: EventSink) -> Result<PageAskResult> {
        if req.private {
            return Err(anyhow!("pages in a private window are not asked about"));
        }
        let question = req.question.trim().to_string();
        if question.is_empty() {
            return Err(anyhow!("message is empty"));
        }
        let settings = self.store.settings()?;
        let url_key = pages::url_key(&req.page.url)?;
        let host = pages::host_of(&req.page.url);
        if pages::host_matches(&settings.page_deny_list, &host) {
            return Err(anyhow!("{} is on the deny list", host));
        }
        let given_title = req.page.title.trim().to_string();
        let title = if given_title.is_empty() { url_key.clone() } else { given_title.clone() };
        let page = match self.store.get_page(&url_key)? {
            Some(page) => {
                let page = self.store.upsert_page(&url_key, &req.page.url, &given_title, req.page.favicon_url.as_deref(), &page.conversation_id)?;
                if !given_title.is_empty() {
                    self.store.rename_conversation(&page.conversation_id, &title)?;
                }
                page
            }
            None => {
                let agent = settings.page_agent.unwrap_or(settings.default_agent);
                let conv = self.create_conversation(agent, None, None, None)?;
                self.store.rename_conversation(&conv.summary.id, &title)?;
                self.store.upsert_page(&url_key, &req.page.url, &given_title, req.page.favicon_url.as_deref(), &conv.summary.id)?
            }
        };
        // The page text goes along when the agent has not seen this version.
        // Its hash is recorded only once the turn has started, so a refused
        // ask (a turn already running) sends the text again next time.
        let page_text = match req.page_text.filter(|_| settings.send_page_text) {
            Some(text) if !text.trim().is_empty() => {
                let text = pages::truncate_page_text(&text);
                let hash = pages::page_text_hash(&text);
                let previous = self.store.page_text_hash(&url_key)?;
                if previous.as_deref() == Some(hash.as_str()) {
                    None
                } else {
                    Some((text, hash, previous.is_some()))
                }
            }
            _ => None,
        };
        let target = req.anchor.map(|anchor| ClarificationTarget::Web {
            quote: anchor.quote.exact.clone(),
            anchor,
            context: req.context,
        });
        let res = self.send_turn_with_page(
            SendTurnRequest { conversation_id: page.conversation_id.clone(), text: question, clarification: target, attachments: vec![] },
            page_text.as_ref().map(|(text, _, changed)| (text.clone(), *changed)),
            sink,
        )
        .await?;
        if let Some((text, hash, _)) = &page_text {
            self.store.set_page_text(&url_key, text, hash)?;
        }
        self.publish(AppEvent::Page { url_key: url_key.clone(), deleted: false });
        Ok(PageAskResult {
            url_key,
            conversation_id: page.conversation_id,
            clarification: res.clarification,
            user_turn: res.user_turn,
            assistant_turn: res.assistant_turn,
        })
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
        self.send_turn_with_page(req, None, sink).await
    }

    /// `send_turn` with, for a page conversation, the page's readable text
    /// to include in the prompt and whether it replaces an earlier copy.
    async fn send_turn_with_page(
        self: &Arc<Self>,
        req: SendTurnRequest,
        page_text: Option<(String, bool)>,
        sink: EventSink,
    ) -> Result<SendTurnResult> {
        let text = req.text.trim().to_string();
        if text.is_empty() {
            return Err(anyhow!("message is empty"));
        }
        let conv = self.store.get_conversation(&req.conversation_id)?;
        let agent = conv.summary.agent;
        // Every event also reaches the broadcast, so the window and the
        // browser bridge both see it whichever side started the turn.
        let events = self.events.clone();
        let sink: EventSink = Arc::new(move |env: TurnEventEnvelope| {
            sink(env.clone());
            let _ = events.send(AppEvent::Turn(Box::new(env)));
        });

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

        let result = self.start_turn(&conv, agent, text, req.clarification, page_text, &req.attachments, cancel.clone(), interaction, sink);
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
        page_text: Option<(String, bool)>,
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
        let page = self.store.page_of_conversation(&conv_id)?;
        let note = match &page {
            Some(p) => prompt::page_system_note(&p.title, &p.url),
            None => prompt::system_note(conv.summary.project_dir.as_deref()),
        };
        let attachments = self.staged_attachments(attachment_ids)?;
        // No agent session yet means this spawn starts the agent's conversation,
        // even when an earlier attempt failed before the agent reported one.
        let is_first_turn = conv.agent_session_id.is_none();

        let (page_body, page_changed) = match &page_text {
            Some((t, changed)) => (Some(t.as_str()), *changed),
            None => (None, false),
        };
        let (clarification, clarification_id, body) = match target {
            None if page.is_some() => (None, None, prompt::page_question_prompt(&text, page_body, page_changed)),
            None => (None, None, text.clone()),
            Some(ClarificationTarget::New { anchor_block_id, quote, parent_id }) => {
                let cl = self.store.create_clarification(&conv_id, &anchor_block_id, &quote, parent_id.as_deref(), None)?;
                let body = prompt::clarification_prompt(&quote, &text);
                (Some(cl.clone()), Some(cl.id), body)
            }
            Some(ClarificationTarget::Web { quote, anchor, context }) => {
                let anchor_json = serde_json::to_string(&anchor)?;
                let cl = self.store.create_clarification(&conv_id, "", &quote, None, Some(&anchor_json))?;
                let body = prompt::page_ask_prompt(&quote, &context, &text, page_body, page_changed);
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
        // A page conversation is named after its page; others after the first message.
        if clarification_id.is_none() && page.is_none() {
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
            pi_session_dir: self.pi_session_dir(&conv_id, agent)?,
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

    #[allow(clippy::too_many_arguments)]
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
/// The canonical form of `dir`, which must be an absolute path to an existing directory.
fn canonical_dir(dir: &str) -> Result<String> {
    let dir = dir.trim();
    let path = std::path::Path::new(dir);
    if !path.is_absolute() {
        return Err(anyhow!("project folder must be an absolute path: {}", dir));
    }
    if !path.is_dir() {
        return Err(anyhow!("project folder does not exist or is not a directory: {}", dir));
    }
    let canonical = std::fs::canonicalize(path).with_context(|| format!("resolve {}", dir))?;
    Ok(plain_path(&canonical))
}

/// A path written the way users, agents and their session folders write it.
/// On Windows `canonicalize` returns the extended-length form, `\\?\C:\x` or
/// `\\?\UNC\server\share\x`; this turns it back into `C:\x` or
/// `\\server\share\x`. Any other path is returned as it is.
pub(crate) fn plain_path(path: &std::path::Path) -> String {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{}", rest);
    }
    match s.strip_prefix(r"\\?\") {
        // Only a drive path drops the prefix; other verbatim paths need it.
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => rest.to_string(),
        _ => s.into_owned(),
    }
}

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

    fn page_ask(url: &str, title: &str, quote: Option<&str>, question: &str, text: Option<&str>) -> PageAskRequest {
        PageAskRequest {
            page: PageMeta { url: url.into(), title: title.into(), favicon_url: None },
            anchor: quote.map(|q| WebAnchor {
                quote: TextQuoteSelector { exact: q.into(), prefix: "pre ".into(), suffix: " suf".into() },
                position: Some(TextPositionSelector { start: 10, end: 20 }),
                container: Some("main > p:nth-of-type(2)".into()),
            }),
            context: AskContext { before: "before text".into(), after: "after text".into() },
            question: question.into(),
            page_text: text.map(String::from),
            private: false,
        }
    }

    async fn settle(engine: &Engine, conv_id: &str) {
        for _ in 0..100 {
            if !engine.is_running(conv_id) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[tokio::test]
    async fn page_asks_create_a_page_conversation_and_send_text_once() {
        let dir = tempfile::tempdir().unwrap();
        let mut env = ShellEnv::from_process();
        env.vars.insert("PATH".into(), "/nonexistent".into());
        let engine = Arc::new(Engine::open_with_env(GlossPaths::at(dir.path()), env).unwrap());
        let mut events = engine.subscribe();
        let (sink, _) = collect();

        let first = engine
            .page_ask(page_ask("https://example.com/post?utm_source=x", "A post", Some("store buffer"), "why?", Some("Page body")), sink.clone())
            .await
            .unwrap();
        assert_eq!(first.url_key, "https://example.com/post");
        let cl = first.clarification.clone().unwrap();
        assert_eq!(cl.anchor_block_id, "");
        assert_eq!(cl.web_anchor.as_ref().unwrap().quote.prefix, "pre ");
        let prompt1 = first.user_turn.prompt_text.clone().unwrap();
        assert!(prompt1.contains("> \"store buffer\""));
        assert!(prompt1.contains("Text just before it: \"…before text\""));
        assert!(prompt1.contains("<page>\nPage body\n</page>"));
        assert!(!prompt1.contains("has changed"));
        // Claude takes the note as a flag, so the prompt body has no system note.
        let conv = engine.get_conversation(&first.conversation_id).unwrap();
        assert_eq!(conv.summary.title, "A post");
        assert_eq!(conv.summary.page_key.as_deref(), Some("https://example.com/post"));
        settle(&engine, &first.conversation_id).await;

        // Same text again: not resent. A tracking-param variant finds the same page.
        let second = engine
            .page_ask(page_ask("https://example.com/post?fbclid=1", "", Some("other"), "and?", Some("Page body")), sink.clone())
            .await
            .unwrap();
        assert_eq!(second.conversation_id, first.conversation_id);
        assert!(!second.user_turn.prompt_text.unwrap().contains("<page>"));
        assert_eq!(engine.get_conversation(&first.conversation_id).unwrap().summary.title, "A post");
        settle(&engine, &first.conversation_id).await;

        // Changed text: sent again and marked as changed. No anchor: a page-level question.
        let third = engine
            .page_ask(page_ask("https://example.com/post", "A post", None, "summarise", Some("New body")), sink.clone())
            .await
            .unwrap();
        assert!(third.clarification.is_none());
        let p3 = third.user_turn.prompt_text.unwrap();
        assert!(p3.starts_with("The user is asking about the page as a whole."));
        assert!(p3.contains("which has changed since last time"));
        assert!(p3.contains("<page>\nNew body\n</page>"));
        settle(&engine, &first.conversation_id).await;

        // Page text off: never sent.
        let mut st = engine.settings().unwrap();
        st.send_page_text = false;
        st.page_deny_list = vec!["*.bank.com".into()];
        engine.update_settings(st).unwrap();
        let fourth = engine
            .page_ask(page_ask("https://example.com/post", "A post", Some("q"), "q?", Some("Third body")), sink.clone())
            .await
            .unwrap();
        assert!(!fourth.user_turn.prompt_text.unwrap().contains("<page>"));
        settle(&engine, &first.conversation_id).await;

        let denied = engine.page_ask(page_ask("https://online.bank.com/x", "Bank", None, "q", None), sink.clone()).await.unwrap_err();
        assert!(denied.to_string().contains("deny list"));
        let mut private = page_ask("https://example.com/p", "P", None, "q", None);
        private.private = true;
        assert!(engine.page_ask(private, sink.clone()).await.is_err());

        let page = engine.get_page("https://example.com/post").unwrap().unwrap();
        assert_eq!(page.page.ask_count, 3);
        assert_eq!(engine.list_pages(10).unwrap().len(), 1);
        engine.report_anchors(&[(cl.id.clone(), AnchorState::Orphan)]).unwrap();
        assert_eq!(engine.get_page("https://example.com/post").unwrap().unwrap().page.orphan_count, 1);

        // The broadcast carried turn and page events.
        let mut saw_turn = false;
        let mut saw_page = false;
        while let Ok(ev) = events.try_recv() {
            match ev {
                AppEvent::Turn(_) => saw_turn = true,
                AppEvent::Page { url_key, deleted: false } if url_key == "https://example.com/post" => saw_page = true,
                _ => {}
            }
        }
        assert!(saw_turn && saw_page);

        engine.delete_page("https://example.com/post").unwrap();
        assert!(engine.get_page("https://example.com/post").unwrap().is_none());
        assert!(matches!(events.try_recv(), Ok(AppEvent::Page { deleted: true, .. })));
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

        // Binding a folder adds it as a project, by the same canonical path.
        let projects = engine.list_projects().unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(Some(projects[0].path.as_str()), conv.summary.project_dir.as_deref());
        assert!(engine.add_project("relative").is_err());
        assert_eq!(engine.add_project(&format!("{}/proj", dir.path().display())).unwrap().path, projects[0].path);
    }

    #[test]
    fn project_sessions_leave_out_those_a_conversation_holds() {
        let dir = tempfile::tempdir().unwrap();
        let homes = crate::history::AgentHomes::under(&dir.path().join("home"));
        let engine = Engine::open_with_env(GlossPaths::at(&dir.path().join("gloss")), ShellEnv::from_process())
            .unwrap()
            .with_agent_homes(homes.clone());
        let project = dir.path().join("proj");
        std::fs::create_dir(&project).unwrap();
        let project = plain_path(&std::fs::canonicalize(&project).unwrap());
        let sessions = homes.claude.join("projects").join(crate::history::claude_slug(&project));
        std::fs::create_dir_all(&sessions).unwrap();
        for id in ["mine", "theirs"] {
            let line = serde_json::json!({"type": "user", "sessionId": id, "cwd": project, "entrypoint": "cli",
                "message": {"role": "user", "content": format!("prompt {}", id)}});
            std::fs::write(sessions.join(format!("{}.jsonl", id)), format!("{}\n", line)).unwrap();
        }
        assert_eq!(engine.list_project_sessions(&project).unwrap().len(), 2);
        let conv = engine.create_conversation(AgentId::Claude, None, None, Some(project.clone())).unwrap();
        engine.store.set_agent_session_id(&conv.summary.id, "mine").unwrap();
        let list = engine.list_project_sessions(&project).unwrap();
        assert_eq!(list.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), vec!["theirs"]);
    }

    #[test]
    fn continuing_an_outside_session_resumes_it_in_a_new_conversation() {
        let dir = tempfile::tempdir().unwrap();
        let homes = crate::history::AgentHomes::under(&dir.path().join("home"));
        let engine = Engine::open_with_env(GlossPaths::at(&dir.path().join("gloss")), ShellEnv::from_process())
            .unwrap()
            .with_agent_homes(homes.clone());
        let project = dir.path().join("proj");
        std::fs::create_dir(&project).unwrap();
        let project = plain_path(&std::fs::canonicalize(&project).unwrap());
        let pi_dir = homes.pi.join("sessions").join(crate::history::pi_slug(&project));
        std::fs::create_dir_all(&pi_dir).unwrap();
        let lines = [
            serde_json::json!({"type": "session", "id": "p1", "cwd": project, "timestamp": "2026-10-01T10:00:00Z"}),
            serde_json::json!({"type": "message", "timestamp": "2026-10-01T10:00:01Z", "message": {"role": "user", "content": "What is this?"}}),
            serde_json::json!({"type": "message", "timestamp": "2026-10-01T10:00:02Z", "message": {"role": "assistant", "content": [{"type": "text", "text": "A repo."}]}}),
            // Written after the takeover: the continued conversation's own turn.
            serde_json::json!({"type": "message", "timestamp": "2999-01-01T00:00:00Z", "message": {"role": "user", "content": "Later"}}),
        ];
        let body: String = lines.iter().map(|l| format!("{}\n", l)).collect();
        std::fs::write(pi_dir.join("p1.jsonl"), body).unwrap();

        assert!(engine.read_project_session(&project, AgentId::Claude, "p1").is_err());
        assert_eq!(engine.read_project_session(&project, AgentId::Pi, "p1").unwrap().len(), 3);

        let conv = engine.continue_project_session(&project, AgentId::Pi, "p1").unwrap();
        assert_eq!(conv.agent_session_id.as_deref(), Some("p1"));
        assert_eq!(conv.summary.title, "What is this?");
        assert_eq!(conv.summary.project_dir.as_deref(), Some(project.as_str()));
        assert!(conv.continued_from.as_deref().is_some_and(|f| f.ends_with("p1.jsonl")));
        assert!(engine.list_project_sessions(&project).unwrap().is_empty());
        let earlier = engine.conversation_history(&conv.summary.id).unwrap();
        assert_eq!(earlier.iter().map(|t| t.text.as_str()).collect::<Vec<_>>(), vec!["What is this?", "A repo."]);
        assert_eq!(engine.pi_session_dir(&conv.summary.id, AgentId::Pi).unwrap(), pi_dir);

        let plain = engine.create_conversation(AgentId::Pi, None, None, None).unwrap();
        assert!(engine.conversation_history(&plain.summary.id).unwrap().is_empty());
        assert_eq!(engine.pi_session_dir(&plain.summary.id, AgentId::Pi).unwrap(), engine.paths.pi_sessions);
    }

    #[test]
    fn plain_paths_drop_the_windows_extended_length_prefix() {
        use std::path::Path;
        assert_eq!(plain_path(Path::new(r"\\?\C:\Users\me\app")), r"C:\Users\me\app");
        assert_eq!(plain_path(Path::new(r"\\?\UNC\server\share\app")), r"\\server\share\app");
        assert_eq!(plain_path(Path::new(r"\\?\Volume{abc}\app")), r"\\?\Volume{abc}\app");
        assert_eq!(plain_path(Path::new("/Users/me/app")), "/Users/me/app");
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
