(() => {
  const canvas = document.querySelector("#game");
  const ctx = canvas.getContext("2d");
  const scoreEl = document.querySelector("#score");
  const bestEl = document.querySelector("#best");
  const overlay = document.querySelector("#overlay");
  const startBtn = document.querySelector("#start");
  const pauseBtn = document.querySelector("#pause");
  const endBtn = document.querySelector("#end-game");
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
  const boardStatusEl = document.querySelector("#arcade-board-status");
  const boardStatusTextEl = document.querySelector("#arcade-board-status-text");
  const boardRetryBtn = document.querySelector("#arcade-board-retry");
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
  // Arcade board: every render (GET or the answer to a score save) takes a
  // number; a GET whose answer arrives after a newer render is dropped, so a
  // slow or stale response can never replace a newer board.
  let boardSeq = 0;
  let boardLoaded = false;
  let boardStatusKind = "";
  // Score save queue (see queueScore).
  const SCORE_RETRY_MS = [400, 1200, 3000];
  let scoreQueue = [];
  let scorePump = null;
  let unsavedScore = null;

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
  // Player name the current / last run belongs to (fixed when it starts):
  // its score saves always go to this name.
  let runPlayer = "";
  // Score epoch of the saved player (bumped by Reset best score on the
  // server) and the one the current / last run started under. Score saves
  // carry the run's epoch; the server ignores ones from before a reset.
  let playerEpoch = null;
  let runEpoch = null;
  // Provisional ticks: the last tick stays open for a correction during its
  // first half (while the drawn head is still in the cell it is leaving).
  // Every tick in Relaxed mode; in both modes the tick right after a turn, so
  // a quick second press makes the tightest U-turn (see step()).
  // { snap: state before the tick, turned: the tick applied a turn,
  //   pending: effects held back until the window closes { ate, died } }
  let grace = null;
  // Rendering only: short blend of the head after a retroactive turn.
  let retroBlend = null;
  // Whether the last tick applied a turn (makes the next tick provisional).
  let lastTickTurned = false;
  const RETRO_BLEND_MS = 100;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Settings dialog preferences: turn highlight layers and turn eagerness.
  // Per browser in localStorage, not per player: they are play/viewing
  // preferences, and keeping them out of the server record leaves the
  // settings API unchanged.
  const DISPLAY_KEY = "snakearcade.prefs.v1";
  const DISPLAY_DEFAULTS = { guide: true, marker: true, eagerness: "early" };
  function loadDisplay() {
    try {
      const raw = JSON.parse(localStorage.getItem(DISPLAY_KEY) || "{}") || {};
      return {
        guide: raw.guide !== false,
        marker: raw.marker !== false,
        eagerness: raw.eagerness === "relaxed" ? "relaxed" : "early"
      };
    } catch {
      return { ...DISPLAY_DEFAULTS };
    }
  }
  let display = loadDisplay();

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
    // Skip if a name was already saved this session (a fast Save name wins
    // over this page-load read of the cached name).
    if (!hydrated || nameSavedThisSession) {
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
  // End game: stop the current run (playing or paused) exactly like a game
  // over. Nothing restarts; the player picks a difficulty and presses Start.
  endBtn.addEventListener("click", () => {
    // Settle an open Relaxed tick first (its food counts; a crash it held
    // back becomes the game over).
    closeGrace();
    if (!running || gameOver) {
      return;
    }
    finish({ ended: true });
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

  // ---- Settings dialog (display options). Modal: focus is trapped inside,
  // Escape / backdrop / Close close it, the page behind is inert. Opening it
  // during play pauses the game; closing it leaves the game paused.
  const settingsBtn = document.querySelector("#settings-btn");
  const settingsBackdrop = document.querySelector("#settings-backdrop");
  const settingsDialog = document.querySelector("#settings-dialog");
  const settingsCloseBtn = document.querySelector("#settings-close");
  const optGuide = document.querySelector("#opt-guide");
  const optMarker = document.querySelector("#opt-marker");
  const optEagerness = document.querySelectorAll("input[name='opt-eagerness']");
  let settingsReturnFocus = null;

  function isSettingsOpen() {
    return !settingsBackdrop.hidden;
  }

  function syncDisplayUi() {
    optGuide.checked = display.guide;
    optMarker.checked = display.marker;
    optEagerness.forEach((el) => {
      el.checked = el.value === display.eagerness;
    });
    canvas.dataset.turnGuide = display.guide ? "on" : "off";
    canvas.dataset.turnMarker = display.marker ? "on" : "off";
    canvas.dataset.eagerness = display.eagerness;
  }

  function setDisplay(patch) {
    display = { ...display, ...patch };
    try {
      localStorage.setItem(DISPLAY_KEY, JSON.stringify(display));
    } catch {
      // Storage full / blocked: the choice still applies for this page.
    }
    syncDisplayUi();
    if (!relaxedActive()) {
      // Leaving Relaxed mid-tick: settle the open tick now.
      closeGrace();
    }
    // The loop redraws every frame (also while paused), so this shows at once.
  }

  function settingsFocusables() {
    return Array.from(settingsDialog.querySelectorAll(
      "button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])"
    )).filter((el) => el.getClientRects().length > 0);
  }

  function openSettings() {
    if (isSettingsOpen()) {
      return;
    }
    if (isLivePlay()) {
      togglePause();
    }
    hideDifficultyTip();
    settingsReturnFocus = document.activeElement;
    syncDisplayUi();
    if (!resetBusy) {
      closeResetConfirm({ focus: false });
      setResetResult("");
    }
    settingsBackdrop.hidden = false;
    shellEl.inert = true;
    rootEl.classList.add("modal-open");
    settingsBtn.setAttribute("aria-expanded", "true");
    optGuide.focus({ preventScroll: true });
  }

  function closeSettings() {
    if (!isSettingsOpen()) {
      return;
    }
    settingsBackdrop.hidden = true;
    shellEl.inert = false;
    rootEl.classList.remove("modal-open");
    settingsBtn.setAttribute("aria-expanded", "false");
    const back = settingsReturnFocus && settingsReturnFocus.getClientRects().length > 0
      ? settingsReturnFocus
      : settingsBtn.getClientRects().length > 0 ? settingsBtn : canvas;
    settingsReturnFocus = null;
    back.focus({ preventScroll: true });
  }

  syncDisplayUi();
  settingsBtn.addEventListener("click", openSettings);
  settingsCloseBtn.addEventListener("click", closeSettings);
  optGuide.addEventListener("change", () => setDisplay({ guide: optGuide.checked }));
  optMarker.addEventListener("change", () => setDisplay({ marker: optMarker.checked }));
  optEagerness.forEach((el) => el.addEventListener("change", () => {
    if (el.checked) {
      setDisplay({ eagerness: el.value === "relaxed" ? "relaxed" : "early" });
    }
  }));
  settingsBackdrop.addEventListener("click", (event) => {
    if (event.target === settingsBackdrop) {
      closeSettings();
    }
  });
  settingsDialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      // Escape backs out of the reset confirmation first.
      if (isResetConfirmOpen() && !resetBusy) {
        closeResetConfirm();
      } else {
        closeSettings();
      }
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    const items = settingsFocusables();
    if (!items.length) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  // Keep focus inside if it ever lands outside the dialog (e.g. a click on
  // the backdrop edge before it closes).
  document.addEventListener("focusin", (event) => {
    if (isSettingsOpen() && !settingsDialog.contains(event.target)) {
      optGuide.focus({ preventScroll: true });
    }
  });

  // ---- Settings > Reset best score. Only for the saved name (or, with no
  // saved name, just this browser's Best). Not while a run is in progress:
  // Settings pauses a live game, and the run's score still belongs to it, so
  // the button stays disabled until the game ends.
  const resetRow = document.querySelector("#reset-best-row");
  const resetBtn = document.querySelector("#reset-best");
  const resetHint = document.querySelector("#reset-best-hint");
  const resetConfirm = document.querySelector("#reset-best-confirm");
  const resetQuestion = document.querySelector("#reset-best-question");
  const resetYes = document.querySelector("#reset-best-yes");
  const resetCancel = document.querySelector("#reset-best-cancel");
  const resetResult = document.querySelector("#reset-best-result");
  let resetBusy = false;

  function resetTarget() {
    return nameSavedThisSession && savedNameSnapshot ? savedNameSnapshot : "";
  }

  function syncResetUi() {
    const locked = runLocked();
    const name = resetTarget();
    resetBtn.disabled = locked || resetBusy;
    if (locked) {
      resetHint.textContent = "End the current game to reset your best.";
    } else if (name) {
      resetHint.textContent = `Only for ${name}: sets its best (${best}) to 0 and takes it off the arcade board.`;
    } else {
      resetHint.textContent = `No saved name: resets the Best in this browser (${best}) only.`;
    }
  }

  function setResetResult(text, tone = "") {
    resetResult.textContent = text;
    resetResult.dataset.tone = tone;
  }

  function isResetConfirmOpen() {
    return !resetConfirm.hidden;
  }

  function openResetConfirm() {
    if (runLocked() || resetBusy) {
      return;
    }
    const name = resetTarget();
    resetQuestion.textContent = name
      ? `Reset your best of ${best} to 0 for ${name}? This removes ${name} from the arcade board. Other names aren’t affected.`
      : `Reset the Best in this browser (${best}) to 0? No name is saved, so the arcade board isn’t changed.`;
    setResetResult("");
    resetRow.hidden = true;
    resetConfirm.hidden = false;
    resetYes.disabled = false;
    resetCancel.disabled = false;
    resetCancel.focus({ preventScroll: true });
    resetConfirm.scrollIntoView({ block: "nearest" });
  }

  function closeResetConfirm({ focus = true } = {}) {
    resetConfirm.hidden = true;
    resetRow.hidden = false;
    syncResetUi();
    if (focus) {
      resetBtn.focus({ preventScroll: true });
    }
  }

  function applyLocalBestReset() {
    settings = window.SnakeSettings.resetLocalBest();
    best = 0;
    bestEl.textContent = "0";
    bestEl.classList.remove("best-flash");
  }

  async function confirmReset() {
    if (resetBusy || runLocked()) {
      return;
    }
    const name = resetTarget();
    if (!name) {
      applyLocalBestReset();
      closeResetConfirm();
      setResetResult("Best in this browser reset to 0.", "ok");
      announce("Best reset to 0.");
      return;
    }
    resetBusy = true;
    resetYes.disabled = true;
    resetCancel.disabled = true;
    setResetResult("Resetting…");
    const result = await window.SnakeSettings.resetBestOnServer(name);
    resetBusy = false;
    if (!result.ok) {
      // Nothing changed locally either, so the two stay in step.
      closeResetConfirm();
      setResetResult(`Couldn’t reset ${name}’s best on the arcade board: ${result.message} Nothing was changed.`, "error");
      announce("Couldn’t reset your best.");
      return;
    }
    // Scores from before the reset must not bring the old best back: drop
    // this name's queued and unsaved ones; an in-flight one carries the old
    // epoch, which the server now ignores.
    playerEpoch = Number((result.player && result.player.scoreEpoch) || 0);
    scoreQueue = scoreQueue.filter((q) => q.name !== name);
    if (unsavedScore && unsavedScore.name === name) {
      unsavedScore = null;
      setBoardStatus("");
    }
    applyLocalBestReset();
    boardSeq += 1;
    renderBoard(result.players, result.revision);
    if (boardEl) {
      boardEl.dataset.savedBest = "0";
    }
    setBoardStatus(`Best reset to 0 for ${name}.`, "ok", { kind: "save" });
    closeResetConfirm();
    setResetResult(`Best reset to 0 for ${name}. It’s off the arcade board until you score again.`, "ok");
    announce(`Best reset to 0 for ${name}.`);
  }

  resetBtn.addEventListener("click", openResetConfirm);
  resetCancel.addEventListener("click", () => closeResetConfirm());
  resetYes.addEventListener("click", confirmReset);

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
    // The name can't change while a run is live or paused (its score belongs
    // to the name it started with).
    if (saveInFlight || runLocked()) {
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
      // No best in the draft: the name's best comes from the server (0 for a
      // new name), never from this browser's previous name.
      const draft = {
        ...settings,
        playerName: nameInput.value.trim(),
        muted,
        difficulty: selectedDifficulty()
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

      const previousName = savedNameSnapshot || settings.playerName || "";
      settings = result.settings;
      best = Number(settings.best || 0);
      bestEl.textContent = best;
      bestEl.classList.remove("best-flash");
      nameSavedThisSession = true;
      savedNameSnapshot = settings.playerName;
      playerEpoch = Number((result.data && result.data.scoreEpoch) || 0);
      if (previousName !== savedNameSnapshot) {
        // The last game's "Saved: …" line was about the previous name. An
        // unsaved score stays listed (it names its player).
        if (unsavedScore) {
          showUnsavedScore();
        } else {
          setBoardStatus("");
        }
      }
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
    // The Settings dialog owns the keyboard while it is open (the game is
    // paused behind it; Space on its Close button must not resume play).
    if (isSettingsOpen()) {
      return;
    }
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
      // Start / End game are button-only; Space/Enter only toggle pause while playing.
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

  // A run is live or paused.
  function runLocked() {
    return running && !gameOver;
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
    saveNameBtn.disabled = saveInFlight || runLocked();
    startBtn.title = ok ? "Start game" : "Save a PG name first";
    overlayStartBtn.title = startBtn.title;
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

    if (!running) {
      // Every Start after an idle board (fresh page, game over or End game)
      // is a brand-new game.
      reset();
    }

    if (!running) {
      // Fresh run: lock in difficulty and take the first step on the next frame.
      applyDifficulty();
      runPlayer = savedNameSnapshot;
      runEpoch = playerEpoch;
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
        // Soft retry once for background settings sync (mute / difficulty).
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
    const seq = ++boardSeq;
    const result = await window.SnakeSettings.fetchPlayers();
    if (seq !== boardSeq) {
      return;
    }
    if (!result.ok) {
      if (!boardLoaded) {
        boardListEl.innerHTML = "";
        const failed = document.createElement("li");
        failed.className = "board-empty";
        failed.textContent = "Couldn’t load the arcade board.";
        boardListEl.appendChild(failed);
      }
      setBoardStatus(`${result.message} Showing the last board loaded.`, "error", { kind: "load" });
      return;
    }
    if (boardStatusKind === "load") {
      setBoardStatus("");
    }
    renderBoard(result.players, result.revision);
  }

  function renderBoard(players, revision) {
    if (!boardListEl) {
      return;
    }
    boardLoaded = true;
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

  // Board status line: score save results and errors (never silent).
  function setBoardStatus(text, tone = "", { kind = "", retry = false } = {}) {
    boardStatusKind = text ? kind || tone : "";
    if (!boardStatusEl) {
      return;
    }
    boardStatusEl.hidden = !text;
    boardStatusEl.dataset.tone = tone;
    if (boardStatusTextEl) {
      boardStatusTextEl.textContent = text;
    }
    if (boardRetryBtn) {
      boardRetryBtn.hidden = !retry;
    }
  }

  // ---- Score saving. New bests during a run and every game over / End game
  // go through this queue: one request at a time, only the highest waiting
  // score per player is sent (the server keeps the max, so order never
  // matters), transient failures retry with backoff, and the board is
  // rendered from the server's answer to the save itself. A save that still
  // fails is shown on the board with a Retry button.

  // `name` is the player the score belongs to (the run's player), never
  // simply whoever is saved now.
  function queueScore(name, value, difficulty, { final = false, epoch = null } = {}) {
    if (!name) {
      return Promise.resolve();
    }
    const item = scoreQueue.find((q) => q.name === name);
    if (item) {
      if (value > item.score) {
        item.score = value;
        item.difficulty = difficulty;
      }
      if (final) {
        item.final = true;
        item.runScore = value;
      }
    } else {
      scoreQueue.push({ name, score: value, difficulty, final, runScore: final ? value : null, epoch });
    }
    // A score that failed to save earlier rides along (the max is kept).
    if (final && unsavedScore && unsavedScore.name === name) {
      const q = scoreQueue.find((x) => x.name === name);
      if (unsavedScore.score > q.score) {
        q.score = unsavedScore.score;
        q.difficulty = unsavedScore.difficulty;
      }
    }
    if (final && name === savedNameSnapshot) {
      setBoardStatus("Saving your score…", "pending");
    }
    if (!scorePump) {
      scorePump = (async () => {
        while (scoreQueue.length) {
          await sendScore(scoreQueue.shift());
        }
        scorePump = null;
      })();
    }
    return scorePump;
  }

  async function sendScore(item) {
    let result;
    for (let attempt = 0; ; attempt += 1) {
      try {
        result = await window.SnakeSettings.submitScore(item.name, item.score, item.difficulty, item.epoch);
      } catch (err) {
        result = { ok: false, retryable: true, message: String(err && err.message) };
      }
      if (result.ok || !result.retryable || attempt >= SCORE_RETRY_MS.length) {
        break;
      }
      await new Promise((r) => setTimeout(r, SCORE_RETRY_MS[attempt]));
    }

    // A score from before a Reset best score of the saved player: its answer
    // (or failure) must not bring the old best back here.
    const preReset = item.name === savedNameSnapshot && playerEpoch != null && item.epoch != null && item.epoch < playerEpoch;
    if (!result.ok) {
      if (preReset) {
        return;
      }
      if (!unsavedScore || unsavedScore.name !== item.name || item.score > unsavedScore.score) {
        unsavedScore = { name: item.name, score: item.score, difficulty: item.difficulty, epoch: item.epoch };
      }
      showUnsavedScore(result.message);
      announce(boardStatusTextEl ? boardStatusTextEl.textContent : "Couldn’t save your score.");
      if (boardEl) {
        boardEl.dataset.saveState = "error";
      }
      return;
    }

    const respEpoch = Number((result.player && result.player.scoreEpoch) || 0);
    if (result.stale && item.name === savedNameSnapshot && (playerEpoch == null || respEpoch > playerEpoch)) {
      // The name's best was reset elsewhere (another browser): this run's
      // score doesn't count, the next run's will.
      playerEpoch = respEpoch;
    }
    if (preReset || result.stale || (item.name === savedNameSnapshot && playerEpoch != null && respEpoch < playerEpoch)) {
      // Answered from before the reset (or ignored as stale): re-read the board
      // instead of drawing this answer.
      if (item.final && boardStatusKind === "pending") {
        setBoardStatus("That score wasn’t counted: this name’s best was reset.", "ok", { kind: "save" });
      }
      refreshArcadeBoard();
      return;
    }
    const serverBest = Number((result.player && result.player.best) || 0);
    if (unsavedScore && unsavedScore.name === item.name && unsavedScore.score <= serverBest) {
      unsavedScore = null;
    }
    // The server is the source of truth for the best on the board; pick up a
    // higher one (e.g. set on another device).
    if (item.name === savedNameSnapshot && serverBest > best) {
      best = serverBest;
      bestEl.textContent = best;
      persistSettingsLocal({ best, bestDifficulty: result.player.bestDifficulty });
    }
    boardSeq += 1;
    renderBoard(result.players, result.revision);
    if (boardEl) {
      boardEl.dataset.saveState = unsavedScore ? "error" : "saved";
      boardEl.dataset.savedBest = String(serverBest);
    }
    if (unsavedScore) {
      // Another player's (pre-rename) score still failed: keep that visible.
      showUnsavedScore();
    } else if (item.final) {
      const run = item.runScore != null ? item.runScore : item.score;
      const whose = item.name === savedNameSnapshot ? "your" : `${item.name}’s`;
      setBoardStatus(
        run > 0 && run >= serverBest
          ? `Saved: ${run} is ${whose} best on the arcade board.`
          : run > 0
            ? `Score ${run}. The board keeps ${whose} best: ${serverBest}.`
            : "Score 0. Eat a dot to get on the arcade board.",
        "ok",
        { kind: "save" }
      );
    } else if (!unsavedScore && boardStatusKind === "save") {
      setBoardStatus("");
    }
  }

  // Error line for a score that didn't save; it names the player when that
  // isn't the name saved now (after a rename it still belongs to them).
  let unsavedReason = "";
  function showUnsavedScore(reason) {
    if (!unsavedScore) {
      return;
    }
    if (reason) {
      unsavedReason = reason;
    }
    const who = unsavedScore.name === savedNameSnapshot ? "" : ` for ${unsavedScore.name}`;
    setBoardStatus(
      `Couldn’t save your score of ${unsavedScore.score}${who} to the arcade board: ${unsavedReason || "unknown error"}`,
      "error",
      { kind: "save", retry: true }
    );
  }

  if (boardRetryBtn) {
    boardRetryBtn.addEventListener("click", () => {
      if (unsavedScore) {
        // Always re-sent for the player who scored it.
        queueScore(unsavedScore.name, unsavedScore.score, unsavedScore.difficulty, { final: true, epoch: unsavedScore.epoch });
      } else {
        setBoardStatus("");
        refreshArcadeBoard();
      }
    });
  }

  function reset() {
    // A fresh game may pick up a new column count (window resized since).
    layoutArena({ regrid: true, placing: true });
    snake = initialSnake();
    prevSnake = null;
    eatenFood = null;
    grace = null;
    retroBlend = null;
    lastTickTurned = false;
    canvas.dataset.lastTurn = "";
    direction = { x: 1, y: 0 };
    turnQueue = [];
    canvas.dataset.heading = headingName(direction);
    canvas.dataset.head = `${snake[0].x},${snake[0].y}`;
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
    if (grace && running && !paused && renderFraction() >= 0.5) {
      // The drawn head crossed into the logical head's cell: commit the tick.
      closeGrace();
    }
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

  function relaxedActive() {
    // With reduced motion the head is drawn in its logical cell right away,
    // so there is no visual lag to make up for: Relaxed acts like Early.
    return display.eagerness === "relaxed" && !reduceMotion;
  }

  function snapshot() {
    return {
      snake: snake.map((part) => ({ ...part })),
      direction,
      food: { ...food },
      score,
      prevSnake,
      eatenFood,
      head: canvas.dataset.head,
      heading: canvas.dataset.heading,
      lastTickTurned
    };
  }

  // One game tick. A provisional tick stays correctable during its first half
  // (the drawn head is still in the cell the tick left): food / best / sound
  // and a crash are held back (grace.pending) so a retroactive turn can
  // replace the tick. `retro` re-runs the current tick from its snapshot
  // (same tick number, no timing change).
  //
  // Provisional ticks: every tick in Relaxed mode, and in both modes the tick
  // right after a turn. The latter fixes wide U-turns: turns apply one per
  // tick, so if the second press of a double tap arrived just after the next
  // tick had already moved the head on from the first perpendicular cell, it
  // used to apply a cell later (an empty lane between trail and return path).
  // Now it still turns in that first cell while the head is drawn there.
  function step({ retro = false } = {}) {
    if (!retro) {
      closeGrace();
      if (!running || gameOver) {
        return;
      }
      ticks += 1;
      canvas.dataset.ticks = String(ticks);
    }
    const snap = retro ? grace.snap : snapshot();
    const provisional = !reduceMotion && (display.eagerness === "relaxed" || snap.lastTickTurned);
    let turned = false;
    if (turnQueue.length) {
      const at = snake[0];
      direction = turnQueue.shift();
      turned = true;
      canvas.dataset.heading = headingName(direction);
      canvas.dataset.lastTurn = `${at.x},${at.y},${headingName(direction)},${ticks}`;
    }
    const head = {
      x: snake[0].x + direction.x,
      y: snake[0].y + direction.y
    };
    prevSnake = snake.map((part) => ({ ...part }));
    eatenFood = null;
    const pending = { ate: false, died: false };
    lastTickTurned = turned;

    if (head.x < 0 || head.x >= cols || head.y < 0 || head.y >= rows || hitsSnake(head)) {
      if (provisional) {
        // Crash confirmed when the window closes, unless a turn avoids it.
        pending.died = true;
        grace = { snap, turned, pending };
        return;
      }
      finish();
      return;
    }

    snake.unshift(head);
    canvas.dataset.head = `${head.x},${head.y}`;

    if (head.x === food.x && head.y === food.y) {
      score += DIFFICULTIES[runDifficulty].points;
      eatenFood = { ...food };
      food = placeFood();
      if (provisional) {
        pending.ate = true;
      } else {
        foodEffects();
      }
    } else {
      snake.pop();
    }
    if (provisional) {
      grace = { snap, turned, pending };
    }
  }

  // Score display, sound and best for a dot just eaten (score already added).
  function foodEffects() {
    scoreEl.textContent = score;
    beep(760, 0.06, "square", 0.035);

    if (score > best) {
      best = score;
      bestEl.textContent = best;
      bestEl.classList.add("best-flash");
      persistSettingsLocal({ best, bestDifficulty: runDifficulty });
      // Save the new best right away (so it counts even if the tab is closed
      // mid-run); the queue sends only the latest if several are waiting.
      queueScore(runPlayer, score, runDifficulty, { epoch: runEpoch });
      if (!beatBestThisRun) {
        beatBestThisRun = true;
        beep(880, 0.08, "sine", 0.04);
      }
    }
  }

  // Relaxed mode: make the open tick final and apply what it held back.
  function closeGrace() {
    if (!grace) {
      return;
    }
    const { pending } = grace;
    grace = null;
    if (pending.ate) {
      foodEffects();
    }
    if (pending.died) {
      finish();
    }
  }

  // A press can still turn in the cell the head is drawn in: true while a
  // provisional tick is open, applied no turn, and nothing is queued.
  function canTurnRetro() {
    return Boolean(grace) && !grace.turned && turnQueue.length === 0;
  }

  // Replace the open tick: restore the state before it and re-run it with the
  // turn applied in the cell the head was leaving. Collision and food are
  // checked again for the corrected cell; timing and tick count are unchanged.
  function retroTurn(side) {
    const s = grace.snap;
    const from = segmentPosition(0, renderFraction());
    snake = s.snake.map((part) => ({ ...part }));
    direction = s.direction;
    food = { ...s.food };
    score = s.score;
    prevSnake = s.prevSnake;
    eatenFood = s.eatenFood;
    canvas.dataset.head = s.head;
    canvas.dataset.heading = s.heading;
    lastTickTurned = s.lastTickTurned;
    turnQueue = [rotate(direction, side)];
    step({ retro: true });
    retroBlend = reduceMotion ? null : { from, start: performance.now() };
    canvas.dataset.retroTurns = String(Number(canvas.dataset.retroTurns || 0) + 1);
  }

  // Game over (crash) or End game. Either way the run's score is sent to the
  // server (which keeps the player's best) and the board is re-rendered from
  // the server's answer once that save has completed.
  function finish({ ended = false } = {}) {
    grace = null;
    lastTickTurned = false;
    retroBlend = null;
    running = false;
    paused = false;
    gameOver = true;
    turnQueue = [];
    pauseBtn.textContent = "Pause";
    updatePlayState();
    beep(180, ended ? 0.08 : 0.18, "sawtooth", ended ? 0.025 : 0.04);

    const next = "Pick a difficulty and press Start.";
    const detail = beatBestThisRun ? `New best: ${best}. ${next}` : `Score ${score}. ${next}`;
    const what = ended ? "Game ended" : "Game over";
    announce(beatBestThisRun ? `${what}. New best ${best}.` : `${what}. Score ${score}.`);
    setOverlay(ended ? "Game ended" : "Game Over", detail);
    if (beatBestThisRun) {
      overlay.querySelector("p").classList.add("new-best");
    } else {
      overlay.querySelector("p").classList.remove("new-best");
    }
    // A score that failed to save earlier is re-sent now too, always for the
    // player who scored it (queueScore merges it if that's this run's player).
    if (unsavedScore && unsavedScore.name !== runPlayer) {
      queueScore(unsavedScore.name, unsavedScore.score, unsavedScore.difficulty, { final: true, epoch: unsavedScore.epoch });
    }
    queueScore(runPlayer, score, runDifficulty, { final: true, epoch: runEpoch });
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
    const preview = turnPreview();
    publishTurnPreview(preview);
    if (preview) {
      drawTurnCells(preview);
    }

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
    let headPos = segmentPosition(0, t);
    if (retroBlend) {
      // Ease from where the head was drawn before a retroactive turn onto
      // its corrected path, instead of jumping.
      const k = (performance.now() - retroBlend.start) / RETRO_BLEND_MS;
      if (k >= 1 || !running) {
        retroBlend = null;
      } else {
        const e = 1 - (1 - Math.max(0, k)) ** 2;
        headPos = {
          x: retroBlend.from.x + (headPos.x - retroBlend.from.x) * e,
          y: retroBlend.from.y + (headPos.y - retroBlend.from.y) * e
        };
      }
    }
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
    if (preview) {
      drawTurnArrows(preview);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // ---- Turn preview: where a turn takes effect, straight from the game logic.
  // step() applies at most one queued turn per tick and then moves the head
  // from its current cell (snake[0]). So the first queued turn happens in
  // snake[0], the second one cell further along the first new direction, and a
  // turn pressed now happens in the cell after any queued turns (none if the
  // queue is full). Only shown during a run; dimmed while paused.
  function turnPreview() {
    if (!running || gameOver || !snake) {
      return null;
    }
    if (canTurnRetro()) {
      // First half of a provisional tick: a press turns in the cell the head
      // is drawn in (the one the last tick left).
      const c = grace.snap.snake[0];
      return { queued: [], next: { x: c.x, y: c.y }, dim: paused };
    }
    let pos = { x: snake[0].x, y: snake[0].y };
    const queued = turnQueue.map((dir) => {
      const cell = { x: pos.x, y: pos.y, dir };
      pos = { x: pos.x + dir.x, y: pos.y + dir.y };
      return cell;
    });
    const onBoard = (c) => c.x >= 0 && c.x < cols && c.y >= 0 && c.y < rows;
    const next = turnQueue.length < maxQueuedTurns && onBoard(pos) ? pos : null;
    return { queued: queued.filter(onBoard), next, dim: paused };
  }

  // Exposed as data attributes (only when they change) for tests / debugging.
  function publishTurnPreview(preview) {
    const next = preview && preview.next ? `${preview.next.x},${preview.next.y}` : "";
    const queued = preview
      ? preview.queued.map((c) => `${c.x},${c.y},${headingName(c.dir)}`).join(";")
      : "";
    if (canvas.dataset.turnNext !== next) {
      canvas.dataset.turnNext = next;
    }
    if (canvas.dataset.turnQueued !== queued) {
      canvas.dataset.turnQueued = queued;
    }
    // Which highlight layers this frame actually draws ("guide", "marker").
    const layers = [];
    if (preview && display.guide && (preview.next || preview.queued.length)) {
      layers.push("guide");
    }
    if (preview && display.marker && (preview.next || preview.queued.length)) {
      layers.push("marker");
    }
    const drawn = layers.join(" ");
    if (canvas.dataset.turnLayers !== drawn) {
      canvas.dataset.turnLayers = drawn;
    }
  }

  const TURN_RGB = "108, 198, 255";

  function drawTurnCells(preview) {
    const k = drawScale;
    const alpha = preview.dim ? 0.4 : 1;
    const guideCell = preview.next || preview.queued[preview.queued.length - 1];
    ctx.save();
    ctx.globalAlpha = alpha;
    if (guideCell && display.guide) {
      // Faint row + column bands through the cell a turn would happen in.
      ctx.fillStyle = `rgba(${TURN_RGB}, 0.07)`;
      ctx.fillRect(0, guideCell.y * tile, cols * tile, tile);
      ctx.fillRect(guideCell.x * tile, 0, tile, rows * tile);
    }
    const outline = (c, strength) => {
      const inset = 1.5 * k;
      ctx.shadowColor = `rgba(${TURN_RGB}, 0.8)`;
      ctx.shadowBlur = 6 * k;
      ctx.strokeStyle = `rgba(${TURN_RGB}, ${strength})`;
      ctx.lineWidth = Math.max(1.5, 2 * k);
      roundRect(c.x * tile + inset, c.y * tile + inset, tile - inset * 2, tile - inset * 2, 5 * k);
      ctx.stroke();
      ctx.shadowBlur = 0;
    };
    if (!display.marker) {
      ctx.restore();
      return;
    }
    preview.queued.forEach((c) => outline(c, 0.7));
    if (preview.next) {
      ctx.fillStyle = `rgba(${TURN_RGB}, 0.10)`;
      const inset = 1.5 * k;
      roundRect(preview.next.x * tile + inset, preview.next.y * tile + inset,
        tile - inset * 2, tile - inset * 2, 5 * k);
      ctx.fill();
      outline(preview.next, 0.9);
    }
    ctx.restore();
  }

  // Small chevron in each queued turn cell pointing the new direction. Drawn
  // on top of the snake, with a dark under-stroke so it reads on the head too.
  function drawTurnArrows(preview) {
    if (!preview.queued.length || !display.marker) {
      return;
    }
    ctx.save();
    ctx.globalAlpha = preview.dim ? 0.4 : 1;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    preview.queued.forEach((c) => {
      ctx.save();
      ctx.translate((c.x + 0.5) * tile, (c.y + 0.5) * tile);
      ctx.rotate(Math.atan2(c.dir.y, c.dir.x));
      const a = tile * 0.22;
      const shape = () => {
        ctx.beginPath();
        ctx.moveTo(-a, 0);
        ctx.lineTo(a * 0.9, 0);
        ctx.moveTo(a * 0.1, -a * 0.8);
        ctx.lineTo(a * 0.9, 0);
        ctx.lineTo(a * 0.1, a * 0.8);
      };
      ctx.strokeStyle = "rgba(6, 12, 18, 0.75)";
      ctx.lineWidth = Math.max(3, tile * 0.2);
      shape();
      ctx.stroke();
      ctx.strokeStyle = `rgb(${TURN_RGB})`;
      ctx.lineWidth = Math.max(1.5, tile * 0.1);
      shape();
      ctx.stroke();
      ctx.restore();
    });
    ctx.restore();
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
    if (canTurnRetro()) {
      // The drawn head is still in the cell the last tick left.
      retroTurn(side);
      return;
    }
    if (turnQueue.length >= maxQueuedTurns) {
      return;
    }
    turnQueue.push(rotate(lastPlannedDirection(), side));
  }

  function rotate(base, side) {
    return side === "left"
      ? { x: base.y, y: -base.x }
      : { x: -base.y, y: base.x };
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
    const locked = runLocked();
    difficultyEl.disabled = locked;
    // Same for the player name: a run's score belongs to the name it started with.
    nameInput.readOnly = locked;
    nameInput.title = locked ? "End this game to change your name" : "";
    saveNameBtn.disabled = locked || saveInFlight;
    // End game only makes sense while a run is live or paused.
    endBtn.disabled = !locked;
    endBtn.title = locked ? "End this game now" : "No game in progress";
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
