use super::*;
use crate::types::AgentId;

const PROJECT: &str = "/work/my.app";

fn write(path: &Path, lines: &[serde_json::Value]) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let body: String = lines.iter().map(|l| format!("{}\n", l)).collect();
    std::fs::write(path, body).unwrap();
}

fn plant_claude(homes: &AgentHomes) {
    let dir = homes.claude.join("projects").join("-work-my-app");
    assert_eq!(claude::slug(PROJECT), "-work-my-app");
    write(
        &dir.join("c1.jsonl"),
        &[
            serde_json::json!({"type": "mode", "sessionId": "c1"}),
            serde_json::json!({"type": "user", "sessionId": "c1", "cwd": PROJECT, "entrypoint": "cli", "timestamp": "2026-10-01T10:00:00Z",
                "message": {"role": "user", "content": "<command-name>/clear</command-name>"}}),
            serde_json::json!({"type": "user", "sessionId": "c1", "cwd": PROJECT, "entrypoint": "cli",
                "message": {"role": "user", "content": [{"type": "text", "text": "Fix the   login\nbug"}]}}),
            serde_json::json!({"type": "ai-title", "aiTitle": "Login bug", "sessionId": "c1"}),
            serde_json::json!({"type": "ai-title", "aiTitle": "Fix login redirect", "sessionId": "c1"}),
        ],
    );
    // No title from the agent: the first prompt is the title.
    write(
        &dir.join("c2.jsonl"),
        &[serde_json::json!({"type": "user", "sessionId": "c2", "cwd": PROJECT, "entrypoint": "sdk-cli",
            "message": {"role": "user", "content": "Explain the build"}})],
    );
    // Opened and left without a message.
    write(&dir.join("c3.jsonl"), &[serde_json::json!({"type": "mode", "sessionId": "c3"})]);
    // Same slug, different folder (`/work/my-app` also slugs to `-work-my-app`).
    write(
        &dir.join("c4.jsonl"),
        &[serde_json::json!({"type": "user", "sessionId": "c4", "cwd": "/work/my-app",
            "message": {"role": "user", "content": "Other folder"}})],
    );
}

fn plant_codex(homes: &AgentHomes) {
    let day = homes.codex.join("sessions").join("2026").join("10").join("02");
    let meta = |id: &str, cwd: &str| {
        serde_json::json!({"type": "session_meta", "payload": {"id": id, "cwd": cwd, "source": "cli", "originator": "codex_cli_rs",
            "timestamp": "2026-10-02T09:00:00Z", "base_instructions": {"text": "You are Codex"}}})
    };
    let prompt = |text: &str| serde_json::json!({"type": "event_msg", "payload": {"type": "user_message", "message": text}});
    let context = serde_json::json!({"type": "response_item", "payload": {"type": "message", "role": "user",
        "content": [{"type": "input_text", "text": "<environment_context>…</environment_context>"}]}});
    write(&day.join("rollout-2026-10-02T09-00-00-x1.jsonl"), &[meta("x1", PROJECT), context.clone(), prompt("Add a CLI flag")]);
    write(&day.join("rollout-2026-10-02T09-30-00-x2.jsonl"), &[meta("x2", "/elsewhere"), context, prompt("Not this one")]);
}

fn plant_gemini(homes: &AgentHomes) {
    let hash = gemini::project_hash(PROJECT);
    std::fs::create_dir_all(&homes.gemini).unwrap();
    std::fs::write(homes.gemini.join("projects.json"), serde_json::json!({"projects": {PROJECT: "my.app"}}).to_string()).unwrap();
    let chats = homes.gemini.join("tmp").join("my.app").join("chats");
    write(
        &chats.join("session-2026-10-03T08-00-g1.jsonl"),
        &[
            serde_json::json!({"sessionId": "g1", "projectHash": hash, "startTime": "2026-10-03T08:00:00Z", "kind": "main"}),
            serde_json::json!({"id": "m0", "type": "info", "content": "Update successful"}),
            serde_json::json!({"id": "m0b", "type": "user", "content": [{"text": "/login"}]}),
            serde_json::json!({"id": "m1", "type": "user", "content": [{"text": "Summarise the README"}]}),
            serde_json::json!({"$set": {"lastUpdated": "2026-10-03T08:01:00Z"}}),
        ],
    );
    // Header only: no message was sent.
    write(&chats.join("session-2026-10-03T08-05-g2.jsonl"), &[serde_json::json!({"sessionId": "g2", "projectHash": hash, "kind": "main"})]);
    // A folder that shares the directory name but hashes differently.
    write(
        &chats.join("session-2026-10-03T08-10-g3.jsonl"),
        &[
            serde_json::json!({"sessionId": "g3", "projectHash": "0".repeat(64), "kind": "main"}),
            serde_json::json!({"id": "m1", "type": "user", "content": "Wrong folder"}),
        ],
    );
    // The older single-object format, in the hash-named directory.
    let old = homes.gemini.join("tmp").join(&hash).join("chats").join("session-2026-03-11T05-08-g4.json");
    std::fs::create_dir_all(old.parent().unwrap()).unwrap();
    std::fs::write(
        &old,
        serde_json::json!({"sessionId": "g4", "projectHash": hash, "startTime": "2026-03-11T05:08:24Z", "kind": "main",
            "messages": [{"id": "a", "type": "user", "content": [{"text": "Old format prompt"}]}]})
        .to_string(),
    )
    .unwrap();
}

fn plant_pi(homes: &AgentHomes) {
    assert_eq!(pi::slug(PROJECT), "--work-my.app--");
    let dir = homes.pi.join("sessions").join("--work-my.app--");
    write(
        &dir.join("2026-10-04T07-00-00-000Z_p1.jsonl"),
        &[
            serde_json::json!({"type": "session", "version": 3, "id": "p1", "cwd": PROJECT, "timestamp": "2026-10-04T07:00:00Z"}),
            serde_json::json!({"type": "model_change", "modelId": "qwen"}),
            serde_json::json!({"type": "message", "message": {"role": "user", "content": [{"type": "text", "text": "What does this app do?"}]}}),
        ],
    );
}

#[test]
fn lists_each_agents_sessions_for_the_project_only() {
    let root = tempfile::tempdir().unwrap();
    let homes = AgentHomes::under(root.path());
    plant_claude(&homes);
    plant_codex(&homes);
    plant_gemini(&homes);
    plant_pi(&homes);

    let index = SessionIndex::default();
    let list = index.list(&homes, PROJECT);
    let mut found: Vec<(AgentId, &str, &str)> = list.iter().map(|s| (s.agent, s.id.as_str(), s.title.as_str())).collect();
    found.sort_by_key(|s| s.1);
    assert_eq!(
        found,
        vec![
            (AgentId::Claude, "c1", "Fix login redirect"),
            (AgentId::Claude, "c2", "Explain the build"),
            (AgentId::Gemini, "g1", "Summarise the README"),
            (AgentId::Gemini, "g4", "Old format prompt"),
            (AgentId::Pi, "p1", "What does this app do?"),
            (AgentId::Codex, "x1", "Add a CLI flag"),
        ]
    );
    let by_id = |id: &str| list.iter().find(|s| s.id == id).unwrap();
    assert_eq!(by_id("c1").origin, Some(SessionOrigin::Terminal));
    assert_eq!(by_id("c2").origin, Some(SessionOrigin::Headless));
    assert_eq!(by_id("x1").origin, Some(SessionOrigin::Terminal));
    assert_eq!(by_id("g1").origin, None);
    assert_eq!(by_id("x1").created_at, parse_time("2026-10-02T09:00:00Z").unwrap());
    assert!(list.windows(2).all(|w| w[0].updated_at >= w[1].updated_at));

    // A second listing reads from the cache; a rewritten file is read again.
    assert_eq!(index.list(&homes, PROJECT).len(), 6);
    let c2 = homes.claude.join("projects").join("-work-my-app").join("c2.jsonl");
    write(
        &c2,
        &[
            serde_json::json!({"type": "user", "sessionId": "c2", "cwd": PROJECT, "message": {"role": "user", "content": "Explain the build"}}),
            serde_json::json!({"type": "custom-title", "customTitle": "Build notes", "sessionId": "c2"}),
        ],
    );
    let again = index.list(&homes, PROJECT);
    assert_eq!(again.iter().find(|s| s.id == "c2").unwrap().title, "Build notes");
}

#[test]
fn missing_homes_list_nothing() {
    let root = tempfile::tempdir().unwrap();
    assert!(SessionIndex::default().list(&AgentHomes::under(root.path()), PROJECT).is_empty());
}

#[test]
fn titles_are_one_short_line() {
    assert_eq!(title_of("  a\n\tb  ").as_deref(), Some("a b"));
    assert_eq!(title_of("   "), None);
    let long = "x".repeat(200);
    assert_eq!(title_of(&long).unwrap().chars().count(), 80);
    assert_eq!(origin_of("claude-vscode"), Some(SessionOrigin::Ide));
    assert_eq!(origin_of("codex_exec"), Some(SessionOrigin::Headless));
    assert_eq!(origin_of("claude-desktop"), Some(SessionOrigin::Desktop));
    assert!(is_slash_command("/login"));
    assert!(is_slash_command("/model gpt-5"));
    assert!(!is_slash_command("/src/main.rs fails"));
    assert!(!is_slash_command("why / here"));
}

#[test]
fn reads_turns_with_tool_calls_collapsed() {
    let root = tempfile::tempdir().unwrap();
    let homes = AgentHomes::under(root.path());
    let claude_file = homes.claude.join("projects").join("-work-my-app").join("t1.jsonl");
    write(
        &claude_file,
        &[
            serde_json::json!({"type": "user", "timestamp": "2026-10-01T10:00:00Z", "message": {"role": "user", "content": "Fix the bug"}}),
            serde_json::json!({"type": "assistant", "timestamp": "2026-10-01T10:00:01Z", "message": {"content": [
                {"type": "text", "text": "Looking."},
                {"type": "tool_use", "name": "Read", "input": {"file_path": "/work/my.app/src/engine.rs"}}]}}),
            serde_json::json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "content": "…"}]}}),
            serde_json::json!({"type": "assistant", "isSidechain": true, "message": {"content": [{"type": "text", "text": "subagent"}]}}),
            serde_json::json!({"type": "assistant", "message": {"content": [
                {"type": "tool_use", "name": "Bash", "input": {"command": "cargo   test\n--all"}},
                {"type": "text", "text": "Fixed."}]}}),
        ],
    );
    let turns = read_turns(AgentId::Claude, &claude_file);
    assert_eq!(turns.len(), 2);
    assert_eq!((turns[0].role, turns[0].text.as_str()), (Role::User, "Fix the bug"));
    assert_eq!(turns[0].at, parse_time("2026-10-01T10:00:00Z").unwrap());
    assert_eq!(turns[1].text, "Looking.\n\nFixed.");
    assert_eq!(turns[1].tools, vec!["Read engine.rs", "Bash cargo test --all"]);

    let codex_file = root.path().join("rollout-x.jsonl");
    write(
        &codex_file,
        &[
            serde_json::json!({"type": "session_meta", "payload": {"id": "x"}}),
            serde_json::json!({"type": "event_msg", "payload": {"type": "user_message", "message": "Add a flag"}}),
            serde_json::json!({"type": "response_item", "payload": {"type": "function_call", "name": "shell",
                "arguments": "{\"command\":[\"bash\",\"-lc\",\"rg flag\"]}"}}),
            serde_json::json!({"type": "event_msg", "payload": {"type": "agent_message", "message": "Done."}}),
        ],
    );
    let turns = read_turns(AgentId::Codex, &codex_file);
    assert_eq!(turns.iter().map(|t| t.text.as_str()).collect::<Vec<_>>(), vec!["Add a flag", "Done."]);
    assert_eq!(turns[1].tools, vec!["shell rg flag"]);

    let gemini_file = root.path().join("session-g.jsonl");
    write(
        &gemini_file,
        &[
            serde_json::json!({"sessionId": "g", "kind": "main"}),
            serde_json::json!({"type": "user", "content": [{"text": "Summarise"}]}),
            serde_json::json!({"type": "gemini", "content": "", "toolCalls": [{"name": "read_file", "args": {"absolute_path": "/w/README.md"}}]}),
            serde_json::json!({"type": "gemini", "content": "It is a CLI."}),
            serde_json::json!({"type": "info", "content": "ignored"}),
        ],
    );
    let turns = read_turns(AgentId::Gemini, &gemini_file);
    assert_eq!(turns.len(), 2);
    assert_eq!((turns[1].text.as_str(), turns[1].tools.clone()), ("It is a CLI.", vec!["read_file README.md".to_string()]));

    let pi_file = root.path().join("pi.jsonl");
    write(
        &pi_file,
        &[
            serde_json::json!({"type": "session", "id": "p"}),
            serde_json::json!({"type": "message", "message": {"role": "user", "content": [{"type": "text", "text": "What is this?"}]}}),
            serde_json::json!({"type": "message", "message": {"role": "assistant", "content": [
                {"type": "thinking", "thinking": "hmm"},
                {"type": "toolCall", "name": "bash", "arguments": {"command": "ls"}}]}}),
            serde_json::json!({"type": "message", "message": {"role": "toolResult", "content": [{"type": "text", "text": "a b"}]}}),
            serde_json::json!({"type": "message", "message": {"role": "assistant", "content": [{"type": "text", "text": "A repo."}]}}),
        ],
    );
    let turns = read_turns(AgentId::Pi, &pi_file);
    assert_eq!(turns.len(), 2);
    assert_eq!((turns[1].text.as_str(), turns[1].tools.clone()), ("A repo.", vec!["bash ls".to_string()]));
}
