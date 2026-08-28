import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  WAVE3_KERNEL_MANIFEST_HASH,
  WAVE3_MECHANISMS,
} from './wave3-intelligent-kernel.mjs';

export const WAVE3_KERNEL_STATE_SCHEMA = 'orange.wave3-intelligent-kernel.state-event.v1';
export const WAVE3_KERNEL_UNASSESSED_STATUS = 'unassessed';
export const WAVE3_KERNEL_RECORDED_STATUSES = Object.freeze([
  'research',
  'shadow',
  'active',
  'rejected',
  'superseded',
]);

const STATUS_SET = new Set(WAVE3_KERNEL_RECORDED_STATUSES);
const MECHANISMS_BY_ID = new Map(WAVE3_MECHANISMS.map((mechanism) => [mechanism.id, mechanism]));
const GENESIS_HASH = '0'.repeat(64);
const LOCK_STALE_AFTER_MS = 30_000;
const LOCK_RETRY_MS = 10;
const LOCK_MAX_ATTEMPTS = 200;

const TRANSITIONS = Object.freeze({
  [WAVE3_KERNEL_UNASSESSED_STATUS]: new Set(['research', 'rejected']),
  research: new Set(['research', 'shadow', 'rejected']),
  shadow: new Set(['shadow', 'research', 'active', 'rejected']),
  active: new Set(['active', 'shadow', 'rejected', 'superseded']),
  rejected: new Set(['rejected', 'research']),
  superseded: new Set(['superseded', 'research']),
});

function defaultLedgerPath() {
  if (process.env.ORANGE5_WAVE3_KERNEL_STATE_LEDGER) {
    return resolve(process.env.ORANGE5_WAVE3_KERNEL_STATE_LEDGER);
  }
  const dataRoot = process.env.ORANGEBOX_DATA_ROOT
    ? resolve(process.env.ORANGEBOX_DATA_ROOT)
    : join(homedir(), 'OrangeBox-Data');
  return join(dataRoot, 'orange5', 'wave3-kernel-state.jsonl');
}

export const DEFAULT_WAVE3_KERNEL_STATE_LEDGER = defaultLedgerPath();

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeEvidenceRefs(evidenceRefs) {
  if (!Array.isArray(evidenceRefs)) throw new TypeError('evidenceRefs must be an array');
  const normalized = evidenceRefs.map((reference, index) =>
    requireNonEmptyString(reference, `evidenceRefs[${index}]`));
  return Object.freeze([...new Set(normalized)]);
}

function sleepSync(milliseconds) {
  const gate = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(gate, 0, 0, milliseconds);
}

function acquireLock(ledgerPath) {
  const lockPath = `${ledgerPath}.lock`;
  mkdirSync(dirname(ledgerPath), { recursive: true });

  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt += 1) {
    try {
      const descriptor = openSync(lockPath, 'wx');
      return { descriptor, lockPath };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_AFTER_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch (statError) {
        if (statError?.code !== 'ENOENT') throw statError;
        continue;
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
  throw new Error(`timed out acquiring Wave 3 kernel state ledger lock: ${lockPath}`);
}

function releaseLock(lock) {
  try {
    closeSync(lock.descriptor);
  } finally {
    try {
      unlinkSync(lock.lockPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function eventPayload(event) {
  const { eventHash: _eventHash, ...payload } = event;
  return payload;
}

function validateStoredEvent(event, expectedPreviousHash, lineNumber) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error(`invalid Wave 3 state event at line ${lineNumber}`);
  }
  if (event.schema !== WAVE3_KERNEL_STATE_SCHEMA) {
    throw new Error(`Wave 3 state schema mismatch at line ${lineNumber}`);
  }
  if (!MECHANISMS_BY_ID.has(event.mechanismId)) {
    throw new Error(`unknown Wave 3 mechanism ID at line ${lineNumber}: ${event.mechanismId}`);
  }
  if (event.manifestHash !== WAVE3_KERNEL_MANIFEST_HASH) {
    throw new Error(`Wave 3 manifest mismatch at line ${lineNumber}`);
  }
  if (!STATUS_SET.has(event.status)) {
    throw new Error(`invalid Wave 3 mechanism status at line ${lineNumber}: ${event.status}`);
  }
  if (event.operatorAuthorized !== true) {
    throw new Error(`unauthorized Wave 3 state event at line ${lineNumber}`);
  }
  requireNonEmptyString(event.owner, `line ${lineNumber} owner`);
  requireNonEmptyString(event.invariant, `line ${lineNumber} invariant`);
  requireNonEmptyString(event.enforcementReference, `line ${lineNumber} enforcementReference`);
  requireNonEmptyString(event.falsifier, `line ${lineNumber} falsifier`);
  requireNonEmptyString(event.failureThreshold, `line ${lineNumber} failureThreshold`);
  normalizeEvidenceRefs(event.evidenceRefs);
  requireNonEmptyString(event.authorizedBy, `line ${lineNumber} authorizedBy`);
  requireNonEmptyString(event.timestamp, `line ${lineNumber} timestamp`);
  if (Number.isNaN(Date.parse(event.timestamp))) {
    throw new Error(`invalid Wave 3 state event timestamp at line ${lineNumber}`);
  }
  if (event.previousHash !== expectedPreviousHash) {
    throw new Error(`Wave 3 state hash-chain break at line ${lineNumber}`);
  }
  const expectedEventHash = sha256(eventPayload(event));
  if (event.eventHash !== expectedEventHash) {
    throw new Error(`Wave 3 state event hash mismatch at line ${lineNumber}`);
  }
  return event;
}

export function readWave3KernelStateEvents({ ledgerPath = DEFAULT_WAVE3_KERNEL_STATE_LEDGER } = {}) {
  const resolvedPath = resolve(ledgerPath);
  if (!existsSync(resolvedPath)) return Object.freeze([]);
  const text = readFileSync(resolvedPath, 'utf8');
  if (text.trim().length === 0) return Object.freeze([]);

  const events = [];
  const latestStatusByMechanism = new Map();
  const eventIds = new Set();
  let previousHash = GENESIS_HASH;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim().length === 0) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new Error(`invalid JSON in Wave 3 state ledger at line ${index + 1}: ${error.message}`);
    }
    validateStoredEvent(event, previousHash, index + 1);
    const eventId = requireNonEmptyString(event.eventId, `line ${index + 1} eventId`);
    if (eventIds.has(eventId)) {
      throw new Error(`duplicate Wave 3 state eventId at line ${index + 1}: ${eventId}`);
    }
    const priorStatus = latestStatusByMechanism.get(event.mechanismId) ?? WAVE3_KERNEL_UNASSESSED_STATUS;
    if (!TRANSITIONS[priorStatus]?.has(event.status)) {
      throw new Error(
        `invalid Wave 3 mechanism transition at line ${index + 1}: ${priorStatus} -> ${event.status}`,
      );
    }
    events.push(Object.freeze(event));
    eventIds.add(eventId);
    latestStatusByMechanism.set(event.mechanismId, event.status);
    previousHash = event.eventHash;
  }
  return Object.freeze(events);
}

function latestStatesFromEvents(events) {
  const latest = new Map();
  for (const event of events) latest.set(event.mechanismId, event);
  return latest;
}

function unassessedState(mechanismId) {
  return Object.freeze({
    schema: WAVE3_KERNEL_STATE_SCHEMA,
    mechanismId,
    manifestHash: WAVE3_KERNEL_MANIFEST_HASH,
    status: WAVE3_KERNEL_UNASSESSED_STATUS,
    recorded: false,
  });
}

export function getLatestWave3MechanismState(
  mechanismId,
  { ledgerPath = DEFAULT_WAVE3_KERNEL_STATE_LEDGER, events = null } = {},
) {
  if (!MECHANISMS_BY_ID.has(mechanismId)) {
    throw new Error(`unknown Wave 3 mechanism id: ${mechanismId}`);
  }
  const sourceEvents = events ?? readWave3KernelStateEvents({ ledgerPath });
  return latestStatesFromEvents(sourceEvents).get(mechanismId) ?? unassessedState(mechanismId);
}

export function getLatestWave3KernelStates({ ledgerPath = DEFAULT_WAVE3_KERNEL_STATE_LEDGER } = {}) {
  const events = readWave3KernelStateEvents({ ledgerPath });
  const latest = latestStatesFromEvents(events);
  return Object.freeze(WAVE3_MECHANISMS.map((mechanism) => Object.freeze({
    mechanism,
    state: latest.get(mechanism.id) ?? unassessedState(mechanism.id),
  })));
}

export function hydrateActiveWave3MechanismDescriptors(
  activeMechanismIds,
  { ledgerPath = DEFAULT_WAVE3_KERNEL_STATE_LEDGER } = {},
) {
  if (!Array.isArray(activeMechanismIds)) {
    throw new TypeError('activeMechanismIds must be an array');
  }
  const uniqueIds = [...new Set(activeMechanismIds)];
  const events = readWave3KernelStateEvents({ ledgerPath });
  const latest = latestStatesFromEvents(events);

  return Object.freeze(uniqueIds.map((mechanismId) => {
    const mechanism = MECHANISMS_BY_ID.get(mechanismId);
    if (!mechanism) throw new Error(`unknown Wave 3 mechanism id: ${mechanismId}`);
    const state = latest.get(mechanismId) ?? unassessedState(mechanismId);
    if (state.status !== 'active') {
      throw new Error(`Wave 3 mechanism ${mechanismId} is ${state.status}, not active`);
    }
    return Object.freeze({ ...mechanism, state });
  }));
}

export function appendWave3KernelStateEvent(input, {
  ledgerPath = DEFAULT_WAVE3_KERNEL_STATE_LEDGER,
  operatorAuthorized = false,
} = {}) {
  if (operatorAuthorized !== true) {
    throw new Error('Wave 3 kernel state writes require explicit operatorAuthorized=true');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Wave 3 kernel state input must be an object');
  }

  const mechanismId = requireNonEmptyString(input.mechanismId, 'mechanismId');
  if (!MECHANISMS_BY_ID.has(mechanismId)) {
    throw new Error(`unknown Wave 3 mechanism id: ${mechanismId}`);
  }
  if (input.manifestHash !== undefined && input.manifestHash !== WAVE3_KERNEL_MANIFEST_HASH) {
    throw new Error('Wave 3 kernel manifest mismatch');
  }
  const status = requireNonEmptyString(input.status, 'status');
  if (!STATUS_SET.has(status)) throw new Error(`invalid Wave 3 mechanism status: ${status}`);

  const owner = requireNonEmptyString(input.owner, 'owner');
  const invariant = requireNonEmptyString(input.invariant, 'invariant');
  const enforcementReference = requireNonEmptyString(input.enforcementReference, 'enforcementReference');
  const falsifier = requireNonEmptyString(input.falsifier, 'falsifier');
  const failureThreshold = requireNonEmptyString(input.failureThreshold, 'failureThreshold');
  const evidenceRefs = normalizeEvidenceRefs(input.evidenceRefs ?? []);
  const authorizedBy = requireNonEmptyString(input.authorizedBy, 'authorizedBy');

  if (status === 'active') {
    if (evidenceRefs.length === 0) throw new Error('activation requires at least one evidence reference');
    requireNonEmptyString(enforcementReference, 'activation enforcementReference');
    requireNonEmptyString(falsifier, 'activation falsifier');
  }

  const resolvedPath = resolve(ledgerPath);
  const lock = acquireLock(resolvedPath);
  try {
    const events = readWave3KernelStateEvents({ ledgerPath: resolvedPath });
    const previousEvent = latestStatesFromEvents(events).get(mechanismId);
    const previousStatus = previousEvent?.status ?? WAVE3_KERNEL_UNASSESSED_STATUS;
    if (!TRANSITIONS[previousStatus]?.has(status)) {
      throw new Error(`invalid Wave 3 mechanism transition: ${previousStatus} -> ${status}`);
    }

    const timestamp = input.timestamp === undefined
      ? new Date().toISOString()
      : requireNonEmptyString(input.timestamp, 'timestamp');
    if (Number.isNaN(Date.parse(timestamp))) throw new Error('timestamp must be a valid ISO-compatible date');

    const previousHash = events.at(-1)?.eventHash ?? GENESIS_HASH;
    const payload = {
      schema: WAVE3_KERNEL_STATE_SCHEMA,
      eventId: input.eventId ? requireNonEmptyString(input.eventId, 'eventId') : randomUUID(),
      mechanismId,
      manifestHash: WAVE3_KERNEL_MANIFEST_HASH,
      status,
      owner,
      invariant,
      enforcementReference,
      falsifier,
      failureThreshold,
      evidenceRefs: [...evidenceRefs],
      authorizedBy,
      operatorAuthorized: true,
      previousHash,
      timestamp: new Date(timestamp).toISOString(),
    };
    const event = Object.freeze({ ...payload, eventHash: sha256(payload) });
    appendFileSync(resolvedPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', flag: 'a' });
    return event;
  } finally {
    releaseLock(lock);
  }
}

export function describeWave3KernelStateLedger({ ledgerPath = DEFAULT_WAVE3_KERNEL_STATE_LEDGER } = {}) {
  const events = readWave3KernelStateEvents({ ledgerPath });
  const latest = latestStatesFromEvents(events);
  const statusCounts = Object.fromEntries([
    WAVE3_KERNEL_UNASSESSED_STATUS,
    ...WAVE3_KERNEL_RECORDED_STATUSES,
  ].map((status) => [status, 0]));
  for (const mechanism of WAVE3_MECHANISMS) {
    statusCounts[latest.get(mechanism.id)?.status ?? WAVE3_KERNEL_UNASSESSED_STATUS] += 1;
  }
  return Object.freeze({
    schema: WAVE3_KERNEL_STATE_SCHEMA,
    manifestHash: WAVE3_KERNEL_MANIFEST_HASH,
    ledgerPath: resolve(ledgerPath),
    eventCount: events.length,
    headHash: events.at(-1)?.eventHash ?? GENESIS_HASH,
    statusCounts: Object.freeze(statusCounts),
  });
}
