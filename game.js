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

  const cells = 24;
  const tile = canvas.width / cells;
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
  let queuedDirection;
  let score;
  let best = Number(settings.best || 0);
  let running = false;
  let paused = false;
  let gameOver = false;
  let lastMove = 0;
  let moveDelay = baseDelay;
  let touchStart = null;
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

  document.querySelectorAll(".dpad [data-dir]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!running || gameOver) {
        return;
      }
      const map = {
        up: { x: 0, y: -1 },
        down: { x: 0, y: 1 },
        left: { x: -1, y: 0 },
        right: { x: 1, y: 0 }
      };
      queueDirection(map[btn.dataset.dir]);
      canvas.focus({ preventScroll: true });
    });
  });

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

    const next = directionFromKey(event.key);

    if (next) {
      if (!running || gameOver) {
        return;
      }
      event.preventDefault();
      queueDirection(next);
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

  canvas.addEventListener("touchstart", (event) => {
    const touch = event.changedTouches[0];
    touchStart = { x: touch.clientX, y: touch.clientY };
  }, { passive: true });

  canvas.addEventListener("touchend", (event) => {
    if (!touchStart) {
      return;
    }

    const touch = event.changedTouches[0];
    const dx = touch.clientX - touchStart.x;
    const dy = touch.clientY - touchStart.y;

    if (Math.max(Math.abs(dx), Math.abs(dy)) > 20) {
      if (!running || gameOver) {
        touchStart = null;
        return;
      }
      queueDirection(Math.abs(dx) > Math.abs(dy)
        ? { x: Math.sign(dx), y: 0 }
        : { x: 0, y: Math.sign(dy) });
    }

    touchStart = null;
  }, { passive: true });

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
            "Tap Start to play. Then use arrow keys, WASD, swipe, or the pad."
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
    queuedDirection = direction;
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
      setOverlay("Press Start", "Tap Start to play. Then use arrow keys, WASD, swipe, or the pad.");
    } else {
      setOverlay(
        "Save a name",
        "Pick a PG name (2+ characters), tap Save name, then Start."
      );
    }
    updateStartGateUi();
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
    direction = queuedDirection;
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
    pauseBtn.textContent = "Pause";
    beep(180, 0.18, "sawtooth", 0.04);

    const detail = beatBestThisRun
      ? `New best: ${best}`
      : "Press Restart or Enter to play again.";
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

    const pulse = reduceMotion ? 0 : Math.sin(foodPulse) * 2;
    ctx.fillStyle = "#f2c94c";
    roundRect(
      food.x * tile + 5 - pulse / 2,
      food.y * tile + 5 - pulse / 2,
      tile - 10 + pulse,
      tile - 10 + pulse,
      7
    );
    ctx.fill();

    snake.forEach((part, index) => {
      ctx.fillStyle = index === 0 ? "#a7f08d" : "#86d672";
      roundRect(part.x * tile + 3, part.y * tile + 3, tile - 6, tile - 6, 6);
      ctx.fill();
    });
  }

  function drawGrid() {
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;

    for (let i = 1; i < cells; i += 1) {
      const pos = i * tile;
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

  function queueDirection(next) {
    if (next.x === -direction.x && next.y === -direction.y) {
      return;
    }

    queuedDirection = next;
  }

  function directionFromKey(keyName) {
    const normalized = keyName.toLowerCase();
    const map = {
      arrowup: { x: 0, y: -1 },
      w: { x: 0, y: -1 },
      arrowdown: { x: 0, y: 1 },
      s: { x: 0, y: 1 },
      arrowleft: { x: -1, y: 0 },
      a: { x: -1, y: 0 },
      arrowright: { x: 1, y: 0 },
      d: { x: 1, y: 0 }
    };

    return map[normalized];
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
