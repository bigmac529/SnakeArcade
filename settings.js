(() => {
  const SETTINGS_KEY = "classic-snake-settings-v1";
  const LEGACY_BEST = "classic-snake-best";
  const LEGACY_MUTE = "classic-snake-muted";

  // PG name filter word list (opaque in source).
  const BLOCKED = JSON.parse(atob("WyJhc3Nob2xlIiwiYXNzd2lwZSIsImJhc3RhcmQiLCJiaXRjaCIsImJvbGxvY2tzIiwiY29jayIsImNyYXAiLCJjdW50IiwiZGFtbiIsImRpY2siLCJkeWtlIiwiZmFnIiwiZmFnZ290IiwiZnVjayIsImZ1Y2tlciIsImZ1Y2tpbmciLCJnb2RkYW1uIiwiaGVsbCIsImphY2thc3MiLCJqaXp6IiwibGVzYmlhbnNleCIsIm1vdGhlcmZ1Y2tlciIsIm5hemkiLCJuaWdnYSIsIm5pZ2dlciIsInBpc3MiLCJwb3JuIiwicHVzc3kiLCJxdWVlciIsInJhcGUiLCJzaGl0Iiwic2x1dCIsInRpdCIsInRpdHMiLCJ0d2F0Iiwid2FuayIsIndob3JlIiwieHh4Il0="));

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

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
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

  function saveSettings(settings) {
    const next = {
      ...defaultSettings(),
      ...settings,
      updatedAt: new Date().toISOString()
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    localStorage.setItem(LEGACY_BEST, String(next.best || 0));
    localStorage.setItem(LEGACY_MUTE, next.muted ? "1" : "0");
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
      return { ok: true, name: "", message: "Playing as Guest." };
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

  function downloadSettings(settings) {
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "snake-settings.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function maybeWriteLocalFile(settings, handle) {
    if (!handle) {
      return null;
    }
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(settings, null, 2));
    await writable.close();
    return handle;
  }

  window.SnakeSettings = {
    SETTINGS_KEY,
    loadSettings,
    saveSettings,
    validatePlayerName,
    downloadSettings,
    maybeWriteLocalFile,
    defaultSettings
  };
})();
