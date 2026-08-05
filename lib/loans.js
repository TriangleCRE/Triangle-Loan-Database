// Data access layer for the `loans` table. Each row stores its free-form
// fields in a JSONB column (the loan portfolio has a long tail of optional,
// inconsistently-present fields — a JSONB payload keeps every field from the
// original hard-coded dataset intact without a sprawling, mostly-null
// column list) plus a stable integer id used by the REST API.
"use strict";

const { getPool } = require("./db");

function rowToLoan(row) {
  return { id: row.id, ...row.data };
}

async function listLoans() {
  const { rows } = await getPool().query(
    "SELECT id, data FROM loans ORDER BY id ASC"
  );
  return rows.map(rowToLoan);
}

async function getLoan(id) {
  const { rows } = await getPool().query(
    "SELECT id, data FROM loans WHERE id = $1",
    [id]
  );
  return rows[0] ? rowToLoan(rows[0]) : null;
}

async function createLoan(fields) {
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
  const { rowCount } = await getPool().query(
    "DELETE FROM loans WHERE id = $1",
    [id]
  );
  return rowCount > 0;
}

module.exports = { listLoans, getLoan, createLoan, updateLoan, deleteLoan };
