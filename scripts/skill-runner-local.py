#!/usr/bin/env python3
"""
Local skill runner — the fast, desktop-on path for the Life-Vault dashboard.

The dashboard "Run" button drops a trigger (inbox/_runs/<skill>-<ts>.run) into
the vault as a GitHub commit. This watcher, running on the desktop with the
Claude CLI already installed, pulls those triggers and runs the skill locally —
no CI cold-start, no per-run install, so it starts in seconds instead of the
~2 minutes the GitHub Action spends provisioning.

It CLAIMS each trigger (archives it and pushes) before running, so the cloud
Action (the laptop-off fallback) sees it's handled and stays idle. When this
watcher isn't running, the Action picks the trigger up as normal.

Run one pass (e.g. from Task Scheduler every 1-2 min):
    python scripts/skill-runner-local.py
Run continuously:
    python scripts/skill-runner-local.py --watch 15     # poll every 15s

Requires: git, bash (Git Bash ships it on Windows), and the Claude CLI on PATH
(`npm i -g @anthropic-ai/claude-code`, then `claude` logged in, or set
CLAUDE_CODE_OAUTH_TOKEN in the environment).
"""
import os
import re
import sys
import glob
import time
import shutil
import subprocess

VAULT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNS = os.path.join(VAULT, "inbox", "_runs")
ARCHIVE = os.path.join(RUNS, "_archive")
STAMP_RE = re.compile(r"-\d{4}-\d{2}-\d{2}T\d{6}$")


def git(*args):
    return subprocess.run(["git", *args], cwd=VAULT, capture_output=True, text=True)


def branch():
    return git("branch", "--show-current").stdout.strip() or "main"


def push_with_rebase(br):
    for attempt in range(1, 6):
        if git("push").returncode == 0:
            return True
        git("pull", "--rebase", "--autostash", "origin", br)
        time.sleep(attempt * 2)
    return False


def skill_of(runfile):
    base = os.path.basename(runfile)[:-4]        # strip ".run"
    return STAMP_RE.sub("", base)                # strip "-<ISO stamp>"


def process_once():
    br = branch()
    git("pull", "--rebase", "--autostash", "origin", br)   # fetch new triggers
    runs = sorted(glob.glob(os.path.join(RUNS, "*.run")))
    if not runs:
        return 0
    if not shutil.which("claude"):
        print("ERROR: 'claude' not on PATH. Install: npm i -g @anthropic-ai/claude-code")
        return 0

    os.makedirs(ARCHIVE, exist_ok=True)
    done = 0
    for f in runs:
        skill = skill_of(f)
        base = os.path.basename(f)
        print(f"[local-runner] claim {skill} ({base})")

        # CLAIM first: archive the trigger and push before running, so the cloud
        # fallback sees it handled. If the push loses a race, back out cleanly.
        shutil.move(f, os.path.join(ARCHIVE, base))
        git("add", "-A")
        git("commit", "-m", f"local-runner: claim {skill}")
        if not push_with_rebase(br):
            print("  claim push failed — leaving it for the cloud fallback")
            git("reset", "--hard", f"origin/{br}")
            continue

        # RUN via the shared runner (writes inbox/_runs/<skill>.status).
        print(f"[local-runner] running {skill} …")
        subprocess.run(["bash", "scripts/run-skill.sh", skill], cwd=VAULT)
        git("add", "-A")
        git("commit", "-m", f"local-runner: {skill} result")
        push_with_rebase(br)
        done += 1
        print(f"[local-runner] {skill} done")
    return done


def main():
    if "--watch" in sys.argv:
        i = sys.argv.index("--watch")
        interval = int(sys.argv[i + 1]) if len(sys.argv) > i + 1 else 15
        print(f"[local-runner] watching inbox/_runs every {interval}s (Ctrl+C to stop)")
        while True:
            try:
                process_once()
            except Exception as e:
                print("cycle error:", e)
            time.sleep(interval)
    else:
        process_once()


if __name__ == "__main__":
    main()
