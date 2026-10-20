#!/usr/bin/env bash
# Prepares the bundled Firefox add-on slot (ui/src-tauri/resources/gloss.xpi)
# before a build. With AMO_JWT_ISSUER and AMO_JWT_SECRET set, the add-on is
# signed by Mozilla for the current version unless a signed file for that
# version is already there. Without them, a signed file for the current
# version is kept and anything else becomes an empty placeholder, which
# Gloss treats as "not bundled" so the bundler never fails.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
res="$root/ui/src-tauri/resources"
mkdir -p "$res"
version="$(node -p 'require(process.argv[1]).version' "$root/extension/package.json" 2>/dev/null || echo unknown)"
have="$(cat "$res/gloss.xpi.version" 2>/dev/null || true)"

if [ -s "$res/gloss.xpi" ] && [ "$have" = "$version" ]; then
  echo "Firefox add-on $version already signed and bundled"
  exit 0
fi
if [ -n "${AMO_JWT_ISSUER:-}" ] && [ -n "${AMO_JWT_SECRET:-}" ]; then
  bash "$root/scripts/sign-firefox.sh"
  exit 0
fi
: > "$res/gloss.xpi"
rm -f "$res/gloss.xpi.version"
echo "Firefox add-on not bundled: set AMO_JWT_ISSUER and AMO_JWT_SECRET to have Mozilla sign it during the build" >&2
