# SnakeArcade

HTML5 Canvas snake game with a small Node.js Express backend for per-player settings. Production Node host: [snakearcade.socha3.com](https://snakearcade.socha3.com) (older static copy may still live at [snakegame.socha3.com](https://snakegame.socha3.com)).

## Run locally

```bash
npm install
npm start
```

Visit [http://localhost:3023](http://localhost:3023).

Optional: `PORT=8080 npm start`

Dev script is the same entrypoint: `npm run dev`.

## Controls

- Arrow keys or WASD
- Swipe on the canvas
- On-screen D-pad (narrow screens)
- Start / Pause–Resume / Restart
- Sound toggle (`M`)
- `P` to pause

## Files

- `index.html` - page shell
- `styles.css` - layout and theme
- `game.js` - game loop and input
- `settings.js` - localStorage + server settings helpers
- `server.js` - Express static host + `/api/settings` + `/api/health`
- `data/settings.json` - per-player settings map (created at runtime; gitignored)

## Player settings

Enter a PG player name in the UI. Preferences (name, mute, pace, best score) persist in the browser **and** on the server in `data/settings.json`.

That file looks like:

```json
{
  "players": {
    "ada": {
      "version": 1,
      "playerName": "Ada",
      "muted": false,
      "difficulty": "normal",
      "best": 120,
      "updatedAt": "2026-09-13T12:00:00.000Z"
    },
    "_guest": { "...": "..." }
  }
}
```

Keys are normalized player names (lowercase / trimmed), or `_guest` when empty. Saving in the UI writes localStorage and `PUT /api/settings`. On load, the client hydrates from `GET /api/settings?player=...` when the server copy is newer (or local is empty). Download/Load JSON remains available as a backup export/import.

Names are filtered client-side for a professional portfolio.

## Deploy (socha3 Windows / IIS)

Production target:

- Public URL: `https://snakearcade.socha3.com`
- App folder: `C:\WebApps\SnakeArcade`
- Node service: Windows service `SnakeArcadeNode` (WinSW), auto-start
- Node listens on `127.0.0.1:3105` (`PORT=3105` set by the service)
- IIS site `SnakeArcade` reverse-proxies to that port via URL Rewrite + ARR (`web.config`)

### Before first public deploy

Fix these in the app (not optional for a public site):

1. **Do not** serve the whole repo root with `express.static(__dirname)`. That can expose `server.js`, `package.json`, `node_modules`, and `data/settings.json`. Serve only public assets (for example a `public/` folder), or block those paths.
2. Bind the HTTP server to loopback only, since IIS owns the public ports:

```js
app.listen(PORT, "127.0.0.1", () => {
  console.log(`SnakeArcade listening on http://127.0.0.1:${PORT}`);
});
```

`process.env.PORT` is already respected (local default `3023`; production service uses `3105`).

### Post-deploy script

After files are on the server, run:

```powershell
cd C:\WebApps\SnakeArcade
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\post-deploy.ps1
```

That script installs npm deps (`npm ci` / `npm install --omit=dev`), ensures `data\` and `web.config` (creates `web.config` only if missing), restarts `SnakeArcadeNode`, and smoke-tests `http://127.0.0.1:3105/`.

Optional: `-SkipNpm`, `-AppRoot C:\WebApps\SnakeArcade`, `-Port 3105`.

### Deploy steps

1. Copy app files into `C:\WebApps\SnakeArcade` (or sync from this repo).
2. **Keep** the server `web.config` that rewrites to `http://127.0.0.1:3105/{R:1}`. Do not overwrite it with an empty/missing file from git if the repo has no `web.config`.
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

- Direct: `http://127.0.0.1:3105/` and `/api/settings?player=`
- Via IIS/Cloudflare: `https://snakearcade.socha3.com/` and `/api/settings?player=`

### Do not delete

- `C:\Tools\WinSW\SnakeArcadeNode.exe` (+ `.xml`) — service wrapper
- IIS site/pool `SnakeArcade`
- Cloudflare DNS `snakearcade.socha3.com` (proxied A to the origin)

### Optional

- `app.set("trust proxy", 1)` if you rely on client IP behind Cloudflare/ARR
- `GET /api/health` is implemented for ops checks
