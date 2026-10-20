//! `gloss-bridge`: the native-messaging host browsers spawn for the Gloss
//! extension. It relays frames from the browser to the running Gloss app
//! over the Unix socket in the Gloss home folder, and lines from the app
//! back to the browser as frames. It stays alive while the port is open
//! even when Gloss is not running, so the extension can ask it to launch
//! Gloss and gets told when the app comes up.

mod frame;
mod launch;

use std::io::{self, BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

#[cfg(unix)]
use std::os::unix::net::UnixStream;

/// Where Gloss listens: `$GLOSS_HOME/bridge.sock`, else `~/.gloss/bridge.sock`.
/// The browser's environment is not the login shell's, so `GLOSS_HOME` set
/// only there is not seen here.
fn socket_path() -> PathBuf {
    if let Some(home) = std::env::var_os("GLOSS_HOME").filter(|h| !h.is_empty()) {
        return PathBuf::from(home).join("bridge.sock");
    }
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).unwrap_or_default();
    PathBuf::from(home).join(".gloss").join("bridge.sock")
}

/// How long the bridge keeps trying to reach Gloss after launching it.
const LAUNCH_WAIT: Duration = Duration::from_secs(30);

struct Bridge {
    socket: PathBuf,
    out: Mutex<io::Stdout>,
    /// The writing half of the connection to Gloss, when there is one,
    /// tagged with a generation number so the reader thread of an older
    /// connection never clears a newer one.
    #[cfg(unix)]
    conn: Mutex<Option<(u64, UnixStream)>>,
    #[cfg(not(unix))]
    conn: Mutex<Option<(u64, ())>>,
    generation: std::sync::atomic::AtomicU64,
}

impl Bridge {
    fn emit(&self, value: &Value) {
        let body = serde_json::to_vec(value).unwrap_or_default();
        let mut out = self.out.lock().unwrap();
        if frame::write_frame(&mut *out, &body).is_err() {
            std::process::exit(0);
        }
    }

    fn emit_line(&self, line: &str) {
        let mut out = self.out.lock().unwrap();
        if frame::write_frame(&mut *out, line.as_bytes()).is_err() {
            std::process::exit(0);
        }
    }

    fn connected(&self) -> bool {
        self.conn.lock().unwrap().is_some()
    }

    /// Connects to Gloss, unless a connection exists, and starts the thread
    /// that relays its lines to the browser. The check and the connect
    /// happen under one lock so two threads never open two connections.
    /// Returns false when nothing is listening.
    #[cfg(unix)]
    fn connect(self: &Arc<Self>) -> bool {
        let mut guard = self.conn.lock().unwrap();
        if guard.is_some() {
            return true;
        }
        let Ok(stream) = UnixStream::connect(&self.socket) else { return false };
        let Ok(reader) = stream.try_clone() else { return false };
        let generation = self.generation.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        *guard = Some((generation, stream));
        drop(guard);
        self.emit(&json!({ "event": "app_state", "data": { "running": true } }));
        let me = Arc::clone(self);
        thread::spawn(move || {
            let mut lines = BufReader::new(reader).lines();
            while let Some(Ok(line)) = lines.next() {
                if !line.trim().is_empty() {
                    me.emit_line(&line);
                }
            }
            let mut guard = me.conn.lock().unwrap();
            let mine = matches!(&*guard, Some((g, _)) if *g == generation);
            if mine {
                *guard = None;
                drop(guard);
                me.emit(&json!({ "event": "app_state", "data": { "running": false } }));
            }
        });
        true
    }

    #[cfg(not(unix))]
    fn connect(self: &Arc<Self>) -> bool {
        false
    }

    /// Sends one request line to Gloss; false when the connection is gone.
    fn send(&self, line: &str) -> bool {
        #[cfg(unix)]
        {
            let mut guard = self.conn.lock().unwrap();
            let Some((_, stream)) = guard.as_mut() else { return false };
            let ok = stream.write_all(line.as_bytes()).and_then(|_| stream.write_all(b"\n")).and_then(|_| stream.flush()).is_ok();
            if !ok {
                *guard = None;
            }
            ok
        }
        #[cfg(not(unix))]
        {
            let _ = line;
            false
        }
    }

    /// Handles a frame from the browser: relays it when Gloss is up, else
    /// launches Gloss on request and reports that the app is not running.
    fn handle(self: &Arc<Self>, body: &[u8]) {
        let value: Value = match serde_json::from_slice(body) {
            Ok(v) => v,
            Err(e) => {
                self.emit(&json!({ "id": "", "error": { "code": "invalid", "message": format!("malformed frame: {}", e) } }));
                return;
            }
        };
        let id = value.get("id").cloned().unwrap_or(Value::String(String::new()));
        let method = value.get("method").and_then(|m| m.as_str()).unwrap_or("");
        self.connect();
        if self.connected() && method != "launchApp" {
            let line = serde_json::to_string(&value).unwrap_or_default();
            if self.send(&line) {
                return;
            }
        }
        if method == "launchApp" {
            let url = value
                .pointer("/params/urlKey")
                .and_then(|k| k.as_str())
                .map(|k| format!("gloss://pages/{}", percent_encode(k)))
                .unwrap_or_else(|| "gloss://open".to_string());
            let launched = launch::open_url(&url).is_ok();
            self.emit(&json!({ "id": id, "result": { "launched": launched, "running": self.connected() } }));
            if launched && !self.connected() {
                let me = Arc::clone(self);
                thread::spawn(move || {
                    let deadline = Instant::now() + LAUNCH_WAIT;
                    while Instant::now() < deadline && !me.connected() {
                        thread::sleep(Duration::from_millis(500));
                        me.connect();
                    }
                });
            }
            return;
        }
        let message = if cfg!(unix) {
            "Gloss is not running"
        } else {
            "the Gloss bridge does not support this platform yet"
        };
        self.emit(&json!({ "id": id, "error": { "code": "app_not_running", "message": message } }));
    }
}

/// Percent-encodes everything but unreserved characters, for a URL path segment.
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn main() {
    // The browser passes its own identification in argv (an origin for
    // Chrome, a manifest path and extension id for Firefox); it is not needed.
    let bridge = Arc::new(Bridge {
        socket: socket_path(),
        out: Mutex::new(io::stdout()),
        conn: Mutex::new(None),
        generation: std::sync::atomic::AtomicU64::new(0),
    });
    bridge.connect();
    let mut input = io::stdin().lock();
    loop {
        match frame::read_frame(&mut input) {
            Ok(Some(body)) => bridge.handle(&body),
            Ok(None) => break,
            Err(e) => {
                eprintln!("gloss-bridge: {}", e);
                break;
            }
        }
    }
}
