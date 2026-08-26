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

**2. Only once that works, schedule it.** Use the PowerShell cmdlets, not
`schtasks`:

```powershell
$exe = "C:\Program Files\Git\bin\bash.exe"
$arg = "-lc ""VAULT_DIR='C:/Users/BenLeary/life-os' bash '/c/Users/BenLeary/life-os/scripts/bridge.sh'"""
$act = New-ScheduledTaskAction -Execute $exe -Argument $arg
$trg = New-ScheduledTaskTrigger -Once -At (Get-Date) `
         -RepetitionInterval (New-TimeSpan -Minutes 10) `
         -RepetitionDuration ([TimeSpan]::FromDays(3650))
Register-ScheduledTask -TaskName "life-vault-bridge" -Action $act -Trigger $trg `
  -Description "Mirror the Obsidian vault to GitHub every 10 minutes" -Force
```

> **Why not `schtasks`.** Its `/TR` argument needs a command line nested inside
> a quoted string, and every published example escapes that with `\"`, which is
> a **cmd.exe** convention. PowerShell does not honour it, so the argument
> splits on the space in `C:\Program Files` and the command dies with
> `Invalid argument/option - 'C:\Program'`. `New-ScheduledTaskAction` takes the
> executable and its arguments as separate parameters, so there is no nesting to
> get wrong. If you do want `schtasks`, run it from **cmd.exe**, or prefix it
> with PowerShell's stop-parsing token: `schtasks.exe --% /Create /SC MINUTE …`.

The task runs as you, only while you are logged on — which is what you want: the
bridge exists to sync a laptop that is in use. It needs no stored password.

> A console window will flash briefly every ten minutes, because `bash.exe` is a
> console program. If that irritates, edit the task in Task Scheduler and tick
> **Run whether user is logged on or not** — it then runs without a visible
> window, at the cost of storing your Windows password.

**3. Confirm it is actually scheduled and running:**

```powershell
Get-ScheduledTask -TaskName "life-vault-bridge" | Get-ScheduledTaskInfo
```

Wait ten minutes, run it again, and check `LastRunTime` has moved.

`Last Result: 0` is healthy. A non-zero result, or a `Last Run Time` that never
advances, means it is registered but not working — which looks exactly like
being unscheduled from the outside. Check it a fortnight after setting it up:
the failure mode here is not a crash, it is silence.

Accept (spec §11 Phase 1): a phone edit reaches GitHub within one cycle; `.git`
untouched by Obsidian Sync; a forced conflict lands on a `conflict/<date>` branch
and pushes an alert — never a silent loss, never a force-push.
