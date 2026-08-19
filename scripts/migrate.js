// One-time (and re-runnable) schema setup for the loans table.
//
// Usage:
//   node scripts/migrate.js
//
// Reads its connection string from DATABASE_URL / POSTGRES_URL in the
// environment. Locally, run `vercel env pull .env` first (or export the
// vars yourself) — see .env.example.
"use strict";

try {
  require("dotenv").config();
} catch {
  // dotenv is optional; envs may already be set (e.g. `vercel dev`, CI).
}

const { Pool } = require("pg");

function connectionString() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL (or POSTGRES_URL) is not set. Run `vercel env pull .env` " +
        "or export it yourself before running this script."
    );
  }
  return url;
}

async function main() {
  const cs = connectionString();
  const pool = new Pool({
    connectionString: cs,
    ssl: /localhost|127\.0\.0\.1/.test(cs) ? false : { rejectUnauthorized: false },
  });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS loans (
        id SERIAL PRIMARY KEY,
        data JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    console.log("✓ loans table is ready.");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS loan_payments (
        id SERIAL PRIMARY KEY,
        loan_id INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
        paid_on DATE NOT NULL,
        principal NUMERIC NOT NULL DEFAULT 0,
        interest NUMERIC NOT NULL DEFAULT 0,
        note TEXT,
        balance_after NUMERIC,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS loan_payments_loan_id_idx ON loan_payments (loan_id);
    `);
    console.log("✓ loan_payments table is ready.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
