// Data access layer for the `loans` table. Each row stores its free-form
// fields in a JSONB column (the loan portfolio has a long tail of optional,
// inconsistently-present fields — a JSONB payload keeps every field from the
// original hard-coded dataset intact without a sprawling, mostly-null
// column list) plus a stable integer id used by the REST API.
"use strict";

const { getPool } = require("./db");
const seedLoans = require("../data/loans.seed.json");

// Self-healing setup: the very first query against a fresh database creates
// the table and — only if it's completely empty — loads the original
// portfolio from data/loans.seed.json. This means a deploy against a brand
// new (or not-yet-migrated) Postgres database never shows up as "all the
// data disappeared"; running scripts/migrate.js + scripts/seed.js by hand is
// still fine (and idempotent) but is no longer required for the site to work.
// Once a single real loan exists, this never touches the table again, so it
// can't clobber anyone's edits.
let readyPromise = null;
async function ensureReady() {
  if (!readyPromise) {
    readyPromise = (async () => {
      const pool = getPool();
      await pool.query(`
        CREATE TABLE IF NOT EXISTS loans (
          id SERIAL PRIMARY KEY,
          data JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM loans");
      if (rows[0].n === 0) {
        for (const loan of seedLoans) {
          const { id, ...fields } = loan;
          await pool.query(
            `INSERT INTO loans (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO NOTHING`,
            [id, JSON.stringify(fields)]
          );
        }
        await pool.query(
          `SELECT setval(pg_get_serial_sequence('loans', 'id'), (SELECT COALESCE(MAX(id), 1) FROM loans))`
        );
      }
    })();
    readyPromise.catch(() => {
      readyPromise = null; // let the next request retry instead of caching a failure forever
    });
  }
  return readyPromise;
}

function rowToLoan(row) {
  return { id: row.id, ...row.data };
}

async function listLoans() {
  await ensureReady();
  const { rows } = await getPool().query(
    "SELECT id, data FROM loans ORDER BY id ASC"
  );
  return rows.map(rowToLoan);
}

async function getLoan(id) {
  await ensureReady();
  const { rows } = await getPool().query(
    "SELECT id, data FROM loans WHERE id = $1",
    [id]
  );
  return rows[0] ? rowToLoan(rows[0]) : null;
}

async function createLoan(fields) {
  await ensureReady();
  const { id, ...data } = fields || {};
  const { rows } = await getPool().query(
    "INSERT INTO loans (data) VALUES ($1::jsonb) RETURNING id, data",
    [JSON.stringify(data)]
  );
  return rowToLoan(rows[0]);
}

// Full-replace update: the incoming fields become the loan's entire record
// (minus id), matching how the front end submits the edit form.
async function updateLoan(id, fields) {
  await ensureReady();
  const { id: _ignored, ...data } = fields || {};
  const { rows } = await getPool().query(
    `UPDATE loans SET data = $2::jsonb, updated_at = now()
     WHERE id = $1
     RETURNING id, data`,
    [id, JSON.stringify(data)]
  );
  return rows[0] ? rowToLoan(rows[0]) : null;
}

async function deleteLoan(id) {
  await ensureReady();
  const { rowCount } = await getPool().query(
    "DELETE FROM loans WHERE id = $1",
    [id]
  );
  return rowCount > 0;
}

module.exports = { listLoans, getLoan, createLoan, updateLoan, deleteLoan };
