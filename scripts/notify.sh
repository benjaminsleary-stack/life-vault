#!/usr/bin/env bash
# Push a briefing to the phone via ntfy. Delivery must not depend on sync/laptop.
#   notify.sh "<title>" <markdown-file>|-
# The message body is the file's contents (or, with '-', stdin / a short reason).
# Env: NTFY_TOPIC (a private, hard-to-guess topic), optional NTFY_SERVER (default ntfy.sh),
#      optional NTFY_TOKEN (bearer for a protected topic).
#
# Delivery receipt: if LV_DELIVERY_RECEIPT names a file, the outcome is written
# there as "<true|false>\t<reason>". run-skill.sh sets it and folds the result
# into inbox/_runs/<skill>.status, so a brief that was written but never reached
# the phone stops reading as a clean run. Between 20 Jul and 1 Aug 2026 every
# brief failed delivery on a blank NTFY_TOPIC and the dashboard still said "all
# routines on schedule" — silence must be loud (CLAUDE.md rule 5), and this
# receipt is the wire that makes it so.
#
# Deliberately NOT `set -e`: every failure path has to write its receipt before
# exiting, and an early exit is exactly what hid those twelve days.
set -uo pipefail
title="${1:-Life-Vault}"
src="${2:--}"
server="${NTFY_SERVER:-https://ntfy.sh}"

receipt() {                               # $1 = true|false, $2 = short reason
  [ -n "${LV_DELIVERY_RECEIPT:-}" ] || return 0
  printf '%s\t%s\n' "$1" "$2" > "$LV_DELIVERY_RECEIPT" 2>/dev/null || true
}
fail() {                                  # $1 = reason
  receipt false "$1"
  echo "notify: FAILED — $1" >&2
  exit 1
}

# `${NTFY_TOPIC:?}` used to trip here and kill the script before anything was
# recorded. Unset and set-but-empty are the same failure, and the second is the
# one that actually happened, so one explicit check catches both.
topic="${NTFY_TOPIC:-}"
[ -n "$topic" ] || fail "NTFY_TOPIC not set (or empty) in this environment"

if [ "$src" = "-" ]; then
  body="$(cat)"
else
  [ -r "$src" ] || fail "no such file to send: $src"
  body="$(cat "$src")"
fi
[ -n "$body" ] || fail "nothing to send (empty body)"
# ntfy has a body size limit; keep it safe (spec §13.8 — verify exact limit).
body="$(printf '%s' "$body" | head -c 3800)"

auth=()
[ -n "${NTFY_TOKEN:-}" ] && auth=(-H "Authorization: Bearer ${NTFY_TOKEN}")

if err="$(curl -fsS --max-time 30 "${auth[@]}" \
  -H "Title: ${title}" \
  -H "Markdown: yes" \
  -d "$body" \
  "${server}/${topic}" 2>&1 >/dev/null)"; then
  receipt true ""
  echo "notified: ${title} (${#body} bytes)"
else
  fail "ntfy rejected the push: ${err:-curl failed}"
fi
