// canon-pressure/detector.mjs
//
// AtomSmasher module #9 — Canon Pressure Detector.
//
// PURPOSE
// -------
// Watches the receipt stream for "ontology candidates" — names, terms, or
// concepts the system has been using as if they were canon, but that have
// not yet been formally promoted. When a candidate accumulates enough real
// usage, the detector raises a promotion candidate for AE7 review.
//
// PROMOTION RULES (binding, both are sufficient; either trips the signal):
//   1. Receipt threshold:  >= 5 receipts reference the candidate AND those
//      receipts span >= 2 distinct missions.
//   2. Operator promotion: a recordOperatorPromotion(...) call has been made
//      against the candidate with a non-empty rationale and actor.
//
// Both signals can fire together; both are surfaced honestly. The detector
// never auto-promotes — it only RAISES. AE7 review is the gate.
//
// DOCTRINE (Mom's Law applied to ontology)
// ----------------------------------------
//   - The detector observes; it does not mutate ontology. Promotion happens
//     elsewhere, with operator stamp.
//   - "References" must be explicit. We do not infer references from prose
//     similarity — callers (the ingest pipeline) pass the candidate name
//     verbatim with each receipt. Silent inference would manufacture canon
//     out of vibes.
//   - Honest gaps: if no receipts have ever been ingested, status() returns
//     empty arrays, not theatrical "all clear" claims.
//   - Idempotent: ingesting the same (candidate, receipt_id) pair twice does
//     not double-count. The unique index on (candidate, receipt_id) is the
//     gate.
//   - Append-only at the row level. A candidate's references are never
//     deleted — superseding a promotion candidate (e.g. "decided not to
//     promote") is itself a separate row in `promotion_decisions`.
//
// WHAT THIS FILE DOES NOT DO
// --------------------------
//   - It does not read markdown receipts itself. The receipts pipeline
//     (06-CONTROL-PLANE/receipts/) is the source of receipts; whoever wires
//     this detector to that pipeline calls ingestReceiptReference() per
//     extracted (candidate, receipt_id, mission_id) tuple.
//   - It does not expose a gateway route. That lives at
//     06-ORANGELLM/server/routes/atomsmasher-canon-pressure.mjs.
//   - It does not write to Æ Cobra Flux. The pressure ledger is local and
//     query-only; promotion DECISIONS made downstream are what land in Flux
//     via separate atom emissions.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import Database from '../../bin/sqlite-shim.mjs';

// ---------------------------------------------------------------------------
// Schema discriminator (mirrors 09-SCHEMAS/canon-pressure.v0 if/when authored).
// Kept as a literal here so the module is self-contained.
// ---------------------------------------------------------------------------

export const SCHEMA_ID = 'orange5.canon-pressure.v0';

// Promotion thresholds, exported so callers/tests can read them rather than
// hard-coding magic numbers. If operator doctrine ever changes the numbers,
// they change here in one place.
export const PRESSURE_THRESHOLDS = Object.freeze({
  MIN_RECEIPTS: 5,
  MIN_MISSIONS: 2,
});

// A candidate's signal status surfaces as one of these strings.
//   - 'inert'        : below threshold, no operator promotion.
//   - 'receipt'      : receipt threshold tripped only.
//   - 'operator'     : operator promotion recorded only.
//   - 'receipt+op'   : both signals tripped.
// AE7 review treats all three non-inert states as "consider for promotion".
export const PRESSURE_STATES = Object.freeze([
  'inert',
  'receipt',
  'operator',
  'receipt+op',
]);

// ---------------------------------------------------------------------------
// SQLite schema
// ---------------------------------------------------------------------------
//
// Two tables. references is the raw observation log; promotion_decisions is
// the operator audit trail. Both are append-only at the application level.
//
//   canon_pressure_references
//     (candidate, receipt_id) PRIMARY KEY  -- idempotency guarantor
//     mission_id                            -- the mission the receipt belongs to
//     observed_at                           -- when WE saw the reference
//     ref_actor                             -- who emitted the receipt (best-effort)
//     ref_evidence                          -- optional pointer (markdown path, etc.)
//
//   canon_pressure_operator_decisions
//     decision_id PRIMARY KEY
//     candidate, decision ('promote'|'reject'), actor, rationale, decided_at
//
// We do NOT store receipt body text; just the link. The receipts pipeline
// is the canonical source for prose.

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS canon_pressure_references (
  candidate     TEXT NOT NULL,
  receipt_id    TEXT NOT NULL,
  mission_id    TEXT NOT NULL,
  observed_at   TEXT NOT NULL,
  ref_actor     TEXT,
  ref_evidence  TEXT,
  PRIMARY KEY (candidate, receipt_id)
);

CREATE INDEX IF NOT EXISTS idx_canon_pressure_candidate
  ON canon_pressure_references (candidate);

CREATE INDEX IF NOT EXISTS idx_canon_pressure_mission
  ON canon_pressure_references (mission_id);

CREATE TABLE IF NOT EXISTS canon_pressure_operator_decisions (
  decision_id   TEXT PRIMARY KEY,
  candidate     TEXT NOT NULL,
  decision      TEXT NOT NULL,
  actor         TEXT NOT NULL,
  rationale     TEXT NOT NULL,
  decided_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_canon_pressure_decisions_candidate
  ON canon_pressure_operator_decisions (candidate);
`;

// ---------------------------------------------------------------------------
// DB handle cache
// ---------------------------------------------------------------------------

const _dbCache = new Map();

function getDb(dbPath) {
  if (typeof dbPath !== 'string' || dbPath.length === 0) {
    throw new Error('canon-pressure: dbPath required (absolute path to canon-pressure.db)');
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

function nowIso() {
  return new Date().toISOString();
}

function isIsoDate(s) {
  return typeof s === 'string' && !Number.isNaN(Date.parse(s));
}

function isNonEmptyString(v, maxLen = Infinity) {
  return typeof v === 'string' && v.length >= 1 && v.length <= maxLen;
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// Canonical candidate normalization: trim and collapse internal whitespace.
// Case-sensitive on purpose — "Pathwaves" and "pathwaves" are different
// surface tokens until an operator says otherwise; the detector does not
// silently merge them, because doing so would be the kind of "vibes ontology"
// the system is built to refuse.
function normalizeCandidate(s) {
  if (typeof s !== 'string') return null;
  const trimmed = s.trim().replace(/\s+/g, ' ');
  return trimmed.length === 0 ? null : trimmed;
}

function computeDecisionId({ candidate, decision, actor, decided_at, rationale }) {
  // Content-derived so equal (candidate, decision, actor, decided_at,
  // rationale) tuples collide and we don't write twice. We DO include
  // rationale here because a different rationale at the same instant is
  // a different decision in spirit; this also means re-submitting the
  // exact same call is naturally idempotent.
  const payload = JSON.stringify({ candidate, decision, actor, decided_at, rationale });
  return sha256Hex(payload);
}

// ---------------------------------------------------------------------------
// ingestReceiptReference
// ---------------------------------------------------------------------------

/**
 * Record that a receipt referenced an ontology candidate, scoped to a mission.
 *
 * Idempotent: the same (candidate, receipt_id) pair is recorded once. A second
 * call with the same pair returns `{ ok: true, duplicate: true }` and does
 * not overwrite the original mission_id. If the second call disagrees with
 * the first on mission_id, this is surfaced as `{ ok: false, error: ... }`
 * because the same receipt cannot truthfully belong to two missions — that
 * would be a data quality bug upstream worth catching.
 *
 * @param {Object}  opts
 * @param {string}  opts.candidate    - the ontology candidate name (e.g. "Pathwaves")
 * @param {string}  opts.receiptId    - receipt_id from the receipts pipeline
 * @param {string}  opts.missionId    - mission identifier
 * @param {string}  opts.dbPath       - absolute path to canon-pressure.db
 * @param {string} [opts.refActor]    - who authored the receipt (optional)
 * @param {string} [opts.refEvidence] - optional pointer (markdown path, hash)
 * @param {string} [opts.observedAt]  - ISO timestamp; defaults to now()
 * @returns {{ ok: boolean, duplicate?: boolean, error?: string }}
 */
export function ingestReceiptReference({
  candidate,
  receiptId,
  missionId,
  dbPath,
  refActor,
  refEvidence,
  observedAt,
} = {}) {
  const c = normalizeCandidate(candidate);
  if (!c) return { ok: false, error: 'candidate must be a non-empty string' };
  if (c.length > 500) return { ok: false, error: 'candidate exceeds 500 chars' };
  if (!isNonEmptyString(receiptId, 500)) {
    return { ok: false, error: 'receiptId must be a non-empty string up to 500 chars' };
  }
  if (!isNonEmptyString(missionId, 500)) {
    return { ok: false, error: 'missionId must be a non-empty string up to 500 chars' };
  }
  if (!dbPath) return { ok: false, error: 'dbPath required' };
  if (observedAt != null && !isIsoDate(observedAt)) {
    return { ok: false, error: `observedAt must be ISO 8601; got '${observedAt}'` };
  }
  if (refActor != null && !isNonEmptyString(refActor, 200)) {
    return { ok: false, error: 'refActor, when present, must be 1..200 chars' };
  }
  if (refEvidence != null && !isNonEmptyString(refEvidence, 1000)) {
    return { ok: false, error: 'refEvidence, when present, must be 1..1000 chars' };
  }

  const db = getDb(dbPath);
  const obs_at = observedAt || nowIso();

  // Idempotency / mission-coherence check.
  const existing = db
    .prepare('SELECT mission_id FROM canon_pressure_references WHERE candidate = ? AND receipt_id = ?')
    .get(c, receiptId);

  if (existing) {
    if (existing.mission_id !== missionId) {
      return {
        ok: false,
        error:
          `receipt ${receiptId} already linked to candidate '${c}' under mission ` +
          `'${existing.mission_id}'; refusing to overwrite with '${missionId}'`,
      };
    }
    return { ok: true, duplicate: true };
  }

  try {
    db.prepare(
      `INSERT INTO canon_pressure_references
         (candidate, receipt_id, mission_id, observed_at, ref_actor, ref_evidence)
       VALUES
         (@candidate, @receipt_id, @mission_id, @observed_at, @ref_actor, @ref_evidence)`,
    ).run({
      candidate: c,
      receipt_id: receiptId,
      mission_id: missionId,
      observed_at: obs_at,
      ref_actor: refActor || null,
      ref_evidence: refEvidence || null,
    });
  } catch (e) {
    return { ok: false, error: `sqlite insert failed: ${e.message}` };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// recordOperatorPromotion
// ---------------------------------------------------------------------------

/**
 * Record an explicit operator promotion (or rejection) for a candidate. This
 * is the second of the two promotion signals. The detector still does not
 * mutate ontology — it records the operator's stamp so status() can surface
 * it as a `'operator'` or `'receipt+op'` signal.
 *
 * Idempotent on content-derived decision_id.
 *
 * @param {Object} opts
 * @param {string} opts.candidate  - candidate name
 * @param {string} opts.decision   - 'promote' or 'reject'
 * @param {string} opts.actor      - e.g. 'operator:atom'
 * @param {string} opts.rationale  - non-empty, non-fluff rationale
 * @param {string} opts.dbPath
 * @param {string} [opts.decidedAt] - ISO timestamp; defaults to now()
 * @returns {{ ok: boolean, decision_id?: string, duplicate?: boolean, error?: string }}
 */
export function recordOperatorPromotion({
  candidate,
  decision,
  actor,
  rationale,
  dbPath,
  decidedAt,
} = {}) {
  const c = normalizeCandidate(candidate);
  if (!c) return { ok: false, error: 'candidate must be a non-empty string' };
  if (decision !== 'promote' && decision !== 'reject') {
    return { ok: false, error: "decision must be 'promote' or 'reject'" };
  }
  if (!isNonEmptyString(actor, 200)) {
    return { ok: false, error: 'actor must be a non-empty string up to 200 chars' };
  }
  if (!isNonEmptyString(rationale, 2000)) {
    return { ok: false, error: 'rationale must be a non-empty string up to 2000 chars' };
  }
  // Anti-fluff: a rationale of "should work" or "looks ok" is not a rationale.
  const lower = rationale.toLowerCase();
  for (const fluff of ['should_work', 'should work', 'looks_ok', 'looks ok', 'probably', 'green_assumed']) {
    if (lower.includes(fluff)) {
      return { ok: false, error: `rationale contains fluff token: '${fluff}'` };
    }
  }
  if (!dbPath) return { ok: false, error: 'dbPath required' };
  if (decidedAt != null && !isIsoDate(decidedAt)) {
    return { ok: false, error: `decidedAt must be ISO 8601; got '${decidedAt}'` };
  }

  const decided_at = decidedAt || nowIso();
  const decision_id = computeDecisionId({
    candidate: c,
    decision,
    actor,
    decided_at,
    rationale,
  });

  const db = getDb(dbPath);

  const existing = db
    .prepare('SELECT decision_id FROM canon_pressure_operator_decisions WHERE decision_id = ?')
    .get(decision_id);
  if (existing) {
    return { ok: true, decision_id, duplicate: true };
  }

  try {
    db.prepare(
      `INSERT INTO canon_pressure_operator_decisions
         (decision_id, candidate, decision, actor, rationale, decided_at)
       VALUES
         (@decision_id, @candidate, @decision, @actor, @rationale, @decided_at)`,
    ).run({
      decision_id,
      candidate: c,
      decision,
      actor,
      rationale,
      decided_at,
    });
  } catch (e) {
    return { ok: false, error: `sqlite insert failed: ${e.message}` };
  }

  return { ok: true, decision_id };
}

// ---------------------------------------------------------------------------
// candidateStatus  (single-candidate)
// ---------------------------------------------------------------------------

/**
 * Compute the current pressure status for a single candidate.
 *
 * Returns an honest object describing observed counts and whether either
 * promotion signal has tripped. Does NOT mutate state.
 *
 * @param {string} candidate
 * @param {Object} opts
 * @param {string} opts.dbPath
 * @returns {{
 *   candidate: string,
 *   receipt_count: number,
 *   mission_count: number,
 *   missions: string[],
 *   threshold_tripped: boolean,
 *   operator_promoted: boolean,
 *   operator_decisions: Array<{decision: string, actor: string, rationale: string, decided_at: string}>,
 *   state: 'inert'|'receipt'|'operator'|'receipt+op',
 *   first_seen_at: string|null,
 *   last_seen_at: string|null,
 * }}
 */
export function candidateStatus(candidate, { dbPath } = {}) {
  const c = normalizeCandidate(candidate);
  if (!c) throw new Error('candidateStatus: candidate required');
  if (!dbPath) throw new Error('candidateStatus: dbPath required');

  const db = getDb(dbPath);

  const agg = db.prepare(
    `SELECT
       COUNT(*)                       AS receipt_count,
       COUNT(DISTINCT mission_id)     AS mission_count,
       MIN(observed_at)               AS first_seen_at,
       MAX(observed_at)               AS last_seen_at
     FROM canon_pressure_references
     WHERE candidate = ?`,
  ).get(c);

  const missionRows = db.prepare(
    `SELECT DISTINCT mission_id
     FROM canon_pressure_references
     WHERE candidate = ?
     ORDER BY mission_id ASC`,
  ).all(c);

  const decisionRows = db.prepare(
    `SELECT decision, actor, rationale, decided_at
     FROM canon_pressure_operator_decisions
     WHERE candidate = ?
     ORDER BY decided_at ASC`,
  ).all(c);

  const receipt_count = agg?.receipt_count || 0;
  const mission_count = agg?.mission_count || 0;
  const missions = missionRows.map((r) => r.mission_id);

  const threshold_tripped =
    receipt_count >= PRESSURE_THRESHOLDS.MIN_RECEIPTS &&
    mission_count >= PRESSURE_THRESHOLDS.MIN_MISSIONS;

  // Only the LAST decision per candidate sets operator_promoted, so a later
  // 'reject' overrides an earlier 'promote'. We preserve the full decision
  // log on the returned object so AE7 review can see the history.
  let operator_promoted = false;
  if (decisionRows.length > 0) {
    const latest = decisionRows[decisionRows.length - 1];
    operator_promoted = latest.decision === 'promote';
  }

  let state;
  if (threshold_tripped && operator_promoted) state = 'receipt+op';
  else if (threshold_tripped) state = 'receipt';
  else if (operator_promoted) state = 'operator';
  else state = 'inert';

  return {
    candidate: c,
    receipt_count,
    mission_count,
    missions,
    threshold_tripped,
    operator_promoted,
    operator_decisions: decisionRows,
    state,
    first_seen_at: agg?.first_seen_at || null,
    last_seen_at: agg?.last_seen_at || null,
  };
}

// ---------------------------------------------------------------------------
// listPromotionCandidates  (all non-inert candidates)
// ---------------------------------------------------------------------------

/**
 * Return every candidate currently in a non-inert state, ordered by signal
 * strength so AE7 review can triage the strongest cases first.
 *
 * Ordering (highest priority first):
 *   1. state === 'receipt+op'
 *   2. state === 'receipt'
 *   3. state === 'operator'
 * Within a state, by receipt_count DESC, then candidate ASC.
 *
 * Inert candidates are excluded by default. Pass { includeInert: true } to
 * get every candidate ever observed — useful for dashboards.
 *
 * @param {Object}  opts
 * @param {string}  opts.dbPath
 * @param {boolean} [opts.includeInert]  - default false
 * @param {number}  [opts.limit]         - default 1000
 * @returns {Array<ReturnType<typeof candidateStatus>>}
 */
export function listPromotionCandidates({ dbPath, includeInert = false, limit = 1000 } = {}) {
  if (!dbPath) throw new Error('listPromotionCandidates: dbPath required');
  if (!Number.isInteger(limit) || limit <= 0 || limit > 100000) {
    throw new Error('listPromotionCandidates: limit must be a positive integer <= 100000');
  }

  const db = getDb(dbPath);

  // Pull the union of every candidate that has either references or
  // operator decisions. UNION (not UNION ALL) so candidates that appear in
  // both sources are de-duplicated.
  const names = db
    .prepare(
      `SELECT candidate FROM canon_pressure_references
       UNION
       SELECT candidate FROM canon_pressure_operator_decisions`,
    )
    .all()
    .map((r) => r.candidate);

  const all = names.map((c) => candidateStatus(c, { dbPath }));

  const filtered = includeInert ? all : all.filter((s) => s.state !== 'inert');

  const stateRank = { 'receipt+op': 0, receipt: 1, operator: 2, inert: 3 };
  filtered.sort((a, b) => {
    const sa = stateRank[a.state] ?? 99;
    const sb = stateRank[b.state] ?? 99;
    if (sa !== sb) return sa - sb;
    if (a.receipt_count !== b.receipt_count) return b.receipt_count - a.receipt_count;
    return a.candidate < b.candidate ? -1 : a.candidate > b.candidate ? 1 : 0;
  });

  return filtered.slice(0, limit);
}

// ---------------------------------------------------------------------------
// pressureSummary
// ---------------------------------------------------------------------------

/**
 * High-level counts for dashboards. Honest — if there are no observations,
 * every count is 0 and total_candidates is 0. No theatrical claims.
 *
 * @param {Object} opts
 * @param {string} opts.dbPath
 * @returns {{
 *   schema: string,
 *   total_candidates: number,
 *   total_receipts: number,
 *   total_missions: number,
 *   states: { inert: number, receipt: number, operator: number, 'receipt+op': number },
 *   thresholds: { MIN_RECEIPTS: number, MIN_MISSIONS: number },
 *   computed_at: string,
 * }}
 */
export function pressureSummary({ dbPath } = {}) {
  if (!dbPath) throw new Error('pressureSummary: dbPath required');
  const db = getDb(dbPath);

  const refAgg = db.prepare(
    `SELECT
       COUNT(*)                       AS total_receipts,
       COUNT(DISTINCT mission_id)     AS total_missions
     FROM canon_pressure_references`,
  ).get();

  const all = listPromotionCandidates({ dbPath, includeInert: true, limit: 100000 });

  const states = { inert: 0, receipt: 0, operator: 0, 'receipt+op': 0 };
  for (const s of all) {
    if (states[s.state] != null) states[s.state] += 1;
  }

  return {
    schema: SCHEMA_ID,
    total_candidates: all.length,
    total_receipts: refAgg?.total_receipts || 0,
    total_missions: refAgg?.total_missions || 0,
    states,
    thresholds: { ...PRESSURE_THRESHOLDS },
    computed_at: nowIso(),
  };
}

// ---------------------------------------------------------------------------
// Internals for tests
// ---------------------------------------------------------------------------

export const __internals = Object.freeze({
  SCHEMA_SQL,
  normalizeCandidate,
  computeDecisionId,
  getDb,
});
