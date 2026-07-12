# Desktop bridge — schedule `scripts/bridge.sh`

The bridge mirrors the local Obsidian vault to GitHub every ~10 min while the
laptop is on. Pick your OS. Set `VAULT_DIR` to the vault path; source `.env` so
conflict alerts can reach ntfy.

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
```
schtasks /Create /SC MINUTE /MO 10 /TN "life-vault-bridge" ^
  /TR "\"C:\Program Files\Git\bin\bash.exe\" -lc \"VAULT_DIR='%USERPROFILE%/life-vault' bash '%USERPROFILE%/life-vault/scripts/bridge.sh'\""
```

Accept (spec §11 Phase 1): a phone edit reaches GitHub within one cycle; `.git`
untouched by Obsidian Sync; a forced conflict lands on a `conflict/<date>` branch
and pings ntfy — never a silent loss, never a force-push.
