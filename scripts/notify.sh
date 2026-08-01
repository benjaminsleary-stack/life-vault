#!/usr/bin/env bash
# Push a briefing to the phone. Delivery must not depend on sync/laptop.
#   notify.sh "<title>" <markdown-file>|-
# The message body is the file's contents (or, with '-', stdin / a short reason).
#
# Delivery is the vault's OWN Web Push, via the Worker: this POSTs to
# $WORKER_URL/api/push/send and the Worker signs (VAPID) and encrypts
# (RFC 8291) one message per registered device. ntfy is gone — it meant a
# third-party app on the phone and a topic whose only protection was being hard
# to guess, carrying the evening brief's Charlotte section in cleartext.
#
# Env: WORKER_URL     e.g. https://life-vault.benvault.workers.dev
#      UNLOCK_TOKEN   the same shared secret the app uses
# Both are already present in the workflows' env block.
#
# Delivery receipt: if LV_DELIVERY_RECEIPT names a file, the outcome is written
# there as "<true|false>\t<reason>". run-skill.sh folds it into the .status file
# and health() turns a false into a failed check. Push is now the ONLY channel,
# so "no device is registered" is a delivery failure and says so — there is no
# fallback left to quietly absorb it.
#
# Deliberately NOT `set -e`: every failure path has to write its receipt before
# exiting, and an early exit is what hid twelve days of undelivered briefs.
set -uo pipefail
title="${1:-Life-Vault}"
src="${2:--}"

receipt() {                               # $1 = true|false, $2 = short reason
  [ -n "${LV_DELIVERY_RECEIPT:-}" ] || return 0
  printf '%s\t%s\n' "$1" "$2" > "$LV_DELIVERY_RECEIPT" 2>/dev/null || true
}
fail() {                                  # $1 = reason
  receipt false "$1"
  echo "notify: FAILED — $1" >&2
  exit 1
}

worker="${WORKER_URL:-}"
token="${UNLOCK_TOKEN:-}"
[ -n "$worker" ] || fail "WORKER_URL not set (or empty) in this environment"
[ -n "$token" ]  || fail "UNLOCK_TOKEN not set (or empty) in this environment"
worker="${worker%/}"

if [ "$src" = "-" ]; then
  body="$(cat)"
else
  [ -r "$src" ] || fail "no such file to send: $src"
  body="$(cat "$src")"
fi
[ -n "$body" ] || fail "nothing to send (empty body)"

# Web Push caps the encrypted payload at ~4KB; the Worker trims too, but keep
# well inside it here so a long brief is truncated rather than rejected.
body="$(printf '%s' "$body" | head -c 2400)"

# Build the JSON with node rather than by hand — a brief is full of quotes,
# newlines, em dashes and markdown links, and hand-rolled escaping is how you
# end up sending a body that is silently dropped as malformed.
payload="$(TITLE="$title" BODY="$body" node -e '
  process.stdout.write(JSON.stringify({ title: process.env.TITLE, body: process.env.BODY }));
' 2>/dev/null)"
[ -n "$payload" ] || fail "could not encode the message (is node on PATH?)"

resp="$(curl -sS --max-time 30 -X POST \
  -H "Authorization: Bearer ${token}" \
  -H "Content-Type: application/json" \
  -d "$payload" \
  "${worker}/api/push/send" 2>&1)" || fail "could not reach the Worker: ${resp:0:160}"

# The Worker reports how many devices it actually reached. Zero is a failure,
# including the "nobody has ever subscribed" case — push is the only channel.
read -r ok sent err <<< "$(RESP="$resp" node -e '
  let j = {};
  try { j = JSON.parse(process.env.RESP); } catch (e) {}
  const clean = (s) => String(s || "").replace(/[\t\r\n]+/g, " ").slice(0, 200) || "-";
  process.stdout.write([j.ok ? "true" : "false", j.sent || 0, clean(j.error)].join("\t"));
' 2>/dev/null)"

if [ "${ok:-false}" = "true" ]; then
  receipt true ""
  echo "notified: ${title} → ${sent} device(s), ${#body} bytes"
else
  [ "$err" = "-" ] && err="the Worker rejected the push"
  fail "$err"
fi
