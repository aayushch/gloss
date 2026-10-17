# Project folders, phase 2: letting agents edit

Phase 1 binds a conversation to a folder with read-only file tools. This note
gathers what phase 2, letting the agent change files, would need. Nothing
here is implemented.

## What each CLI offers

Verified from `--help` on this machine on 2026-10-17, except Codex, which is
not installed; its flags come from its documentation.

| Agent | Read-only today | Edit mode | Also runs commands? |
| --- | --- | --- | --- |
| Claude Code | `--restricted --tools Read,Glob,Grep,LS` with `--permission-mode dontAsk --permission-prompts none` | add `Edit,Write,MultiEdit,NotebookEdit` to `--tools`/`--allowedTools` and use `--permission-mode acceptEdits`, which approves edits inside the working directories (`--add-dir` extends them) | Only if `Bash` is added to the tool list; `--restricted` keeps it out otherwise. `bypassPermissions` is refused under `--restricted`. |
| Pi | `--tools read,grep,find,ls` | `--tools read,grep,find,ls,edit,write` | `bash` is a separate tool name; leave it out. |
| Codex CLI | `--sandbox read-only --ask-for-approval never` | `--sandbox workspace-write --ask-for-approval never` (`--full-auto` is the same pair); writes are confined to the cwd and its temp dirs, network stays off inside the sandbox | Commands run inside the sandbox in both modes; there is no flag to disable them. |
| Gemini CLI | `--approval-mode plan` | `--approval-mode auto_edit`, which auto-approves the edit tools and refuses everything else headlessly (no prompt is possible) | `yolo` approves shell too; not wanted. |
| Cursor Agent | `--mode ask` | no edit-only mode: dropping `--mode` gives the default agent mode, which edits and runs commands subject to its own allowlist; `--force`/`--yolo` lift that | Yes in the default mode; cannot be separated from edits. |

So three agents have a clean "edit files, no shell" mode (Claude, Pi,
Gemini), Codex always allows sandboxed commands, and Cursor cannot edit
without also being allowed to run commands. Phase 2 should probably offer
editing for Claude, Pi and Gemini first, Codex with a note about sandboxed
commands, and leave Cursor read-only.

## Showing the user what changed

The point of a per-conversation edit switch is that the user sees every
change the agent made, in the app, as it lands.

- **Git folders.** Record `HEAD` and the working-tree state when the turn
  starts, then after the turn show `git status --porcelain` plus
  `git diff` (and `git diff --no-index` against `/dev/null` for new files).
  Shell out to `git` rather than linking libgit2, since every machine with
  these CLIs has git. Show the diff in a side pane like the artifact pane,
  file by file, with the turn that produced it. Offer "revert this turn's
  changes" through `git checkout -- <files>` and deleting the new files,
  only when the files were clean before the turn.
- **Folders without git.** Snapshot the tree cheaply before the turn: path,
  size and mtime of every file (skip `node_modules`, `target`, `.git` and
  the like), then compare after. Changed files can be diffed against a copy
  taken before the turn for files under a size limit; above it, just name
  them. No revert without git.
- **Attribution.** Each turn's diff summary (files added, changed, deleted,
  lines) is stored with the assistant turn so the transcript can show a
  "changed 3 files" line that opens the pane later.

## Guard rails

- **Per-conversation switch, off by default**, with a confirmation naming
  the folder the first time it is turned on. Phase 1's read-only bound
  conversation stays the default.
- **Never outside the folder.** Claude's `--restricted` already confines its
  file tools; Codex's sandbox does too; Pi and Gemini rely on the system
  note and the cwd, so the diff check above is also the safety net: files
  outside the folder cannot be shown or reverted, so the note must say so.
- **Project hooks and settings.** `--restricted` makes Claude skip the
  project's settings files and hooks even in edit mode. Gemini loads the
  project's `GEMINI.md`; Pi loads its own config. Keep the one-line warning
  from phase 1 in the folder picker.
- **Concurrent edits.** One running turn per conversation is already
  enforced; two conversations bound to the same folder could edit at once.
  Warn when a second edit-enabled conversation on the same folder starts a
  turn while another is running.
- **Dirty trees.** If the folder has uncommitted changes when the switch is
  turned on, say so, since a later revert could not tell the agent's changes
  from the user's.

## Open questions for the user

1. Edit mode for Claude, Pi and Gemini only at first, or also Codex with its
   sandboxed commands?
2. Should a revert be offered at all in the first version, or only the diff?
3. Is a folder without git acceptable for editing, or should edit mode
   require a git repository so every change is revertable?
