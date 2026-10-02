# Release pipeline: test on merge, production on demand

Every merge to `main` builds a versioned release and deploys it to the **test**
site. **Production** changes only when someone publishes a chosen build with a
manual workflow, and it gets exactly the bytes that ran on test.

```
merge to main
  └─ Build and deploy to test (automatic)
       build (GitHub-hosted)  ->  release build-<n>-<sha7>  ->  deploy to TEST  ->  notes: "deployed to test"
                                  zip + .sha256 + signed provenance

Actions > Deploy to production > Run workflow (manual)
  resolve + verify (SHA-256, provenance, commit on main, tested)  ->  [approval]  ->  deploy to PRODUCTION
```

| | Test | Production |
| --- | --- | --- |
| URL | `https://test.snakearcade.socha3.com/` | `https://snakearcade.socha3.com/` |
| Content root | `C:\WebApps\SnakeArcadeTest` | `C:\WebApps\SnakeArcade` |
| Backups | `C:\WebApps\SnakeArcadeTest-backups` | `C:\WebApps\SnakeArcade-backups` |
| Settings/secrets (after the accounts PR) | `C:\WebApps\SnakeArcadeTest-config\snakearcade.env` | `C:\WebApps\SnakeArcade-config\snakearcade.env` |
| Node service / port | `SnakeArcadeTestNode` / `3107` | `SnakeArcadeNode` / `3105` |
| IIS site + app pool | `SnakeArcadeTest` | `SnakeArcade` |
| GitHub Environment | `test` | `production` |
| Deployed by | every push to `main` | **Deploy to production**, manual |

## Builds

- **Name:** `build-<run number>-<first 7 chars of the commit>`, e.g. `build-42-1a2b3c4`. The number always goes up.
- **Where:** the repo's **Releases** page. Each release has `snakearcade-<tag>.zip` (the app with `node_modules` installed by `npm ci --omit=dev` on Node 24, plus `build-info.json`) and `snakearcade-<tag>.zip.sha256`.
- **Immutable:**
  - A build is made once and never rebuilt. Re-running a workflow reuses the existing release.
  - Every deploy checks the zip's SHA-256.
  - Production also verifies the signed build provenance attestation: built by `build-and-deploy-test.yml` from `refs/heads/main` for that exact commit, on a GitHub-hosted runner.
  - Turn on **immutable releases** (below) and GitHub also refuses any change to a published zip or tag. The pipeline only edits the title and notes after publishing, which immutable releases allow.
- **Status:** the release notes list every deploy ("deployed to **test**", "deployed to **production** by @user"). A title ending in "- tested" deployed to test successfully. `latest-test` is the build with the most recent successful test deploy.
- **What's running:** `GET /api/health` on either site reports `build: { tag, sha, builtAt }`.

## Publish to production

1. **GitHub > bigmac529/SnakeArcade > Actions > Deploy to production > Run workflow.**
2. *Use workflow from*: **Branch: main** (other branches are refused).
3. *Build to publish*: leave `latest-test` (the build on test now), or enter a tag (`build-42-1a2b3c4`), a build number (`42`) or a commit SHA (the newest build of that commit).
4. Leave *Allow a build that never deployed successfully to test* unticked.
5. **Run workflow.**
6. If `production` has a required reviewer, the run pauses at **deploy**. Open the run > **Review deployments** > tick **production** > **Approve and deploy**.
7. The run summary shows the tag, commit and SHA-256. The deploy job ends with `DEPLOY OK` after `https://snakearcade.socha3.com/api/health` answers `ok: true` with that build's tag.

Why a text box and not a dropdown: `workflow_dispatch` choice options are fixed in the workflow file, so they cannot list releases. The Releases page is the list; copy a tag from there.

### Roll back

Same clicks, with an older tag from the Releases page as *Build to publish* (for example the build before the current one; its notes show when it was on production).

- Rolling back is just another deploy of an existing, verified zip. Nothing is rebuilt.
- `data\` (player data), `web.config`, `logs\` and the env file are never touched by any deploy.
- **Database migrations (after the accounts PR) are forward-only.** An older build runs against the newer schema. That is fine as long as migrations only add things. If a release ever changes or removes a column, note it in the PR, because rolling back past it needs a manual database step.

## What happened when the pipeline PR (#12) merged

- The merge is a push to `main`, so **Build and deploy to test** runs: it builds `build-<n>-<sha7>` and deploys it to the test site (the first deploy starts the stopped `SnakeArcadeTestNode` with an empty content root).
- **Production is not touched.** It keeps its current version until the first **Deploy to production** run. The old `deploy.yml` (which deployed every push straight to production) is removed.

## GitHub settings (one-time)

These need an admin of the repo; the `gh` commands work in any terminal logged in as `bigmac529`.

### 1. `test` environment, `main` only

**Settings > Environments > New environment** > `test` > *Deployment branches and tags*: **Selected branches and tags** > add `main`.

```bash
gh api -X PUT repos/bigmac529/SnakeArcade/environments/test --input - <<'JSON'
{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
JSON
gh api -X POST repos/bigmac529/SnakeArcade/environments/test/deployment-branch-policies -f name=main -f type=branch
```

(If skipped, the first test deploy creates the environment without restrictions.)

### 2. `production` environment: approval + `main` only

**Settings > Environments > production** > *Required reviewers*: `bigmac529` (leave *Prevent self-review* off so you can approve your own runs) > *Deployment branches and tags*: **Selected branches and tags** > `main` > **Save protection rules**.

```bash
uid=$(gh api users/bigmac529 --jq .id)
gh api -X PUT repos/bigmac529/SnakeArcade/environments/production --input - <<JSON
{"reviewers": [{"type": "User", "id": $uid}], "prevent_self_review": false,
 "deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
JSON
gh api -X POST repos/bigmac529/SnakeArcade/environments/production/deployment-branch-policies -f name=main -f type=branch
```

The reviewer is optional: without it, **Run workflow** deploys right away.

### 3. Environment variables (optional)

The defaults in `.github/workflows/deploy-build.yml` already match the table above. Set a variable on an environment only to change one value (each value lives in exactly one place):

| Variable | Production default | Test default |
| --- | --- | --- |
| `APP_ROOT` | `C:\WebApps\SnakeArcade` | `C:\WebApps\SnakeArcadeTest` |
| `SERVICE_NAME` | `SnakeArcadeNode` | `SnakeArcadeTestNode` |
| `APP_PORT` (must equal `PORT` in the service XML; `0` = read `PORT=` from the env file) | `3105` | `3107` |
| `PUBLIC_URL` (site root; the public health check is `<PUBLIC_URL>api/health`) | `https://snakearcade.socha3.com/` | `https://test.snakearcade.socha3.com/` |
| `ENV_FILE` (read by the runner for migrations; `<APP_ROOT>-config\snakearcade.env` if only `APP_ROOT` is overridden) | `C:\WebApps\SnakeArcade-config\snakearcade.env` | `C:\WebApps\SnakeArcadeTest-config\snakearcade.env` |
| `EXPECTED_DATABASE` (migrations refuse unless the env file's connections use it) | `SnakeArcade` | `SnakeArcadeTest` |
| `BACKUP_ROOT` | `<APP_ROOT>-backups` | same rule |
| `REQUIRE_PUBLIC_HEALTH` | `true` | `false` (only a warning) |

Once HTTPS is live on the test site, make its public health check required:

```bash
gh variable set REQUIRE_PUBLIC_HEALTH --env test --body true
```

The local check (`http://localhost:<port>/api/health` from the runner, which must report the new build's tag) is always required.

### 4. Immutable releases (recommended)

**Settings > General > Releases > Enable release immutability.** GitHub then blocks changing or deleting a published build's zip or tag. Only affects releases published after it is turned on.

### Already in place

Fork PR workflows need approval (**Settings > Actions > General**, keep "Require approval for all external contributors"). No workflow here runs on `pull_request`.

## Test site checklist (server admin)

Done on socha3 (confirmed by the server admin):

- [x] DNS `test.snakearcade.socha3.com` (DNS-only, no Cloudflare proxy), so IIS/ARR is the front door.
- [x] Let's Encrypt certificate for the host on the server.
- [x] IIS site and app pool `SnakeArcadeTest`, content root `C:\WebApps\SnakeArcadeTest` with empty `data\` and `logs\`.
- [x] `web.config` in the content root, proxying to `http://localhost:3107` (it will also carry the Let's Encrypt renewal rule). Deploys never copy over or delete `web.config` or `.well-known\`.
- [x] WinSW service `SnakeArcadeTestNode` (LocalSystem, automatic start) with `PORT=3107` and `NODE_ENV` like production. It is currently stopped; the first deploy starts it.
- [x] `C:\WebApps\SnakeArcadeTest-backups`.
- [x] Runner account `.\svc-snakearcade`: Modify on the test content root and backup folder, start/stop on `SnakeArcadeTestNode`.
- [x] `C:\WebApps\SnakeArcadeTest-config` created (admin-only for now).

Still to do:

- [x] **Make HTTPS live** (done, 2026-10: `https://test.snakearcade.socha3.com/api/health` answers `ok: true`; Michael can now set `REQUIRE_PUBLIC_HEALTH=true` on the `test` environment). Was: add an `https` binding on `SnakeArcadeTest` for `test.snakearcade.socha3.com` with the Let's Encrypt certificate (SNI on). If you add an http to https redirect, keep `/.well-known/acme-challenge/` out of it, and keep the ACME rule above the proxy rule in `web.config`. Then check `https://test.snakearcade.socha3.com/api/health` answers `ok: true` and tell Michael, so he can set `REQUIRE_PUBLIC_HEALTH=true` on the `test` environment.
- [x] After the first test deploy (the first merge to `main` after this PR), check `SnakeArcadeTestNode` is Running and `http://localhost:3107/api/health` shows a `build` tag.
- [ ] Optional: keep the test site out of search engines with a response header in the test `web.config`:

  ```xml
  <system.webServer>
    <httpProtocol>
      <customHeaders>
        <add name="X-Robots-Tag" value="noindex, nofollow" />
      </customHeaders>
    </httpProtocol>
  </system.webServer>
  ```

- [ ] Optional: limit who can reach the test site (IIS IP restrictions), if it should not be public.

## Test site: database and accounts (before merging #11)

Merging #11 deploys the accounts version to **test only** (production keeps running its current build until someone publishes to it). The accounts version needs the setup below. **Do it all before #11 is merged**: without a readable env file the test deploy fails in pre-flight and test keeps running its current build; with a wrong database name it fails before migrating. Production is not affected either way.

1. **Database and logins** (SQL Server, as an admin; long random passwords):

   ```sql
   CREATE DATABASE SnakeArcadeTest;
   GO
   CREATE LOGIN snakearcadetest_app      WITH PASSWORD = N'<test app password>',      CHECK_POLICY = ON;
   CREATE LOGIN snakearcadetest_migrator WITH PASSWORD = N'<test migrator password>', CHECK_POLICY = ON;
   GO
   USE SnakeArcadeTest;
   CREATE USER snakearcadetest_app      FOR LOGIN snakearcadetest_app;
   CREATE USER snakearcadetest_migrator FOR LOGIN snakearcadetest_migrator;
   ALTER ROLE db_datareader ADD MEMBER snakearcadetest_app;
   ALTER ROLE db_datawriter ADD MEMBER snakearcadetest_app;
   ALTER ROLE db_ddladmin   ADD MEMBER snakearcadetest_migrator;
   ALTER ROLE db_datareader ADD MEMBER snakearcadetest_migrator;
   ALTER ROLE db_datawriter ADD MEMBER snakearcadetest_migrator;
   GO
   ```

   Never give the test logins access to `SnakeArcade` (production). SQL authentication and TCP/IP must be enabled (see `docs/database-setup.md` section 1).

2. **Env file** `C:\WebApps\SnakeArcadeTest-config\snakearcade.env` (UTF-8, one `KEY=value` per line; quote a value that contains ` #`):

   ```ini
   NODE_ENV=production
   PORT=3107
   HOST=localhost
   PUBLIC_BASE_URL=https://test.snakearcade.socha3.com

   # 48 random bytes; NOT the production secret.
   # node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   SESSION_SECRET=<generate>

   DB_CLIENT=mssql
   DB_CONNECTION_STRING=Server=<SQLHOST>,1433;Database=SnakeArcadeTest;User Id=snakearcadetest_app;Password=<test app password>;Encrypt=true;TrustServerCertificate=true
   DB_MIGRATION_CONNECTION_STRING=Server=<SQLHOST>,1433;Database=SnakeArcadeTest;User Id=snakearcadetest_migrator;Password=<test migrator password>;Encrypt=true;TrustServerCertificate=true
   # The site never runs DDL; the deploy migrates with the migrator login.
   DB_MIGRATE_ON_START=false

   SMTP_HOST=<SMTP host>
   SMTP_PORT=587
   SMTP_SECURE=false
   SMTP_USER=<mailbox, e.g. no-reply@socha3.com>
   SMTP_PASSWORD=<mailbox or app password>
   MAIL_FROM=SnakeArcade Test <no-reply@socha3.com>
   ```

   - `<SQLHOST>`: `localhost` if SQL Server is on this machine; named instance: `Server=localhost\INSTANCE` (no `,1433`). Use `TrustServerCertificate=true` only for SQL Server's self-signed certificate on the same machine / trusted network.
   - A password containing `;` goes in braces: `Password={pa;ss}`.
   - No real mail on test? Leave `SMTP_HOST=` empty: emails are then written to `C:\WebApps\SnakeArcadeTest\data\outbox\` instead of being sent (sign-up confirmation links can be copied from there).

3. **Folder access.** The runner reads the file during each deploy (migrations, port check); LocalSystem (the service) can already read it:

   ```powershell
   icacls C:\WebApps\SnakeArcadeTest-config /grant "svc-snakearcade:(OI)(CI)R"
   ```

   Nobody else besides Administrators and SYSTEM should have access.

4. **Service setting, only after step 2's file exists** (the app refuses to start if this names a missing file). In `C:\Tools\WinSW\SnakeArcadeTestNode.xml`, inside `<service>`:

   ```xml
   <env name="SNAKEARCADE_ENV_FILE" value="C:\WebApps\SnakeArcadeTest-config\snakearcade.env" />
   ```

   Then reload the definition: `C:\Tools\WinSW\SnakeArcadeTestNode.exe refresh`. Do not restart the service afterwards by hand: the running build (no accounts) ignores the file, and the next deploy restarts it.

5. **Migrations: nothing to run by hand.** The test deploy runs them before stopping the service, with `DB_MIGRATION_CONNECTION_STRING`, after checking that both connections really point at `SnakeArcadeTest`. Optional check before merging, from any extracted accounts build (or a clone of the PR branch with `npm ci --omit=dev`):

   ```powershell
   $env:SNAKEARCADE_ENV_FILE = "C:\WebApps\SnakeArcadeTest-config\snakearcade.env"
   node scripts\migrate.js --expect-database=SnakeArcadeTest --check
   ```

   It should print both connections as `database SnakeArcadeTest` and list the pending migrations (exit code 1 = migrations pending, which is expected).

6. **Tell Michael it's done**, then he merges #11. Afterwards: the **Build and deploy to test** run is green, `https://test.snakearcade.socha3.com/api/health` shows `"db":"mssql"`, the new `build` tag and `"mail":"smtp"` (or `"outbox"`), and sign-up, email confirmation, a game and the board work. Problems show in `SnakeArcadeTestNode.out.log` / `.err.log` (`[config]`, `[db]`, `[mail]`).

Optional: SPF/DKIM for the sender domain (production needs it anyway, `docs/database-setup.md` section 3) and importing the old test board (`npm run import-legacy`, section 6; usually not needed for test).

## Files

- `.github/workflows/build-and-deploy-test.yml`: build, publish, deploy to test, mark tested.
- `.github/workflows/deploy-production.yml`: pick, verify and publish a build to production.
- `.github/workflows/deploy-build.yml`: the shared deploy job (self-hosted runner) and the per-site defaults.
- `.github/scripts/build-bundle.ps1`: packages the zip, `.sha256` and `build-info.json`.
- `.github/scripts/resolve-build.mjs` (+ tests): turns the *Build to publish* input into one release.
- `.github/scripts/fetch-build.ps1`: downloads a build on the runner, checks the SHA-256, extracts it.
- `scripts/deploy.ps1`: deploys an extracted build to one site (both sites use it).
