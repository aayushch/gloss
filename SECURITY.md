# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest release and `main` | Yes |
| Older releases | No |

## Reporting a Vulnerability

If you discover a security vulnerability in Gloss, please report it responsibly.
**Do not open a public GitHub issue.**

### How to Report

Use GitHub's private vulnerability reporting on this repository
(Security tab → Report a vulnerability), or email **aayush@live.in**, with:

- A description of the vulnerability
- Steps to reproduce
- Affected component (engine, shell, UI, bridge, browser extension, Safari app extension)
- Impact assessment (what an attacker could do)
- Any suggested fix, if you have one

### What to Expect

- **Acknowledgment** within 48 hours of your report
- **Status update** within 7 days with an assessment and timeline
- **Credit** in the release notes (unless you prefer to remain anonymous)

### Scope

The following are in scope:

- Gloss engine (Rust, `engine/`) — agent process spawning, SQLite access, the
  loopback bridge server and its token check
- Tauri shell (Rust, `ui/src-tauri/`) — IPC commands, file system access,
  environment capture, artifact preview sandboxing
- Gloss UI (Svelte, `ui/`) — XSS through agent output or artifacts, injection,
  data exposure
- Native messaging bridge (`bridge/`) and the browser extension (`extension/`)
  — message validation, origin checks, what a web page can make the extension do
- Safari app extension (`safari/`) — App Group container handling, loopback
  token handling
- Attachments and artifacts — path handling, content rendering

The following are out of scope:

- Vulnerabilities in the agent CLIs Gloss drives (Claude Code, Codex CLI,
  Gemini CLI, Pi, Cursor Agent); report those upstream
- Vulnerabilities in upstream dependencies with no demonstrated exploit in Gloss
- Denial of service against local-only services
- Social engineering

## Security Design

Gloss is a **local-first** desktop application. Key security properties:

- **No cloud service** — Gloss runs agent CLIs you already have installed, and
  all conversations, clarifications and settings stay in `~/.gloss/` on the
  user's machine
- **No API keys** — Gloss holds no model credentials of its own; each agent CLI
  manages its own authentication
- **Artifact previews** are rendered in a sandboxed iframe with an injected
  content security policy: scripts and network are off until the user turns
  them on, and the frame is never same-origin, so it cannot reach Tauri's IPC
- **Browser extension traffic** reaches Gloss only over a local Unix socket, or,
  for Safari, over a loopback TCP listener guarded by a per-launch token

## Disclosure Policy

We follow coordinated disclosure. We ask that you give us reasonable time to
address the issue before any public disclosure. We aim to release fixes within
30 days of a confirmed vulnerability.
