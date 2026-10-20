#!/usr/bin/env bash
# Builds the gloss-bridge native-messaging host and places it where the
# Tauri bundler expects a sidecar: ui/src-tauri/binaries/gloss-bridge-<triple>.
# Usage: scripts/build-bridge.sh [--debug] [--target <triple>]
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
profile=release
target="${TAURI_ENV_TARGET_TRIPLE:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --debug) profile=debug ;;
    --target) target="$2"; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
if [ -z "$target" ]; then
  target="$(rustc -vV | sed -n 's/^host: //p')"
fi
args=(build -p gloss-bridge --target "$target")
[ "$profile" = release ] && args+=(--release)
(cd "$root" && cargo "${args[@]}")
ext=""
case "$target" in *windows*) ext=".exe" ;; esac
mkdir -p "$root/ui/src-tauri/binaries"
cp "$root/target/$target/$profile/gloss-bridge$ext" "$root/ui/src-tauri/binaries/gloss-bridge-$target$ext"
echo "gloss-bridge ($profile) -> ui/src-tauri/binaries/gloss-bridge-$target$ext"
