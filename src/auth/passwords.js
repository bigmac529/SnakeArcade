"use strict";
// Password hashing with Node's built-in scrypt (memory-hard, no native deps).
// Stored as "scrypt$N$r$p$salt$hash" (base64url), so parameters can be raised
// later and old hashes still verify.
const crypto = require("crypto");
const { promisify } = require("util");

const scrypt = promisify(crypto.scrypt);
const PARAMS = { N: 32768, r: 8, p: 1 };
const KEYLEN = 32;
const MAXMEM = 64 * 1024 * 1024;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(String(password).normalize("NFKC"), salt, KEYLEN, { ...PARAMS, maxmem: MAXMEM });
  return ["scrypt", PARAMS.N, PARAMS.r, PARAMS.p, salt.toString("base64url"), hash.toString("base64url")].join("$");
}

async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }
  const [, N, r, p, saltText, hashText] = parts;
  const expected = Buffer.from(hashText, "base64url");
  const actual = await scrypt(String(password).normalize("NFKC"), Buffer.from(saltText, "base64url"), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: MAXMEM
  });
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// Used when the email is unknown, so a failed sign-in takes the same time
// whether or not the account exists.
let dummyHash = null;
async function burnPasswordCheck(password) {
  if (!dummyHash) {
    dummyHash = await hashPassword("not-a-real-password-" + crypto.randomBytes(8).toString("hex"));
  }
  await verifyPassword(password, dummyHash);
  return false;
}

module.exports = { hashPassword, verifyPassword, burnPasswordCheck };
