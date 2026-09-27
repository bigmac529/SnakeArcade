(() => {
  const canvas = document.querySelector("#game");
  const ctx = canvas.getContext("2d");
  const scoreEl = document.querySelector("#score");
  const bestEl = document.querySelector("#best");
  const overlay = document.querySelector("#overlay");
  const startBtn = document.querySelector("#start");
  const pauseBtn = document.querySelector("#pause");
  const restartBtn = document.querySelector("#restart");
  const muteBtn = document.querySelector("#mute");
  const overlayStartBtn = document.querySelector("#overlay-start");
  const difficultyEl = document.querySelector("#difficulty");
  const difficultyWrap = document.querySelector(".difficulty");
  const difficultyInfoBtn = document.querySelector("#difficulty-info");
  const difficultyTip = document.querySelector("#difficulty-tip");
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

  // The board always has 24 rows. Columns are added when the content column is
  // wider than a 24x24 square would be (cells stay square), so the board fills
  // the available width. The column count only changes between games.
  const rows = 24;
  const minCols = 24;
  let cols = 24;
  // Design-time tile size (640px board / 24 rows); drawing insets scale from it.
  const designTile = 640 / rows;
  const minArena = 180;
  const maxArena = 640;
  const maxQueuedTurns = 2;
  let tile = canvas.height / rows;
  let drawScale = tile / designTile;
  // Device-pixel offset of the playable grid inside the canvas. The canvas
  // spans the full container width; the grid (whole cells only) is centred in
  // it with a margin of less than one cell.
  let gridOffsetX = 0;

  function initialSnake() {
    const headX = Math.floor(cols / 2) - 1;
    const y = Math.floor(rows / 2);
    return [
      { x: headX, y },
      { x: headX - 1, y },
      { x: headX - 2, y }
    ];
  }
  // Fixed tick interval (ms per block) and points per food dot. The speed never
  // changes during a run: no ramp-up with time or score.
  const DIFFICULTIES = {
    easy: { label: "Easy", tickMs: 256, points: 5 },
    normal: { label: "Normal", tickMs: 128, points: 10 },
    hard: { label: "Hard", tickMs: 64, points: 20 }
  };
  const normalizeDifficulty = window.SnakeSettings.normalizeDifficulty;

  const nameInput = document.querySelector("#player-name");
  const nameHint = document.querySelector("#name-hint");
  const saveNameBtn = document.querySelector("#save-settings");

  let settings = window.SnakeSettings.loadSettings();
  let nameSavedThisSession = false;
  let savedNameSnapshot = "";
  let saveInFlight = false;

  let snake;
  let food;
  // Rendering only: where each segment was before the last tick, so draw() can
  // slide it toward its current cell. Game logic never reads these.
  let prevSnake = null;
  let eatenFood = null;
  let frameTime = 0;
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
  let pausedAt = 0;
  let ticks = 0;
  // Difficulty of the current / next run. Locked in when a run starts and never
  // changed while it is in progress.
  let runDifficulty = normalizeDifficulty(settings.difficulty);
  let moveDelay = DIFFICULTIES[runDifficulty].tickMs;
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
    if (!running) {
      difficultyEl.value = normalizeDifficulty(next.difficulty);
    }
    nameInput.value = next.playerName || "";
    updateMuteUi();
    applyDifficulty();
    applyName(next.playerName || "", { silent: true, persist: false });
    updateStartGateUi();
  }

  bestEl.textContent = best;
  difficultyEl.value = runDifficulty;
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
    // Difficulty is locked for the whole run (the select is also disabled while
    // playing or paused); a change only ever applies to the next run.
    if (running) {
      difficultyEl.value = runDifficulty;
      return;
    }
    applyDifficulty();
    persistSettingsLocal({ difficulty: runDifficulty });
    if (nameSavedThisSession) {
      pushServerState({ force: true, quiet: true });
    }
    announce(`Difficulty set to ${DIFFICULTIES[runDifficulty].label}.`);
    renderDifficultyTip();
  });

  // ---- Difficulty tooltip: points per dot + movement rate for each level.
  // Desktop: hover or keyboard focus on the dropdown / (i) button. Phones: tap
  // the (i) button or focus the dropdown. Never shown during play.
  let tipPinned = false;
  let tipHover = false;

  function blocksPerSecond(tickMs) {
    const rate = Math.round((1000 / tickMs) * 10) / 10;
    const text = Number.isInteger(rate) ? String(rate) : rate.toFixed(1);
    return `${text} block${rate === 1 ? "" : "s"} per second`;
  }

  function renderDifficultyTip() {
    const selected = selectedDifficulty();
    difficultyTip.innerHTML = "";
    const title = document.createElement("p");
    title.className = "tip-title";
    title.textContent = "Points and speed (fixed all game)";
    const list = document.createElement("ul");
    Object.entries(DIFFICULTIES).forEach(([key, d]) => {
      const li = document.createElement("li");
      li.dataset.difficulty = key;
      const name = document.createElement("strong");
      name.textContent = d.label;
      li.appendChild(name);
      li.appendChild(document.createTextNode(`: ${d.points} points per dot, ${blocksPerSecond(d.tickMs)}`));
      if (key === selected) {
        li.classList.add("is-selected");
        li.setAttribute("aria-current", "true");
        const tag = document.createElement("span");
        tag.className = "tip-selected sr-only";
        tag.textContent = " (selected)";
        li.appendChild(tag);
      }
      list.appendChild(li);
    });
    difficultyTip.append(title, list);
  }

  function isLivePlay() {
    return running && !paused && !gameOver;
  }

  function positionDifficultyTip() {
    const margin = 8;
    const gap = 10;
    const anchor = difficultyEl.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;
    difficultyTip.style.maxWidth = `${vw - margin * 2}px`;
    const tipRect = difficultyTip.getBoundingClientRect();
    let left = anchor.left + anchor.width / 2 - tipRect.width / 2;
    left = Math.max(margin, Math.min(left, vw - margin - tipRect.width));
    // Above the dropdown; only flip below if there is truly no room above.
    let top = anchor.top - gap - tipRect.height;
    const below = top < margin && anchor.bottom + gap + tipRect.height <= vh - margin;
    if (below) {
      top = anchor.bottom + gap;
    } else {
      top = Math.max(margin, top);
    }
    difficultyTip.classList.toggle("is-below", below);
    difficultyTip.style.left = `${Math.round(left)}px`;
    difficultyTip.style.top = `${Math.round(top)}px`;
    const arrowX = Math.max(14, Math.min(tipRect.width - 14, anchor.left + anchor.width / 2 - left));
    difficultyTip.style.setProperty("--arrow-x", `${Math.round(arrowX)}px`);
  }

  function showDifficultyTip() {
    if (isLivePlay()) {
      return;
    }
    renderDifficultyTip();
    difficultyTip.hidden = false;
    difficultyInfoBtn.setAttribute("aria-expanded", "true");
    positionDifficultyTip();
  }

  function hideDifficultyTip() {
    tipPinned = false;
    tipHover = false;
    difficultyTip.hidden = true;
    difficultyInfoBtn.setAttribute("aria-expanded", "false");
  }

  function syncDifficultyTip() {
    const focused = difficultyWrap.contains(document.activeElement) &&
      document.activeElement !== document.body;
    if (!isLivePlay() && (tipPinned || tipHover || focused)) {
      showDifficultyTip();
    } else {
      hideDifficultyTip();
    }
  }

  [difficultyEl, difficultyInfoBtn, difficultyTip].forEach((el) => {
    el.addEventListener("pointerenter", (event) => {
      if (event.pointerType === "mouse") {
        tipHover = true;
        syncDifficultyTip();
      }
    });
    el.addEventListener("pointerleave", (event) => {
      if (event.pointerType === "mouse") {
        tipHover = false;
        // Let the pointer cross the gap between the control and the tooltip.
        setTimeout(() => {
          if (!tipHover) {
            syncDifficultyTip();
          }
        }, 120);
      }
    });
  });
  difficultyWrap.addEventListener("focusin", syncDifficultyTip);
  difficultyWrap.addEventListener("focusout", () => setTimeout(syncDifficultyTip, 0));
  difficultyInfoBtn.addEventListener("click", (event) => {
    event.preventDefault();
    if (isLivePlay()) {
      return;
    }
    if (difficultyTip.hidden || !tipPinned) {
      tipPinned = true;
      showDifficultyTip();
    } else {
      hideDifficultyTip();
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!difficultyTip.hidden && !difficultyWrap.contains(event.target)) {
      hideDifficultyTip();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !difficultyTip.hidden) {
      hideDifficultyTip();
    }
  });
  const repositionTip = () => {
    if (!difficultyTip.hidden) {
      positionDifficultyTip();
    }
  };
  window.addEventListener("resize", repositionTip);
  window.addEventListener("scroll", repositionTip, { passive: true });

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
        difficulty: selectedDifficulty(),
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

  function selectedDifficulty() {
    return normalizeDifficulty(difficultyEl.value);
  }

  // Lock in the selected difficulty for the next run. No-op mid-run, so the
  // speed of a game in progress can never change.
  function applyDifficulty() {
    if (running) {
      return;
    }
    runDifficulty = selectedDifficulty();
    moveDelay = DIFFICULTIES[runDifficulty].tickMs;
    canvas.dataset.difficulty = runDifficulty;
    canvas.dataset.tickMs = String(moveDelay);
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

    if (!running) {
      // Fresh run: lock in difficulty and take the first step on the next frame.
      applyDifficulty();
      lastMove = performance.now() - moveDelay;
    } else if (paused) {
      lastMove += performance.now() - pausedAt;
    }
    const freshRun = !running;
    running = true;
    paused = false;
    pauseBtn.textContent = "Pause";
    setOverlay(null);
    updatePlayState();
    if (freshRun) {
      // Size the grid for the in-play layout (phones collapse the setup UI,
      // freeing height). This is the last moment columns may change.
      layoutArena({ regrid: true, fresh: true });
    }
    window.scrollTo(0, 0);
    announce("Game started.");
    beep(520, 0.05, "triangle", 0.03);
  }

  function togglePause() {
    if (!running || gameOver) {
      return;
    }

    paused = !paused;
    if (paused) {
      pausedAt = performance.now();
    } else {
      // Resume with the remainder of the interrupted tick, not a free step.
      lastMove += performance.now() - pausedAt;
    }
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
      difficulty: selectedDifficulty(),
      best,
      ...patch
    };
    const nameCheck = window.SnakeSettings.validatePlayerName(merged.playerName);
    // Never persist a rejected name from the input box via mute/difficulty/score saves.
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
      difficulty: selectedDifficulty(),
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
        // Difficulty the best score was set on (older entries have none).
        const diff = document.createElement("span");
        diff.className = "board-diff";
        const diffKey = p.bestDifficulty && DIFFICULTIES[p.bestDifficulty] ? p.bestDifficulty : "";
        if (diffKey) {
          diff.textContent = DIFFICULTIES[diffKey].label;
          diff.dataset.difficulty = diffKey;
          diff.title = `Best set on ${DIFFICULTIES[diffKey].label}`;
        }
        li.appendChild(rank);
        li.appendChild(name);
        li.appendChild(diff);
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
    // A fresh game may pick up a new column count (window resized since).
    layoutArena({ regrid: true, placing: true });
    snake = initialSnake();
    prevSnake = null;
    eatenFood = null;
    direction = { x: 1, y: 0 };
    turnQueue = [];
    canvas.dataset.heading = headingName(direction);
    score = 0;
    ticks = 0;
    canvas.dataset.ticks = "0";
    running = false;
    applyDifficulty();
    paused = false;
    gameOver = false;
    beatBestThisRun = false;
    scoreEl.textContent = score;
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
    frameTime = time;
    if (running && !paused) {
      const elapsed = time - lastMove;
      if (elapsed >= moveDelay) {
        step();
        // Keep a steady cadence (no drift from frame timing); if we fell far
        // behind (e.g. a background tab), resync instead of bursting steps.
        lastMove = elapsed < moveDelay * 2 ? lastMove + moveDelay : time;
      }
    }

    foodPulse = reduceMotion ? 0 : (foodPulse + 0.08) % (Math.PI * 2);
    draw();
    requestAnimationFrame(loop);
  }

  function step() {
    ticks += 1;
    canvas.dataset.ticks = String(ticks);
    if (turnQueue.length) {
      direction = turnQueue.shift();
      canvas.dataset.heading = headingName(direction);
    }
    const head = {
      x: snake[0].x + direction.x,
      y: snake[0].y + direction.y
    };
    prevSnake = snake.map((part) => ({ ...part }));
    eatenFood = null;

    if (head.x < 0 || head.x >= cols || head.y < 0 || head.y >= rows || hitsSnake(head)) {
      finish();
      return;
    }

    snake.unshift(head);

    if (head.x === food.x && head.y === food.y) {
      score += DIFFICULTIES[runDifficulty].points;
      scoreEl.textContent = score;
      eatenFood = { ...food };
      food = placeFood();
      beep(760, 0.06, "square", 0.035);

      if (score > best) {
        best = score;
        bestEl.textContent = best;
        bestEl.classList.add("best-flash");
        persistSettingsLocal({ best, bestDifficulty: runDifficulty });
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
    const boardW = cols * tile;
    const boardH = rows * tile;
    // Margin outside the grid (less than one cell wide) is darker, with a thin
    // edge line so the walls are unambiguous.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#080b0d";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.translate(gridOffsetX, 0);
    ctx.fillStyle = "#0c1013";
    ctx.fillRect(0, 0, boardW, boardH);
    drawGrid();
    if (gridOffsetX >= 2) {
      ctx.strokeStyle = "rgba(134, 214, 114, 0.28)";
      ctx.lineWidth = 1;
      ctx.strokeRect(-0.5, -0.5, boardW + 1, boardH + 1);
    }

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

    const t = renderFraction();

    // The dot just eaten shrinks away as the head slides onto it.
    if (eatenFood && t < 1) {
      const size = (tile - 10 * k) * (1 - t);
      const cx = (eatenFood.x + 0.5) * tile;
      const cy = (eatenFood.y + 0.5) * tile;
      ctx.fillStyle = "#f2c94c";
      roundRect(cx - size / 2, cy - size / 2, size, size, Math.min(7 * k, size / 2));
      ctx.fill();
    }

    const seg = tile - 6 * k;
    const center = (p) => ({ x: (p.x + 0.5) * tile, y: (p.y + 0.5) * tile });
    const headPos = segmentPosition(0, t);
    const tailPos = segmentPosition(snake.length - 1, t);
    // Body: one continuous stroke from the head, through the centre of every
    // occupied cell (so corners go through the corner cell, never a diagonal),
    // to the tail end. Each segment only ever moves between adjacent cells.
    const path = [headPos, ...snake.slice(1), tailPos].map(center);
    ctx.strokeStyle = "#86d672";
    ctx.lineWidth = seg;
    ctx.lineJoin = "round";
    ctx.lineCap = "butt";
    ctx.beginPath();
    ctx.moveTo(path[0].x, path[0].y);
    for (let i = 1; i < path.length; i += 1) {
      ctx.lineTo(path[i].x, path[i].y);
    }
    ctx.stroke();

    const tailC = center(tailPos);
    ctx.fillStyle = "#86d672";
    roundRect(tailC.x - seg / 2, tailC.y - seg / 2, seg, seg, 6 * k);
    ctx.fill();

    const headC = center(headPos);
    ctx.fillStyle = "#a7f08d";
    roundRect(headC.x - seg / 2, headC.y - seg / 2, seg, seg, 6 * k);
    ctx.fill();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // Fraction (0..1) of the current tick that has elapsed, used only to draw
  // segments between their previous and current cells. Snaps to 1 (grid
  // positions) before a run, after game over and with reduced motion; frozen
  // while paused.
  function renderFraction() {
    if (reduceMotion || !prevSnake || !running || gameOver) {
      return 1;
    }
    const now = paused ? pausedAt : frameTime;
    return Math.max(0, Math.min(1, (now - lastMove) / moveDelay));
  }

  function segmentPosition(index, t) {
    const cur = snake[index];
    const prev = prevSnake && prevSnake[index];
    if (!prev || t >= 1) {
      return { x: cur.x, y: cur.y };
    }
    return { x: prev.x + (cur.x - prev.x) * t, y: prev.y + (cur.y - prev.y) * t };
  }

  // Grid lines in board coordinates (the caller translates to the grid origin).
  function drawGrid() {
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    const lineWidth = Math.max(1, Math.round(drawScale));
    // Odd widths need a half-pixel offset to land on whole device pixels.
    const offset = lineWidth % 2 ? 0.5 : 0;
    ctx.lineWidth = lineWidth;
    const boardW = cols * tile;
    const boardH = rows * tile;

    for (let i = 1; i < cols; i += 1) {
      const pos = Math.round(i * tile) + offset;
      ctx.beginPath();
      ctx.moveTo(pos, 0);
      ctx.lineTo(pos, boardH);
      ctx.stroke();
    }
    for (let i = 1; i < rows; i += 1) {
      const pos = Math.round(i * tile) + offset;
      ctx.beginPath();
      ctx.moveTo(0, pos);
      ctx.lineTo(boardW, pos);
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
        x: Math.floor(Math.random() * cols),
        y: Math.floor(Math.random() * rows)
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
    // No difficulty changes while a run is live or paused.
    const locked = running && !gameOver;
    difficultyEl.disabled = locked;
    difficultyEl.title = locked ? "Difficulty is locked until this run ends" : "";
    if (playing) {
      // The tooltip must never cover the board during play.
      hideDifficultyTip();
    }
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

  // Size the board from the space actually left on screen: width of the arena
  // slot, and viewport height minus everything above the arena and the turn
  // buttons / padding below it. The row count is fixed; the cell size comes
  // from the height (capped so a narrow screen keeps a 24x24 square), and
  // between games the column count is chosen so the board fills the width.
  // Mid-run (and on the game-over screen) the columns never change: the board
  // is only rescaled. Cells are a whole number of device pixels so the grid
  // stays crisp on high-DPR screens.
  function layoutArena({ regrid = false, placing = false, fresh = false } = {}) {
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
    const widthPx = Math.max(Math.floor(minArena * dpr), Math.floor(availW * dpr));
    const heightCap = Math.max(Math.min(minArena, availW), Math.floor(Math.min(availH, maxArena)));

    const allowRegrid = regrid || (!running && !gameOver);
    let tileDevice;
    let nextCols = cols;
    if (allowRegrid) {
      const squareSide = Math.min(heightCap, availW);
      tileDevice = Math.max(4, Math.floor((squareSide * dpr) / rows));
      nextCols = Math.max(minCols, Math.floor(widthPx / tileDevice));
    } else {
      tileDevice = Math.max(4, Math.floor(Math.min(widthPx / cols, (heightCap * dpr) / rows)));
    }

    const colsChanged = nextCols !== cols;
    cols = nextCols;
    tile = tileDevice;
    drawScale = tile / designTile;
    const boardDevW = cols * tile;
    const canvasW = Math.max(boardDevW, widthPx);
    const canvasH = rows * tile;
    gridOffsetX = Math.floor((canvasW - boardDevW) / 2);

    if (canvas.width !== canvasW || canvas.height !== canvasH) {
      canvas.width = canvasW;
      canvas.height = canvasH;
    }
    const cssW = `${canvasW / dpr}px`;
    const cssH = `${canvasH / dpr}px`;
    if (canvasWrap.style.width !== cssW || canvasWrap.style.height !== cssH) {
      canvasWrap.style.width = cssW;
      canvasWrap.style.height = cssH;
      stageEl.style.setProperty("--arena-size", cssW);
    }
    canvas.dataset.cols = String(cols);
    canvas.dataset.rows = String(rows);
    canvas.dataset.tile = String(tile);
    canvas.dataset.offsetX = String(gridOffsetX);

    // Before a run starts (or at the instant it starts, sized for the in-play
    // layout), a new column count re-centres the snake and moves food that
    // would now be off the board. (reset() does its own placing.)
    if (colsChanged && !placing && snake && (fresh || (!running && !gameOver))) {
      snake = initialSnake();
      prevSnake = null;
      if (!food || food.x >= cols || snake.some((p) => p.x === food.x && p.y === food.y)) {
        food = placeFood();
      }
    }
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
