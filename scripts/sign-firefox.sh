#!/usr/bin/env bash
# Has Mozilla sign the Firefox build as a self-distributed add-on and puts
# the signed .xpi where the bundler picks it up (ui/src-tauri/resources).
# Needs AMO_JWT_ISSUER and AMO_JWT_SECRET from addons.mozilla.org. Each
# signing needs a version Mozilla has not seen: bump with set-version.sh.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
: "${AMO_JWT_ISSUER:?set AMO_JWT_ISSUER (addons.mozilla.org › Tools › Manage API Keys)}"
: "${AMO_JWT_SECRET:?set AMO_JWT_SECRET}"
cd "$root/extension"
[ -d node_modules ] || npm ci
npm run build -- --target firefox
rm -rf dist/signed
npx web-ext sign --source-dir dist/firefox --artifacts-dir dist/signed \
  --channel unlisted --api-key "$AMO_JWT_ISSUER" --api-secret "$AMO_JWT_SECRET"
mkdir -p "$root/ui/src-tauri/resources"
cp dist/signed/*.xpi "$root/ui/src-tauri/resources/gloss.xpi"
echo "signed add-on copied to ui/src-tauri/resources/gloss.xpi"
