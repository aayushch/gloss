//! Gloss engine.
//!
//! Drives installed CLI coding agents (Claude Code, Codex, Gemini CLI, Pi,
//! Cursor Agent) in their non-interactive modes to hold chat conversations,
//! and stores those conversations in SQLite under `~/.gloss`.
//!
//! The Tauri shell links this crate directly; `src/bin/gloss_engine.rs` exposes
//! the same functionality as a command line tool for headless testing.

pub mod agents;
pub mod attach;
pub mod engine;
pub mod env;
pub mod paths;
pub mod prompt;
pub mod store;
pub mod types;

pub use engine::Engine;
pub use env::ShellEnv;
pub use paths::GlossPaths;
pub use types::*;
