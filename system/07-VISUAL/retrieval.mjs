// 07-VISUAL/retrieval.mjs — AE Eyes retrieval layer (Pillar 4, visual).
//
// BACKEND ONLY. No UI, no served model, no image generation. This module is
// the ColPali/Qdrant indexing + similarity CONTRACT plus an offline,
// deterministic local stub so the pipeline is testable without Qdrant,
// without ColQwen2.5, and without a network.
//
// Two public functions:
//   indexVisualEvent({ id, caption, embedding?, meta })  → append one
//       visual-event record to the local index (default) OR to the Æ Cobra
//       flux Reality-lane date file (events/reality/<YYYY-MM-DD>.jsonl) when a
//       fluxRoot is supplied. Records are hash-linked (prev_hash → hash) using
//       the documented envelope shape so the local index mirrors the flux
//       ledger contract exactly (see visual-event/README.md §"What gets recorded").
//   searchVisual({ query, k })  → nearest indexed records by cosine similarity
//       over provided or stub embeddings. Deterministic.
//
// Doctrine refs:
//   - AE_ORANGEEYE_FOUNDATION_SPEC.md §2 (Late-Interaction Retrieval / MaxSim),
//     §4.2 (Qdrant orange5-vision collection), §7 (Æ Cobra Reality-lane loop).
//   - visual-event/writer.mjs — the sibling Reality-lane writer this coexists
//     with. That writer records ONE cortex observation; THIS module is the
//     retrieval index (many events, searchable by similarity). Different jobs.
//   - Frontier-Isolation Law: zero network code here. Real embeddings arrive
//     from ColQwen2.5 upstream; when absent we use a deterministic local stub.
//
// CONTRACT (what a real ColPali/Qdrant backend must honor when it replaces the
// stub): the record written by indexVisualEvent is the canonical visual-event
// surface. A production upserter maps { id → Qdrant point id }, embeds the page
// into 196×128-dim Int8 patch vectors, and stores them in the orange5-vision
// collection with distance=Dot + multivector comparator=max_sim. searchVisual's
// cosine-over-vectors is the offline analogue of Qdrant's MaxSim late
// interaction: same shape in (query vector(s) → ranked docs), same shape out.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Embedding dimensionality for the offline stub. Real ColQwen2.5 patches are
// 128-dim; the stub uses the same width so downstream shape assumptions hold.
const STUB_DIM = 128;

// Default local index: self-contained, append-only, offline-safe. Lives under
// 07-VISUAL so it never depends on /mnt/ae_flux being mounted (Windows-safe).
const DEFAULT_INDEX_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  'index',
  'visual-events.jsonl',
);

const GENESIS = 'GENESIS';

// ---------------------------------------------------------------------------
// Deterministic helpers
// ---------------------------------------------------------------------------

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * Canonical JSON — sorted keys, no whitespace, non-finite rejected. Matches the
 * Æ Cobra flux writer's canonicalization so hashes are reproducible across
 * machines and replays.
 */
function canonicalJSON(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`non-finite number in record: ${value}`);
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJSON(value[k])).join(',') + '}';
  }
  throw new Error(`unsupported value type in record: ${typeof value}`);
}

/**
 * stubEmbedding — deterministic unit vector derived from text.
 *
 * Not semantic (this is NOT a real embedding model), but it IS deterministic
 * and stable: identical text → identical vector → cosine similarity 1.0. That
 * gives searchVisual a real, testable ranking signal offline. Different text
 * hashes to a different direction, so unrelated captions score low.
 *
 * Construction: SHA-256 the text repeatedly, unpack bytes into signed floats,
 * fill STUB_DIM components, then L2-normalize. Pure function of the input.
 *
 * @param {string} text
 * @returns {number[]} length STUB_DIM, L2-normalized
 */
export function stubEmbedding(text) {
  const src = isNonEmptyString(text) ? text : '';
  const out = new Array(STUB_DIM);
  let filled = 0;
  let counter = 0;
  while (filled < STUB_DIM) {
    const digest = crypto.createHash('sha256').update(`${src}#${counter++}`, 'utf8').digest();
    for (let b = 0; b < digest.length && filled < STUB_DIM; b++) {
      // Map byte 0..255 → signed float in [-1, 1).
      out[filled++] = (digest[b] - 128) / 128;
    }
  }
  return l2normalize(out);
}

function l2normalize(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum);
  if (norm === 0) return vec.slice();
  const out = new Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

/**
 * cosineSimilarity — dot product of two vectors, each treated as a direction.
 * Vectors are normalized defensively so callers may pass raw (un-normalized)
 * embeddings. Returns 0 for length mismatch or a zero vector (no signal).
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} in [-1, 1]
 */
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const av = isFiniteNumber(a[i]) ? a[i] : 0;
    const bv = isFiniteNumber(b[i]) ? b[i] : 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---------------------------------------------------------------------------
// Index location + record envelope
// ---------------------------------------------------------------------------

function todayUTC() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Resolve the JSONL file this call reads/writes.
 *   - fluxRoot given → the Æ Cobra Reality-lane date file:
 *       <fluxRoot>/events/reality/<YYYY-MM-DD>.jsonl  (matches README + task)
 *   - indexPath given → that exact file
 *   - neither → DEFAULT_INDEX_PATH (local, offline-safe)
 */
function resolveIndexFile({ fluxRoot, indexPath, date } = {}) {
  if (isNonEmptyString(fluxRoot)) {
    const d = isNonEmptyString(date) ? date : todayUTC();
    return path.join(fluxRoot, 'events', 'reality', `${d}.jsonl`);
  }
  if (isNonEmptyString(indexPath)) return indexPath;
  return DEFAULT_INDEX_PATH;
}

/**
 * Read all records from a JSONL index file. Tolerates a torn trailing line
 * (returns only complete, parseable records). Missing file → [].
 */
function readIndex(file) {
  if (!fs.existsSync(file)) return [];
  const data = fs.readFileSync(file, 'utf8');
  if (data.length === 0) return [];
  const lines = data.split('\n').filter(Boolean);
  const recs = [];
  for (const line of lines) {
    try {
      recs.push(JSON.parse(line));
    } catch {
      // torn / partial trailing line — stop; earlier records are still valid.
      break;
    }
  }
  return recs;
}

function lastHash(recs) {
  if (recs.length === 0) return GENESIS;
  const tail = recs[recs.length - 1];
  return isNonEmptyString(tail.hash) ? tail.hash : GENESIS;
}

// ---------------------------------------------------------------------------
// Public: indexVisualEvent
// ---------------------------------------------------------------------------

/**
 * indexVisualEvent — append one visual-event record to the index.
 *
 * The written record mirrors the Æ Cobra Reality-lane envelope documented in
 * visual-event/README.md:
 *   { ts, lane:'reality', origin:'receipt.orangeeye', kind:'visual.index',
 *     body:{ id, caption, embedding, meta }, prev_hash, hash }
 * with hash = SHA-256( prev_hash + canonicalJSON(body) ) — a per-file hash
 * chain so tampering is detectable, same discipline as the flux ledger.
 *
 * The `embedding` stored is the caller's vector when supplied, else a
 * deterministic stub derived from the caption. Either way search is exact and
 * reproducible.
 *
 * @param {object} params
 * @param {string} params.id                 - stable event id (→ Qdrant point id upstream).
 * @param {string} params.caption            - human/cortex caption of the visual.
 * @param {number[]} [params.embedding]      - optional precomputed vector (e.g. from ColQwen2.5).
 * @param {object} [params.meta={}]          - free-form provenance (source, page, doc_id, lane, sha256...).
 * @param {string} [params.fluxRoot]         - write to <fluxRoot>/events/reality/<date>.jsonl instead of local index.
 * @param {string} [params.indexPath]        - explicit JSONL path (overrides default; ignored if fluxRoot set).
 * @param {number} [params.ts=Date.now()]    - epoch ms; override for deterministic tests.
 * @param {string} [params.date]             - YYYY-MM-DD for the flux date file; defaults to today (UTC).
 * @returns {{ts:number, lane:string, origin:string, kind:string, body:object, prev_hash:string, hash:string}}
 */
export function indexVisualEvent({
  id,
  caption,
  embedding,
  meta = {},
  fluxRoot,
  indexPath,
  ts = Date.now(),
  date,
} = {}) {
  if (!isNonEmptyString(id)) throw new Error('indexVisualEvent: id required (non-empty string)');
  if (!isNonEmptyString(caption)) throw new Error('indexVisualEvent: caption required (non-empty string)');
  if (embedding !== undefined) {
    if (!Array.isArray(embedding) || embedding.length === 0 || !embedding.every(isFiniteNumber)) {
      throw new Error('indexVisualEvent: embedding, if provided, must be a non-empty array of finite numbers');
    }
  }
  if (meta !== null && typeof meta !== 'object') {
    throw new Error('indexVisualEvent: meta must be an object');
  }
  if (!isFiniteNumber(ts)) throw new Error('indexVisualEvent: ts must be a finite number (epoch ms)');

  const vec = embedding !== undefined ? embedding.slice() : stubEmbedding(caption);

  const body = {
    id,
    caption,
    embedding: vec,
    embedding_source: embedding !== undefined ? 'provided' : 'stub',
    meta: meta && typeof meta === 'object' ? meta : {},
  };

  const file = resolveIndexFile({ fluxRoot, indexPath, date });
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const existing = readIndex(file);
  const prev_hash = lastHash(existing);
  const hash = sha256Hex(prev_hash + canonicalJSON(body));

  const record = {
    ts,
    lane: 'reality',
    origin: 'receipt.orangeeye',
    kind: 'visual.index',
    body,
    prev_hash,
    hash,
  };

  fs.appendFileSync(file, JSON.stringify(record) + '\n');
  return record;
}

// ---------------------------------------------------------------------------
// Public: searchVisual
// ---------------------------------------------------------------------------

/**
 * searchVisual — nearest indexed visual events to a query, by cosine similarity.
 *
 * Offline analogue of Qdrant MaxSim late interaction: query text (or an
 * explicit query vector) is scored against every indexed record's embedding;
 * the top-k are returned sorted by descending score. Deterministic: same index
 * + same query → same ranking every time.
 *
 * @param {object} params
 * @param {string} [params.query]            - query text; embedded via stub if queryEmbedding absent.
 * @param {number[]} [params.queryEmbedding] - explicit query vector (skips stub; use to mirror a real embed).
 * @param {number} [params.k=5]              - number of results to return.
 * @param {string} [params.fluxRoot]         - read from <fluxRoot>/events/reality/<date>.jsonl instead of local index.
 * @param {string} [params.indexPath]        - explicit JSONL path.
 * @param {string} [params.date]             - YYYY-MM-DD for the flux date file; defaults to today (UTC).
 * @returns {Array<{id:string, caption:string, score:number, meta:object, ts:number}>}
 */
export function searchVisual({
  query,
  queryEmbedding,
  k = 5,
  fluxRoot,
  indexPath,
  date,
} = {}) {
  if (queryEmbedding !== undefined) {
    if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0 || !queryEmbedding.every(isFiniteNumber)) {
      throw new Error('searchVisual: queryEmbedding, if provided, must be a non-empty array of finite numbers');
    }
  } else if (!isNonEmptyString(query)) {
    throw new Error('searchVisual: provide query (string) or queryEmbedding (number[])');
  }
  const topK = isFiniteNumber(k) && k > 0 ? Math.floor(k) : 5;

  const qvec = queryEmbedding !== undefined ? queryEmbedding : stubEmbedding(query);

  const file = resolveIndexFile({ fluxRoot, indexPath, date });
  const recs = readIndex(file);

  const scored = [];
  for (const r of recs) {
    const b = r && r.body;
    if (!b || !Array.isArray(b.embedding)) continue;
    const score = cosineSimilarity(qvec, b.embedding);
    scored.push({
      id: b.id,
      caption: b.caption,
      score,
      meta: b.meta && typeof b.meta === 'object' ? b.meta : {},
      ts: isFiniteNumber(r.ts) ? r.ts : 0,
    });
  }

  // Descending by score; stable tiebreak on id so ties are deterministic.
  scored.sort((x, y) => (y.score - x.score) || String(x.id).localeCompare(String(y.id)));
  return scored.slice(0, topK);
}

// ---------------------------------------------------------------------------
// The CONTRACT surface a real ColPali/Qdrant backend must satisfy.
// Documented, not executed — the stub above stands in until the sidecar lands.
// ---------------------------------------------------------------------------

export const RETRIEVAL_CONTRACT = {
  collection: 'orange5-vision',
  vector: { size: 128, distance: 'Dot', comparator: 'max_sim', datatype: 'uint8' },
  patchesPerPage: 196,
  // What the real upserter does with an indexVisualEvent record:
  upsert: 'map body.id → Qdrant point id; embed page → 196×128 Int8 patches; store with payload {source,page,doc_id,ingested_at,lane}',
  // What the real search does; searchVisual is its offline analogue:
  search: 'embed query tokens via ColQwen2.5 → Qdrant multivector MaxSim → top-k pages + patch coords',
  offlineStub: 'deterministic SHA-256 unit-vector embedding + cosine similarity; same shape in/out as the real path',
};

export const __internal = {
  STUB_DIM,
  DEFAULT_INDEX_PATH,
  GENESIS,
  canonicalJSON,
  l2normalize,
  resolveIndexFile,
  readIndex,
  lastHash,
  todayUTC,
};
