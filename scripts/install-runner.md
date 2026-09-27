# One-time setup: self-hosted GitHub Actions runner on the SnakeArcade server

`.github/workflows/deploy.yml` deploys every push to `main` (and manual
"Run workflow" clicks) by running on a **self-hosted runner installed on the
production Windows server**. The runner only makes outbound HTTPS calls to
GitHub, so no inbound port, RDP, or SSH access is needed.

Do these steps once, as a local Administrator on the server, **before merging
the PR that adds the workflow** (the merge itself is a push to `main` and will
queue a deploy; a queued job waits for a runner for up to 24 hours).

Assumed layout (matches `scripts/deploy.ps1` defaults and the workflow `env:`):

| Item | Value |
| --- | --- |
| Content root | `C:\WebApps\SnakeArcade` (contains `web.config`, `data\`) |
| Player data | `C:\WebApps\SnakeArcade\data\settings.json` (never copied over or deleted) |
| Node service | `SnakeArcadeNode` (WinSW, `C:\Tools\WinSW\SnakeArcadeNode.exe` + `.xml`), `PORT=3105` |
| Node.js | on `PATH`, or `C:\Program Files\nodejs` |
| Data backups | `C:\WebApps\SnakeArcade-backups` (a copy of `settings.json` before each deploy, last 20 kept) |
| Runner folder | `C:\actions-runner` |
| Runner account | local user `svc-snakearcade` (not an administrator) |

If any of these differ, change the `env:` block in `.github/workflows/deploy.yml`.

---

## 1. Create a dedicated, non-admin service account

```powershell
$pw = Read-Host -AsSecureString "Password for svc-snakearcade"
New-LocalUser -Name "svc-snakearcade" -Password $pw `
  -PasswordNeverExpires -UserMayNotChangePassword -AccountNeverExpires `
  -Description "GitHub Actions runner for SnakeArcade deploys"
```

Windows limits local account names to 20 characters, so keep the name short.
Do **not** add it to Administrators. (On a domain you can use a gMSA
instead; the grants below are the same.)

## 2. Grant only what the deploy needs

### 2a. Write access to the content root and backup folder

```powershell
icacls "C:\WebApps\SnakeArcade" /grant "svc-snakearcade:(OI)(CI)M"
New-Item -ItemType Directory -Force "C:\WebApps\SnakeArcade-backups" | Out-Null
icacls "C:\WebApps\SnakeArcade-backups" /grant "svc-snakearcade:(OI)(CI)M"
```

`M` (Modify) is needed because the mirror deletes files that were removed
from the repo. The account running `SnakeArcadeNode` keeps its existing
access; new files inherit the folder ACL.

### 2b. Stop/start rights on the `SnakeArcadeNode` service only

This adds one ACE (query + start + stop, no config change) to that service's
security descriptor. The original descriptor is saved first so it can be
restored.

```powershell
$svc  = "SnakeArcadeNode"
$sid  = (New-Object System.Security.Principal.NTAccount("svc-snakearcade")).Translate(
          [System.Security.Principal.SecurityIdentifier]).Value
$sd   = ((sc.exe sdshow $svc) | Where-Object { $_ }) -join ""
$sd | Set-Content "C:\WebApps\SnakeArcade-backups\SnakeArcadeNode-sddl-original.txt"
$ace  = "(A;;CCLCSWRPWPLORC;;;$sid)"
if ($sd -notlike "*$sid*") {
  $i   = $sd.IndexOf("S:")
  $new = if ($i -ge 0) { $sd.Insert($i, $ace) } else { $sd + $ace }
  sc.exe sdset $svc $new
}
sc.exe sdshow $svc
```

Rights in the ACE: `CC` query config, `LC` query status, `SW` enumerate
dependents, `RP` start, `WP` stop, `LO` interrogate, `RC` read permissions.
To undo: `sc.exe sdset SnakeArcadeNode (Get-Content C:\WebApps\SnakeArcade-backups\SnakeArcadeNode-sddl-original.txt)`.

## 3. Download the Actions runner (Windows x64)

Get the current commands (with the current version and SHA-256) from
**GitHub > bigmac529/SnakeArcade > Settings > Actions > Runners >
New self-hosted runner > Windows / x64**. At the time of writing:

```powershell
mkdir C:\actions-runner; cd C:\actions-runner
Invoke-WebRequest -Uri https://github.com/actions/runner/releases/download/v2.337.0/actions-runner-win-x64-2.337.0.zip -OutFile actions-runner-win-x64-2.337.0.zip
if ((Get-FileHash -Path actions-runner-win-x64-2.337.0.zip -Algorithm SHA256).Hash.ToUpper() -ne '1150692afa94e71f872017e254ea55b6eece1eece3fe7e3a6d4c93d0a1b85cfc'.ToUpper()) { throw 'Computed checksum did not match' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory("$PWD\actions-runner-win-x64-2.337.0.zip", "$PWD")
```

Keep the runner out of `C:\Users` and `C:\Program Files`.

## 4. Register it as a Windows service

The token comes from the same "New self-hosted runner" page (it expires
after about an hour).

```powershell
cd C:\actions-runner
.\config.cmd --url https://github.com/bigmac529/SnakeArcade --token <TOKEN> `
  --name snakearcade-prod --labels snakearcade --runasservice `
  --windowslogonaccount ".\svc-snakearcade"
```

- If the password contains cmd.exe special characters (`& | < > ^ %`), `config.cmd` breaks; run `.\bin\Runner.Listener.exe configure ...` with the same arguments instead, or use a letters-and-digits password.
- Leave `--windowslogonpassword` off so `config.cmd` prompts for the password
  (keeps it out of shell history).
- The runner gets `self-hosted`, `Windows`, `X64` automatically; `snakearcade`
  is the extra label the workflow targets (`runs-on: [self-hosted, windows, snakearcade]`).
- `config.cmd` grants the account "Log on as a service" and access to
  `C:\actions-runner`; it creates a service named like
  `actions.runner.bigmac529-SnakeArcade.snakearcade-prod`.
- Without `--windowslogonaccount` it would run as `NT AUTHORITY\NETWORK SERVICE`;
  then grant steps 2a/2b to `NETWORK SERVICE` (SID `S-1-5-20`) instead. The
  dedicated account is preferred because other services also run as NETWORK SERVICE.

## 5. Confirm it is online

```powershell
Get-Service "actions.runner.*" | Format-Table Name, Status, StartType
```

The service should be `Running` / `Automatic`, and **Settings > Actions >
Runners** should list `snakearcade-prod` as **Idle** with the labels
`self-hosted, Windows, X64, snakearcade`.

## 6. Dry run, then a real deploy

Optional but recommended before the first automated deploy: preview what the
mirror would copy and delete, without stopping anything.

```powershell
git clone https://github.com/bigmac529/SnakeArcade C:\Temp\SnakeArcade-dry
cd C:\Temp\SnakeArcade-dry
npm.cmd ci --omit=dev
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\deploy.ps1 -DryRun
```

Anything listed as `*EXTRA File` / `*EXTRA Dir` would be deleted from
`C:\WebApps\SnakeArcade`. `data\`, `web.config`, `logs\`, `*.log` and the
WinSW files are excluded and must not show up. If something else must stay
(for example a `.well-known` folder), add it to `-ExtraExcludeDirs` /
`-ExtraExcludeFiles` in the workflow's deploy step.

Then merge (or run **Actions > Deploy > Run workflow** on `main`) and watch
the job: it ends with `DEPLOY OK` after `/api/health` answers `ok: true`.

---

## Security: public repo + self-hosted runner

The runner executes code on the production server, and this repository is
public. Rules:

1. **The deploy workflow must never run on `pull_request` or
   `pull_request_target`, especially from forks.** It triggers only on
   `push` to `main` and `workflow_dispatch` (which only users with write
   access can start), and the job also checks
   `github.ref == 'refs/heads/main'`. Do not add PR triggers to it.
2. **A fork PR can add its own workflow file** that targets
   `runs-on: [self-hosted, snakearcade]`. Pull-request workflows run the
   PR's version of `.github/workflows`, so the triggers in `deploy.yml` alone
   do not protect the runner. Therefore turn on:
   **Settings > Actions > General > "Approval for running fork pull request
   workflows from contributors" > "Require approval for all external
   contributors"** (older UI: "Require approval for all outside
   collaborators"), and never approve a fork run you have not read,
   especially one that changes anything under `.github/`.
3. Optional hardening: **Settings > Environments > production** (created on
   the first deploy) > "Deployment branches and tags" > *Selected branches* >
   `main`; and add required reviewers if you want a manual gate.
4. The workflow token is read-only (`permissions: contents: read`) and
   checkout does not persist credentials on disk.
5. The runner account is not an administrator: it can only write the content
   root / backup folder and start/stop `SnakeArcadeNode`.

## Removing the runner

```powershell
cd C:\actions-runner
.\config.cmd remove --token <removal token from Settings > Actions > Runners>
```
