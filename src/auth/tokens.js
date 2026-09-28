"use strict";
// Random secrets (session ids, email links). Only their SHA-256 is stored, so
// a database leak can't be replayed as live sessions or links.
const crypto = require("crypto");

const newToken = () => crypto.randomBytes(32).toString("base64url");
const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");
const looksLikeToken = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{40,64}$/.test(value);

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = { newToken, hashToken, looksLikeToken, safeEqual };
