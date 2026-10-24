// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

//! Unix-socket listener for the `gloss-bridge` native-messaging host.
//! The socket file is readable by its owner only, and every connection's
//! peer must run as the same user as Gloss.

use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result};
use tokio::io::BufReader;
use tokio::net::UnixListener;
use tracing::{info, warn};

use super::handler::BridgeHandler;
use super::session::run_session;

/// Binds `path` and serves connections until the task is dropped. A stale
/// socket file from an earlier run is removed first.
pub async fn serve(handler: Arc<BridgeHandler>, path: &Path) -> Result<()> {
    // Unix socket paths are limited to about 100 bytes on macOS and Linux.
    if path.as_os_str().len() > 100 {
        anyhow::bail!(
            "socket path {} is too long for a Unix socket; set GLOSS_HOME to a shorter path",
            path.display()
        );
    }
    if path.exists() {
        std::fs::remove_file(path).with_context(|| format!("remove stale {}", path.display()))?;
    }
    let listener = UnixListener::bind(path).with_context(|| format!("bind {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    info!(path = %path.display(), "bridge socket listening");
    loop {
        let (stream, _) = match listener.accept().await {
            Ok(s) => s,
            Err(e) => {
                warn!(error = %e, "bridge socket accept failed");
                continue;
            }
        };
        let same_user = stream
            .peer_cred()
            .map(|c| c.uid() == unsafe { libc::getuid() })
            .unwrap_or(false);
        if !same_user {
            warn!("bridge connection from another user refused");
            continue;
        }
        let handler = handler.clone();
        tokio::spawn(async move {
            let (r, w) = stream.into_split();
            run_session(handler, BufReader::new(r), w, "native").await;
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
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
    use tokio::net::UnixStream;

    #[tokio::test]
    async fn answers_requests_over_the_socket() {
        let dir = tempfile::tempdir().unwrap();
        let paths = GlossPaths::at(dir.path());
        let engine = Arc::new(Engine::open_with_env(paths.clone(), test_env()).unwrap());
        let handler = Arc::new(BridgeHandler::new(engine.clone(), "0.0.0-test"));
        let sock = paths.bridge_sock.clone();
        let server = tokio::spawn(async move { serve(handler, &sock).await });
        for _ in 0..50 {
            if paths.bridge_sock.exists() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let stream = UnixStream::connect(&paths.bridge_sock).await.unwrap();
        let (r, mut w) = stream.into_split();
        let mut lines = BufReader::new(r).lines();
        w.write_all(b"{\"id\":\"1\",\"method\":\"hello\",\"params\":{\"protocol\":1,\"browser\":\"test\",\"extensionVersion\":\"0\"}}\n")
            .await
            .unwrap();
        let reply: serde_json::Value =
            serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(reply["id"], "1");
        assert_eq!(reply["result"]["protocol"], super::super::PROTOCOL);
        w.write_all(b"{\"id\":\"2\",\"method\":\"getPage\",\"params\":{\"url\":\"https://example.com/a?utm_source=x\"}}\n")
            .await
            .unwrap();
        let reply: serde_json::Value =
            serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(reply["result"]["urlKey"], "https://example.com/a");
        assert!(reply["result"]["page"].is_null());
        server.abort();
    }
}
