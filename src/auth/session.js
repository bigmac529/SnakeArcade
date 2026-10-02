"use strict";
// Session cookie + CSRF token helpers.
// - Cookie holds a random id; the database stores only its SHA-256.
// - HttpOnly, SameSite=Lax, Path=/, Secure (and the __Host- prefix) when the
//   site is served over HTTPS.
// - CSRF token = HMAC(SESSION_SECRET, session id). The page reads it from
//   /api/auth/me and sends it as X-CSRF-Token on every signed-in POST.
const crypto = require("crypto");
const { hashToken, newToken, safeEqual } = require("./tokens");

function cookieName(config) {
  return config.cookieSecure ? "__Host-sa_session" : "sa_session";
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      const key = part.slice(0, eq).trim();
      if (!(key in out)) {
        // A malformed value (e.g. "%") must not throw: one request with a bad
        // Cookie header used to crash the whole process. Skip that cookie.
        try {
          out[key] = decodeURIComponent(part.slice(eq + 1).trim());
        } catch {
          // ignored: treated as absent (signed out)
        }
      }
    }
  }
  return out;
}

function serializeCookie(config, value, maxAgeSeconds) {
  const parts = [`${cookieName(config)}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`];
  if (config.cookieSecure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function csrfFor(config, sessionId) {
  return crypto.createHmac("sha256", config.sessionSecret).update("csrf:" + sessionId).digest("base64url");
}

function checkCsrf(config, sessionId, header) {
  return Boolean(sessionId && header) && safeEqual(csrfFor(config, sessionId), header);
}

module.exports = { cookieName, parseCookies, serializeCookie, csrfFor, checkCsrf, hashToken, newToken };
