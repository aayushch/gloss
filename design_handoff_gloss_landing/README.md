# Handoff: Gloss landing page

## Overview

A single-page marketing site for **Gloss** — the local desktop chat app that runs on top of installed CLI agents (Claude Code, Codex CLI, Gemini CLI, Pi, Cursor Agent) and adds inline clarifications. The page is served from GitHub Pages (like laya's `landing/`) and links to installers published by the repo's Release workflow.

Audience: developers who use CLI agents **and** broader technical users. Tone: terse, plain, non-technical examples (the demo conversation is about a sourdough starter, deliberately — no CPU internals on the marketing page).

## About the design file

`Gloss Landing.dc.html` is a **design reference built in HTML** — an interactive prototype showing intended look, copy and behaviour. It is not production code to copy. Recreate it in the repo's `landing/` folder as plain static HTML + CSS + a small vanilla JS file (same shape as laya's landing: `index.html`, `styles.css`, no build step, deployed by a `pages.yml` workflow). Open the prototype in a browser to see every state; its `<script data-dc-script>` block holds the exact demo content, mock answers, release-asset classifier and OS detection logic to port.

## Fidelity

**High-fidelity.** The page must look like the Gloss app: same tokens, type, radii and component styling as `ui/src/app.css` (warm paper, IBM Plex Sans/Mono, 8–14px radii, clay accent). Colours and measurements below are final. Copy is final unless noted.

## Page structure (top → bottom)

### 1. Sticky nav (58px)
`position: sticky; top: 0; background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: blur(10px); border-bottom: 1px solid var(--line)`. Content in the 1120px `.wrap`:
- Brand: 26px square mark (radius 8, `--text` fill, "G" in `--bg` 13px/600) + "Gloss" 15px/600. Links to `#`.
- Links (hidden < 640px): How it works `#how` · Agents `#agents` · Download `#download` — 14px, `--text-2`, no underline.
- Theme toggle: 34px ghost icon button, Lucide `moon`/`sun` at stroke 1.75, `--text-2`. Toggles `data-mode="dark"` on the page root; persist in `localStorage`, default to `prefers-color-scheme`.
- GitHub button: `.ibtn.ibtn-sm` with the GitHub mark, links to the repo.

### 2. Hero (`padding: clamp(56px,8vw,96px) 0 40px`)
Two-column grid `minmax(0,1.1fr) minmax(0,1fr)`, gap `clamp(28px,5vw,64px)`, stacks < 900px.

Left:
- Eyebrow (11px/600, uppercase, letter-spacing .1em, `--accent-text`): "A chat app for the AI agents already on your computer"
- H1 `clamp(38px,5.4vw,60px)` / 1.08 / 600 / letter-spacing −.02em, three lines: "Highlight a line." / "Ask about it." / "The answer stays in place." (third line in `--accent-text`).
- Lead 17px `--text-2`, max 52ch: "Gloss runs on Claude Code, Codex, Gemini CLI, Pi and Cursor Agent. It shows their conversations like a proper chat client and adds one thing they lack: select any text in a reply, ask about it, and the answer appears right under that sentence — without derailing the conversation."
- **Split download button** (see §7): primary pill, left half `Download for <OS>` with a download icon, right half a chevron that opens the downloads modal. Beside it a ghost "See how it works" → `#how`.
- Meta line 13px `--text-3`: `All platforms` (opens modal) · `Latest release · vX.Y.Z` · `View source` (repo).
- Footnote 14px `--text-2`: "Free and open source. Everything stays on your machine. No API keys — it uses the agents you're already signed into."

Right:
- A **well** (see §5 styling) headed "● WHY THIS EXISTS" with body copy: "Asking “wait, what does this bit mean?” in a normal chat means copy, paste, a new message — and now the conversation is about that one line instead of your actual question. Gloss keeps the question attached to the text it is about. To the agent, nothing changed: it is one more message in the same chat."
- Three stat tiles (1px `--line` border, radius 12, padding 14): **5** agents supported · **0** API keys to paste · **100%** local, open source. Number 22px/600, label 12.5px `--text-2`.

### 3. Interactive demo (`padding: 24px 0 72px`)
Header row: eyebrow "Try it — select any text in the reply below, then ask" · right-aligned note 13px `--text-3` "Interactive demo · replies are pre-written".

A 620px-tall frame (1px `--line`, radius 14, `--shadow`) reproducing the Gloss window: 224px rail (hidden < 900px; frame becomes auto-height) + conversation column. Build this as a faithful, **working** miniature of the app's own UI — reuse the real app's CSS where practical:
- Rail: New chat button, search input, "TODAY" group with the active conversation "Sourdough starter help" (count pill), its clarification sub-items (jump links), "Plan a 3-day Lisbon trip"; "YESTERDAY": "Fix my résumé summary", "Why is my basil wilting?". Footer: Gloss mark + "Gloss / via Claude Code".
- Header: title, model pill (`claude · Claude Sonnet 4.5`), "N clarifications" pill.
- Transcript: user bubble "My sourdough starter smells like nail polish remover and isn't rising much. What's going on?" then the assistant reply (markdown blocks — exact text in the prototype's `RAW` array). Two seeded clarifications: #01 on "peaks and collapses within 6–8 hours" (open), #02 nested inside #01's reply on "right at the peak" (collapsed).
- Behaviour to implement (all client-side, no network): select text inside any block → floating "Ask about this" pill 44px above the selection → click opens the inline composer under that block → Enter/Ask creates a thread with a pulsing pending indicator → after ~1s a canned reply appears (keyword-matched from the `ANSWERS` table, generic fallback otherwise) → stub in rail. Follow-up field inside each thread; nested asks inside replies; click mark/header to collapse; rail sub-item jumps and expands. Composer textareas auto-grow (cap 160px).
- Visual spec for marks, wells, header labels, follow-up row is identical to the app (see `Inline Clarifications v4` handoff / `app.css`): mark `--accent-tint` fill + 1.5px `--accent` underline, radius 3; well `--surface` on 1px `--line`, radius 10, 13px type; nested well flips to `--bg`.

### 4. How it works (`#how`, `padding: 56px 0 72px`, top rule)
Eyebrow "How a clarification works"; H2 (clamp 26–34px/600) "Three steps. The agent sees an ordinary message."
Three steps in a 3-col grid (gap 28, stacks < 900): 44px numbered tile (radius 12, `--accent-tint` bg, `--accent-text` mono digit) + title 17px/600 + 14.5px `--text-2` copy:
1. **Select** — "Highlight any text in a reply — a sentence, a list item, a word in a heading, a line of code. An *Ask about this* button appears over the selection."
2. **Ask** — "A small composer opens under that paragraph. Your question is sent to the agent like any other message: the quoted text plus what you asked. Same session, same memory."
3. **Read in place** — "The answer appears under the sentence it is about — collapsible, with follow-ups threaded inside. You can highlight text in *that* answer and ask again, as deep as you need."

Then three feature cards (`--surface` bg, 1px `--line`, radius 14, padding 22; eyebrow "Also in the box"):
- **Artifacts** — "When the agent writes a page, drawing, diagram, document or file, it shows as a card and opens in a side pane — safe preview, versions, save to disk."
- **Attachments & search** — "Drop images and text files into a message. Search every conversation at once — clarifications included. Pin and tag the ones that matter."
- **Export** — "Save a reply or a whole conversation as Markdown, with each clarification folded in right under the sentence it was asked about."

### 5. Agents (`#agents`)
Eyebrow "Supported agents"; H2 "Bring the agents you already pay for."; lead: "Gloss never talks to a model API. Each message runs the agent's own command-line tool in the background, inside a private folder, so nothing shows up in your real projects. Pick the agent and model per conversation."

Table (radius 14 container, header row on `--surface`, body rows on `--bg`, 1px `--line` rules; grid `1.4fr 1fr 1fr 1fr 1fr`, 14px; collapses to 3 cols < 900):

| Agent | Command | Web search | Images | Models |
| --- | --- | --- | --- | --- |
| Claude Code | `claude` | On / off | Yes | Pick per turn |
| Codex CLI | `codex` | On / off | Yes | Pick per turn |
| Gemini CLI | `gemini` | Always on | Yes | Pick per turn |
| Pi | `pi` | — | Yes | Pick per turn |
| Cursor Agent | `cursor-agent` | On / off | Yes | Auto |

Note 13px `--text-3`: "Needs at least one of these installed: claude, codex, gemini, pi or cursor-agent. Installed via npm, Homebrew or Cargo? Found automatically, even when you launch from the Dock." (Keep this table in sync with `docs/agents.md`.)

### 6. Download (`#download`)
Two columns `minmax(0,1fr) minmax(0,1.2fr)`.
Left: eyebrow "Download"; H2 "Get Gloss"; lead "macOS, Windows and Linux. Builds are produced by GitHub Actions and published on the releases page; this list is read live from the latest release."; primary pill `Download for <OS>` + outline pill "All releases on GitHub"; version line.
Right: compact asset list (radius 14, `--surface` container): one row per asset — line 1 `Platform  arch  [Recommended]`, line 2 `Format · size` (13.5/12.5px), Download button on the right; recommended row tinted `--accent-tint`. Footer line with the per-OS install note (§7).

### 7. Downloads: GitHub releases integration (port from laya's `landing/index.html`, lines ~1469–1657)
- `REPO = '<owner>/gloss'`. On load, `fetch('https://api.github.com/repos/'+REPO+'/releases/latest')`. Read `tag_name` (strip leading `v`) and `assets[]`.
- Classify assets by filename; **ignore anything not in this list** (`.sig`, `.sha256`, `latest.json`, source archives):
  - `*.dmg` → macOS; arch `arm64` if name contains `aarch64|arm64` (label "Apple Silicon"), else `x64` ("Intel"); format "Disk image (.dmg)"
  - `*-setup.exe` / `*.exe` → Windows x64, "Installer (.exe)"
  - `*.msi` → Windows x64, "MSI package"
  - `*.AppImage` → Linux x64, "AppImage"
  - `*.deb` → Linux x64, ".deb (Debian / Ubuntu)"
  - `*.rpm` → Linux x64, ".rpm (Fedora / RHEL)"
  Only assets actually present in the release are rendered — the page must never advertise a build the workflow didn't publish. Check `.github/workflows/release.yml` for the current target matrix (expected: aarch64-apple-darwin, x86_64-apple-darwin, x86_64-pc-windows-msvc, x86_64-unknown-linux-gnu; Tauri emits dmg ×2, exe (+msi if enabled), AppImage, deb (+rpm if enabled)).
- Detect OS from `navigator.platform` / UA (macos / windows / linux) and arch (arm64 if UA has `arm|aarch64`, or `MacIntel` with `maxTouchPoints > 1`). Recommended = asset matching OS+arch, else first asset for that OS.
- Sort: detected OS first, then macOS → Windows → Linux, then by format rank.
- Hero + Download-section buttons: `href` = recommended asset URL with `download` attr, label `Download for <OS>`; fall back to `https://github.com/<repo>/releases/latest` and label "Download Gloss" if no match.
- Version label: "Latest release · vX.Y.Z". On fetch failure show "Couldn't reach GitHub right now. Open the latest release →" in the list, keep buttons pointing to `/releases/latest`.
- **Downloads modal** ("All platforms" / split-button chevron): 640px dialog, title "Download Gloss", sub "Latest release · vX.Y.Z · pick the build for your platform.", full table (Platform / Format / Arch / Size / Download), footer "All releases and checksums are published on GitHub. · Browse all releases →". Close on backdrop click, ×, or Esc.
- Per-OS notes: macOS "Unsigned builds are blocked by Gatekeeper on first launch: right-click the app and choose Open." · Windows "Needs WebView2, which is preinstalled on Windows 10 and 11." · Linux ".deb and .rpm use the system WebKitGTK; the AppImage bundles it."
- Add JSON-LD `SoftwareApplication` with `downloadUrl` = releases/latest and `sameAs` = repo (as laya does).

### 8. Footer
Top rule; 13px `--text-3`: "Gloss · open source · built with Svelte, Tauri and a Rust engine · data lives in `~/.gloss`" · right: GitHub · Releases · Docs (`/tree/main/docs`).

## Design tokens (identical to the app)

Light: `--bg #f7f6f3 --surface #efede8 --surface-2 #e6e3dc --text #26241f --text-2 #5f5b53 --text-3 #8e897f --line #dedbd3 --accent #b4573a --accent-text #9a4328 --accent-tint #f3e2da --on-accent #fff --shadow 0 4px 16px rgba(40,30,20,.12)`
Dark (`[data-mode="dark"]`, `color-scheme: dark`): `--bg #1f1e1b --surface #2a2825 --surface-2 #34312d --text #ebe8e1 --text-2 #b3ada2 --text-3 #7f796f --line #3a3733 --accent #d4785a --accent-text #e39a80 --accent-tint #4a3128 --on-accent #1f1e1b --shadow 0 4px 16px rgba(0,0,0,.5)`
Fonts: IBM Plex Sans 400/500/600, IBM Plex Mono 400 (Google Fonts or self-hosted). Body 16px/1.6.
Controls: `.ibtn` 14px/500, padding 9px 16px, 1px `--line`, radius 8, hover `--surface`; `.ibtn-primary` accent fill; `.ibtn-ghost` borderless `--accent-text`; `.ibtn-sm` 13px / 6px 12px; pill variants radius 999. Inputs: `.iinput` 14px, 1px `--line`, radius 8, focus accent border + `0 0 0 3px --accent-tint` ring. Focus-visible 2px accent outline. `::selection` `--accent-tint`.
Layout: `.wrap` max-width 1120px, padding `clamp(20px,5vw,56px)`. Section rhythm 56/72px with 1px top rules. Breakpoints 900px (grids stack, rail hidden) and 640px (nav links hidden).

## Assets
Icons: Lucide (`download`, `chevron-down`, `plus`, `sun`, `moon`, `x`) stroke 1.75–2; GitHub mark inline SVG. No images required. Favicon: the "G" mark.

## Files
- `Gloss Landing.dc.html` — the prototype (source of truth for layout, copy, demo content, canned answers, asset classifier). Needs `support.js` beside it to open in a browser.
- `support.js` — prototype runtime only; ignore for implementation.
- Reference in the gloss repo: `ui/src/app.css` (tokens/components to mirror), `docs/agents.md` (agent table), `.github/workflows/release.yml` (asset names). Reference in laya: `landing/index.html` §"Downloads (GitHub releases)" and `.github/workflows/pages.yml` for the Pages deploy.
