# Project folders, phase 2: modes and the agent's requests

Phase 1 binds a conversation to a folder with read-only file tools. Phase 2
lets the user pick a working mode the CLI offers, and relays the agent's
permission prompts and questions where the CLI can hand them to a host.
This note records what each CLI offers and what was built on it; the
protocol details Gloss relies on are in `docs/agents.md`.

Verified from `--help` and live runs on this machine on 2026-10-17, except
Codex, which is not installed; its details come from its documentation.

## What each CLI offers

| Agent | Modes | Can hand prompts to a host headlessly? | Questions to the user |
| --- | --- | --- | --- |
| Claude Code 2.1.302 | `--permission-mode` manual, acceptEdits, auto, plan, dontAsk (bypassPermissions refused under `--restricted`) | Yes: `--permission-prompt-tool stdio` with stream-json in and out; `control_request` / `control_response` lines, suggestions to switch mode included | Yes: `AskUserQuestion` goes through the same channel with `requires_user_interaction` |
| Gemini CLI 0.49 | `--approval-mode` default, auto_edit, yolo, plan | Not in `-p` mode. Its ACP mode (`gemini --acp`, JSON-RPC over stdio) does: `session/request_permission` with `allow_once`/`allow_always`/`reject_once`/`reject_always` options, modes advertised in the session with `session/set_mode` to switch | Through ACP only |
| Codex CLI | `--sandbox` read-only, workspace-write, danger-full-access; `--ask-for-approval never` in exec | Not in `codex exec`, which never prompts. `codex app-server` (JSON-RPC over stdio) does: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, decisions accept / acceptForSession / decline; `turn/start` takes `approvalPolicy` and `sandboxPolicy` per turn | `tool/requestUserInput` (experimental) in the app server |
| Cursor Agent 2026.10.16 | `--mode` plan, ask; agent mode without the flag; `--force` for commands | No: print mode writes files without asking and rejects shell commands outright (observed: the agent retries, then gives up) | No |
| Pi 0.79 | Tool sets only (`--tools`) | Not in print mode. `pi --mode rpc` keeps a process alive with `prompt` commands and `extension_ui_request` / `extension_ui_response` for select, confirm and input dialogs | `ask_question` tool, through RPC mode |

## What was built

- Modes are read from each CLI's help output at detection time and shown
  in a picker in the header of a project-bound conversation; the chosen id
  is stored on the conversation and mapped to the CLI's flag on every
  spawn, so switching mid-conversation applies on the next turn, resumed
  session included.
- The engine keeps an agent's stdin open and pauses the idle timeout while
  a request is pending; adapters turn CLI-specific requests into a common
  card (permission or question) and encode the answer back.
- Claude Code is wired up on its stdio protocol. The others get modes but
  no relay: Gemini's `default` mode fails on anything needing approval
  headlessly, Cursor's print mode never asks, Codex and Pi never prompt in
  exec/print mode.

## Next steps

1. **Changed-files view.** After an editing turn in a git folder, show
   `git status --porcelain` and `git diff` for the turn in a side pane, with
   a revert per turn (`git checkout -- <files>` plus removing new files) when
   the files were clean before the turn. Folders without git get a snapshot
   of path, size and mtime before and after the turn and a list of changes.
2. **Gemini over ACP** for prompts and mode switching in the same session.
3. **Codex over the app server**, which also gives per-turn mode changes.
4. **Pi over RPC mode** for its `ask_question` tool and extension dialogs.
5. **Concurrent edits.** Warn when a second edit-enabled conversation on the
   same folder starts a turn while another is running.

Sources: [Claude Code permission modes](https://code.claude.com/docs/en/permission-modes),
[Gemini CLI ACP mode](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md),
[ACP tool calls](https://agentclientprotocol.com/protocol/tool-calls),
[ACP session modes](https://agentclientprotocol.com/protocol/session-modes),
[Codex app server](https://learn.chatgpt.com/docs/app-server),
[Cursor CLI parameters](https://cursor.com/docs/cli/reference/parameters),
Pi's `docs/rpc.md` in the installed package.
