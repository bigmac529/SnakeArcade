// Browser-side data helpers: local preferences (sound, difficulty), the
// arcade board, and score saves / resets for the signed-in account (through
// window.SnakeAccount.api, which adds the CSRF token).
(() => {
  const SETTINGS_KEY = "snake-arcade-settings-v1";
  const LEGACY_SETTINGS_KEY = "classic-snake-settings-v1";
  const LEGACY_MUTE = "classic-snake-muted";

  // PG name filter word list (opaque in source). Same rules as the server;
  // used for instant feedback in the name fields.
  const BLOCKED = JSON.parse(atob("WyJhc3Nob2xlIiwiYXNzd2lwZSIsImJhc3RhcmQiLCJiaXRjaCIsImJvbGxvY2tzIiwiY29jayIsImNyYXAiLCJjdW50IiwiZGFtbiIsImRpY2siLCJkeWtlIiwiZmFnIiwiZmFnZ290IiwiZnVjayIsImZ1Y2tlciIsImZ1Y2tpbmciLCJnb2RkYW1uIiwiaGVsbCIsImphY2thc3MiLCJqaXp6IiwibGVzYmlhbnNleCIsIm1vdGhlcmZ1Y2tlciIsIm5hemkiLCJuaWdnYSIsIm5pZ2dlciIsInBpc3MiLCJwb3JuIiwicHVzc3kiLCJxdWVlciIsInJhcGUiLCJzaGl0Iiwic2x1dCIsInRpdCIsInRpdHMiLCJ0d2F0Iiwid2FuayIsIndob3JlIiwieHh4Il0="));

  let knownRevision = null;
  const DIFFICULTIES = ["easy", "normal", "hard"];

  // "fast" was the top option of the old Pace control; it is now "hard".
  function normalizeDifficulty(value) {
    const v = String(value || "").toLowerCase();
    if (v === "fast") {
      return "hard";
    }
    return DIFFICULTIES.includes(v) ? v : "normal";
  }

  // Sound and difficulty are per browser. (Names and best scores live on the
  // account now; older caches' playerName / best fields are ignored.)
  // Storage can be blocked (privacy settings, sandboxed frames): even reading
  // window.localStorage then throws. Never let that stop the game.
  function storageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  function loadPrefs() {
    let raw = null;
    try {
      raw = JSON.parse(storageGet(SETTINGS_KEY) || storageGet(LEGACY_SETTINGS_KEY) || "null");
    } catch (_) {
      raw = null;
    }
    return {
      muted: raw ? Boolean(raw.muted) : storageGet(LEGACY_MUTE) === "1",
      difficulty: normalizeDifficulty(raw && raw.difficulty)
    };
  }

  function savePrefs(patch) {
    const next = { ...loadPrefs(), ...patch };
    next.difficulty = normalizeDifficulty(next.difficulty);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ version: 2, muted: Boolean(next.muted), difficulty: next.difficulty }));
      localStorage.setItem(LEGACY_MUTE, next.muted ? "1" : "0");
      localStorage.removeItem("classic-snake-best");
    } catch (_) {
      /* storage full / blocked: applies for this page only */
    }
    return next;
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
      return { ok: false, name: "", message: "Enter a display name (2+ characters)." };
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
        return { ok: false, name: cleaned, message: "That name isn’t PG enough for this portfolio site. Try another." };
      }
    }
    return { ok: true, name: cleaned, message: "" };
  }

  function noteRevision(rev) {
    if (rev != null && (knownRevision == null || rev > knownRevision)) {
      knownRevision = rev;
    }
  }

  // API GETs must never come from a cache (the live IIS/ARR proxy once kept
  // identical GETs for about a minute); account.js adds a unique query string.
  async function fetchPlayers() {
    const res = await window.SnakeAccount.api("GET", "/api/players");
    if (res.status === 0) {
      return { ok: false, revision: knownRevision, players: [], message: "The arcade board did not load (network error)." };
    }
    if (!res.ok) {
      return { ok: false, revision: knownRevision, players: [], message: `The arcade board did not load (HTTP ${res.status}).` };
    }
    noteRevision(res.data.revision);
    return { ok: true, revision: res.data.revision, players: Array.isArray(res.data.players) ? res.data.players : [] };
  }

  /**
   * Record a run's score for the signed-in account (the server takes the
   * player from the session). runAccount is the account id the run started
   * under: the server refuses the score if this browser has switched
   * accounts since. Resolves { ok, improved, stale, player, players,
   * revision } or { ok: false, status, error, message, retryable }.
   */
  async function submitScore(score, difficulty, epoch, runAccount) {
    const res = await window.SnakeAccount.api("POST", "/api/score", {
      score: Math.max(0, Math.floor(Number(score) || 0)),
      difficulty: normalizeDifficulty(difficulty),
      ...(Number.isFinite(Number(epoch)) && epoch !== null ? { epoch: Number(epoch) } : {}),
      ...(runAccount ? { runAccount } : {})
    });
    const data = res.data || {};
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: data.error || "save_failed",
        message: data.message || `Server error (HTTP ${res.status}).`,
        // Network errors, 5xx, 408 and 429 may work on a retry.
        retryable: res.status === 0 || res.status >= 500 || res.status === 408 || res.status === 429
      };
    }
    noteRevision(data.revision);
    return {
      ok: true,
      improved: Boolean(data.improved),
      stale: Boolean(data.stale),
      player: data.player || null,
      players: Array.isArray(data.players) ? data.players : [],
      revision: data.revision
    };
  }

  // Reset the signed-in account's best to 0 (and take it off the board).
  async function resetBestOnServer() {
    const res = await window.SnakeAccount.api("POST", "/api/reset-best", {});
    const data = res.data || {};
    if (!res.ok) {
      return { ok: false, status: res.status, error: data.error || "reset_failed", message: data.message || `Server error (HTTP ${res.status}).` };
    }
    noteRevision(data.revision);
    return {
      ok: true,
      previousBest: Number(data.previousBest || 0),
      player: data.player || null,
      players: Array.isArray(data.players) ? data.players : [],
      revision: data.revision
    };
  }

  window.SnakeSettings = {
    SETTINGS_KEY,
    loadPrefs,
    savePrefs,
    validatePlayerName,
    normalizeDifficulty,
    submitScore,
    resetBestOnServer,
    fetchPlayers,
    getKnownRevision: () => knownRevision
  };
})();
