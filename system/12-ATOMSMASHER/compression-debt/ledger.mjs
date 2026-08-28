// compression-debt/ledger.mjs
//
// AtomSmasher module #7 — Compression Debt Ledger.
//
// Tracks every time the system chose verbose over compressed. Paying the debt
// means re-execution (or a later pass with a real codec) actually produced
// the compressed form. Forgiveness is the rare operator-stamped write-off
// when the verbose form turned out to be load-bearing on inspection.
//
// Doctrine (Mom's Law applied to compression):
//   - Recording a debt is the honest move. The verbose form was emitted; the
//     ledger admits it. Hiding the choice would be theater.
//   - Paying a debt is the recovery move. The ledger stamps the realized
//     compressed_chars and savings_chars so the system learns which surfaces
//     accumulate the most debt and which actually pay it back.
//   - A negative savings_chars (the "compressed" form was longer) is NOT
//     silently swallowed; it is recorded as-is and flagged in summary() as
//     a regression. That itself is a finding worth keeping.
//   - The ledger does NOT store the verbose prose, only its sha256 and char
//     count. We do not bloat the auditor with the very verbosity it audits.
//   - Flux Reality lane is the canonical record. SQLite is a projection that
//     can be rebuilt from Flux. Writes go to Flux first, then SQLite; if the
//     SQLite mirror fails we surface honestly — never lie about the write.
//
// What this file does NOT do:
//   - It does not invoke any codec. The verbose form is supplied by the
//     caller (which already has it in hand). The ledger only fingerprints,
//     stores, and accounts.
//   - It does not expose a gateway route. That lives at
//     06-ORANGELLM/server/routes/atomsmasher-compression-debt.mjs.
//
// Exports:
//   recordDebt({ verboseText, context, fluxRoot, dbPath, recordedAt? })
//   payDebt({ debtId, compressedText, paymentEvidence, fluxRoot, dbPath, paidAt? })
//   forgiveDebt({ debtId, paymentEvidence, fluxRoot, dbPath, paidAt? })
//   getDebt(debtId, { dbPath })
//   listDebts({ status?, surface?, since?, limit?, dbPath })
//   debtSummary({ dbPath, surface?, since? })
//   _closeAllForTests()
//   __internals  (SCHEMA_SQL, helpers — test-only)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import Database from '../../bin/sqlite-shim.mjs';

import { writeFluxRecord } from '../../06-ORANGELLM/memory/ae-cobra/flux/writer.mjs';

// ---------------------------------------------------------------------------
// Schema discriminator (mirrors 09-SCHEMAS/compression-debt.v0.schema.json)
// ---------------------------------------------------------------------------

export const SCHEMA_ID = 'orange5.compression-debt.v0';

export const VALID_STATUSES = Object.freeze(['open', 'paid', 'forgiven']);

const SHA256_RE = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// SQLite schema
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS compression_debts (
  debt_id            TEXT PRIMARY KEY,
  verbose_hash       TEXT NOT NULL,
  verbose_chars      INTEGER NOT NULL,
  compressed_hash    TEXT,
  compressed_chars   INTEGER,
  savings_chars      INTEGER,
  status             TEXT NOT NULL,
  recorded_at        TEXT NOT NULL,
  paid_at            TEXT,
  surface            TEXT NOT NULL,
  actor              TEXT NOT NULL,
  ref                TEXT,
  reason             TEXT,
  payment_evidence   TEXT
);

CREATE INDEX IF NOT EXISTS idx_debts_status_recorded
  ON compression_debts (status, recorded_at);

CREATE INDEX IF NOT EXISTS idx_debts_surface_status
  ON compression_debts (surface, status);
`;

// ---------------------------------------------------------------------------
// DB handle cache
// ---------------------------------------------------------------------------
//
// Cache one open handle per absolute db path. better-sqlite3 is synchronous
// so each handle is cheap, but reopening on every call thrashes WAL and the
// page cache for hot callers.

const _dbCache = new Map();

function getDb(dbPath) {
  if (typeof dbPath !== 'string' || dbPath.length === 0) {
    throw new Error('compression-debt: dbPath required (absolute path to compression-debt.db)');
  }
  const abs = path.resolve(dbPath);
  if (_dbCache.has(abs)) return _dbCache.get(abs);

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const db = new Database(abs);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA_SQL);
  _dbCache.set(abs, db);
  return db;
}

/** Close every cached handle. Test-only. */
export function _closeAllForTests() {
  for (const db of _dbCache.values()) {
    try { db.close(); } catch { /* ignore */ }
  }
  _dbCache.clear();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function isIsoDate(s) {
  return typeof s === 'string' && !Number.isNaN(Date.parse(s));
}

function isNonEmptyString(v, maxLen = Infinity) {
  return typeof v === 'string' && v.length >= 1 && v.length <= maxLen;
}

function canonicalContext(context) {
  // Only the stable fields go into the debt_id. surface + actor are required;
  // ref and reason can vary over time without changing identity.
  return {
    surface: context.surface,
    actor: context.actor,
  };
}

function computeDebtId({ verbose_hash, recorded_at, context }) {
  const payload = JSON.stringify({
    verbose_hash,
    recorded_at,
    context: canonicalContext(context),
  });
  return sha256Hex(payload);
}

function rowToEntry(row) {
  if (!row) return null;
  return {
    schema: SCHEMA_ID,
    debt_id: row.debt_id,
    verbose_hash: row.verbose_hash,
    verbose_chars: row.verbose_chars,
    compressed_hash: row.compressed_hash ?? null,
    compressed_chars: row.compressed_chars ?? null,
    savings_chars: row.savings_chars ?? null,
    status: row.status,
    recorded_at: row.recorded_at,
    paid_at: row.paid_at ?? null,
    context: {
      surface: row.surface,
      actor: row.actor,
      ...(row.ref ? { ref: row.ref } : {}),
      ...(row.reason ? { reason: row.reason } : {}),
    },
    payment_evidence: row.payment_evidence ?? null,
  };
}

function validateContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    return 'context must be an object';
  }
  if (!isNonEmptyString(context.surface, 200)) {
    return 'context.surface must be a non-empty string up to 200 chars';
  }
  if (!isNonEmptyString(context.actor, 200)) {
    return 'context.actor must be a non-empty string up to 200 chars';
  }
  if (context.ref != null && (typeof context.ref !== 'string' || context.ref.length > 500)) {
    return 'context.ref, when present, must be a string up to 500 chars';
  }
  if (context.reason != null && (typeof context.reason !== 'string' || context.reason.length > 500)) {
    return 'context.reason, when present, must be a string up to 500 chars';
  }
  return null;
}

// ---------------------------------------------------------------------------
// recordDebt
// ---------------------------------------------------------------------------

/**
 * Record that the system chose verbose-over-compressed. The verbose prose is
 * fingerprinted, not stored. Idempotent: an identical (verbose_hash,
 * recorded_at, surface, actor) tuple returns the existing debt_id with a
 * duplicate=true flag rather than minting a second row.
 *
 * @param {Object} opts
 * @param {string} opts.verboseText  - the verbose output that was emitted
 * @param {Object} opts.context      - { surface, actor, ref?, reason? }
 * @param {string} opts.fluxRoot     - absolute path to Flux root
 * @param {string} opts.dbPath       - absolute path to compression-debt.db
 * @param {string} [opts.recordedAt] - ISO timestamp; defaults to now()
 * @returns {{ ok: boolean, debt_id?: string, duplicate?: boolean,
 *            flux_record_hash?: string, error?: string }}
 */
export function recordDebt({ verboseText, context, fluxRoot, dbPath, recordedAt } = {}) {
  if (typeof verboseText !== 'string' || verboseText.length === 0) {
    return { ok: false, error: 'verboseText required (non-empty string)' };
  }
  const ctxErr = validateContext(context);
  if (ctxErr) return { ok: false, error: ctxErr };
  if (!fluxRoot) return { ok: false, error: 'fluxRoot required' };
  if (!dbPath) return { ok: false, error: 'dbPath required' };
  if (recordedAt != null && !isIsoDate(recordedAt)) {
    return { ok: false, error: `recordedAt must be ISO 8601; got '${recordedAt}'` };
  }

  const verbose_hash = sha256Hex(verboseText);
  const verbose_chars = verboseText.length;
  const recorded_at = recordedAt || nowIso();
  const debt_id = computeDebtId({ verbose_hash, recorded_at, context });

  const db = getDb(dbPath);

  // Idempotency: same debt_id means the same (verbose, surface, actor, ts)
  // tuple was already recorded. Return the existing row honestly.
  const existing = db.prepare('SELECT debt_id, status FROM compression_debts WHERE debt_id = ?').get(debt_id);
  if (existing) {
    return {
      ok: true,
      debt_id,
      duplicate: true,
      status: existing.status,
    };
  }

  const entry = {
    schema: SCHEMA_ID,
    debt_id,
    verbose_hash,
    verbose_chars,
    compressed_hash: null,
    compressed_chars: null,
    savings_chars: null,
    status: 'open',
    recorded_at,
    paid_at: null,
    context: {
      surface: context.surface,
      actor: context.actor,
      ...(context.ref ? { ref: context.ref } : {}),
      ...(context.reason ? { reason: context.reason } : {}),
    },
    payment_evidence: null,
  };

  // ---- Flux first (canonical) --------------------------------------------
  let fluxRecord;
  try {
    fluxRecord = writeFluxRecord({
      lane: 'reality',
      origin: 'receipt.atomsmasher',
      kind: 'compression-debt',
      body: entry,
      fluxRoot,
    });
  } catch (e) {
    return { ok: false, error: `flux write failed: ${e.message}` };
  }

  // ---- SQLite mirror -----------------------------------------------------
  try {
    db.prepare(
      `INSERT INTO compression_debts
        (debt_id, verbose_hash, verbose_chars, compressed_hash, compressed_chars,
         savings_chars, status, recorded_at, paid_at, surface, actor, ref, reason,
         payment_evidence)
       VALUES
        (@debt_id, @verbose_hash, @verbose_chars, NULL, NULL,
         NULL, 'open', @recorded_at, NULL, @surface, @actor, @ref, @reason,
         NULL)`,
    ).run({
      debt_id,
      verbose_hash,
      verbose_chars,
      recorded_at,
      surface: context.surface,
      actor: context.actor,
      ref: context.ref || null,
      reason: context.reason || null,
    });
  } catch (e) {
    return {
      ok: false,
      error: `sqlite insert failed after flux write succeeded: ${e.message}`,
      flux_record_hash: fluxRecord.hash,
      debt_id,
      recovery: 'replay flux reality lane to rebuild compression-debts table',
    };
  }

  return {
    ok: true,
    debt_id,
    flux_record_hash: fluxRecord.hash,
  };
}

// ---------------------------------------------------------------------------
// payDebt
// ---------------------------------------------------------------------------

/**
 * Close an open debt by stamping the realized compressed form. Computes
 * savings_chars honestly (verbose - compressed); a negative value is kept
 * as-is and surfaces in debtSummary() as a regression.
 *
 * Idempotent: paying an already-paid debt with the SAME compressed_hash
 * returns ok:true with already=true. Paying with a DIFFERENT compressed_hash
 * is rejected — that would lie about which compression actually closed the
 * debt; mint a new debt instead.
 *
 * @param {Object} opts
 * @param {string} opts.debtId
 * @param {string} opts.compressedText
 * @param {string} opts.paymentEvidence  - receipt path / hash / URI
 * @param {string} opts.fluxRoot
 * @param {string} opts.dbPath
 * @param {string} [opts.paidAt]
 * @returns {{ ok: boolean, debt_id?: string, savings_chars?: number,
 *            already?: boolean, flux_record_hash?: string, error?: string }}
 */
export function payDebt({ debtId, compressedText, paymentEvidence, fluxRoot, dbPath, paidAt } = {}) {
  if (!isNonEmptyString(debtId) || !SHA256_RE.test(debtId)) {
    return { ok: false, error: 'debtId required (sha256 hex)' };
  }
  if (typeof compressedText !== 'string') {
    return { ok: false, error: 'compressedText required (string, may be empty)' };
  }
  if (!isNonEmptyString(paymentEvidence, 1000)) {
    return { ok: false, error: 'paymentEvidence required (non-empty string up to 1000 chars)' };
  }
  if (!fluxRoot) return { ok: false, error: 'fluxRoot required' };
  if (!dbPath) return { ok: false, error: 'dbPath required' };
  if (paidAt != null && !isIsoDate(paidAt)) {
    return { ok: false, error: `paidAt must be ISO 8601; got '${paidAt}'` };
  }

  const db = getDb(dbPath);
  const existing = db.prepare('SELECT * FROM compression_debts WHERE debt_id = ?').get(debtId);
  if (!existing) {
    return { ok: false, error: `debt not found: ${debtId}` };
  }

  const compressed_hash = sha256Hex(compressedText);
  const compressed_chars = compressedText.length;
  const savings_chars = existing.verbose_chars - compressed_chars;
  const paid_at = paidAt || nowIso();

  // Idempotency.
  if (existing.status === 'paid') {
    if (existing.compressed_hash === compressed_hash) {
      return {
        ok: true,
        already: true,
        debt_id: debtId,
        savings_chars: existing.savings_chars,
      };
    }
    return {
      ok: false,
      error:
        `debt ${debtId} is already paid with a different compressed_hash. ` +
        'Mint a new debt rather than overwriting the receipt.',
      existing_compressed_hash: existing.compressed_hash,
    };
  }
  if (existing.status === 'forgiven') {
    return { ok: false, error: `debt ${debtId} was forgiven; cannot mark paid` };
  }

  // ---- Flux first (canonical) --------------------------------------------
  const paymentBody = {
    schema: SCHEMA_ID,
    debt_id: debtId,
    verbose_hash: existing.verbose_hash,
    verbose_chars: existing.verbose_chars,
    compressed_hash,
    compressed_chars,
    savings_chars,
    status: 'paid',
    recorded_at: existing.recorded_at,
    paid_at,
    context: {
      surface: existing.surface,
      actor: existing.actor,
      ...(existing.ref ? { ref: existing.ref } : {}),
      ...(existing.reason ? { reason: existing.reason } : {}),
    },
    payment_evidence: paymentEvidence,
  };

  let fluxRecord;
  try {
    fluxRecord = writeFluxRecord({
      lane: 'reality',
      origin: 'receipt.atomsmasher',
      kind: 'compression-debt-payment',
      body: paymentBody,
      fluxRoot,
    });
  } catch (e) {
    return { ok: false, error: `flux write failed: ${e.message}` };
  }

  // ---- SQLite mirror -----------------------------------------------------
  try {
    db.prepare(
      `UPDATE compression_debts
         SET compressed_hash = @compressed_hash,
             compressed_chars = @compressed_chars,
             savings_chars = @savings_chars,
             status = 'paid',
             paid_at = @paid_at,
             payment_evidence = @payment_evidence
       WHERE debt_id = @debt_id`,
    ).run({
      debt_id: debtId,
      compressed_hash,
      compressed_chars,
      savings_chars,
      paid_at,
      payment_evidence: paymentEvidence,
    });
  } catch (e) {
    return {
      ok: false,
      error: `sqlite update failed after flux write succeeded: ${e.message}`,
      flux_record_hash: fluxRecord.hash,
      debt_id: debtId,
      recovery: 'replay flux reality lane to rebuild compression-debts table',
    };
  }

  return {
    ok: true,
    debt_id: debtId,
    savings_chars,
    regression: savings_chars < 0,
    flux_record_hash: fluxRecord.hash,
  };
}

// ---------------------------------------------------------------------------
// forgiveDebt
// ---------------------------------------------------------------------------

/**
 * Operator write-off. Use ONLY when inspection shows the verbose form was
 * actually load-bearing (e.g. the audience needed every word, or no smaller
 * form preserves the meaning). paymentEvidence MUST point to the inspection
 * receipt that justifies the write-off — Mom's Law does not allow silent
 * forgiveness.
 *
 * @param {Object} opts
 * @param {string} opts.debtId
 * @param {string} opts.paymentEvidence  - receipt of the inspection
 * @param {string} opts.fluxRoot
 * @param {string} opts.dbPath
 * @param {string} [opts.paidAt]
 */
export function forgiveDebt({ debtId, paymentEvidence, fluxRoot, dbPath, paidAt } = {}) {
  if (!isNonEmptyString(debtId) || !SHA256_RE.test(debtId)) {
    return { ok: false, error: 'debtId required (sha256 hex)' };
  }
  if (!isNonEmptyString(paymentEvidence, 1000)) {
    return { ok: false, error: 'paymentEvidence required (cite the inspection receipt)' };
  }
  if (!fluxRoot) return { ok: false, error: 'fluxRoot required' };
  if (!dbPath) return { ok: false, error: 'dbPath required' };
  if (paidAt != null && !isIsoDate(paidAt)) {
    return { ok: false, error: `paidAt must be ISO 8601; got '${paidAt}'` };
  }

  const db = getDb(dbPath);
  const existing = db.prepare('SELECT * FROM compression_debts WHERE debt_id = ?').get(debtId);
  if (!existing) return { ok: false, error: `debt not found: ${debtId}` };
  if (existing.status === 'forgiven') return { ok: true, already: true, debt_id: debtId };
  if (existing.status === 'paid') {
    return { ok: false, error: `debt ${debtId} is already paid; forgiveness would lie about history` };
  }

  const forgiven_at = paidAt || nowIso();

  const body = {
    schema: SCHEMA_ID,
    debt_id: debtId,
    verbose_hash: existing.verbose_hash,
    verbose_chars: existing.verbose_chars,
    compressed_hash: null,
    compressed_chars: null,
    savings_chars: null,
    status: 'forgiven',
    recorded_at: existing.recorded_at,
    paid_at: forgiven_at,
    context: {
      surface: existing.surface,
      actor: existing.actor,
      ...(existing.ref ? { ref: existing.ref } : {}),
      ...(existing.reason ? { reason: existing.reason } : {}),
    },
    payment_evidence: paymentEvidence,
  };

  let fluxRecord;
  try {
    fluxRecord = writeFluxRecord({
      lane: 'reality',
      origin: 'receipt.atomsmasher',
      kind: 'compression-debt-forgiveness',
      body,
      fluxRoot,
    });
  } catch (e) {
    return { ok: false, error: `flux write failed: ${e.message}` };
  }

  try {
    db.prepare(
      `UPDATE compression_debts
         SET status = 'forgiven',
             paid_at = @paid_at,
             payment_evidence = @payment_evidence
       WHERE debt_id = @debt_id`,
    ).run({
      debt_id: debtId,
      paid_at: forgiven_at,
      payment_evidence: paymentEvidence,
    });
  } catch (e) {
    return {
      ok: false,
      error: `sqlite update failed after flux write succeeded: ${e.message}`,
      flux_record_hash: fluxRecord.hash,
      recovery: 'replay flux reality lane to rebuild compression-debts table',
    };
  }

  return {
    ok: true,
    debt_id: debtId,
    status: 'forgiven',
    flux_record_hash: fluxRecord.hash,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Fetch one debt by id. Returns null when not found. */
export function getDebt(debtId, { dbPath } = {}) {
  if (!isNonEmptyString(debtId)) throw new Error('getDebt: debtId required');
  if (!dbPath) throw new Error('getDebt: dbPath required');
  const db = getDb(dbPath);
  const row = db.prepare('SELECT * FROM compression_debts WHERE debt_id = ?').get(debtId);
  return rowToEntry(row);
}

/**
 * List debts with optional filters. Filters are AND-combined. Ordered by
 * recorded_at ASC then debt_id ASC for stable pagination.
 *
 * @param {Object} opts
 * @param {string} opts.dbPath
 * @param {string} [opts.status]   - open | paid | forgiven
 * @param {string} [opts.surface]  - exact match on context.surface
 * @param {string} [opts.since]    - ISO 8601; recorded_at >= since
 * @param {number} [opts.limit]    - default 1000, max 100000
 */
export function listDebts({ status, surface, since, dbPath, limit = 1000 } = {}) {
  if (!dbPath) throw new Error('listDebts: dbPath required');
  if (status != null && !VALID_STATUSES.includes(status)) {
    throw new Error(`listDebts: invalid status '${status}'. Must be one of: ${VALID_STATUSES.join(', ')}`);
  }
  if (since != null && !isIsoDate(since)) {
    throw new Error(`listDebts: since must be parseable ISO date, got '${since}'`);
  }
  if (!Number.isInteger(limit) || limit <= 0 || limit > 100000) {
    throw new Error('listDebts: limit must be a positive integer <= 100000');
  }

  const db = getDb(dbPath);
  const where = [];
  const params = {};
  if (status != null) { where.push('status = @status'); params.status = status; }
  if (surface != null) { where.push('surface = @surface'); params.surface = surface; }
  if (since != null) { where.push('recorded_at >= @since'); params.since = since; }

  const sql =
    'SELECT * FROM compression_debts' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY recorded_at ASC, debt_id ASC' +
    ` LIMIT ${limit}`;

  return db.prepare(sql).all(params).map(rowToEntry);
}

/**
 * Honest accounting. Returns counts and char totals broken out by status,
 * plus regressions (paid debts where savings_chars < 0).
 *
 * @param {Object} opts
 * @param {string} opts.dbPath
 * @param {string} [opts.surface]
 * @param {string} [opts.since]
 */
export function debtSummary({ dbPath, surface, since } = {}) {
  if (!dbPath) throw new Error('debtSummary: dbPath required');
  if (since != null && !isIsoDate(since)) {
    throw new Error(`debtSummary: since must be parseable ISO date, got '${since}'`);
  }

  const db = getDb(dbPath);
  const where = [];
  const params = {};
  if (surface != null) { where.push('surface = @surface'); params.surface = surface; }
  if (since != null) { where.push('recorded_at >= @since'); params.since = since; }
  const whereClause = where.length ? ' WHERE ' + where.join(' AND ') : '';

  const totalsRow = db.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
       SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paid_count,
       SUM(CASE WHEN status = 'forgiven' THEN 1 ELSE 0 END) AS forgiven_count,
       SUM(CASE WHEN status = 'open' THEN verbose_chars ELSE 0 END) AS open_verbose_chars,
       SUM(CASE WHEN status = 'paid' THEN savings_chars ELSE 0 END) AS paid_savings_chars,
       SUM(CASE WHEN status = 'paid' AND savings_chars < 0 THEN 1 ELSE 0 END) AS regression_count,
       SUM(CASE WHEN status = 'paid' AND savings_chars < 0 THEN savings_chars ELSE 0 END) AS regression_chars
     FROM compression_debts` + whereClause,
  ).get(params);

  const bySurface = db.prepare(
    `SELECT surface,
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
            SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paid_count,
            SUM(CASE WHEN status = 'paid' THEN savings_chars ELSE 0 END) AS savings_chars
       FROM compression_debts` + whereClause +
    ' GROUP BY surface ORDER BY total DESC',
  ).all(params);

  return {
    total: totalsRow.total || 0,
    open_count: totalsRow.open_count || 0,
    paid_count: totalsRow.paid_count || 0,
    forgiven_count: totalsRow.forgiven_count || 0,
    open_verbose_chars: totalsRow.open_verbose_chars || 0,
    paid_savings_chars: totalsRow.paid_savings_chars || 0,
    regression_count: totalsRow.regression_count || 0,
    regression_chars: totalsRow.regression_chars || 0,
    by_surface: bySurface.map((r) => ({
      surface: r.surface,
      total: r.total,
      open: r.open_count || 0,
      paid: r.paid_count || 0,
      savings_chars: r.savings_chars || 0,
    })),
    generated_at: nowIso(),
  };
}

// ---------------------------------------------------------------------------
// Internals (test-only)
// ---------------------------------------------------------------------------

export const __internals = Object.freeze({
  SCHEMA_SQL,
  computeDebtId,
  rowToEntry,
  sha256Hex,
  getDb,
});
