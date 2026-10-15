#!/usr/bin/env bash
# Build Gloss installers for the current platform.
#
#   scripts/build.sh                                  # native target
#   scripts/build.sh --target x86_64-apple-darwin     # a specific Rust target
#   scripts/build.sh --universal                      # macOS arm64 + x86_64 in one app
#   scripts/build.sh --sign "Developer ID Application: Name (TEAMID)"
#   scripts/build.sh --debug                          # unoptimised build, faster
#
# Prerequisites: Node.js 20+, Rust stable, and on Linux the WebKitGTK
# development packages (see README). Output lands in target/release/bundle/.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET=""
UNIVERSAL=false
DEBUG=false
SIGN="${APPLE_SIGNING_IDENTITY:-}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --target) TARGET="$2"; shift 2 ;;
        --universal) UNIVERSAL=true; shift ;;
        --debug) DEBUG=true; shift ;;
        --sign) SIGN="$2"; shift 2 ;;
        *) echo "unknown option: $1" >&2; exit 1 ;;
    esac
done

if [ "$UNIVERSAL" = true ]; then
    rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
    TARGET="universal-apple-darwin"
elif [ -n "$TARGET" ]; then
    rustup target add "$TARGET" >/dev/null
fi

cd "$REPO_ROOT/ui"
if [ ! -d node_modules ]; then
    npm ci
fi

ARGS=()
[ -n "$TARGET" ] && ARGS+=(--target "$TARGET")
[ "$DEBUG" = true ] && ARGS+=(--debug)

if [ -n "$SIGN" ]; then
    export APPLE_SIGNING_IDENTITY="$SIGN"
fi

echo "== Gloss build ${TARGET:+($TARGET)} =="
npx tauri build "${ARGS[@]+"${ARGS[@]}"}"

PROFILE=release
[ "$DEBUG" = true ] && PROFILE=debug
BUNDLE="$REPO_ROOT/target/${TARGET:+$TARGET/}$PROFILE/bundle"
echo
echo "== Installers =="
find "$BUNDLE" -maxdepth 2 \( -name '*.dmg' -o -name '*.app' -o -name '*.AppImage' -o -name '*.deb' -o -name '*.rpm' -o -name '*.msi' -o -name '*-setup.exe' \) 2>/dev/null | sed 's/^/  /'
