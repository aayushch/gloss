# Contributing to Gloss

Thanks for your interest in contributing to Gloss! This guide will help you get
started.

## Getting Started

### Prerequisites

- **Rust 1.85+** with cargo
- **Node.js 20+** with npm
- At least one agent CLI on your PATH: `claude`, `codex`, `gemini`, `pi` or
  `cursor-agent`
- Linux: `sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf`
- Windows: the Microsoft C++ Build Tools and WebView2
- macOS with Xcode, if you want the Safari extension built into the app

### Setup

```bash
git clone https://github.com/aayushch/gloss.git
cd gloss

npm install              # repo-wide Prettier
cd ui && npm install
npm run tauri dev        # opens the app; rebuilds on change
```

Frontend only, in a browser with mocked agents: `cd ui && npm run dev`.
Engine only, without the UI: `cargo run -p gloss-engine -- agents`.

Set `GLOSS_HOME` to point the app at a throwaway data directory instead of
`~/.gloss` while developing.

### Project Structure

| Directory | Description |
|-----------|-------------|
| `engine/` | Rust crate: agent drivers, SQLite store, bridge server |
| `bridge/` | Rust native-messaging host for Chrome-family and Firefox |
| `ui/src/` | SvelteKit + Svelte 5 frontend |
| `ui/src-tauri/` | Tauri 2 shell |
| `extension/` | Browser extension (Chrome-family, Firefox, Safari web extension) |
| `safari/` | Safari app extension and its native handler |
| `landing/` | Static site at gloss.aay.sh |
| `docs/` | Architecture, agent drivers, shell/frontend API |
| `scripts/` | Build, packaging, versioning and smoke-test scripts |

Read `docs/architecture.md` first, then `docs/agents.md` for how each CLI is
driven and `docs/api.md` for the shell ↔ frontend contract.

## Development Workflow

1. **Fork** the repository and create a feature branch from `main`.
2. **Make your changes** following the conventions below.
3. **Verify** your changes (see Verify section).
4. **Format** before committing: `npm run format` at the repo root and
   `cargo fmt --all`. CI does not check formatting.
5. **Open a pull request** against `main`.

### Branch Naming

- `feat/short-description` for features
- `fix/short-description` for bug fixes
- `docs/short-description` for documentation

### Commit Messages

- Start with a verb in imperative mood (`Add`, `Fix`, `Keep`, `Let`, `Remove`)
- Say what the change does for the user, not which files it touches
- Keep the first line under 72 characters
- Add a blank line and details if needed

## Code Conventions

### Rust (engine, bridge, shell)

- `cargo clippy --workspace --all-targets -- -D warnings` must pass; CI runs it
- Shared dependencies are declared once in the workspace `Cargo.toml`
- Each agent driver lives in its own module under the engine and is
  documented in `docs/agents.md`; a change to how a CLI is driven updates both

### UI and extension (Svelte, TypeScript)

- **Svelte 5 runes only**: use `$state`, `$derived`, `$effect`, `$props` —
  never legacy `$:` reactive declarations
- Plain CSS; no utility framework
- Anything that crosses the shell ↔ frontend boundary is documented in
  `docs/api.md`

### Comments

- Describe what the code does and why, in present tense, for someone reading
  the file for the first time
- Never describe development history or what the code used to do

### General

- Don't introduce abstractions beyond what the task requires
- Don't add speculative error handling for impossible scenarios

## Verify

```bash
cargo test -p gloss-engine -p gloss-bridge -p gloss-app
cargo clippy --workspace --all-targets -- -D warnings
cd ui && npm run check && npm test && npm run build
cd extension && npm run check && npm test && npm run build
```

CI runs the same steps on macOS, Ubuntu and Windows for every push and pull
request. The engine tests spawn no real agents, so they run without any CLI
installed.

`gloss-engine serve --loopback` runs the browser bridge without the app, and
`node scripts/bridge-smoke.mjs` drives the native-messaging host the way a
browser would.

## Reporting Issues

- Use the **Bug Report** template for bugs
- Use the **Feature Request** template for enhancements
- Search existing issues first to avoid duplicates
- Report security vulnerabilities privately; see [SECURITY.md](../SECURITY.md)

## Pull Requests

- Fill out the PR template completely
- Link related issues using `Closes #123` or `Fixes #123`
- Keep PRs focused — one feature or fix per PR
- Ensure the Verify steps pass before requesting review

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](../LICENSE).
