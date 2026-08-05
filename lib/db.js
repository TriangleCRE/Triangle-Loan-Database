// Shared Postgres connection pool. Reads the connection string from the
// environment variables Vercel's Neon integration provisions automatically
// (DATABASE_URL, falling back to POSTGRES_URL) — no credentials are ever
// hard-coded here.
"use strict";

const { Pool } = require("pg");

let pool = null;

function connectionString() {
  const url =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL;
  if (!url) {
    throw new Error(
      "No database connection string found. Set DATABASE_URL (or POSTGRES_URL) " +
        "in the environment — Vercel's Neon integration adds this automatically."
    );
  }
  return url;
}

// Neon requires TLS. Skip only for an explicit local, non-TLS Postgres.
function sslConfig(url) {
  if (/localhost|127\.0\.0\.1/.test(url)) return false;
  return { rejectUnauthorized: false };
}

function getPool() {
  if (!pool) {
    const cs = connectionString();
    pool = new Pool({ connectionString: cs, ssl: sslConfig(cs) });
  }
  return pool;
}

module.exports = { getPool };
