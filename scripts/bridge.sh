#!/usr/bin/env bash
# Desktop bridge: mirror the local Obsidian vault to the GitHub repo.
# Run every ~10 min by an OS scheduler (launchd / Task Scheduler / cron) while the
# laptop is on. This — NOT the obsidian-git plugin — is the mechanism of record.
#
# Guarantees (spec §1b): pull --rebase before push; on conflict, park local work on
# a conflict/<date> branch, push it, alert via push notification, and STOP. Never force-push,
# never exit silently, never lose an edit.
#
# Usage: VAULT_DIR=~/life-vault bash scripts/bridge.sh
# Env: VAULT_DIR (default: repo root), optional WORKER_URL/UNLOCK_TOKEN for alerts.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
VAULT_DIR="${VAULT_DIR:-$(cd "$HERE/.." && pwd)}"

# Defined BEFORE the directory check, and pointing at notify.sh by absolute
# path, because the first thing that can go wrong happens before we are in the
# vault — and the old order meant the one failure most likely to occur was the
# one failure that could not speak.
alert() {  # best-effort; never fail the bridge because alerting failed
  if [ -n "${WORKER_URL:-}" ] && [ -f "$HERE/notify.sh" ]; then
    printf '%s' "$1" | bash "$HERE/notify.sh" "⚠️ vault bridge" - || true
  fi
  echo "ALERT: $1" >&2
}

# A wrong VAULT_DIR is the likeliest setup mistake and used to be the quietest.
# The scheduled task fired every ten minutes, printed "no vault dir" into a log
# file nobody opens, and exited 2 — for fourteen days. The documented Windows
# command hard-coded %USERPROFILE%/life-vault; the actual clone is life-os. The
# drift was found by accident, reconciling twelve days of divergence by hand.
if ! cd "$VAULT_DIR" 2>/dev/null; then
  alert "bridge cannot start: VAULT_DIR '$VAULT_DIR' does not exist. Check the path in the scheduled task."
  exit 2
fi
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  alert "bridge cannot start: '$VAULT_DIR' is not a git repository."
  exit 2
fi

# 1. Commit whatever Obsidian changed locally (fine if nothing).
git add -A
git commit -m "vault edits $(date -u +%FT%TZ)" >/dev/null 2>&1 || true

# 2. Integrate remote (routine pushes) by rebasing local on top.
if git pull --rebase --autostash origin "$(git branch --show-current)" >/dev/null 2>&1; then
  # 3. Push the integrated result.
  if ! git push >/dev/null 2>&1; then
    alert "push failed after clean rebase — will retry next cycle"
    exit 1
  fi
  exit 0
fi

# Rebase hit a conflict. Park local work safely and stop.
git rebase --abort >/dev/null 2>&1 || true
branch="conflict/$(date +%F-%H%M%S)"
git checkout -b "$branch" >/dev/null 2>&1
git push -u origin "$branch" >/dev/null 2>&1 || alert "couldn't push $branch"
git checkout - >/dev/null 2>&1 || true
alert "sync conflict — your local edits are safe on '$branch'. Resolve on desktop; the bridge is paused on main until then."
exit 1
