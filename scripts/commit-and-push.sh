#!/usr/bin/env bash
# Commit whatever a run produced and get it to origin, surviving a concurrent
# writer (the bridge, the desktop watcher, or the other workflow).
#
#   bash scripts/commit-and-push.sh "<commit message>" ["<author name>"]
#
# Extracted from the two workflows, which carried the same rebase-retry loop
# twice. Exits 0 when there was nothing to commit — an empty run is a normal
# outcome, not a failure.
set -uo pipefail
message="${1:?usage: commit-and-push.sh <message> [author]}"
author="${2:-life-vault runner}"

git config user.name "$author"
git config user.email "actions@github.com"
git add -A
if git diff --cached --quiet; then
  echo "nothing to commit"
  exit 0
fi
git commit -m "$message"

branch="$(git rev-parse --abbrev-ref HEAD)"
for a in 1 2 3 4 5; do
  git push && exit 0
  echo "push rejected — rebasing ($a)…"
  git pull --rebase --autostash origin "$branch" || git rebase --abort || true
  sleep $((a * 3))
done
echo "push failed after retries"
exit 1
