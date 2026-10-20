#!/usr/bin/env bash
# Makes sure every bundled resource exists so the bundler never fails: the
# Firefox add-on is downloaded by the release workflow, and an empty
# placeholder stands in otherwise (Gloss treats size zero as "not bundled").
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
res="$root/ui/src-tauri/resources"
mkdir -p "$res"
[ -f "$res/gloss.xpi" ] || : > "$res/gloss.xpi"
