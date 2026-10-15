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
open /Applications/Liszt.app
