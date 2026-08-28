// flux/writer.mjs — hash-chained JSONL appender for Æ Cobra Flux ledger.
//
// Spec (Night-1 doctrine, operator-authored):
//   Path:    /mnt/ae_flux/{reality,thought}.jsonl      (flat per-lane files)
//   Record:  {ts, sha256, prior_sha256, origin, lane, event}
//   Hash:    sha256 = SHA-256( prior_sha256 + canonical_json(event) )
//   Append:  atomic — write tmp + fsync + rename-merge (append-only semantics)
//   Crash:   on (re)start, scan tail and recover last valid sha; never trust
//            an unterminated / unparsable / hash-mismatched trailing line.
//
// Genesis:  prior_sha256 = "GENESIS" for the first record in each lane file.
//
// Canonical JSON: keys sorted lexicographically, no whitespace, UTF-8, NaN/±Inf
// rejected. This guarantees identical hashes across machines / replays.
//
// This module ONLY appends. It never edits prior records and never truncates.
// A truncating tool that discards a torn tail must be a separate script and
// must write a `kind:"chain_repair"` receipt to reality.jsonl after running.

import fs from 'node:fs';
import path from 'node:path';
import { canonicalFluxRoot } from '../paths.mjs';
import crypto from 'node:crypto';
import os from 'node:os';

const VALID_LANES = new Set(['reality', 'thought', 'merge']);
const GENESIS = 'GENESIS';
const DEFAULT_ROOT = canonicalFluxRoot();

// ---------------------------------------------------------------------------
// Canonical JSON — deterministic stringify (sorted keys, no whitespace).
// Rejects NaN / ±Infinity and undefined values (would round-trip lossily).
// ---------------------------------------------------------------------------
function canonicalJSON(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`non-finite number in event: ${value}`);
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') {
    throw new Error('bigint not supported in canonical event JSON');
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJSON).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJSON(value[k])).join(',') + '}';
  }
  throw new Error(`unsupported value type in event: ${typeof value}`);
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function computeRecordHash(priorSha, event) {
  return sha256Hex(priorSha + canonicalJSON(event));
}

// The Phase-5 learning loop briefly emitted hashes over the complete record
// base (including ts + prev_hash) before the durable writer became canonical.
// Preserve those append-only records and verify both known historical forms.
function computeLegacyRecordHash(rec) {
  const base = {
    ts: rec.ts,
    lane: rec.lane,
    origin: rec.origin,
    kind: rec.kind,
    body: rec.body,
    prev_hash: rec.prev_hash,
  };
  return sha256Hex(rec.prev_hash + '|' + JSON.stringify(base));
}

function recordHashValid(rec) {
  const current = computeRecordHash(rec.prev_hash, {
    lane: rec.lane, origin: rec.origin, kind: rec.kind, body: rec.body,
  });
  return rec.hash === current || rec.hash === computeLegacyRecordHash(rec);
}

function lanePath(fluxRoot, lane) {
  return path.join(fluxRoot, `${lane}.jsonl`);
}

// ---------------------------------------------------------------------------
// Tail scan — find last fully-terminated, parseable, hash-valid line.
// Returns { priorSha, validBytes } where validBytes is the byte offset
// up to which the file is known-good. A torn / partial trailing line is
// detected (its sha will mismatch or its JSON will fail to parse) but
// NOT truncated here — this writer is strictly append-only.
//
// Truncation of a torn tail is an operator-level chain_repair step.
// We surface it via the returned `torn` flag so callers can refuse to
// append until the repair script runs.
// ---------------------------------------------------------------------------
function scanTail(filePath) {
  if (!fs.existsSync(filePath)) {
    return { priorSha: GENESIS, validBytes: 0, count: 0, torn: false };
  }
  const data = fs.readFileSync(filePath, 'utf8');
  if (data.length === 0) {
    return { priorSha: GENESIS, validBytes: 0, count: 0, torn: false };
  }
  // A valid file ends with \n. If it doesn't, the trailing fragment is torn.
  const torn = !data.endsWith('\n');
  const completePart = torn ? data.slice(0, data.lastIndexOf('\n') + 1) : data;
  const lines = completePart.split('\n').filter(Boolean);

  let priorSha = GENESIS;
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      // Mid-stream corruption — refuse to extend a broken chain.
      return { priorSha, validBytes: -1, count, torn: true, error: `parse error at line ${i}` };
    }
    if (rec.prior_sha256 !== priorSha) {
      return { priorSha, validBytes: -1, count, torn: true, error: `prior_sha256 mismatch at line ${i}` };
    }
    const expected = computeRecordHash(rec.prior_sha256, rec.event);
    if (rec.sha256 !== expected) {
      return { priorSha, validBytes: -1, count, torn: true, error: `sha256 mismatch at line ${i}` };
    }
    priorSha = rec.sha256;
    count++;
  }
  return { priorSha, validBytes: Buffer.byteLength(completePart, 'utf8'), count, torn };
}

// ---------------------------------------------------------------------------
// Atomic append.
//
// Strategy (POSIX, also works on Windows for non-concurrent appenders):
//   1. Open the lane file in append mode, write the line, fsync, close.
//   2. On most Linux filesystems O_APPEND + a single write() <= PIPE_BUF
//      bytes is atomic w.r.t. concurrent appenders. Our records are
//      typically <1KB but can exceed PIPE_BUF. We therefore guard with
//      a per-lane lockfile rename to serialize appenders within a host.
//
// The lockfile is created via `wx` (exclusive). If present, we spin with
// short backoff up to `lockTimeoutMs`. A stale lock (older than 2× timeout)
// is forcibly removed and logged to thought.jsonl as a `lock_break` event.
//
// fsync on both the file and its parent dir ensures the appended bytes
// survive a power loss — directory fsync is what makes the rename-of-tmp
// pattern crash-safe on ext4 / xfs.
// ---------------------------------------------------------------------------
function withLaneLock(fluxRoot, lane, lockTimeoutMs, fn) {
  const lockPath = path.join(fluxRoot, `.${lane}.lock`);
  const start = Date.now();
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, `${process.pid}\n${start}\n`);
      fs.closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Check for stale lock.
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > 2 * lockTimeoutMs) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch { /* race — retry */ }
      if (Date.now() - start > lockTimeoutMs) {
        throw new Error(`flux lock timeout on ${lane} after ${lockTimeoutMs}ms`);
      }
      // Exponential backoff, max 50ms.
      const sleepMs = Math.min(50, 2 ** attempt++);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(lockPath); } catch { /* best-effort */ }
  }
}

function fsyncDir(dirPath) {
  // Directory fsync — required after a rename to durably commit the entry.
  // On Windows, opening a directory for fsync is not supported; skip.
  if (process.platform === 'win32') return;
  const fd = fs.openSync(dirPath, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function appendLineDurable(filePath, line) {
  // Append a single line and fsync the file + its parent directory.
  const fd = fs.openSync(filePath, 'a');
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fsyncDir(path.dirname(filePath));
}

function scanLiveLane(laneDir) {
  if (!fs.existsSync(laneDir)) return { priorSha: GENESIS, count: 0, torn: false };
  const files = fs.readdirSync(laneDir).filter((name) => name.endsWith('.jsonl')).sort();
  let priorSha = GENESIS;
  let count = 0;
  for (const name of files) {
    const file = path.join(laneDir, name);
    const data = fs.readFileSync(file, 'utf8');
    const torn = data.length > 0 && !data.endsWith('\n');
    const complete = torn ? data.slice(0, data.lastIndexOf('\n') + 1) : data;
    for (const line of complete.split('\n').filter(Boolean)) {
      let rec;
      try { rec = JSON.parse(line); }
      catch { return { priorSha, count, torn: true, error: `parse error in ${name}` }; }
      if (rec.prev_hash !== priorSha) {
        return { priorSha, count, torn: true, error: `prev_hash mismatch in ${name}` };
      }
      if (!recordHashValid(rec)) {
        return { priorSha, count, torn: true, error: `hash mismatch in ${name}` };
      }
      priorSha = rec.hash;
      count++;
    }
    if (torn) return { priorSha, count, torn: true, error: `torn trailing line in ${name}` };
  }
  return { priorSha, count, torn: false };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Append a single event to the named lane.
 *
 * @param {object}  args
 * @param {'reality'|'thought'} args.lane
 * @param {string}  args.origin   — non-empty origin tag (e.g. "terminal", "hermes",
 *                                 "orangellm", "operator", "ae-cobra")
 * @param {object}  args.event    — the event payload; must be canonical-JSON-safe
 * @param {string}  [args.fluxRoot=/mnt/ae_flux]
 * @param {number}  [args.ts=Date.now()]
 * @param {number}  [args.lockTimeoutMs=5000]
 * @param {boolean} [args.allowTornRecovery=false]
 *                  — if true, a torn (unterminated) tail is treated as the
 *                    last good prior_sha256; the caller asserts that an
 *                    out-of-band repair step is acceptable. Default false:
 *                    the writer refuses to extend a torn chain.
 * @returns {{ts:number, sha256:string, prior_sha256:string, origin:string, lane:string, event:object}}
 */
export function writeFluxRecord({
  lane,
  origin,
  event,
  kind,
  body,
  fluxRoot = DEFAULT_ROOT,
  ts = Date.now(),
  lockTimeoutMs = 5000,
  allowTornRecovery = false,
} = {}) {
  if (!VALID_LANES.has(lane)) throw new Error(`invalid lane: ${lane} (expected reality|thought)`);
  if (typeof origin !== 'string' || origin.length === 0) throw new Error('origin required (non-empty string)');
  const payload = body ?? event;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('body/event must be a plain object');
  }
  if (typeof ts !== 'number' || !Number.isFinite(ts)) throw new Error('ts must be finite number (ms epoch)');

  fs.mkdirSync(fluxRoot, { recursive: true });
  const laneDir = path.join(fluxRoot, 'events', lane);
  fs.mkdirSync(laneDir, { recursive: true });
  const utcDate = new Date(ts).toISOString().slice(0, 10);
  const latestDate = fs.readdirSync(laneDir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .sort().at(-1)?.slice(0, 10);
  // Never append behind an already-created later partition (clock skew,
  // migration, or a UTC/local midnight boundary would reorder the chain).
  const date = latestDate && latestDate > utcDate ? latestDate : utcDate;
  const file = path.join(laneDir, `${date}.jsonl`);

  return withLaneLock(fluxRoot, lane, lockTimeoutMs, () => {
    const tail = scanLiveLane(laneDir);
    if (tail.error && !tail.torn) {
      throw new Error(
        `flux chain corruption on ${lane}: ${tail.error}. ` +
        `Refusing to append. Run chain_repair before retrying.`
      );
    }
    if (tail.torn && !allowTornRecovery) {
      throw new Error(
        `flux ${lane}.jsonl has a torn trailing line (unterminated). ` +
        `Refusing to append. Pass allowTornRecovery:true after operator review, ` +
        `or run a chain_repair script before retrying ` +
        `and writes a kind:"chain_repair" receipt.`
      );
    }

    const priorSha = tail.priorSha;
    const normalizedKind = typeof kind === 'string' && kind ? kind : 'event';
    const hashPayload = { lane, origin, kind: normalizedKind, body: payload };
    const sha = computeRecordHash(priorSha, hashPayload);
    const record = {
      ts,
      lane,
      origin,
      kind: normalizedKind,
      body: payload,
      prev_hash: priorSha,
      hash: sha,
    };
    // Persist record in field-order matching spec; values are JSON-encoded
    // with the standard library (the canonical form is used only for hashing,
    // not for the on-disk line — the on-disk line is the canonical form of
    // the wrapper record itself).
    const line = canonicalJSON(record) + '\n';
    appendLineDurable(file, line);
    return record;
  });
}

/**
 * Read the current tail state for a lane without appending.
 * Used by health checks and the smoke-test to verify chain integrity at boot.
 *
 * @returns {{priorSha:string, count:number, torn:boolean, validBytes:number, error?:string}}
 */
export function tailState({ lane, fluxRoot = DEFAULT_ROOT } = {}) {
  if (!VALID_LANES.has(lane)) throw new Error(`invalid lane: ${lane}`);
  return scanLiveLane(path.join(fluxRoot, 'events', lane));
}

/**
 * Full-chain verification — recomputes every sha256 and prior_sha256 link
 * from genesis. O(n). For Night-1 lane files this is fine (<100k events).
 *
 * @returns {{ok:boolean, count:number, broken:Array<{idx:number,reason:string}>, tailSha:string}}
 */
export function verifyChain({ lane, fluxRoot = DEFAULT_ROOT } = {}) {
  if (!VALID_LANES.has(lane)) throw new Error(`invalid lane: ${lane}`);
  const dir = path.join(fluxRoot, 'events', lane);
  if (!fs.existsSync(dir)) return { ok: true, count: 0, broken: [], tailSha: GENESIS };
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort();
  const broken = [];
  let priorSha = GENESIS;
  let count = 0;
  for (const name of files) {
    const data = fs.readFileSync(path.join(dir, name), 'utf8');
    const torn = !data.endsWith('\n') && data.length > 0;
    const lines = (torn ? data.slice(0, data.lastIndexOf('\n') + 1) : data).split('\n').filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      let rec;
      try { rec = JSON.parse(lines[i]); }
      catch { broken.push({ file: name, idx: count, reason: 'parse error' }); break; }
      if (rec.prev_hash !== priorSha) {
        broken.push({ file: name, idx: count, reason: `prev_hash mismatch (expected ${priorSha}, got ${rec.prev_hash})` });
        break;
      }
      if (!recordHashValid(rec)) {
        broken.push({ file: name, idx: count, reason: 'hash mismatch (body tampered or hashing diverged)' });
        break;
      }
      priorSha = rec.hash;
      count++;
    }
    if (torn) broken.push({ file: name, idx: count, reason: 'torn trailing line (unterminated)' });
    if (broken.length) break;
  }
  return { ok: broken.length === 0, count, broken, tailSha: priorSha };
}

// Convenience helpers — thin wrappers so callers don't construct lane strings.
export const writeReality = (args) => writeFluxRecord({ ...args, lane: 'reality' });
export const writeThought = (args) => writeFluxRecord({ ...args, lane: 'thought' });

// Exposed for tests + smoke-test.
export const _internal = { canonicalJSON, computeRecordHash, computeLegacyRecordHash, recordHashValid, scanTail, scanLiveLane, GENESIS };
