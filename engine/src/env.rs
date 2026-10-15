//! The environment agent processes run in.
//!
//! A desktop app launched from Finder or a launcher inherits a minimal
//! environment: no Homebrew or npm directories on PATH and none of the API
//! keys the user exports in their shell profile. Agents need both, so the
//! environment is captured once from the user's login shell and reused for
//! detection and spawning.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Directories appended to PATH when they exist and are not already present.
/// They cover the usual install locations for the agent CLIs.
#[cfg(not(windows))]
const EXTRA_PATH_DIRS: &[&str] = &[
    "~/.local/bin",
    "~/.cargo/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "~/.npm-global/bin",
    "~/Library/pnpm/bin",
    "~/.bun/bin",
];

/// Windows installs: Claude Code's native installer uses `~/.local/bin`, npm
/// global shims live under `AppData/Roaming/npm`.
#[cfg(windows)]
const EXTRA_PATH_DIRS: &[&str] = &[
    "~/.local/bin",
    "~/.cargo/bin",
    "~/AppData/Roaming/npm",
    "~/AppData/Local/pnpm",
    "~/.bun/bin",
];

/// Extensions tried after a bare command name on Windows when PATHEXT is unset.
#[cfg(windows)]
const DEFAULT_PATHEXT: &str = ".EXE;.CMD;.BAT;.COM";

#[derive(Clone, Debug)]
pub struct ShellEnv {
    pub vars: HashMap<String, String>,
}

impl ShellEnv {
    /// Capture the login shell environment, merged over the current process
    /// environment, with the extra PATH directories appended.
    pub fn capture() -> ShellEnv {
        let mut vars: HashMap<String, String> = std::env::vars().collect();
        if let Some(shell_vars) = login_shell_env(Duration::from_secs(5)) {
            vars.extend(shell_vars);
        }
        let mut env = ShellEnv { vars };
        env.augment_path();
        env
    }

    /// The current process environment only, with the extra PATH directories.
    /// Used by tests and when a shell probe is not wanted.
    pub fn from_process() -> ShellEnv {
        let mut env = ShellEnv {
            vars: std::env::vars().collect(),
        };
        env.augment_path();
        env
    }

    pub fn path(&self) -> String {
        self.vars.get("PATH").cloned().unwrap_or_default()
    }

    /// PATH entries in order, split with the platform's separator.
    pub fn path_dirs(&self) -> Vec<PathBuf> {
        std::env::split_paths(&self.path())
            .filter(|p| !p.as_os_str().is_empty())
            .collect()
    }

    fn augment_path(&mut self) {
        let mut parts = self.path_dirs();
        for dir in EXTRA_PATH_DIRS {
            let expanded = expand_home(dir);
            if expanded.is_dir() && !parts.iter().any(|p| p == &expanded) {
                parts.push(expanded);
            }
        }
        let joined = std::env::join_paths(&parts)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| self.path());
        self.vars.insert("PATH".to_string(), joined);
    }

    /// Find an executable by name on this environment's PATH. Absolute paths
    /// are returned as-is when they point at an executable file.
    pub fn path_lookup(&self, name: &str) -> Option<PathBuf> {
        let candidate = Path::new(name);
        if candidate.is_absolute() {
            return is_executable(candidate).then(|| candidate.to_path_buf());
        }
        self.path_lookup_all(name).into_iter().next()
    }

    /// Every executable on PATH with this name, in PATH order. Used when the
    /// first hit cannot be trusted (Cursor installs a binary called `agent`).
    pub fn path_lookup_all(&self, name: &str) -> Vec<PathBuf> {
        let names = self.candidate_names(name);
        self.path_dirs()
            .iter()
            .flat_map(|d| names.iter().map(move |n| d.join(n)))
            .filter(|p| is_executable(p))
            .collect()
    }

    /// File names a bare command can resolve to. On Windows a command typed as
    /// `gemini` is `gemini.cmd` (npm shim) or `gemini.exe` on disk, so every
    /// PATHEXT extension is tried after the bare name.
    #[cfg(windows)]
    fn candidate_names(&self, name: &str) -> Vec<String> {
        if Path::new(name).extension().is_some() {
            return vec![name.to_string()];
        }
        let pathext = self
            .vars
            .get("PATHEXT")
            .filter(|s| !s.is_empty())
            .map(String::as_str)
            .unwrap_or(DEFAULT_PATHEXT)
            .to_string();
        let mut names = vec![name.to_string()];
        names.extend(
            pathext
                .split(';')
                .filter(|e| !e.is_empty())
                .map(|e| format!("{}{}", name, e.to_lowercase())),
        );
        names
    }

    #[cfg(not(windows))]
    fn candidate_names(&self, name: &str) -> Vec<String> {
        vec![name.to_string()]
    }
}

fn is_executable(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        p.is_file()
            && std::fs::metadata(p)
                .map(|m| m.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        p.is_file()
    }
}

pub fn expand_home(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(p)
}

/// Run the user's shell as an interactive login shell and read its environment
/// (`env -0`, NUL separated so multi-line values survive). Returns None when
/// the shell is missing, fails, or exceeds the timeout.
fn login_shell_env(timeout: Duration) -> Option<HashMap<String, String>> {
    // Windows has no login shell profile to source; the process environment
    // already carries the user's PATH and variables.
    if cfg!(windows) {
        return None;
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    // Interactive login first so both profile and rc files run; plain login as
    // a fallback for shells whose interactive mode misbehaves without a TTY.
    for flags in ["-ilc", "-lc"] {
        if let Some(out) = run_capture(&shell, &[flags, "env -0"], None, timeout) {
            let parsed = parse_env_nul(&out);
            if parsed.contains_key("PATH") {
                return Some(parsed);
            }
        }
    }
    None
}

fn parse_env_nul(out: &[u8]) -> HashMap<String, String> {
    out.split(|b| *b == 0)
        .filter(|entry| !entry.is_empty())
        .filter_map(|entry| {
            let s = String::from_utf8_lossy(entry);
            let (k, v) = s.split_once('=')?;
            // Shell functions exported by bash appear as "BASH_FUNC_x%%" and
            // are not useful to child processes.
            if k.is_empty() || k.contains('%') {
                return None;
            }
            Some((k.to_string(), v.to_string()))
        })
        .collect()
}

/// Run a program with a timeout and return its stdout on exit code 0. The
/// child is killed when the timeout elapses.
pub fn run_capture(
    program: &str,
    args: &[&str],
    env: Option<&HashMap<String, String>>,
    timeout: Duration,
) -> Option<Vec<u8>> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(env) = env {
        cmd.env_clear().envs(env);
    }
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    // Read on a thread so a chatty child cannot block on a full pipe while
    // the parent waits for it to exit.
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = std::io::Read::read_to_end(&mut stdout, &mut buf);
        buf
    });
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let out = reader.join().ok()?;
                return status.success().then_some(out);
            }
            Ok(None) if start.elapsed() < timeout => {
                std::thread::sleep(Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nul_separated_env() {
        let raw = b"PATH=/a:/b\0MULTI=line1\nline2\0BASH_FUNC_f%%=() { :; }\0=bad\0";
        let m = parse_env_nul(raw);
        assert_eq!(m.get("PATH").unwrap(), "/a:/b");
        assert_eq!(m.get("MULTI").unwrap(), "line1\nline2");
        assert_eq!(m.len(), 2);
    }

    #[test]
    fn finds_executables_on_path() {
        let env = ShellEnv::from_process();
        let shell = if cfg!(windows) { "cmd" } else { "sh" };
        assert!(env.path_lookup(shell).is_some());
        assert!(env.path_lookup("definitely-not-a-binary-xyz").is_none());
    }

    #[test]
    fn augmented_path_keeps_order_and_adds_nothing_twice() {
        let env = ShellEnv::from_process();
        let dirs = env.path_dirs();
        // The user's own PATH may repeat entries; the appended extra dirs
        // must not add a second copy of anything already present.
        let original: Vec<PathBuf> = std::env::split_paths(&std::env::var("PATH").unwrap_or_default())
            .filter(|p| !p.as_os_str().is_empty())
            .collect();
        for extra in EXTRA_PATH_DIRS {
            let dir = expand_home(extra);
            let appended = dirs[original.len()..].iter().filter(|d| **d == dir).count();
            assert!(appended <= 1, "{} appended more than once", dir.display());
            assert!(!(appended == 1 && original.contains(&dir)), "{} appended although on PATH", dir.display());
        }
        // Original entries come first, so the user's own PATH order wins.
        assert!(dirs.starts_with(&original));
    }
}
