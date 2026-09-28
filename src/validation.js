"use strict";
// Input validation shared by the API routes: display names (PG filter),
// emails, passwords and difficulty names.

// PG filter word list (base64 so the words don't appear in the source).
const BLOCKED = JSON.parse(Buffer.from("WyJhc3Nob2xlIiwiYXNzd2lwZSIsImJhc3RhcmQiLCJiaXRjaCIsImJvbGxvY2tzIiwiY29jayIsImNyYXAiLCJjdW50IiwiZGFtbiIsImRpY2siLCJkeWtlIiwiZmFnIiwiZmFnZ290IiwiZnVjayIsImZ1Y2tlciIsImZ1Y2tpbmciLCJnb2RkYW1uIiwiaGVsbCIsImphY2thc3MiLCJqaXp6IiwibGVzYmlhbnNleCIsIm1vdGhlcmZ1Y2tlciIsIm5hemkiLCJuaWdnYSIsIm5pZ2dlciIsInBpc3MiLCJwb3JuIiwicHVzc3kiLCJxdWVlciIsInJhcGUiLCJzaGl0Iiwic2x1dCIsInRpdCIsInRpdHMiLCJ0d2F0Iiwid2FuayIsIndob3JlIiwieHh4Il0=", "base64").toString("utf8"));

const NAME_MAX = 24;
const EMAIL_MAX = 254;
const PASSWORD_MIN = 10;
const PASSWORD_MAX = 200;

function compact(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function cleanName(name) {
  return String(name || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NAME_MAX);
}

// Same rules as before accounts: 2-24 characters, letters, numbers, spaces
// and . _ ' - only, and nothing on the PG list (also when squashed together).
function validateDisplayName(name) {
  const cleaned = cleanName(name);
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
      return { ok: false, name: cleaned, message: "That name isn't PG enough for this portfolio site. Try another." };
    }
  }
  return { ok: true, name: cleaned, message: "" };
}

// Case-insensitive uniqueness key for display names.
function displayNameKey(name) {
  return cleanName(name).toLowerCase();
}

function normalizeEmail(email) {
  const cleaned = String(email || "").trim();
  return { email: cleaned, key: cleaned.toLowerCase() };
}

function validateEmail(email) {
  const { email: cleaned, key } = normalizeEmail(email);
  if (!cleaned || cleaned.length > EMAIL_MAX || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) {
    return { ok: false, email: cleaned, key, message: "Enter a valid email address." };
  }
  return { ok: true, email: cleaned, key, message: "" };
}

function validatePassword(password, { email = "" } = {}) {
  const value = typeof password === "string" ? password : "";
  if (value.length < PASSWORD_MIN) {
    return { ok: false, message: `Use at least ${PASSWORD_MIN} characters for your password.` };
  }
  if (value.length > PASSWORD_MAX) {
    return { ok: false, message: `Use at most ${PASSWORD_MAX} characters for your password.` };
  }
  if (email && value.trim().toLowerCase() === String(email).trim().toLowerCase()) {
    return { ok: false, message: "Your password can't be your email address." };
  }
  return { ok: true, message: "" };
}

const DIFFICULTIES = ["easy", "normal", "hard"];
// "fast" is the old name of "hard". Returns null for anything unknown.
function normalizeDifficulty(value) {
  const v = String(value || "").toLowerCase();
  if (v === "fast") {
    return "hard";
  }
  return DIFFICULTIES.includes(v) ? v : null;
}

// Emails never go to the logs in full: "m***@example.com".
function maskEmail(email) {
  const [user, domain] = String(email || "").split("@");
  if (!domain) {
    return "***";
  }
  return `${user.slice(0, 1)}***@${domain}`;
}

module.exports = {
  NAME_MAX,
  EMAIL_MAX,
  PASSWORD_MIN,
  PASSWORD_MAX,
  validateDisplayName,
  displayNameKey,
  validateEmail,
  normalizeEmail,
  validatePassword,
  normalizeDifficulty,
  maskEmail,
  cleanName
};
