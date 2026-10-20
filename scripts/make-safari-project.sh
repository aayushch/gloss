#!/usr/bin/env bash
# Generates the Xcode project for the Safari extension once, from the built
# extension, then puts Gloss's own native handler and entitlements in place.
# The project is committed; rerun this only to regenerate it from scratch.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
dist="$root/extension/dist/safari"
[ -f "$dist/manifest.json" ] || (cd "$root/extension" && npm run build -- --target safari)
rm -rf "$root/safari/Gloss"
xcrun safari-web-extension-converter "$dist" \
  --project-location "$root/safari" --app-name Gloss --bundle-identifier sh.aay.gloss \
  --macos-only --no-open --no-prompt --swift
# The handler and entitlements the converter wrote are replaced by Gloss's.
cp "$root/safari/handler/SafariWebExtensionHandler.swift" "$root/safari/Gloss/Gloss Extension/SafariWebExtensionHandler.swift"
cp "$root/safari/handler/Gloss_Extension.entitlements" "$root/safari/Gloss/Gloss Extension/Gloss Extension.entitlements"
echo "project written to safari/Gloss"
