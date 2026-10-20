//! Wire types of the bridge protocol. One JSON object per line in both
//! directions: the extension sends `Request`s, Gloss answers each with a
//! `Response` or `Error` carrying the same id, and pushes `Event`s at any
//! time. The field names are camelCase to match the extension's TypeScript.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize, Debug, Clone)]
pub struct Request {
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Serialize, Debug, Clone)]
#[serde(untagged)]
pub enum Outgoing {
    Response { id: String, result: Value },
    Error { id: String, error: BridgeError },
    Event { event: String, data: Value },
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct BridgeError {
    pub code: ErrorCode,
    pub message: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// The extension and the app speak incompatible protocol versions, or
    /// `hello` was not the first request.
    Protocol,
    /// The connection did not present a valid token (loopback listener only).
    Unauthorized,
    /// A turn is already running in that page's conversation.
    Busy,
    NotFound,
    /// The page is on the deny list or the window is private.
    Denied,
    /// Malformed parameters.
    Invalid,
    Internal,
    /// Produced by `gloss-bridge` itself when no Gloss is running.
    AppNotRunning,
}

impl Outgoing {
    pub fn ok(id: &str, result: Value) -> Outgoing {
        Outgoing::Response { id: id.to_string(), result }
    }
    pub fn err(id: &str, code: ErrorCode, message: impl Into<String>) -> Outgoing {
        Outgoing::Error { id: id.to_string(), error: BridgeError { code, message: message.into() } }
    }
    pub fn event(name: &str, data: Value) -> Outgoing {
        Outgoing::Event { event: name.to_string(), data }
    }
}

/// Maps an engine error to a protocol error code by its message.
pub fn code_for(message: &str) -> ErrorCode {
    let m = message.to_ascii_lowercase();
    if m.contains("already running") {
        ErrorCode::Busy
    } else if m.contains("deny list") || m.contains("private window") {
        ErrorCode::Denied
    } else if m.starts_with("no ") || m.contains("not found") {
        ErrorCode::NotFound
    } else {
        ErrorCode::Internal
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outgoing_shapes_match_the_extension() {
        let r = serde_json::to_string(&Outgoing::ok("1", serde_json::json!({"a": 1}))).unwrap();
        assert_eq!(r, r#"{"id":"1","result":{"a":1}}"#);
        let e = serde_json::to_string(&Outgoing::err("2", ErrorCode::Busy, "wait")).unwrap();
        assert_eq!(e, r#"{"id":"2","error":{"code":"busy","message":"wait"}}"#);
        let ev = serde_json::to_string(&Outgoing::event("page", serde_json::json!({"urlKey": "k"}))).unwrap();
        assert_eq!(ev, r#"{"event":"page","data":{"urlKey":"k"}}"#);
        let req: Request = serde_json::from_str(r#"{"id":"x","method":"hello"}"#).unwrap();
        assert!(req.params.is_null());
    }

    #[test]
    fn error_codes_follow_engine_messages() {
        assert_eq!(code_for("a turn is already running in this conversation"), ErrorCode::Busy);
        assert_eq!(code_for("no clarification cl_1"), ErrorCode::NotFound);
        assert_eq!(code_for("example.com is on the deny list"), ErrorCode::Denied);
        assert_eq!(code_for("boom"), ErrorCode::Internal);
    }
}
