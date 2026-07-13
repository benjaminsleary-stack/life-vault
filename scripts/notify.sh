#!/usr/bin/env bash
# Push a briefing to the phone via ntfy. Delivery must not depend on sync/laptop.
#   notify.sh "<title>" <markdown-file>|-
# The message body is the file's contents (or, with '-', stdin / a short reason).
# Env: NTFY_TOPIC (a private, hard-to-guess topic), optional NTFY_SERVER (default ntfy.sh),
#      optional NTFY_TOKEN (bearer for a protected topic).
set -euo pipefail
title="${1:-Life-Vault}"
src="${2:--}"
server="${NTFY_SERVER:-https://ntfy.sh}"
topic="${NTFY_TOPIC:?NTFY_TOPIC not set}"

if [ "$src" = "-" ]; then body="$(cat)"; else body="$(cat "$src")"; fi
# ntfy has a body size limit; keep it safe (spec §13.8 — verify exact limit).
body="$(printf '%s' "$body" | head -c 3800)"

auth=()
[ -n "${NTFY_TOKEN:-}" ] && auth=(-H "Authorization: Bearer ${NTFY_TOKEN}")

curl -fsS "${auth[@]}" \
  -H "Title: ${title}" \
  -H "Markdown: yes" \
  -d "$body" \
  "${server}/${topic}" >/dev/null
echo "notified: ${title} (${#body} bytes)"
