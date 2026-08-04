#!/usr/bin/env bash
# Render dashboard/icons/*.svg to the PNGs the manifest and service worker use.
#
#   bash scripts/make-icons.sh
#
# The SVGs are the source of truth; the PNGs are build output that happens to be
# committed, because a PWA manifest cannot point at an SVG for the maskable and
# badge slots on Android and Cloudflare Pages serves static files only.
#
# Rendering uses headless Chrome rather than a Node or Python image library, so
# there is nothing to install: Playwright's Chromium is already on the box, and
# on a machine without it any Chrome or Chromium on PATH will do. Chrome is also
# the thing that will actually display these icons, which makes it the most
# honest renderer available.
#
# --default-background-color=00000000 is what keeps the badge transparent. Drop
# it and Chrome paints white behind the SVG, which is precisely the bug this
# script exists to fix.
set -euo pipefail
cd "$(dirname "$0")/.."

# headless_shell FIRST, and not as a stylistic preference. Chrome's new headless
# mode renders a viewport shorter than the --window-size it is given: asking for
# 512x512 produced artwork occupying 512x425 with the bottom 87 rows transparent,
# while the PNG header still read 512x512. --headless=old, which did not do this,
# has been removed. headless_shell has no window chrome and gets it exactly right.
chrome=""
for c in \
  /opt/pw-browsers/chromium_headless_shell-*/chrome-linux/headless_shell \
  "$(command -v chrome-headless-shell || true)" \
  /opt/pw-browsers/chromium-*/chrome-linux/chrome \
  "$(command -v google-chrome || true)" \
  "$(command -v chromium || true)" \
  "$(command -v chromium-browser || true)" \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
do
  [ -n "$c" ] && [ -x "$c" ] && { chrome="$c"; break; }
done
[ -n "$chrome" ] || { echo "no chrome/chromium found — install one or set \$chrome" >&2; exit 1; }
echo "renderer: $chrome"
case "$chrome" in
  *headless_shell|*chrome-headless-shell) ;;
  *) echo "note: this is full Chrome, which clips the viewport. check-png.mjs will catch it if it does." ;;
esac

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

render() {                                # $1 = svg, $2 = px, $3 = out.png
  local svg="$1" px="$2" out="$3"
  # Screenshot a zero-margin HTML wrapper, never the .svg directly. Chrome gives
  # a standalone SVG document the default 8px body margin, which shifted every
  # icon down-right and clipped 8px off the bottom and right edges — visible as
  # a transparent corner on what should be a full-bleed maskable icon.
  cat > "$tmp/wrap.html" <<HTML
<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;background:transparent;overflow:hidden}
  img{display:block;width:${px}px;height:${px}px}
</style>
<img src="file://$PWD/$svg" alt="">
HTML
  local flags="--disable-gpu --no-sandbox --hide-scrollbars --force-device-scale-factor=1"
  case "$chrome" in *headless_shell|*chrome-headless-shell) ;; *) flags="--headless $flags" ;; esac
  # shellcheck disable=SC2086
  "$chrome" $flags \
    --default-background-color=00000000 \
    --screenshot="$tmp/shot.png" \
    --window-size="${px},${px}" \
    "file://$tmp/wrap.html" >/dev/null 2>&1
  [ -s "$tmp/shot.png" ] || { echo "render failed: $svg" >&2; exit 1; }
  mv "$tmp/shot.png" "$out"
  node scripts/check-png.mjs "$out" "$px" "$4"
}

echo "rendering:"
render dashboard/icons/icon.svg           192 dashboard/icon-192.png          centred
render dashboard/icons/icon.svg           512 dashboard/icon-512.png          centred
render dashboard/icons/icon-maskable.svg  512 dashboard/icon-maskable-512.png bleed
render dashboard/icons/badge.svg           96 dashboard/badge-96.png          centred
echo "done — bump SHELL in dashboard/sw.js so devices actually pick these up."
