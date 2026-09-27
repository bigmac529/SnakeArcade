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

**Start** (or the **Start game** button on the board) is the only way to begin a run, and it needs a saved PG name this session. Taps, key presses, and the turn buttons never start a game.

### Phone / touch: two buttons

- **Left** turns the snake 90° counter-clockwise from the way it is heading now.
- **Right** turns it 90° clockwise.
- Turns are relative to the snake, not the screen: a snake moving down that gets **Left** turns to screen-right.
- The buttons react on touch-down (no 300 ms tap delay, no double-tap zoom, no text selection or long-press menu).
- Each tick applies one turn, and up to two quick taps are queued. Two fast **Right** taps make a clean U-turn over two ticks, never an instant reversal into your own body.
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
- Keys typed into the name field (or any other input) never steer, pause, or start the game.

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
- `scripts/deploy.ps1` - automated deploy used by GitHub Actions (stop service, robocopy mirror, start, health check)
- `scripts/install-runner.md` - one-time self-hosted runner setup + security notes
- `.github/workflows/deploy.yml` - deploy on push to `main` / manual run

## Player settings & Arcade board

Enter a PG player name (2+ characters) and tap **Save name**. That writes name + mute/pace/best to `data/settings.json` via `PUT /api/settings`. Guest / empty names cannot start.

If the name already exists on the server, the UI asks for confirmation (shows the existing best score) and only overwrites after you confirm (`force: true`).

Changing the name input clears the session “saved” flag until you save again. Start / overlay Start / Restart stay disabled until a successful save this session.

The **Arcade board** panel lists all players sorted by best score (desc). It refreshes on load, after save, and when a new best is synced.

### API

- `GET /api/health` → `{ ok, app, node, port, time }`
- `GET /api/players` → `{ revision, players: [{ playerName, best, updatedAt, key }] }` sorted by best
- `GET /api/settings?player=` → one player record (+ `revision`)
- `PUT /api/settings` body: `{ playerName, muted, difficulty, best, force?, baseRevision? }`
  - `400` `{ error: "playerName_rejected", message }` — PG / validation reject
  - `409` `{ error: "name_exists", existing, revision }` — name taken and `force` not set
  - `409` `{ error: "revision_conflict" | "lock_busy", revision }` — concurrency
  - `200` saved player + `revision`

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
      "updatedAt": "2026-09-13T12:00:00.000Z"
    }
  }
}
```

Writes use a `.lock` file (`wx` + retries/backoff/jitter) and bump `revision` each successful write. The HTTP server binds `localhost` only.

Names are filtered client- and server-side (base64 blocked list) for a professional portfolio.

## Deploy (socha3 Windows / IIS)

Production target:

- Public URL: `https://snakearcade.socha3.com`
- App folder: `C:\WebApps\SnakeArcade`
- Node service: Windows service `SnakeArcadeNode` (WinSW), auto-start
- Node listens on `localhost:3105` (`PORT=3105` set by the service)
- IIS site `SnakeArcade` reverse-proxies to that port via URL Rewrite + ARR (`web.config`)

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

### Automatic deploy on merge to `main` (GitHub Actions)

`.github/workflows/deploy.yml` deploys every push to `main` (plus manual **Actions > Deploy > Run workflow**) on a self-hosted runner that lives on the server (labels `self-hosted, windows, snakearcade`), so the server needs no inbound access. Deploys never overlap (`concurrency`).

Steps: checkout, use the Node.js already installed on the server, `npm ci --omit=dev` (or `npm install --omit=dev` without a lockfile), then `scripts/deploy.ps1` (Windows PowerShell 5.1):

1. Stops `SnakeArcadeNode`.
2. Backs up `data\settings.json` to `C:\WebApps\SnakeArcade-backups`.
3. Mirrors the checkout into `C:\WebApps\SnakeArcade` with `robocopy /MIR`, excluding `data\`, `.git\`, `.github\`, `logs\`, `web.config`, `*.log` and the WinSW files (robocopy exit codes 0-7 = success, 8+ = failure), then verifies `settings.json` is unchanged.
4. Starts the service and polls `http://localhost:3105/api/health` until `ok: true` (the job fails otherwise), then checks the public URL (warning only).

Paths, service name and port are parameters at the top of `scripts/deploy.ps1` and in the workflow `env:`. Preview a deploy without changing anything: `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\deploy.ps1 -DryRun`.

One-time runner setup and the security rules for a self-hosted runner on a public repo: [`scripts/install-runner.md`](scripts/install-runner.md). The workflow must never run on `pull_request` from forks; keep "Require approval for all external contributors" enabled for fork PR workflows.

### Post-deploy script

After files are on the server, run:

```powershell
cd C:\WebApps\SnakeArcade
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\post-deploy.ps1
```

That script installs npm deps (`npm ci` / `npm install --omit=dev`), ensures `data\` and `web.config` (creates `web.config` only if missing), restarts `SnakeArcadeNode`, and smoke-tests `http://localhost:3105/`.

Optional: `-SkipNpm`, `-AppRoot C:\WebApps\SnakeArcade`, `-Port 3105`.

### Deploy steps

1. Copy app files into `C:\WebApps\SnakeArcade` (or sync from this repo).
2. **Keep** the server `web.config` that rewrites to `http://localhost:3105/{R:1}`. Do not overwrite it with an empty/missing file from git if the repo has no `web.config`.
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
- Cloudflare DNS `snakearcade.socha3.com` (proxied A to the origin)

### Optional

- `app.set("trust proxy", 1)` if you rely on client IP behind Cloudflare/ARR
- `GET /api/health` is implemented for ops checks
