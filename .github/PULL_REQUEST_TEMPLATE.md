## Summary

<!-- What does this PR do? Keep it to 1-3 sentences. -->

## Changes

<!-- Bullet list of what changed and why. -->

-

## Related Issues

<!-- Link issues: "Closes #123", "Fixes #456", "Part of #789" -->

## Type of Change

- [ ] Bug fix
- [ ] New feature
- [ ] Enhancement to existing feature
- [ ] Refactor (no behavior change)
- [ ] Documentation
- [ ] Other: <!-- describe -->

## Component(s) Affected

- [ ] Engine (Rust: agent drivers, store, bridge server)
- [ ] Tauri shell (Rust)
- [ ] UI (Svelte frontend)
- [ ] Native messaging bridge
- [ ] Browser extension (Chrome-family / Firefox / Safari)
- [ ] Safari app extension (Swift)
- [ ] Build, release or CI scripts
- [ ] Docs or landing page

## Agents Affected

<!-- Tick the agent CLIs whose driving changes, or delete this section. -->

- [ ] Claude Code
- [ ] Codex CLI
- [ ] Gemini CLI
- [ ] Pi
- [ ] Cursor Agent

## Testing

<!-- How did you verify this works? -->

- [ ] `cargo test -p gloss-engine -p gloss-bridge -p gloss-app` passes
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` passes
- [ ] `cd ui && npm run check && npm test` passes
- [ ] `cd extension && npm run check && npm test` passes (if extension changed)
- [ ] Added new tests
- [ ] Manually tested in `npm run tauri dev`

### Test steps

<!-- Steps a reviewer can follow to verify: -->

1.

## Screenshots

<!-- If UI changes, include before/after screenshots. Delete this section if not applicable. -->

## Checklist

- [ ] My code follows the project conventions (see CONTRIBUTING.md)
- [ ] I ran `npm run format` and `cargo fmt --all`
- [ ] I've used Svelte 5 runes (`$state`, `$derived`, `$effect`) — no legacy `$:`
- [ ] `docs/agents.md` or `docs/api.md` is updated if a driver or the shell API changed
- [ ] I've tested on both dark and light themes (if UI change)
