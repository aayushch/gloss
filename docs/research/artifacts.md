# Research: saving and rendering generated files

Status: written 2026-10-14 as research. Implemented the same day as the
artifact pane (see `docs/architecture.md`, "Frontend model"): a prompt
convention, cards in the reply, a side pane with sandboxed previews, versions,
copy, save and open-in-browser. Levels 3 and 5 below remain open; level 4 is
partly covered because each artifact can be saved on its own.

## Where Gloss stands

Agents in Gloss have no file or shell tools, so everything they produce is
text in the reply: code blocks, HTML, SVG, CSV, Markdown. Gloss already parses
replies into blocks with a language tag, has a native save dialog command
(`save_text_file`, used by the Markdown export), and has `tauri-plugin-opener`
for opening paths with the system. Those are the building blocks.

## Levels, cheapest first

### 1. Save a code block to a file

A "Save…" button in the code block header next to "Copy". The default file
name comes from the language (`snippet.py`), or from a path the agent wrote
on the line before the fence or as a comment on its first line, which agents
do often when asked for a file. Uses the save dialog that exists. Effort:
hours.

### 2. Preview HTML and SVG blocks

A "Preview" toggle on `html` and `svg` blocks that renders the content inside
the reply. SVG can be rendered inline by the webview. HTML must go into a
sandboxed `<iframe sandbox srcdoc=…>`.

Security is the whole problem here. The app webview has IPC access to the
engine, so agent-written HTML must never run with the app's origin:

- `sandbox` without `allow-same-origin` gives the frame an opaque origin, so
  scripts inside it cannot reach the app's DOM or Tauri's IPC bridge. Adding
  `allow-scripts` is then acceptable; `allow-same-origin` together with
  `allow-scripts` is not.
- The CSP in `tauri.conf.json` applies to srcdoc frames too, so it needs a
  `frame-src`/`child-src` entry and, if scripts should run inside previews,
  the preview content needs its own policy. Simplest: previews start with
  scripts disabled and a "Run scripts" button that re-renders the frame with
  `allow-scripts`.
- External network requests from a preview (images, fonts, fetch) should be
  blocked by the frame's CSP; an agent-written page that phones home is a
  data-exfiltration path for whatever the user pasted into the chat.

Effort: a day, most of it the CSP and a test matrix across WebKit (macOS,
Linux) and WebView2.

### 3. A separate preview window

For richer previews (a full page with scripts, resizable, printable), open a
second Tauri window that loads the artifact from a file under
`~/.gloss/artifacts/` through the asset protocol, with no capabilities
granted to that window. It cannot call commands at all, which is a stronger
boundary than an iframe. Effort: a day or two, including window management
and the asset scope.

### 4. Multi-file artifacts

Agents can produce several files in one reply. Parsing fences into files is
unreliable, so the useful move is a prompt convention: ask the agent to wrap
files as

```
<file path="src/app.py">
…
</file>
```

when the user asks for files. Gloss then shows an artifacts pane (file list,
per-file preview, "Save all…" into a chosen folder via a directory picker).
Storage: `~/.gloss/artifacts/<conversation>/<turn>/…` with an `artifacts`
table mirroring `attachments`. "Reveal in Finder" comes free from the opener
plugin. Effort: several days; the pane is the main work.

### 5. Beyond text

Binary output (images, PDFs) needs tools the agents do not have in Gloss, by
design. The route would be a per-conversation "allow writes inside the Gloss
artifacts folder" permission, which hands agents a sandboxed write tool
(Claude `--allowedTools "Write(~/.gloss/artifacts/**)"`, Codex
`--sandbox workspace-write` with the artifacts dir as cwd). That is a real
policy change from "chat plus web only" and should be its own decision.

## Recommendation

Do level 1 now; it is small and immediately useful. Do level 2 next with
scripts disabled by default. Treat levels 4 and 5 as a separate project with
its own design pass, since they change what an artifact is and what agents
may do.
