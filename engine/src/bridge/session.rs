//! One bridge connection: reads request lines, answers them, and forwards
//! engine events, whichever transport carries the bytes.

use std::sync::Arc;

use serde_json::{json, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;
use tracing::{debug, warn};

use super::handler::{BridgeHandler, SessionState};
use super::protocol::{ErrorCode, Outgoing};
use super::MAX_LINE_BYTES;
use crate::types::AppEvent;

/// Serves one connection until the peer closes it or the engine shuts
/// down. Responses and events share the writer through a channel, so a
/// slow reply never interleaves with an event line. `label` names the
/// transport in logs.
pub async fn run_session<R, W>(handler: Arc<BridgeHandler>, reader: R, writer: W, label: &str)
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let writer_task = tokio::spawn(async move {
        let mut writer = writer;
        while let Some(line) = rx.recv().await {
            if writer.write_all(line.as_bytes()).await.is_err() || writer.write_all(b"\n").await.is_err() {
                break;
            }
            if writer.flush().await.is_err() {
                break;
            }
        }
    });

    let mut events = handler.engine.subscribe();
    let mut state = SessionState::new(handler.next_session_id(), label);
    let mut lines = reader.lines();
    loop {
        tokio::select! {
            line = lines.next_line() => {
                let Ok(Some(line)) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                let out = match serde_json::from_str::<super::protocol::Request>(&line) {
                    Ok(req) => handler.handle(&mut state, req).await,
                    Err(e) => Outgoing::err("", ErrorCode::Invalid, format!("malformed request: {}", e)),
                };
                if tx.send(encode(out)).is_err() {
                    break;
                }
            }
            ev = events.recv() => {
                match ev {
                    Ok(AppEvent::Shutdown) => {
                        let _ = tx.send(encode(Outgoing::event("shutdown", Value::Null)));
                        break;
                    }
                    Ok(ev) => {
                        if let Some(out) = event_line(ev) {
                            if tx.send(encode(out)).is_err() {
                                break;
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        warn!(session = state.id, skipped = n, "bridge session fell behind on events");
                    }
                    Err(_) => break,
                }
            }
        }
    }
    handler.forget_session(state.id);
    drop(tx);
    let _ = writer_task.await;
    debug!(session = state.id, "bridge session closed");
}

/// The line a session sends for an engine event, or None for events the
/// browser has no use for.
fn event_line(ev: AppEvent) -> Option<Outgoing> {
    match ev {
        AppEvent::Turn(env) => Some(Outgoing::event("turn", json!(env))),
        AppEvent::Page { url_key, deleted } => Some(Outgoing::event("page", json!({ "urlKey": url_key, "deleted": deleted }))),
        AppEvent::Settings(s) => Some(Outgoing::event(
            "settings",
            json!({ "sendPageText": s.send_page_text, "denyList": s.page_deny_list }),
        )),
        AppEvent::Focus { .. } | AppEvent::Shutdown => None,
    }
}

/// Serialises an outgoing message, replacing anything over the size cap
/// with an error so a frame never exceeds what the browser accepts.
pub fn encode(out: Outgoing) -> String {
    let line = serde_json::to_string(&out).unwrap_or_else(|_| "{}".into());
    if line.len() <= MAX_LINE_BYTES {
        return line;
    }
    let id = match &out {
        Outgoing::Response { id, .. } | Outgoing::Error { id, .. } => id.clone(),
        Outgoing::Event { .. } => String::new(),
    };
    serde_json::to_string(&Outgoing::err(&id, ErrorCode::Internal, "reply too large for the browser; open it in Gloss"))
        .unwrap_or_else(|_| "{}".into())
}
