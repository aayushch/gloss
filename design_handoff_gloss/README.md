# Handoff: Gloss — inline clarifications for CLI-agent conversations

## Overview

**Gloss** is a local desktop chat UI that runs on top of CLI coding agents already installed on the machine (Claude Code, Codex CLI, Gemini CLI). It renders their conversations the way their desktop counterparts do, plus one defining feature:

> **Highlight any text in a response → ask about it → the answer appears inline, directly under that sentence, collapsible, with threaded follow-ups.**

Crucially, a clarification is **just another turn** sent to the agent (the same as if the user typed "explain X" in the main composer). The only thing the UI does differently is *where it renders the answer* (inline, anchored to the highlighted span) and *how it is listed* (a stub in the transcript and an entry in the navigation rail). The agent receives the quoted text plus the question as a normal user message; nothing about the agent protocol changes.

A *gloss* is a short explanation written beside a word in a text — which is exactly what an inline clarification is.

## About the design files

The files in this bundle are **design references created in HTML** (`Inline Clarifications v4.dc.html` and its earlier iterations). They are prototypes that show intended look and behaviour; they are **not production code to copy**. The task is to **recreate these designs in the target codebase's environment** (Electron/Tauri + React, Swift, etc.) using its own patterns and libraries. If no codebase exists yet, choose a desktop-shell stack that can spawn and stream from local CLI processes (Tauri + React + TypeScript is a sensible default) and implement there.

Earlier files (`v1`, `v2`, `v3`) are kept for history only. **`Inline Clarifications v4.dc.html` is the source of truth**; within it, options **4a** (light) and **4b** (dark) are the same design with different default theme.

## Fidelity

**High-fidelity.** Colours, type, spacing, radii and interactions in v4 are final and should be reproduced faithfully. The sample *content* (a conversation about compare-and-swap) is placeholder. Earlier files that use the "Modernist"/"Industry" design systems are superseded.

## Screens / views

There is one screen: the conversation window. It is composed of a navigation rail, a conversation column, and overlays (model menu, settings sheet, floating "Ask about this" button).

### 1. App shell

- Window content area: `background: --bg`, `color: --text`, font `IBM Plex Sans` 15px / 1.55.
- Two columns: **Rail** 232px fixed · **Conversation** `flex: 1; min-width: 0`.
- The prototype shows the shell at 900×860 inside a 14px-radius card; in the real app it fills the window.

### 2. Navigation rail (left, 232px)

`background: --surface; border-right: 1px solid --line; padding: 12px 10px; display: flex; flex-direction: column; gap: 10px`.

Top to bottom:

1. **New chat** button — full width, `.ibtn` style (see tokens), label left-aligned with a 14px Lucide `plus` icon, `background: --bg`.
2. **Search** input — `.iinput`, height 30px, 12.5px text, placeholder "Search conversations".
3. **Conversation list** (scrolls): groups "Today", "Yesterday", "Last week" (group label 10.5px/600, uppercase, letter-spacing .08em, `--text-3`, padding 10px 10px 4px).
   - **Conversation item** (`.navitem`): full width, padding 7px 10px, radius 8px, 13px, `--text-2`; hover → `background: --surface-2; color: --text`; active (`aria-current="page"`) → same background, `--text`, weight 500. Title truncates with ellipsis. If the conversation has clarifications, a count pill on the right: 10.5px, `--accent-text` on `--accent-tint`, padding 1px 6px, pill radius.
   - **Clarification sub-items** appear only under the *active* conversation (`.navsub`): padding 5px 10px 5px 22px, 12px, `--text-2`, 5px accent dot, label `Clarification 01 · <quote truncated to 26 chars>`; nested clarifications are indented a further 12px (`padding-left: 34px`). Clicking jumps to and expands that clarification in the transcript.
4. **Footer** (`border-top: 1px solid --line; padding-top: 10px`): app mark (24px square, radius 7px, `--text` fill, "G" in `--bg` 12px/600), then two lines — "Gloss" 13px/600 `--text` and "via Claude Code" 11px `--text-3` (active agent name) — then two 30px icon buttons: **Settings** (Lucide `settings`) and **Theme toggle** (Lucide `moon` in light mode / `sun` in dark mode), stroke 1.75, `--text-2`.

### 3. Conversation column

#### 3a. Header
`display: flex; align-items: center; gap: 10px; padding: 12px 16px 12px 24px; border-bottom: 1px solid --line`.
- Title 14px/600, truncates.
- **Model pill** (right): pill (radius 999px) `background: --surface`, padding 4px 8px 4px 10px, content `agent-command` (11px mono, `--text-3`) + `Model name` (12px, `--text`) + 12px chevron. Click opens the **model menu** (see Overlays).
- **Count pill**: "N clarifications" 12px `--text-2` on `--surface`, padding 3px 9px.

#### 3b. Transcript (scrolls; `padding: 20px 28px 32px; position: relative`)
- **User message**: right-aligned bubble, max-width 78%, `--surface`, padding 10px 14px, 14px/1.5, radius `14px 14px 4px 14px`.
- **Assistant response**: rendered markdown (see *Rich content*), 15px/1.6, blocks spaced 10px.
- **Transcript stubs** (after the response, `margin-top: 22px; gap: 6px`): one per clarification in creation order — full-width row, `border: 1px dashed --line`, radius 10px, padding 8px 12px, 12px `--text-2`: accent dot · `Asked about "<quote 36 chars>"` · right: `N turns · just now` (`--text-3`) · `View inline →` (`--accent-text`, 500). Nested clarifications are prefixed `↳ `. Click → jump to the inline block.

#### 3c. Composer (bottom)
`padding: 8px 16px 14px; display: flex; gap: 8px; align-items: flex-end` — **no top border** (the rail footer keeps its own rule; the chat side must not draw a competing line).
- Textarea `.iinput`, radius 18px, padding 8px 14px, `rows=1`, min-height 36px, **auto-grows to max 200px** then scrolls internally, `resize: none`.
- **Send** primary button, pill, height 36px.

### 4. Rich content (applies to responses *and* to clarification replies)

Model output is markdown and must render as markdown:

- Headings (`h4` 17px/600, margin 22px 0 8px), paragraphs, bullet lists (5px round bullet `--text-2`, 13px gap), nested numbered lists (number column 22px, 13px `--text-2`, indented 34px), **bold** (600), *italic*, inline `code` (mono, .87em, `--surface-2` background, padding 1px 5px, radius 4px).
- **Fenced code blocks must be syntax-highlighted.** Container: `--surface` (or `--surface-2` when nested inside a clarification) background, 1px `--line` border, radius 10px, header row with the language label (11px `--text-3`, bottom rule), `<pre>` padding 12px 14px, mono 12.5px / 1.65, horizontal scroll. Token colours come from the `--syn-*` palette (keyword, type, function, number, string, comment) which has a light and a dark variant. Use a real highlighter (Shiki or Prism) mapped onto these six roles; the prototype's regex tokenizer is a stand-in only.
- Whenever a code block has a clarification anchored to it, its header shows `● clarified below` on the right (accent dot, `--accent-text`, 11px) instead of an in-text mark.

### 5. Highlight-to-ask

1. User selects text inside **any** rendered block of an assistant turn (paragraph, list item, heading, inline code, code block, or any block inside a clarification reply). Selection must be inside a single block; cross-block selections are ignored.
2. On mouse-up a floating **"Ask about this"** primary pill button appears 44px above the selection, horizontally centred on it (clamped 70px from the edges of the transcript), `box-shadow: --shadow`, 13px, padding 6px 12px, `z-index` above content. It disappears on any click elsewhere / collapsed selection.
3. Clicking it (handle on `mousedown` + `preventDefault` so the selection survives) clears the native selection, renders the quoted span as a **highlight mark** and opens an **inline composer** directly below that block.
   - Mark: `background: --accent-tint; border-bottom: 1.5px solid --accent; padding: 1px 3px; radius 3px; box-decoration-break: clone`; it keeps the span's original formatting (bold / code / italic). Clicking a mark toggles its clarification open/closed.
4. **Inline composer** (a *well*, see §6): header "● CLARIFICATION  re "<quote>"", textarea (rows 2, min 52px, auto-grows to 160px), **Ask** primary + **Cancel** secondary. Enter sends (Shift+Enter newline). Focus moves into the textarea automatically.
5. On send the UI creates a clarification thread anchored to `(blockId, quote)`, shows the question and a pulsing three-dot pending indicator, and dispatches the turn to the agent as an ordinary user message:

   ```
   > "<quoted text>"
   <user's question>
   ```
   (A short system/prefix note such as "The user is asking about this excerpt of your previous answer" may be added by the adapter; the agent's transcript simply gains one more turn.)
6. The streamed reply fills the thread; the transcript stub and the rail sub-item appear at the same time; the header count increments.

### 6. Clarification block ("well")

Rendered **directly below the block that contains the highlight**, indented 28px from the response's left edge, margin 8px 0 20px.

- Container: `background: --surface; border: 1px solid --line; radius 10px; font-size 13px; overflow hidden`. When nested inside another well the background flips to `--bg` so depth stays legible.
- **Header** (clickable, toggles collapse): padding 8px 12px, 11px/600, uppercase, letter-spacing .06em, `--accent-text`: accent dot · `Clarification 01` · `re "<quote 44 chars>"` (normal case, `--text-2`, truncates) · `N turns` (`--text-3`) · chevron (rotates 180° when open, 150ms).
- **Collapsed** = header only.
- **Turn rows**: `border-top: 1px solid --line; padding: 9px 12px; grid 40px 1fr; gap 4px 10px`. Column labels `YOU` (`--text-3`) and `REPLY` (`--accent-text`) at 10px/600 uppercase .08em. Question 13px/500 `--text`; reply 13px/1.5 `--text-2`, rendered with the full rich-content pipeline (§4) at this smaller size (code blocks 12px, nested code 11.5px).
- **Follow-up row**: `border-top; padding 6px 12px 8px 62px` (aligns with the reply column): `.iinput` 28px high 12px text, placeholder "Follow up in this clarification…", ghost **Ask** button. Enter sends. A follow-up is appended as another turn row *in the same well*; it is also another ordinary turn for the agent.
- **Nesting**: selecting text inside a reply opens a nested well under that reply block, indented 16px, header label "Nested clarification" while composing. Nesting is unbounded in the spec; the prototype renders two levels.

Visual hierarchy goal: the main response is 15px on the page ground; clarifications are 13px in recessed wells with a labelled header, so at a glance the eye separates "the answer" from "asides about the answer".

### 7. Overlays

- **Model menu** (anchored under the header pill, right-aligned, width 260px): `--bg`, 1px `--line`, radius 10px, `--shadow`, padding 6px. Section label `MODEL · <Agent>`; one row per model (name 13px/500 + note 11.5px `--text-3`; selected row `--surface` background with accent check); footer note "Applies to new turns in this conversation." Click outside / select closes.
- **Settings sheet** (modal, centred, 480px, radius 14px, backdrop `rgba(20,16,12,.35)`): title row with close ×; sections:
  - **Agent** — intro copy; one radio-style row per agent: monogram square (28px, `--surface-2`, mono 12px), name 13.5px/500, command in mono 11.5px `--text-3`, status text (`Installed · 2.1.4` in `--text-3`, or `Not found on PATH` in `--accent-text`), radio circle (16px, accent 8px dot when selected). Selected row: `border-color: --accent; background: --surface`. Unavailable agents render at 60% opacity, `cursor: not-allowed`, not selectable.
  - **Default model · <Agent>** — same row style, with context size in mono on the right. Used for new conversations; per-conversation override lives in the header pill.
  - **Appearance** — segmented Light / Dark (selected segment accent fill, `--on-accent` text).

### 8. Agents and models (reference data used in the mock)

Agents: `claude` (Claude Code, cmd `claude`), `codex` (Codex CLI, cmd `codex`), `gemini` (Gemini CLI, cmd `gemini`). Detect availability by probing `PATH`.

Models per agent (mock values — read the real list from each CLI where possible):
- Claude Code: Claude Opus 4.1, Claude Sonnet 4.5 (default), Claude Haiku 4.5
- Codex CLI: GPT-5 Codex (default), GPT-5, o4-mini
- Gemini CLI: Gemini 2.5 Pro (default), Gemini 2.5 Flash

A conversation is bound to the agent that started it; the model may change per turn.

## Interactions & behaviour summary

| Trigger | Result |
| --- | --- |
| Select text in an assistant block (mouse-up) | "Ask about this" button floats above selection |
| Click "Ask about this" | Mark the span, open inline composer below the block, focus it |
| Enter / Ask in composer | Create thread (pending), send turn to agent, add stub + rail entry, increment count |
| Cancel | Remove composer and temporary mark |
| Click mark or well header | Toggle that clarification |
| Enter / Ask in follow-up field | Append turn in the same well, send to agent |
| Select text inside a reply | Same flow, producing a nested well |
| Click stub or rail sub-item | Expand the thread (and its parent if nested), smooth-scroll it to 80px from the top of the transcript |
| Click rail conversation | Switch conversation, scroll to top; each conversation keeps its own clarifications |
| Header model pill | Open/close model menu; choosing a model closes it |
| Rail gear | Open settings sheet; backdrop click or × closes |
| Theme toggle / Appearance segment | Flip `data-mode` light/dark |
| Typing in composer / inline composer | Auto-grow to max 200px / 160px, then internal scroll |

Transitions: chevron rotate 150ms; pending indicator = three 6px accent dots pulsing opacity .25→1 at 1s with 0/.2/.4s offsets. No other animation.

## State model

```ts
type BlockId = string;              // top-level: block id; nested: `${threadId}.${turnIndex}.${blockIndex}`
interface Clarification {
  id: number;                       // per-conversation, increasing; display number = creation order
  anchor: { blockId: BlockId; quote: string };
  open: boolean;
  turns: { question: string; reply: MarkdownBlock[] | null /* null = pending */ }[];
}
interface Conversation {
  id: string; title: string; agent: AgentId; model: ModelId;
  turns: Turn[];                    // ordinary transcript; clarification turns are included here too,
                                    // tagged with clarificationId so the transcript can render them as stubs
  clarifications: Clarification[];
}
interface AppState {
  conversations: Conversation[]; activeId: string;
  agents: { id; name; cmd; available: boolean; version?: string }[];
  defaults: { agent: AgentId; modelByAgent: Record<AgentId, ModelId> };
  theme: 'light' | 'dark';
  ui: { settingsOpen; modelMenuOpen; pendingAsk?: { blockId; quote; x; y }; composerFor?: { blockId; quote } };
}
```

Anchoring: resolve `quote` against the block's plain text (first occurrence) at render time; split the block's inline runs at mark boundaries so formatting is preserved. If the quote no longer resolves (edited response), keep the thread and render it below the block without a mark.

Persistence: conversations + clarifications persist locally (the agents own their own session files; Gloss stores the anchor metadata alongside the turn ids).

## Design tokens

Light (`[data-mode="light"]`):
```
--bg #f7f6f3   --surface #efede8   --surface-2 #e6e3dc
--text #26241f --text-2 #5f5b53    --text-3 #8e897f   --line #dedbd3
--accent #b4573a  --accent-text #9a4328  --accent-tint #f3e2da  --on-accent #fff
--shadow 0 4px 16px rgba(40,30,20,.12)
--syn-kw #7a4fa3 --syn-type #2f6f8f --syn-fn #9a4328 --syn-num #3f7a4c --syn-str #3f7a4c --syn-cmt #8e897f
```
Dark (`[data-mode="dark"]`, `color-scheme: dark`):
```
--bg #1f1e1b   --surface #2a2825   --surface-2 #34312d
--text #ebe8e1 --text-2 #b3ada2    --text-3 #7f796f   --line #3a3733
--accent #d4785a  --accent-text #e39a80  --accent-tint #4a3128  --on-accent #1f1e1b
--shadow 0 4px 16px rgba(0,0,0,.5)
--syn-kw #c39be6 --syn-type #86bcd8 --syn-fn #e39a80 --syn-num #9fcf9a --syn-str #9fcf9a --syn-cmt #7f796f
```
Type: `IBM Plex Sans` 400/500/600 (UI + prose), `IBM Plex Mono` 400 (code, commands). Scale: 10 / 10.5 / 11 / 11.5 / 12 / 12.5 / 13 / 13.5 / 14 / 15 / 17 px.
Radii: 3 (mark), 4 (inline code), 7 (small squares), 8 (inputs, buttons, nav items), 10 (wells, code blocks, menus), 14 (settings, bubbles), 18 (composer), 999 (pills).
Spacing: 4/6/8/10/12/14/16/20/22/24/28 px as listed per component.
Controls: `.ibtn` 13px/500, padding 6px 12px, 1px `--line` border, hover `--surface`, active `--surface-2`; primary = `--accent` fill / `--on-accent` text, hover brightness .94; ghost = no border, `--accent-text`, hover `--accent-tint`. `.iinput` 14px, padding 7px 10px, `--bg` fill, 1px `--line`, hover border `--text-3`, focus border `--accent` + `0 0 0 3px --accent-tint` ring. Focus-visible everywhere: 2px `--accent` outline, offset 2px. `::selection` uses `--accent-tint`.

## Assets

Icons: Lucide (`plus`, `settings`, `sun`, `moon`, `chevron-down`, `check`, `x`) at stroke 1.75. App mark is a plain "G" in a filled square — no logo file yet. Fonts from Google Fonts (IBM Plex Sans, IBM Plex Mono); bundle them locally in the desktop app.

## Files

- `Inline Clarifications v4.dc.html` — **source of truth** (4a light, 4b dark). Open in a browser; the prototype is interactive (select text → ask; rail; settings; model menu). The logic lives in the `<script data-dc-script>` block at the bottom — its `view()` function shows the exact mark-splitting and nesting algorithm.
- `Inline Clarifications v3.dc.html` — theme exploration that led to warm paper (3a/3b) and a rejected cool variant.
- `Inline Clarifications v2.dc.html`, `Inline Clarifications.dc.html` — earlier structural options on other design systems; superseded.
- `support.js` — runtime needed only to open the `.dc.html` prototypes in a browser; ignore for implementation.

## Suggested next features (not in the mock)

Pin a clarification into the response as a footnote · branch a conversation at any turn · per-conversation scratchpad visible to the agent · rewind-and-regenerate · diff view with per-hunk accept for file edits · "ask another agent the same thing" side-by-side · search across conversations including clarifications · export to Markdown/PDF with clarifications as footnotes.
