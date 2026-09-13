# SnakeArcade

HTML5 Canvas snake game (live at [snakegame.socha3.com](https://snakegame.socha3.com)), with a small Node.js Express backend for per-player settings.

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
- `server.js` - Express static host + `/api/settings`
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
