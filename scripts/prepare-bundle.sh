#!/usr/bin/env bash
# Runs before every `tauri build` and `tauri dev`: builds the gloss-bridge
# sidecar, makes sure the bundled Firefox add-on slot exists, and on macOS
# with Xcode builds the Safari extension that the bundler copies into
# Gloss.app. Usage: scripts/prepare-bundle.sh [--debug]
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
mode="${1:-}"

bash "$root/scripts/build-bridge.sh" ${mode:+"$mode"}
if [ "$mode" = "--debug" ]; then
  # A development run never signs with Mozilla; it keeps whatever is there.
  mkdir -p "$root/ui/src-tauri/resources"
  [ -f "$root/ui/src-tauri/resources/gloss.xpi" ] || : > "$root/ui/src-tauri/resources/gloss.xpi"
else
  bash "$root/scripts/ensure-resources.sh"
fi

if [ "$(uname -s)" = Darwin ]; then
  if ! xcode-select -p >/dev/null 2>&1 || ! xcrun --find xcodebuild >/dev/null 2>&1; then
    echo "Xcode is not installed: Gloss.app will not include the Safari extension" >&2
    mkdir -p "$root/safari/build"
    [ -d "$root/safari/build/Gloss Extension.appex" ] || echo "safari/build/Gloss Extension.appex is missing; the macOS bundle step needs it" >&2
    exit 0
  fi
  if [ "$mode" = "--debug" ] && [ -d "$root/safari/build/Gloss Extension.appex" ]; then
    # A development run reuses the last Safari build; a release always rebuilds.
    exit 0
  fi
  if [ ! -d "$root/extension/node_modules" ]; then
    (cd "$root/extension" && npm ci)
  fi
  bash "$root/scripts/build-safari.sh"
fi
