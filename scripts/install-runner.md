# One-time setup: self-hosted GitHub Actions runner on the SnakeArcade server

The deploy jobs of `.github/workflows/build-and-deploy-test.yml` (every push
to `main` goes to the **test** site) and `.github/workflows/deploy-production.yml`
(manual publish to **production**) run on a **self-hosted runner installed on
the Windows server**; both call `.github/workflows/deploy-build.yml`. One
runner serves both sites. Building happens on GitHub-hosted runners; this
runner only downloads a verified build zip and deploys it. The runner only makes outbound HTTPS calls to
GitHub, so no inbound port, RDP, or SSH access is needed.

Do these steps once, as a local Administrator on the server, **before merging
the PR that adds the workflow** (the merge itself is a push to `main` and will
queue a deploy; a queued job waits for a runner for up to 24 hours).

Assumed layout (matches the defaults in `.github/workflows/deploy-build.yml`):

| Item | Production | Test |
| --- | --- | --- |
| Content root (contains `web.config`, `data\`, `logs\`) | `C:\WebApps\SnakeArcade` | `C:\WebApps\SnakeArcadeTest` |
| Player data (never copied over or deleted) | `...\data\settings.json` | `...\data\settings.json` |
| Node service (WinSW, `C:\Tools\WinSW\<name>.exe` + `.xml`) | `SnakeArcadeNode`, `PORT=3105` | `SnakeArcadeTestNode`, `PORT=3107` |
| Data backups (`settings.json` before each deploy, last 20 kept) | `C:\WebApps\SnakeArcade-backups` | `C:\WebApps\SnakeArcadeTest-backups` |
| Settings/secrets folder (after the accounts PR) | `C:\WebApps\SnakeArcade-config` | `C:\WebApps\SnakeArcadeTest-config` |
| Node.js | on `PATH`, or `C:\Program Files\nodejs` | same |
| Runner folder / account | `C:\actions-runner` / local user `svc-snakearcade` (not an administrator) | same runner |

If any of these differ, set the matching variable (`APP_ROOT`, `SERVICE_NAME`,
`APP_PORT`, `PUBLIC_URL`, `ENV_FILE`, `BACKUP_ROOT`) on the `production` or
`test` environment (**Settings > Environments**); see `docs/release-pipeline.md`.

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

For the test site, do the same for `C:\WebApps\SnakeArcadeTest` and
`C:\WebApps\SnakeArcadeTest-backups` (already done on socha3).

With the accounts version, each deploy also runs database migrations with
the site's env file, so the runner needs **Read** (not Modify) on each
site's config folder:

```powershell
icacls "C:\WebApps\SnakeArcadeTest-config" /grant "svc-snakearcade:(OI)(CI)R"
icacls "C:\WebApps\SnakeArcade-config"     /grant "svc-snakearcade:(OI)(CI)R"
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

Repeat with `$svc = "SnakeArcadeTestNode"` (saving to
`C:\WebApps\SnakeArcadeTest-backups\SnakeArcadeTestNode-sddl-original.txt`) for
the test service (already done on socha3).

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

Download a build zip from the repo's **Releases** page (or a clone with
`npm.cmd ci --omit=dev`), extract it to e.g. `C:\Temp\SnakeArcade-dry`, then:

```powershell
cd C:\Temp\SnakeArcade-dry
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\deploy.ps1 -SourceDir . -DryRun `
  -AppRoot C:\WebApps\SnakeArcadeTest -ServiceName SnakeArcadeTestNode -Port 3107 `
  -PublicUrl https://test.snakearcade.socha3.com/
```

Anything listed as `*EXTRA File` / `*EXTRA Dir` would be deleted from the
content root. `data\`, `logs\`, `web.config`, `.well-known\`, `*.log`,
`.env` / `*.env` and the WinSW files are excluded and must not show up. If
something else must stay, add it with `-ExtraExcludeDirs` /
`-ExtraExcludeFiles` in the deploy step of `.github/workflows/deploy-build.yml`.

Then merge (or run **Actions > Build and deploy to test > Run workflow** on
`main`) and watch the `deploy-test` job: it ends with `DEPLOY OK` after
`/api/health` answers `ok: true` with the new build's tag.

---

## Security: public repo + self-hosted runner

The runner executes code on the production server, and this repository is
public. Rules:

1. **The deploy workflows must never run on `pull_request` or
   `pull_request_target`, especially from forks.** They trigger only on
   `push` to `main` and `workflow_dispatch` (which only users with write
   access can start), and the jobs also check
   `github.ref == 'refs/heads/main'`. Do not add PR triggers to them.
2. **A fork PR can add its own workflow file** that targets
   `runs-on: [self-hosted, snakearcade]`. Pull-request workflows run the
   PR's version of `.github/workflows`, so the triggers in our workflows alone
   do not protect the runner. Therefore turn on:
   **Settings > Actions > General > "Approval for running fork pull request
   workflows from contributors" > "Require approval for all external
   contributors"** (older UI: "Require approval for all outside
   collaborators"), and never approve a fork run you have not read,
   especially one that changes anything under `.github/`.
3. Hardening (see `docs/release-pipeline.md`): **Settings > Environments >
   production** and **test** > "Deployment branches and tags" > *Selected
   branches* > `main`; add yourself as a required reviewer on `production`
   for a manual gate.
4. The deploy jobs on this runner get a read-only token
   (`permissions: contents: read`), checkout does not persist credentials on
   disk, and the runner only deploys a zip whose SHA-256 was checked (for
   production also its signed build provenance). Releases are published by
   GitHub-hosted jobs, never by this runner.
5. The runner account is not an administrator: it can only write the content
   roots / backup folders and start/stop `SnakeArcadeNode` and
   `SnakeArcadeTestNode`.

## Removing the runner

```powershell
cd C:\actions-runner
.\config.cmd remove --token <removal token from Settings > Actions > Runners>
```
