# Browser extension: distribution and transport facts

Researched 2026-10-20 while designing the extension. These are the
constraints the design rests on.

## Can the app install the extension itself?

- **Chrome-family (Chrome, Arc, Brave, Edge, Vivaldi, Chromium):** no. On
  consumer Windows and macOS, Chrome installs only extensions hosted and
  signed by the Chrome Web Store; self-hosted `.crx` files work only through
  enterprise policy. The listing can be unlisted. A fixed `key` in the
  manifest keeps the extension id the same for a load-unpacked build and the
  store item, so the native host manifest can allow-list one id.
- **Firefox:** nearly. Mozilla must sign the add-on, but a "self-distributed"
  (unlisted) signing via `web-ext sign --channel unlisted` returns an `.xpi`
  that never appears on addons.mozilla.org and installs from anywhere. Gloss
  bundles it as a resource and opens it with Firefox.
- **Safari:** the extension must be a Safari Web Extension inside a macOS
  app, signed and notarized. Since Safari 18.4 (March 2025) a Developer
  ID-signed and notarized app can carry one outside the App Store. Gloss.app
  is that app; the `.appex` is built by Xcode and copied into
  `Contents/PlugIns` before the bundler signs the app (the bundler copies
  directories from `bundle.macOS.files` but does not sign them).

## Native messaging

- Per-user host manifests on macOS live in each browser's
  `NativeMessagingHosts` folder under `~/Library/Application Support`
  (Google/Chrome, Chromium, BraveSoftware/Brave-Browser, Microsoft Edge,
  Arc/User Data, Vivaldi, Mozilla); on Linux under `~/.config/<browser>` and
  `~/.mozilla/native-messaging-hosts`; on Windows through `HKCU` registry
  keys that point at the file. `path` must be absolute.
- Frames are JSON with a 32-bit native-endian length prefix; a host may send
  at most 1 MB per frame and receive up to 64 MiB.
- `connectNative` exists only in the background; an open native port keeps a
  Chrome MV3 service worker alive (Chrome 105+).

## Safari

- A Safari extension's background page cannot open `ws://127.0.0.1`: WebKit
  treats it as mixed content and manifest CSP changes do not help.
- `browser.runtime.sendNativeMessage` reaches the extension's own native
  handler (a sandboxed app extension), one request and one response at a
  time; the handler cannot push to the page. The handler can make outgoing
  network connections (`network.client`) and read the App Group container,
  which is how it finds the port and token Gloss writes to `bridge.json`.
- Streaming therefore polls: the extension asks for the turn every half
  second while one runs.

## Anchoring

The Hypothesis approach: store the exact quote with 32 characters of prefix
and suffix plus the character position, resolve by exact match, then by
context among repeats, then fuzzily, and report orphans. The CSS Custom
Highlight API (Chrome 105, Firefox 140, Safari 17.2) highlights ranges
without touching the page's DOM.
