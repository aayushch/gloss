//! Runs one agent process and hands its stdout to the caller line by line.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

/// A fully resolved command line: the program path, its arguments, extra
/// environment variables layered over the shell environment, the cwd, and
/// optional bytes to write to the process's stdin before closing it.
#[derive(Clone, Debug)]
pub struct CommandSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: PathBuf,
    pub stdin: Option<Vec<u8>>,
}

/// Why and how the process ended.
#[derive(Clone, Debug, Default)]
pub struct ProcessOutcome {
    pub exit_code: Option<i32>,
    /// Last stderr lines, newest last.
    pub stderr_tail: String,
    /// The process was killed because it printed nothing for the idle timeout.
    pub idle_timed_out: bool,
    /// The process was killed because the caller cancelled.
    pub cancelled: bool,
}

impl ProcessOutcome {
    pub fn succeeded(&self) -> bool {
        !self.cancelled && !self.idle_timed_out && self.exit_code == Some(0)
    }

    /// One-line description for an error message.
    pub fn describe(&self) -> String {
        let mut msg = if self.cancelled {
            "Cancelled".to_string()
        } else if self.idle_timed_out {
            "The agent produced no output for too long and was stopped".to_string()
        } else {
            match self.exit_code {
                Some(code) => format!("The agent exited with code {}", code),
                None => "The agent was terminated by a signal".to_string(),
            }
        };
        if !self.stderr_tail.trim().is_empty() {
            msg.push_str(": ");
            msg.push_str(self.stderr_tail.trim());
        }
        msg
    }
}

/// Lines longer than this are dropped rather than buffered; a single JSON
/// line carrying a large tool result can still be many megabytes.
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;
const STDERR_KEEP_LINES: usize = 50;

/// Spawn the process and call `on_line` for every stdout line until it exits,
/// is cancelled, or stays silent longer than `idle_timeout`.
pub async fn run_lines<F>(
    spec: &CommandSpec,
    base_env: &HashMap<String, String>,
    idle_timeout: Duration,
    cancel: CancellationToken,
    mut on_line: F,
) -> std::io::Result<ProcessOutcome>
where
    F: FnMut(&str),
{
    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args)
        .current_dir(&spec.cwd)
        .env_clear()
        .envs(base_env)
        .envs(spec.env.iter().cloned())
        .stdin(if spec.stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd.spawn()?;
    if let (Some(bytes), Some(mut stdin)) = (spec.stdin.clone(), child.stdin.take()) {
        // Written on its own task so a large payload cannot deadlock against
        // a child that starts producing output before it has read it all.
        tokio::spawn(async move {
            let _ = stdin.write_all(&bytes).await;
            let _ = stdin.shutdown().await;
        });
    }
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    let stderr_lines: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
    let stderr_sink = stderr_lines.clone();
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let text = String::from_utf8_lossy(&buf).trim_end().to_string();
                    if text.is_empty() {
                        continue;
                    }
                    let mut q = stderr_sink.lock().unwrap();
                    if q.len() >= STDERR_KEEP_LINES {
                        q.pop_front();
                    }
                    q.push_back(text);
                }
            }
        }
    });

    let mut outcome = ProcessOutcome::default();
    let mut reader = BufReader::with_capacity(64 * 1024, stdout);
    let mut buf: Vec<u8> = Vec::new();
    let mut over_limit = false;

    loop {
        buf.clear();
        let read = tokio::select! {
            _ = cancel.cancelled() => {
                outcome.cancelled = true;
                terminate(&mut child).await;
                break;
            }
            res = tokio::time::timeout(idle_timeout, read_line_bounded(&mut reader, &mut buf, &mut over_limit)) => res,
        };
        match read {
            Err(_elapsed) => {
                outcome.idle_timed_out = true;
                terminate(&mut child).await;
                break;
            }
            Ok(Ok(0)) => break,
            Ok(Ok(_)) => {
                if over_limit {
                    over_limit = false;
                    continue;
                }
                let line = String::from_utf8_lossy(&buf);
                let line = line.trim_end_matches(['\n', '\r']);
                if !line.is_empty() {
                    on_line(line);
                }
            }
            Ok(Err(_)) => break,
        }
    }

    let status = child.wait().await?;
    outcome.exit_code = status.code();
    let _ = tokio::time::timeout(Duration::from_secs(2), stderr_task).await;
    let tail: Vec<String> = stderr_lines.lock().unwrap().iter().cloned().collect();
    outcome.stderr_tail = tail.join("\n");
    Ok(outcome)
}

/// Read one line, discarding its bytes once it exceeds `MAX_LINE_BYTES`. Returns
/// the number of bytes consumed (0 at EOF) and sets `over_limit` when the line
/// was dropped.
async fn read_line_bounded<R: AsyncBufReadExt + Unpin>(
    reader: &mut R,
    buf: &mut Vec<u8>,
    over_limit: &mut bool,
) -> std::io::Result<usize> {
    let mut total = 0usize;
    loop {
        let chunk = reader.fill_buf().await?;
        if chunk.is_empty() {
            return Ok(total);
        }
        let (take, done) = match chunk.iter().position(|b| *b == b'\n') {
            Some(i) => (i + 1, true),
            None => (chunk.len(), false),
        };
        if !*over_limit {
            if buf.len() + take > MAX_LINE_BYTES {
                *over_limit = true;
                buf.clear();
            } else {
                buf.extend_from_slice(&chunk[..take]);
            }
        }
        reader.consume(take);
        total += take;
        if done {
            return Ok(total);
        }
    }
}

/// Ask the child to stop (SIGTERM), then force it after a grace period.
async fn terminate(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // SAFETY: plain libc call with a pid this process owns.
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGTERM);
        }
        if tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .is_ok()
        {
            return;
        }
    }
    let _ = child.start_kill();
}

/// Read all of a reader into a string; used by tests and the CLI.
pub async fn read_all<R: AsyncReadExt + Unpin>(mut r: R) -> String {
    let mut s = String::new();
    let _ = r.read_to_string(&mut s).await;
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(program: &str, args: &[&str]) -> CommandSpec {
        CommandSpec {
            program: PathBuf::from(program),
            args: args.iter().map(|a| a.to_string()).collect(),
            env: vec![],
            cwd: std::env::temp_dir(),
            stdin: None,
        }
    }

    /// `script` run by the platform's shell: `sh -c` or `cmd /C`.
    fn sh(script: &str) -> CommandSpec {
        if cfg!(windows) {
            spec("cmd", &["/C", script])
        } else {
            spec("/bin/sh", &["-c", script])
        }
    }

    /// A process that stays silent for 30 seconds. On Windows it is a direct
    /// program rather than a shell child, because killing cmd.exe leaves its
    /// child alive and holding the stdout pipe.
    fn silent_for_30s() -> CommandSpec {
        if cfg!(windows) {
            spec("ping", &["-n", "31", "127.0.0.1"])
        } else {
            sh("sleep 30")
        }
    }

    #[tokio::test]
    async fn stdin_bytes_reach_the_child() {
        // `sort` on Windows and `cat` elsewhere both echo a single stdin line.
        let mut spec = if cfg!(windows) { spec("sort", &[]) } else { sh("cat") };
        spec.stdin = Some(b"from stdin\n".to_vec());
        let mut lines = Vec::new();
        let out = run_lines(&spec, &HashMap::new(), Duration::from_secs(5), CancellationToken::new(), |l| lines.push(l.to_string()))
            .await
            .unwrap();
        assert!(out.succeeded());
        assert_eq!(lines, vec!["from stdin"]);
    }

    #[tokio::test]
    async fn collects_lines_and_exit_code() {
        let mut lines = Vec::new();
        let script = if cfg!(windows) { "echo a& echo b& echo err 1>&2& exit 3" } else { "printf 'a\\nb\\n'; echo err >&2; exit 3" };
        let out = run_lines(
            &sh(script),
            &std::env::vars().collect(),
            Duration::from_secs(5),
            CancellationToken::new(),
            |l| lines.push(l.to_string()),
        )
        .await
        .unwrap();
        assert_eq!(lines, vec!["a", "b"]);
        assert_eq!(out.exit_code, Some(3));
        assert_eq!(out.stderr_tail, "err");
        assert!(!out.succeeded());
    }

    #[tokio::test]
    async fn idle_timeout_kills_silent_process() {
        let out = run_lines(
            &silent_for_30s(),
            &std::env::vars().collect(),
            Duration::from_millis(200),
            CancellationToken::new(),
            |_| {},
        )
        .await
        .unwrap();
        assert!(out.idle_timed_out);
        assert!(!out.succeeded());
    }

    #[tokio::test]
    async fn cancel_stops_process() {
        let token = CancellationToken::new();
        let t2 = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            t2.cancel();
        });
        let out = run_lines(
            &silent_for_30s(),
            &std::env::vars().collect(),
            Duration::from_secs(10),
            token,
            |_| {},
        )
        .await
        .unwrap();
        assert!(out.cancelled);
    }
}
