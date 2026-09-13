# Classic Snake

Static HTML5 Canvas Snake game recovered from [snakegame.socha3.com](https://snakegame.socha3.com).

## Run locally

```bash
python3 -m http.server 8080
```

Visit `http://localhost:8080`.

## Controls

- Arrow keys or WASD
- Swipe on the canvas
- On-screen D-pad (narrow screens)
- Start / Pause·Resume / Restart
- Sound toggle (`M`)
- `P` to pause

## Files

- `index.html` — page shell
- `styles.css` — layout and theme
- `game.js` — game loop and input

## Player settings

Enter a PG player name in the UI. Preferences (name, mute, pace, best score) persist in the browser and can be downloaded/loaded as `snake-settings.json`.

Names are filtered client-side for a professional portfolio. Shared public leaderboards will need a backend later — this release keeps settings local per visitor.
