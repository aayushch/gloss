# Shell ↔ frontend API

The Svelte frontend talks to the Rust side only through Tauri commands and one
Tauri event. Payload types are defined in `engine/src/types.rs` and mirrored in
`ui/src/lib/api/types.ts`. All fields are camelCase; enums are snake_case strings.

## Commands

| Command | Arguments | Returns | Notes |
| --- | --- | --- | --- |
| `list_agents` | – | `AgentInfo[]` | Probes PATH (with the login-shell environment) each call. |
| `list_models` | `agent: AgentId` | `ModelInfo[]` | Static list, config cache, or the CLI's own list command depending on the agent. |
| `get_settings` | – | `Settings` | |
| `update_settings` | `settings: Settings` | `Settings` | Whole-object replace. |
| `list_conversations` | `query?: string, tag?: string` | `ConversationSummary[]` | Pinned first, then newest. `query` matches titles (substring) and finished turn text (full-text, every word as a prefix); `tag` keeps conversations carrying that tag. |
| `search` | `query: string` | `SearchHit[]` | Full-text hits across every conversation, best match first (at most 60). Title-only matches have `turnId: null`. Matched words in `snippet` are wrapped in `\u0001`…`\u0002`. |
| `set_pinned` | `id: string, pinned: boolean` | `ConversationSummary` | |
| `set_tags` | `id: string, tags: string[]` | `ConversationSummary` | Tags are trimmed, lower-cased and de-duplicated. |
| `list_tags` | – | `string[]` | Every tag in use, most used first. |
| `add_attachment` | raw body = file bytes; headers `x-name` (percent-encoded), `x-mime` | `Attachment` | Stores the file under `~/.gloss/workspace/attachments/<id>/`. Images (png, jpeg, gif, webp, ≤ 20 MB) and UTF-8 text (≤ 512 KB) only; anything else is an error. |
| `add_attachment_path` | `path: string` | `Attachment` | Same as `add_attachment` for a file already on disk, named by the native file picker or a drop on the window. The name comes from the path and the type from its extension and content. |
| `remove_attachment` | `id: string` | – | Only for attachments not yet sent. |
| `attachment_bytes` | `id: string` | raw bytes | For image previews. |
| `save_text_file` | `defaultName: string, contents: string` | `string \| null` | Native save dialog filtered by the default name's extension; the chosen path, or null when dismissed. |
| `open_artifact` | `name: string, contents: string` | `string` | Writes the content under `~/.gloss/artifacts/<id>/` and opens it with the system's default app (the browser for `.html`). Returns the path. |
| `get_conversation` | `id: string` | `Conversation` | Turns in `seq` order, clarifications in `number` order. |
| `list_projects` | – | `Project[]` | Folders the user added as projects, most recently active first (added, or one of their conversations updated). |
| `add_project` | `path: string` | `Project` | `path` must be an existing absolute directory; it is stored canonicalised. Adding a project that exists returns it unchanged. |
| `list_project_sessions` | `path: string` | `ExternalSession[]` | Sessions Claude Code, Codex, Gemini CLI and Pi recorded for the folder in their own history files, newest first. Sessions a Gloss conversation holds (by agent session id), empty sessions and other folders' sessions are left out. Cursor is not read. Files are re-read only when they change. |
| `read_project_session` | `path: string, agent: AgentId, id: string` | `SessionTurn[]` | The turns of one session `list_project_sessions` lists, read from the agent's file: prompts, and replies with each tool call reduced to a short label. Errors for a session the project does not list. |
| `continue_project_session` | `path: string, agent: AgentId, id: string` | `Conversation` | Creates a conversation in the project that resumes that session in place: same agent session id, so new turns go to the same history file. Its title is the session's, `continuedFrom` is the file, and the session leaves the outside list. |
| `conversation_history` | `id: string` | `SessionTurn[]` | For a conversation with `continuedFrom`, the session's turns from before Gloss took it over; empty otherwise. |
| `remove_project` | `path: string` | – | Removes the project from the list only. Its conversations keep their `projectDir` and are listed outside any project. |
| `create_conversation` | `agent: AgentId, model?: string, webSearch?: boolean, projectDir?: string` | `Conversation` | Title starts as "New conversation" and is replaced by the first user message. `projectDir` must be an existing absolute directory; it is stored canonicalised, added as a project if it is not one, and cannot change later. The agent then runs inside it with read-only file tools (see `docs/agents.md`). |
| `rename_conversation` | `id: string, title: string` | `ConversationSummary` | |
| `delete_conversation` | `id: string` | – | Cancels a running turn first. Agent-side session files are left alone. |
| `set_conversation_model` | `id: string, model: string` | `ConversationSummary` | Applies to the next turn. |
| `set_conversation_mode` | `id: string, mode?: string` | `ConversationSummary` | Working mode of a project-bound conversation, one of the ids in `AgentInfo.modes`; omitted or `"read-only"` is read-only. Takes effect on the next turn, including a resumed session. |
| `answer_request` | `conversationId: string, requestId: string, answer: RequestAnswer` | – | Answers the request the running agent is waiting on (see Events). A permission answer with `setMode` also switches the conversation to that mode. |
| `set_conversation_web_search` | `id: string, enabled: boolean` | `ConversationSummary` | Applies to the next turn. |
| `send_turn` | `req: SendTurnRequest` | `SendTurnResult` | Returns as soon as both turn rows exist; progress arrives as `turn-event`s. Errors if a turn is already running in that conversation. `req.attachments` lists staged attachment ids; they are bound to the user turn. |
| `cancel_turn` | `conversationId: string` | – | Kills the agent process; the turn ends with a `cancelled` event. |
| `set_clarification_open` | `id: string, open: boolean` | – | Persists the collapsed state. |
| `set_theme` | `theme: Theme` | – | Also switches the native window appearance and background colour (the transparent macOS title bar shows the latter). |
| `list_pages` | `limit?: number` | `Page[]` | Web pages asked about from the browser extension, most recently active first. |
| `get_page` | `urlKey: string` | `PageDetail \| null` | The page with its conversation; asks are the clarifications carrying a `webAnchor`, turns without a clarification are questions about the whole page. |
| `delete_page` | `urlKey: string` | – | Deletes the page's conversation (and so the page, its asks and turns). |
| `delete_clarification` | `id: string` | – | Removes one clarification with its turns and any clarification nested in its replies. |
| `extension_status` | – | `ExtensionStatus` | Bridge path, whether the app runs translocated, per-browser host-manifest status, connected extensions, whether the Firefox add-on and Safari extension are bundled, the Chrome Web Store URL, the loopback port, and the Safari bridge file or the error that kept it from being written. |
| `register_native_hosts` / `unregister_native_hosts` | – | `BrowserRegistration[]` | Writes or removes the native-messaging host manifests for every installed browser. Done at every launch too. |
| `open_url` | `url: string` | – | Opens an http(s) link in the default browser. |
| `install_firefox_extension` | – | – | Opens the bundled signed `.xpi` with Firefox, which asks to install it. Errors when this build has no add-on. |
| `open_safari_extensions` | – | – | Opens Safari's Settings › Extensions pane at the Gloss extension (falls back to bringing Safari forward). |
| `safari_extension_state` | – | `SafariExtensionState` | Whether Safari has the bundled extension turned on; an error when Safari cannot say, such as a build without the extension. |

## Event `turn-event`

Payload: `TurnEventEnvelope { conversationId, turnId, event }`. Order for one turn:

1. `started` once the agent process reports its session (may carry the model).
2. Any number of `delta`, `replace`, `activity`, and `request` / `request_resolved` pairs.
3. Exactly one of `done`, `failed`, `cancelled`, each carrying the final `Turn` row.

`request` means the agent is waiting for the user and carries an
`AgentRequest`: `id` plus `kind`, which is `permission` (`tool`, `title`,
`detail`, `suggestions[]` of modes the CLI proposes switching to) or
`question` (`questions[]` with `question`, `header`, `options[]` of
`label`/`description`, `multiSelect`). The turn stays running until
`answer_request` is called; `request_resolved` (`requestId`) follows. A
reopened conversation carries the open request as
`Conversation.pendingRequest`. `AgentInfo.modes` lists the working modes a
CLI offers for project-bound conversations, read from its own help output
(`id`, `label`, `description`, `writes`), and `AgentInfo.supportsRequests`
says whether its prompts reach the user.

`delta` appends; `replace` swaps the whole text. The frontend must tolerate a
`replace` after deltas: some agents re-send a full message that does not
extend the streamed prefix.

## Other events

- `page-event` `{ urlKey, deleted }`: a page's asks changed (created, removed,
  opened or closed, re-anchored) or the page was deleted. The frontend
  re-fetches the page list and, when it is open, the page.
- `settings-event` `Settings`: the settings changed, from any side.
- `open-page` `{ urlKey, clarificationId }`: the browser asked Gloss to show a
  page (the extension's "Open in Gloss" button, or a `gloss://pages/<url key>?ask=<id>`
  link). The window is already in front when the event arrives.

## Bridge protocol (browser extension ↔ app)

The browser extension talks to the running app through `engine/src/bridge/`.
Chrome-family browsers and Firefox spawn the `gloss-bridge` native-messaging
host, which relays frames to the Unix socket `~/.gloss/bridge.sock`; the
Safari extension's native handler connects to a TCP listener on 127.0.0.1
whose port and token are in `~/.gloss/bridge.json` (and the App Group
container), and must send `{"token": "…"}` as its first line. Both carry
the same protocol: one JSON object per line.

- Request `{ id, method, params }`; reply `{ id, result }` or
  `{ id, error: { code, message } }` with codes `protocol`, `unauthorized`,
  `busy`, `not_found`, `denied`, `invalid`, `internal`, and `app_not_running`
  (sent by `gloss-bridge` itself when no app is running).
- Pushed events `{ event, data }`: `turn` (a `TurnEventEnvelope`), `page`
  (`{ urlKey, deleted }`), `settings` (`{ sendPageText, denyList }`),
  `shutdown`; `gloss-bridge` adds `app_state` (`{ running }`).
- Methods: `hello` (must come first; `{ protocol, extensionVersion, browser }` →
  `{ protocol, minProtocol, appVersion, settings, agent }`), `getPage`
  (`PageMeta` → `{ urlKey, page }`), `getTurn` (`{ turnId }` → `{ turn, running,
  request }`), `ask` (`PageAskRequest` → `PageAskResult`), `askPage` (same with
  no anchor), `followUp` (`{ clarificationId, question }`), `setOpen`,
  `cancel`, `deleteAsk`, `reportAnchors` (`{ states: { id: 'anchored' |
  'fuzzy' | 'orphan' } }`), `listRecentPages`, `openInGloss`, and `launchApp`
  (handled by the host, never by the app).
- Every line the app writes stays under 900 KB, Chrome's frame limit; a page
  whose replies would exceed it comes back with long turn texts cut and
  `truncated: true` on those turns.

Protocol constants live in `engine/src/bridge/mod.rs` and
`extension/src/shared/protocol.ts`. The headless CLI speaks it too:
`gloss-engine serve [--loopback]` runs the listeners and `gloss-engine
bridge-call <method> [json]` sends one request.

## Attachments in the prompt

Text attachments are inlined into the prompt after the message, each as

```
<attachment name="<original name>">
<file contents>
</attachment>
```

Image attachments take each CLI's own route (see `docs/agents.md`); the user
turn's `promptText` does not mention them.

## Artifacts in the reply

The system note asks agents to write standalone work as

```
<artifact id="short-kebab-id" type="text/html" title="Short title">
...content...
</artifact>
```

with `type` one of `text/html`, `image/svg+xml`, `text/mermaid`,
`text/markdown`, `text/plain` or `text/code` (plus `lang="…"`). The engine
passes the text through untouched; `ui/src/lib/markdown/artifacts.ts` parses
it. A reply that reuses an id is a new version of that artifact.

## Block ids

The frontend parses each assistant turn's markdown into blocks and gives block
`i` of turn `T` the id `T:i`. Clarifications store that id plus the quoted text.
At render time the quote is matched against the block's plain text (first
occurrence); if it no longer matches, the thread still renders under the block
without a mark.

## Clarification prompt

A clarification is a normal user turn. The frontend sends only the question;
the engine composes what the agent receives (stored as `promptText` on the user
turn):

```
The user highlighted this excerpt of your previous answer and is asking about it.
Answer about the excerpt directly, in markdown, without repeating the whole answer.

> "<quote>"

<question>
```

Follow-ups inside the same clarification are sent as:

```
Follow-up about the excerpt "<quote, truncated>":

<question>
```
