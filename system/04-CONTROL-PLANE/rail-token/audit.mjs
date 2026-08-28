#!/usr/bin/env node
// Orange5 Control Plane — Rail Token Audit Log
// =============================================
// Append-only, hash-chained JSONL ledger of every ORANGEBOX_RAIL_TOKEN
// rotation, leak-detection, and kill-switch event. This is the durable
// receipt surface for the Codexa rail token rotation doctrine.
//
// Sibling artifacts:
//   generate.mjs        - mints raw token (sole place it exists)
//   store-n150.ps1      - DPAPI storage on N150
//   deploy-codexa.ps1   - rsync + systemd reload on Codexa
//   install-schedule.ps1- Task Scheduler + systemd timer install
//   rotate.ps1          - top-level driver that calls into this module
//
// File:
//   state/rail-token-audit.jsonl
//   - One JSON object per line. Append-only. No rewrites, no truncation.
//   - Each line includes a `prev_chain` field equal to sha256 of the
//     PRIOR full line text (including its own prev_chain). The first
//     line uses the genesis constant. This is a forward hash chain:
//     tampering with any earlier line invalidates every subsequent one.
//
// Entry shape (canonical key order — keep stable for chain integrity):
//   {
//     "seq":          <integer, 0-based, monotonic>,
//     "ts":           "<ISO-8601 UTC>",
//     "action":       "rotate" | "leak-detected" | "kill-switch",
//     "prior_sha":    "<hex sha256 of prior token, or null>",
//     "new_sha":      "<hex sha256 of new token, or null>",
//     "sites_updated":["n150-dpapi","codexa-file","atomic-orange-stronghold",...],
//     "status":       "ok" | "partial" | "failed" | "disabled" | "detected",
//     "notes":        "<free-text, NO secret material>" (optional),
//     "prev_chain":   "<sha256 of prior raw line, or GENESIS>",
//     "chain":        "<sha256 of THIS line minus the chain field itself>"
//   }
//
// Hash-chain construction (forward chain):
//   - Build the entry WITHOUT the `chain` field.
//   - Set `prev_chain` = sha256(prior_raw_line_bytes) OR GENESIS for seq=0.
//   - Serialize with JSON.stringify in the canonical order above.
//   - chain = sha256(serialized).
//   - Final raw line = serialized-with-chain-inserted + "\n".
//   - Next call rereads the tail and uses sha256(final-raw-line) as
//     `prev_chain`.
//
// Mom's Law:
//   - Tokens NEVER appear in audit lines. Only sha256 fingerprints.
//   - `notes` is operator-supplied; we redact any 64-hex run that matches
//     the prior_sha/new_sha (defense-in-depth) and refuse any value with
//     base64url-shaped runs >= 32 chars that are not already fingerprints.
//   - Writes are O_APPEND with fsync. We never rewrite history. We never
//     "fix" a bad line — we append a corrective entry.
//   - On chain mismatch when appending, we write a `leak-detected`
//     entry with status="detected" naming the corruption, but we DO NOT
//     refuse to append (the chain itself carries the evidence forward).
//
// Kill-switch:
//   - When ORANGEBOX_RAIL_DISABLED=1, callers (rotate.ps1) should still
//     call appendKillSwitch() so the ledger records the disable event.
//     This module never reads that env itself; it just records what it
//     is told.
//
// CLI:
//   node audit.mjs verify [--file PATH]
//       Walks the chain end-to-end. Exits 0 if intact, 10 if broken,
//       writes a summary to stdout.
//   node audit.mjs tail [--file PATH] [--n N]
//       Prints the last N entries (default 10) as pretty JSON.
//   node audit.mjs append --action ACT --status ST [--prior-sha S] \
//       [--new-sha S] [--sites a,b,c] [--notes "..."] [--file PATH]
//       Convenience wrapper for shell drivers that prefer not to import.
//
// Programmatic API (default export + named):
//   import { appendRotate, appendLeakDetected, appendKillSwitch,
//            verifyChain, readTail, AUDIT_FILE_DEFAULT } from './audit.mjs';
//
// Exit codes (CLI):
//   0  ok
//   2  invalid argument
//   3  io error
//   4  refusing — secret-shaped material detected in notes
//   10 chain verification failed

import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { argv, stdout, stderr, exit, cwd } from 'node:process';
import { fileURLToPath } from 'node:url';

const VERSION = '1.0.0';

// Genesis constant — the `prev_chain` value used for seq=0. Chosen so
// that an empty file cannot accidentally match (sha256 of empty string
// would be too easy to forge as a "fresh start" by anyone who deleted
// the log; this constant must be embedded). 32-byte all-zeros hex is
// load-bearing: anyone restoring from backup who sees a different
// genesis line knows it is not the canonical chain start.
const GENESIS = '0'.repeat(64);

// Canonical key order. JSON.stringify with this exact order is what we
// hash. Do not reorder without bumping a schema version and migrating.
const ENTRY_KEY_ORDER = [
  'seq',
  'ts',
  'action',
  'prior_sha',
  'new_sha',
  'sites_updated',
  'status',
  'notes',
  'prev_chain',
  'chain',
];

const VALID_ACTIONS = new Set(['rotate', 'leak-detected', 'kill-switch']);
const VALID_STATUSES = new Set(['ok', 'partial', 'failed', 'disabled', 'detected']);

// Default path is resolved relative to THIS file so the module is
// portable when imported from rotate.ps1, generate.mjs, or a test.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const AUDIT_FILE_DEFAULT = resolve(__dirname, 'state', 'rail-token-audit.jsonl');

// --------------------------------------------------------------------
// Hashing + serialization
// --------------------------------------------------------------------

function sha256Hex(s) {
  return createHash('sha256').update(s).digest('hex');
}

function isShaHex(s) {
  return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
}

/**
 * Serialize an entry in canonical key order. The `chain` field is
 * inserted last; if `withChain` is false, it is omitted entirely so
 * the caller can hash the remainder and then splice the chain field
 * back in for the final on-disk form.
 */
function serializeCanonical(entry, withChain) {
  const out = {};
  for (const k of ENTRY_KEY_ORDER) {
    if (k === 'chain' && !withChain) continue;
    // Preserve nulls explicitly — they are part of the hashed payload.
    if (k in entry) out[k] = entry[k];
    else if (k === 'notes') {
      // notes is optional; omit when absent so older + newer entries
      // hash consistently. New code SHOULD always set it (even to "").
      continue;
    } else {
      out[k] = null;
    }
  }
  return JSON.stringify(out);
}

// --------------------------------------------------------------------
// Secret-shaped redaction (Mom's Law)
// --------------------------------------------------------------------

/**
 * Reject `notes` that contain anything that looks like raw token
 * material. We allow 64-hex sha256 fingerprints (those are explicitly
 * the audit currency), but reject base64url runs >= 32 chars that are
 * NOT a known fingerprint from this entry.
 */
function refuseIfSecretShaped(notes, knownFingerprints) {
  if (notes == null || notes === '') return;
  if (typeof notes !== 'string') {
    throw new Error('notes must be a string');
  }
  // base64url alphabet, length >= 32 → could be a 24-byte+ token.
  const b64urlRe = /[A-Za-z0-9_-]{32,}/g;
  let m;
  while ((m = b64urlRe.exec(notes)) !== null) {
    const candidate = m[0];
    // sha256 hex (64 chars, all lowercase 0-9a-f) is allowed iff it
    // matches a known fingerprint argument from THIS entry.
    if (/^[0-9a-f]{64}$/.test(candidate) && knownFingerprints.has(candidate)) {
      continue;
    }
    throw Object.assign(
      new Error('refusing to append: notes contains secret-shaped material'),
      { code: 'SECRET_SHAPED', sample_len: candidate.length },
    );
  }
}

// --------------------------------------------------------------------
// File I/O — append-only with fsync
// --------------------------------------------------------------------

function ensureParentDir(filePath) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Read the entire audit file as an array of {raw, parsed} objects.
 * Returns [] if the file does not exist. Tolerates trailing newline.
 * Throws on a malformed line (which would itself be a chain break the
 * caller may want to flag).
 */
function readAllLines(filePath) {
  if (!existsSync(filePath)) return [];
  const text = readFileSync(filePath, 'utf8');
  if (text.length === 0) return [];
  const lines = text.split('\n');
  // Trailing newline produces a final empty element.
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw === '') {
      // Only acceptable as the file's final terminator.
      if (i !== lines.length - 1) {
        throw Object.assign(new Error(`empty line mid-file at line ${i + 1}`), {
          code: 'EMPTY_LINE',
        });
      }
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw Object.assign(new Error(`line ${i + 1} is not valid JSON: ${err.message}`), {
        code: 'BAD_JSON',
        lineNo: i + 1,
      });
    }
    out.push({ raw, parsed, lineNo: i + 1 });
  }
  return out;
}

/**
 * Atomically append a single line (with trailing newline) to the audit
 * file, fsyncing before close. We open with O_APPEND so concurrent
 * writers do not interleave bytes (POSIX guarantee; Windows respects
 * append on file handles created without FILE_SHARE_WRITE conflict on
 * a single short write — these entries are well under PIPE_BUF / page).
 */
function appendLineSync(filePath, line) {
  ensureParentDir(filePath);
  // 'a' mode == O_APPEND. mode 0o600 — operator-only.
  const fd = openSync(filePath, 'a', 0o600);
  try {
    const buf = Buffer.from(line + '\n', 'utf8');
    let written = 0;
    while (written < buf.length) {
      written += writeSync(fd, buf, written, buf.length - written);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// --------------------------------------------------------------------
// Chain construction
// --------------------------------------------------------------------

/**
 * Compute the `prev_chain` value for the next entry, given the existing
 * file contents. For an empty file, returns GENESIS. Otherwise returns
 * sha256(last_raw_line). This is the forward-chain link.
 */
function computePrevChain(existingLines) {
  if (existingLines.length === 0) return GENESIS;
  const tail = existingLines[existingLines.length - 1];
  return sha256Hex(tail.raw);
}

function nextSeq(existingLines) {
  if (existingLines.length === 0) return 0;
  const tail = existingLines[existingLines.length - 1].parsed;
  if (typeof tail.seq !== 'number' || !Number.isInteger(tail.seq) || tail.seq < 0) {
    throw Object.assign(new Error('tail entry has invalid seq'), { code: 'BAD_SEQ' });
  }
  return tail.seq + 1;
}

// --------------------------------------------------------------------
// Public append API
// --------------------------------------------------------------------

/**
 * Append an entry to the audit log. Returns the parsed entry (including
 * the computed `chain`). All callers go through this function so the
 * invariants are enforced in exactly one place.
 *
 * @param {object} opts
 * @param {'rotate'|'leak-detected'|'kill-switch'} opts.action
 * @param {'ok'|'partial'|'failed'|'disabled'|'detected'} opts.status
 * @param {string|null} [opts.prior_sha]
 * @param {string|null} [opts.new_sha]
 * @param {string[]}    [opts.sites_updated]
 * @param {string}      [opts.notes]
 * @param {string}      [opts.file]  - audit file path
 * @param {string}      [opts.ts]    - override timestamp (testing only)
 */
export function appendEntry(opts) {
  if (!opts || typeof opts !== 'object') {
    throw new Error('appendEntry requires an options object');
  }
  const {
    action,
    status,
    prior_sha = null,
    new_sha = null,
    sites_updated = [],
    notes,
    file = AUDIT_FILE_DEFAULT,
    ts = new Date().toISOString(),
  } = opts;

  if (!VALID_ACTIONS.has(action)) {
    throw Object.assign(new Error(`invalid action: ${action}`), { code: 'BAD_ACTION' });
  }
  if (!VALID_STATUSES.has(status)) {
    throw Object.assign(new Error(`invalid status: ${status}`), { code: 'BAD_STATUS' });
  }
  if (prior_sha !== null && !isShaHex(prior_sha)) {
    throw Object.assign(new Error('prior_sha must be 64-hex or null'), { code: 'BAD_SHA' });
  }
  if (new_sha !== null && !isShaHex(new_sha)) {
    throw Object.assign(new Error('new_sha must be 64-hex or null'), { code: 'BAD_SHA' });
  }
  if (!Array.isArray(sites_updated) || sites_updated.some((s) => typeof s !== 'string')) {
    throw Object.assign(new Error('sites_updated must be a string array'), { code: 'BAD_SITES' });
  }

  const knownFps = new Set();
  if (prior_sha) knownFps.add(prior_sha);
  if (new_sha) knownFps.add(new_sha);
  refuseIfSecretShaped(notes, knownFps);

  // Read existing chain. If parsing fails partway, the caller is the
  // rotation driver and should escalate; we do not silently "repair."
  const existing = readAllLines(file);
  const seq = nextSeq(existing);
  const prev_chain = computePrevChain(existing);

  const entryNoChain = { seq, ts, action, prior_sha, new_sha, sites_updated, status };
  if (notes !== undefined) entryNoChain.notes = String(notes);
  entryNoChain.prev_chain = prev_chain;

  const serializedNoChain = serializeCanonical(entryNoChain, false);
  const chain = sha256Hex(serializedNoChain);

  const entry = { ...entryNoChain, chain };
  const finalLine = serializeCanonical(entry, true);

  appendLineSync(file, finalLine);
  return entry;
}

export function appendRotate({ prior_sha, new_sha, sites_updated, status = 'ok', notes, file } = {}) {
  return appendEntry({
    action: 'rotate',
    status,
    prior_sha: prior_sha ?? null,
    new_sha: new_sha ?? null,
    sites_updated: sites_updated ?? [],
    notes,
    file,
  });
}

export function appendLeakDetected({ prior_sha, notes, file } = {}) {
  return appendEntry({
    action: 'leak-detected',
    status: 'detected',
    prior_sha: prior_sha ?? null,
    new_sha: null,
    sites_updated: [],
    notes: notes ?? 'leak-detected: see operator console',
    file,
  });
}

export function appendKillSwitch({ prior_sha, notes, file } = {}) {
  return appendEntry({
    action: 'kill-switch',
    status: 'disabled',
    prior_sha: prior_sha ?? null,
    new_sha: null,
    sites_updated: [],
    notes: notes ?? 'ORANGEBOX_RAIL_DISABLED=1',
    file,
  });
}

// --------------------------------------------------------------------
// Verification + read API
// --------------------------------------------------------------------

/**
 * Walk the entire audit file and verify the forward hash chain.
 *
 * Returns:
 *   { ok: true, count, last_chain, last_seq }
 * or:
 *   { ok: false, count, broken_at_line, reason }
 *
 * Never throws on a chain break — that IS the signal. Throws only on
 * I/O failure or malformed JSON (which is itself a chain break, but
 * we surface it with a clear code).
 */
export function verifyChain({ file = AUDIT_FILE_DEFAULT } = {}) {
  let lines;
  try {
    lines = readAllLines(file);
  } catch (err) {
    return {
      ok: false,
      count: 0,
      broken_at_line: err.lineNo ?? null,
      reason: `${err.code || 'IO_ERR'}: ${err.message}`,
    };
  }

  if (lines.length === 0) {
    return { ok: true, count: 0, last_chain: null, last_seq: -1 };
  }

  let expectedPrevChain = GENESIS;
  let expectedSeq = 0;

  for (let i = 0; i < lines.length; i++) {
    const { raw, parsed, lineNo } = lines[i];

    // Field presence
    for (const k of ['seq', 'ts', 'action', 'prior_sha', 'new_sha', 'sites_updated', 'status', 'prev_chain', 'chain']) {
      if (!(k in parsed)) {
        return { ok: false, count: i, broken_at_line: lineNo, reason: `missing field: ${k}` };
      }
    }

    if (parsed.seq !== expectedSeq) {
      return {
        ok: false,
        count: i,
        broken_at_line: lineNo,
        reason: `seq mismatch: expected ${expectedSeq}, got ${parsed.seq}`,
      };
    }

    if (parsed.prev_chain !== expectedPrevChain) {
      return {
        ok: false,
        count: i,
        broken_at_line: lineNo,
        reason: `prev_chain mismatch: expected ${expectedPrevChain}, got ${parsed.prev_chain}`,
      };
    }

    // Recompute chain over canonical-no-chain payload.
    const recomputed = sha256Hex(serializeCanonical(parsed, false));
    if (recomputed !== parsed.chain) {
      return {
        ok: false,
        count: i,
        broken_at_line: lineNo,
        reason: `chain mismatch: recomputed ${recomputed}, stored ${parsed.chain}`,
      };
    }

    // Also verify the raw on-disk line matches our canonical re-serialization.
    // This catches whitespace tampering and key-reordering edits.
    const canonical = serializeCanonical(parsed, true);
    if (canonical !== raw) {
      return {
        ok: false,
        count: i,
        broken_at_line: lineNo,
        reason: 'raw line does not match canonical serialization (tampering or reorder)',
      };
    }

    expectedPrevChain = sha256Hex(raw);
    expectedSeq = parsed.seq + 1;
  }

  return {
    ok: true,
    count: lines.length,
    last_chain: expectedPrevChain,
    last_seq: expectedSeq - 1,
  };
}

/**
 * Return the last N parsed entries. Does NOT verify the chain — callers
 * that need integrity should run verifyChain separately.
 */
export function readTail({ file = AUDIT_FILE_DEFAULT, n = 10 } = {}) {
  const lines = readAllLines(file);
  return lines.slice(Math.max(0, lines.length - n)).map((l) => l.parsed);
}

// --------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------

function parseCliArgs(args) {
  // args is process.argv.slice(2)
  if (args.length === 0) return { cmd: 'help' };
  const cmd = args[0];
  const flags = {};
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) {
      stderr.write(`error: unexpected positional argument: ${a}\n`);
      exit(2);
    }
    const key = a.slice(2);
    const val = args[i + 1];
    if (val === undefined || val.startsWith('--')) {
      // Boolean flag
      flags[key] = true;
    } else {
      flags[key] = val;
      i++;
    }
  }
  return { cmd, flags };
}

function printHelp() {
  stdout.write(
    `rail-token/audit.mjs v${VERSION}\n` +
      'Commands:\n' +
      '  verify [--file PATH]\n' +
      '  tail   [--file PATH] [--n N]\n' +
      '  append --action ACT --status ST [--prior-sha S] [--new-sha S]\n' +
      '         [--sites a,b,c] [--notes "..."] [--file PATH]\n' +
      '\n' +
      `Default audit file: ${AUDIT_FILE_DEFAULT}\n`,
  );
}

function cliMain() {
  const { cmd, flags } = parseCliArgs(argv.slice(2));

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp();
    return 0;
  }

  if (cmd === 'verify') {
    const result = verifyChain({ file: flags.file });
    stdout.write(JSON.stringify(result, null, 2) + '\n');
    return result.ok ? 0 : 10;
  }

  if (cmd === 'tail') {
    const n = flags.n ? parseInt(flags.n, 10) : 10;
    if (!Number.isFinite(n) || n <= 0) {
      stderr.write('error: --n must be a positive integer\n');
      return 2;
    }
    try {
      const entries = readTail({ file: flags.file, n });
      stdout.write(JSON.stringify(entries, null, 2) + '\n');
      return 0;
    } catch (err) {
      stderr.write(`error: ${err.message}\n`);
      return 3;
    }
  }

  if (cmd === 'append') {
    if (!flags.action) {
      stderr.write('error: --action is required\n');
      return 2;
    }
    if (!flags.status) {
      stderr.write('error: --status is required\n');
      return 2;
    }
    const sites = flags.sites
      ? String(flags.sites)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    try {
      const entry = appendEntry({
        action: flags.action,
        status: flags.status,
        prior_sha: flags['prior-sha'] || null,
        new_sha: flags['new-sha'] || null,
        sites_updated: sites,
        notes: flags.notes,
        file: flags.file,
      });
      // Print sha-only confirmation; do NOT echo notes back.
      stdout.write(
        JSON.stringify({
          seq: entry.seq,
          ts: entry.ts,
          action: entry.action,
          status: entry.status,
          chain: entry.chain,
        }) + '\n',
      );
      return 0;
    } catch (err) {
      if (err.code === 'SECRET_SHAPED') {
        stderr.write(`error: ${err.message} (sample_len=${err.sample_len})\n`);
        return 4;
      }
      stderr.write(`error: ${err.message}\n`);
      return err.code === 'BAD_ACTION' || err.code === 'BAD_STATUS' || err.code === 'BAD_SHA' || err.code === 'BAD_SITES'
        ? 2
        : 3;
    }
  }

  stderr.write(`error: unknown command: ${cmd}\n`);
  printHelp();
  return 2;
}

// Run CLI only when invoked directly, not when imported.
const invokedDirectly = (() => {
  if (!argv[1]) return false;
  try {
    return resolve(argv[1]) === resolve(__filename);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  exit(cliMain());
}

// Default export bundle for ergonomic imports.
export default {
  appendEntry,
  appendRotate,
  appendLeakDetected,
  appendKillSwitch,
  verifyChain,
  readTail,
  AUDIT_FILE_DEFAULT,
  GENESIS,
};
