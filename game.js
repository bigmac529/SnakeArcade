(() => {
  const canvas = document.querySelector("#game");
  const ctx = canvas.getContext("2d");
  const scoreEl = document.querySelector("#score");
  const bestEl = document.querySelector("#best");
  const speedEl = document.querySelector("#speed");
  const overlay = document.querySelector("#overlay");
  const startBtn = document.querySelector("#start");
  const pauseBtn = document.querySelector("#pause");
  const restartBtn = document.querySelector("#restart");
  const muteBtn = document.querySelector("#mute");
  const overlayStartBtn = document.querySelector("#overlay-start");
  const difficultyEl = document.querySelector("#difficulty");
  const statusEl = document.querySelector("#status");
  const boardEl = document.querySelector("#arcade-board");
  const boardListEl = document.querySelector("#arcade-board-list");
  const boardMetaEl = document.querySelector("#arcade-board-meta");
  const stageEl = document.querySelector("#stage");
  const arenaSlot = document.querySelector("#arena-slot");
  const canvasWrap = document.querySelector("#canvas-wrap");
  const shellEl = document.querySelector(".shell");
  const turnButtons = document.querySelectorAll(".turn-btn[data-turn]");
  const rootEl = document.documentElement;

  const cells = 24;
  // Design-time tile size (640px board / 24 cells); drawing insets scale from it.
  const designTile = 640 / cells;
  const minArena = 180;
  const maxArena = 640;
  const maxQueuedTurns = 2;
  let tile = canvas.width / cells;
  let drawScale = tile / designTile;
  const initialSnake = [
    { x: 11, y: 12 },
    { x: 10, y: 12 },
    { x: 9, y: 12 }
  ];
  const paceDelays = { easy: 160, normal: 125, fast: 95 };
  const minDelay = 68;

  const nameInput = document.querySelector("#player-name");
  const nameHint = document.querySelector("#name-hint");
  const saveNameBtn = document.querySelector("#save-settings");

  let settings = window.SnakeSettings.loadSettings();
  let baseDelay = paceDelays[settings.difficulty] || paceDelays[difficultyEl.value] || 125;
  let nameSavedThisSession = false;
  let savedNameSnapshot = "";
  let saveInFlight = false;

  let snake;
  let food;
  let direction;
  // Pending heading changes, applied one per tick so two quick turns can never
  // add up to a 180-degree reversal inside a single step.
  let turnQueue = [];
  let score;
  let best = Number(settings.best || 0);
  let running = false;
  let paused = false;
  let gameOver = false;
  let lastMove = 0;
  let moveDelay = baseDelay;
  let foodPulse = 0;
  let muted = Boolean(settings.muted);
  let audioCtx = null;
  let beatBestThisRun = false;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function applySettingsToUi(next) {
    settings = next;
    best = Number(next.best || 0);
    muted = Boolean(next.muted);
    bestEl.textContent = best;
    difficultyEl.value = next.difficulty in paceDelays ? next.difficulty : "normal";
    nameInput.value = next.playerName || "";
    updateMuteUi();
    applyPace();
    applyName(next.playerName || "", { silent: true, persist: false });
    updateStartGateUi();
  }

  bestEl.textContent = best;
  difficultyEl.value = settings.difficulty in paceDelays ? settings.difficulty : "normal";
  nameInput.value = settings.playerName || "";
  updateMuteUi();
  applyName(settings.playerName || "", { silent: true, persist: false });
  updateStartGateUi();
  layoutArena();
  reset();
  requestAnimationFrame(loop);
  refreshArcadeBoard();

  window.SnakeSettings.hydrateFromServer(nameInput.value).then((hydrated) => {
    if (!hydrated) {
      return;
    }
    applySettingsToUi(hydrated);
    refreshArcadeBoard();
  });

  startBtn.addEventListener("click", () => {
    if (!ensureCanStart()) {
      return;
    }
    start();
    canvas.focus({ preventScroll: true });
  });
  pauseBtn.addEventListener("click", togglePause);
  restartBtn.addEventListener("click", () => {
    // Restart always begins a fresh run — require a saved name.
    if (!ensureCanStart()) {
      return;
    }
    reset();
    start();
    canvas.focus({ preventScroll: true });
  });
  muteBtn.addEventListener("click", toggleMute);
  overlayStartBtn.addEventListener("click", () => {
    if (!ensureCanStart()) {
      return;
    }
    start();
    canvas.focus({ preventScroll: true });
  });
  difficultyEl.addEventListener("change", () => {
    if (!running) {
      applyPace();
      speedEl.textContent = "1";
      persistSettingsLocal({ difficulty: difficultyEl.value });
      if (nameSavedThisSession) {
        pushServerState({ force: true, quiet: true });
      }
      announce(`Pace set to ${difficultyEl.value}.`);
    }
  });

  nameInput.addEventListener("input", () => {
    // Changing the name clears the session "saved" gate.
    if (nameSavedThisSession) {
      nameSavedThisSession = false;
      savedNameSnapshot = "";
      updateStartGateUi();
      nameHint.textContent = "Name changed — save it before you can start.";
      nameHint.classList.remove("error");
    }
  });
  nameInput.addEventListener("change", () => {
    applyName(nameInput.value, { persist: false });
  });
  nameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      saveNameBtn.click();
    }
  });

  saveNameBtn.addEventListener("click", async () => {
    if (saveInFlight) {
      return;
    }
    if (!applyName(nameInput.value, { persist: false })) {
      updateStartGateUi();
      return;
    }

    saveInFlight = true;
    saveNameBtn.disabled = true;
    nameHint.textContent = "Saving name to arcade board…";
    nameHint.classList.remove("error");

    try {
      const draft = {
        ...settings,
        playerName: nameInput.value.trim(),
        muted,
        difficulty: difficultyEl.value,
        best
      };

      let result = await window.SnakeSettings.saveToServer(draft, {
        force: false,
        baseRevision: window.SnakeSettings.getKnownRevision()
      });

      if (!result.ok && result.error === "name_exists") {
        const existingBest = result.existing ? Number(result.existing.best || 0) : 0;
        const existingLabel =
          (result.existing && result.existing.playerName) || draft.playerName;
        const ok = window.confirm(
          `"${existingLabel}" is already on the arcade board (best score: ${existingBest}).\n\nClaim / overwrite this name?`
        );
        if (!ok) {
          nameHint.textContent = "Save cancelled — that name is already taken.";
          nameHint.classList.add("error");
          announce("Save cancelled.");
          return;
        }
        result = await window.SnakeSettings.saveToServer(draft, {
          force: true,
          baseRevision: result.revision != null
            ? result.revision
            : window.SnakeSettings.getKnownRevision()
        });
      }

      if (!result.ok) {
        if (result.error === "revision_conflict") {
          nameHint.textContent =
            "Arcade board changed while saving. Refreshing board — try Save name again.";
          await refreshArcadeBoard();
        } else if (result.error === "lock_busy") {
          nameHint.textContent =
            "Arcade board is busy (another save in progress). Please try again.";
        } else {
          nameHint.textContent = result.message || "Could not save name.";
        }
        nameHint.classList.add("error");
        announce(result.message || "Could not save name.");
        return;
      }

      settings = result.settings;
      best = Number(settings.best || 0);
      bestEl.textContent = best;
      nameSavedThisSession = true;
      savedNameSnapshot = settings.playerName;
      nameHint.textContent = `Saved as ${settings.playerName}. You’re cleared to Start.`;
      nameHint.classList.remove("error");
      announce(`Name saved: ${settings.playerName}.`);
      updateStartGateUi();
      await refreshArcadeBoard();
    } catch (_) {
      nameHint.textContent = "Network error while saving name.";
      nameHint.classList.add("error");
      announce("Network error while saving name.");
    } finally {
      saveInFlight = false;
      updateStartGateUi();
    }
  });

  turnButtons.forEach((btn) => {
    // pointerdown fires immediately on touch (no 300ms click delay); the CSS
    // sets touch-action: none so the browser never scrolls or zooms from here.
    btn.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "mouse" && event.button !== 0) {
        return;
      }
      event.preventDefault();
      btn.classList.add("is-pressed");
      turn(btn.dataset.turn);
    });
    const release = () => btn.classList.remove("is-pressed");
    btn.addEventListener("pointerup", release);
    btn.addEventListener("pointercancel", release);
    btn.addEventListener("pointerleave", release);
    // Deliberately no "click" handler: taps would then turn twice (pointerdown +
    // click). Keyboard players get the same relative turns from Left/Right
    // arrows and A / D (see the keydown handler).
    btn.addEventListener("contextmenu", (event) => event.preventDefault());
  });

  // Keep the page from panning while a game is live (belt and braces for iOS,
  // which does not always honour overflow: hidden on the root).
  stageEl.addEventListener("touchmove", (event) => {
    if (rootEl.classList.contains("is-playing")) {
      event.preventDefault();
    }
  }, { passive: false });

  window.addEventListener("resize", scheduleLayout);
  window.addEventListener("orientationchange", scheduleLayout);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", scheduleLayout);
  }
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(scheduleLayout);
    [arenaSlot, document.querySelector(".top-bar"), document.querySelector(".player-panel"),
      document.querySelector(".toolbar")].forEach((el) => el && ro.observe(el));
  }
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(scheduleLayout);
  }

  function isFormField(target) {
    if (!target || !target.tagName) {
      return false;
    }
    const tag = target.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
      return true;
    }
    return Boolean(target.isContentEditable);
  }

  document.addEventListener("keydown", (event) => {
    // Typing a name (or other form field) must never move/start the snake.
    if (isFormField(event.target)) {
      return;
    }

    // Leave browser shortcuts (Ctrl+A, Cmd+D, Alt+Arrow, ...) alone.
    const hasModifier = event.ctrlKey || event.metaKey || event.altKey;
    const side = hasModifier ? null : turnFromKey(event.key);

    if (side) {
      // Keys never start a run; they only steer while one is live.
      if (!running || gameOver) {
        return;
      }
      event.preventDefault();
      // Holding a key must not spin the snake: one press = one turn, like
      // one tap on an on-screen button.
      if (!paused && !event.repeat) {
        turn(side);
      }
      return;
    }

    if (!hasModifier && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      // Up/Down no longer steer, but still must not scroll the page mid-run.
      if (running && !gameOver) {
        event.preventDefault();
      }
      return;
    }

    if (event.key === " " || event.key === "Enter") {
      // Start / Restart are button-only; Space/Enter only toggle pause while playing.
      if (!running || gameOver) {
        return;
      }
      event.preventDefault();
      togglePause();
      return;
    }

    if (event.key.toLowerCase() === "p") {
      if (!running || gameOver) {
        return;
      }
      togglePause();
    }

    if (event.key.toLowerCase() === "m") {
      toggleMute();
    }
  });

  function applyPace() {
    baseDelay = paceDelays[difficultyEl.value] || 125;
    if (!running) {
      moveDelay = baseDelay;
    }
  }

  function announce(message) {
    statusEl.textContent = "";
    statusEl.textContent = message;
  }

  function canStart() {
    if (!nameSavedThisSession) {
      return false;
    }
    const check = window.SnakeSettings.validatePlayerName(nameInput.value);
    if (!check.ok || check.name.length < 2) {
      return false;
    }
    if (savedNameSnapshot && check.name !== savedNameSnapshot) {
      return false;
    }
    return true;
  }

  function ensureCanStart() {
    if (canStart()) {
      return true;
    }
    const check = window.SnakeSettings.validatePlayerName(nameInput.value);
    const msg = !check.ok
      ? check.message
      : "Save your name before starting.";
    nameHint.textContent = msg;
    nameHint.classList.add("error");
    announce(msg);
    updateStartGateUi();
    nameInput.focus({ preventScroll: true });
    return false;
  }

  function updateStartGateUi() {
    const ok = canStart();
    startBtn.disabled = !ok || saveInFlight;
    overlayStartBtn.disabled = !ok || saveInFlight;
    restartBtn.disabled = !ok || saveInFlight;
    saveNameBtn.disabled = saveInFlight;
    startBtn.title = ok ? "Start game" : "Save a PG name first";
    overlayStartBtn.title = startBtn.title;
    restartBtn.title = ok ? "Restart" : "Save a PG name first";
    if (overlay && !overlay.classList.contains("hidden")) {
      const title = overlay.querySelector("h2");
      if (title && (title.textContent === "Press Start" || title.textContent === "Save a name")) {
        if (!ok) {
          setOverlay(
            "Save a name",
            "Pick a PG name (2+ characters), tap Save name, then Start."
          );
        } else if (!running && !gameOver) {
          setOverlay(
            "Press Start",
            "Tap Start to play. Then steer with the Left / Right buttons (or ← / → or A / D keys)."
          );
        }
      }
    }
  }

  function start() {
    if (!ensureCanStart()) {
      return;
    }
    ensureAudio();

    if (gameOver) {
      reset();
    }

    running = true;
    paused = false;
    pauseBtn.textContent = "Pause";
    setOverlay(null);
    updatePlayState();
    window.scrollTo(0, 0);
    announce("Game started.");
    beep(520, 0.05, "triangle", 0.03);
  }

  function togglePause() {
    if (!running || gameOver) {
      return;
    }

    paused = !paused;
    pauseBtn.textContent = paused ? "Resume" : "Pause";
    setOverlay(paused ? "Paused" : null, paused ? "Press P, Resume, or keep playing." : "");
    announce(paused ? "Paused." : "Resumed.");
    updatePlayState();
  }

  function toggleMute() {
    muted = !muted;
    persistSettingsLocal({ muted });
    updateMuteUi();
    if (nameSavedThisSession) {
      pushServerState({ force: true, quiet: true });
    }
    if (!muted) {
      ensureAudio();
      beep(440, 0.04, "sine", 0.03);
    }
  }

  function persistSettingsLocal(patch = {}) {
    const merged = {
      ...settings,
      playerName: nameSavedThisSession
        ? savedNameSnapshot || nameInput.value.trim()
        : (settings.playerName || ""),
      muted,
      difficulty: difficultyEl.value,
      best,
      ...patch
    };
    const nameCheck = window.SnakeSettings.validatePlayerName(merged.playerName);
    // Never persist a rejected name from the input box via mute/pace/score saves.
    merged.playerName = nameCheck.ok ? nameCheck.name : (settings.playerName || "");
    settings = window.SnakeSettings.cacheSettings(merged);
    return settings;
  }

  async function pushServerState({ force = true, quiet = false } = {}) {
    if (!nameSavedThisSession || !savedNameSnapshot) {
      return;
    }
    const draft = {
      ...settings,
      playerName: savedNameSnapshot,
      muted,
      difficulty: difficultyEl.value,
      best
    };
    try {
      const result = await window.SnakeSettings.saveToServer(draft, {
        force,
        baseRevision: window.SnakeSettings.getKnownRevision()
      });
      if (result.ok) {
        settings = result.settings;
        if (result.revision != null) {
          await refreshArcadeBoard();
        }
      } else if (!quiet) {
        announce(result.message || "Could not sync score.");
      } else if (result.error === "revision_conflict" || result.error === "lock_busy") {
        // Soft retry once for background score sync.
        const retry = await window.SnakeSettings.saveToServer(draft, {
          force: true,
          baseRevision: result.revision != null
            ? result.revision
            : window.SnakeSettings.getKnownRevision()
        });
        if (retry.ok) {
          settings = retry.settings;
          await refreshArcadeBoard();
        }
      }
    } catch (_) {
      /* ignore background sync errors */
    }
  }

  function applyName(raw, { persist = false, silent = false } = {}) {
    const result = window.SnakeSettings.validatePlayerName(raw);
    nameInput.classList.toggle("invalid", !result.ok);
    if (!result.ok) {
      nameHint.textContent = result.message;
      nameHint.classList.add("error");
      if (!silent) {
        announce(result.message);
      }
      updateStartGateUi();
      return false;
    }

    nameInput.value = result.name;
    if (!nameSavedThisSession || result.name !== savedNameSnapshot) {
      nameHint.textContent = `${result.message} Tap Save name to claim it on the arcade board.`;
    } else {
      nameHint.textContent = `${result.message} Saved this session — Start when ready.`;
    }
    nameHint.classList.remove("error");
    if (persist) {
      persistSettingsLocal({ playerName: result.name });
    }
    if (!silent) {
      announce(result.message);
    }
    updateStartGateUi();
    return true;
  }

  function updateMuteUi() {
    muteBtn.textContent = muted ? "Sound: Off" : "Sound: On";
    muteBtn.setAttribute("aria-pressed", muted ? "true" : "false");
  }

  async function refreshArcadeBoard() {
    if (!boardListEl) {
      return;
    }
    const { revision, players } = await window.SnakeSettings.fetchPlayers();
    boardListEl.innerHTML = "";
    if (!players.length) {
      const empty = document.createElement("li");
      empty.className = "board-empty";
      empty.textContent = "No high scores yet — be the first snake!";
      boardListEl.appendChild(empty);
    } else {
      players.forEach((p, index) => {
        const li = document.createElement("li");
        li.className = "board-row";
        if (savedNameSnapshot && p.playerName === savedNameSnapshot) {
          li.classList.add("is-you");
        }
        const rank = document.createElement("span");
        rank.className = "board-rank";
        rank.textContent = index === 0 ? "👑" : `#${index + 1}`;
        const name = document.createElement("span");
        name.className = "board-name";
        name.textContent = p.playerName;
        const pts = document.createElement("span");
        pts.className = "board-best";
        pts.textContent = String(p.best);
        li.appendChild(rank);
        li.appendChild(name);
        li.appendChild(pts);
        boardListEl.appendChild(li);
      });
    }
    if (boardMetaEl) {
      boardMetaEl.textContent =
        revision != null ? `rev ${revision} · ${players.length} player${players.length === 1 ? "" : "s"}` : "";
    }
    if (boardEl) {
      boardEl.dataset.count = String(players.length);
    }
  }

  function reset() {
    snake = initialSnake.map((part) => ({ ...part }));
    direction = { x: 1, y: 0 };
    turnQueue = [];
    canvas.dataset.heading = headingName(direction);
    score = 0;
    applyPace();
    moveDelay = baseDelay;
    running = false;
    paused = false;
    gameOver = false;
    beatBestThisRun = false;
    scoreEl.textContent = score;
    speedEl.textContent = "1";
    bestEl.classList.remove("best-flash");
    overlay.querySelector("p").classList.remove("new-best");
    pauseBtn.textContent = "Pause";
    food = placeFood();
    if (canStart()) {
      setOverlay("Press Start", "Tap Start to play. Then steer with the Left / Right buttons (or ← / → or A / D keys).");
    } else {
      setOverlay(
        "Save a name",
        "Pick a PG name (2+ characters), tap Save name, then Start."
      );
    }
    updateStartGateUi();
    updatePlayState();
    draw();
  }

  function loop(time) {
    if (running && !paused && time - lastMove > moveDelay) {
      step();
      lastMove = time;
    }

    foodPulse = reduceMotion ? 0 : (foodPulse + 0.08) % (Math.PI * 2);
    draw();
    requestAnimationFrame(loop);
  }

  function step() {
    if (turnQueue.length) {
      direction = turnQueue.shift();
      canvas.dataset.heading = headingName(direction);
    }
    const head = {
      x: snake[0].x + direction.x,
      y: snake[0].y + direction.y
    };

    if (head.x < 0 || head.x >= cells || head.y < 0 || head.y >= cells || hitsSnake(head)) {
      finish();
      return;
    }

    snake.unshift(head);

    if (head.x === food.x && head.y === food.y) {
      score += 10;
      scoreEl.textContent = score;
      moveDelay = Math.max(minDelay, moveDelay - 3);
      speedEl.textContent = String(speedLevel());
      food = placeFood();
      beep(760, 0.06, "square", 0.035);

      if (score > best) {
        best = score;
        bestEl.textContent = best;
        bestEl.classList.add("best-flash");
        persistSettingsLocal({ best });
        pushServerState({ force: true, quiet: true });
        if (!beatBestThisRun) {
          beatBestThisRun = true;
          beep(880, 0.08, "sine", 0.04);
        }
      }
    } else {
      snake.pop();
    }
  }

  function speedLevel() {
    return Math.max(1, Math.round((baseDelay - moveDelay) / 3) + 1);
  }

  function finish() {
    running = false;
    gameOver = true;
    turnQueue = [];
    pauseBtn.textContent = "Pause";
    updatePlayState();
    beep(180, 0.18, "sawtooth", 0.04);

    const detail = beatBestThisRun
      ? `New best: ${best}`
      : "Press Restart to play again.";
    announce(beatBestThisRun ? `Game over. New best ${best}.` : `Game over. Score ${score}.`);
    setOverlay("Game Over", detail);
    if (beatBestThisRun) {
      overlay.querySelector("p").classList.add("new-best");
      refreshArcadeBoard();
    } else {
      overlay.querySelector("p").classList.remove("new-best");
    }
  }

  function draw() {
    ctx.fillStyle = "#0c1013";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawGrid();

    const k = drawScale;
    const pulse = reduceMotion ? 0 : Math.sin(foodPulse) * 2 * k;
    ctx.fillStyle = "#f2c94c";
    roundRect(
      food.x * tile + 5 * k - pulse / 2,
      food.y * tile + 5 * k - pulse / 2,
      tile - 10 * k + pulse,
      tile - 10 * k + pulse,
      7 * k
    );
    ctx.fill();

    snake.forEach((part, index) => {
      ctx.fillStyle = index === 0 ? "#a7f08d" : "#86d672";
      roundRect(part.x * tile + 3 * k, part.y * tile + 3 * k, tile - 6 * k, tile - 6 * k, 6 * k);
      ctx.fill();
    });
  }

  function drawGrid() {
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    const lineWidth = Math.max(1, Math.round(drawScale));
    // Odd widths need a half-pixel offset to land on whole device pixels.
    const offset = lineWidth % 2 ? 0.5 : 0;
    ctx.lineWidth = lineWidth;

    for (let i = 1; i < cells; i += 1) {
      const pos = Math.round(i * tile) + offset;
      ctx.beginPath();
      ctx.moveTo(pos, 0);
      ctx.lineTo(pos, canvas.height);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, pos);
      ctx.lineTo(canvas.width, pos);
      ctx.stroke();
    }
  }

  function roundRect(x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + width, y, x + width, y + height, radius);
    ctx.arcTo(x + width, y + height, x, y + height, radius);
    ctx.arcTo(x, y + height, x, y, radius);
    ctx.arcTo(x, y, x + width, y, radius);
    ctx.closePath();
  }

  function placeFood() {
    let candidate;

    do {
      candidate = {
        x: Math.floor(Math.random() * cells),
        y: Math.floor(Math.random() * cells)
      };
    } while (snake.some((part) => part.x === candidate.x && part.y === candidate.y));

    return candidate;
  }

  function hitsSnake(head) {
    return snake.some((part) => part.x === head.x && part.y === head.y);
  }

  function lastPlannedDirection() {
    return turnQueue.length ? turnQueue[turnQueue.length - 1] : direction;
  }

  // Relative turn, shared by the on-screen buttons and the keyboard
  // (Left/Right arrows, A / D). Left = 90deg counter-clockwise,
  // Right = 90deg clockwise, measured from the heading after queued turns.
  // Canvas y grows downward, so CCW maps (x, y) -> (y, -x).
  function turn(side) {
    if (!running || paused || gameOver) {
      return;
    }
    const base = lastPlannedDirection();
    const next = side === "left"
      ? { x: base.y, y: -base.x }
      : { x: -base.y, y: base.x };
    if (turnQueue.length >= maxQueuedTurns) {
      return;
    }
    turnQueue.push(next);
  }

  function headingName(dir) {
    if (dir.x === 1) return "right";
    if (dir.x === -1) return "left";
    if (dir.y === -1) return "up";
    return "down";
  }

  function updatePlayState() {
    const playing = running && !paused && !gameOver;
    rootEl.classList.toggle("is-playing", playing);
    rootEl.dataset.state = playing ? "playing" : paused ? "paused" : gameOver ? "over" : "ready";
    // Hidden panels change what sits above the arena, so resize right away.
    layoutArena();
  }

  let layoutFrame = 0;
  function scheduleLayout() {
    if (layoutFrame) {
      return;
    }
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0;
      layoutArena();
    });
  }

  function viewportHeight() {
    const vv = window.visualViewport;
    // When pinch-zoomed the visual viewport shrinks; fall back to the layout viewport.
    if (vv && Math.abs(vv.scale - 1) < 0.01) {
      return vv.height;
    }
    return window.innerHeight;
  }

  // Size the square board from the space actually left on screen: width of the
  // arena slot, and viewport height minus everything above the arena and the
  // turn buttons / padding below it. Backing store is snapped to a whole number
  // of device pixels per cell so the grid stays crisp on high-DPR screens.
  function layoutArena() {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const slotRect = arenaSlot.getBoundingClientRect();
    const slotTop = slotRect.top + window.scrollY;
    // Space the turn buttons need under the arena. Use their CSS minimum height
    // (they may stretch to fill leftover space during play, which must not
    // shrink the arena). In landscape they sit beside the arena instead.
    const firstBtn = turnButtons[0];
    const btnRect = firstBtn.getBoundingClientRect();
    const beside = btnRect.top < slotRect.bottom - 1;
    const stageGap = parseFloat(getComputedStyle(stageEl).rowGap) || 0;
    const btnMin = parseFloat(getComputedStyle(firstBtn).minHeight) || btnRect.height;
    const belowArena = beside ? 0 : stageGap + btnMin;
    const shellStyle = getComputedStyle(shellEl);
    const padBottom = parseFloat(shellStyle.paddingBottom) || 0;
    const availH = viewportHeight() - slotTop - belowArena - padBottom;
    const availW = arenaSlot.clientWidth;
    let cssSize = Math.floor(Math.min(availW, availH, maxArena));
    cssSize = Math.max(Math.min(minArena, availW), cssSize);

    const tileDevice = Math.max(4, Math.floor((cssSize * dpr) / cells));
    const devicePx = tileDevice * cells;
    const finalCss = devicePx / dpr;

    if (canvas.width !== devicePx) {
      canvas.width = devicePx;
      canvas.height = devicePx;
    }
    const cssText = `${finalCss}px`;
    if (canvasWrap.style.width !== cssText) {
      canvasWrap.style.width = cssText;
      canvasWrap.style.height = cssText;
      stageEl.style.setProperty("--arena-size", cssText);
    }
    tile = tileDevice;
    drawScale = tile / designTile;
    if (snake && food) {
      draw();
    }
  }

  // Keyboard steering is relative, exactly like the on-screen buttons:
  // ArrowLeft / A = turn left (CCW), ArrowRight / D = turn right (CW).
  // Up/Down and W/S intentionally do nothing.
  function turnFromKey(keyName) {
    const map = {
      arrowleft: "left",
      a: "left",
      arrowright: "right",
      d: "right"
    };
    return map[String(keyName || "").toLowerCase()] || null;
  }

  function setOverlay(title, message = "") {
    if (!title) {
      overlay.classList.add("hidden");
      return;
    }

    overlay.classList.remove("hidden");
    overlay.querySelector("h2").textContent = title;
    const p = overlay.querySelector("p");
    p.textContent = message;
    if (!message.startsWith("New best:")) {
      p.classList.remove("new-best");
    }
  }

  function ensureAudio() {
    if (muted || audioCtx) {
      return;
    }

    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      return;
    }

    audioCtx = new Ctx();
  }

  function beep(freq, duration, type, gainValue) {
    if (muted) {
      return;
    }

    ensureAudio();
    if (!audioCtx) {
      return;
    }

    if (audioCtx.state === "suspended") {
      audioCtx.resume();
    }

    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.value = gainValue;
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);
    osc.stop(audioCtx.currentTime + duration + 0.02);
  }
})();
