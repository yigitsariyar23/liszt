#!/bin/bash
# Builds the Mac app and puts it in /Applications, then opens it.
set -euo pipefail
cd "$(dirname "$0")/.."

npm run dist:mac

# `open` only brings a running copy forward, so the old one has to quit first.
if pgrep -x Liszt >/dev/null; then
  osascript -e 'tell application "Liszt" to quit' || true
  for _ in $(seq 20); do pgrep -x Liszt >/dev/null || break; sleep 0.5; done
  if pgrep -x Liszt >/dev/null; then
    echo "Liszt hâlâ açık; kapatıp tekrar deneyin." >&2
    exit 1
  fi
fi

ditto release/mac-arm64/Liszt.app /Applications/Liszt.app

# The Dock looks the icon up by bundle id, so a stray copy (the build output, an old checkout) can lend
# it an old logo, and killall Dock alone keeps its icon cache. Only the installed copy stays registered.
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
"$LSREGISTER" -dump | awk '/^path:/{p=$2} /local\.liszt\.terminal/{print p}' | sort -u | while read -r app; do
  [ "$app" = /Applications/Liszt.app ] || "$LSREGISTER" -u "$app" 2>/dev/null || true
done
touch /Applications/Liszt.app
"$LSREGISTER" -f /Applications/Liszt.app
rm -rf "$(getconf DARWIN_USER_CACHE_DIR)com.apple.dock.iconcache"
killall Dock

open /Applications/Liszt.app
