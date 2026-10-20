# The Gloss browser extension

Highlight text on any web page, click **Ask about this**, and the reply
appears in a popover anchored to that text. A small Gloss mark stays on the
passage; it comes back the next time the page is open. Every ask is kept by
the Gloss app under **Pages** in the rail, one entry per page.

The extension itself never calls an AI. It sends the highlighted passage,
some text around it, the page's readable text (first time, and again only
when the page changes) and the question to the Gloss app on the same
machine, which runs your configured agent exactly as it does for a chat.

## Installing

Gloss must be running (or installed; the extension offers "Open Gloss").
Open **Settings › Browser extension** in Gloss for the buttons below.

| Browser | How |
| --- | --- |
| Chrome, Brave, Edge, Arc, Vivaldi, Chromium | Install from the Chrome Web Store (the listing is unlisted; Gloss links to it). These browsers only install extensions from the store, so Gloss cannot do it for you. Gloss writes the native-messaging host file each browser needs at every launch. |
| Firefox | Click **Install in Firefox**: Gloss hands Firefox the add-on it ships with (signed by Mozilla), and Firefox asks to install it. |
| Safari | The extension is inside Gloss.app. Open Safari › Settings › Extensions and enable **Gloss**. A build that is not notarized needs "Allow unsigned extensions" in Safari's Develop menu. |

Move Gloss to the Applications folder before installing: macOS runs a
freshly downloaded app from a temporary location, and the path the browsers
are given would go stale.

## Using it

- Select text, then click the pill or use the context menu "Ask Gloss about…"
  (also Alt+Shift+G). The context menu works where the pill cannot appear,
  such as the PDF viewer, with the reply shown in a small window instead.
- The popover streams the reply; ask follow-ups in it. Collapse hides it
  (the mark dims), Remove deletes the ask, "Open in Gloss" shows the page in
  the app.
- The toolbar button lists this page's asks, including any whose passage is
  no longer found on the page, and recent pages.
- Private windows are left alone. Hosts on the deny list in Gloss's settings
  are never asked about, and "Send page text to the agent" can be turned off.

## When something is off

- "Gloss isn't running": click Open Gloss. The question is kept and sent once
  the app is up.
- "Update Gloss" or "Update the Gloss extension": the two speak different
  protocol versions; update the older one.
- A mark is missing after the page changed: the ask is still listed in the
  toolbar popup and in Gloss, marked as not on the page any more.
- After moving Gloss, launch it once so it rewrites the host files.

## Releasing

The `Release` workflow builds the extension once and then:

- signs the Firefox build with Mozilla as a self-distributed add-on
  (`AMO_JWT_ISSUER`, `AMO_JWT_SECRET` secrets from addons.mozilla.org › API
  keys) and bundles the `.xpi` into every installer;
- builds the Safari extension with Xcode on the macOS runners and places it
  inside Gloss.app before the app is signed and notarized (the usual
  `APPLE_*` secrets);
- uploads the Chrome build to the Chrome Web Store and publishes it
  (`CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN`: an OAuth client
  with the Chrome Web Store API enabled, as described in Google's "Using the
  Chrome Web Store Publish API"). The store item must exist already, created
  once by uploading `dist/chrome.zip` by hand with the `key` in its manifest
  so the item id equals `extension/EXTENSION_ID`;
- attaches `chrome.zip`, `firefox.zip` and the signed `.xpi` to the release.

Without a secret, the matching step is skipped and the rest still ships.

## For developers

- `extension/`: `npm run build` writes `dist/chrome`, `dist/firefox` and
  `dist/safari`. Load `dist/chrome` unpacked at `chrome://extensions`
  (Developer mode) and `dist/firefox/manifest.json` at `about:debugging` as a
  temporary add-on. The Chrome id is fixed by the `key` in the manifest and
  recorded in `extension/EXTENSION_ID`, which the app compiles into its host
  manifests.
- `scripts/make-safari-project.sh` generates the Xcode project once;
  `scripts/build-safari.sh` builds `safari/build/Gloss Extension.appex`,
  which every `tauri build` runs on macOS (through `scripts/prepare-bundle.sh`)
  before the bundler copies it into Gloss.app. Safari only works with
  a **signed** Gloss: the extension's sandbox can read the port and token
  from the App Group container alone, and macOS lets only an app signed with
  the group entitlement write there (an unsigned build logs "could not write
  bridge info" and Safari sees "Gloss isn't running"). For a local Safari
  test, build with `scripts/build.sh --sign "Developer ID Application: …"`
  and run that bundle.
- `gloss-engine serve --loopback` runs the bridge without the app;
  `node scripts/bridge-smoke.mjs` drives `gloss-bridge` like a browser;
  `gloss-engine page-ask --url … "question"` asks like the extension does.
