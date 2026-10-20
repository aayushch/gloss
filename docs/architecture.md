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

The engine is Rust and linked straight into the shell. There is no second
runtime to bootstrap: the shell starts, opens the database, captures the shell
environment, and is ready. The only things listening are for the browser
extension (see below): a Unix socket in the Gloss home, and a token-guarded
TCP listener on 127.0.0.1 for Safari.

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
  logs/gloss.log  the app's log (also on stderr); gloss.log.1 is the previous one
```

Gloss owns the canonical transcript. The agents keep their own session files
in their own homes, keyed by the Gloss cwd, so nothing Gloss does shows up in
a real project's history. `docs/agents.md` lists what each CLI stores and where.

The user can add folders as projects (the `projects` table). The rail lists
each project with its own conversations and its own "New chat"; the global
"New chat" always starts a chat outside any project. Removing a project only
takes it off the list: its conversations keep their folder and are listed by
date.

An expanded project also lists the sessions its agents recorded outside
Gloss (`engine/src/history/`, read-only). Opening one shows its turns from
the agent's file. Sending a message, or "Continue in Gloss", creates a
conversation that resumes that same agent session in place: the agent keeps
writing to the same history file, so the terminal and Gloss share it. The
conversation records the file and the takeover time (`origin_file`,
`origin_until`) and shows the file's earlier turns above its own. The
session then drops out of the outside list, because a conversation holds its
id.

A conversation can instead be bound to a project folder when it is created,
by starting it from the project or picking the project in the draft's header
(binding a folder that is not yet a project adds it). The agent then starts
in that folder, read-only unless the user picks one of
the working modes its CLI offers. The folder is fixed for the life of the
conversation because the agent's session is keyed to it, and those sessions
do appear in the project's own history, which is the point; the mode can
change at any time and applies from the next turn. Attachments still live
under `~/.gloss`. A folder picked under Desktop, Documents or Downloads on
macOS triggers the system's file-access prompt for Gloss, and the agent
processes inherit the answer.

Modes are not hard-coded: each adapter reads them from the CLI's own help
output when agents are detected, and maps the chosen id to the CLI's flag on
every spawn. Where the CLI can hand a decision to its host, the engine keeps
the agent's stdin open and relays it: a tool call that needs approval or a
question the agent asks arrives as a `request` event, the transcript shows a
card under the pending reply, and the answer is written back to the process.
Today Claude Code is the agent with such a channel (`docs/agents.md` has the
protocol); the others either never prompt headlessly or refuse what their
mode does not allow.

`turns_fts` is an FTS5 index over finished turns, kept current by triggers on
`turns`; the rail's search box queries it. Picking a hit opens its
conversation, expands the well if the hit is inside one, and hands the search
text to the frontend's find bar, which highlights every occurrence in the
rendered transcript and scrolls to the first one in the hit's turn. The same
bar opens on Cmd/Ctrl+F. It matches rendered text, and a collapsed well
renders nothing, so when typing pauses it opens every well whose stored text
contains the query and the new matches join the count. The schema carries a
version number and `Store::open` migrates older files in place.

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
makes nesting unbounded. The engine runs one turn per conversation at a time,
so while a reply is streaming the "Ask about this" pill is shown inert with a
note to wait, and the well follow-up boxes are disabled.

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

## Browser extension

The extension (`extension/`) brings the same gesture to any web page:
highlight, ask, read the reply in a popover anchored to the text, and find a
small glyph there on the next visit. It does no AI work; everything goes to
the running app.

```
 page ──content script──▶ background ──┬─ Chrome/Firefox: native messaging ──▶ gloss-bridge ──▶ ~/.gloss/bridge.sock ─┐
                                       └─ Safari: sendNativeMessage ──▶ Gloss Extension.appex ──▶ 127.0.0.1:<port> ──┤
                                                                                                        engine/src/bridge ◀┘
```

- **Pages are conversations.** Each page (keyed by a canonical URL computed in
  `engine/src/pages.rs`: tracking parameters dropped, query sorted, fragment
  dropped unless it is a hash route) owns one conversation, so the agent keeps
  the page in context across asks. Each ask is a clarification whose
  `web_anchor` holds a W3C-style selector (exact quote with prefix and suffix,
  character position, container hint); `anchor_block_id` is empty for those.
  The page's readable text goes into the first prompt and again only when its
  hash changes. The rail lists pages under **Pages**.
- **One protocol, two transports.** `engine/src/bridge/` handles requests
  and fans the engine's event broadcast out to every connection (`docs/api.md`
  has the method table). The `gloss-bridge` sidecar (`bridge/`) is what
  browsers spawn for native messaging; Gloss writes the host manifests for
  every installed browser on each launch. Safari cannot use native messaging
  from a Tauri app and blocks `ws://` from an extension, so the Safari
  extension's own Swift handler (`safari/handler/`) relays each message over
  loopback TCP, authenticated by a per-launch token in `bridge.json`, which
  the sandboxed handler reads from the App Group container.
- **Re-anchoring is the extension's job.** It resolves an anchor by exact
  text at the stored position, then by prefix and suffix among repeats, then
  inside the container, then fuzzily; what it finds (or not) is reported back
  and shown in Gloss as "approximate" or "not on the page any more".
- **The app stays up.** Closing the window hides Gloss to a menu-bar icon so
  the bridge keeps answering; Quit is in the tray menu and the app menu. A
  `gloss://pages/<url key>` link opens a page in the window, which is how the
  extension launches the app when it is not running.

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

Show the project's diff after an editing turn, with a revert per turn;
relay prompts for Gemini (ACP), Codex (app server) and Pi (RPC mode); import
an existing agent session into Gloss; branch at a turn; ask another agent
the same question side by side.
