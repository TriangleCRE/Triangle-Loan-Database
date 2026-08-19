// Data access layer for the `loan_payments` table — the record of actual
// principal/interest payments applied to a loan. Recording a payment is the
// one manual step: it deducts the principal portion from the loan's stored
// balance in the same transaction, so the balance shown on the loan stays
// current without anyone re-uploading a spreadsheet.
"use strict";

const { getPool } = require("./db");

// Self-healing setup, same pattern as lib/loans.js: create the table on
// first use so a fresh database (or one that predates this feature) just
// works without a manual migration step.
let readyPromise = null;
async function ensureReady() {
  if (!readyPromise) {
    readyPromise = (async () => {
      const pool = getPool();
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
    })();
    readyPromise.catch(() => {
      readyPromise = null;
    });
  }
  return readyPromise;
}

function rowToPayment(row) {
  return {
    id: row.id,
    loanId: row.loan_id,
    paidOn: row.paid_on,
    principal: row.principal == null ? 0 : Number(row.principal),
    interest: row.interest == null ? 0 : Number(row.interest),
    note: row.note,
    balanceAfter: row.balance_after == null ? null : Number(row.balance_after),
    createdAt: row.created_at,
  };
}

async function listPayments(loanId) {
  await ensureReady();
  const { rows } = await getPool().query(
    `SELECT id, loan_id, paid_on::text AS paid_on, principal, interest, note,
            balance_after, created_at
     FROM loan_payments WHERE loan_id = $1
     ORDER BY paid_on ASC, id ASC`,
    [loanId]
  );
  return rows.map(rowToPayment);
}

// Inserts a payment row and deducts its principal from the loan's balance,
// atomically. Returns { loan, payment } or null if the loan doesn't exist.
async function recordPayment(loanId, { paidOn, principal, interest, note }) {
  await ensureReady();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: loanRows } = await client.query(
      "SELECT id, data FROM loans WHERE id = $1 FOR UPDATE",
      [loanId]
    );
    if (!loanRows[0]) {
      await client.query("ROLLBACK");
      return null;
    }
    const loan = loanRows[0];
    const currentBalance = typeof loan.data.balance === "number" ? loan.data.balance : 0;
    const p = Number(principal) || 0;
    const i = Number(interest) || 0;
    const newBalance = Math.round((currentBalance - p) * 100) / 100;
    const newData = { ...loan.data, balance: newBalance };
    await client.query(
      "UPDATE loans SET data = $2::jsonb, updated_at = now() WHERE id = $1",
      [loanId, JSON.stringify(newData)]
    );
    const { rows: payRows } = await client.query(
      `INSERT INTO loan_payments (loan_id, paid_on, principal, interest, note, balance_after)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, loan_id, paid_on::text AS paid_on, principal, interest, note,
                 balance_after, created_at`,
      [loanId, paidOn, p, i, note || null, newBalance]
    );
    await client.query("COMMIT");
    return { loan: { id: loan.id, ...newData }, payment: rowToPayment(payRows[0]) };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Deleting a payment only makes sense for a loan's single most-recent entry
// — that's the only case where "undo" unambiguously restores the balance to
// what it was before. Returns { loan } on success, { error: "not_latest" }
// if paymentId isn't the latest payment on file, or null if either id
// doesn't exist.
async function deleteLatestPayment(loanId, paymentId) {
  await ensureReady();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: latestRows } = await client.query(
      `SELECT id, principal FROM loan_payments
       WHERE loan_id = $1 ORDER BY paid_on DESC, id DESC LIMIT 1`,
      [loanId]
    );
    if (!latestRows[0]) {
      await client.query("ROLLBACK");
      return null;
    }
    if (latestRows[0].id !== paymentId) {
      await client.query("ROLLBACK");
      return { error: "not_latest" };
    }
    const { rows: loanRows } = await client.query(
      "SELECT id, data FROM loans WHERE id = $1 FOR UPDATE",
      [loanId]
    );
    if (!loanRows[0]) {
      await client.query("ROLLBACK");
      return null;
    }
    const loan = loanRows[0];
    const currentBalance = typeof loan.data.balance === "number" ? loan.data.balance : 0;
    const restoredBalance =
      Math.round((currentBalance + Number(latestRows[0].principal)) * 100) / 100;
    const newData = { ...loan.data, balance: restoredBalance };
    await client.query(
      "UPDATE loans SET data = $2::jsonb, updated_at = now() WHERE id = $1",
      [loanId, JSON.stringify(newData)]
    );
    await client.query("DELETE FROM loan_payments WHERE id = $1", [paymentId]);
    await client.query("COMMIT");
    return { loan: { id: loan.id, ...newData } };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { listPayments, recordPayment, deleteLatestPayment };
