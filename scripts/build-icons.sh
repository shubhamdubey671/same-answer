#!/bin/sh
# Renders icons/icon.svg into icons/icon16.png, icon48.png and icon128.png
# (transparent corners). macOS: needs Google Chrome and sips.
#   scripts/build-icons.sh [output-dir]      output-dir defaults to icons/
set -eu
cd "$(dirname "$0")/.."
OUT="${1:-icons}"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT"
printf '<!doctype html><body style="margin:0;background:transparent"><img src="file://%s/icons/icon.svg" width="512" height="512" style="display:block">' "$PWD" > "$TMP/master.html"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 \
  --window-size=512,512 --screenshot="$TMP/master.png" "file://$TMP/master.html" >/dev/null 2>&1
for size in 16 48 128; do sips -z "$size" "$size" "$TMP/master.png" --out "$OUT/icon$size.png" >/dev/null; done
