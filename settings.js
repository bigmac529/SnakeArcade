(() => {
  const SETTINGS_KEY = "snake-arcade-settings-v1";
  const LEGACY_SETTINGS_KEY = "classic-snake-settings-v1";
  const LEGACY_BEST = "classic-snake-best";
  const LEGACY_MUTE = "classic-snake-muted";

  // PG name filter word list (opaque in source).
  const BLOCKED = JSON.parse(atob("WyJhc3Nob2xlIiwiYXNzd2lwZSIsImJhc3RhcmQiLCJiaXRjaCIsImJvbGxvY2tzIiwiY29jayIsImNyYXAiLCJjdW50IiwiZGFtbiIsImRpY2siLCJkeWtlIiwiZmFnIiwiZmFnZ290IiwiZnVjayIsImZ1Y2tlciIsImZ1Y2tpbmciLCJnb2RkYW1uIiwiaGVsbCIsImphY2thc3MiLCJqaXp6IiwibGVzYmlhbnNleCIsIm1vdGhlcmZ1Y2tlciIsIm5hemkiLCJuaWdnYSIsIm5pZ2dlciIsInBpc3MiLCJwb3JuIiwicHVzc3kiLCJxdWVlciIsInJhcGUiLCJzaGl0Iiwic2x1dCIsInRpdCIsInRpdHMiLCJ0d2F0Iiwid2FuayIsIndob3JlIiwieHh4Il0="));

  let knownRevision = null;

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
    const next = {
      ...defaultSettings(),
      ...settings
    };
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
        return { ...defaultSettings(), ...JSON.parse(raw) };
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
   * Persist name + mute/pace/best to server.
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
      difficulty: settings.difficulty || "normal",
      best: Number(settings.best || 0)
    };
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

    const next = cacheSettings({
      ...settings,
      ...data,
      playerName: data.playerName || nameCheck.name
    });
    return {
      ok: true,
      status: response.status,
      settings: next,
      revision: data.revision,
      data
    };
  }

  async function fetchPlayers() {
    try {
      const response = await fetch("/api/players");
      if (!response.ok) {
        return { revision: knownRevision, players: [] };
      }
      const data = await response.json();
      if (data && data.revision != null) {
        knownRevision = data.revision;
      }
      return {
        revision: data.revision,
        players: Array.isArray(data.players) ? data.players : []
      };
    } catch (_) {
      return { revision: knownRevision, players: [] };
    }
  }

  async function hydrateFromServer(playerName) {
    try {
      const query = encodeURIComponent(playerName || "");
      const response = await fetch(`/api/settings?player=${query}`);
      if (!response.ok) {
        return loadSettings();
      }
      const serverSettings = await response.json();
      if (serverSettings && serverSettings.revision != null) {
        knownRevision = serverSettings.revision;
      }
      if (!serverSettings || serverSettings._missing || !serverSettings.updatedAt) {
        return loadSettings();
      }

      const local = loadSettings();
      const localEmpty = isLocalEmpty(local);
      const serverTime = Date.parse(serverSettings.updatedAt);
      const localTime = Date.parse(local.updatedAt || 0);
      const serverNewer =
        Number.isFinite(serverTime) && (!Number.isFinite(localTime) || serverTime > localTime);

      if (serverNewer || localEmpty) {
        const merged = {
          ...local,
          ...serverSettings
        };
        delete merged._missing;
        delete merged.revision;
        return writeLocalCache(merged);
      }

      return local;
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
    hydrateFromServer,
    saveToServer,
    fetchPlayers,
    getKnownRevision,
    setKnownRevision
  };
})();
