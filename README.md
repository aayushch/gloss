# Gloss

Inline clarifications for CLI-agent conversations.

Gloss is a local desktop chat app that runs on top of the coding agents you
already have installed: Claude Code, Codex CLI, Gemini CLI, Pi and Cursor
Agent. It drives them in their non-interactive modes, renders the conversation
like a desktop chat client, and adds one thing those clients lack:

> Highlight any text in a response, ask about it, and the answer appears
> inline under that sentence, collapsible, with threaded follow-ups.

A *gloss* is a short explanation written beside a word in a text.

Also in the box: artifacts (a page, drawing, diagram, document or file the
agent writes shows as a card in the reply and opens in a side pane with a
sandboxed preview, versions and save), attachments of images and text files,
full-text search across every conversation, pinned and tagged conversations,
and export of a reply or a whole conversation as Markdown with the
clarifications folded in under the sentences they were asked about.

## Stack

- Frontend: Svelte 5 (runes) + SvelteKit static build, plain CSS, Shiki
- Shell: Tauri 2
- Engine: Rust crate (`engine/`), linked into the shell; SQLite via rusqlite

See `docs/architecture.md`, `docs/agents.md` (how each CLI is driven and its
caveats) and `docs/api.md` (shell ↔ frontend contract).

## Install

Download the installer for your platform from the GitHub release:

| Platform | File |
| --- | --- |
| macOS (Apple Silicon or Intel) | `Gloss_<version>_aarch64.dmg` or `Gloss_<version>_x64.dmg` |
| Windows | `Gloss_<version>_x64-setup.exe` (NSIS) or `Gloss_<version>_x64_en-US.msi` |
| Linux | `Gloss_<version>_amd64.AppImage`, `.deb` or `.rpm` |

Unsigned macOS builds are blocked by Gatekeeper on first launch: right-click
the app and choose Open, or run `xattr -dr com.apple.quarantine /Applications/Gloss.app`.
Linux `.deb`/`.rpm` packages use the system WebKitGTK; the AppImage bundles it.

Gloss needs at least one agent CLI on your PATH: `claude`, `codex`, `gemini`,
`pi` or `cursor-agent`. On macOS and Linux the login shell's PATH and
environment are captured at launch, so agents installed by npm, Homebrew or
Cargo are found even when the app is started from the Dock.

## Requirements (development)

- Rust 1.85+, Node 20+
- Linux: `sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf`
- Windows: the Microsoft C++ Build Tools and WebView2 (preinstalled on Windows 10/11)
- macOS 27 with Rust older than 1.98: release builds only work because the
  workspace profile disables symbol stripping (see the note in `Cargo.toml`);
  `rustup update` to 1.98 or newer removes the need for it

## Develop

```bash
cd ui
npm install
npm run tauri dev        # opens the app; rebuilds on change
```

Frontend only, in a browser with mocked agents:

```bash
cd ui && npm run dev     # http://localhost:1420
```

Engine without the UI:

```bash
cargo run -p gloss-engine -- agents
cargo run -p gloss-engine -- new --agent claude --model haiku
cargo run -p gloss-engine -- send <conv-id> "Reply with exactly: pong"
```

Set `GLOSS_HOME` to use a different data directory (default `~/.gloss`).

## Verify

```bash
cargo test -p gloss-engine
cd ui && npm run check && npm test && npm run build
```

## Package

```bash
scripts/build.sh                     # installers for this machine's platform
scripts/build.sh --universal         # macOS: one app for Apple Silicon and Intel
scripts/build.sh --sign "Developer ID Application: …"   # signed macOS build
```

Output lands in `target/release/bundle/` (`dmg/`, `macos/`, `nsis/`, `msi/`,
`appimage/`, `deb/`, `rpm/`). Each platform can only package for itself.

## Release

1. `scripts/set-version.sh 0.2.0` and commit.
2. `git tag v0.2.0 && git push --tags`.
3. The `Release` workflow builds macOS (arm64 and x64), Windows x64 and Linux
   x64 installers and attaches them to a draft release named after the tag.
   Publish the draft when the assets look right.

Signing is optional. Add the `APPLE_*` secrets for a signed and notarized
macOS build and `WINDOWS_CERTIFICATE`/`WINDOWS_CERTIFICATE_PASSWORD` for
Authenticode; without them the installers are unsigned. The `CI` workflow runs
the tests and compiles the app on all three platforms for every push.
