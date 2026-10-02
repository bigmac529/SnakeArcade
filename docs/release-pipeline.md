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

## What happens when this PR merges

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
| `ENV_FILE` | `<APP_ROOT>-config\snakearcade.env` | same rule |
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

- [ ] **Make HTTPS live**: add an `https` binding on `SnakeArcadeTest` for `test.snakearcade.socha3.com` with the Let's Encrypt certificate (SNI on). If you add an http to https redirect, keep `/.well-known/acme-challenge/` out of it, and keep the ACME rule above the proxy rule in `web.config`. Then check `https://test.snakearcade.socha3.com/api/health` answers `ok: true` and tell Michael, so he can set `REQUIRE_PUBLIC_HEALTH=true` on the `test` environment.
- [ ] After the first test deploy (the first merge to `main` after this PR), check `SnakeArcadeTestNode` is Running and `http://localhost:3107/api/health` shows a `build` tag.
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

When the accounts + database PR (#11) lands (until then the test site uses a local `data\settings.json` like production today):

- [ ] A **separate** database `SnakeArcadeTest` with its own logins (same roles as production, see `docs/database-setup.md`). Never point test at the production database.
- [ ] `C:\WebApps\SnakeArcadeTest-config\snakearcade.env` with test values: its own `SESSION_SECRET` (never production's), `PUBLIC_BASE_URL=https://test.snakearcade.socha3.com`, `DB_*` for `SnakeArcadeTest`, `SMTP_*`/`MAIL_FROM` (a test sender, or leave `SMTP_HOST` empty to write emails to files), and `PORT=3107` (optional, must match the service).
- [ ] Grant the runner **Read** on that folder so each deploy can run migrations and read settings before switching versions. LocalSystem (the service) already has access:

  ```powershell
  icacls C:\WebApps\SnakeArcadeTest-config /grant "svc-snakearcade:(OI)(CI)R"
  ```

- [ ] Add `<env name="SNAKEARCADE_ENV_FILE" value="C:\WebApps\SnakeArcadeTest-config\snakearcade.env" />` to the `SnakeArcadeTestNode` XML and refresh the service. Do this only once the file exists: the app refuses to start if that variable names a missing file. With `NODE_ENV=production` and no settings (no `SESSION_SECRET`), the accounts version refuses to start, so test deploys fail until this is in place.

## Files

- `.github/workflows/build-and-deploy-test.yml`: build, publish, deploy to test, mark tested.
- `.github/workflows/deploy-production.yml`: pick, verify and publish a build to production.
- `.github/workflows/deploy-build.yml`: the shared deploy job (self-hosted runner) and the per-site defaults.
- `.github/scripts/build-bundle.ps1`: packages the zip, `.sha256` and `build-info.json`.
- `.github/scripts/resolve-build.mjs` (+ tests): turns the *Build to publish* input into one release.
- `.github/scripts/fetch-build.ps1`: downloads a build on the runner, checks the SHA-256, extracts it.
- `scripts/deploy.ps1`: deploys an extracted build to one site (both sites use it).
