//! Tauri shell for Gloss. Each command is a thin wrapper over the engine
//! crate; turn progress reaches the webview as the `turn-event` event.

use std::sync::Arc;

use gloss_engine::engine::EventSink;
use gloss_engine::*;
use tauri::ipc::{Request, Response};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

type Eng = Arc<Engine>;

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
fn update_settings(engine: State<'_, Eng>, settings: Settings) -> Result<Settings, String> {
    engine.update_settings(settings).map_err(err)
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

#[tauri::command]
async fn send_turn(app: AppHandle, engine: State<'_, Eng>, req: SendTurnRequest) -> Result<SendTurnResult, String> {
    let sink: EventSink = Arc::new(move |envelope: TurnEventEnvelope| {
        if let Err(e) = app.emit("turn-event", &envelope) {
            tracing::warn!(error = %e, "could not emit turn-event");
        }
    });
    engine.send_turn(req, sink).await.map_err(err)
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
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let paths = GlossPaths::from_env();
            let engine = Engine::open(paths).map_err(|e| std::io::Error::other(e.to_string()))?;
            // The stored theme decides the native window appearance at launch.
            let theme = engine.settings().map(|s| s.theme).unwrap_or(Theme::Light);
            apply_native_theme(app.handle(), theme);
            app.manage(Arc::new(engine));
            Ok(())
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
