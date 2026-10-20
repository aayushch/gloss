#!/usr/bin/env bash
# Set the app version everywhere it is recorded: the Tauri config, the Cargo
# workspace, ui/package.json, and the browser extension's package.json and
# manifests (which take the numeric part only, as Chrome requires). Used by
# the release workflow with the tag name, and by hand before tagging.
#
#   scripts/set-version.sh 0.2.0
set -euo pipefail

VERSION="${1:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$ ]]; then
    echo "usage: $0 <semver>   (e.g. 0.2.0)" >&2
    exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

node -e '
  const fs = require("fs");
  const [version, ...files] = process.argv.slice(1);
  for (const file of files) {
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    json.version = version;
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
  }
' "$VERSION" "$REPO_ROOT/ui/src-tauri/tauri.conf.json" "$REPO_ROOT/ui/package.json"

# Browser manifests allow only dotted numbers; a prerelease suffix is dropped.
NUMERIC="${VERSION%%-*}"
EXT_FILES=()
for f in "$REPO_ROOT/extension/package.json" "$REPO_ROOT"/extension/manifests/*.json; do
    [ -f "$f" ] && EXT_FILES+=("$f")
done
if [ ${#EXT_FILES[@]} -gt 0 ]; then
    node -e '
      const fs = require("fs");
      const [version, ...files] = process.argv.slice(1);
      for (const file of files) {
        const json = JSON.parse(fs.readFileSync(file, "utf8"));
        json.version = version;
        fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
      }
    ' "$NUMERIC" "${EXT_FILES[@]}"
fi

# Lock files record the package version too.
for dir in "$REPO_ROOT/ui" "$REPO_ROOT/extension"; do
    if [ -f "$dir/package-lock.json" ]; then
        (cd "$dir" && npm install --package-lock-only --ignore-scripts --no-audit --no-fund >/dev/null 2>&1) || echo "warning: could not refresh $dir/package-lock.json" >&2
    fi
done

# The Safari extension's bundle version lives in its Xcode project.
PBXPROJ="$REPO_ROOT/safari/Gloss/Gloss.xcodeproj/project.pbxproj"
if [ -f "$PBXPROJ" ]; then
    sed -i.bak -E "s/MARKETING_VERSION = [^;]*;/MARKETING_VERSION = $NUMERIC;/" "$PBXPROJ"
    rm -f "$PBXPROJ.bak"
fi

# The workspace manifest is the single source for every crate's version.
sed -i.bak -E "s/^version = \"[^\"]*\"/version = \"$VERSION\"/" "$REPO_ROOT/Cargo.toml"
rm -f "$REPO_ROOT/Cargo.toml.bak"

# Keep Cargo.lock in step so the build does not rewrite it.
(cd "$REPO_ROOT" && cargo update --workspace --offline >/dev/null 2>&1 || cargo update --workspace >/dev/null)

echo "version set to $VERSION"
