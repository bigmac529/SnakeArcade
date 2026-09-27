(() => {
  const SETTINGS_KEY = "snake-arcade-settings-v1";
  const LEGACY_SETTINGS_KEY = "classic-snake-settings-v1";
  const LEGACY_BEST = "classic-snake-best";
  const LEGACY_MUTE = "classic-snake-muted";

  // PG name filter word list (opaque in source).
  const BLOCKED = JSON.parse(atob("WyJhc3Nob2xlIiwiYXNzd2lwZSIsImJhc3RhcmQiLCJiaXRjaCIsImJvbGxvY2tzIiwiY29jayIsImNyYXAiLCJjdW50IiwiZGFtbiIsImRpY2siLCJkeWtlIiwiZmFnIiwiZmFnZ290IiwiZnVjayIsImZ1Y2tlciIsImZ1Y2tpbmciLCJnb2RkYW1uIiwiaGVsbCIsImphY2thc3MiLCJqaXp6IiwibGVzYmlhbnNleCIsIm1vdGhlcmZ1Y2tlciIsIm5hemkiLCJuaWdnYSIsIm5pZ2dlciIsInBpc3MiLCJwb3JuIiwicHVzc3kiLCJxdWVlciIsInJhcGUiLCJzaGl0Iiwic2x1dCIsInRpdCIsInRpdHMiLCJ0d2F0Iiwid2FuayIsIndob3JlIiwieHh4Il0="));

  let knownRevision = null;

  const DIFFICULTIES = ["easy", "normal", "hard"];

  // "fast" was the top option of the old Pace control; it is now "hard".
  // Anything unknown falls back to "normal".
  function normalizeDifficulty(value) {
    const v = String(value || "").toLowerCase();
    if (v === "fast") {
      return "hard";
    }
    return DIFFICULTIES.includes(v) ? v : "normal";
  }

  function normalizeBestDifficulty(value) {
    const v = String(value || "").toLowerCase();
    if (v === "fast") {
      return "hard";
    }
    return DIFFICULTIES.includes(v) ? v : undefined;
  }

  function normalizeStored(settings) {
    const next = { ...settings, difficulty: normalizeDifficulty(settings.difficulty) };
    const bestDifficulty = normalizeBestDifficulty(settings.bestDifficulty);
    if (bestDifficulty) {
      next.bestDifficulty = bestDifficulty;
    } else {
      delete next.bestDifficulty;
    }
    return next;
  }

  function defaultSettings() {
    return {
      version: 1,
      playerName: "",
      muted: false,
      difficulty: "normal",
      best: 0,
      updatedAt: new Date().toISOString()
    };
  }

  function writeLocalCache(settings) {
    const next = normalizeStored({
      ...defaultSettings(),
      ...settings
    });
    if (!next.updatedAt) {
      next.updatedAt = new Date().toISOString();
    }
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    localStorage.setItem(LEGACY_BEST, String(next.best || 0));
    localStorage.setItem(LEGACY_MUTE, next.muted ? "1" : "0");
    return next;
  }

  function loadSettings() {
    try {
      let raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) {
        raw = localStorage.getItem(LEGACY_SETTINGS_KEY);
      }
      if (raw) {
        return normalizeStored({ ...defaultSettings(), ...JSON.parse(raw) });
      }
    } catch (_) {
      /* fall through */
    }

    const settings = defaultSettings();
    const legacyBest = Number(localStorage.getItem(LEGACY_BEST) || 0);
    if (legacyBest) {
      settings.best = legacyBest;
    }
    if (localStorage.getItem(LEGACY_MUTE) === "1") {
      settings.muted = true;
    }
    return settings;
  }

  function isLocalEmpty(settings) {
    if (!settings) {
      return true;
    }
    const hasName = Boolean(settings.playerName);
    const hasBest = Number(settings.best || 0) > 0;
    const hasMute = Boolean(settings.muted);
    const hasCustomDifficulty = settings.difficulty && settings.difficulty !== "normal";
    return !hasName && !hasBest && !hasMute && !hasCustomDifficulty;
  }

  function normalizeName(name) {
    return String(name || "")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 24);
  }

  function compact(value) {
    return value.toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function validatePlayerName(name) {
    const cleaned = normalizeName(name);
    if (!cleaned) {
      return { ok: false, name: "", message: "Enter a player name (2+ characters)." };
    }
    if (cleaned.length < 2) {
      return { ok: false, name: cleaned, message: "Name needs at least 2 characters." };
    }
    if (!/^[\p{L}\p{N} .'_-]+$/u.test(cleaned)) {
      return { ok: false, name: cleaned, message: "Use letters, numbers, spaces, . _ ' - only." };
    }

    const mashed = compact(cleaned);
    for (const word of BLOCKED) {
      if (mashed.includes(compact(word))) {
        return {
          ok: false,
          name: cleaned,
          message: "That name isn’t PG enough for this portfolio site. Try another."
        };
      }
    }

    return { ok: true, name: cleaned, message: `Playing as ${cleaned}.` };
  }

  function cacheSettings(incoming) {
    const current = loadSettings();
    const merged = {
      ...defaultSettings(),
      ...current,
      ...incoming
    };
    const nameCheck = validatePlayerName(merged.playerName);
    if (!nameCheck.ok) {
      // Keep the last accepted name; never write a blocked string.
      const fallback = validatePlayerName(current.playerName);
      merged.playerName = fallback.ok ? fallback.name : "";
    } else {
      merged.playerName = nameCheck.name;
    }

    return writeLocalCache({
      ...merged,
      updatedAt: new Date().toISOString()
    });
  }

  async function parseJsonResponse(response) {
    const text = await response.text();
    try {
      return text ? JSON.parse(text) : {};
    } catch (_) {
      return { raw: text };
    }
  }

  async function putSettingsOnce(payload) {
    const response = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await parseJsonResponse(response);
    if (data && data.revision != null) {
      knownRevision = data.revision;
    }
    return { response, data };
  }

  /**
   * Persist name + mute/difficulty to server (never the best score).
   * options.force — overwrite/claim existing name
   * options.baseRevision — optimistic concurrency token
   * Retries once on lock_busy.
   */
  async function saveToServer(settings, options = {}) {
    const nameCheck = validatePlayerName(settings.playerName);
    if (!nameCheck.ok) {
      return {
        ok: false,
        status: 400,
        error: "playerName_rejected",
        message: nameCheck.message
      };
    }

    const payload = {
      playerName: nameCheck.name,
      muted: Boolean(settings.muted),
      difficulty: normalizeDifficulty(settings.difficulty)
    };
    // Never send the best score: scores only reach the server through
    // submitScore, for runs actually played under a name. (Sending the local
    // best here used to copy it to a newly saved name.)
    if (options.force) {
      payload.force = true;
    }
    if (options.baseRevision != null && Number.isFinite(Number(options.baseRevision))) {
      payload.baseRevision = Number(options.baseRevision);
    } else if (knownRevision != null) {
      payload.baseRevision = knownRevision;
    }

    let { response, data } = await putSettingsOnce(payload);

    if (response.status === 409 && data && data.error === "lock_busy") {
      await new Promise((r) => setTimeout(r, 60 + Math.floor(Math.random() * 120)));
      const retryPayload = { ...payload };
      if (data.revision != null) {
        retryPayload.baseRevision = data.revision;
        knownRevision = data.revision;
      }
      ({ response, data } = await putSettingsOnce(retryPayload));
    }

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: (data && data.error) || "save_failed",
        message:
          (data && data.message) ||
          (response.status === 409
            ? "Could not save — arcade board conflict."
            : "Could not save name to server."),
        existing: data && data.existing,
        revision: data && data.revision,
        data
      };
    }

    // The best (and its difficulty tag) always come from the server record
    // for this name: 0 for a new name, the name's own best for an existing one.
    const record = { ...data };
    delete record.ok;
    delete record.revision;
    const next = cacheSettings({
      ...settings,
      ...record,
      playerName: data.playerName || nameCheck.name,
      best: Number(data.best || 0),
      bestDifficulty: normalizeBestDifficulty(data.bestDifficulty)
    });
    return {
      ok: true,
      status: response.status,
      settings: next,
      revision: data.revision,
      data
    };
  }

  // API GETs must never come from a cache: the live IIS/ARR proxy kept
  // identical GETs for about a minute, so after a game over the board could
  // show a copy from before the run. The server now sends no-store; the
  // unique query string makes sure of it for any proxy in between.
  let freshSeq = 0;
  function freshUrl(path) {
    const sep = path.includes("?") ? "&" : "?";
    freshSeq += 1;
    return `${path}${sep}_=${Date.now().toString(36)}.${freshSeq}`;
  }

  async function fetchPlayers() {
    try {
      const response = await fetch(freshUrl("/api/players"), { cache: "no-store" });
      if (!response.ok) {
        return {
          ok: false,
          revision: knownRevision,
          players: [],
          message: `The arcade board did not load (HTTP ${response.status}).`
        };
      }
      const data = await response.json();
      if (data && data.revision != null) {
        knownRevision = data.revision;
      }
      return {
        ok: true,
        revision: data.revision,
        players: Array.isArray(data.players) ? data.players : []
      };
    } catch (_) {
      return {
        ok: false,
        revision: knownRevision,
        players: [],
        message: "The arcade board did not load (network error)."
      };
    }
  }

  /**
   * Record a run's score for a player. The server keeps the higher of this
   * and the stored best (order-independent, repeat-safe) and answers with
   * the player's record and the whole board.
   * Resolves { ok, improved, player, players, revision } or
   * { ok: false, status, error, message, retryable }. Never throws.
   */
  async function submitScore(playerName, score, difficulty, epoch) {
    const nameCheck = validatePlayerName(playerName);
    if (!nameCheck.ok) {
      return { ok: false, status: 400, error: "playerName_rejected", message: nameCheck.message, retryable: false };
    }
    let response;
    let data;
    try {
      response = await fetch("/api/score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          playerName: nameCheck.name,
          score: Math.max(0, Math.floor(Number(score) || 0)),
          difficulty: normalizeDifficulty(difficulty),
          // Score epoch the run started under; the server ignores scores from
          // before a Reset best score.
          ...(Number.isFinite(Number(epoch)) && epoch !== null ? { epoch: Number(epoch) } : {})
        })
      });
      data = await parseJsonResponse(response);
    } catch (_) {
      return { ok: false, status: 0, error: "network", message: "Network error.", retryable: true };
    }
    if (!response.ok || !data || data.ok !== true) {
      return {
        ok: false,
        status: response.status,
        error: (data && data.error) || "save_failed",
        message: (data && data.message) || `Server error (HTTP ${response.status}).`,
        // 4xx other than 408/429 won't succeed on a retry.
        retryable: response.status >= 500 || response.status === 408 || response.status === 429
      };
    }
    if (data.revision != null && (knownRevision == null || data.revision > knownRevision)) {
      knownRevision = data.revision;
    }
    return {
      ok: true,
      improved: Boolean(data.improved),
      stale: Boolean(data.stale),
      player: data.player || null,
      players: Array.isArray(data.players) ? data.players : [],
      revision: data.revision
    };
  }

  /**
   * Reset one player's best to 0 on the server (and drop them from the board).
   * Resolves { ok, found, previousBest, player, players, revision } or
   * { ok: false, status, error, message }. Never throws.
   */
  async function resetBestOnServer(playerName) {
    const nameCheck = validatePlayerName(playerName);
    if (!nameCheck.ok) {
      return { ok: false, status: 400, error: "playerName_rejected", message: nameCheck.message };
    }
    let response;
    let data;
    try {
      response = await fetch("/api/reset-best", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ playerName: nameCheck.name })
      });
      data = await parseJsonResponse(response);
    } catch (_) {
      return { ok: false, status: 0, error: "network", message: "Network error." };
    }
    if (!response.ok || !data || data.ok !== true) {
      return {
        ok: false,
        status: response.status,
        error: (data && data.error) || "reset_failed",
        message: (data && data.message) || `Server error (HTTP ${response.status}).`
      };
    }
    if (data.revision != null && (knownRevision == null || data.revision > knownRevision)) {
      knownRevision = data.revision;
    }
    return {
      ok: true,
      found: Boolean(data.found),
      previousBest: Number(data.previousBest || 0),
      player: data.player || null,
      players: Array.isArray(data.players) ? data.players : [],
      revision: data.revision
    };
  }

  // Best score to 0 in every local key (current cache, legacy cache and the
  // legacy best key), without touching the name or other preferences.
  function resetLocalBest() {
    try {
      const legacyRaw = localStorage.getItem(LEGACY_SETTINGS_KEY);
      if (legacyRaw) {
        const legacy = JSON.parse(legacyRaw);
        if (legacy && typeof legacy === "object") {
          legacy.best = 0;
          delete legacy.bestDifficulty;
          localStorage.setItem(LEGACY_SETTINGS_KEY, JSON.stringify(legacy));
        }
      }
    } catch (_) {
      localStorage.removeItem(LEGACY_SETTINGS_KEY);
    }
    const next = writeLocalCache({ ...loadSettings(), best: 0, bestDifficulty: undefined, updatedAt: new Date().toISOString() });
    localStorage.setItem(LEGACY_BEST, "0");
    return next;
  }

  async function hydrateFromServer(playerName) {
    try {
      const query = encodeURIComponent(playerName || "");
      const response = await fetch(freshUrl(`/api/settings?player=${query}`), { cache: "no-store" });
      if (!response.ok) {
        return loadSettings();
      }
      const serverSettings = await response.json();
      if (serverSettings && serverSettings.revision != null) {
        knownRevision = serverSettings.revision;
      }
      const local = loadSettings();
      if (!serverSettings) {
        return local;
      }
      if (serverSettings._missing || !serverSettings.updatedAt) {
        // This name has no record on the server, so it has no best yet (the
        // cached best may be left over from another name).
        if (!normalizeName(playerName) || (!Number(local.best || 0) && !local.bestDifficulty)) {
          return local;
        }
        return writeLocalCache({ ...local, best: 0, bestDifficulty: undefined });
      }

      const localEmpty = isLocalEmpty(local);
      const serverTime = Date.parse(serverSettings.updatedAt);
      const localTime = Date.parse(local.updatedAt || 0);
      const serverNewer =
        Number.isFinite(serverTime) && (!Number.isFinite(localTime) || serverTime > localTime);

      const base = serverNewer || localEmpty ? { ...local, ...serverSettings } : { ...local };
      delete base._missing;
      delete base.revision;
      // The best always comes from the server: every score is saved there,
      // and the cached one may belong to a different name.
      return writeLocalCache({
        ...base,
        best: Number(serverSettings.best || 0),
        bestDifficulty: normalizeBestDifficulty(serverSettings.bestDifficulty)
      });
    } catch (_) {
      return loadSettings();
    }
  }

  function getKnownRevision() {
    return knownRevision;
  }

  function setKnownRevision(rev) {
    if (rev != null && Number.isFinite(Number(rev))) {
      knownRevision = Number(rev);
    }
  }

  window.SnakeSettings = {
    SETTINGS_KEY,
    loadSettings,
    saveSettings: cacheSettings,
    cacheSettings,
    validatePlayerName,
    defaultSettings,
    normalizeDifficulty,
    hydrateFromServer,
    saveToServer,
    submitScore,
    resetBestOnServer,
    resetLocalBest,
    fetchPlayers,
    getKnownRevision,
    setKnownRevision
  };
})();
