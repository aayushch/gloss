# Gloss browser extension

Highlight text on any web page, click **Ask about this**, and the question goes to the Gloss app running on this computer. The reply streams back into a popover anchored to the passage; the passage keeps a highlight and a small quote glyph, and the extension finds it again the next time the page is opened. The extension never contacts an AI service itself.

One TypeScript codebase (Manifest V3, Svelte 5) builds for Chrome, Firefox and Safari.

## Build

```sh
cd extension
npm install
npm run build          # dist/chrome, dist/firefox, dist/safari
npm run watch          # rebuild on change (all targets)
node build.mjs --target chrome   # one target
npm test               # vitest: text index, anchoring, URL watcher, state reducer
npm run check          # tsc + svelte-check
npm run zip            # dist/gloss-chrome-<version>.zip and dist/gloss-firefox-<version>.zip
npm run lint:firefox   # web-ext lint over dist/firefox
```

`build.mjs` bundles with esbuild, copies `manifests/<target>.json` to `dist/<target>/manifest.json` and injects the `__BROWSER__` define (`'chrome' | 'firefox' | 'safari'`) that picks the transport. The icons in `icons/` are rendered by `scripts/icons.sh` at the repository root from `design/icon/`, the same source as the app icon (the 16 and 32 px toolbar sizes use the mark without its text lines).

## Load in Chrome (unpacked)

1. `npm run build`.
2. Open `chrome://extensions`, turn on **Developer mode**.
3. **Load unpacked** and pick `extension/dist/chrome`.
4. The extension id is the Chrome Web Store item's id, `EXTENSION_ID`. The `key` in `manifests/chrome.json` is the store item's public key (developer dashboard › Package › View public key), which gives unpacked builds the same id. The Gloss app registers the native-messaging host `sh.aay.gloss` for that id, so the id must not change.
5. Open Gloss once so it installs the native-messaging host manifest, then reload the extension.

## Load in Firefox (temporary add-on)

1. `npm run build`.
2. Open `about:debugging#/runtime/this-firefox`, **Load Temporary Add-on…**, pick `extension/dist/firefox/manifest.json`.
3. Firefox does not grant `<all_urls>` to MV3 extensions at install time: open the extension's entry in `about:addons`, **Permissions**, and allow access to all sites (or allow it per site from the extensions toolbar button).
4. The add-on id is `gloss@aay.sh`; Gloss registers the native-messaging host for it.

## Safari

Safari cannot stream over native messaging, so the Safari build (`dist/safari`) sends each request with `browser.runtime.sendNativeMessage` to a native handler and polls `getTurn` while a reply is being written. The Xcode project that wraps `dist/safari` as a Safari Web Extension, and the native handler that relays to Gloss's loopback bridge, live in `/Users/aayush/gloss/safari` (created separately).

## Layout

```
build.mjs                 esbuild + esbuild-svelte build, one dist folder per target
manifests/                chrome.json, firefox.json, safari.json
icons/                    icon{16,32,48,128}.png, rendered from design/icon/ by ../scripts/icons.sh
src/shared/protocol.ts    wire types mirrored from engine/src/bridge and engine/src/types.rs
src/shared/messages.ts    messages between the background and its clients
src/shared/client.ts      the runtime-port client used by content, popup and ask window
src/background/           index.ts (session, routing, menu, badge), native.ts, safari.ts, tabs.ts
src/content/              text.ts (normalised text index), anchor.ts (describe/resolve),
                          urlwatch.ts, highlight.ts (rounded tint boxes), glyphs.ts (margin marks), markdown.ts, state.ts,
                          index.ts (the content script), ui/*.svelte, styles.css
src/popup/                toolbar popup
src/options/              options page
src/ask/                  standalone ask window for pages without a content script
test/                     vitest + jsdom
```

## How a page is anchored

`TextIndex` walks the body's text nodes in document order (skipping scripts, styles, hidden and `aria-hidden` elements and the extension's own host), collapses whitespace runs to one space and remembers which node and offset every character came from. An ask records the exact quote, 32 characters of context on either side, the offsets in that text and a short CSS path of the block it started in. On a later visit the passage is looked up by position, then by exact text choosing the occurrence with the best context, then inside its container with quotes and dashes folded, then approximately (Myers' algorithm, up to 20% edits, reported as `fuzzy`). Anything else is an `orphan`, retried at 1, 3 and 6 seconds for pages that render late, and listed in the popup.
