// Audit 02 — Generate 4 stress-test corpora for M19 generalization audit.
// Each corpus has 1,000+ records in the canonical AtomEons receipt schema:
//   { id, action, status, summary, payload_json, created_at }
//
// A — random JSON   : high-entropy strings, varied actions/statuses (kills repetition)
// B — repetitive    : 1,000 identical records (best case)
// C — sparse        : ~80% of non-required fields null
// D — large payloads: each record carries a 1KB random embedded JSON blob

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const OUTDIR = path.join(ROOT, 'corpora');
fs.mkdirSync(OUTDIR, { recursive: true });

// Deterministic seed for reproducibility
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rid(rng) {
  const b = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) b[i] = Math.floor(rng() * 256);
  return 'rcpt_' + b.toString('hex');
}

function randomString(rng, len) {
  // High-entropy: full printable ASCII minus quote/backslash for JSON safety
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .-_';
  let s = '';
  for (let i = 0; i < len; i++) s += charset[Math.floor(rng() * charset.length)];
  return s;
}

function randomISOTime(rng) {
  // Span ~30 days
  const base = Date.UTC(2026, 5, 1);
  const ms = base + Math.floor(rng() * 30 * 86400 * 1000);
  return new Date(ms).toISOString().replace(/\.\d{3}/, '');
}

// ─────────────────────────────────────────────
// Corpus A — random JSON, high entropy
// ─────────────────────────────────────────────
{
  const rng = mulberry32(0xA11CE);
  const lines = [];
  for (let i = 0; i < 1000; i++) {
    // Each record has a unique-ish action and status (random)
    const action = 'act.' + randomString(rng, 6);
    const status = randomString(rng, 4);
    const summary = randomString(rng, 60);
    const payload = {
      f1: randomString(rng, 16),
      f2: Math.floor(rng() * 1e9),
      f3: randomString(rng, 24),
      tag: randomString(rng, 8),
    };
    const r = {
      id: rid(rng),
      action,
      status,
      summary,
      payload_json: JSON.stringify(payload),
      created_at: randomISOTime(rng),
    };
    lines.push(JSON.stringify(r));
  }
  fs.writeFileSync(path.join(OUTDIR, 'A-random.jsonl'), lines.join('\n') + '\n');
}

// ─────────────────────────────────────────────
// Corpus B — repetitive, all identical
// ─────────────────────────────────────────────
{
  const rng = mulberry32(0xB0B);
  const lines = [];
  const fixed = {
    action: 'fixed.action',
    status: 'ok',
    summary: 'identical summary across all records',
    payload_json: JSON.stringify({ k: 'v', n: 42, msg: 'same' }),
    created_at: '2026-06-27T00:00:00Z',
  };
  for (let i = 0; i < 1000; i++) {
    lines.push(JSON.stringify({ id: rid(rng), ...fixed }));
  }
  fs.writeFileSync(path.join(OUTDIR, 'B-repetitive.jsonl'), lines.join('\n') + '\n');
}

// ─────────────────────────────────────────────
// Corpus C — sparse, ~80% null fields
// ─────────────────────────────────────────────
// M19 schema treats every field as required; "null" here = empty string/null value
// We use null for summary and payload_json on ~80% of records.
{
  const rng = mulberry32(0xC0DE);
  const lines = [];
  for (let i = 0; i < 1000; i++) {
    const sparseRoll = rng();
    const r = {
      id: rid(rng),
      action: sparseRoll < 0.8 ? 'sparse.empty' : 'sparse.dense',
      status: sparseRoll < 0.8 ? 'ok' : randomString(rng, 5),
      summary: sparseRoll < 0.8 ? null : randomString(rng, 40),
      payload_json: sparseRoll < 0.8 ? null : JSON.stringify({ a: 1, b: randomString(rng, 12) }),
      created_at: sparseRoll < 0.8 ? '2026-06-27T00:00:00Z' : randomISOTime(rng),
    };
    lines.push(JSON.stringify(r));
  }
  fs.writeFileSync(path.join(OUTDIR, 'C-sparse.jsonl'), lines.join('\n') + '\n');
}

// ─────────────────────────────────────────────
// Corpus D — large embedded payloads (1KB each)
// ─────────────────────────────────────────────
{
  const rng = mulberry32(0xD00D);
  const lines = [];
  for (let i = 0; i < 1000; i++) {
    // Build a payload object that serializes to ~1KB
    const obj = {};
    for (let k = 0; k < 20; k++) {
      obj['field_' + k] = randomString(rng, 40);
    }
    const payload_json = JSON.stringify(obj);
    const r = {
      id: rid(rng),
      action: 'data.upload',
      status: 'ok',
      summary: `record ${i}: ${payload_json.length}B payload`,
      payload_json,
      created_at: randomISOTime(rng),
    };
    lines.push(JSON.stringify(r));
  }
  fs.writeFileSync(path.join(OUTDIR, 'D-large.jsonl'), lines.join('\n') + '\n');
}

// Report sizes
for (const name of ['A-random', 'B-repetitive', 'C-sparse', 'D-large']) {
  const p = path.join(OUTDIR, name + '.jsonl');
  const bytes = fs.statSync(p).size;
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).length;
  console.log(`${name}: ${lines} records, ${bytes} bytes`);
}
