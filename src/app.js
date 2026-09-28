"use strict";
// HTTP layer: security middleware, account/auth routes, scores, leaderboard.
// Only the public/ folder is served as static files (never data/, the source
// or scripts).
const express = require("express");
const helmet = require("helmet");
const V = require("./validation");
const { hashPassword, verifyPassword, burnPasswordCheck } = require("./auth/passwords");
const { newToken, hashToken, looksLikeToken } = require("./auth/tokens");
const { cookieName, parseCookies, serializeCookie, csrfFor, checkCsrf } = require("./auth/session");
const { createRateLimiter } = require("./auth/rateLimit");
const { verificationEmail, resetEmail } = require("./mail");

const MAX_SCORE = 10000000;
const HOUR = 3600 * 1000;
const SESSION_TOUCH_MS = HOUR;

function createApp({ config, store, mailer, db, log = console }) {
  const app = express();
  const limiter = createRateLimiter();
  const sessionMs = config.sessionDays * 24 * HOUR;
  const cookie = cookieName(config);

  app.disable("x-powered-by");
  // Behind IIS/ARR (and Cloudflare) the client address arrives in headers.
  app.set("trust proxy", config.trustProxy ? true : false);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", "data:"],
          fontSrc: ["'self'"],
          connectSrc: ["'self'"],
          mediaSrc: ["'self'", "data:", "blob:"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"]
        }
      },
      referrerPolicy: { policy: "no-referrer" },
      // HTTPS is terminated by IIS; only claim HSTS when the site is https.
      strictTransportSecurity: config.cookieSecure ? { maxAge: 15552000, includeSubDomains: false } : false,
      crossOriginEmbedderPolicy: false
    })
  );

  // SMTP errors can quote the recipient ("550 <x@y.com> rejected"): mask any address.
  function scrubEmails(text) {
    return String(text || "").replace(/[^\s<>"'(),;:]+@[^\s<>"'(),;:]+/g, (m) => V.maskEmail(m));
  }

  function clientIp(req) {
    if (config.trustProxy) {
      const cf = req.get("cf-connecting-ip");
      if (cf) {
        return cf.trim();
      }
    }
    return req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
  }

  const allowedOrigins = new Set([config.publicOrigin, ...config.allowedOrigins]);
  if (!config.production) {
    allowedOrigins.add(`http://localhost:${config.port}`);
    allowedOrigins.add(`http://127.0.0.1:${config.port}`);
  }
  function requestOrigin(req) {
    const origin = req.get("origin");
    if (origin) {
      return origin;
    }
    const referer = req.get("referer");
    if (referer) {
      try {
        return new URL(referer).origin;
      } catch {
        return "";
      }
    }
    return "";
  }

  const send = (res, status, body) => res.status(status).json(body);
  const fail = (res, status, error, message, extra = {}) => send(res, status, { ok: false, error, message, ...extra });

  // --- /api basics: no caching, same-origin JSON only for writes (CSRF layer 1)
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      return next();
    }
    if (!allowedOrigins.has(requestOrigin(req))) {
      return fail(res, 403, "bad_origin", "This request must come from the SnakeArcade page.");
    }
    if (!req.is("application/json")) {
      return fail(res, 415, "json_required", "Send JSON.");
    }
    return next();
  });
  app.use("/api", express.json({ limit: "10kb", strict: true }));
  app.use("/api", (err, _req, res, next) => {
    if (err) {
      return fail(res, err.status === 413 ? 413 : 400, err.status === 413 ? "too_large" : "bad_json", "Request body is invalid.");
    }
    return next();
  });

  // --- session lookup (cookie -> sha256 -> sessions row)
  function setSessionCookie(res, sessionId) {
    res.append("Set-Cookie", serializeCookie(config, sessionId, Math.floor(sessionMs / 1000)));
  }
  function clearSessionCookie(res) {
    res.append("Set-Cookie", serializeCookie(config, "", 0));
  }

  app.use("/api", async (req, _res, next) => {
    req.auth = null;
    const sid = parseCookies(req.get("cookie"))[cookie];
    if (!sid || !looksLikeToken(sid)) {
      return next();
    }
    try {
      const idHash = hashToken(sid);
      const found = await store.findSession(idHash);
      if (found) {
        req.auth = { sessionId: sid, idHash, user: found.user };
        const now = Date.now();
        if (now - found.lastSeenAt > SESSION_TOUCH_MS) {
          // Sliding expiry: refresh at most hourly.
          await store.touchSession(idHash, now, now + sessionMs);
          setSessionCookie(_res, sid);
        }
      }
      return next();
    } catch (err) {
      return next(err);
    }
  });

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // Signed-in routes: session required (401) + CSRF token (403, layer 2).
  function requireSession(req, res, next) {
    if (!req.auth) {
      return fail(res, 401, "signed_out", "Sign in to do that.");
    }
    if (!checkCsrf(config, req.auth.sessionId, req.get("x-csrf-token"))) {
      return fail(res, 403, "csrf_failed", "Your session check failed. Reload the page and try again.");
    }
    return next();
  }
  function requireVerified(req, res, next) {
    if (!req.auth.user.verified) {
      return fail(res, 403, "email_unverified", "Confirm your email first. Check your inbox for the link.");
    }
    return next();
  }

  function presentUser(user) {
    return {
      id: user.id,
      displayName: user.displayName,
      email: user.email, // only ever sent to the account's own session
      verified: user.verified,
      best: user.best,
      bestDifficulty: user.bestDifficulty || null,
      scoreEpoch: user.scoreEpoch
    };
  }
  function mePayload(sessionId, user) {
    return { ok: true, signedIn: true, csrfToken: csrfFor(config, sessionId), user: presentUser(user) };
  }

  async function startSession(res, userId) {
    const sessionId = newToken();
    const now = Date.now();
    await store.createSession({ idHash: hashToken(sessionId), userId, now, expiresAt: now + sessionMs });
    setSessionCookie(res, sessionId);
    return sessionId;
  }

  async function sendVerification(user) {
    const token = newToken();
    const now = Date.now();
    await store.createEmailToken({ tokenHash: hashToken(token), userId: user.id, purpose: "verify", now, expiresAt: now + config.tokens.verifyHours * HOUR });
    const link = `${config.publicBaseUrl}/?verify=${token}`;
    await mailer.send({ to: user.email, ...verificationEmail({ displayName: user.displayName, link, hours: config.tokens.verifyHours }) });
  }

  function rateLimited(res, result, message) {
    res.set("Retry-After", String(result.retryAfterSeconds));
    return fail(res, 429, "rate_limited", message, { retryAfterSeconds: result.retryAfterSeconds });
  }

  // --- health
  app.get(
    "/api/health",
    wrap(async (_req, res) => {
      let dbOk = false;
      try {
        await db.ping();
        dbOk = true;
      } catch (err) {
        log.error("health: database ping failed:", err && err.message);
      }
      send(res, dbOk ? 200 : 503, {
        ok: dbOk,
        app: "SnakeArcade",
        node: process.version,
        port: config.port,
        db: db.dialect,
        mail: mailer.mode,
        time: new Date().toISOString()
      });
    })
  );

  // --- who am I
  app.get("/api/auth/me", (req, res) => {
    if (!req.auth) {
      return send(res, 200, { ok: true, signedIn: false });
    }
    return send(res, 200, mePayload(req.auth.sessionId, req.auth.user));
  });

  // --- sign up (session starts right away, unverified until the link is used)
  app.post(
    "/api/auth/signup",
    wrap(async (req, res) => {
      const body = req.body || {};
      const email = V.validateEmail(body.email);
      if (!email.ok) {
        return fail(res, 400, "email_invalid", email.message, { field: "email" });
      }
      const name = V.validateDisplayName(body.displayName);
      if (!name.ok) {
        return fail(res, 400, "displayName_rejected", name.message, { field: "displayName" });
      }
      const password = V.validatePassword(body.password, { email: email.email });
      if (!password.ok) {
        return fail(res, 400, "password_invalid", password.message, { field: "password" });
      }
      const limit = limiter.hit(`signup:${clientIp(req)}`, config.limits.signupPerHourPerIp, HOUR);
      if (!limit.ok) {
        return rateLimited(res, limit, "Too many sign-ups from here. Try again later.");
      }
      let user;
      try {
        user = await store.createUser({
          email: email.email,
          emailKey: email.key,
          passwordHash: await hashPassword(body.password),
          displayName: name.name,
          displayNameKey: V.displayNameKey(name.name)
        });
      } catch (err) {
        if (err instanceof store.Conflict) {
          const field = err.code === "email_taken" ? "email" : "displayName";
          const message = err.code === "email_taken" ? "An account with this email already exists. Sign in instead, or use Forgot password." : err.message;
          return fail(res, 409, err.code, message, { field });
        }
        throw err;
      }
      log.log(`[auth] signup ${V.maskEmail(user.email)}`);
      const sessionId = await startSession(res, user.id);
      let mailSent = true;
      try {
        await sendVerification(user);
      } catch (err) {
        mailSent = false;
        log.error(`[mail] verification email to ${V.maskEmail(user.email)} failed:`, scrubEmails(err && err.message));
      }
      return send(res, 201, { ...mePayload(sessionId, user), mailSent });
    })
  );

  // --- confirm email (the link opens the page, the page POSTs the token, so
  // mail scanners that prefetch GET links can't use it up)
  app.post(
    "/api/auth/verify",
    wrap(async (req, res) => {
      const token = (req.body || {}).token;
      if (!looksLikeToken(token)) {
        return fail(res, 400, "token_invalid", "This confirmation link isn't valid.");
      }
      const userId = await store.consumeEmailToken(hashToken(token), "verify");
      if (!userId) {
        return fail(res, 400, "token_invalid", "This confirmation link has expired or was already used. Sign in and choose Resend email.");
      }
      await store.markVerified(userId);
      const user = await store.findUserById(userId);
      log.log(`[auth] verified ${V.maskEmail(user.email)}`);
      const sameUser = req.auth && req.auth.user.id === userId;
      return send(res, 200, sameUser ? { ...mePayload(req.auth.sessionId, user), verified: true } : { ok: true, verified: true, signedIn: Boolean(req.auth) });
    })
  );

  app.post(
    "/api/auth/resend-verification",
    requireSession,
    wrap(async (req, res) => {
      const user = req.auth.user;
      if (user.verified) {
        return send(res, 200, { ok: true, alreadyVerified: true });
      }
      const now = Date.now();
      const day = await store.emailTokenStats(user.id, "verify", now - 24 * HOUR);
      const cooldownMs = config.limits.resendCooldownSeconds * 1000;
      if (day.lastAt && now - day.lastAt < cooldownMs) {
        return rateLimited(res, { retryAfterSeconds: Math.ceil((cooldownMs - (now - day.lastAt)) / 1000) }, "Email just sent. Wait a minute before asking again.");
      }
      if (day.count >= config.limits.resendPerDay) {
        return rateLimited(res, { retryAfterSeconds: 3600 }, "That's enough emails for today. Check your spam folder, or try again tomorrow.");
      }
      try {
        await sendVerification(user);
      } catch (err) {
        log.error(`[mail] verification email to ${V.maskEmail(user.email)} failed:`, scrubEmails(err && err.message));
        return fail(res, 502, "mail_failed", "Couldn't send the email right now. Try again in a few minutes.");
      }
      return send(res, 200, { ok: true, sent: true });
    })
  );

  // --- sign in (one generic error for unknown email and wrong password)
  app.post(
    "/api/auth/login",
    wrap(async (req, res) => {
      const body = req.body || {};
      const { key } = V.normalizeEmail(body.email);
      const password = typeof body.password === "string" ? body.password : "";
      if (!key || !password || key.length > V.EMAIL_MAX || password.length > V.PASSWORD_MAX) {
        return fail(res, 400, "login_failed", "Email or password is incorrect.");
      }
      const ipLimit = limiter.hit(`login-ip:${clientIp(req)}`, config.limits.loginPer15MinPerIp, 15 * 60 * 1000);
      const accountLimit = ipLimit.ok ? limiter.hit(`login:${key}`, config.limits.loginPer15MinPerAccount, 15 * 60 * 1000) : ipLimit;
      if (!ipLimit.ok || !accountLimit.ok) {
        return rateLimited(res, ipLimit.ok ? accountLimit : ipLimit, "Too many sign-in attempts. Wait a few minutes and try again.");
      }
      const user = await store.findUserByEmailKey(key);
      const good = user ? await verifyPassword(password, user.passwordHash) : await burnPasswordCheck(password);
      if (!good) {
        return fail(res, 401, "login_failed", "Email or password is incorrect.");
      }
      limiter.reset(`login:${key}`);
      const sessionId = await startSession(res, user.id);
      log.log(`[auth] login ${V.maskEmail(user.email)}`);
      return send(res, 200, mePayload(sessionId, user));
    })
  );

  app.post(
    "/api/auth/logout",
    wrap(async (req, res) => {
      if (req.auth) {
        if (!checkCsrf(config, req.auth.sessionId, req.get("x-csrf-token"))) {
          return fail(res, 403, "csrf_failed", "Your session check failed. Reload the page and try again.");
        }
        await store.deleteSession(req.auth.idHash);
      }
      clearSessionCookie(res);
      return send(res, 200, { ok: true, signedIn: false });
    })
  );

  // --- forgot / reset password. Always the same answer, and the email goes
  // out in the background, so it can't reveal whether an account exists.
  app.post(
    "/api/auth/forgot",
    wrap(async (req, res) => {
      const email = V.validateEmail((req.body || {}).email);
      if (!email.ok) {
        return fail(res, 400, "email_invalid", email.message, { field: "email" });
      }
      const limit = limiter.hit(`forgot-ip:${clientIp(req)}`, config.limits.forgotPerHourPerIp, HOUR);
      if (!limit.ok) {
        return rateLimited(res, limit, "Too many requests. Try again later.");
      }
      const generic = { ok: true, message: "If that email has an account, a reset link is on its way. It expires in " + config.tokens.resetMinutes + " minutes." };
      (async () => {
        const user = await store.findUserByEmailKey(email.key);
        if (!user) {
          return;
        }
        const now = Date.now();
        const recent = await store.emailTokenStats(user.id, "reset", now - HOUR);
        if (recent.count >= config.limits.forgotPerHourPerAccount) {
          return;
        }
        const token = newToken();
        await store.createEmailToken({ tokenHash: hashToken(token), userId: user.id, purpose: "reset", now, expiresAt: now + config.tokens.resetMinutes * 60 * 1000 });
        await mailer.send({
          to: user.email,
          ...resetEmail({ displayName: user.displayName, link: `${config.publicBaseUrl}/?reset=${token}`, minutes: config.tokens.resetMinutes })
        });
      })().catch((err) => log.error(`[mail] reset email for ${V.maskEmail(email.email)} failed:`, scrubEmails(err && err.message)));
      return send(res, 200, generic);
    })
  );

  app.post(
    "/api/auth/reset",
    wrap(async (req, res) => {
      const body = req.body || {};
      if (!looksLikeToken(body.token)) {
        return fail(res, 400, "token_invalid", "This reset link isn't valid.");
      }
      const tokenHash = hashToken(body.token);
      const peekId = await store.peekEmailToken(tokenHash, "reset");
      if (!peekId) {
        return fail(res, 400, "token_invalid", "This reset link has expired or was already used. Ask for a new one with Forgot password.");
      }
      const owner = await store.findUserById(peekId);
      const password = V.validatePassword(body.password, { email: owner ? owner.email : "" });
      if (!password.ok) {
        return fail(res, 400, "password_invalid", password.message, { field: "password" });
      }
      const userId = await store.consumeEmailToken(tokenHash, "reset");
      if (!userId) {
        return fail(res, 400, "token_invalid", "This reset link has expired or was already used. Ask for a new one with Forgot password.");
      }
      await store.setPasswordHash(userId, await hashPassword(body.password));
      // The link proved the mailbox, so the email counts as confirmed. Every
      // other session is signed out; this browser gets a fresh one.
      await store.markVerified(userId);
      await store.deleteUserSessions(userId);
      const sessionId = await startSession(res, userId);
      const user = await store.findUserById(userId);
      log.log(`[auth] password reset ${V.maskEmail(user.email)}`);
      return send(res, 200, mePayload(sessionId, user));
    })
  );

  // --- edit display name (best score stays with the account)
  app.post(
    "/api/account/name",
    requireSession,
    wrap(async (req, res) => {
      const name = V.validateDisplayName((req.body || {}).displayName);
      if (!name.ok) {
        return fail(res, 400, "displayName_rejected", name.message, { field: "displayName" });
      }
      let user;
      try {
        user = await store.setDisplayName(req.auth.user.id, name.name, V.displayNameKey(name.name));
      } catch (err) {
        if (err instanceof store.Conflict) {
          return fail(res, 409, err.code, err.message, { field: "displayName" });
        }
        throw err;
      }
      const board = await store.board({ viewerId: user.id });
      return send(res, 200, { ...mePayload(req.auth.sessionId, user), ...board });
    })
  );

  // --- public leaderboard (no auth; display names only, never emails)
  app.get(
    "/api/players",
    wrap(async (req, res) => {
      const board = await store.board({ viewerId: req.auth && req.auth.user.verified ? req.auth.user.id : null });
      return send(res, 200, board);
    })
  );

  function scorePlayer(user) {
    return { playerName: user.displayName, best: user.best, bestDifficulty: user.bestDifficulty || undefined, scoreEpoch: user.scoreEpoch };
  }

  // --- record a score for the signed-in, verified account. The player is
  // always the session's account; any name or id in the body is ignored.
  app.post(
    "/api/score",
    requireSession,
    requireVerified,
    wrap(async (req, res) => {
      const body = req.body || {};
      const score = Number(body.score);
      if (!Number.isInteger(score) || score < 0 || score > MAX_SCORE) {
        return fail(res, 400, "score_invalid", "Score must be a whole number.");
      }
      const difficulty = V.normalizeDifficulty(body.difficulty);
      const epoch = body.epoch != null && body.epoch !== "" ? Number(body.epoch) : null;
      const userId = req.auth.user.id;
      // Guard, not identity: the page says which account its run started
      // under; if this browser has since switched accounts, refuse rather
      // than credit the score to whoever is signed in now.
      if (body.runAccount != null && String(body.runAccount) !== userId) {
        return fail(res, 409, "account_changed", "You signed in as someone else since that run, so its score wasn't saved.");
      }
      const result = await store.submitScore(userId, score, difficulty, epoch);
      const user = await store.findUserById(userId);
      const board = await store.board({ viewerId: userId });
      return send(res, 200, { ok: true, improved: result.improved, stale: result.stale, score, player: scorePlayer(user), ...board });
    })
  );

  // --- reset the signed-in account's best (Settings > Reset best score)
  app.post(
    "/api/reset-best",
    requireSession,
    wrap(async (req, res) => {
      const userId = req.auth.user.id;
      const result = await store.resetBest(userId);
      const user = await store.findUserById(userId);
      const board = await store.board({ viewerId: userId });
      return send(res, 200, { ok: true, found: true, previousBest: result.previousBest, player: scorePlayer(user), ...board });
    })
  );

  app.use("/api", (_req, res) => fail(res, 404, "not_found", "Unknown API route."));

  // --- static site: public/ only
  app.use(express.static(config.publicDir, { index: "index.html", dotfiles: "ignore", redirect: false }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    log.error(`[error] ${req.method} ${req.path}:`, err && (err.stack || err.message));
    if (res.headersSent) {
      return;
    }
    if (req.path.startsWith("/api")) {
      return fail(res, 500, "server_error", "Something went wrong on the server. Try again.");
    }
    return res.status(500).send("Server error");
  });

  return app;
}

module.exports = { createApp };
