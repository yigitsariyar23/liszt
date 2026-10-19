#!/bin/bash
# Builds the Mac app and puts it in /Applications, then opens it.
set -euo pipefail
cd "$(dirname "$0")/.."

npm run dist:mac

# `open` only brings a running copy forward, so the old one has to quit first. Only the app itself:
# the session host runs the same executable with arguments and keeps the chats going meanwhile.
app_running() { pgrep -xf '.*/Liszt\.app/Contents/MacOS/Liszt' >/dev/null; }
if app_running; then
  osascript -e 'tell application "Liszt" to quit' || true
  for _ in $(seq 20); do app_running || break; sleep 0.5; done
  if app_running; then
    echo "Liszt hâlâ açık; kapatıp tekrar deneyin." >&2
    exit 1
  fi
fi

# The session host still runs from the installed copy, so it is swapped for the new one rather than
# written over: the host keeps the files it has open, and macOS kills a process whose code changes
# under it.
rm -rf /Applications/.Liszt-new.app /Applications/.Liszt-old.app
ditto release/mac-arm64/Liszt.app /Applications/.Liszt-new.app
[ -d /Applications/Liszt.app ] && mv /Applications/Liszt.app /Applications/.Liszt-old.app
mv /Applications/.Liszt-new.app /Applications/Liszt.app
rm -rf /Applications/.Liszt-old.app

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
