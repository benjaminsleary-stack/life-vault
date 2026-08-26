# Desktop bridge — schedule `scripts/bridge.sh`

The bridge mirrors the local Obsidian vault to GitHub every ~10 min while the
laptop is on. Pick your OS. Set `VAULT_DIR` to the vault path; source `.env` so
conflict alerts can reach your phone.

## macOS (launchd)
`~/Library/LaunchAgents/com.ben.life-vault-bridge.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.ben.life-vault-bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>set -a; source "$HOME/life-vault/.env"; VAULT_DIR="$HOME/life-vault" bash "$HOME/life-vault/scripts/bridge.sh" &gt;&gt; "$HOME/life-vault/scripts/_work/bridge.log" 2&gt;&amp;1</string>
  </array>
  <key>StartInterval</key><integer>600</integer>
  <key>RunAtLoad</key><true/>
</dict></plist>
```
Then: `launchctl load ~/Library/LaunchAgents/com.ben.life-vault-bridge.plist`

## Linux (cron)
`crontab -e`:
```
*/10 * * * * set -a; . $HOME/life-vault/.env; VAULT_DIR=$HOME/life-vault bash $HOME/life-vault/scripts/bridge.sh >> $HOME/life-vault/scripts/_work/bridge.log 2>&1
```

## Windows (Task Scheduler, via Git Bash)

**Use your real clone path, and check it before scheduling anything.** This
section used to hard-code `%USERPROFILE%/life-vault`. The actual clone is
`C:\Users\BenLeary\life-os`, so the scheduled task pointed at a directory that
does not exist, failed every ten minutes into a log nobody opens, and went
unnoticed for fourteen days while the desktop drifted twelve days out of sync.
`bridge.sh` now pushes a notification instead of dying quietly, but the path
still has to be right.

**1. Prove it runs, by hand, before scheduling it.** In PowerShell:

```powershell
& "C:\Program Files\Git\bin\bash.exe" -lc "VAULT_DIR='C:/Users/BenLeary/life-os' bash '/c/Users/BenLeary/life-os/scripts/bridge.sh'"
echo "exit=$LASTEXITCODE"
```

`exit=0` is a clean sync. `exit=2` means the path is wrong — the message says
which. Note the two forms of the same path: `VAULT_DIR` takes the Windows form
with forward slashes, the script argument takes the Git Bash form (`/c/Users/…`).

**2. Only once that works, schedule it:**

```powershell
schtasks /Create /SC MINUTE /MO 10 /TN "life-vault-bridge" /TR "\"C:\Program Files\Git\bin\bash.exe\" -lc \"VAULT_DIR='C:/Users/BenLeary/life-os' bash '/c/Users/BenLeary/life-os/scripts/bridge.sh'\""
```

**3. Confirm it is actually scheduled and running:**

```powershell
schtasks /Query /TN "life-vault-bridge" /V /FO LIST | Select-String "Status|Last Run|Last Result|Next Run"
```

`Last Result: 0` is healthy. A non-zero result, or a `Last Run Time` that never
advances, means it is registered but not working — which looks exactly like
being unscheduled from the outside. Check it a fortnight after setting it up:
the failure mode here is not a crash, it is silence.

Accept (spec §11 Phase 1): a phone edit reaches GitHub within one cycle; `.git`
untouched by Obsidian Sync; a forced conflict lands on a `conflict/<date>` branch
and pushes an alert — never a silent loss, never a force-push.
