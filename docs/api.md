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
