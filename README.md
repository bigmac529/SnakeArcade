# SnakeArcade

HTML5 Canvas snake game with a small Node.js Express backend for per-player settings and an arcade leaderboard. Production Node host: [snakearcade.socha3.com](https://snakearcade.socha3.com) (older static copy may still live at [snakegame.socha3.com](https://snakegame.socha3.com)).

## Run locally

```bash
npm install
npm start
```

`npm start` frees port 3023 if something is already listening, starts the server, and opens http://localhost:3023/ in your default browser.

Visit [http://localhost:3023](http://localhost:3023).

Optional: `PORT=8080 npm start`

Dev script is the same entrypoint: `npm run dev`.

## Controls

**Start** (or the **Start game** button on the board) is the only way to begin a run, and it needs a saved PG name this session. Every Start begins a fresh game. Taps, key presses, and the turn buttons never start a game.

**End game** (formerly Restart) stops the current run right away, whether it is playing or paused, exactly like a game over. It does not restart: the Difficulty dropdown unlocks, and you press **Start** to play again. Scores count the same as a crash game over (a new best is saved the moment you reach it during the run). **End game** is disabled when no run is active. On phones the toolbar is hidden during play, so press **Pause** first, then **End game**.

### Turn highlight

During a run, the cell where a turn pressed now would happen is outlined in blue, with faint row and column bands through it. That cell is the one the head is gliding into, because the next tick applies the turn and moves the head out of that cell in the new direction. Each queued turn (up to two) is marked in its cell with a small blue arrow for the new direction, and a new press would then apply one cell further along. The highlight dims while paused and is hidden before Start and after the game ends. It sits under the food and uses blue, not the food's yellow. It follows the game logic exactly, including with reduced motion, and it follows the Turn eagerness setting (below).

Right after a turn, the marker stays on the first cell of the new direction until the drawn head leaves it. A second press during that time still turns in that cell (see **Tight U-turns** below).

### Settings

The **Settings** button (gear icon) in the toolbar opens a dialog with:

- **Row/column guide** (switch, on by default): shows or hides the faint row and column bands through the turn cell.
- **Turn cell marker** (switch, on by default): shows or hides the outlined cell where a turn pressed now takes effect, plus the arrows on queued turns.
- **Turn eagerness** (choice, default **Early (current)**):
  - **Early:** a press turns in the cell the head is moving into, which is the logical head. Because drawing lags the logic by up to one tick, this is one cell ahead of the drawn head for the first half of each tick.
  - **Relaxed:** a press turns in the cell the head is *drawn* in, right up until the drawn head's centre crosses into the next cell. For the first half of each tick, the tick is provisional. A press then re-runs that tick from the state before it, with the turn applied in the cell the head was leaving. Collision and food are checked again for the corrected cell, and the tick count and timing do not change. A dot eaten or a crash in a provisional tick only counts when the window closes (half a tick later), so there is no score flicker and no missed or unfair crash. The head eases onto the corrected path over about 100 ms instead of jumping. With reduced motion there is no drawing lag, so Relaxed acts like Early.

Changes apply right away, including while paused. They are saved per browser in `localStorage` (key `snakearcade.prefs.v1`), not on the server, so they are not tied to the player name and the settings API is unchanged. The guide and marker switches only change the drawing.

- **Reset best score** (button): sets the saved player's best to 0 for **that name only**. The button's hint names the player. It first asks inline, inside the dialog: "Reset your best of N to 0 for NAME? This removes NAME from the arcade board. Other names aren't affected." with **Cancel** (focused) and **Reset**; Escape backs out of the question first. On Reset, the best becomes 0 on the server (`POST /api/reset-best`), which takes the name off the board, and in every local key (`snake-arcade-settings-v1`, `classic-snake-settings-v1`, `classic-snake-best`). The board redraws and a result line appears. Scores from before the reset, still being saved or retried, are ignored, so the old best can't come back. It is disabled while a run is in progress (Settings pauses it); end the game first. With no name saved this session it only resets this browser's Best. If the server can't reset, nothing is changed and the dialog says so.

The dialog is modal: focus stays inside it, and **Escape**, a click on the backdrop, or **Close** closes it. Opening Settings during play pauses the game, and closing it leaves the game paused (press Resume or P to continue). On phones the toolbar is hidden during play, so Settings is available before Start, when paused and after a game.

### Difficulty

Pick **Difficulty** before you press **Start**. The snake moves at one fixed speed for the whole run. It never speeds up over time or as your score grows.

| Difficulty | Tick (ms per block) | Speed | Points per dot |
| --- | --- | --- | --- |
| Easy | 256 | 3.9 blocks per second | 5 |
| Normal (default) | 128 | 7.8 blocks per second | 10 |
| Hard | 64 | 15.6 blocks per second | 20 |

The values live in `DIFFICULTIES` at the top of `game.js`. Hover or focus the dropdown, or tap the small **i** button next to it (phones), to see a tooltip with the points per dot and speed of each level, with the current choice highlighted. The tooltip text is built from `DIFFICULTIES`, so it always matches the real numbers. It never opens during a live run.

The dropdown is disabled while a run is live or paused. A change applies from the next **Start**, so it can never change the speed of a game in progress. Saved settings from the old **Pace** control carry over: `easy` and `normal` stay the same, and `fast` becomes **Hard**.

### Board size

The board always has 24 rows and square cells. The cell size comes from the height left on screen (capped so a board narrower than it is tall stays a 24x24 square). Columns are then added until the board fills the full width of its column: beside the Arcade board on desktop, the full screen width on phones. For example, 1280x800 gives 42x24 with 16 px cells, and a 390x844 phone gives 24x24. The canvas spans the exact container width. Any leftover of less than one cell is split into a thin, darker margin with an edge line, so the walls stay clear.

The column count is chosen only between games: when a run starts (sized for the in-play layout, which on phones hides the setup panels) and when a new game is reset. Resizing or rotating during a run only rescales the drawing, and the game-over screen keeps the run's grid. Food spawning and wall collisions use the current column and row counts. Scores from different grid sizes share one leaderboard.

### Smooth movement

Game logic runs on the fixed grid tick above: turns, eating, growth, collisions and scoring all happen once per tick, cell by cell. Only the drawing is smooth. Each animation frame (`requestAnimationFrame`) draws the snake part-way between its previous and current cells, based on how much of the tick has passed, so it glides instead of jumping. The body is drawn as one path through the centre of each occupied cell, so turns go around the corner cell rather than cutting diagonally. The picture trails the game state by less than one tick. Pause freezes the snake mid-glide, game over shows the exact final cells, and with the OS "reduce motion" setting the snake snaps from cell to cell as before.

### Phone / touch: two buttons

- **Left** turns the snake 90° counter-clockwise from the way it is heading now.
- **Right** turns it 90° clockwise.
- Turns are relative to the snake, not the screen: a snake moving down that gets **Left** turns to screen-right.
- The buttons react on touch-down (no 300 ms tap delay, no double-tap zoom, no text selection or long-press menu).
- Each tick applies one turn, and up to two quick taps are queued. Two fast **Right** taps make a clean U-turn over two ticks, never an instant reversal into your own body.
- **Tight U-turns:** a double tap always makes the tightest U-turn. The snake moves exactly one cell sideways and comes back in the lane right beside its trail. After a turn, the next tick stays correctable while the head is still drawn in that first sideways cell, in both eagerness modes. A second press that arrives just after that tick has already moved the head on still turns in the first sideways cell, not one cell later. Before this, a second press landing just after the next tick made a U-turn one lane too wide, which happened most on Hard (64 ms per cell).
- Swiping and the old D-pad are gone.

While a run is live on a phone, the name panel, extra buttons, and Arcade board are hidden. That leaves the score, **Pause**, the board, and the two turn buttons (at the bottom, in thumb reach) on one screen with no scrolling. **Pause** (or a game over) brings everything back. Held sideways, the buttons sit on either side of the board.

### Desktop keyboard: relative turns (same as the buttons)

- `←` (ArrowLeft) or `A` turns the snake 90° counter-clockwise from its current heading, just like **Left**.
- `→` (ArrowRight) or `D` turns it 90° clockwise, just like **Right**.
- `A` / `D` work with or without Shift or Caps Lock. Keys pressed together with Ctrl, Alt, or Cmd are left to the browser.
- Keys use the same turn queue as the buttons: one turn per tick, at most two queued. Two fast `→` presses make a clean U-turn. Holding a key down turns once; it does not auto-repeat.
- `↑` / `↓` and `W` / `S` do not steer. During a run the steering keys (and `↑` / `↓`) don't scroll the page.
- Steering keys only work during a live run. They do nothing before **Start**, while paused, or after game over, and they never start a game.
- The on-screen Left / Right buttons also work with a mouse.
- `P` / Space: pause or resume (only during a run)
- `M`: sound on/off
- `F`: full screen on/off (`Esc` also exits)
- Keys typed into the name field (or any other input) never steer, pause, or start the game.

### Full screen

The **Full screen** button (corner-arrows icon) in the toolbar, or `F` on a keyboard, switches to a view with only the current score, the board and the **Left** / **Right** buttons. The buttons show on desktop too; the keyboard still steers. `F` does nothing while you're typing in the name box. On phones the button sits next to **Settings** and, like Settings, is hidden while a run is live: use it before **Start**, while paused, or after a game.

- **Layout:** held upright, the score is at the top left, the board is full width and sits right above the two turn buttons, and any spare height goes above the board. Held sideways (and on desktop), the board takes the middle and the buttons fill each side, with the score above **Left**.
- **Controls inside full screen:** the board's overlay button reads **Start game**, **Resume** or **Play again** (after a game over, the overlay shows the score). A small **Pause** / **Resume** icon button and an **Exit full screen** icon button sit in the top right corner. `P` / Space still pause. Without a saved name, the overlay button reads **Exit full screen**, because the name box is outside the full screen view.
- **Ways out:** the exit button, `Esc`, `F`, or leaving the browser's full screen any other way (for example a swipe or the browser's own control). All of them restore the normal page. Leaving mid-run pauses the game.
- **How:** the real Fullscreen API (`requestFullscreen`, or `webkitRequestFullscreen` on Safari) on the game area. Where that API is missing or refused (iPhone Safari has no element full screen), an "immersive" mode pins the game area over the whole viewport instead and hides the rest of the page. Everything else works the same in that mode.
- **Board size:** in full screen the board uses all the space it has, with no 640 px cap. With no run in progress, the grid is recomputed for the full screen shape. Entering or rotating mid-run keeps the run's columns and only rescales the cells to fit, and the next game uses the full screen size. Cells stay square and whole device pixels, so the board stays sharp.
- Scores from full screen are saved exactly like any other game.

Hiding the tab (switching apps, locking the phone) pauses a live run, in or out of full screen.

### Layout notes

- The board is always square. Its size comes from the visible viewport (`visualViewport` / `100dvh`, minus safe-area insets), and it is recomputed on resize, rotation, and when the on-screen keyboard opens or closes.
- The canvas backing store is scaled by `devicePixelRatio` and snapped to whole device pixels per cell, so it stays sharp on high-DPI phones.
- Pull-to-refresh and overscroll bounce are turned off.

## Files

- `index.html` - page shell + Arcade board panel
- `styles.css` - layout and theme
- `favicon.svg` - cute snake favicon
- `game.js` - game loop, input (Left/Right turn buttons + keyboard), responsive canvas sizing, start-gate, leaderboard UI
- `settings.js` - localStorage + server settings helpers
- `server.js` - Express static host + settings/players API + `/api/health`
- `data/settings.json` - revisioned per-player settings map (created at runtime; gitignored)
- `scripts/post-deploy.ps1` - manual post-copy setup on the server (npm, data/, web.config, restart, smoke test)
- `scripts/deploy.ps1` - deploy one build to one site (test or production): stop service, robocopy mirror, start, health check
- `scripts/install-runner.md` - one-time self-hosted runner setup + security notes
- `.github/workflows/build-and-deploy-test.yml` - on every push to `main`: build a versioned release zip and deploy it to the test site
- `.github/workflows/deploy-production.yml` - manual: publish a chosen build to production (or roll back)
- `.github/workflows/deploy-build.yml` - shared deploy job used by both
- `.github/scripts/` - build packaging, build selection and download helpers
- `docs/release-pipeline.md` - release pipeline, GitHub settings, test-site checklist
- `build-info.json` - written into each build zip (tag, commit); not in git

## Player settings & Arcade board

(The turn-highlight display options in the **Settings** dialog are separate: they are saved in this browser only, see [Settings](#settings).)

Enter a PG player name (2+ characters) and tap **Save name**. That writes name + mute/difficulty to `data/settings.json` via `PUT /api/settings`, never a best score. Guest / empty names cannot start.

If the name already exists on the server, the UI asks for confirmation and only claims it after you confirm (`force: true`). Claiming keeps that name's own best, and the question says so: *"NAME" is already on the arcade board with a best of N. Play as "NAME"? Its best of N stays with the name. To start it from 0, use Settings > Reset best score after saving.* After claiming, the name hint repeats the kept best. A brand-new name always starts at 0: Save name never sends a best score (only `POST /api/score` changes a best), and the server ignores one in a settings save.

**A new name is a new player.** The Best box shows the saved name's best from the server: 0 for a new name, and the name's own best for an existing one. It is never this browser's best from a previous name, and the old name's board entry stays as it was. A name only appears on the board once a run played under it scores more than 0. Scores always go to the name the run started with. The name box and Save name are locked while a run is live or paused, and a score that failed to save stays with the name that scored it, even after a rename. On reload, the Best box takes the cached name's best from the server (0 if the name has no record).

Changing the name input clears the session “saved” flag until you save again. Start / overlay Start stay disabled until a successful save this session.

The **Arcade board** panel lists all players with a best above 0, sorted by best score (desc), with a small tag showing the difficulty the best was set on (older entries saved before this feature have no tag). It shows each player's **best** score only, so a game that doesn't beat your best leaves your row unchanged.

Scores are saved with `POST /api/score`: each new best during a run, and the final score at every game over / End game. The client sends one request at a time (only the highest waiting score), retries transient failures (0.4 s, 1.2 s, 3 s), and redraws the board from the save's own response, with a status line under the board header ("Saved: 120 is your best on the arcade board." / "Score 40. The board keeps your best: 120."). If a save still fails, the status line says so, with a **Retry** button; the failed score is also re-sent at the next game over. The board also refreshes on load and after Save name. API GETs use a unique query string and the server sends `Cache-Control: no-store`, because the IIS ARR proxy otherwise caches identical GETs for about a minute.

### API

- `GET /api/health` → `{ ok, app, node, port, build?, time }` (`build` = `{ tag, sha, builtAt }` from `build-info.json`, present on deployed builds)
- `GET /api/players` → `{ revision, players: [{ playerName, best, bestDifficulty?, updatedAt, key }] }` sorted by best; players with best 0 aren't listed (their record and name claim remain)
- `GET /api/settings?player=` → one player record (+ `revision`)
- `POST /api/score` body: `{ playerName, score, difficulty, epoch? }` → `{ ok, improved, stale, score, player, revision, players }`
  - The server keeps the higher of `score` and the stored best (and tags it with `difficulty` when the score is higher), so score saves can overlap, repeat, or arrive out of order without lowering a best. No `baseRevision`: another player's save can't make a score save fail. Creates the player record if it's missing and `score` > 0. `players` is the full board, like `GET /api/players`.
  - `epoch`: the player's `scoreEpoch` when the run started. A score with an older epoch (from before a reset) is ignored (`stale: true`). Clients that don't send it are accepted.
  - `400` `{ error: "playerName_rejected" | "score_invalid" }`, `503` `{ error: "lock_busy" }`, `500` `{ error: "write_failed" }`
- `POST /api/reset-best` body: `{ playerName }` → `{ ok, found, previousBest, player, revision, players }`
  - Sets that player's best to 0, removes its difficulty tag and bumps its `scoreEpoch`. It's then off the board. Other players are untouched. For an unknown name it changes nothing (`found: false`). This is the only way a best goes down.
- `PUT /api/settings` body: `{ playerName, muted, difficulty, force?, baseRevision? }`
  - `difficulty`: `easy` | `normal` | `hard`. The legacy value `fast` is still accepted and stored as `hard`.
  - `400` `{ error: "playerName_rejected", message }` — PG / validation reject
  - `409` `{ error: "name_exists", existing, revision }` — name taken and `force` not set
  - `409` `{ error: "revision_conflict" | "lock_busy", revision }` — concurrency
  - `200` saved player + `revision`
  - Never changes the best score: a `best` / `bestDifficulty` in the body (older clients) is ignored. A new record starts at 0, and an existing or claimed one keeps its own best.
- All `/api` responses send `Cache-Control: no-store`.

Store shape:

```json
{
  "revision": 3,
  "players": {
    "ada": {
      "version": 1,
      "playerName": "Ada",
      "muted": false,
      "difficulty": "normal",
      "best": 120,
      "bestDifficulty": "hard",
      "scoreEpoch": 0,
      "updatedAt": "2026-09-13T12:00:00.000Z"
    }
  }
}
```

Writes use a `.lock` file (`wx` + retries/backoff/jitter), write to a temp file and rename it over `settings.json` (retrying briefly if Windows reports the file busy), and bump `revision` each successful write. A write never proceeds from an unreadable `settings.json` (that would wipe the board); the request fails instead. The HTTP server binds `localhost` only. On Windows with Node 17+ `localhost` may resolve to IPv6 `::1` only, so the IIS reverse proxy targets `http://localhost:3105` (not `127.0.0.1`); that works whether Node ends up on `::1` or `127.0.0.1`.

Names are filtered client- and server-side (base64 blocked list) for a professional portfolio.

## Deploy (socha3 Windows / IIS)

Production target:

- Public URL: `https://snakearcade.socha3.com`
- App folder: `C:\WebApps\SnakeArcade`
- Node service: Windows service `SnakeArcadeNode` (WinSW), auto-start
- Node listens on `localhost:3105` (`PORT=3105` set by the service; on Windows Server 2025 / Node 24 this is `[::1]:3105`)
- IIS site `SnakeArcade` reverse-proxies to `http://localhost:3105` via URL Rewrite + ARR (`web.config`). Do not point it at `127.0.0.1`: Node is not listening on IPv4 and ARR returns 502.

### Before first public deploy

Fix these in the app (not optional for a public site):

1. **Do not** serve the whole repo root with `express.static(__dirname)`. That can expose `server.js`, `package.json`, `node_modules`, and `data/settings.json`. Serve only public assets (for example a `public/` folder), or block those paths.
2. Bind the HTTP server to loopback only, since IIS owns the public ports:

```js
app.listen(PORT, "localhost", () => {
  console.log(`SnakeArcade listening on http://localhost:${PORT}`);
});
```

`process.env.PORT` is already respected (local default `3023`; production service uses `3105`).

### Release pipeline: test on merge, production on demand (GitHub Actions)

Two sites run on the same server, deployed by a self-hosted runner that lives there (labels `self-hosted, windows, snakearcade`), so the server needs no inbound access:

| | Test | Production |
| --- | --- | --- |
| URL | `https://test.snakearcade.socha3.com/` | `https://snakearcade.socha3.com/` |
| Content root | `C:\WebApps\SnakeArcadeTest` | `C:\WebApps\SnakeArcade` |
| Node service / port | `SnakeArcadeTestNode` / `3107` | `SnakeArcadeNode` / `3105` |
| IIS site + app pool | `SnakeArcadeTest` | `SnakeArcade` |
| Deployed | automatically, every push to `main` | only when someone runs **Deploy to production** |

1. **Merge to `main`**: **Build and deploy to test** builds once on a GitHub-hosted runner (`npm ci --omit=dev`, then a zip with `node_modules` and a `build-info.json`). It publishes the zip as a versioned GitHub Release `build-<run number>-<sha7>` with its SHA-256 and a signed build provenance attestation (a build is never rebuilt or replaced; with immutable releases turned on, GitHub enforces that), then deploys exactly that zip to test. When test is healthy, the release notes record "deployed to **test**" and its title gets "- tested"; the most recently tested build is `latest-test`.
2. **Publish to production**: **Actions > Deploy to production > Run workflow** (branch `main`) > *Build to publish* (default `latest-test`, or a tag like `build-42-1a2b3c4`, a build number, or a commit SHA) > **Run workflow**. The workflow checks the SHA-256, the attestation (built by this repo's workflow from `main` for that commit) and that the commit is on `main`, waits for approval if the `production` environment has a required reviewer, then deploys the same bytes. Builds that never passed on test are refused unless *Allow untested* is ticked.
3. **Roll back**: run **Deploy to production** again with an older tag from the Releases page. Each release's notes record where and when it was deployed.

Both targets use `scripts/deploy.ps1` (Windows PowerShell 5.1), which:

1. Checks the build (`build-info.json` tag, `node_modules\express`) and, for database builds, runs migrations before anything is stopped.
2. Stops the site's service (a stopped or empty service is fine: the first test deploy starts from nothing).
3. Backs up `data\settings.json` to `<content root>-backups`.
4. Mirrors the build into the content root with `robocopy /MIR`, never copying over or deleting `data\`, `logs\`, `web.config`, `.well-known\`, `*.log`, `.env` / `*.env` or the WinSW files (robocopy exit codes 0-7 = success, 8+ = failure), then verifies `settings.json` is unchanged.
5. Starts the service, polls `http://localhost:<port>/api/health` until `ok: true` **and** the reported `build.tag` is the build just deployed, then checks `<public URL>api/health` (required for production, a warning only for test until its HTTPS is live). Health URLs get a cache-busting query string because ARR caches `/api/health` briefly.

Site settings (paths, service, port, URL) have defaults in `.github/workflows/deploy-build.yml`, and a GitHub Environment variable (`APP_ROOT`, `SERVICE_NAME`, `APP_PORT`, `PUBLIC_URL`, `ENV_FILE`, `BACKUP_ROOT`, `REQUIRE_PUBLIC_HEALTH`) on the `test` or `production` environment overrides each one. Preview a deploy without changing anything: `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\deploy.ps1 -SourceDir <extracted build> -DryRun` (add `-AppRoot C:\WebApps\SnakeArcadeTest -ServiceName SnakeArcadeTestNode -Port 3107 -PublicUrl https://test.snakearcade.socha3.com/` for test).

Full details, the GitHub settings to make once, and the test-site checklist for the server admin: [`docs/release-pipeline.md`](docs/release-pipeline.md). One-time runner setup and the security rules for a self-hosted runner on a public repo: [`scripts/install-runner.md`](scripts/install-runner.md). These workflows must never run on `pull_request` from forks; keep "Require approval for all external contributors" enabled for fork PR workflows.

### Post-deploy script

After files are on the server, run:

```powershell
cd C:\WebApps\SnakeArcade
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\post-deploy.ps1
```

That script installs npm deps (`npm ci` / `npm install --omit=dev`), ensures `data\` and `web.config` (creates `web.config` only if missing), restarts `SnakeArcadeNode`, and smoke-tests `http://localhost:3105/`.

Optional: `-SkipNpm`, `-AppRoot C:\WebApps\SnakeArcade`, `-Port 3105`. For the test site: `-AppRoot C:\WebApps\SnakeArcadeTest -Port 3107 -ServiceName SnakeArcadeTestNode -SiteName SnakeArcadeTest -PublicUrl https://test.snakearcade.socha3.com/`. The pipeline does not use this script; it is for manual repair.

### Manual deploy steps (without the pipeline)

1. Copy app files into `C:\WebApps\SnakeArcade` (or sync from this repo).
2. **Keep** the server `web.config` that rewrites to `http://localhost:3105/{R:1}` (use `localhost`, not `127.0.0.1`). Do not overwrite it with an empty/missing file from git if the repo has no `web.config`.
3. On the server, in the app folder:

```powershell
cd C:\WebApps\SnakeArcade
npm ci
# or: npm install --omit=dev
```

4. Ensure `data\` exists and is writable by the account running `SnakeArcadeNode` (created automatically on first run if the service can write there).
5. Restart the Node service:

```powershell
Restart-Service SnakeArcadeNode
```

6. Smoke-test:

- Direct: `http://localhost:3105/` and `/api/settings?player=` / `/api/players`
- Via IIS/Cloudflare: `https://snakearcade.socha3.com/` and `/api/players`

### Do not delete

- `C:\Tools\WinSW\SnakeArcadeNode.exe` (+ `.xml`) — service wrapper
- IIS site/pool `SnakeArcade`
- Test site: `C:\Tools\WinSW\SnakeArcadeTestNode.exe` (+ `.xml`), IIS site/pool `SnakeArcadeTest`, `C:\WebApps\SnakeArcadeTest\web.config` (carries the Let's Encrypt renewal rule)
- Cloudflare DNS `snakearcade.socha3.com` (proxied A to the origin)

### Optional

- `app.set("trust proxy", 1)` if you rely on client IP behind Cloudflare/ARR
- `GET /api/health` is implemented for ops checks
