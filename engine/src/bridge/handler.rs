//! Dispatches bridge requests to the engine. Transport-agnostic: the Unix
//! socket and loopback listeners both hand their lines here.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::protocol::{code_for, ErrorCode, Outgoing, Request};
use super::{MAX_LINE_BYTES, MIN_PROTOCOL, PROTOCOL};
use crate::engine::{Engine, EventSink};
use crate::store::now_ms;
use crate::types::*;

/// A connected extension, as the Settings sheet lists it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: u64,
    /// "native" (Unix socket) or "loopback" (Safari).
    pub transport: String,
    /// The browser named in `hello`, e.g. "chrome", "firefox", "safari".
    pub browser: String,
    pub extension_version: String,
    pub connected_at: i64,
}

/// Per-connection state the handler needs between requests.
pub struct SessionState {
    pub id: u64,
    pub transport: String,
    /// Set once `hello` succeeded; every other method requires it.
    pub greeted: bool,
}

impl SessionState {
    pub fn new(id: u64, transport: &str) -> SessionState {
        SessionState { id, transport: transport.to_string(), greeted: false }
    }
}

pub struct BridgeHandler {
    pub engine: Arc<Engine>,
    app_version: String,
    sessions: Mutex<Vec<SessionInfo>>,
    next_id: AtomicU64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelloParams {
    protocol: u32,
    #[serde(default)]
    extension_version: String,
    #[serde(default)]
    browser: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FollowUpParams {
    clarification_id: String,
    question: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenParams {
    clarification_id: String,
    open: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReportParams {
    states: std::collections::HashMap<String, AnchorState>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FocusParams {
    url_key: String,
    #[serde(default)]
    clarification_id: Option<String>,
}

/// Replies longer than this have their turn texts cut (see `fit`).
const TRUNCATED_TURN_CHARS: usize = 4000;

impl BridgeHandler {
    pub fn new(engine: Arc<Engine>, app_version: &str) -> BridgeHandler {
        BridgeHandler { engine, app_version: app_version.to_string(), sessions: Mutex::new(Vec::new()), next_id: AtomicU64::new(1) }
    }

    pub fn next_session_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    /// Extensions connected right now.
    pub fn sessions(&self) -> Vec<SessionInfo> {
        self.sessions.lock().unwrap().clone()
    }

    pub fn forget_session(&self, id: u64) {
        self.sessions.lock().unwrap().retain(|s| s.id != id);
    }

    /// Settings the extension needs, as `hello` and the `settings` event send them.
    pub fn settings_for_extension(settings: &Settings) -> Value {
        json!({ "sendPageText": settings.send_page_text, "denyList": settings.page_deny_list })
    }

    pub async fn handle(&self, session: &mut SessionState, req: Request) -> Outgoing {
        let id = req.id.clone();
        if !session.greeted && req.method != "hello" {
            return Outgoing::err(&id, ErrorCode::Protocol, "the first request must be hello");
        }
        match self.dispatch(session, &req).await {
            Ok(v) => Outgoing::ok(&id, v),
            Err(Failure::Code(code, msg)) => Outgoing::err(&id, code, msg),
            Err(Failure::Engine(e)) => {
                let msg = e.to_string();
                Outgoing::err(&id, code_for(&msg), msg)
            }
        }
    }

    async fn dispatch(&self, session: &mut SessionState, req: &Request) -> Result<Value, Failure> {
        let engine = &self.engine;
        match req.method.as_str() {
            "hello" => {
                let p: HelloParams = params(&req.params)?;
                if p.protocol < MIN_PROTOCOL {
                    return Err(Failure::Code(
                        ErrorCode::Protocol,
                        format!("the extension speaks protocol {} but Gloss {} needs at least {}", p.protocol, self.app_version, MIN_PROTOCOL),
                    ));
                }
                if p.protocol > PROTOCOL {
                    return Err(Failure::Code(
                        ErrorCode::Protocol,
                        format!("the extension speaks protocol {} but Gloss {} only knows {}; update Gloss", p.protocol, self.app_version, PROTOCOL),
                    ));
                }
                session.greeted = true;
                let info = SessionInfo {
                    id: session.id,
                    transport: session.transport.clone(),
                    browser: p.browser,
                    extension_version: p.extension_version,
                    connected_at: now_ms(),
                };
                let mut sessions = self.sessions.lock().unwrap();
                sessions.retain(|s| s.id != session.id);
                sessions.push(info);
                let settings = engine.settings()?;
                Ok(json!({
                    "protocol": PROTOCOL,
                    "minProtocol": MIN_PROTOCOL,
                    "appVersion": self.app_version,
                    "settings": Self::settings_for_extension(&settings),
                    "agent": settings.page_agent.unwrap_or(settings.default_agent),
                }))
            }
            "getPage" => {
                let meta: PageMeta = params(&req.params)?;
                let (url_key, detail) = engine.get_page_by_url(&meta, true)?;
                let mut v = json!({ "urlKey": url_key, "page": detail });
                fit(&mut v);
                Ok(v)
            }
            "getTurn" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct P {
                    turn_id: String,
                }
                let p: P = params(&req.params)?;
                let turn = engine.store.get_turn(&p.turn_id)?;
                let request = engine.pending_request(&turn.conversation_id);
                Ok(json!({ "turn": turn, "running": engine.is_running(&turn.conversation_id), "request": request }))
            }
            "ask" => {
                let p: PageAskRequest = params(&req.params)?;
                let res = engine.page_ask(p, quiet_sink()).await?;
                Ok(json!(res))
            }
            "followUp" => {
                let p: FollowUpParams = params(&req.params)?;
                let cl = engine.store.get_clarification(&p.clarification_id)?;
                let res = engine
                    .send_turn(
                        SendTurnRequest {
                            conversation_id: cl.conversation_id,
                            text: p.question,
                            clarification: Some(ClarificationTarget::Existing { clarification_id: cl.id }),
                            attachments: vec![],
                        },
                        quiet_sink(),
                    )
                    .await?;
                Ok(json!({ "userTurn": res.user_turn, "assistantTurn": res.assistant_turn }))
            }
            "askPage" => {
                let mut p: PageAskRequest = params(&req.params)?;
                p.anchor = None;
                let res = engine.page_ask(p, quiet_sink()).await?;
                Ok(json!(res))
            }
            "setOpen" => {
                let p: OpenParams = params(&req.params)?;
                engine.set_clarification_open(&p.clarification_id, p.open)?;
                Ok(json!({}))
            }
            "cancel" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct P {
                    conversation_id: String,
                }
                let p: P = params(&req.params)?;
                engine.cancel_turn(&p.conversation_id);
                Ok(json!({}))
            }
            "deleteAsk" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct P {
                    clarification_id: String,
                }
                let p: P = params(&req.params)?;
                engine.delete_clarification(&p.clarification_id)?;
                Ok(json!({}))
            }
            "reportAnchors" => {
                let p: ReportParams = params(&req.params)?;
                let states: Vec<(String, AnchorState)> = p.states.into_iter().collect();
                engine.report_anchors(&states)?;
                Ok(json!({}))
            }
            "listRecentPages" => {
                #[derive(Deserialize)]
                struct P {
                    #[serde(default)]
                    limit: Option<usize>,
                }
                let p: P = params(&req.params)?;
                let pages = engine.list_pages(p.limit.unwrap_or(20).min(200))?;
                Ok(json!({ "pages": pages }))
            }
            "openInGloss" => {
                let p: FocusParams = params(&req.params)?;
                engine.publish(AppEvent::Focus { url_key: p.url_key, clarification_id: p.clarification_id });
                Ok(json!({}))
            }
            other => Err(Failure::Code(ErrorCode::Invalid, format!("unknown method {}", other))),
        }
    }
}

enum Failure {
    Code(ErrorCode, String),
    Engine(anyhow::Error),
}

impl From<anyhow::Error> for Failure {
    fn from(e: anyhow::Error) -> Failure {
        Failure::Engine(e)
    }
}

fn params<T: serde::de::DeserializeOwned>(v: &Value) -> Result<T, Failure> {
    let v = if v.is_null() { Value::Object(Default::default()) } else { v.clone() };
    serde_json::from_value(v).map_err(|e| Failure::Code(ErrorCode::Invalid, format!("bad parameters: {}", e)))
}

/// Events reach the browser through the engine's broadcast, so requests
/// that start turns need no sink of their own.
fn quiet_sink() -> EventSink {
    Arc::new(|_| {})
}

/// Keeps a reply under the frame cap. The prompts handed to the agent are
/// dropped first (they carry the page text, and the browser never shows
/// them); if the reply is still too large, long turn texts are cut and
/// marked `truncated` so the extension can point to Gloss for the rest.
fn fit(v: &mut Value) {
    if let Some(turns) = v.pointer_mut("/page/conversation/turns").and_then(|t| t.as_array_mut()) {
        for turn in turns {
            turn["promptText"] = Value::Null;
        }
    }
    if serde_json::to_string(v).map(|s| s.len()).unwrap_or(0) <= MAX_LINE_BYTES {
        return;
    }
    if let Some(turns) = v.pointer_mut("/page/conversation/turns").and_then(|t| t.as_array_mut()) {
        for turn in turns {
            let cut = turn["text"].as_str().map(|t| t.chars().count() > TRUNCATED_TURN_CHARS).unwrap_or(false);
            if cut {
                let short: String = turn["text"].as_str().unwrap_or("").chars().take(TRUNCATED_TURN_CHARS).collect();
                turn["text"] = Value::String(short);
                turn["truncated"] = Value::Bool(true);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::ShellEnv;
    use crate::paths::GlossPaths;

    fn handler(dir: &std::path::Path) -> BridgeHandler {
        let mut env = ShellEnv::from_process();
        env.vars.insert("PATH".into(), "/nonexistent".into());
        let engine = Arc::new(Engine::open_with_env(GlossPaths::at(dir), env).unwrap());
        BridgeHandler::new(engine, "1.2.3")
    }

    fn req(id: &str, method: &str, params: Value) -> Request {
        Request { id: id.into(), method: method.into(), params }
    }

    fn result(out: Outgoing) -> Value {
        match out {
            Outgoing::Response { result, .. } => result,
            Outgoing::Error { error, .. } => panic!("unexpected error {:?}", error),
            Outgoing::Event { .. } => panic!("unexpected event"),
        }
    }

    fn error(out: Outgoing) -> ErrorCode {
        match out {
            Outgoing::Error { error, .. } => error.code,
            other => panic!("expected an error, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn hello_gates_everything_and_checks_the_protocol() {
        let dir = tempfile::tempdir().unwrap();
        let h = handler(dir.path());
        let mut s = SessionState::new(1, "native");
        assert_eq!(error(h.handle(&mut s, req("0", "getPage", json!({"url": "https://x.com"}))).await), ErrorCode::Protocol);
        assert_eq!(error(h.handle(&mut s, req("1", "hello", json!({"protocol": 99}))).await), ErrorCode::Protocol);
        assert_eq!(error(h.handle(&mut s, req("1", "hello", json!({"protocol": 0}))).await), ErrorCode::Protocol);
        let r = result(h.handle(&mut s, req("2", "hello", json!({"protocol": 1, "browser": "firefox", "extensionVersion": "0.1"}))).await);
        assert_eq!(r["appVersion"], "1.2.3");
        assert_eq!(r["settings"]["sendPageText"], true);
        assert_eq!(h.sessions()[0].browser, "firefox");
        assert_eq!(error(h.handle(&mut s, req("3", "nope", Value::Null)).await), ErrorCode::Invalid);
        assert_eq!(error(h.handle(&mut s, req("4", "getPage", json!({"url": "chrome://x"}))).await), ErrorCode::Internal);
        h.forget_session(1);
        assert!(h.sessions().is_empty());
    }

    #[tokio::test]
    async fn ask_creates_the_page_and_later_requests_find_it() {
        let dir = tempfile::tempdir().unwrap();
        let h = handler(dir.path());
        let mut s = SessionState::new(1, "loopback");
        result(h.handle(&mut s, req("1", "hello", json!({"protocol": 1}))).await);
        let ask = json!({
            "page": {"url": "https://example.com/post?utm_source=mail", "title": "A post"},
            "anchor": {"quote": {"exact": "store buffer", "prefix": "the ", "suffix": " holds"}, "position": {"start": 4, "end": 16}},
            "context": {"before": "In CPUs the", "after": "holds writes"},
            "question": "why?",
            "pageText": "In CPUs the store buffer holds writes."
        });
        let r = result(h.handle(&mut s, req("2", "ask", ask.clone())).await);
        assert_eq!(r["urlKey"], "https://example.com/post");
        let cl_id = r["clarification"]["id"].as_str().unwrap().to_string();
        assert_eq!(r["clarification"]["webAnchor"]["quote"]["exact"], "store buffer");
        let turn_id = r["assistantTurn"]["id"].as_str().unwrap().to_string();

        let page = result(h.handle(&mut s, req("3", "getPage", json!({"url": "https://example.com/post"}))).await);
        assert_eq!(page["page"]["page"]["title"], "A post");
        assert_eq!(page["page"]["page"]["askCount"], 1);
        assert_eq!(page["page"]["conversation"]["clarifications"][0]["id"], cl_id);

        let turn = result(h.handle(&mut s, req("4", "getTurn", json!({"turnId": turn_id}))).await);
        assert_eq!(turn["turn"]["id"], turn_id);

        result(h.handle(&mut s, req("5", "reportAnchors", json!({"states": {cl_id.clone(): "orphan"}}))).await);
        result(h.handle(&mut s, req("6", "setOpen", json!({"clarificationId": cl_id, "open": false}))).await);
        let page = result(h.handle(&mut s, req("7", "getPage", json!({"url": "https://example.com/post"}))).await);
        assert_eq!(page["page"]["page"]["orphanCount"], 1);
        assert_eq!(page["page"]["conversation"]["clarifications"][0]["open"], false);
        assert_eq!(page["page"]["conversation"]["clarifications"][0]["anchorState"], "orphan");

        let list = result(h.handle(&mut s, req("8", "listRecentPages", Value::Null)).await);
        assert_eq!(list["pages"].as_array().unwrap().len(), 1);

        result(h.handle(&mut s, req("9", "deleteAsk", json!({"clarificationId": cl_id}))).await);
        let page = result(h.handle(&mut s, req("10", "getPage", json!({"url": "https://example.com/post"}))).await);
        assert_eq!(page["page"]["page"]["askCount"], 0);
        assert_eq!(error(h.handle(&mut s, req("11", "ask", json!({"page": {"url": "https://example.com"}, "question": "q", "private": true}))).await), ErrorCode::Denied);
    }

    #[test]
    fn long_replies_are_cut_to_fit_a_frame() {
        let prompt = "p".repeat(MAX_LINE_BYTES + 10);
        let mut v = json!({"page": {"conversation": {"turns": [{"text": "a", "promptText": prompt}]}}});
        fit(&mut v);
        assert!(v["page"]["conversation"]["turns"][0]["promptText"].is_null());
        assert!(v["page"]["conversation"]["turns"][0].get("truncated").is_none());

        let big = "x".repeat(MAX_LINE_BYTES + 10);
        let mut v = json!({"page": {"conversation": {"turns": [{"text": big}, {"text": "short"}]}}});
        fit(&mut v);
        assert_eq!(v["page"]["conversation"]["turns"][0]["truncated"], true);
        assert_eq!(v["page"]["conversation"]["turns"][0]["text"].as_str().unwrap().len(), TRUNCATED_TURN_CHARS);
        assert!(v["page"]["conversation"]["turns"][1].get("truncated").is_none());
    }
}
