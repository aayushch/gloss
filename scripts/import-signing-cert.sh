#!/usr/bin/env bash
# Imports the Developer ID certificate from APPLE_CERTIFICATE (base64 .p12)
# into a temporary keychain so xcodebuild can sign the Safari extension on
# a CI runner. tauri-action does the same for its own signing step.
set -euo pipefail
: "${APPLE_CERTIFICATE:?}" "${APPLE_CERTIFICATE_PASSWORD:?}"
keychain="$RUNNER_TEMP/gloss-signing.keychain-db"
password="$(uuidgen)"
echo "$APPLE_CERTIFICATE" | base64 --decode > "$RUNNER_TEMP/cert.p12"
security create-keychain -p "$password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$password" "$keychain"
security import "$RUNNER_TEMP/cert.p12" -P "$APPLE_CERTIFICATE_PASSWORD" -A -t cert -f pkcs12 -k "$keychain"
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain" >/dev/null
security list-keychain -d user -s "$keychain" login.keychain-db
rm -f "$RUNNER_TEMP/cert.p12"
