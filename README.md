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
full-text search across every conversation and find within the open one
(Cmd/Ctrl+F), pinned and tagged conversations,
and export of a reply or a whole conversation as Markdown with the
clarifications folded in under the sentences they were asked about.

The same gesture works in the browser: the Gloss extension (Chrome-family,
Firefox and Safari) puts "Ask about this" on any highlighted passage of a
web page, shows the reply in a popover anchored to it, and leaves a mark
that returns on the next visit. Every page you asked about is listed under
**Pages** in Gloss. See `docs/extension.md`.

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
cargo test -p gloss-engine -p gloss-bridge -p gloss-app
cd ui && npm run check && npm test && npm run build
cd extension && npm run check && npm test && npm run build
```

`gloss-engine serve --loopback` runs the browser bridge without the app and
`node scripts/bridge-smoke.mjs` drives the native-messaging host like a
browser would.

## Package

```bash
scripts/build.sh                     # installers for this machine's platform
scripts/build.sh --universal         # macOS: one app for Apple Silicon and Intel
scripts/build.sh --sign "Developer ID Application: …"   # signed macOS build
scripts/build.sh --safari            # macOS: also build the Safari extension into Gloss.app (needs Xcode)
```

The `gloss-bridge` sidecar is built and placed automatically before every
`tauri dev` and `tauri build`. The Firefox add-on is bundled when
`ui/src-tauri/resources/gloss.xpi` holds a signed file; the release workflow
puts one there (with the `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` secrets), a
local build ships an empty placeholder and the Firefox button stays off.

Output lands in `target/release/bundle/` (`dmg/`, `macos/`, `nsis/`, `msi/`,
`appimage/`, `deb/`, `rpm/`). Each platform can only package for itself.

## Release

1. `scripts/set-version.sh 0.2.0` and commit.
2. `git tag v0.2.0 && git push --tags`.
3. The `Release` workflow builds macOS (arm64 and x64), Windows x64 and Linux
   x64 installers and attaches them to a draft release named after the tag,
   with the updater bundles and `latest.json` beside them. Publish the draft
   when the assets look right.

Installed copies check that `latest.json` a few seconds after launch and every
two hours, offer the new version in the rail, and install it in place after a
restart. Updater bundles are signed with a minisign key: the public half lives
in `ui/src-tauri/tauri.conf.json`, the private half must be in the
`TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets,
or the release build fails. Keep that key safe; a lost key means shipped apps
can never update again. The Linux updater works for the AppImage only.

Platform signing is optional. Add the `APPLE_*` secrets for a signed and
notarized macOS build and `WINDOWS_CERTIFICATE`/`WINDOWS_CERTIFICATE_PASSWORD`
for Authenticode; without them the installers are unsigned. The `CI` workflow
runs the tests and compiles the app on all three platforms for every push.

## Icons

The app icon lives in `design/icon/`: `gloss-dark.svg` and `gloss-light.svg`
are the mark on each theme, and `Gloss.icon` is an Icon Composer package with
a light and a dark appearance. `scripts/icons.sh` regenerates everything in
`ui/src-tauri/icons/` from them: the PNG and ICO set for Windows, Linux and
the window, `icon.icns` for macOS 15 and older, and `Assets.car`, the compiled
package that macOS 26 and newer read (`CFBundleIconName` in
`ui/src-tauri/Info.plist`), switching between the light and dark icon with
the system appearance. The script needs librsvg and Xcode 26 or newer; the
generated files are committed, so a release build does not run it.

## Landing page

`landing/` is the static site at <https://aayushch.github.io/gloss/>: plain
HTML, CSS and one script, no build step. The `Deploy landing page` workflow
publishes it to GitHub Pages on every push to `main` that touches that folder.
The download section reads the latest release from the GitHub API, so it
always lists exactly the installers the `Release` workflow produced.
