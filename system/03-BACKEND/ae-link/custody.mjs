import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson, hmacHex } from './protocol.mjs';

export const AE_LINK_CUSTODY_SCHEMA = 'ae-link.work-custody.v1';
export const CUSTODY_STATES = Object.freeze({
  OFFERED: 'OFFERED',
  PERSISTED: 'PERSISTED',
  STARTED: 'STARTED',
  CANCEL_REQUESTED: 'CANCEL_REQUESTED',
  TERMINAL: 'TERMINAL',
});

const TERMINAL_OUTCOMES = new Set(['completed', 'failed', 'cancelled']);
const ZERO_HASH = '0'.repeat(64);
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const LOCK_RETRY_MS = 4;
const lockWaitArray = new Int32Array(new SharedArrayBuffer(4));

export class AELinkCustodyError extends Error {
  constructor(message, code = 'CUSTODY_REJECTED') {
    super(message);
    this.name = 'AELinkCustodyError';
    this.code = code;
  }
}

export class AELinkCustodyIntegrityError extends AELinkCustodyError {
  constructor(message) {
    super(message, 'CUSTODY_INTEGRITY_FAILED');
    this.name = 'AELinkCustodyIntegrityError';
  }
}

function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new AELinkCustodyError(`${label} is required`);
  return value.trim();
}

function positiveEpoch(value, label = 'ownerEpoch') {
  if (!Number.isSafeInteger(value) || value < 1) throw new AELinkCustodyError(`${label} must be a positive safe integer`);
  return value;
}

function jsonClone(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    throw new AELinkCustodyError('custody payload must be JSON serializable');
  }
}

function requiredEvidence(value, label = 'orphanEvidence') {
  const evidence = jsonClone(value);
  if (evidence === null || evidence === '' || (Array.isArray(evidence) && evidence.length === 0)) {
    throw new AELinkCustodyError(`${label} is required`, 'ORPHAN_EVIDENCE_REQUIRED');
  }
  if (evidence && typeof evidence === 'object' && !Array.isArray(evidence) && Object.keys(evidence).length === 0) {
    throw new AELinkCustodyError(`${label} is required`, 'ORPHAN_EVIDENCE_REQUIRED');
  }
  return evidence;
}

function boundedMilliseconds(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 60_000) {
    throw new TypeError(`${label} must be an integer from 0 through 60000`);
  }
  return value;
}

function sleepSync(milliseconds) {
  if (milliseconds > 0) Atomics.wait(lockWaitArray, 0, 0, milliseconds);
}

function recordHash(body) {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

function publicWork(work) {
  if (!work) return null;
  return {
    ...structuredClone(work),
    effects: structuredClone(work.effects),
  };
}

/**
 * Durable custody for work accepted across AE Link.
 *
 * The journal is the acknowledgement boundary: callers may acknowledge remote
 * work only after `persist()` returns. External effects may run only after
 * `grantEffect()` returns, making a replay use the same durable effect id.
 */
export class WorkCustodyJournal {
  constructor({
    filePath,
    nodeId,
    integrityKey,
    clock = Date.now,
    lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  }) {
    if (!filePath) throw new TypeError('custody filePath is required');
    this.filePath = path.resolve(filePath);
    this.lockPath = `${this.filePath}.lock`;
    this.nodeId = requiredText(String(nodeId ?? ''), 'nodeId');
    this.integrityKey = requiredText(String(integrityKey ?? ''), 'integrityKey');
    this.clock = clock;
    this.lockTimeoutMs = boundedMilliseconds(lockTimeoutMs, 'lockTimeoutMs');
    this.sequence = 0;
    this.lastHash = ZERO_HASH;
    this.records = [];
    this.work = new Map();
    this.idempotencyKeys = new Map();
    this.fileBytes = null;
    this.#synchronize();
  }

  status(workId) {
    this.#synchronize();
    return publicWork(this.work.get(requiredText(workId, 'workId')));
  }

  list() {
    this.#synchronize();
    return [...this.work.values()].map(publicWork).sort((left, right) => left.workId.localeCompare(right.workId));
  }

  offer({ workId, idempotencyKey, owner, ownerEpoch = 1, payload = {} }) {
    this.#synchronize();
    workId = requiredText(workId, 'workId');
    idempotencyKey = requiredText(idempotencyKey, 'idempotencyKey');
    owner = requiredText(owner, 'owner');
    ownerEpoch = positiveEpoch(ownerEpoch);
    const idempotentWorkId = this.idempotencyKeys.get(idempotencyKey);
    if (idempotentWorkId && idempotentWorkId !== workId) {
      throw new AELinkCustodyError(
        `idempotency key ${idempotencyKey} already belongs to work ${idempotentWorkId}`,
        'IDEMPOTENCY_CONFLICT',
      );
    }
    const existing = this.work.get(workId);
    if (existing) {
      if (existing.idempotencyKey !== idempotencyKey) {
        throw new AELinkCustodyError(`work ${workId} already exists with another idempotency key`, 'IDEMPOTENCY_CONFLICT');
      }
      return { duplicate: true, work: publicWork(existing) };
    }
    return this.#commit({
      event: 'OFFER', workId, idempotencyKey, owner, ownerEpoch,
      fromState: null, toState: CUSTODY_STATES.OFFERED, payload: jsonClone(payload),
    });
  }

  persist({ workId, owner, ownerEpoch }) {
    this.#synchronize();
    const current = this.#owned(workId, owner, ownerEpoch);
    if (current.state !== CUSTODY_STATES.OFFERED) {
      if ([CUSTODY_STATES.PERSISTED, CUSTODY_STATES.STARTED, CUSTODY_STATES.CANCEL_REQUESTED, CUSTODY_STATES.TERMINAL].includes(current.state)) {
        return { duplicate: true, work: publicWork(current) };
      }
      throw new AELinkCustodyError(`work ${current.workId} cannot persist from ${current.state}`);
    }
    return this.#commit(this.#transition(current, 'PERSIST', CUSTODY_STATES.PERSISTED));
  }

  start({ workId, owner, ownerEpoch }) {
    this.#synchronize();
    const current = this.#owned(workId, owner, ownerEpoch);
    if (current.state === CUSTODY_STATES.STARTED) return { duplicate: true, work: publicWork(current) };
    if (current.state !== CUSTODY_STATES.PERSISTED) {
      throw new AELinkCustodyError(`work ${current.workId} cannot start from ${current.state}`, 'START_REJECTED');
    }
    return this.#commit(this.#transition(current, 'START', CUSTODY_STATES.STARTED));
  }

  grantEffect({ workId, owner, ownerEpoch, effectId }) {
    this.#synchronize();
    const current = this.#owned(workId, owner, ownerEpoch);
    effectId = requiredText(effectId, 'effectId');
    const prior = current.effects[effectId];
    if (prior) {
      return {
        duplicate: true,
        granted: prior.status === 'granted',
        resumeIdempotently: prior.status === 'granted',
        resolved: prior.status !== 'granted',
        effectId,
        work: publicWork(current),
      };
    }
    if (current.state !== CUSTODY_STATES.STARTED) {
      throw new AELinkCustodyError(`effect ${effectId} denied while work is ${current.state}`, 'EFFECT_REJECTED');
    }
    const result = this.#commit({
      ...this.#transition(current, 'EFFECT_GRANTED', current.state),
      detail: { effectId },
    });
    return { ...result, granted: true, effectId };
  }

  commitEffect({ workId, owner, ownerEpoch, effectId, evidence }) {
    return this.#resolveEffect({ workId, owner, ownerEpoch, effectId, evidence, resolution: 'committed' });
  }

  abortEffect({ workId, owner, ownerEpoch, effectId, evidence }) {
    return this.#resolveEffect({ workId, owner, ownerEpoch, effectId, evidence, resolution: 'aborted' });
  }

  requestCancel({ workId, owner, ownerEpoch, reason = 'cancel-requested' }) {
    this.#synchronize();
    const current = this.#owned(workId, owner, ownerEpoch);
    reason = requiredText(reason, 'reason');
    if (current.state === CUSTODY_STATES.TERMINAL) {
      if (current.outcome === 'cancelled') return { duplicate: true, work: publicWork(current) };
      throw new AELinkCustodyError(`work ${current.workId} is already terminal`, 'TERMINAL_CONFLICT');
    }
    if (current.state === CUSTODY_STATES.CANCEL_REQUESTED) return { duplicate: true, work: publicWork(current) };
    if ([CUSTODY_STATES.OFFERED, CUSTODY_STATES.PERSISTED].includes(current.state)) {
      return this.#commit({
        ...this.#transition(current, 'CANCEL', CUSTODY_STATES.TERMINAL),
        detail: { reason, outcome: 'cancelled' },
      });
    }
    if (current.state === CUSTODY_STATES.STARTED) {
      return this.#commit({
        ...this.#transition(current, 'CANCEL_REQUEST', CUSTODY_STATES.CANCEL_REQUESTED),
        detail: { reason },
      });
    }
    throw new AELinkCustodyError(`work ${current.workId} cannot cancel from ${current.state}`);
  }

  terminal({ workId, owner, ownerEpoch, outcome, evidence = null }) {
    this.#synchronize();
    const current = this.#owned(workId, owner, ownerEpoch);
    outcome = requiredText(outcome, 'outcome').toLowerCase();
    if (!TERMINAL_OUTCOMES.has(outcome)) throw new AELinkCustodyError(`unsupported terminal outcome: ${outcome}`);
    if (current.state === CUSTODY_STATES.TERMINAL) {
      if (current.outcome === outcome) return { duplicate: true, work: publicWork(current) };
      throw new AELinkCustodyError(`work ${current.workId} already ended as ${current.outcome}`, 'TERMINAL_CONFLICT');
    }
    if (![CUSTODY_STATES.STARTED, CUSTODY_STATES.CANCEL_REQUESTED].includes(current.state)) {
      throw new AELinkCustodyError(`work ${current.workId} cannot end from ${current.state}`);
    }
    if (current.state === CUSTODY_STATES.CANCEL_REQUESTED && outcome !== 'cancelled') {
      throw new AELinkCustodyError('cancel-requested work must close as cancelled', 'CANCEL_OUTCOME_REQUIRED');
    }
    const unresolved = Object.entries(current.effects).filter(([, effect]) => effect.status === 'granted').map(([effectId]) => effectId);
    if (unresolved.length > 0) {
      throw new AELinkCustodyError(`work ${current.workId} has unresolved effects: ${unresolved.join(', ')}`, 'UNRESOLVED_EFFECTS');
    }
    return this.#commit({
      ...this.#transition(current, 'TERMINAL', CUSTODY_STATES.TERMINAL),
      detail: { outcome, evidence: jsonClone(evidence) },
    });
  }

  handoff({ workId, fromOwner, fromEpoch, toOwner, toEpoch }) {
    this.#synchronize();
    const current = this.#required(workId);
    toOwner = requiredText(toOwner, 'toOwner');
    toEpoch = positiveEpoch(toEpoch, 'toEpoch');
    if (this.#isRepeatedOwnershipTransition(current, 'HANDOFF', {
      owner: toOwner,
      ownerEpoch: toEpoch,
      previousOwner: fromOwner,
      previousEpoch: fromEpoch,
    })) {
      return { duplicate: true, work: publicWork(current) };
    }
    this.#assertOwner(current, fromOwner, fromEpoch);
    if (current.state !== CUSTODY_STATES.PERSISTED) {
      throw new AELinkCustodyError(`work ${current.workId} may hand off only while PERSISTED`, 'HANDOFF_REJECTED');
    }
    if (toEpoch <= current.ownerEpoch) throw new AELinkCustodyError('handoff owner epoch must increase', 'STALE_OWNER_EPOCH');
    return this.#commit({
      ...this.#transition(current, 'HANDOFF', CUSTODY_STATES.PERSISTED),
      owner: toOwner,
      ownerEpoch: toEpoch,
      detail: {
        fromOwner: current.owner,
        fromEpoch: current.ownerEpoch,
        previousOwner: current.owner,
        previousEpoch: current.ownerEpoch,
      },
    });
  }

  recover({ workId, newOwner, newEpoch, reason = 'orphan-recovery', orphanEvidence }) {
    this.#synchronize();
    const current = this.#required(workId);
    newOwner = requiredText(newOwner, 'newOwner');
    newEpoch = positiveEpoch(newEpoch, 'newEpoch');
    reason = requiredText(reason, 'reason');
    orphanEvidence = requiredEvidence(orphanEvidence);
    if (this.#isRepeatedOwnershipTransition(current, 'RECOVER', {
      owner: newOwner,
      ownerEpoch: newEpoch,
    })) {
      return { duplicate: true, work: publicWork(current) };
    }
    if (![CUSTODY_STATES.STARTED, CUSTODY_STATES.CANCEL_REQUESTED].includes(current.state)) {
      throw new AELinkCustodyError(`work ${current.workId} is not an orphaned in-flight item`, 'RECOVERY_REJECTED');
    }
    if (newEpoch <= current.ownerEpoch) throw new AELinkCustodyError('recovery owner epoch must increase', 'STALE_OWNER_EPOCH');
    return this.#commit({
      ...this.#transition(
        current,
        'RECOVER',
        current.state === CUSTODY_STATES.CANCEL_REQUESTED
          ? CUSTODY_STATES.CANCEL_REQUESTED
          : CUSTODY_STATES.PERSISTED,
      ),
      owner: newOwner,
      ownerEpoch: newEpoch,
      detail: {
        reason,
        orphanEvidence,
        previousOwner: current.owner,
        previousEpoch: current.ownerEpoch,
        previousState: current.state,
      },
    });
  }

  verify() {
    this.#synchronize({ force: true });
    const replay = new Map();
    const replayIdempotencyKeys = new Map();
    let previousHash = ZERO_HASH;
    let expectedSequence = 1;
    for (const record of this.records) {
      this.#verifyRecord(record, expectedSequence, previousHash);
      this.#applyRecord(record, replay, replayIdempotencyKeys);
      previousHash = record.hash;
      expectedSequence += 1;
    }
    const expected = canonicalJson([...this.work.entries()]);
    const actual = canonicalJson([...replay.entries()]);
    if (expected !== actual) throw new AELinkCustodyIntegrityError('custody replay does not match live state');
    if (canonicalJson([...this.idempotencyKeys.entries()]) !== canonicalJson([...replayIdempotencyKeys.entries()])) {
      throw new AELinkCustodyIntegrityError('custody idempotency index does not match replay');
    }
    return {
      ok: true,
      records: this.records.length,
      workItems: this.work.size,
      terminal: [...this.work.values()].filter((item) => item.state === CUSTODY_STATES.TERMINAL).length,
      lastHash: this.lastHash,
      workRoots: Object.fromEntries([...this.work.values()].map((item) => [item.workId, item.lastRecordHash])),
    };
  }

  #required(workId) {
    workId = requiredText(workId, 'workId');
    const current = this.work.get(workId);
    if (!current) throw new AELinkCustodyError(`unknown work item: ${workId}`, 'WORK_NOT_FOUND');
    return current;
  }

  #owned(workId, owner, ownerEpoch) {
    const current = this.#required(workId);
    this.#assertOwner(current, owner, ownerEpoch);
    return current;
  }

  #assertOwner(current, owner, ownerEpoch) {
    owner = requiredText(owner, 'owner');
    ownerEpoch = positiveEpoch(ownerEpoch);
    if (owner !== current.owner || ownerEpoch !== current.ownerEpoch) {
      throw new AELinkCustodyError(
        `stale owner for ${current.workId}; current owner is ${current.owner}@${current.ownerEpoch}`,
        'STALE_OWNER_EPOCH',
      );
    }
  }

  #isRepeatedOwnershipTransition(current, event, expected) {
    if (current.owner !== expected.owner || current.ownerEpoch !== expected.ownerEpoch) return false;
    const lastRecord = this.records.find((record) => record.hash === current.lastRecordHash);
    if (!lastRecord || lastRecord.event !== event) return false;
    if (expected.previousOwner !== undefined && lastRecord.detail?.previousOwner !== expected.previousOwner) return false;
    if (expected.previousEpoch !== undefined && lastRecord.detail?.previousEpoch !== expected.previousEpoch) return false;
    return true;
  }

  #transition(current, event, toState) {
    return {
      event,
      workId: current.workId,
      idempotencyKey: current.idempotencyKey,
      owner: current.owner,
      ownerEpoch: current.ownerEpoch,
      fromState: current.state,
      toState,
      payload: null,
    };
  }

  #resolveEffect({ workId, owner, ownerEpoch, effectId, evidence, resolution }) {
    this.#synchronize();
    const current = this.#owned(workId, owner, ownerEpoch);
    effectId = requiredText(effectId, 'effectId');
    const prior = current.effects[effectId];
    if (!prior) throw new AELinkCustodyError(`effect ${effectId} has no durable grant`, 'EFFECT_NOT_GRANTED');
    if (prior.status !== 'granted') {
      if (prior.status === resolution) return { duplicate: true, resolved: true, effectId, work: publicWork(current) };
      throw new AELinkCustodyError(`effect ${effectId} already resolved as ${prior.status}`, 'EFFECT_RESOLUTION_CONFLICT');
    }
    if (![CUSTODY_STATES.STARTED, CUSTODY_STATES.CANCEL_REQUESTED].includes(current.state)) {
      throw new AELinkCustodyError(`effect ${effectId} cannot resolve while work is ${current.state}`, 'EFFECT_REJECTED');
    }
    return {
      ...this.#commit({
        ...this.#transition(current, resolution === 'committed' ? 'EFFECT_COMMITTED' : 'EFFECT_ABORTED', current.state),
        detail: { effectId, evidence: jsonClone(evidence) },
      }),
      resolved: true,
      effectId,
    };
  }

  #commit(input) {
    const expectedSequence = this.sequence;
    const expectedLastHash = this.lastHash;
    return this.#withFileLock(() => {
      this.#reload({ allowMissing: expectedSequence === 0 });
      if (this.sequence !== expectedSequence || this.lastHash !== expectedLastHash) {
        throw new AELinkCustodyError(
          'custody journal changed during mutation; retry against the durable head',
          'CUSTODY_CONCURRENT_UPDATE',
        );
      }
      const current = this.work.get(input.workId) ?? null;
      const body = {
        schema: AE_LINK_CUSTODY_SCHEMA,
        sequence: this.sequence + 1,
        at: new Date(this.clock()).toISOString(),
        nodeId: this.nodeId,
        previousHash: this.lastHash,
        workRevision: (current?.revision ?? 0) + 1,
        previousWorkHash: current?.lastRecordHash ?? ZERO_HASH,
        event: input.event,
        workId: input.workId,
        idempotencyKey: input.idempotencyKey,
        owner: input.owner,
        ownerEpoch: input.ownerEpoch,
        fromState: input.fromState,
        toState: input.toState,
        payload: input.payload ?? null,
        detail: input.detail ?? null,
      };
      const hash = recordHash(body);
      const record = { ...body, hash, mac: hmacHex({ ...body, hash }, this.integrityKey) };
      this.#append(record);
      this.#applyRecord(record, this.work, this.idempotencyKeys);
      this.records.push(record);
      this.sequence = record.sequence;
      this.lastHash = record.hash;
      return {
        duplicate: false,
        record: structuredClone(record),
        work: publicWork(this.work.get(record.workId)),
      };
    });
  }

  #synchronize({ force = false } = {}) {
    const observedBytes = fs.existsSync(this.filePath) ? fs.statSync(this.filePath).size : 0;
    if (!force && this.fileBytes !== null && observedBytes === this.fileBytes) return;
    const hadRecords = this.records.length > 0;
    return this.#withFileLock(() => this.#reload({ allowMissing: !hadRecords }));
  }

  #reload({ allowMissing = true } = {}) {
    if (!fs.existsSync(this.filePath) && !allowMissing) {
      throw new AELinkCustodyIntegrityError('custody journal disappeared after it was loaded');
    }
    this.sequence = 0;
    this.lastHash = ZERO_HASH;
    this.records = [];
    this.work = new Map();
    this.idempotencyKeys = new Map();
    this.#load();
    this.fileBytes = fs.existsSync(this.filePath) ? fs.statSync(this.filePath).size : 0;
  }

  #withFileLock(action) {
    const lock = this.#acquireFileLock();
    try {
      return action();
    } finally {
      this.#releaseFileLock(lock);
    }
  }

  #acquireFileLock() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const deadline = Date.now() + this.lockTimeoutMs;
    const token = randomUUID();
    while (true) {
      let descriptor;
      try {
        descriptor = fs.openSync(this.lockPath, 'wx', 0o600);
        fs.writeFileSync(descriptor, `${canonicalJson({
          schema: 'ae-link.custody-lock.v1',
          nodeId: this.nodeId,
          pid: process.pid,
          token,
          createdAt: new Date().toISOString(),
        })}\n`, 'utf8');
        return { descriptor, token };
      } catch (error) {
        if (descriptor !== undefined) {
          fs.closeSync(descriptor);
          fs.rmSync(this.lockPath, { force: true });
        }
        if (error?.code !== 'EEXIST') throw error;
        if (this.#removeStaleLock()) continue;
        if (Date.now() >= deadline) {
          throw new AELinkCustodyError('custody journal is busy', 'CUSTODY_BUSY');
        }
        sleepSync(LOCK_RETRY_MS);
      }
    }
  }

  #removeStaleLock() {
    let document;
    try {
      document = JSON.parse(fs.readFileSync(this.lockPath, 'utf8'));
    } catch {
      try {
        const ageMs = Date.now() - fs.statSync(this.lockPath).mtimeMs;
        if (ageMs < Math.max(30_000, this.lockTimeoutMs * 2)) return false;
      } catch {
        return true;
      }
      fs.rmSync(this.lockPath, { force: true });
      return true;
    }
    if (!Number.isSafeInteger(document?.pid) || document.pid < 1) return false;
    try {
      process.kill(document.pid, 0);
      return false;
    } catch (error) {
      if (error?.code === 'EPERM') return false;
      fs.rmSync(this.lockPath, { force: true });
      return true;
    }
  }

  #releaseFileLock({ descriptor, token }) {
    fs.closeSync(descriptor);
    try {
      const current = JSON.parse(fs.readFileSync(this.lockPath, 'utf8'));
      if (current?.token === token) fs.rmSync(this.lockPath, { force: true });
    } catch {
      // A missing lock means another recovery path already removed it.
    }
  }

  #append(record) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const descriptor = fs.openSync(this.filePath, 'a', 0o600);
    try {
      fs.writeFileSync(descriptor, `${canonicalJson(record)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    this.fileBytes = fs.statSync(this.filePath).size;
  }

  #load() {
    if (!fs.existsSync(this.filePath)) return;
    const text = fs.readFileSync(this.filePath, 'utf8');
    const lines = text.split(/\r?\n/).filter(Boolean);
    let previousHash = ZERO_HASH;
    let expectedSequence = 1;
    for (const line of lines) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        throw new AELinkCustodyIntegrityError(`custody journal line ${expectedSequence} is not valid JSON`);
      }
      this.#verifyRecord(record, expectedSequence, previousHash);
      this.#applyRecord(record, this.work);
      this.records.push(record);
      this.sequence = record.sequence;
      this.lastHash = record.hash;
      previousHash = record.hash;
      expectedSequence += 1;
    }
  }

  #verifyRecord(record, expectedSequence, previousHash) {
    if (!record || record.schema !== AE_LINK_CUSTODY_SCHEMA) throw new AELinkCustodyIntegrityError('custody schema is invalid');
    if (record.sequence !== expectedSequence) throw new AELinkCustodyIntegrityError(`custody sequence ${record.sequence} is not ${expectedSequence}`);
    if (record.nodeId !== this.nodeId) throw new AELinkCustodyIntegrityError(`custody record belongs to ${record.nodeId}`);
    if (record.previousHash !== previousHash) throw new AELinkCustodyIntegrityError('custody hash chain is broken');
    const { hash, mac, ...body } = record;
    if (!/^[a-f0-9]{64}$/.test(hash ?? '') || recordHash(body) !== hash) {
      throw new AELinkCustodyIntegrityError('custody record hash failed');
    }
    if (!/^[a-f0-9]{64}$/.test(mac ?? '') || hmacHex({ ...body, hash }, this.integrityKey) !== mac) {
      throw new AELinkCustodyIntegrityError('custody record authentication failed');
    }
  }

  #applyRecord(record, target, idempotencyKeys = this.idempotencyKeys) {
    const current = target.get(record.workId) ?? null;
    if (record.event === 'OFFER') {
      if (current || record.fromState !== null || record.toState !== CUSTODY_STATES.OFFERED) {
        throw new AELinkCustodyIntegrityError('invalid OFFER transition');
      }
      if (typeof record.idempotencyKey !== 'string' || !record.idempotencyKey) {
        throw new AELinkCustodyIntegrityError('OFFER idempotency key is invalid');
      }
      const idempotentWorkId = idempotencyKeys.get(record.idempotencyKey);
      if (idempotentWorkId && idempotentWorkId !== record.workId) {
        throw new AELinkCustodyIntegrityError(`idempotency key ${record.idempotencyKey} is reused`);
      }
      if ((record.workRevision !== undefined && record.workRevision !== 1)
        || (record.previousWorkHash !== undefined && record.previousWorkHash !== ZERO_HASH)) {
        throw new AELinkCustodyIntegrityError('OFFER work chain is invalid');
      }
      idempotencyKeys.set(record.idempotencyKey, record.workId);
      target.set(record.workId, {
        workId: record.workId,
        idempotencyKey: record.idempotencyKey,
        state: CUSTODY_STATES.OFFERED,
        owner: record.owner,
        ownerEpoch: record.ownerEpoch,
        payload: jsonClone(record.payload),
        effects: {},
        outcome: null,
        terminalResult: null,
        cancelReason: null,
        createdAt: record.at,
        updatedAt: record.at,
        lastSequence: record.sequence,
        revision: record.workRevision ?? 1,
        lastRecordHash: record.hash,
      });
      return;
    }
    if (!current) throw new AELinkCustodyIntegrityError(`${record.event} references unknown work ${record.workId}`);
    if (record.idempotencyKey !== current.idempotencyKey || record.fromState !== current.state) {
      throw new AELinkCustodyIntegrityError(`${record.event} does not continue current custody state`);
    }
    const sameOwner = record.owner === current.owner && record.ownerEpoch === current.ownerEpoch;
    if (!['HANDOFF', 'RECOVER'].includes(record.event) && !sameOwner) {
      throw new AELinkCustodyIntegrityError(`${record.event} uses a stale owner epoch`);
    }
    const nextWorkRevision = current.revision + 1;
    if ((record.workRevision !== undefined && record.workRevision !== nextWorkRevision)
      || (record.previousWorkHash !== undefined && record.previousWorkHash !== current.lastRecordHash)) {
      throw new AELinkCustodyIntegrityError(`${record.event} breaks the per-work journal chain`);
    }

    switch (record.event) {
      case 'PERSIST':
        if (current.state !== CUSTODY_STATES.OFFERED || record.toState !== CUSTODY_STATES.PERSISTED) throw new AELinkCustodyIntegrityError('invalid PERSIST transition');
        current.persistedAt = record.at;
        break;
      case 'START':
        if (current.state !== CUSTODY_STATES.PERSISTED || record.toState !== CUSTODY_STATES.STARTED) throw new AELinkCustodyIntegrityError('invalid START transition');
        current.startedAt = record.at;
        break;
      case 'EFFECT_GRANTED':
        if (current.state !== CUSTODY_STATES.STARTED || record.toState !== CUSTODY_STATES.STARTED) throw new AELinkCustodyIntegrityError('invalid EFFECT_GRANTED transition');
        if (!record.detail?.effectId || current.effects[record.detail.effectId]) throw new AELinkCustodyIntegrityError('duplicate or missing effect grant');
        current.effects[record.detail.effectId] = {
          status: 'granted',
          evidence: null,
          grantOwner: record.owner,
          grantOwnerEpoch: record.ownerEpoch,
          grantSequence: record.sequence,
          grantRecordHash: record.hash,
        };
        break;
      case 'EFFECT_COMMITTED':
      case 'EFFECT_ABORTED': {
        const effectId = record.detail?.effectId;
        if (![CUSTODY_STATES.STARTED, CUSTODY_STATES.CANCEL_REQUESTED].includes(current.state)
          || record.toState !== current.state
          || !effectId
          || current.effects[effectId]?.status !== 'granted') {
          throw new AELinkCustodyIntegrityError(`invalid ${record.event} transition`);
        }
        current.effects[effectId] = {
          ...current.effects[effectId],
          status: record.event === 'EFFECT_COMMITTED' ? 'committed' : 'aborted',
          evidence: jsonClone(record.detail.evidence),
          resolutionSequence: record.sequence,
          resolutionRecordHash: record.hash,
        };
        break;
      }
      case 'CANCEL':
        if (![CUSTODY_STATES.OFFERED, CUSTODY_STATES.PERSISTED].includes(current.state) || record.toState !== CUSTODY_STATES.TERMINAL || record.detail?.outcome !== 'cancelled') {
          throw new AELinkCustodyIntegrityError('invalid pre-start CANCEL transition');
        }
        current.outcome = 'cancelled';
        current.cancelReason = record.detail?.reason ?? 'cancel-requested';
        current.terminalResult = {
          outcome: 'cancelled',
          evidence: null,
          sequence: record.sequence,
          recordHash: record.hash,
          at: record.at,
        };
        break;
      case 'CANCEL_REQUEST':
        if (current.state !== CUSTODY_STATES.STARTED || record.toState !== CUSTODY_STATES.CANCEL_REQUESTED) throw new AELinkCustodyIntegrityError('invalid CANCEL_REQUEST transition');
        current.cancelReason = record.detail?.reason ?? 'cancel-requested';
        break;
      case 'TERMINAL':
        if (![CUSTODY_STATES.STARTED, CUSTODY_STATES.CANCEL_REQUESTED].includes(current.state) || record.toState !== CUSTODY_STATES.TERMINAL || !TERMINAL_OUTCOMES.has(record.detail?.outcome)) {
          throw new AELinkCustodyIntegrityError('invalid TERMINAL transition');
        }
        if (current.state === CUSTODY_STATES.CANCEL_REQUESTED && record.detail.outcome !== 'cancelled') throw new AELinkCustodyIntegrityError('cancel-requested work did not end cancelled');
        if (Object.values(current.effects).some((effect) => effect.status === 'granted')) throw new AELinkCustodyIntegrityError('terminal work contains unresolved effects');
        current.outcome = record.detail.outcome;
        current.terminalResult = {
          outcome: record.detail.outcome,
          evidence: jsonClone(record.detail.evidence),
          sequence: record.sequence,
          recordHash: record.hash,
          at: record.at,
        };
        break;
      case 'HANDOFF':
        if (current.state !== CUSTODY_STATES.PERSISTED || record.toState !== CUSTODY_STATES.PERSISTED || record.ownerEpoch <= current.ownerEpoch) throw new AELinkCustodyIntegrityError('invalid HANDOFF transition');
        if (record.detail?.previousOwner !== undefined
          && (record.detail.previousOwner !== current.owner || record.detail.previousEpoch !== current.ownerEpoch)) {
          throw new AELinkCustodyIntegrityError('HANDOFF predecessor does not match current owner epoch');
        }
        current.owner = record.owner;
        current.ownerEpoch = record.ownerEpoch;
        break;
      case 'RECOVER':
        {
          const hardenedRecovery = record.detail?.orphanEvidence !== undefined;
          const expectedState = current.state === CUSTODY_STATES.CANCEL_REQUESTED
            ? CUSTODY_STATES.CANCEL_REQUESTED
            : CUSTODY_STATES.PERSISTED;
          const compatibleLegacyState = !hardenedRecovery && record.toState === CUSTODY_STATES.PERSISTED;
          if (![CUSTODY_STATES.STARTED, CUSTODY_STATES.CANCEL_REQUESTED].includes(current.state)
            || (!compatibleLegacyState && record.toState !== expectedState)
            || record.ownerEpoch <= current.ownerEpoch) {
            throw new AELinkCustodyIntegrityError('invalid RECOVER transition');
          }
          if (hardenedRecovery
            && (record.detail.previousOwner !== current.owner
              || record.detail.previousEpoch !== current.ownerEpoch
              || record.detail.previousState !== current.state)) {
            throw new AELinkCustodyIntegrityError('RECOVER predecessor does not match current custody');
          }
        }
        current.owner = record.owner;
        current.ownerEpoch = record.ownerEpoch;
        break;
      default:
        throw new AELinkCustodyIntegrityError(`unknown custody event: ${record.event}`);
    }
    current.state = record.toState;
    current.updatedAt = record.at;
    current.lastSequence = record.sequence;
    current.revision = record.workRevision ?? nextWorkRevision;
    current.lastRecordHash = record.hash;
  }
}
