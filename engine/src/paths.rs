//! Locations of everything Gloss writes to disk.

use std::path::{Path, PathBuf};

/// All Gloss state lives under one home directory: `$GLOSS_HOME` when set,
/// otherwise `~/.gloss`.
#[derive(Clone, Debug)]
pub struct GlossPaths {
    pub home: PathBuf,
    /// SQLite database with conversations, turns, clarifications and settings.
    pub db: PathBuf,
    /// Working directory handed to every agent process. It holds nothing but
    /// attachments; its purpose is to give the agents a cwd that is not one of
    /// the user's projects, so their own session history for Gloss stays separate.
    pub workspace: PathBuf,
    /// Files the user attaches to prompts, one directory per attachment.
    /// Kept inside the workspace so agents that read files by path can reach
    /// them without any extra directory being allowed.
    pub attachments: PathBuf,
    /// Pi stores its session files wherever `--session-dir` points; Gloss
    /// keeps them here instead of in `~/.pi`.
    pub pi_sessions: PathBuf,
    /// Artifacts the user opens in the browser are written here first, one
    /// directory per file, so the system can open them by path.
    pub artifacts: PathBuf,
    pub logs: PathBuf,
    /// Unix socket the `gloss-bridge` native-messaging host connects to.
    pub bridge_sock: PathBuf,
    /// Port and token of the loopback listener, for the Safari extension.
    pub bridge_json: PathBuf,
}

impl GlossPaths {
    /// Resolve from the environment: `$GLOSS_HOME`, else `~/.gloss`.
    pub fn from_env() -> GlossPaths {
        let home = std::env::var_os("GLOSS_HOME")
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| {
                dirs::home_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join(".gloss")
            });
        GlossPaths::at(&home)
    }

    pub fn at(home: &Path) -> GlossPaths {
        GlossPaths {
            home: home.to_path_buf(),
            db: home.join("gloss.db"),
            workspace: home.join("workspace"),
            attachments: home.join("workspace").join("attachments"),
            pi_sessions: home.join("pi-sessions"),
            artifacts: home.join("artifacts"),
            logs: home.join("logs"),
            bridge_sock: home.join("bridge.sock"),
            bridge_json: home.join("bridge.json"),
        }
    }

    /// Create every directory Gloss needs. Safe to call repeatedly.
    pub fn ensure(&self) -> std::io::Result<()> {
        for dir in [&self.home, &self.workspace, &self.attachments, &self.pi_sessions, &self.artifacts, &self.logs] {
            std::fs::create_dir_all(dir)?;
        }
        Ok(())
    }
}
