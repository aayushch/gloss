//! TCP listener on 127.0.0.1 for the Safari extension's native handler,
//! which cannot reach a Unix socket from its sandbox. Every connection must
//! start with a line `{"token": "<hex>"}` carrying the token Gloss wrote to
//! `bridge.json` at launch; anything else closes the connection.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpListener;
use tracing::{info, warn};

use super::handler::BridgeHandler;
use super::session::run_session;

/// What `bridge.json` holds, for the Safari handler to read.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct BridgeInfo {
    pub port: u16,
    pub token: String,
    pub protocol: u32,
}

#[derive(Deserialize)]
struct TokenLine {
    token: String,
}

/// A fresh 256-bit token as lower-case hex.
pub fn new_token() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

/// Binds an ephemeral port on 127.0.0.1 and returns the listener with the
/// port it got, so the caller can publish the port before serving.
pub async fn bind() -> Result<(TcpListener, u16)> {
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0);
    let listener = TcpListener::bind(addr).await.context("bind loopback listener")?;
    let port = listener.local_addr()?.port();
    Ok((listener, port))
}

/// Writes `info` to every path in `paths` with owner-only permissions.
/// Missing parent folders are created; a path that cannot be written is
/// logged and skipped, since the Safari copy lives in a folder that only
/// exists once the extension has run.
pub fn write_info(info: &BridgeInfo, paths: &[&Path]) -> Vec<WriteFailure> {
    let json = serde_json::to_string_pretty(info).unwrap_or_default();
    let mut failures = Vec::new();
    for path in paths {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let written = options.open(path).and_then(|mut f| {
            use std::io::Write;
            f.write_all(json.as_bytes())
        });
        if let Err(e) = written {
            warn!(path = %path.display(), error = %e, "could not write bridge info");
            failures.push(WriteFailure { path: path.to_path_buf(), error: e.to_string() });
        }
    }
    failures
}

/// One location `write_info` could not write, with the OS error in words.
#[derive(Debug, Clone)]
pub struct WriteFailure {
    pub path: std::path::PathBuf,
    pub error: String,
}

/// Serves connections on `listener` until the task is dropped.
pub async fn serve(handler: Arc<BridgeHandler>, listener: TcpListener, token: String) -> Result<()> {
    let token = Arc::new(token);
    info!(port = listener.local_addr()?.port(), "loopback bridge listening");
    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(s) => s,
            Err(e) => {
                warn!(error = %e, "loopback accept failed");
                continue;
            }
        };
        if !peer.ip().is_loopback() {
            warn!(%peer, "non-loopback bridge connection refused");
            continue;
        }
        let handler = handler.clone();
        let token = token.clone();
        tokio::spawn(async move {
            let (r, w) = stream.into_split();
            let mut reader = BufReader::new(r);
            let mut first = String::new();
            let read = tokio::time::timeout(Duration::from_secs(2), reader.read_line(&mut first)).await;
            let presented = match read {
                Ok(Ok(n)) if n > 0 => serde_json::from_str::<TokenLine>(first.trim()).ok().map(|t| t.token),
                _ => None,
            };
            if presented.as_deref() != Some(token.as_str()) {
                warn!("loopback connection without a valid token refused");
                return;
            }
            run_session(handler, reader, w, "loopback").await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::Engine;
    use crate::env::ShellEnv;
    use crate::paths::GlossPaths;

    fn test_env() -> ShellEnv {
        let mut env = ShellEnv::from_process();
        env.vars.insert("PATH".into(), "/nonexistent".into());
        env
    }
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpStream;

    #[tokio::test]
    async fn requires_the_token_first() {
        let dir = tempfile::tempdir().unwrap();
        let engine = Arc::new(Engine::open_with_env(GlossPaths::at(dir.path()), test_env()).unwrap());
        let handler = Arc::new(BridgeHandler::new(engine, "0.0.0-test"));
        let (listener, port) = bind().await.unwrap();
        let token = new_token();
        assert_eq!(token.len(), 64);
        let info = BridgeInfo { port, token: token.clone(), protocol: super::super::PROTOCOL };
        let file = dir.path().join("sub").join("bridge.json");
        let _ = write_info(&info, &[&file]);
        let back: BridgeInfo = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(back, info);
        let server = tokio::spawn(serve(handler, listener, token.clone()));

        // Wrong token: the connection is closed without a reply.
        let mut bad = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        bad.write_all(b"{\"token\":\"nope\"}\n{\"id\":\"1\",\"method\":\"hello\",\"params\":{\"protocol\":1}}\n").await.unwrap();
        let mut buf = String::new();
        let n = BufReader::new(bad).read_line(&mut buf).await.unwrap();
        assert_eq!(n, 0);

        // Right token: requests are answered.
        let good = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let (r, mut w) = good.into_split();
        w.write_all(format!("{{\"token\":\"{}\"}}\n{{\"id\":\"1\",\"method\":\"hello\",\"params\":{{\"protocol\":1}}}}\n", token).as_bytes())
            .await
            .unwrap();
        let mut lines = BufReader::new(r).lines();
        let reply: serde_json::Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(reply["result"]["protocol"], super::super::PROTOCOL);
        server.abort();
    }
}
