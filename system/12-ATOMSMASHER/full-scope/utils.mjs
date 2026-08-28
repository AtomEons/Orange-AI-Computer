// AtomSmasher Full-Scope — utility helpers
// Faithful Bun port of `atomsmasher_full_scope_v1_0/atomsmasher/utils.py`.

import crypto from 'node:crypto';

// Determinism Unlock (PERFECT_SYNTHESIS Law 1) — primitives.
// Lives in utils.mjs so nowIso() and any downstream module can be deterministic
// when ATOMSMASHER_DETERMINISM_SEED is set, without circular imports through
// engines.mjs.
let __atomsmasher_det_counter = 0;
let __atomsmasher_det_clock = 0;
export function __resetDeterminismCounter() {
  __atomsmasher_det_counter = 0;
  __atomsmasher_det_clock = 0;
}
export function __incDetCounter() {
  __atomsmasher_det_counter += 1;
  return __atomsmasher_det_counter;
}
// nowSeeded() — Date.now() replacement that's deterministic when seeded.
// Monotonic seeded clock: starts at a fixed epoch (2025-01-01T00:00:00Z),
// advances 1ms per call. Identical to Date.now() when env var unset.
export function nowSeeded() {
  if (process.env.ATOMSMASHER_DETERMINISM_SEED) {
    if (__atomsmasher_det_clock === 0) __atomsmasher_det_clock = 1735689600000;
    return __atomsmasher_det_clock++;
  }
  return Date.now();
}

export function nowIso() {
  // datetime.datetime.now(datetime.UTC).replace(microsecond=0).isoformat().replace('+00:00','Z')
  // Determinism Unlock: when ATOMSMASHER_DETERMINISM_SEED is set, anchor on
  // the seeded clock so every receipt/atom/order column that stamps a wall
  // time becomes byte-stable across replay runs.
  return new Date(nowSeeded()).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

export function slugify(text) {
  const s = String(text).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return s || 'item';
}

export function tokenEstimate(text) {
  return Math.max(1, Math.ceil(String(text).length / 4));
}

export function normalize(text) {
  return String(text).trim().toLowerCase().replace(/\s+/g, ' ');
}

export function jdump(obj) {
  return JSON.stringify(obj, sortKeysReplacer(), 2);
}

// Stable canonical JSON: keys sorted at every nesting level.
export function canonicalJson(obj) {
  return JSON.stringify(obj, sortKeysReplacer());
}

function sortKeysReplacer() {
  const seen = new WeakSet();
  return function (key, value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (seen.has(value)) return undefined;
      seen.add(value);
      const sorted = {};
      for (const k of Object.keys(value).sort()) sorted[k] = value[k];
      return sorted;
    }
    return value;
  };
}

export function splitChunks(text, maxChars = 1200) {
  // Heading-aware, then paragraph-aware, then hard split.
  const lines = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const chunks = [];
  let heading = 'root';
  let buf = [];

  const flush = () => {
    if (buf.length === 0) return;
    let block = buf.join('\n').trim();
    buf = [];
    if (!block) return;
    while (block.length > maxChars) {
      let cut = block.lastIndexOf(' ', maxChars);
      if (cut < Math.floor(maxChars / 2)) cut = maxChars;
      chunks.push([heading, block.slice(0, cut).trim()]);
      block = block.slice(cut).trim();
    }
    if (block) chunks.push([heading, block]);
  };

  const HEADING_RE = /^(#{1,6}\s+|[A-Z0-9][A-Z0-9 /:_-]{4,80}$)/;

  for (const line of lines) {
    const stripped = line.trim();
    if (HEADING_RE.test(stripped)) {
      flush();
      const cleaned = stripped.replace(/^#+/, '').trim();
      heading = cleaned || heading;
    } else if (stripped === '') {
      const len = buf.reduce((a, b) => a + b.length, 0);
      if (len > Math.floor(maxChars / 2)) flush();
      else buf.push(line);
    } else {
      buf.push(line);
      const len = buf.reduce((a, b) => a + b.length, 0);
      if (len > maxChars) flush();
    }
  }
  flush();
  return chunks.length > 0 ? chunks : [['root', String(text).slice(0, maxChars)]];
}

export function cosineLike(a, b) {
  // Python: len(a & b) / (len(a) * len(b)) ** 0.5
  if (!(a instanceof Set) || !(b instanceof Set)) return 0.0;
  if (a.size === 0 || b.size === 0) return 0.0;
  let intersect = 0;
  for (const x of a) if (b.has(x)) intersect++;
  return intersect / Math.sqrt(a.size * b.size);
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'what', 'when',
  'where', 'into', 'your', 'you', 'are', 'but', 'not', 'all', 'can', 'will',
  'must', 'only', 'then', 'than',
]);

export function keywords(text) {
  const out = new Set();
  const re = /[a-zA-Z0-9_]{3,}/g;
  const lowered = String(text).toLowerCase();
  let m;
  while ((m = re.exec(lowered)) !== null) {
    if (!STOPWORDS.has(m[0])) out.add(m[0]);
  }
  return out;
}
