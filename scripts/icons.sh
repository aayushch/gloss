#!/usr/bin/env bash
# Regenerate every app icon from the sources in design/icon/.
#
#   scripts/icons.sh
#
# design/icon/gloss-dark.svg      the mark on the dark theme; source of the
#                                 Windows, Linux and in-app PNG/ICO icons
# design/icon/Gloss.icon          Icon Composer package with a light and a dark
#                                 appearance; macOS 26 and newer pick the one
#                                 matching the system appearance
# design/icon/tray.svg            the menu bar glyph, black on transparent;
#                                 macOS tints it as a template image
#
# Outputs land in ui/src-tauri/icons/: the PNG/ICO set from `tauri icon`,
# icon.icns (Apple's flattened render of the package, used by macOS 15 and
# older) and Assets.car (the compiled package, bundled into the .app and named
# by CFBundleIconName in ui/src-tauri/Info.plist).
#
# Needs rsvg-convert (brew install librsvg) and Xcode 26 or newer for actool;
# an older actool silently drops the dark appearance, so check the result with
# `assetutil --info ui/src-tauri/icons/Assets.car | grep DarkAqua`.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ICONS="$REPO_ROOT/ui/src-tauri/icons"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "== PNG and ICO set =="
rsvg-convert -w 1024 -h 1024 "$REPO_ROOT/design/icon/gloss-dark.svg" -o "$TMP/gloss-1024.png"
(cd "$REPO_ROOT/ui" && npx tauri icon "$TMP/gloss-1024.png" -o "$TMP/set" >/dev/null)
find "$TMP/set" -maxdepth 1 -type f \( -name '*.png' -o -name '*.ico' \) -exec cp {} "$ICONS/" \;

echo "== menu bar glyph =="
# 36 px for an 18 pt menu bar slot, so Retina displays get a crisp 2x image.
rsvg-convert -w 36 -h 36 "$REPO_ROOT/design/icon/tray.svg" -o "$ICONS/tray.png"

echo "== macOS asset catalog =="
mkdir -p "$TMP/car"
xcrun actool "$REPO_ROOT/design/icon/Gloss.icon" --compile "$TMP/car" \
    --output-format human-readable-text --notices --warnings --errors \
    --output-partial-info-plist "$TMP/partial.plist" \
    --app-icon Gloss --include-all-app-icons --enable-on-demand-resources NO \
    --development-region en --target-device mac \
    --minimum-deployment-target 26.0 --platform macosx
test -f "$TMP/car/Assets.car" && test -f "$TMP/car/Gloss.icns"
cp "$TMP/car/Assets.car" "$ICONS/Assets.car"
cp "$TMP/car/Gloss.icns" "$ICONS/icon.icns"
assetutil --info "$ICONS/Assets.car" > "$TMP/car.json"
grep -q NSAppearanceNameDarkAqua "$TMP/car.json" \
    || { echo "Assets.car has no dark appearance; use a newer Xcode" >&2; exit 1; }
echo "done: $ICONS"
