# Agent CLIs: how Gloss drives them

Gloss never talks to a model API. Every turn spawns the agent's CLI in its
non-interactive mode, with stdin closed, inside `~/.gloss/workspace`, and parses
the JSON it streams on stdout. Each conversation is bound to one agent; the
agent's own session id is stored so later turns resume that session.

Verified on this machine on 2026-10-13 unless marked otherwise.

## Common rules

- **Working directory.** `~/.gloss/workspace` (empty, created on first run)
  unless the conversation is bound to a project folder, in which case the CLI
  starts in that folder. Every agent keys its history by cwd, so workspace
  sessions land in one bucket per agent and never show up in a real project's
  resume picker, while project-bound sessions appear in that project's own
  history by design.
- **Project folders.** A bound conversation starts read-only: Claude Code
  runs with `--restricted` and the Read, Glob, Grep and LS tools pre-approved
  (plus the web tools), which also confines the file tools to the folder and
  skips the project's settings files and hooks; Pi gets
  `--tools read,grep,find,ls`; Codex, Gemini and Cursor use their read-only
  modes. Gemini gets `--include-directories` with the attachments directory
  so `@` image references outside the folder still resolve.
- **Modes.** The user can switch a bound conversation to one of the modes
  the CLI offers. The list is read from the CLI's own `--help` at detection
  time, so it tracks the installed version; each adapter maps the chosen id
  to its flag on every spawn, resumed sessions included, so a switch applies
  from the next turn. Read-only is Gloss's own mode and is not in the list.

  | Agent | Modes read from | Flag per turn | Prompts reach the user? |
  | --- | --- | --- | --- |
  | Claude Code | `--permission-mode` choices (`bypassPermissions` dropped: `--restricted` refuses it) | `--permission-mode <id>`; a chosen mode also adds Edit, Write, MultiEdit, NotebookEdit and Bash to `--tools`, never to `--allowedTools`, so the mode decides whether they prompt | Yes, see below |
  | Gemini CLI | `--approval-mode` choices (`plan` is read-only) | `--approval-mode <id>` | No: headless runs cannot prompt, so `default` fails on anything needing approval |
  | Codex CLI | `codex exec --help`, `--sandbox` values (`read-only` is read-only) | `--sandbox <id> --ask-for-approval never` | No: exec never prompts |
  | Cursor Agent | `--mode` choices (`ask` is read-only) plus `agent` (no `--mode`: edits, commands rejected) and `force` (`--force`: commands allowed) | as named | No: print mode writes without asking and rejects commands |
  | Pi | the built-in tool list: `edit` (read set + edit, write) and `full` (+ bash) when those tools exist | `--tools <set>` | No in print mode |

- **Requests (Claude Code).** Every Claude run uses `--input-format
  stream-json` with the prompt as one user message on stdin, and
  `--permission-prompt-tool stdio --permission-prompts host`. Whenever a tool
  call needs approval, or Claude calls `AskUserQuestion`, it writes a
  `control_request` line (`request.subtype == "can_use_tool"`, `tool_name`,
  `input`, `permission_suggestions`) and waits; Gloss shows it as a card and
  writes the answer back as a `control_response` (`behavior` allow with
  `updatedInput`, optionally `updatedPermissions` with a `setMode`
  suggestion, or deny with `message`; for questions `updatedInput.answers`
  maps each question to the chosen label). The idle timeout is paused while
  a request is open. Claude keeps running after its `result` until stdin
  closes, so the engine closes stdin as soon as the turn is done. The
  `AskUserQuestion` tool is on in every conversation, project or not, since
  questions can always be relayed. Verified 2026-10-17 on 2.1.302: manual
  mode prompts for Write and the file appears only after the allow,
  `acceptEdits` on a resumed session writes without a prompt, and switching
  back to read-only makes the next turn refuse.
- **Environment.** A Tauri app launched from Finder does not inherit the login
  shell's environment. On startup the engine runs `$SHELL -ilc 'env -0'` once
  and uses that environment, with common binary directories appended to PATH,
  for agent detection and spawning. Without this Gemini (API-key auth) hangs
  forever with no output, and binaries installed by npm/brew/cargo are missing.
- **Timeouts.** The runner kills a process that prints nothing for the idle
  timeout (default 5 minutes) and reports an error. Cancel sends SIGTERM, then
  SIGKILL after 5 seconds.
- **stdout buffer.** Lines can exceed 64 KiB (a tool result carrying a file).
  The reader uses a 16 MiB line limit.
- **stderr.** Drained concurrently into a ring buffer; the last lines are
  attached to the error message when the process exits non-zero.
- **Web search.** Per-conversation toggle, default on. Each agent maps it to
  its own flags (see below). No agent gets file or shell tools in Gloss.
- **Attachments.** Files live under `~/.gloss/workspace/attachments/<id>/`,
  inside the cwd, so every CLI can reach them by path. Text files are inlined
  into the prompt for every agent. Images take one route per CLI, all verified
  on 2026-10-14 with a 32×32 red PNG unless noted:

  | Agent | Image route |
  | --- | --- |
  | Claude Code | `--input-format stream-json`, one `user` message on stdin with `text` and base64 `image` content blocks; the prompt is no longer passed as an argument. Answered "Red". |
  | Codex CLI | `--image <path>` per file (documented; Codex is not installed here). |
  | Gemini CLI | `@attachments/<id>/<name>` appended to the prompt; the headless runner expands `@` references (confirmed in the bundled source, not run: the API key here is invalid). |
  | Pi | `@attachments/<id>/<name>` arguments before the message. Answered "Red". |
  | Cursor Agent | No flag; the prompt lists the absolute paths and asks Cursor to open them with its file tool, which it does in ask mode. Answered "solid bright red". |

## Claude Code (`claude`) — verified 2.1.296

```
claude -p "<prompt>" --output-format stream-json --verbose --include-partial-messages \
  --session-id <uuid>            # first turn: Gloss chooses the id
  --resume <uuid>                # later turns
  --model <alias|full name>      # optional
  --permission-mode dontAsk --permission-prompts none
  --tools "WebSearch,WebFetch" --allowedTools WebSearch WebFetch     # web on
  --tools ""                                                           # web off
  --strict-mcp-config            # no --mcp-config given → zero MCP servers
  --append-system-prompt "<gloss note>"
  -n "<conversation title>"      # names the session in claude's own picker
```

Stream (one JSON object per line):

- `system/init`: `session_id`, `model`, `tools`, `cwd`.
- `stream_event`: Anthropic streaming events; text arrives as
  `content_block_delta` with `delta.type == "text_delta"`. A new
  `message_start` after text has been produced means a new assistant message
  (text, tool, text); insert a paragraph break.
- `assistant`: complete message with `content[]` blocks (`text`, `tool_use`,
  `thinking`). With partial messages on, text blocks duplicate the deltas, so
  only `tool_use` is read from here.
- `user`: tool results (ignored except for activity).
- `rate_limit_event`: quota window info.
- `result`: `subtype` success/error, `result` (final text), `usage`,
  `total_cost_usd`, `duration_ms`, `is_error`, `session_id`.

Caveats: `--bare` would skip CLAUDE.md and hooks but also disables OAuth, so it
is not used; the user's global `~/.claude/CLAUDE.md` loads into chat sessions.
`--system-prompt-snapshot` is on by default: the system prompt is recorded on
the first request, so a changed `--append-system-prompt` only applies to new
conversations. Session file: `~/.claude/projects/<cwd-slug>/<uuid>.jsonl`.

## Gemini CLI (`gemini`) — 0.49.0, stream shape verified from a real run

```
gemini -p "<prompt>" -o stream-json --approval-mode plan \
  --session-id <uuid>            # first turn
  --resume <uuid>                # later turns (also accepts "latest" or an index)
  -m <model>
```
Environment: `GEMINI_CLI_TRUST_WORKSPACE=true` is required. Without it a
headless run in an untrusted folder prints "Gemini CLI is not running in a
trusted directory" and exits. Web search is Gemini's built-in
`google_web_search`; plan mode is read-only and there is no flag to disable
search, so the toggle is disabled for Gemini (`supportsWebSearch` is false).

Stream (JSON lines, with plain-text noise interleaved on stdout):

- `init`: `session_id`, `model`, `timestamp`.
- `message`: `role` user|assistant, `content`; assistant chunks carry `delta: true`.
- `tool_use` (`tool_name`, `parameters`), `tool_result` (`status`, `output`).
- `result`: `status` success|error, `error: {type, message}` on failure,
  `stats` (`input_tokens`, `output_tokens`, `duration_ms`, `tool_calls`,
  per-model breakdown under `models`).
- Noise to skip: lines starting with `[STARTUP]`, "Ripgrep is not available",
  and multi-line JavaScript stack traces (`Error when talking to Gemini API …`
  followed by `    at …` lines) that precede an error `result`.

Caveats: with API-key auth and no `GEMINI_API_KEY` in the environment the CLI
printed nothing and never exited; the idle timeout is the only guard. On this
machine the configured key is currently rejected (`API_KEY_INVALID`), so the
adapter is verified against captured output only. Sessions live in
`~/.gemini/tmp/<cwd-basename>/chats/`; `--list-sessions` is per cwd.

## Codex CLI (`codex`) — not installed here; from laya's adapter and a recorded run

```
codex exec --json --sandbox read-only --ask-for-approval never [--search] [-m <model>] "<prompt>"
codex exec resume <thread_id> --json [--search] "<prompt>"
```
Stream: `thread.started` (`thread_id`), `turn.started`, `item.started|updated|completed`
with `item.type` in `agent_message` (`text`), `reasoning`, `command_execution`,
`web_search`, `todo_list`, …; `turn.completed` (`usage`); `error` (`message`).
Text arrives only as complete `agent_message` items on `item.completed`.

Caveats: the thread id cannot be chosen; it is read from `thread.started`.
Sessions are global (`~/.codex/sessions/YYYY/MM/DD/…`), so Gloss conversations
do appear in `codex resume`'s picker, with the Gloss cwd. The model list is
read from `~/.codex/models_cache.json` when present.

## Pi (`pi`) — verified 0.79.6

```
pi -p --mode json --no-tools --session-dir ~/.gloss/pi-sessions \
  --session-id <id>              # first turn
  --session <id>                 # later turns
  [--model <provider/id>] [--append-system-prompt "<gloss note>"] "<prompt>"
```
Stream: `session` (`id`, `cwd`), `agent_start`, `turn_start`,
`message_start|message_update|message_end` (`message.role`;
`assistantMessageEvent.type` in `text_start|text_delta|text_end|thinking_*|toolcall_*`,
`delta` carries text), `tool_execution_start|end`, `turn_end`, `agent_end`.
Usage is on the assistant `message_end` (`usage.input/output/cost.total`).

Pi has no web search tool; the toggle is disabled for Pi. `pi --list-models`
prints a table of the models whose provider has credentials. Sessions are
stored entirely inside `~/.gloss`, so nothing touches `~/.pi`.

## Cursor Agent (`cursor-agent`, binary also installed as `agent`) — verified

```
cursor-agent -p --trust --output-format stream-json --stream-partial-output --mode ask \
  [--resume=<chat_id>] "<prompt>"
```
Stream: `system/init` (`session_id`, `model`), `user` (echo), `thinking`
(`subtype` delta|completed), `assistant` (`message.content[].text`), `tool_call`,
`result` (`result`, `usage`, `is_error`, `duration_ms`).

Streaming: with `--stream-partial-output` the `assistant` events are word-level
deltas followed by one final `assistant` event that repeats the complete text;
the adapter drops a chunk equal to the text already assembled.

Caveats: never pass `--model`; Cursor persists it as the user's default in
`~/.cursor/cli-config.json`. The UI shows "Auto" and model selection is
disabled. The chat id cannot be chosen; it is read from `system/init`.
`cursor-agent --list-models` works. Sessions live in `~/.cursor/chats/<cwd-hash>/`.
Binary detection must not trust a bare `agent` on PATH; the resolved path has
to contain `cursor-agent`, or `--version` has to print Cursor's build id.
