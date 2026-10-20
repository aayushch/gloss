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
# design/icon/gloss-small.svg     the mark without the text lines, for the
#                                 16 and 32 px browser toolbar icons where
#                                 the lines would blur into a smudge
#
# Outputs land in ui/src-tauri/icons/: the PNG/ICO set from `tauri icon`,
# icon.icns (Apple's flattened render of the package, used by macOS 15 and
# older) and Assets.car (the compiled package, bundled into the .app and named
# by CFBundleIconName in ui/src-tauri/Info.plist). The browser extension's
# icons (extension/icons/) and the Safari wrapper app's icon set come from
# the same sources, so every surface shows one mark.
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

echo "== browser extension =="
EXT="$REPO_ROOT/extension/icons"
mkdir -p "$EXT"
for size in 16 32; do
    rsvg-convert -w "$size" -h "$size" "$REPO_ROOT/design/icon/gloss-small.svg" -o "$EXT/icon$size.png"
done
for size in 48 128; do
    rsvg-convert -w "$size" -h "$size" "$REPO_ROOT/design/icon/gloss-dark.svg" -o "$EXT/icon$size.png"
done

echo "== Safari wrapper app =="
# The Xcode project's own app icon and the image on its window. Only the
# extension inside it ships, but the project should match the rest.
SAFARI="$REPO_ROOT/safari/Gloss/Gloss"
cp "$EXT/icon128.png" "$SAFARI/Resources/Icon.png"
for spec in 16@1x:16 16@2x:32 32@1x:32 32@2x:64 128@1x:128 128@2x:256 256@1x:256 256@2x:512 512@1x:512 512@2x:1024; do
    px="${spec#*:}"
    rsvg-convert -w "$px" -h "$px" "$REPO_ROOT/design/icon/gloss-dark.svg" \
        -o "$SAFARI/Assets.xcassets/AppIcon.appiconset/mac-icon-${spec%:*}.png"
done

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
