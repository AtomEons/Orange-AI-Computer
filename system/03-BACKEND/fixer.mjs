import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from '#sqlite';
import { appendPartyLineEvent } from '../04-CONTROL-PLANE/party-line/ledger.mjs';
import { readReceipt, validateReceiptShape } from '../08-HERMES/src/loom-gates/03-receipt-spine.mjs';

export const FIXER_SCHEMA = 'orange.fixer.case.v1';
export const FIXER_STATES = Object.freeze([
  'detected',
  'reproduced',
  'isolated',
  'repair_planned',
  'leased',
  'patched',
  'exact_path_verified',
  'regression_encoded',
  'closed',
]);
export const FIXER_SEVERITIES = Object.freeze(['low', 'medium', 'high', 'critical']);

const json = (value) => JSON.stringify(value ?? null);
const parse = (value, fallback = null) => {
  try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; }
};
const stable = (value) => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const now = () => new Date().toISOString();
const SUCCESS_STATUSES = new Set(['ok', 'passed', 'success', 'succeeded', 'verified', 'green', 'complete', 'completed']);

const isSuccessStatus = (value) => {
  if (typeof value !== 'string') return false;
  const status = value.trim().toLowerCase();
  return SUCCESS_STATUSES.has(status) || status.endsWith('_green') || status.endsWith('_passed');
};

const hasSuccessSignal = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.ok === true || value.pass === true || value.passed === true || value.success === true) return true;
  if (value.exitCode === 0 || value.exit_code === 0) return true;
  if (isSuccessStatus(value.status)) return true;
  return Array.isArray(value.gates) && value.gates.length > 0 && value.gates.every((gate) => gate?.pass === true);
};

const hasFailureSignal = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.ok === false || value.pass === false || value.passed === false || value.success === false) return true;
  if ((Number.isInteger(value.exitCode) && value.exitCode !== 0) || (Number.isInteger(value.exit_code) && value.exit_code !== 0)) return true;
  return typeof value.status === 'string' && /^(?:failed|failure|error|red|needs_work)$/i.test(value.status.trim());
};

const hasSuccessfulRepairEvidence = (evidence) => Array.isArray(evidence) && evidence.some((item) => (
  typeof item?.type === 'string'
  && /(?:repair|execution)/i.test(item.type)
  && hasSuccessSignal(item)
));

const isExistingArtifact = (artifactPath) => {
  if (typeof artifactPath !== 'string' || !artifactPath.trim()) return false;
  try {
    const resolved = path.isAbsolute(artifactPath) ? artifactPath : path.resolve(process.cwd(), artifactPath);
    const stat = fs.statSync(resolved);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
};

const receiptHasSuccessEvidence = (receipt) => {
  if (!isSuccessStatus(receipt?.status)) return false;
  if (Array.isArray(receipt.blockers) && receipt.blockers.length > 0) return false;

  const evidence = Array.isArray(receipt.evidence) ? receipt.evidence : [];
  if (evidence.some(hasFailureSignal)) return false;
  if (evidence.some(hasSuccessSignal)) return true;
  if (hasSuccessSignal(receipt.execution) || hasSuccessSignal(receipt.result)) return true;

  const checks = receipt.checks && typeof receipt.checks === 'object' && !Array.isArray(receipt.checks)
    ? Object.values(receipt.checks)
    : [];
  return checks.length > 0 && checks.every((check) => check === true || hasSuccessSignal(check));
};

export function canonicalFixerPath() {
  return path.join(os.homedir(), 'OrangeBox-Data', 'orange5', 'control', 'fixer.sqlite');
}

export class FixerStore {
  constructor(dbPath = canonicalFixerPath(), options = {}) {
    this.path = path.resolve(dbPath);
    this.partyLinePath = options.partyLinePath;
    this.publish = options.publish !== false;
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    this.db = new Database(this.path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fixer_cases (
        defect_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        source TEXT NOT NULL,
        severity TEXT NOT NULL,
        state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        reproducer_json TEXT,
        suspected_boundary TEXT,
        repair_order_json TEXT,
        hermes_lease_json TEXT,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        rollback_json TEXT,
        regression_json TEXT,
        receipt_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        case_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fixer_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        defect_id TEXT NOT NULL,
        from_state TEXT,
        to_state TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        prev_hash TEXT,
        event_hash TEXT NOT NULL,
        FOREIGN KEY (defect_id) REFERENCES fixer_cases(defect_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS fixer_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        defect_id TEXT NOT NULL,
        cause TEXT NOT NULL,
        method TEXT NOT NULL,
        succeeded INTEGER NOT NULL,
        evidence_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (defect_id) REFERENCES fixer_cases(defect_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_fixer_cases_open ON fixer_cases(state, severity, updated_at);
      CREATE INDEX IF NOT EXISTS idx_fixer_events_case ON fixer_events(defect_id, seq);
    `);
  }

  async createCase(input) {
    const defectId = String(input?.defectId || '').trim();
    const runId = String(input?.runId || '').trim();
    const source = String(input?.source || '').trim();
    const severity = String(input?.severity || '').trim();
    if (defectId.length < 3 || runId.length < 3 || !source) throw new Error('defectId, runId, and source are required');
    if (!FIXER_SEVERITIES.includes(severity)) throw new Error(`invalid Fixer severity: ${severity}`);
    if (this.getCase(defectId)) throw new Error(`Fixer case already exists: ${defectId}`);
    const createdAt = input.createdAt || now();
    const base = {
      schema: FIXER_SCHEMA,
      defectId,
      runId,
      source,
      severity,
      state: 'detected',
      attempts: 0,
      reproducer: null,
      suspectedBoundary: null,
      repairOrder: null,
      hermesLease: null,
      evidence: Array.isArray(input.evidence) ? input.evidence : [],
      rollback: null,
      regression: null,
      receiptPath: null,
      createdAt,
      updatedAt: createdAt,
      closedAt: null,
    };
    const caseHash = this.#caseHash(base);
    this.db.prepare(`
      INSERT INTO fixer_cases (
        defect_id, run_id, source, severity, state, attempts, evidence_json,
        created_at, updated_at, case_hash
      ) VALUES (?, ?, ?, ?, 'detected', 0, ?, ?, ?, ?)
    `).run(defectId, runId, source, severity, json(base.evidence), createdAt, createdAt, caseHash);
    this.#appendEvent(defectId, null, 'detected', { source, severity, evidence: base.evidence }, createdAt);
    await this.#publish(this.getCase(defectId), null, 'detected');
    return this.getCase(defectId);
  }

  async transition(defectId, nextState, patch = {}) {
    const current = this.getCase(defectId);
    if (!current) throw new Error(`Fixer case not found: ${defectId}`);
    const expected = FIXER_STATES[FIXER_STATES.indexOf(current.state) + 1];
    if (nextState !== expected) throw new Error(`invalid Fixer transition ${current.state} -> ${nextState}; expected ${expected || 'none'}`);
    const merged = {
      ...current,
      ...patch,
      state: nextState,
      evidence: [...current.evidence, ...(Array.isArray(patch.evidence) ? patch.evidence : [])],
      updatedAt: patch.updatedAt || now(),
      closedAt: nextState === 'closed' ? (patch.closedAt || now()) : current.closedAt,
    };
    await this.#validateTransition(merged, patch);
    merged.caseHash = this.#caseHash(merged);
    this.db.prepare(`
      UPDATE fixer_cases SET
        state = ?, attempts = ?, reproducer_json = ?, suspected_boundary = ?,
        repair_order_json = ?, hermes_lease_json = ?, evidence_json = ?,
        rollback_json = ?, regression_json = ?, receipt_path = ?,
        updated_at = ?, closed_at = ?, case_hash = ?
      WHERE defect_id = ?
    `).run(
      merged.state, merged.attempts, json(merged.reproducer), merged.suspectedBoundary,
      json(merged.repairOrder), json(merged.hermesLease), json(merged.evidence),
      json(merged.rollback), json(merged.regression), merged.receiptPath,
      merged.updatedAt, merged.closedAt, merged.caseHash, defectId,
    );
    this.#appendEvent(defectId, current.state, nextState, patch, merged.updatedAt);
    await this.#publish(merged, current.state, nextState);
    return this.getCase(defectId);
  }

  recordAttempt(defectId, { cause, method, succeeded = false, evidence = {} }) {
    const current = this.getCase(defectId);
    if (!current) throw new Error(`Fixer case not found: ${defectId}`);
    const cleanCause = String(cause || '').trim();
    const cleanMethod = String(method || '').trim();
    if (!cleanCause || !cleanMethod) throw new Error('Fixer attempt cause and method are required');
    const sameFailures = this.db.prepare(`
      SELECT COUNT(*) AS count FROM fixer_attempts
      WHERE defect_id = ? AND cause = ? AND method = ? AND succeeded = 0
    `).get(defectId, cleanCause, cleanMethod)?.count || 0;
    if (!succeeded && sameFailures >= 2) {
      throw new Error(`blind retry refused for ${cleanCause}; change method or escalate`);
    }
    this.db.prepare(`
      INSERT INTO fixer_attempts (defect_id, cause, method, succeeded, evidence_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(defectId, cleanCause, cleanMethod, succeeded ? 1 : 0, json(evidence), now());
    const attempts = this.db.prepare('SELECT COUNT(*) AS count FROM fixer_attempts WHERE defect_id = ?').get(defectId)?.count || 0;
    this.db.prepare('UPDATE fixer_cases SET attempts = ?, updated_at = ? WHERE defect_id = ?').run(attempts, now(), defectId);
    this.#rehash(defectId);
    return { attempts, changedMethodRequired: !succeeded && sameFailures + 1 >= 2 };
  }

  getCase(defectId) {
    const row = this.db.prepare('SELECT * FROM fixer_cases WHERE defect_id = ?').get(defectId);
    return row ? this.#row(row) : null;
  }

  listCases({ includeClosed = false, limit = 100 } = {}) {
    const where = includeClosed ? '' : "WHERE state <> 'closed'";
    const rows = this.db.prepare(`
      SELECT * FROM fixer_cases ${where}
      ORDER BY CASE severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
               updated_at ASC LIMIT ?
    `).all(Math.max(1, Math.min(500, Number(limit) || 100)));
    return rows.map((row) => this.#row(row));
  }

  verifyCase(defectId) {
    const fixerCase = this.getCase(defectId);
    if (!fixerCase) return { ok: false, defectId, errors: ['case_not_found'] };
    const events = this.db.prepare('SELECT * FROM fixer_events WHERE defect_id = ? ORDER BY seq').all(defectId);
    const errors = [];
    let previous = null;
    for (const event of events) {
      const payload = {
        defectId,
        fromState: event.from_state,
        toState: event.to_state,
        detail: parse(event.detail_json, {}),
        createdAt: event.created_at,
        prevHash: event.prev_hash,
      };
      if (event.prev_hash !== previous) errors.push(`event_${event.seq}_prev_hash`);
      if (sha256(stable(payload)) !== event.event_hash) errors.push(`event_${event.seq}_hash`);
      previous = event.event_hash;
    }
    if (this.#caseHash(fixerCase) !== fixerCase.caseHash) errors.push('case_hash');
    if (events.at(-1)?.to_state !== fixerCase.state) errors.push('state_event_mismatch');
    return { ok: errors.length === 0, defectId, state: fixerCase.state, events: events.length, headHash: previous, errors };
  }

  close() {
    if (!this.db) return;
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch {}
    this.db.close();
    this.db = null;
  }

  async #validateTransition(next, patch) {
    if (next.state === 'reproduced' && !next.reproducer) throw new Error('reproduced requires a reproducer');
    if (next.state === 'isolated' && !next.suspectedBoundary) throw new Error('isolated requires suspectedBoundary');
    if (next.state === 'repair_planned' && (!next.repairOrder || !next.rollback)) throw new Error('repair_planned requires repairOrder and rollback');
    if (next.state === 'leased' && !next.hermesLease?.id) throw new Error('leased requires a Hermès lease id');
    if (next.state === 'patched' && !hasSuccessfulRepairEvidence(patch.evidence)) {
      throw new Error('patched requires successful fresh repair evidence');
    }
    if (next.state === 'exact_path_verified' && !next.evidence.some((item) => item?.type === 'exact_path_verification' && item?.ok === true)) {
      throw new Error('exact_path_verified requires passing exact_path_verification evidence');
    }
    if (next.state === 'regression_encoded' && (next.regression?.passed !== true || !isExistingArtifact(next.regression?.path))) {
      throw new Error('regression_encoded requires an existing nonempty regression artifact with passed=true');
    }
    if (next.state === 'closed') {
      if (typeof next.receiptPath !== 'string' || !next.receiptPath.trim()) {
        throw new Error('closed requires an existing valid receipt with success evidence');
      }
      const read = await readReceipt(next.receiptPath);
      const shape = read.ok ? validateReceiptShape(read.receipt) : { pass: false };
      if (!read.ok || !shape.pass || !receiptHasSuccessEvidence(read.receipt)) {
        throw new Error('closed requires an existing valid receipt with success evidence');
      }
    }
  }

  #appendEvent(defectId, fromState, toState, detail, createdAt = now()) {
    const previous = this.db.prepare('SELECT event_hash FROM fixer_events WHERE defect_id = ? ORDER BY seq DESC LIMIT 1').get(defectId)?.event_hash || null;
    const payload = { defectId, fromState, toState, detail, createdAt, prevHash: previous };
    const eventHash = sha256(stable(payload));
    this.db.prepare(`
      INSERT INTO fixer_events (defect_id, from_state, to_state, detail_json, created_at, prev_hash, event_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(defectId, fromState, toState, json(detail), createdAt, previous, eventHash);
  }

  async #publish(fixerCase, fromState, toState) {
    if (!this.publish) return null;
    return appendPartyLineEvent({
      projectId: 'orange5',
      topic: 'fixer',
      actor: { id: 'orange-fixer', kind: 'agent', displayName: 'Fixer' },
      eventType: toState === 'closed' ? 'receipt' : 'repair',
      status: toState,
      summary: `Fixer ${fixerCase.defectId}: ${fromState ? `${fromState} -> ` : ''}${toState}`,
      detail: { defectId: fixerCase.defectId, runId: fixerCase.runId, severity: fixerCase.severity, attempts: fixerCase.attempts },
      sourceRefs: fixerCase.receiptPath ? [{ uri: fixerCase.receiptPath }] : [],
      tags: ['fixer', fixerCase.severity, toState],
      correlationId: fixerCase.runId,
      importance: fixerCase.severity === 'critical' ? 1 : fixerCase.severity === 'high' ? 0.9 : 0.7,
    }, this.partyLinePath ? { filePath: this.partyLinePath } : {});
  }

  #row(row) {
    return {
      schema: FIXER_SCHEMA,
      defectId: row.defect_id,
      runId: row.run_id,
      source: row.source,
      severity: row.severity,
      state: row.state,
      attempts: row.attempts,
      reproducer: parse(row.reproducer_json),
      suspectedBoundary: row.suspected_boundary,
      repairOrder: parse(row.repair_order_json),
      hermesLease: parse(row.hermes_lease_json),
      evidence: parse(row.evidence_json, []),
      rollback: parse(row.rollback_json),
      regression: parse(row.regression_json),
      receiptPath: row.receipt_path,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      closedAt: row.closed_at,
      caseHash: row.case_hash,
    };
  }

  #caseHash(value) {
    const copy = { ...value };
    delete copy.caseHash;
    return sha256(stable(copy));
  }

  #rehash(defectId) {
    const fixerCase = this.getCase(defectId);
    this.db.prepare('UPDATE fixer_cases SET case_hash = ? WHERE defect_id = ?').run(this.#caseHash(fixerCase), defectId);
  }
}

export const __fixerInternals = Object.freeze({ stable, sha256 });
