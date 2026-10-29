#!/bin/sh
# Install (or re-install) dsh-remote-monitor into a DSH profile.
#
# The plugin is COPIED rather than symlinked on purpose: Node resolves a
# symlinked package by its real path, so a link into a source checkout would
# resolve the plugin's own dependencies from the checkout instead of the profile
# — where `ssh2` actually lives. A real directory keeps resolution unambiguous.
#
# Usage:  ./install.sh [profile-name]      (default: desktop)
set -eu

PROFILE_NAME="${1:-desktop}"
SOURCE="$(cd "$(dirname "$0")" && pwd)"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE="$DSH_HOME_DIR/profiles/$PROFILE_NAME"
TARGET="$PROFILE/node_modules/dsh-remote-monitor"

if [ ! -d "$PROFILE" ]; then
  echo "error: profile '$PROFILE_NAME' not found at $PROFILE" >&2
  echo "available: $(ls "$DSH_HOME_DIR/profiles" 2>/dev/null | tr '\n' ' ')" >&2
  exit 1
fi

echo "installing $SOURCE -> $TARGET"
mkdir -p "$TARGET"
# --delete keeps the installed copy in step with the source on upgrade; the
# node_modules exclusion preserves anything a package manager put there.
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --exclude 'node_modules' "$SOURCE/" "$TARGET/"
else
  rm -rf "$TARGET"
  mkdir -p "$TARGET"
  cp -R "$SOURCE"/. "$TARGET"/
  rm -rf "$TARGET/node_modules"
fi

PATCH="$PROFILE/cordis.patch.yml"
if [ ! -f "$PATCH" ]; then
  echo "error: $PATCH not found; cannot enable the plugin" >&2
  exit 1
fi
if grep -q "dsh-remote-monitor" "$PATCH"; then
  echo "profile patch already enables the plugin"
else
  cp "$PATCH" "$PATCH.bak-$(date +%s)"
  # The row MUST go inside an `insert:` list. A bare top-level `- id: X / name: Y`
  # is an id-targeted OVERRIDE of a row some bundle already inserted — pointing it
  # at a row that does not exist inserts nothing and fails silently, which is
  # exactly how the first install of this plugin appeared to do nothing.
  cat >> "$PATCH" <<'EOF'

# dsh-remote-monitor — 远程机器资源监控（CPU/内存/磁盘/网络/GPU + rmon_* agent 工具）。
- insert:
    - id: remote-monitor
      name: 'dsh-remote-monitor'
EOF
  echo "added the plugin row to $PATCH (backup written beside it)"
fi

echo
echo "done. Restart the DeepSeek Harness host so the loader picks up the new row,"
echo "then open the sidebar's 监控 / Monitor page."
echo
echo "Verify the installed copy parses (uses the bundled runtime):"
echo "  cd \"$TARGET\" && \"$DSH_HOME_DIR/../DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node\" --input-type=module -e \"import('./src/index.js').then(m=>console.log(m.name))\""
echo "  (a missing '@deepseek-ai/dsh-tools' is expected: the host injects the SDK)"
