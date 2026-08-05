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
const { listLoans, createLoan, updateLoan, deleteLoan } = require("./lib/loans");

const app = express();
app.disable("x-powered-by");
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: "1mb" }));

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
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@600;700&family=Hanken+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root { color-scheme: light; }
  *{ box-sizing: border-box; }
  body {
    font-family: 'Hanken Grotesk', -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    background: #F4F6F2;
    color: #1C211E;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0;
  }
  main {
    background: #FFFFFF;
    border-radius: 14px;
    border-top: 5px solid #1A9E36;
    padding: 2.25rem 2.25rem 2.5rem;
    width: min(90vw, 360px);
    box-shadow: 0 10px 40px rgba(28, 33, 30, 0.12);
  }
  .brand { display: flex; align-items: center; gap: 9px; margin-bottom: 6px; }
  .tri {
    width: 0; height: 0; flex: none;
    border-left: 11px solid #1A9E36;
    border-top: 7px solid transparent;
    border-bottom: 7px solid transparent;
  }
  .brand h1 {
    font-family: 'Bricolage Grotesque', sans-serif;
    font-weight: 700;
    font-size: 1.35rem;
    letter-spacing: 0.02em;
    margin: 0;
    color: #1C211E;
  }
  .sub {
    font-size: 0.72rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: #6C736A;
    margin: 0 0 1.75rem;
    padding-bottom: 1.25rem;
    border-bottom: 1px solid #DEE2DA;
  }
  label {
    display: block;
    font-weight: 600;
    font-size: 0.85rem;
    margin-bottom: 0.4rem;
    color: #1C211E;
  }
  input[type="password"] {
    width: 100%;
    padding: 0.7rem 0.8rem;
    border-radius: 8px;
    border: 1.5px solid #1A9E36;
    background: #FFFFFF;
    color: #1C211E;
    font-size: 1rem;
    font-family: inherit;
    margin-bottom: 1.25rem;
  }
  input[type="password"]:focus {
    outline: none;
    border-color: #0F7A28;
    box-shadow: 0 0 0 3px #EAF4EB;
  }
  button {
    width: 100%;
    padding: 0.8rem;
    border-radius: 8px;
    border: none;
    background: #0F7A28;
    color: white;
    font-size: 1rem;
    font-weight: 700;
    cursor: pointer;
  }
  button:hover { background: #0c621f; }
  .error {
    color: #b3261e;
    background: #fbeceb;
    border: 1px solid #f3c9c6;
    border-radius: 8px;
    padding: 0.6rem 0.75rem;
    font-size: 0.85rem;
    margin: -0.5rem 0 1rem;
    text-align: center;
  }
</style>
</head>
<body>
<main>
  <div class="brand">
    <div class="tri"></div>
    <h1>TRIANGLE</h1>
  </div>
  <p class="sub">Investment Group &middot; Loan Database</p>
  <form method="POST" action="/login">
    ${errorHtml}
    <label for="passcode">Passcode</label>
    <input type="password" id="passcode" name="passcode" autofocus required autocomplete="off">
    <button type="submit">Enter</button>
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

// Loan portfolio API — reads from and writes to the Neon Postgres database.
// Sits behind the session-cookie gate above, same as the static site.
app.get("/api/loans", async (req, res, next) => {
  try {
    res.json(await listLoans());
  } catch (err) {
    next(err);
  }
});

app.post("/api/loans", async (req, res, next) => {
  try {
    const loan = await createLoan(req.body || {});
    res.status(201).json(loan);
  } catch (err) {
    next(err);
  }
});

app.put("/api/loans/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "Invalid loan id" });
    }
    const loan = await updateLoan(id, req.body || {});
    if (!loan) return res.status(404).json({ error: "Loan not found" });
    res.json(loan);
  } catch (err) {
    next(err);
  }
});

app.delete("/api/loans/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "Invalid loan id" });
    }
    const ok = await deleteLoan(id);
    if (!ok) return res.status(404).json({ error: "Loan not found" });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
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
