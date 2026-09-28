# SnakeArcade

HTML5 Canvas snake game with a small Node.js Express backend: player accounts (email + password, email confirmation), per-account best scores, and a public arcade leaderboard. Production Node host: [snakearcade.socha3.com](https://snakearcade.socha3.com) (older static copy may still live at [snakegame.socha3.com](https://snakegame.socha3.com)).

## Run locally

Needs Node.js 22.13+ (production runs Node 24). Locally the database is a SQLite file (built into Node, nothing to install) and emails are written to a folder instead of being sent.

```bash
npm install
npm start
```

`npm start` frees port 3023 if something is already listening, starts the server, and opens http://localhost:3023/ in your default browser. On first start it creates `data/snakearcade.db` and applies the migrations.

Emails (confirmation and password-reset links) land as JSON files in `data/outbox/`. Open the newest one and paste its link into the browser to confirm a local account.

Optional: copy `.env.example` to `.env` to change settings (port, SMTP, database). `PORT=8080 npm start` works too. `npm run dev` is the same entrypoint; `npm run serve` runs `node server.js` without the port/browser helper.

## Controls

**Start** (or the **Start game** button on the board) is the only way to begin a run, and it needs a signed-in account with a confirmed email. Every Start begins a fresh game. Taps, key presses, and the turn buttons never start a game.

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

Changes apply right away, including while paused. They are saved per browser in `localStorage` (key `snakearcade.prefs.v1`), not on the server, so they are not part of your account. The guide and marker switches only change the drawing.

- **Reset best score** (button): sets **your account's** best to 0. The button's hint names your account. It first asks inline, inside the dialog: "Reset your best of N to 0 for NAME? This removes NAME from the arcade board. Other players aren't affected." with **Cancel** (focused) and **Reset**; Escape backs out of the question first. On Reset, the best becomes 0 on the server (`POST /api/reset-best`), which takes you off the board; the board redraws and a result line appears. Scores from before the reset, still being saved or retried, are ignored, so the old best can't come back. It is disabled while a run is in progress (Settings pauses it) and when signed out. If the server can't reset, nothing is changed and the dialog says so.

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

While a run is live on a phone, the account panel, extra buttons, and Arcade board are hidden. That leaves the score, **Pause**, the board, and the two turn buttons (at the bottom, in thumb reach) on one screen with no scrolling. **Pause** (or a game over) brings everything back. Held sideways, the buttons sit on either side of the board.

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
- Keys typed into a text field (including the account dialog) never steer, pause, or start the game.

### Full screen

The **Full screen** button (corner-arrows icon) in the toolbar, or `F` on a keyboard, switches to a view with only the current score, the board and the **Left** / **Right** buttons. The buttons show on desktop too; the keyboard still steers. `F` does nothing while you're typing in a field or the account dialog is open. On phones the button sits next to **Settings** and, like Settings, is hidden while a run is live: use it before **Start**, while paused, or after a game.

- **Layout:** held upright, the score is at the top left, the board is full width and sits right above the two turn buttons, and any spare height goes above the board. Held sideways (and on desktop), the board takes the middle and the buttons fill each side, with the score above **Left**.
- **Controls inside full screen:** the board's overlay button reads **Start game**, **Resume** or **Play again** (after a game over, the overlay shows the score). A small **Pause** / **Resume** icon button and an **Exit full screen** icon button sit in the top right corner. `P` / Space still pause. Signed out (or with an unconfirmed email), the overlay says so and its button reads **Exit full screen**: it leaves full screen and opens **Sign in** (or re-checks the email), because the account panel is outside the full screen view.
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

- `public/` - everything the browser gets (the server serves only this folder):
  - `index.html` - page shell, account panel + dialog, Arcade board panel
  - `styles.css` - layout and theme
  - `favicon.svg` - cute snake favicon
  - `game.js` - game loop, input (Left/Right turn buttons + keyboard), responsive canvas sizing, start gate, leaderboard UI
  - `account.js` - account panel and dialog (sign up, sign in, confirm email, forgot / reset password, edit name), session + CSRF handling
  - `settings.js` - local prefs (mute, difficulty) + score/board API helpers
- `server.js` - entry point: config check, migrations, HTTP server, graceful shutdown
- `src/app.js` - Express app: security headers, CSRF/origin checks, rate limits, auth + score API, static `public/`
- `src/config.js` - settings from environment variables / env file (see `.env.example`)
- `src/store.js` - all database queries (parameterized)
- `src/db/` - SQLite (`node:sqlite`) and SQL Server (`mssql`) adapters, migration runner
- `src/auth/` - password hashing (scrypt), tokens, sessions/cookies, rate limiter
- `src/mail.js` - SMTP (nodemailer) or local outbox, email texts
- `src/validation.js` - email / password / display name rules (PG filter)
- `migrations/sqlite/`, `migrations/mssql/` - schema migrations, one file per version per database
- `scripts/migrate.js` - `npm run migrate` (`-- --check` lists pending ones)
- `scripts/import-legacy.js` - optional one-time import of the old name-only board (`data/settings.json`)
- `test/api.test.js` - API tests (`npm test`; SQLite by default, SQL Server with `TEST_DB=mssql`)
- `docs/database-setup.md` - production database, secrets and SMTP setup, with a checklist
- `scripts/post-deploy.ps1` - manual post-copy setup on the server (npm, data/, web.config, restart, smoke test)
- `scripts/deploy.ps1` - automated deploy used by GitHub Actions (migrate, stop service, robocopy mirror, start, health check)
- `scripts/install-runner.md` - one-time self-hosted runner setup + security notes
- `.github/workflows/deploy.yml` - deploy on push to `main` / manual run

## Accounts & Arcade board

(Mute, difficulty and the turn-highlight options in **Settings** stay in this browser's `localStorage`; they are not part of the account.)

**Sign up** with an email address, a password (10+ characters) and a display name (2-24 characters, PG filter, unique ignoring case). The site emails a confirmation link; until it's opened the account panel shows **Email not confirmed** with a **Resend email** button, and the account can't play or post scores. The link works once and expires after 24 hours. Opening it (in this tab or another) confirms the email; the page POSTs the token, so a mail scanner that only follows the link can't use it up, and the token is removed from the address bar.

**Sign in** with email + password. A wrong password and an unknown email get the same message ("Email or password is incorrect."). **Forgot password?** always answers the same way whether or not the email has an account, and sends a reset link (single use, 60 minutes). Choosing a new password signs you in and signs out every other session.

**Edit name** renames the account; the best score stays with the account, so the board shows the same entry under the new name (no copy). **Edit name** and **Sign out** are disabled while a run is live or paused. **Sign out** ends the session on the server.

The **Best** box shows the signed-in account's best (0 when signed out). Scores go to the account that started the run; if you sign in as someone else before a failed save is retried, that score is dropped, never credited to the new account. **Settings > Reset best score** sets your own account's best to 0 and takes it off the board, after an inline confirmation; it's disabled while a run is in progress and when signed out.

The **Arcade board** lists display names (never emails) of confirmed accounts with a best above 0, sorted by best, with a small tag for the difficulty the best was set on. Your own row is highlighted. Rows imported from the old name-only board (optional, see below) carry a **legacy** tag.

Scores are saved with `POST /api/score`: each new best during a run, and the final score at every game over / End game. The client sends one request at a time (only the highest waiting score), retries transient failures (0.4 s, 1.2 s, 3 s), and redraws the board from the save's own response, with a status line under the board header ("Saved: 120 is your best on the arcade board." / "Score 40. The board keeps your best: 120."). If a save still fails, the status line says so, with a **Retry** button. API GETs use a unique query string and the server sends `Cache-Control: no-store`, because the IIS ARR proxy otherwise caches identical GETs for about a minute.

### Security

- Passwords: scrypt (N=32768, r=8, p=1, 16-byte salt), never logged or returned. Unknown-email logins still spend the same hashing time.
- Sessions: random 256-bit id in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` and the `__Host-` prefix in production); only its SHA-256 hash is stored. 30 days, sliding. Signing out or resetting the password deletes sessions server-side.
- Email tokens: random 256-bit, stored hashed, single use (atomic), 24 h (confirm) / 60 min (reset).
- CSRF: every state-changing request needs the `X-CSRF-Token` header (HMAC of the session) and an allowed `Origin`/`Referer`, and must be `application/json`.
- Rate limits (per IP and per account): sign-up, sign-in, resend (cooldown + daily cap), forgot password.
- Headers via helmet: strict same-origin Content-Security-Policy, no framing, no referrer, HSTS in production. Only `public/` is served; `data/`, `src/`, `server.js`, `package.json` etc. return 404.
- Logs never contain passwords, tokens or full email addresses (masked as `a***@example.com`).
- All SQL is parameterized.

### API

All `/api` responses are JSON with `Cache-Control: no-store`. Errors are `{ ok: false, error, message, field? }`. POSTs need `Content-Type: application/json`, an allowed `Origin`, and (when signed in) the `X-CSRF-Token` header from `GET /api/auth/me`.

- `GET /api/health` → `{ ok, app, node, port, db, mail, time }`
- `GET /api/auth/me` → `{ ok, signedIn, csrfToken, user: { id, email, displayName, verified, best, bestDifficulty, scoreEpoch } | null }` (your own email only)
- `POST /api/auth/signup` `{ email, displayName, password }` → `201` + me payload, `mailSent`. `400` `email_invalid` / `displayName_rejected` / `password_invalid`, `409` `email_taken` / `name_taken`, `429`
- `POST /api/auth/verify` `{ token }` → confirms; `signedIn` + me payload when the token belongs to the current session's account. `400` `token_invalid`
- `POST /api/auth/resend-verification` (session) → `{ ok, alreadyVerified? }`, `429` with `retryAfterSeconds`
- `POST /api/auth/login` `{ email, password }` → me payload; `401` `login_failed` (generic), `429`
- `POST /api/auth/logout` (session)
- `POST /api/auth/forgot` `{ email }` → always the same `{ ok, message }`
- `POST /api/auth/reset` `{ token, password }` → me payload (new session); other sessions are revoked
- `POST /api/account/name` `{ displayName }` (session) → me payload + board. `409` `name_taken`
- `GET /api/players` → `{ revision, players: [{ playerName, best, bestDifficulty?, updatedAt, isYou?, legacy? }] }`
- `POST /api/score` `{ score, difficulty, epoch?, runAccount? }` (confirmed account) → `{ ok, improved, stale, score, player, revision, players }`
  - The player comes from the session; a name in the body is ignored. `401` signed out, `403` `csrf_failed` / `email_unverified`.
  - The server keeps the higher of `score` and the stored best (and tags it with `difficulty` when higher), so saves can overlap, repeat or arrive out of order.
  - `epoch`: the account's `scoreEpoch` when the run started; a score from before a reset is ignored (`stale: true`).
  - `runAccount`: the account id the run started under; a different session account gets `409` `account_changed`.
- `POST /api/reset-best` (confirmed account) → `{ ok, found, previousBest, player, revision, players }`. Sets your best to 0 and bumps `scoreEpoch`.
- The old `GET/PUT /api/settings` name-only API is gone (404).

### Configuration

All settings are environment variables (or lines in an env file: `.env` in the app folder, or the file named by `SNAKEARCADE_ENV_FILE`; real environment variables win). See [`.env.example`](.env.example) for the full list with defaults. The important ones:

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | | `production` on the server: requires `SESSION_SECRET`, secure cookies |
| `PORT`, `HOST` | `3023`, `localhost` | production service uses `3105` |
| `PUBLIC_BASE_URL` | `http://localhost:PORT` | used in email links and the Origin check: `https://snakearcade.socha3.com` |
| `SESSION_SECRET` | | 32+ random characters, secret |
| `DB_CLIENT` | `sqlite` | `mssql` in production |
| `SQLITE_FILE` | `data/snakearcade.db` | local only |
| `DB_CONNECTION_STRING` | | SQL Server app login (read/write), secret |
| `DB_MIGRATION_CONNECTION_STRING` | | optional login with DDL rights for migrations, secret |
| `DB_MIGRATE_ON_START` | `true` | `false` if the app login can't create tables |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | empty, `587`, port 465 → true | empty host = write emails to `data/outbox/` |
| `SMTP_USER`, `SMTP_PASSWORD` | | mailbox login, password is secret |
| `MAIL_FROM`, `MAIL_REPLY_TO` | `SnakeArcade <no-reply@socha3.com>` | |
| `RATE_LIMIT_*`, `VERIFY_TOKEN_HOURS`, `RESET_TOKEN_MINUTES` | see `.env.example` | |

**Email in production** goes through the socha3.com mailbox over authenticated SMTP: port 587 with STARTTLS (`SMTP_SECURE=false`, TLS is still required) or port 465 with TLS (`SMTP_SECURE=true`). Suggested sender: a dedicated `no-reply@socha3.com` mailbox (or the existing one). The SMTP password is a server secret: set it only on the server, never commit it. Publish SPF, DKIM (and ideally DMARC) records for socha3.com so the emails don't land in spam. Details: [`docs/database-setup.md`](docs/database-setup.md).

### Database & migrations

SQL Server in production, SQLite locally, same schema (`migrations/mssql/*.sql` and `migrations/sqlite/*.sql`). Applied versions are recorded in `schema_migrations`; each migration runs in a transaction.

```bash
npm run migrate              # apply pending migrations
npm run migrate -- --check   # list pending migrations (exit 1 if any)
```

`server.js` applies pending migrations on start (`DB_MIGRATE_ON_START=true`, using `DB_MIGRATION_CONNECTION_STRING` when set) and refuses to start if any are still pending. The deploy script also runs them before switching versions. Expired sessions and old tokens are purged every 6 hours.

**Old leaderboard (optional):** the previous name-only board lived in `data/settings.json`. It is not used any more and is left untouched. To show those scores on the new board (tagged **legacy**, not tied to any account):

```bash
npm run import-legacy -- --dry-run   # show what would be imported
npm run import-legacy                # import (re-running replaces, no duplicates)
npm run import-legacy -- --clear     # remove them again
```

### Tests

```bash
npm test                      # API tests on a temporary SQLite database
TEST_DB=mssql TEST_MSSQL_CONNECTION_STRING="Server=...;Database=SnakeArcade_Test;..." npm test
```

The SQL Server run uses an empty test database (tables are dropped afterwards); `TEST_MSSQL_DRIVER=msnodesqlv8` uses Windows authentication via the ODBC driver (needs `npm install msnodesqlv8`).

## Deploy (socha3 Windows / IIS)

Production target:

- Public URL: `https://snakearcade.socha3.com`
- App folder: `C:\WebApps\SnakeArcade`
- Node service: Windows service `SnakeArcadeNode` (WinSW), auto-start
- Node listens on `localhost:3105` (`PORT=3105` set by the service; on Windows Server 2025 / Node 24 this is `[::1]:3105`)
- IIS site `SnakeArcade` reverse-proxies to `http://localhost:3105` via URL Rewrite + ARR (`web.config`). Do not point it at `127.0.0.1`: Node is not listening on IPv4 and ARR returns 502.

### Before the first deploy with accounts

Follow [`docs/database-setup.md`](docs/database-setup.md) (checklist at the end): SQL Server database + logins, the server env file with `SESSION_SECRET`, `DB_*`, `SMTP_*`, and SPF/DKIM for socha3.com. Without `SESSION_SECRET` and a database the service refuses to start (the health check fails and the deploy job goes red, the previous files are already replaced by then, so do the setup first).

The server binds `localhost` only (IIS owns the public ports) and serves only `public/`.

### Automatic deploy on merge to `main` (GitHub Actions)

`.github/workflows/deploy.yml` deploys every push to `main` (plus manual **Actions > Deploy > Run workflow**) on a self-hosted runner that lives on the server (labels `self-hosted, windows, snakearcade`), so the server needs no inbound access. Deploys never overlap (`concurrency`).

Steps: checkout, use the Node.js already installed on the server, `npm ci --omit=dev` (or `npm install --omit=dev` without a lockfile), then `scripts/deploy.ps1` (Windows PowerShell 5.1):

0. Applies database migrations from the checkout (`node scripts\migrate.js`) with the server env file (`-EnvFile`, default `C:\WebApps\SnakeArcade-config\snakearcade.env`) while the old version keeps running. A failed migration stops the deploy before anything is touched. Skipped with `-SkipMigrations` or when the env file doesn't exist (the service then migrates on start).
1. Stops `SnakeArcadeNode`.
2. Backs up `data\settings.json` to `C:\WebApps\SnakeArcade-backups`.
3. Mirrors the checkout into `C:\WebApps\SnakeArcade` with `robocopy /MIR`, excluding `data\`, `.git\`, `.github\`, `logs\`, `web.config`, `.env` / `*.env`, `*.log` and the WinSW files (robocopy exit codes 0-7 = success, 8+ = failure), then verifies `settings.json` is unchanged.
4. Starts the service and polls `http://localhost:3105/api/health` until `ok: true` (the job fails otherwise), then checks the public URL. The workflow passes `-RequirePublicHealthy`, so the job fails if the public URL never returns `ok: true` (e.g. an IIS/ARR 502). Health URLs get a cache-busting query string because ARR caches `/api/health` briefly.

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
2. **Keep** the server `web.config` that rewrites to `http://localhost:3105/{R:1}` (use `localhost`, not `127.0.0.1`). Do not overwrite it with an empty/missing file from git if the repo has no `web.config`.
3. On the server, in the app folder:

```powershell
cd C:\WebApps\SnakeArcade
npm ci
# or: npm install --omit=dev
```

4. Ensure the env file (or WinSW `<env>` entries) is in place, see [`docs/database-setup.md`](docs/database-setup.md), and run `npm run migrate` if the app login can't create tables.
5. Restart the Node service:

```powershell
Restart-Service SnakeArcadeNode
```

6. Smoke-test:

- Direct: `http://localhost:3105/`, `/api/health` (shows `db` and `mail` mode) and `/api/players`
- Via IIS/Cloudflare: `https://snakearcade.socha3.com/` and `/api/players`

### Do not delete

- `C:\Tools\WinSW\SnakeArcadeNode.exe` (+ `.xml`) — service wrapper
- IIS site/pool `SnakeArcade`
- Cloudflare DNS `snakearcade.socha3.com` (proxied A to the origin)

### Optional

- `TRUST_PROXY` (default `true`): the app sits behind IIS/ARR (and Cloudflare) and binds `localhost` only, so it uses Cloudflare's `CF-Connecting-IP` / `X-Forwarded-For` for the visitor's IP (rate limits are per visitor). Set `false` if Node is ever reachable directly.
- `GET /api/health` is implemented for ops checks
