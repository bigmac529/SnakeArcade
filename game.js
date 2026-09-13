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
  const saveSettingsBtn = document.querySelector("#save-settings");
  const exportSettingsBtn = document.querySelector("#export-settings");
  const importSettingsInput = document.querySelector("#import-settings");

  let settings = window.SnakeSettings.loadSettings();
  let settingsFileHandle = null;
  let baseDelay = paceDelays[settings.difficulty] || paceDelays[difficultyEl.value] || 125;

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
  }

  bestEl.textContent = best;
  difficultyEl.value = settings.difficulty in paceDelays ? settings.difficulty : "normal";
  nameInput.value = settings.playerName || "";
  updateMuteUi();
  applyName(settings.playerName || "", { silent: true, persist: false });
  reset();
  requestAnimationFrame(loop);

  window.SnakeSettings.hydrateFromServer(nameInput.value).then((hydrated) => {
    if (!hydrated) {
      return;
    }
    applySettingsToUi(hydrated);
  });

  startBtn.addEventListener("click", () => {
    start();
    canvas.focus({ preventScroll: true });
  });
  pauseBtn.addEventListener("click", togglePause);
  restartBtn.addEventListener("click", () => {
    reset();
    start();
    canvas.focus({ preventScroll: true });
  });
  muteBtn.addEventListener("click", toggleMute);
  overlayStartBtn.addEventListener("click", () => {
    start();
    canvas.focus({ preventScroll: true });
  });
  difficultyEl.addEventListener("change", () => {
    if (!running) {
      applyPace();
      speedEl.textContent = "1";
      persistSettings({ difficulty: difficultyEl.value });
      announce(`Pace set to ${difficultyEl.value}.`);
    }
  });

  nameInput.addEventListener("change", () => {
    applyName(nameInput.value, { persist: true });
  });
  nameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyName(nameInput.value, { persist: true });
      nameInput.blur();
    }
  });
  saveSettingsBtn.addEventListener("click", async () => {
    if (!applyName(nameInput.value, { persist: true })) {
      return;
    }
    const saved = persistSettings({});
    nameHint.textContent = "Settings saved to server and this browser.";
    nameHint.classList.remove("error");
    announce("Settings saved to server and this browser.");

    // Optional file-picker / download remains available as a backup export.
    if (window.showSaveFilePicker) {
      try {
        settingsFileHandle = settingsFileHandle || await window.showSaveFilePicker({
          suggestedName: "snake-settings.json",
          types: [{ description: "JSON", accept: { "application/json": [".json"] } }]
        });
        await window.SnakeSettings.maybeWriteLocalFile(saved, settingsFileHandle);
        nameHint.textContent = "Settings saved to server and this browser (backup JSON file updated).";
        announce("Settings saved to server; backup JSON file updated.");
        return;
      } catch (error) {
        if (error && error.name === "AbortError") {
          return;
        }
      }
    }
  });
  exportSettingsBtn.addEventListener("click", () => {
    applyName(nameInput.value, { persist: true });
    window.SnakeSettings.downloadSettings(persistSettings({}));
    announce("Downloaded snake-settings.json.");
  });
  importSettingsInput.addEventListener("change", async () => {
    const file = importSettingsInput.files && importSettingsInput.files[0];
    if (!file) {
      return;
    }
    try {
      const parsed = JSON.parse(await file.text());
      const next = window.SnakeSettings.saveSettings({
        ...window.SnakeSettings.loadSettings(),
        ...parsed
      });
      settings = next;
      best = Number(next.best || 0);
      muted = Boolean(next.muted);
      bestEl.textContent = best;
      difficultyEl.value = next.difficulty in paceDelays ? next.difficulty : "normal";
      nameInput.value = next.playerName || "";
      updateMuteUi();
      applyPace();
      applyName(next.playerName || "", { persist: false });
      nameHint.textContent = "Loaded settings from JSON.";
      nameHint.classList.remove("error");
      announce("Settings loaded from JSON.");
    } catch (_) {
      nameHint.textContent = "Could not read that JSON file.";
      nameHint.classList.add("error");
    }
    importSettingsInput.value = "";
  });

  document.querySelectorAll(".dpad [data-dir]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const map = {
        up: { x: 0, y: -1 },
        down: { x: 0, y: 1 },
        left: { x: -1, y: 0 },
        right: { x: 1, y: 0 }
      };
      queueDirection(map[btn.dataset.dir]);
      if (!running && !gameOver) {
        start();
      }
      canvas.focus({ preventScroll: true });
    });
  });

  document.addEventListener("keydown", (event) => {
    const next = directionFromKey(event.key);

    if (next) {
      event.preventDefault();
      queueDirection(next);
      if (!running && !gameOver) {
        start();
      }
      return;
    }

    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      if (gameOver) {
        reset();
      }
      start();
    }

    if (event.key.toLowerCase() === "p") {
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
      queueDirection(Math.abs(dx) > Math.abs(dy)
        ? { x: Math.sign(dx), y: 0 }
        : { x: 0, y: Math.sign(dy) });
      start();
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

  function start() {
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
    persistSettings({ muted });
    updateMuteUi();
    if (!muted) {
      ensureAudio();
      beep(440, 0.04, "sine", 0.03);
    }
  }

  function persistSettings(patch) {
    settings = window.SnakeSettings.saveSettings({
      ...settings,
      playerName: nameInput.value.trim(),
      muted,
      difficulty: difficultyEl.value,
      best,
      ...patch
    });
    return settings;
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
      return false;
    }

    nameInput.value = result.name;
    nameHint.textContent = result.name
      ? `${result.message} Settings sync to the server disk JSON when you save.`
      : "Playing as Guest. Settings sync to the server disk JSON when you save.";
    nameHint.classList.remove("error");
    if (persist) {
      persistSettings({ playerName: result.name });
    }
    if (!silent) {
      announce(result.message);
    }
    return true;
  }

  function updateMuteUi() {
    muteBtn.textContent = muted ? "Sound: Off" : "Sound: On";
    muteBtn.setAttribute("aria-pressed", muted ? "true" : "false");
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
    setOverlay("Press Start", "Use arrow keys, WASD, swipe, or the pad.");
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
        persistSettings({ best });
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
