# Gloss architecture

Gloss is a desktop chat UI for the CLI coding agents already installed on the
machine. Its defining feature is inline clarification: highlight part of an
answer, ask about it, and the reply renders under that sentence as a
collapsible thread. To the agent a clarification is just another turn.

## Pieces

```
┌──────────────────────────── Tauri window ─────────────────────────────┐
│  Svelte 5 frontend (ui/src)                                           │
│   rail · transcript · wells · composer · settings                     │
│   markdown → block model → marks → Shiki                              │
│          │ invoke(command)            ▲ listen("turn-event")         │
├──────────┴────────────────────────────┴───────────────────────────────┤
│  Tauri shell (ui/src-tauri): thin command wrappers, event forwarding  │
├───────────────────────────────────────────────────────────────────────┤
│  Engine crate (engine/): Rust library + `gloss-engine` CLI            │
│   agents/   adapters: claude · codex · gemini · pi · cursor           │
│   process   spawn, stream lines, idle timeout, cancel                 │
│   store     SQLite at ~/.gloss/gloss.db                               │
│   env       login-shell environment capture                           │
└───────────────────────────────────────────────────────────────────────┘
            │ spawns `<agent> -p … --output-format json-stream`
            ▼
   claude / codex / gemini / pi / cursor-agent   (cwd: ~/.gloss/workspace)
```

The engine is Rust and linked straight into the shell. There is no sidecar,
no local HTTP server and no second runtime to bootstrap: the shell starts, opens
the database, captures the shell environment, and is ready.

Updates come through Tauri's updater plugin. The app fetches `latest.json`
from the newest GitHub release shortly after launch and every two hours, and
offers a newer version in the rail. The bundle it downloads must carry a
minisign signature that matches the public key in `tauri.conf.json`; the
release workflow signs with the matching private key from the repository
secrets. The frontend state lives in `ui/src/lib/state/updater.svelte.ts`.

## A turn, end to end

1. The frontend calls `send_turn` with the typed text and, for a
   clarification, the anchor (block id + quote) or the existing clarification.
2. The engine writes the user turn (with the exact prompt it will send) and a
   pending assistant turn, creates the clarification row if needed, and returns.
3. A background task spawns the agent CLI. First turn: a fresh session id
   chosen by Gloss where the CLI allows it. Later turns: the CLI's resume flag
   with the stored session id. Every spawn uses cwd `~/.gloss/workspace` and
   the captured login-shell environment.
4. The adapter turns the CLI's JSON lines into a small set of events: append
   text, set full text, activity (thinking, tool, status), usage, error. The
   engine forwards them to the window as `turn-event`s and persists the
   assembled text every half second.
5. On exit the engine records usage, model and the agent's session id, marks
   the turn done (or error/cancelled) and emits the final turn row.

## Storage and segregation

```
~/.gloss/
  gloss.db        conversations · turns · clarifications · attachments · settings · turns_fts
  workspace/      cwd for every agent process; holds only attachments/
  workspace/attachments/<id>/<name>   one directory per attached file
  pi-sessions/    Pi stores its session files here (--session-dir)
  artifacts/<id>/<name>   artifacts written out for "Open" in the browser; purged after 7 days
  logs/
```

Gloss owns the canonical transcript. The agents keep their own session files
in their own homes, keyed by the Gloss cwd, so nothing Gloss does shows up in
a real project's history. `docs/agents.md` lists what each CLI stores and where.

`turns_fts` is an FTS5 index over finished turns, kept current by triggers on
`turns`; the rail's search box queries it. Picking a hit opens its
conversation, expands the well if the hit is inside one, and hands the search
text to the frontend's find bar, which highlights every occurrence in the
rendered transcript and scrolls to the first one in the hit's turn. The same
bar opens on Cmd/Ctrl+F and searches only what is rendered, so a collapsed
well is covered by the rail search, not by find. The schema carries a version number
and `Store::open` migrates older files in place.

Export runs in the frontend: it serialises the same blocks the transcript
renders back to Markdown and inserts each clarification as a blockquote after
its anchor block, so the exported text matches what the user saw.

## Frontend model

Assistant markdown is parsed into blocks (paragraph, heading, list item, code,
quote, table). Block `i` of turn `T` has id `T:i`. A clarification stores the
block id and the quoted text; at render time the quote is located in the
block's plain text and the block's inline runs are split at the mark
boundaries, so bold, code and italic formatting survives inside the highlight.
Clarification replies are themselves turns parsed the same way, which is what
makes nesting unbounded.

Artifacts are part of the reply text. The system note asks every agent to
wrap a standalone piece of work (page, SVG, Mermaid diagram, document, file)
in `<artifact id type title>`; the block parser lifts each one out before the
markdown lexer runs and leaves an `artifact` block in its place, which the
transcript renders as a card. Fenced blocks holding a whole HTML document, an
SVG or a Mermaid diagram are lifted the same way for agents that ignore the
tag. Nothing is stored separately: the artifact pane groups the artifacts of
the open conversation by id, and each reply that reuses an id is the next
version. Previews of HTML, SVG and rendered diagrams load in an iframe with
`sandbox` and an injected content security policy; scripts and network are
off until the user switches them on, and `allow-same-origin` is never set, so
the frame cannot reach Tauri's IPC bridge. Markdown artifacts render with the
app's own read-only renderer.

## Decisions

- **Rust engine, no Python sidecar.** The engine is process spawning, JSON
  parsing and SQLite; Rust handles it in a few thousand lines and avoids
  shipping and bootstrapping a second runtime.
- **Chat plus web search by default.** Agents get no file or shell tools in
  Gloss. Web search is a per-conversation toggle mapped to each CLI's flags.
- **All five agents in v1.** Codex is implemented from laya's adapter and a
  recorded run because it is not installed on the development machine.
- **One shared workspace directory** rather than one per conversation, so the
  agents create one project bucket each instead of one per chat.

## Later

Bind a conversation to a project folder (read-only tools, lives in that
project's agent history by design); import an existing agent session into
Gloss; branch at a turn; ask another agent the same question side by side.
