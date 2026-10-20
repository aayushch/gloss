#!/usr/bin/env bash
# Builds the Safari extension (an .appex) from extension/dist/safari with
# the Xcode project in safari/, and prints the bundler config that puts it
# into Gloss.app. Signed with APPLE_SIGNING_IDENTITY when set, ad hoc
# otherwise (Safari then needs "Allow unsigned extensions" in its Develop
# menu). Usage: scripts/build-safari.sh [--skip-extension-build]
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
skip=0
[ "${1:-}" = "--skip-extension-build" ] && skip=1
if [ "$skip" = 0 ]; then
  (cd "$root/extension" && npm run build -- --target safari)
fi
project="$root/safari/Gloss/Gloss.xcodeproj"
if [ ! -d "$project" ]; then
  echo "safari/Gloss/Gloss.xcodeproj is missing; run scripts/make-safari-project.sh first" >&2
  exit 1
fi
# The project compiles its own copies of the handler and entitlements;
# safari/handler is the source, so the copies are refreshed before each build.
cp "$root/safari/handler/SafariWebExtensionHandler.swift" "$root/safari/Gloss/Gloss Extension/SafariWebExtensionHandler.swift"
cp "$root/safari/handler/Gloss_Extension.entitlements" "$root/safari/Gloss/Gloss Extension/Gloss Extension.entitlements"
out="$root/safari/build"
rm -rf "$out"
sign=(CODE_SIGN_IDENTITY="-" CODE_SIGNING_REQUIRED=NO)
if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
  sign=(CODE_SIGN_IDENTITY="$APPLE_SIGNING_IDENTITY" DEVELOPMENT_TEAM="${APPLE_TEAM_ID:-BG78RT6D5Z}" CODE_SIGN_STYLE=Manual OTHER_CODE_SIGN_FLAGS="--timestamp --options runtime")
fi
# The entitlements come from safari/handler, not from the capabilities the
# converter put in the project: the extension needs outgoing network access
# and the App Group, and nothing else. Xcode's injected get-task-allow is
# turned off because notarization rejects it.
xcodebuild -project "$project" -target "Gloss Extension" -configuration Release \
  CONFIGURATION_BUILD_DIR="$out" SYMROOT="$out/sym" OBJROOT="$out/obj" \
  ARCHS="arm64 x86_64" ONLY_ACTIVE_ARCH=NO \
  CODE_SIGN_ENTITLEMENTS="$root/safari/handler/Gloss_Extension.entitlements" \
  CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO ENABLE_USER_SELECTED_FILES="" \
  "${sign[@]}" -quiet
echo "built $out/Gloss Extension.appex"
