// Shared-passcode auth: no accounts, no session store. The session cookie
// itself is the credential — it is a timestamp plus an HMAC of that
// timestamp, keyed off PASSCODE. Verifying it is pure computation (no
// lookup), and changing PASSCODE invalidates every outstanding cookie.
"use strict";

const crypto = require("node:crypto");

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, sliding
const COOKIE_NAME = "session";

function secret() {
  const passcode = process.env.PASSCODE;
  if (!passcode) {
    throw new Error("PASSCODE environment variable is not set");
  }
  return passcode;
}

function hmac(input) {
  return crypto.createHmac("sha256", secret()).update(input).digest("base64url");
}

// Timing-safe comparison for arbitrary-length strings: hash both sides to a
// fixed length first so timingSafeEqual never throws on a length mismatch
// (which would itself leak information via which error path is taken).
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return ha.length === hb.length && crypto.timingSafeEqual(ha, hb);
}

function checkPasscode(candidate) {
  return typeof candidate === "string" && candidate.length > 0 && safeEqual(candidate, secret());
}

function makeSessionCookieValue() {
  const payload = String(Date.now());
  return `${payload}.${hmac(payload)}`;
}

function isValidSessionCookie(value) {
  if (!value || !value.includes(".")) return false;
  const i = value.lastIndexOf(".");
  const payload = value.slice(0, i);
  const sig = value.slice(i + 1);
  if (!safeEqual(sig, hmac(payload))) return false;
  const issuedAt = Number(payload);
  return Number.isFinite(issuedAt) && Date.now() - issuedAt < MAX_AGE_MS;
}

// Minimal Cookie-header parser so we don't need a body of dependencies just
// to read one cookie back.
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

module.exports = {
  MAX_AGE_MS,
  COOKIE_NAME,
  checkPasscode,
  makeSessionCookieValue,
  isValidSessionCookie,
  parseCookies,
};
