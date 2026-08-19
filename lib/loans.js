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

// Ids below this are reserved for records that come from data/loans.seed.json
// (currently in the low hundreds at most). Keeping manually-created loans'
// ids well above it means a future spreadsheet sync — which assigns new
// records the next id after the seed file's current highest — can never
// land on an id a manually-added loan already claimed and silently
// overwrite it. Bumping the sequence here is cheap and idempotent; it's a
// no-op once the sequence has already passed this floor.
const MANUAL_LOAN_ID_FLOOR = 100000;

async function createLoan(fields) {
  await ensureReady();
  const pool = getPool();
  const { id, ...data } = fields || {};
  await pool.query(
    `SELECT setval(pg_get_serial_sequence('loans', 'id'),
       GREATEST($1, (SELECT COALESCE(MAX(id), 0) FROM loans)))`,
    [MANUAL_LOAN_ID_FLOOR]
  );
  const { rows } = await pool.query(
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

// Re-applies data/loans.seed.json — the file this repo's PRs update whenever
// a new spreadsheet comes in — to a database that already has real rows.
// Unlike ensureReady()'s one-time seed, this runs on demand (from the "Sync
// from Spreadsheet" button) so a spreadsheet-driven update can go live
// without anyone touching the database directly. It's an upsert by id, same
// as scripts/seed.js: existing loans get their fields replaced with the
// seed's version, loans in the seed that don't exist yet get inserted, and
// nothing not in the seed is ever touched or deleted — so loans added
// through the app are left alone.
//
// One exception: a loan's balance, once the payment tracker has recorded
// any payment against it, is no longer the spreadsheet's to set — otherwise
// re-syncing would silently erase what those payments paid down (the
// payment history rows themselves are never touched either way, but the
// balance they moved would get overwritten back to the spreadsheet's
// snapshot). For those loans this keeps the live balance and updates every
// other field from the seed as normal.
async function syncFromSeed() {
  await ensureReady();
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Guard for a database that has never had a payment recorded yet (so
    // lib/payments.js's own lazy table creation hasn't run).
    await client.query(`
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
    const { rows: existingRows } = await client.query("SELECT id, data FROM loans");
    const existingById = new Map(existingRows.map((r) => [r.id, r.data]));
    const { rows: paidRows } = await client.query(
      "SELECT DISTINCT loan_id FROM loan_payments"
    );
    const loanIdsWithPayments = new Set(paidRows.map((r) => r.loan_id));
    let inserted = 0;
    let updated = 0;
    let balancePreserved = 0;
    for (const loan of seedLoans) {
      const { id, ...fields } = loan;
      const existingData = existingById.get(id);
      if (existingData) {
        updated++;
        if (loanIdsWithPayments.has(id) && typeof existingData.balance === "number") {
          fields.balance = existingData.balance;
          balancePreserved++;
        }
      } else {
        inserted++;
      }
      await client.query(
        `INSERT INTO loans (id, data) VALUES ($1, $2::jsonb)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [id, JSON.stringify(fields)]
      );
    }
    await client.query(
      `SELECT setval(pg_get_serial_sequence('loans', 'id'), (SELECT COALESCE(MAX(id), 1) FROM loans))`
    );
    await client.query("COMMIT");
    return { total: seedLoans.length, inserted, updated, balancePreserved };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  listLoans,
  getLoan,
  createLoan,
  updateLoan,
  deleteLoan,
  syncFromSeed,
};
