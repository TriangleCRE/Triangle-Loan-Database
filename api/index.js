// Vercel serverless function entrypoint. vercel.json routes every request
// (pages, static assets, and any API routes alike) to this single function,
// which is the same gated Express app used for local dev.
"use strict";

module.exports = require("../app");
