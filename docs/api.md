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
| `remove_attachment` | `id: string` | – | Only for attachments not yet sent. |
| `attachment_bytes` | `id: string` | raw bytes | For image previews. |
| `save_text_file` | `defaultName: string, contents: string` | `string \| null` | Native save dialog filtered by the default name's extension; the chosen path, or null when dismissed. |
| `open_artifact` | `name: string, contents: string` | `string` | Writes the content under `~/.gloss/artifacts/<id>/` and opens it with the system's default app (the browser for `.html`). Returns the path. |
| `get_conversation` | `id: string` | `Conversation` | Turns in `seq` order, clarifications in `number` order. |
| `create_conversation` | `agent: AgentId, model?: string, webSearch?: boolean` | `Conversation` | Title starts as "New conversation" and is replaced by the first user message. |
| `rename_conversation` | `id: string, title: string` | `ConversationSummary` | |
| `delete_conversation` | `id: string` | – | Cancels a running turn first. Agent-side session files are left alone. |
| `set_conversation_model` | `id: string, model: string` | `ConversationSummary` | Applies to the next turn. |
| `set_conversation_web_search` | `id: string, enabled: boolean` | `ConversationSummary` | Applies to the next turn. |
| `send_turn` | `req: SendTurnRequest` | `SendTurnResult` | Returns as soon as both turn rows exist; progress arrives as `turn-event`s. Errors if a turn is already running in that conversation. `req.attachments` lists staged attachment ids; they are bound to the user turn. |
| `cancel_turn` | `conversationId: string` | – | Kills the agent process; the turn ends with a `cancelled` event. |
| `set_clarification_open` | `id: string, open: boolean` | – | Persists the collapsed state. |
| `set_theme` | `theme: Theme` | – | Also switches the native window appearance. |

## Event `turn-event`

Payload: `TurnEventEnvelope { conversationId, turnId, event }`. Order for one turn:

1. `started` once the agent process reports its session (may carry the model).
2. Any number of `delta`, `replace`, `activity`.
3. Exactly one of `done`, `failed`, `cancelled`, each carrying the final `Turn` row.

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
