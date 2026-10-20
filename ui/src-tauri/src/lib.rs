//! Tauri shell for Gloss. Each command is a thin wrapper over the engine
//! crate; turn progress reaches the webview as the `turn-event` event. The
//! shell also runs the browser bridge, keeps the app alive in the menu bar
//! when the window closes, and registers the `gloss://` link scheme.

mod native_host;
mod safari;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use gloss_engine::bridge::{self, BridgeHandler, SessionInfo};
use gloss_engine::engine::EventSink;
use gloss_engine::*;
use serde::Serialize;
use tauri::ipc::{Request, Response};
use tauri::menu::MenuBuilder;
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

type Eng = Arc<Engine>;

/// App Group shared with the Safari extension, which reads `bridge.json`
/// from the group container because its sandbox cannot see `~/.gloss`.
pub const APP_GROUP: &str = "BG78RT6D5Z.sh.aay.gloss";

/// State of the browser bridge kept for the Settings sheet and for turning
/// the Safari listener on and off.
struct BridgeStatus {
    handler: Arc<BridgeHandler>,
    bridge_path: PathBuf,
    loopback: Mutex<Option<(u16, tauri::async_runtime::JoinHandle<()>)>>,
    /// Why the port and token could not be written where the Safari
    /// extension reads them, when that failed; None while it worked.
    safari_bridge_error: Mutex<Option<String>>,
}

/// What the Settings sheet shows about the extension.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct ExtensionStatus {
    bridge_path: String,
    translocated: bool,
    browsers: Vec<native_host::BrowserRegistration>,
    sessions: Vec<SessionInfo>,
    xpi_bundled: bool,
    chrome_store_url: String,
    firefox_xpi_path: Option<String>,
    safari_available: bool,
    loopback_port: Option<u16>,
    /// The file the Safari extension reads the port and token from, when Gloss could write it.
    safari_bridge_file: Option<String>,
    /// Why that file could not be written, when it could not.
    safari_bridge_error: Option<String>,
}

/// Whether the Safari extension is turned on, as Safari reports it.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct SafariExtensionState {
    enabled: bool,
}

/// Errors cross to the webview as plain strings.
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[tauri::command]
fn list_agents(engine: State<'_, Eng>) -> Vec<AgentInfo> {
    engine.list_agents()
}

#[tauri::command]
fn list_models(engine: State<'_, Eng>, agent: AgentId) -> Vec<ModelInfo> {
    engine.list_models(agent)
}

#[tauri::command]
fn get_settings(engine: State<'_, Eng>) -> Result<Settings, String> {
    engine.settings().map_err(err)
}

#[tauri::command]
fn update_settings(app: AppHandle, engine: State<'_, Eng>, settings: Settings) -> Result<Settings, String> {
    let saved = engine.update_settings(settings).map_err(err)?;
    apply_safari_bridge(&app, saved.safari_bridge);
    Ok(saved)
}

#[tauri::command]
fn list_pages(engine: State<'_, Eng>, limit: Option<usize>) -> Result<Vec<Page>, String> {
    engine.list_pages(limit.unwrap_or(200)).map_err(err)
}

#[tauri::command]
fn get_page(engine: State<'_, Eng>, url_key: String) -> Result<Option<PageDetail>, String> {
    engine.get_page(&url_key).map_err(err)
}

#[tauri::command]
fn delete_page(engine: State<'_, Eng>, url_key: String) -> Result<(), String> {
    engine.delete_page(&url_key).map_err(err)
}

#[tauri::command]
fn delete_clarification(engine: State<'_, Eng>, id: String) -> Result<(), String> {
    engine.delete_clarification(&id).map_err(err)
}

/// Everything the Settings sheet shows about the browser extension.
#[tauri::command]
fn extension_status(app: AppHandle, status: State<'_, Arc<BridgeStatus>>) -> ExtensionStatus {
    let xpi = firefox_xpi_path(&app);
    // Each lock is taken and released on its own line: a guard created
    // inside the struct literal would live until the literal is complete,
    // and a second lock of the same mutex there would never return.
    let loopback_port = status.loopback.lock().unwrap().as_ref().map(|(port, _)| *port);
    let safari_bridge_error = status.safari_bridge_error.lock().unwrap().clone();
    let safari_bridge_file = match (loopback_port, &safari_bridge_error) {
        (Some(_), None) => app_group_dir().map(|d| d.join("bridge.json").to_string_lossy().to_string()),
        _ => None,
    };
    ExtensionStatus {
        bridge_path: status.bridge_path.to_string_lossy().to_string(),
        translocated: native_host::translocated(&status.bridge_path),
        browsers: native_host::status(&status.bridge_path),
        sessions: status.handler.sessions(),
        xpi_bundled: xpi.is_some(),
        chrome_store_url: format!("{}{}", native_host::CHROME_STORE_URL, native_host::CHROME_EXTENSION_ID.trim()),
        firefox_xpi_path: xpi.map(|p| p.to_string_lossy().to_string()),
        safari_available: safari_appex_path().is_some(),
        loopback_port,
        safari_bridge_file,
        safari_bridge_error,
    }
}

/// Asks Safari whether the bundled extension is enabled. Runs off the main
/// thread because Safari answers on the main queue.
#[tauri::command]
async fn safari_extension_state() -> Result<SafariExtensionState, String> {
    #[cfg(target_os = "macos")]
    {
        if safari_appex_path().is_none() {
            return Err("this build of Gloss does not include the Safari extension".into());
        }
        tauri::async_runtime::spawn_blocking(safari::extension_enabled)
            .await
            .map_err(err)?
            .map(|enabled| SafariExtensionState { enabled })
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Safari extensions exist only on macOS".into())
    }
}

#[tauri::command]
fn register_native_hosts(status: State<'_, Arc<BridgeStatus>>) -> Vec<native_host::BrowserRegistration> {
    native_host::register_all(&status.bridge_path)
}

#[tauri::command]
fn unregister_native_hosts() -> Vec<native_host::BrowserRegistration> {
    native_host::unregister_all()
}

/// Opens a web URL in the default browser.
#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only web links can be opened".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(err)
}

/// Hands the bundled Firefox add-on to Firefox, which asks to install it.
/// Firefox is found by its usual locations on each platform, so the file
/// never falls to whatever program owns `.xpi` files.
#[tauri::command]
fn install_firefox_extension(app: AppHandle) -> Result<(), String> {
    let path = firefox_xpi_path(&app).ok_or("this build of Gloss does not include the Firefox add-on")?;
    let xpi = path.to_string_lossy().to_string();
    #[cfg(target_os = "macos")]
    {
        app.opener().open_path(xpi, Some("Firefox")).map_err(err)
    }
    #[cfg(target_os = "windows")]
    {
        let candidates = ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]
            .iter()
            .filter_map(|v| std::env::var_os(v))
            .map(|base| PathBuf::from(base).join("Mozilla Firefox").join("firefox.exe"))
            .chain(std::iter::once(PathBuf::from("firefox.exe")));
        for exe in candidates {
            if std::process::Command::new(&exe).arg(&xpi).spawn().is_ok() {
                return Ok(());
            }
        }
        Err("Firefox was not found; open the add-on file in Firefox yourself".into())
    }
    #[cfg(target_os = "linux")]
    {
        for exe in ["firefox", "firefox-esr", "flatpak"] {
            let mut cmd = std::process::Command::new(exe);
            if exe == "flatpak" {
                cmd.args(["run", "org.mozilla.firefox"]);
            }
            if cmd.arg(&xpi).spawn().is_ok() {
                return Ok(());
            }
        }
        Err("Firefox was not found; open the add-on file in Firefox yourself".into())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        app.opener().open_path(xpi, None::<&str>).map_err(err)
    }
}

/// Opens Safari's Settings › Extensions pane at the Gloss extension so the
/// user can turn it on. Falls back to bringing Safari forward when Safari
/// does not know the extension yet (it learns of it the first time Gloss.app
/// is launched from a fixed location).
#[tauri::command]
async fn open_safari_extensions(app: AppHandle) -> Result<(), String> {
    if safari_appex_path().is_none() {
        return Err("this build of Gloss does not include the Safari extension".into());
    }
    #[cfg(target_os = "macos")]
    {
        match tauri::async_runtime::spawn_blocking(safari::show_preferences).await.map_err(err)? {
            Ok(()) => return Ok(()),
            Err(reason) => tracing::warn!(reason, "Safari could not show the extension's settings"),
        }
    }
    app.opener().open_path("/Applications/Safari.app", None::<&str>).map_err(err)
}

/// The bundled Firefox add-on, when this build includes a real one. A
/// placeholder file of size zero stands in when it was not downloaded.
fn firefox_xpi_path(app: &AppHandle) -> Option<PathBuf> {
    let path = app.path().resolve("gloss.xpi", tauri::path::BaseDirectory::Resource).ok()?;
    let size = std::fs::metadata(&path).ok()?.len();
    (size > 0).then_some(path)
}

/// The Safari extension inside this app bundle, when it was built in.
fn safari_appex_path() -> Option<PathBuf> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    let plugins = exe.parent()?.parent()?.join("PlugIns").join("Gloss Extension.appex");
    plugins.is_dir().then_some(plugins)
}

/// Where the `gloss-bridge` program sits: next to the app's own binary,
/// both in a bundle and in `tauri dev`.
fn bridge_binary_path() -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_default();
    let dir = exe.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    dir.join(if cfg!(windows) { "gloss-bridge.exe" } else { "gloss-bridge" })
}

/// Shows and focuses the main window, bringing the app back from the menu bar.
fn show_main(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Hides the window and, on macOS, leaves only the menu bar icon.
fn hide_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
}

/// Handles a `gloss://` link: `gloss://pages/<url key>?ask=<id>` opens a
/// page in the window; anything else only brings the window forward.
fn handle_deep_link(app: &AppHandle, url: &tauri::Url) {
    show_main(app);
    if url.host_str() != Some("pages") {
        return;
    }
    let key = url.path().trim_start_matches('/');
    let Ok(url_key) = percent_decode_str(key) else { return };
    let ask = url.query_pairs().find(|(k, _)| k == "ask").map(|(_, v)| v.into_owned());
    let _ = app.emit("open-page", serde_json::json!({ "urlKey": url_key, "clarificationId": ask }));
}

fn percent_decode_str(s: &str) -> Result<String, ()> {
    let decoded = percent_decode(s);
    if decoded.is_empty() && !s.is_empty() { Err(()) } else { Ok(decoded) }
}

/// Starts or stops the loopback listener the Safari extension uses, to
/// match the setting. The token is new on every start and written to
/// `bridge.json` in the Gloss home and in the App Group container.
fn apply_safari_bridge(app: &AppHandle, enabled: bool) {
    let status = app.state::<Arc<BridgeStatus>>().inner().clone();
    let engine = app.state::<Eng>().inner().clone();
    let mut guard = status.loopback.lock().unwrap();
    if !enabled {
        if let Some((_, task)) = guard.take() {
            task.abort();
            let _ = std::fs::remove_file(&engine.paths.bridge_json);
            if let Some(group) = app_group_dir() {
                let _ = std::fs::remove_file(group.join("bridge.json"));
            }
        }
        return;
    }
    if guard.is_some() {
        return;
    }
    let handler = status.handler.clone();
    let status_for_task = status.clone();
    let json_path = engine.paths.bridge_json.clone();
    let (tx, rx) = std::sync::mpsc::channel::<Option<u16>>();
    let task = tauri::async_runtime::spawn(async move {
        let Ok((listener, port)) = bridge::loopback::bind().await else {
            let _ = tx.send(None);
            return;
        };
        let token = bridge::loopback::new_token();
        let info = bridge::loopback::BridgeInfo { port, token: token.clone(), protocol: bridge::PROTOCOL };
        let mut targets = vec![json_path.clone()];
        if let Some(group) = app_group_dir() {
            targets.push(group.join("bridge.json"));
        }
        let refs: Vec<&std::path::Path> = targets.iter().map(|p| p.as_path()).collect();
        let failures = bridge::loopback::write_info(&info, &refs);
        // Only the App Group copy matters to Safari; the home copy serves tests.
        let safari_failure = failures
            .iter()
            .find(|f| targets.len() > 1 && f.path == targets[1])
            .map(|f| format!("{} ({})", f.error, f.path.display()));
        *status_for_task.safari_bridge_error.lock().unwrap() = safari_failure;
        let _ = tx.send(Some(port));
        if let Err(e) = bridge::loopback::serve(handler, listener, token).await {
            tracing::warn!(error = %e, "loopback bridge stopped");
        }
    });
    match rx.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(Some(port)) => *guard = Some((port, task)),
        _ => {
            task.abort();
            tracing::warn!("loopback bridge could not start");
        }
    }
}

/// The App Group container the Safari extension can read. The path is
/// asked of NSFileManager rather than built by hand: macOS grants a
/// non-sandboxed app access to its group container only once the app has
/// looked the container up that way, and refuses a direct write before then.
fn app_group_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        use objc2_foundation::{NSFileManager, NSString};
        let group = NSString::from_str(APP_GROUP);
        let url = NSFileManager::defaultManager().containerURLForSecurityApplicationGroupIdentifier(&group)?;
        let path = url.path()?;
        Some(PathBuf::from(path.to_string()))
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

#[tauri::command]
fn list_conversations(
    engine: State<'_, Eng>,
    query: Option<String>,
    tag: Option<String>,
) -> Result<Vec<ConversationSummary>, String> {
    engine.list_conversations(query.as_deref(), tag.as_deref()).map_err(err)
}

#[tauri::command]
fn search(engine: State<'_, Eng>, query: String) -> Result<Vec<SearchHit>, String> {
    engine.search(&query).map_err(err)
}

#[tauri::command]
fn set_pinned(engine: State<'_, Eng>, id: String, pinned: bool) -> Result<ConversationSummary, String> {
    engine.set_pinned(&id, pinned).map_err(err)
}

#[tauri::command]
fn set_tags(engine: State<'_, Eng>, id: String, tags: Vec<String>) -> Result<ConversationSummary, String> {
    engine.set_tags(&id, &tags).map_err(err)
}

#[tauri::command]
fn list_tags(engine: State<'_, Eng>) -> Result<Vec<String>, String> {
    engine.list_tags().map_err(err)
}

/// Stores a file for a later turn. The bytes arrive as the raw request body;
/// the file name and mime type come in the `x-name` and `x-mime` headers,
/// which keeps large files out of JSON.
#[tauri::command]
fn add_attachment(engine: State<'_, Eng>, request: Request<'_>) -> Result<Attachment, String> {
    let header = |key: &str| {
        request
            .headers()
            .get(key)
            .and_then(|v| v.to_str().ok())
            .map(percent_decode)
            .unwrap_or_default()
    };
    let name = header("x-name");
    let mime = header("x-mime");
    let bytes: &[u8] = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b,
        _ => return Err("attachment body must be raw bytes".into()),
    };
    engine.add_attachment(&name, &mime, bytes).map_err(err)
}

/// Stores a file that the native file picker or a drop on the window named
/// by path. The engine classifies it by extension and content, as it does for
/// bytes sent from the page.
#[tauri::command]
fn add_attachment_path(engine: State<'_, Eng>, path: String) -> Result<Attachment, String> {
    let file = std::path::Path::new(&path);
    let name = file.file_name().and_then(|n| n.to_str()).unwrap_or("file").to_string();
    let bytes = std::fs::read(file).map_err(|e| format!("could not read {}: {}", name, e))?;
    engine.add_attachment(&name, "", &bytes).map_err(err)
}

#[tauri::command]
fn remove_attachment(engine: State<'_, Eng>, id: String) -> Result<(), String> {
    engine.remove_attachment(&id).map_err(err)
}

/// The stored bytes of an attachment, returned raw for image previews.
#[tauri::command]
fn attachment_bytes(engine: State<'_, Eng>, id: String) -> Result<Response, String> {
    let (_, bytes) = engine.attachment_bytes(&id).map_err(err)?;
    Ok(Response::new(bytes))
}

/// Opens a native save dialog and writes `contents` where the user chooses.
/// The dialog's type filter follows the extension of `default_name`.
/// Returns the chosen path, or None when the dialog was dismissed.
#[tauri::command]
async fn save_text_file(app: AppHandle, default_name: String, contents: String) -> Result<Option<String>, String> {
    let ext = std::path::Path::new(&default_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_string();
    let mut dialog = app.dialog().file().set_file_name(&default_name);
    if !ext.is_empty() {
        dialog = dialog.add_filter(format!(".{}", ext), &[ext.as_str()]);
    }
    let picked = dialog.add_filter("All files", &["*"]).blocking_save_file();
    let Some(path) = picked else { return Ok(None) };
    let path = path.into_path().map_err(err)?;
    std::fs::write(&path, contents).map_err(err)?;
    Ok(Some(path.to_string_lossy().to_string()))
}

/// Writes an artifact to the artifacts folder and opens it with the system's
/// default application for that file type, which for HTML is the browser.
#[tauri::command]
fn open_artifact(app: AppHandle, engine: State<'_, Eng>, name: String, contents: String) -> Result<String, String> {
    let path = engine.write_artifact_file(&name, &contents).map_err(err)?;
    app.opener().open_path(path.to_string_lossy().to_string(), None::<&str>).map_err(err)?;
    Ok(path.to_string_lossy().to_string())
}

/// Decodes `%XX` escapes, which the UI uses to fit any file name in a header.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

#[tauri::command]
fn list_projects(engine: State<'_, Eng>) -> Result<Vec<Project>, String> {
    engine.list_projects().map_err(err)
}

#[tauri::command]
fn add_project(engine: State<'_, Eng>, path: String) -> Result<Project, String> {
    engine.add_project(&path).map_err(err)
}

/// Agent sessions recorded for the project folder outside Gloss. Reading the
/// agents' files can take a moment on first use, so it runs off the main thread.
#[tauri::command]
async fn list_project_sessions(engine: State<'_, Eng>, path: String) -> Result<Vec<ExternalSession>, String> {
    let engine = engine.inner().clone();
    tauri::async_runtime::spawn_blocking(move || engine.list_project_sessions(&path))
        .await
        .map_err(err)?
        .map_err(err)
}

/// The turns of one of those sessions, read from the agent's file.
#[tauri::command]
async fn read_project_session(engine: State<'_, Eng>, path: String, agent: AgentId, id: String) -> Result<Vec<SessionTurn>, String> {
    let engine = engine.inner().clone();
    tauri::async_runtime::spawn_blocking(move || engine.read_project_session(&path, agent, &id))
        .await
        .map_err(err)?
        .map_err(err)
}

/// Starts a conversation that resumes one of those sessions in place.
#[tauri::command]
async fn continue_project_session(engine: State<'_, Eng>, path: String, agent: AgentId, id: String) -> Result<Conversation, String> {
    let engine = engine.inner().clone();
    tauri::async_runtime::spawn_blocking(move || engine.continue_project_session(&path, agent, &id))
        .await
        .map_err(err)?
        .map_err(err)
}

/// The turns a continued conversation's session had before Gloss took it over.
#[tauri::command]
async fn conversation_history(engine: State<'_, Eng>, id: String) -> Result<Vec<SessionTurn>, String> {
    let engine = engine.inner().clone();
    tauri::async_runtime::spawn_blocking(move || engine.conversation_history(&id))
        .await
        .map_err(err)?
        .map_err(err)
}

/// Removes the project from the list; its conversations are kept.
#[tauri::command]
fn remove_project(engine: State<'_, Eng>, path: String) -> Result<(), String> {
    engine.remove_project(&path).map_err(err)
}

#[tauri::command]
fn get_conversation(engine: State<'_, Eng>, id: String) -> Result<Conversation, String> {
    engine.get_conversation(&id).map_err(err)
}

#[tauri::command]
fn create_conversation(
    engine: State<'_, Eng>,
    agent: AgentId,
    model: Option<String>,
    web_search: Option<bool>,
    project_dir: Option<String>,
) -> Result<Conversation, String> {
    engine.create_conversation(agent, model, web_search, project_dir).map_err(err)
}

#[tauri::command]
fn rename_conversation(engine: State<'_, Eng>, id: String, title: String) -> Result<ConversationSummary, String> {
    engine.rename_conversation(&id, &title).map_err(err)
}

#[tauri::command]
fn delete_conversation(engine: State<'_, Eng>, id: String) -> Result<(), String> {
    engine.delete_conversation(&id).map_err(err)
}

#[tauri::command]
fn set_conversation_model(engine: State<'_, Eng>, id: String, model: String) -> Result<ConversationSummary, String> {
    engine.set_conversation_model(&id, &model).map_err(err)
}

#[tauri::command]
fn set_conversation_web_search(
    engine: State<'_, Eng>,
    id: String,
    enabled: bool,
) -> Result<ConversationSummary, String> {
    engine.set_conversation_web_search(&id, enabled).map_err(err)
}

/// Turn progress reaches the window through the engine's event broadcast
/// (see `forward_events`), so the command passes no sink of its own.
#[tauri::command]
async fn send_turn(engine: State<'_, Eng>, req: SendTurnRequest) -> Result<SendTurnResult, String> {
    let sink: EventSink = Arc::new(|_| {});
    engine.send_turn(req, sink).await.map_err(err)
}

/// Relays engine events to the webview for as long as the app runs.
fn forward_events(app: AppHandle, engine: Eng) {
    tauri::async_runtime::spawn(async move {
        let mut rx = engine.subscribe();
        loop {
            match rx.recv().await {
                Ok(AppEvent::Turn(env)) => {
                    if let Err(e) = app.emit("turn-event", &*env) {
                        tracing::warn!(error = %e, "could not emit turn-event");
                    }
                }
                Ok(AppEvent::Page { url_key, deleted }) => {
                    let _ = app.emit("page-event", serde_json::json!({ "urlKey": url_key, "deleted": deleted }));
                }
                Ok(AppEvent::Settings(s)) => {
                    let _ = app.emit("settings-event", &*s);
                }
                Ok(AppEvent::Focus { url_key, clarification_id }) => {
                    show_main(&app);
                    let _ = app.emit("open-page", serde_json::json!({ "urlKey": url_key, "clarificationId": clarification_id }));
                }
                Ok(AppEvent::Shutdown) | Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            }
        }
    });
}

#[tauri::command]
fn cancel_turn(engine: State<'_, Eng>, conversation_id: String) {
    engine.cancel_turn(&conversation_id)
}

/// Sets the working mode of a project-bound conversation; `None` is read-only.
#[tauri::command]
fn set_conversation_mode(engine: State<'_, Eng>, id: String, mode: Option<String>) -> Result<ConversationSummary, String> {
    engine.set_conversation_mode(&id, mode).map_err(err)
}

/// Hands the user's answer to the agent waiting on `request_id`.
#[tauri::command]
fn answer_request(
    engine: State<'_, Eng>,
    conversation_id: String,
    request_id: String,
    answer: RequestAnswer,
) -> Result<(), String> {
    engine.answer_request(&conversation_id, &request_id, answer).map_err(err)
}

#[tauri::command]
fn set_clarification_open(engine: State<'_, Eng>, id: String, open: bool) -> Result<(), String> {
    engine.set_clarification_open(&id, open).map_err(err)
}

#[tauri::command]
fn set_theme(app: AppHandle, engine: State<'_, Eng>, theme: Theme) -> Result<(), String> {
    engine.set_theme(theme).map_err(err)?;
    apply_native_theme(&app, theme);
    Ok(())
}

/// Switches every window's native appearance and background to `theme`.
/// The background matters on macOS, where the transparent title bar shows
/// it: the colour is the frontend's `--bg` for that theme, so the bar reads
/// as part of the page.
fn apply_native_theme(app: &AppHandle, theme: Theme) {
    let (native, bg) = match theme {
        Theme::Light => (tauri::Theme::Light, tauri::window::Color(0xf7, 0xf6, 0xf3, 0xff)),
        Theme::Dark => (tauri::Theme::Dark, tauri::window::Color(0x1f, 0x1e, 0x1b, 0xff)),
    };
    for window in app.webview_windows().values() {
        let _ = window.set_theme(Some(native));
        let _ = window.set_background_color(Some(bg));
    }
}

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            let paths = GlossPaths::from_env();
            let engine = Engine::open(paths.clone()).map_err(|e| std::io::Error::other(e.to_string()))?;
            // The stored theme decides the native window appearance at launch.
            let settings = engine.settings().unwrap_or_default();
            apply_native_theme(app.handle(), settings.theme);
            let engine = Arc::new(engine);
            app.manage(engine.clone());
            forward_events(app.handle().clone(), engine.clone());

            // The browser bridge: a Unix socket for the native-messaging
            // host, host manifests so browsers can find that host, and the
            // loopback listener for Safari when the setting is on.
            let handler = Arc::new(BridgeHandler::new(engine.clone(), app.package_info().version.to_string().as_str()));
            let status = Arc::new(BridgeStatus {
                handler: handler.clone(),
                bridge_path: bridge_binary_path(),
                loopback: Mutex::new(None),
                safari_bridge_error: Mutex::new(None),
            });
            app.manage(status.clone());
            #[cfg(unix)]
            {
                let sock = paths.bridge_sock.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = bridge::unix::serve(handler, &sock).await {
                        tracing::warn!(error = %e, "bridge socket stopped");
                    }
                });
            }
            for reg in native_host::register_all(&status.bridge_path) {
                if let Some(e) = reg.error {
                    tracing::warn!(browser = reg.name, error = e, "could not register the native messaging host");
                }
            }
            apply_safari_bridge(app.handle(), settings.safari_bridge);

            // Menu-bar icon: the app keeps running after its window closes.
            let menu = MenuBuilder::new(app).text("open", "Open Gloss").separator().text("quit", "Quit Gloss").build()?;
            TrayIconBuilder::with_id("main")
                .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .icon_as_template(true)
                .tooltip("Gloss")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // gloss:// links from the extension's "Open Gloss" button.
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    handle_deep_link(&handle, &url);
                }
            });
            #[cfg(any(target_os = "linux", windows))]
            let _ = app.deep_link().register_all();
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                hide_main(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_agents,
            list_models,
            get_settings,
            update_settings,
            list_conversations,
            list_projects,
            add_project,
            remove_project,
            list_project_sessions,
            read_project_session,
            continue_project_session,
            conversation_history,
            get_conversation,
            create_conversation,
            rename_conversation,
            delete_conversation,
            set_conversation_model,
            set_conversation_web_search,
            set_conversation_mode,
            answer_request,
            send_turn,
            cancel_turn,
            set_clarification_open,
            set_theme,
            search,
            set_pinned,
            set_tags,
            list_tags,
            add_attachment,
            add_attachment_path,
            remove_attachment,
            attachment_bytes,
            save_text_file,
            open_artifact,
            list_pages,
            get_page,
            delete_page,
            delete_clarification,
            extension_status,
            register_native_hosts,
            unregister_native_hosts,
            open_url,
            install_firefox_extension,
            open_safari_extensions,
            safari_extension_state,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => show_main(app),
            tauri::RunEvent::Exit => {
                if let Some(engine) = app.try_state::<Eng>() {
                    engine.publish(AppEvent::Shutdown);
                    let _ = std::fs::remove_file(&engine.paths.bridge_sock);
                    let _ = std::fs::remove_file(&engine.paths.bridge_json);
                    if let Some(group) = app_group_dir() {
                        let _ = std::fs::remove_file(group.join("bridge.json"));
                    }
                }
            }
            _ => {}
        });
}
