# Plan: bring-your-own-key backends and phone apps

Status: plan agreed 2026-10-15, nothing implemented. Decisions taken with the
author are marked **Decided**.

## Where Gloss stands

Every turn spawns one of five CLIs and parses its stdout. The adapter trait in
`engine/src/agents/mod.rs` has two jobs: build the command line for a turn and
translate one output line into events. The turn runner in `engine/src/engine.rs`
calls the process spawner directly. Conversation memory lives in the CLI, which
Gloss resumes by its session id, so Gloss sends only the newest prompt. The
agent list is a closed enum that doubles as the `agent` column, the settings
key and the UI picker.

## Part 1: API backends on desktop

**Decided:** the first release adds Anthropic, OpenAI and Gemini, plus an
OpenAI-compatible backend with a base URL field that covers OpenRouter, Groq,
Ollama and LM Studio.

### 1. Gloss owns the history

The APIs are stateless, so every request carries the whole conversation.
Gloss already stores the canonical transcript, so the engine builds the
message list from the stored turns in `seq` order:

- User turns send `prompt_text` when set, else `text`. The clarification
  framing is already part of `prompt_text`, so wells need no special case.
- Assistant turns send `text`. Turns whose status is error or cancelled are
  skipped; a cancelled turn with partial text is skipped too, so the model
  never sees half an answer as its own.
- Text attachments are already inlined into `prompt_text`. Images are read
  from disk and re-sent as base64 on every later turn, because the provider
  keeps nothing between calls.
- `prompt::SYSTEM_NOTE` becomes the request's system prompt on every turn,
  instead of being prepended to the first message for CLIs without a flag.
- Prompt caching keeps the replay affordable: Anthropic `cache_control` on
  the last history block, automatic caching on OpenAI, implicit on Gemini.

Context limits are the new failure mode. The CLIs compact silently; the APIs
return an error. The first release surfaces that error in plain words. A later
release can drop the oldest main-column turns while keeping the anchor turn of
an open well. A size cap is also what the isolated-clarification research in
`clarification-isolation.md` needs, so the two features share it.

### 2. A backend trait above the process runner

Today `run_turn` owns the spawn. The change is one level of indirection:

```
trait Backend {
    async fn run(&mut self, req: TurnRequest, cancel: CancellationToken,
                 on_event: &mut dyn FnMut(AgentEvent)) -> Result<Outcome>;
}
```

- `CliBackend` wraps today's adapter and `process::run_lines` unchanged.
- `ApiBackend` opens a streaming HTTP request and feeds each server-sent
  event line to a provider adapter. SSE is line based, so the API adapters
  keep the same `parse_line` shape and the same fixture-driven tests as the
  CLI adapters.

`TurnState`, persistence, the `turn-event` envelope and the frontend need no
change. Cancel drops the HTTP stream.

### 3. Provider adapters

| Backend | Endpoint | Stream shape | Web search | Images |
| --- | --- | --- | --- | --- |
| Anthropic | Messages API, `stream: true` | `message_start`, `content_block_delta` with `text_delta`, `message_delta` carrying usage | server tool `web_search` | `image` block, base64 source |
| OpenAI | Responses API, `stream: true` | `response.output_text.delta`, `response.completed` with usage | hosted tool `web_search` | `input_image` with a data URL |
| Gemini | `streamGenerateContent?alt=sse` | `candidates[].content.parts[].text`, `usageMetadata` on the last chunk | `google_search` grounding tool | `inline_data` part |
| OpenAI-compatible | Chat Completions at a user base URL | `choices[].delta.content` | off, toggle disabled | `image_url` data URL when the server accepts it |

The compatible backend speaks Chat Completions rather than Responses because
that is what every third-party server implements. Its adapter is the lenient
one: missing usage, missing finish reason and non-JSON keepalive lines are all
tolerated.

All search tools run on the provider's servers, so Gloss keeps its
chat-plus-web design with no local tool loop. Tool calls show as activity
lines exactly as today. Exact tool names, event names and the Responses API
field set are verified against live calls at implementation time; only an
Anthropic key is known to exist on the development machine.

### 4. Keys in the OS keychain

Keys never enter SQLite. The `keyring` crate stores one entry per backend
under the service name `sh.aay.gloss`, using macOS Keychain, Windows
Credential Manager and Linux secret-service. Settings keep only non-secret
fields: the compatible backend's base URL and display name. New shell
commands: `set_api_key`, `clear_api_key`, `has_api_key`, `test_api_key`.
The test command calls the provider's list-models endpoint and reports the
HTTP status in words.

### 5. Models

Each provider has a list-models endpoint, filtered to chat-capable ids and
sorted newest first, with a static fallback used when the key is missing or
the request fails. The compatible backend lists `GET /v1/models` from the base
URL and falls back to a free-text model field.

### 6. Identity, types and UI

- `AgentId` gains `AnthropicApi`, `OpenaiApi`, `GeminiApi`, `Compatible`.
  Extending the enum keeps the text column, `Settings.default_model` and the
  picker working without a migration. The word "agent" stays in code; the UI
  says "backend".
- `AgentInfo` gains `kind: cli | api` and `needsKey: bool`. For API backends
  `available` means "a key is stored", `path` and `version` are null, and
  `supportsWebSearch` is false for the compatible backend.
- The agent picker groups "Installed agents" and "Your API keys".
- The Settings sheet gains an "API keys" section: one row per backend with a
  masked input, Save, Test and Remove, plus base URL and name for the
  compatible backend. Keys are written straight to the keychain and never
  echoed back; the row shows "Stored" or "Not set".
- `AGENT_NAMES`, the mock API and `types.ts` mirror the Rust types.

### 7. Cost

CLIs report dollars. The APIs report tokens, so the meta line shows tokens
and omits cost for API turns. A price table is deliberately not shipped; it
would be stale within weeks.

### 8. Dependencies

`reqwest` with `stream`, `json` and `rustls-tls` features and no OpenSSL,
`futures-util` for the byte stream, `keyring` with the platform features.
`rustls` keeps Linux and Windows CI builds free of system TLS libraries.

### Phases

1. Backend trait refactor. All five CLIs still pass their tests.
2. Anthropic adapter with recorded-stream fixtures, history builder, keychain
   module, `set_api_key` and friends, minimal Settings row. First live turn.
3. OpenAI Responses and Gemini adapters.
4. Images and web search on all three, with the per-backend toggle state.
5. OpenAI-compatible backend and its lenient adapter.
6. Picker grouping, model lists from the providers, docs, README, landing
   page copy. `docs/agents.md` opens with "Gloss never talks to a model API"
   and must be rewritten.

### Verification

Fixture tests per adapter from recorded SSE, a history-builder test covering
skipped failures and image replay, an engine test with the transport mocked
behind the trait, one live smoke turn per provider for which a key exists,
`npm run check`, vitest, clippy.

## Part 2: iOS and Android

**Decided:** Tauri mobile reusing the Rust engine; each device keeps its own
conversations; distribution through the App Store and Google Play.

### Why BYOK comes first

iOS cannot spawn processes and Android apps cannot run the agent CLIs, so the
phone apps offer only API backends. `env.rs` and `process.rs` compile out
behind `cfg(not(any(target_os = "ios", target_os = "android")))`, and
`CliBackend` with them. The rest of the engine is portable: `rusqlite` is
bundled, `reqwest` with rustls is pure Rust, and `GlossPaths::at` already
takes a base directory, which becomes the app's sandboxed data directory.

### Shell

- `tauri ios init` and `tauri android init` add the Xcode and Gradle
  projects under `ui/src-tauri/gen/`. A `mobile` capability file grants the
  same core permissions minus updater and process.
- The updater and dialog plugins register only on desktop. On the phones,
  "Save" becomes the share sheet and "Open artifact" the opener plugin.
- Key storage needs iOS Keychain and Android Keystore, which `keyring` does
  not provide. Either a community Tauri keychain plugin, verified at
  implementation time, or a small plugin of our own with a Swift and a Kotlin
  half behind the same `set_api_key` commands.
- Logging goes to the platform log instead of `~/.gloss/logs`.

### Frontend

- **Touch selection for the core feature.** Today the transcript listens for
  mouse-up and reads the window selection, then floats the Ask button. Phones
  fire `selectionchange` and show the system callout. The plan: listen to
  `selectionchange`, debounce until the handles stop moving, then show the
  Ask button as a bar above the composer rather than next to the selection,
  so it never fights the callout. Prototype this first; it decides whether
  the port is worth finishing.
- **Layout.** The rail becomes a drawer, the artifact pane a full-screen
  sheet, the model menu a bottom sheet, and the minimum window width goes
  away. Safe-area insets for the notch and the home indicator.
- **Input.** The composer must survive the software keyboard: pin it to the
  visual viewport and scroll the transcript when the keyboard opens.
- **Attachments.** The file picker becomes the photo picker plus the Files
  app on iOS and the document picker on Android, through the dialog plugin's
  mobile support or a small plugin.

### Store distribution

- Apple: the app is free, sells nothing, and lets the user enter keys they
  bought elsewhere. Guideline 3.1.1 risk is real but many bring-your-own-key
  clients ship; the listing should describe Gloss as a client for the user's
  own API accounts and show no purchase prompt. A privacy policy URL is
  required and can live on the landing page. Privacy labels: data stays on
  device and goes only to the provider the user chose.
- Google: the Play data safety form says the same. Target the current API
  level and provide a 64-bit build.
- The updater plugin stays off on mobile; the stores deliver updates.
- Release workflow gains `aarch64-apple-ios` and the Android targets, an
  Xcode archive step with the existing Apple secrets plus a provisioning
  profile, and a Gradle signing step with an upload key.

### Phases

1. Spike: build the current UI as an iOS and Android app with a stub engine,
   test touch selection on real devices. One or two days. Stop here if the
   selection interaction cannot be made good.
2. Gate the process code, build the engine for both targets, point paths at
   the sandbox.
3. Mobile keychain plugin behind the existing key commands.
4. Responsive layout and the touch Ask bar.
5. Attachments and share sheet.
6. CI targets, signing, TestFlight and internal Play track, then store
   review.

### Relative size

The mobile port is larger than BYOK, mostly from the selection interaction,
the layout work and the toolchain, not from the engine.

## Open questions for implementation time

- Whether the compatible backend should also accept an Anthropic-shaped base
  URL for proxies that mirror the Messages API.
- Whether API conversations should get the isolated-clarification mode from
  `clarification-isolation.md` right away, since the history builder makes
  forking trivial there.
- Which community Tauri keychain plugin, if any, is maintained well enough to
  depend on.
