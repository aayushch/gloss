// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

//! The bridge: how browser extensions talk to a running Gloss.
//!
//! Every transport carries the same protocol, one JSON object per line
//! (`protocol.rs`), handled by `BridgeHandler` (`handler.rs`) inside a
//! per-connection loop (`session.rs`). Two listeners exist: a Unix socket
//! that the `gloss-bridge` native-messaging host connects to on behalf of
//! Chrome-family browsers and Firefox (`unix.rs`), and a token-guarded TCP
//! listener on 127.0.0.1 that the Safari extension's native handler uses
//! (`loopback.rs`).

pub mod handler;
pub mod loopback;
pub mod protocol;
pub mod session;
#[cfg(unix)]
pub mod unix;

pub use handler::{BridgeHandler, SessionInfo};
pub use protocol::{BridgeError, ErrorCode, Outgoing, Request};

/// Version of the wire protocol this build speaks.
pub const PROTOCOL: u32 = 1;
/// Oldest extension protocol this build still accepts.
pub const MIN_PROTOCOL: u32 = 1;

/// Largest line the bridge writes. Chrome refuses native-messaging frames
/// above 1 MiB, so every reply and event stays under it.
pub const MAX_LINE_BYTES: usize = 900 * 1024;
