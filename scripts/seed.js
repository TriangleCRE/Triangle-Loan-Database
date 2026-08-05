// Loads data/loans.seed.json (the data that used to be hard-coded in
// public/index.html) into the loans table. Safe to re-run: existing ids are
// upserted rather than duplicated.
//
// Usage:
//   node scripts/migrate.js   # create the table first, if needed
//   node scripts/seed.js
"use strict";

try {
  require("dotenv").config();
} catch {
  // dotenv is optional; envs may already be set (e.g. `vercel dev`, CI).
}

const path = require("node:path");
const { Pool } = require("pg");
const loans = require(path.join(__dirname, "..", "data", "loans.seed.json"));

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
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const loan of loans) {
      const { id, ...fields } = loan;
      await client.query(
        `INSERT INTO loans (id, data)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [id, JSON.stringify(fields)]
      );
    }
    // Keep the id sequence ahead of the seeded ids so future inserts don't collide.
    await client.query(
      `SELECT setval(pg_get_serial_sequence('loans', 'id'), (SELECT COALESCE(MAX(id), 1) FROM loans))`
    );
    await client.query("COMMIT");
    console.log(`✓ Seeded ${loans.length} loans.`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
