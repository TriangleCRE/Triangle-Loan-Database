// Single Express app that fronts the entire site: it serves the login
// screen, verifies the shared passcode, and — for every other route —
// gates access behind a signed session cookie before falling through to
// the static site. Deployed on Vercel as one serverless function (see
// vercel.json) so no route can bypass this gate.
"use strict";

const path = require("node:path");
const express = require("express");
const {
  MAX_AGE_MS,
  COOKIE_NAME,
  checkPasscode,
  makeSessionCookieValue,
  isValidSessionCookie,
  parseCookies,
} = require("./lib/auth");

const app = express();
app.disable("x-powered-by");
app.use(express.urlencoded({ extended: false }));

const PUBLIC_DIR = path.join(__dirname, "public");

function isSecureRequest(req) {
  if (req.secure) return true;
  const proto = req.headers["x-forwarded-proto"];
  return typeof proto === "string" && proto.split(",")[0].trim() === "https";
}

function setSessionCookie(req, res) {
  res.cookie(COOKIE_NAME, makeSessionCookieValue(), {
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: "lax",
    maxAge: MAX_AGE_MS,
    path: "/",
  });
}

function renderLogin({ error } = {}) {
  const errorHtml = error
    ? `<p class="error">Incorrect passcode. Please try again.</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in — Triangle Loan Database</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    background: #0f172a;
    color: #e2e8f0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0;
  }
  main {
    background: #1e293b;
    border-radius: 12px;
    padding: 2.5rem;
    width: min(90vw, 360px);
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.35);
  }
  h1 { font-size: 1.25rem; margin: 0 0 1.5rem; text-align: center; }
  input[type="password"] {
    width: 100%;
    box-sizing: border-box;
    padding: 0.75rem;
    border-radius: 8px;
    border: 1px solid #334155;
    background: #0f172a;
    color: #e2e8f0;
    font-size: 1rem;
    margin-bottom: 1rem;
  }
  button {
    width: 100%;
    padding: 0.75rem;
    border-radius: 8px;
    border: none;
    background: #2563eb;
    color: white;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
  }
  button:hover { background: #1d4ed8; }
  .error {
    color: #f87171;
    font-size: 0.9rem;
    margin: -0.5rem 0 1rem;
    text-align: center;
  }
</style>
</head>
<body>
<main>
  <h1>Enter passcode</h1>
  <form method="POST" action="/login">
    ${errorHtml}
    <input type="password" name="passcode" placeholder="Passcode" autofocus required autocomplete="off">
    <button type="submit">Continue</button>
  </form>
</main>
</body>
</html>
`;
}

// Public: crawlers should stay out entirely.
app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send("User-agent: *\nDisallow: /\n");
});

// Public: the login page itself.
app.get("/login", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  if (isValidSessionCookie(cookies[COOKIE_NAME])) {
    return res.redirect(302, "/");
  }
  res.type("html").send(renderLogin());
});

// Public: the only endpoint that verifies the passcode.
app.post("/login", (req, res) => {
  const passcode = req.body && req.body.passcode;
  if (checkPasscode(passcode)) {
    setSessionCookie(req, res);
    return res.redirect(302, "/");
  }
  res.status(401).type("html").send(renderLogin({ error: true }));
});

// Everything below this line — pages, static assets, and any future API
// routes alike — requires a valid session cookie.
app.use((req, res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  if (isValidSessionCookie(cookies[COOKIE_NAME])) {
    setSessionCookie(req, res); // slide the 30-day expiry forward
    return next();
  }
  if (req.method === "GET" || req.method === "HEAD") {
    if (req.accepts(["html", "json"]) === "json") {
      return res.status(401).json({ error: "Unauthorized" });
    }
    return res.redirect(302, "/login");
  }
  res.status(401).type("text").send("Unauthorized");
});

app.use(express.static(PUBLIC_DIR));

app.use((req, res) => {
  res.status(404).type("text").send("Not found");
});

// Centralized error handler so a misconfiguration (e.g. missing PASSCODE)
// never leaks a stack trace to the client.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).type("text").send("Server error");
});

module.exports = app;
