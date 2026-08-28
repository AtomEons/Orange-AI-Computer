// graph-weaver/daemon.mjs — tail daemon that turns Æ Cobra flux into a graph.
//
// Pipeline (every TICK_MS):
//   1. Read flux records > watermark per lane (reality / thought / merge)
//      via the existing Æ Cobra reader at ../ae-cobra/flux/reader.mjs.
//   2. For each record: call the entity extractor (qwen3:0.6b via Ollama)
//      to surface {entities:[{type,name,attrs}], edges:[{source_name,predicate,target_name}]}.
//   3. Upsert nodes (embed first sight with nomic-embed-text; bump observed_count + last_seen_at otherwise).
//   4. Insert or reinforce edges (weight bump + evidence append).
//   5. Persist watermarks.
//
// Doctrine:
//   - 10-node 6-edge LOCKED ontology. Anything outside lands in
//     ontology_candidates, never in nodes. Same rule for edges.
//   - Receipt-gated promotion: candidate promoted when referenced by
//     >=5 distinct Receipt nodes OR operator types `promote-ontology <name>`.
//   - Idempotent on restart: watermark = (last_processed_ts, last_processed_hash).
//   - No silent fallback: if Ollama is down, the tick records the failure and
//     advances no watermark (the records will be reprocessed next tick).
//
// Exports:
//   run(opts)        — long-running entrypoint (systemd-friendly).
//   tickOnce(opts)   — single tick, for tests.
//   openDb(opts)     — opens / initializes the SQLite store (tests use this too).
//
// References:
//   schema:   ./schema.sql
//   reader:   ../ae-cobra/flux/reader.mjs
//   ollama:   http://127.0.0.1:11434  (operator's N150 host)

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import Database from '#sqlite';

import { readFlux } from '../ae-cobra/flux/reader.mjs';
import { canonicalFluxRoot } from '../ae-cobra/paths.mjs';

// ---------------------------------------------------------------------------
// constants — locked ontology
// ---------------------------------------------------------------------------

export const NODE_TYPES = Object.freeze([
  'Sovereign', 'Project', 'Mission', 'Lane', 'Model',
  'Tool', 'Service', 'Host', 'Receipt', 'Doctrine',
]);

export const EDGE_PREDICATES = Object.freeze([
  'PROVES', 'REQUIRES', 'BLOCKED_BY',
  'SUPERSEDES', 'APPROVED_BY', 'OBSERVED_BY',
]);

const NODE_TYPE_SET = new Set(NODE_TYPES);
const EDGE_PRED_SET = new Set(EDGE_PREDICATES);
const LANES = Object.freeze(['reality', 'thought', 'merge']);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB        = path.resolve(__dirname, '..', 'graph.db');
const DEFAULT_SCHEMA    = path.resolve(__dirname, 'schema.sql');
const DEFAULT_FLUX_ROOT = canonicalFluxRoot();
const DEFAULT_OLLAMA    = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const DEFAULT_TICK_MS   = 30_000;
const DEFAULT_BATCH     = 500;
const PROMOTION_THRESHOLD = 5;

// ---------------------------------------------------------------------------
// id hashing  (sha256 hex — schema CHECK length 64)
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';

function sha256hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function nodeId(type, name) {
  const n = normalizeName(name);
  return sha256hex(`${n}\x1f${type}`);
}

export function edgeId(sourceId, predicate, targetId) {
  return sha256hex(`${sourceId}\x1f${predicate}\x1f${targetId}`);
}

function normalizeName(name) {
  return String(name).trim().replace(/\s+/g, ' ').toLowerCase();
}

function isoNow() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// db open + init
// ---------------------------------------------------------------------------

export function openDb({ dbPath = DEFAULT_DB, schemaPath = DEFAULT_SCHEMA } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const isFresh = !fs.existsSync(dbPath);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Apply schema if fresh OR if expected tables missing (idempotent CREATE IF NOT EXISTS).
  const need =
    isFresh ||
    !tableExists(db, 'nodes') ||
    !tableExists(db, 'edges') ||
    !tableExists(db, 'watermarks') ||
    !tableExists(db, 'ontology_candidates');

  if (need) {
    if (!fs.existsSync(schemaPath)) {
      throw new Error(`graph-weaver: schema.sql not found at ${schemaPath}`);
    }
    const sql = fs.readFileSync(schemaPath, 'utf8');
    db.exec(sql);
  }
  // Ensure a row per lane in watermarks.
  const ins = db.prepare(`
    INSERT OR IGNORE INTO watermarks (lane, last_processed_ts, last_processed_hash, updated_at)
    VALUES (?, 0, '', ?)
  `);
  for (const lane of LANES) ins.run(lane, isoNow());

  return db;
}

function tableExists(db, name) {
  const row = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`
  ).get(name);
  return !!row;
}

// ---------------------------------------------------------------------------
// watermarks
// ---------------------------------------------------------------------------

export function getWatermarks(db) {
  const rows = db.prepare(`SELECT lane, last_processed_ts, last_processed_hash FROM watermarks`).all();
  const out = {};
  for (const r of rows) {
    out[r.lane] = { ts: r.last_processed_ts || 0, hash: r.last_processed_hash || '' };
  }
  for (const lane of LANES) {
    if (!out[lane]) out[lane] = { ts: 0, hash: '' };
  }
  return out;
}

function setWatermark(db, lane, ts, hash) {
  db.prepare(`
    UPDATE watermarks
       SET last_processed_ts = ?, last_processed_hash = ?, updated_at = ?
     WHERE lane = ?
  `).run(ts, hash || '', isoNow(), lane);
}

// ---------------------------------------------------------------------------
// extractor + embedder (Ollama)
// ---------------------------------------------------------------------------
//
// Both can be replaced for tests via opts.extractor / opts.embedder.
//
// extractor(record) -> {entities, edges, raw?}
// embedder(text)    -> Float32Array(768) | null

const EXTRACTOR_SYSTEM = `You are the Graph Weaver entity extractor for AtomEons.
Given a single flux record (JSON), surface concrete entities and edges relevant
to the 10-node 6-edge ontology. Output a STRICT JSON object only:
{
  "entities": [{"type": "<NodeType>", "name": "<canonical-name>", "attrs": {}}],
  "edges":    [{"source_name": "<name>", "predicate": "<EdgePredicate>", "target_name": "<name>"}]
}
NodeType MUST be one of: Sovereign, Project, Mission, Lane, Model, Tool,
Service, Host, Receipt, Doctrine. If a clearly named real-world thing does
not fit, set type to "Candidate:<your-proposed-type>" and we will route it
to ontology_candidates. Predicate MUST be one of: PROVES, REQUIRES,
BLOCKED_BY, SUPERSEDES, APPROVED_BY, OBSERVED_BY. No prose. JSON only.`;

async function callOllamaChat({ host, model, system, user, signal }) {
  const url = `${host.replace(/\/+$/, '')}/api/chat`;
  const body = {
    model,
    stream: false,
    format: 'json',
    options: { temperature: 0 },
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: user   },
    ],
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`ollama chat ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json();
  return data?.message?.content ?? '';
}

async function callOllamaEmbed({ host, model, input, signal }) {
  const url = `${host.replace(/\/+$/, '')}/api/embeddings`;
  const body = { model, prompt: typeof input === 'string' ? input : JSON.stringify(input) };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`ollama embed ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json();
  const arr = data?.embedding;
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return Float32Array.from(arr);
}

function defaultExtractor({ ollamaHost, model }) {
  return async (record) => {
    const userJson = JSON.stringify(record);
    const raw = await callOllamaChat({
      host: ollamaHost,
      model,
      system: EXTRACTOR_SYSTEM,
      user: userJson,
    });
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { return { entities: [], edges: [], raw }; }
    const entities = Array.isArray(parsed?.entities) ? parsed.entities : [];
    const edges    = Array.isArray(parsed?.edges)    ? parsed.edges    : [];
    return { entities, edges, raw };
  };
}

function defaultEmbedder({ ollamaHost, model }) {
  return async (text) => {
    const vec = await callOllamaEmbed({ host: ollamaHost, model, input: text });
    if (!vec || vec.length !== 768) return null;
    return vec;
  };
}

function embeddingToBlob(vec) {
  if (!vec) return null;
  if (!(vec instanceof Float32Array)) vec = Float32Array.from(vec);
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

// ---------------------------------------------------------------------------
// candidate routing
// ---------------------------------------------------------------------------

function isCandidateNodeType(type) {
  return typeof type === 'string' && type.startsWith('Candidate:');
}

function isCandidateEdgePred(pred) {
  return typeof pred === 'string' && pred.startsWith('Candidate:');
}

function stripCandidatePrefix(t) {
  return t.replace(/^Candidate:/, '').trim();
}

function recordCandidate(db, { kind, proposedType, exampleName, receiptHash }) {
  const now = isoNow();
  const row = db.prepare(`
    SELECT proposed_type, occurrence_count, referencing_receipts_json
      FROM ontology_candidates WHERE proposed_type = ?
  `).get(proposedType);

  if (!row) {
    const refs = receiptHash ? JSON.stringify([receiptHash]) : '[]';
    db.prepare(`
      INSERT INTO ontology_candidates
        (proposed_type, occurrence_count, first_seen_at, last_seen_at, referencing_receipts_json)
      VALUES (?, 1, ?, ?, ?)
    `).run(proposedType, now, now, refs);
    return;
  }
  let refs = [];
  try { refs = JSON.parse(row.referencing_receipts_json || '[]'); } catch {}
  if (receiptHash && !refs.includes(receiptHash)) refs.push(receiptHash);
  db.prepare(`
    UPDATE ontology_candidates
       SET occurrence_count = occurrence_count + 1,
           last_seen_at = ?,
           referencing_receipts_json = ?
     WHERE proposed_type = ?
  `).run(now, JSON.stringify(refs), proposedType);
  // Note: actually flipping `promoted = 1` and extending the locked ontology is
  // a deliberate operator action. The daemon only journals receipt density.
  void kind; void exampleName; void PROMOTION_THRESHOLD;
}

// ---------------------------------------------------------------------------
// node + edge upsert
// ---------------------------------------------------------------------------

function upsertNode(db, { type, name, attrs, embedding, now }) {
  const id = nodeId(type, name);
  const existing = db.prepare(`SELECT id, embedding FROM nodes WHERE id = ?`).get(id);
  if (!existing) {
    db.prepare(`
      INSERT INTO nodes (id, type, name, attrs_json, embedding,
                         created_at, last_seen_at, observed_count, receipt_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(
      id,
      type,
      normalizeName(name),
      JSON.stringify(attrs || {}),
      embeddingToBlob(embedding),
      now,
      now,
      type === 'Receipt' ? 1 : 0,
    );
    return { id, created: true };
  }
  db.prepare(`
    UPDATE nodes
       SET observed_count = observed_count + 1,
           last_seen_at = ?,
           receipt_count = receipt_count + ?,
           embedding = COALESCE(embedding, ?)
     WHERE id = ?
  `).run(now, type === 'Receipt' ? 1 : 0, embeddingToBlob(embedding), id);
  return { id, created: false };
}

function upsertEdge(db, { sourceId, predicate, targetId, evidenceHash, now }) {
  const id = edgeId(sourceId, predicate, targetId);
  const existing = db.prepare(`SELECT id, evidence_json FROM edges WHERE id = ?`).get(id);
  if (!existing) {
    const evidence = evidenceHash ? JSON.stringify([evidenceHash]) : '[]';
    db.prepare(`
      INSERT INTO edges (id, source, predicate, target, weight, created_at, last_observed_at, evidence_json)
      VALUES (?, ?, ?, ?, 1.0, ?, ?, ?)
    `).run(id, sourceId, predicate, targetId, now, now, evidence);
    return { id, created: true };
  }
  let arr = [];
  try { arr = JSON.parse(existing.evidence_json || '[]'); } catch {}
  if (evidenceHash && !arr.includes(evidenceHash)) arr.push(evidenceHash);
  db.prepare(`
    UPDATE edges
       SET weight = weight + 1.0,
           last_observed_at = ?,
           evidence_json = ?
     WHERE id = ?
  `).run(now, JSON.stringify(arr), id);
  return { id, created: false };
}

// ---------------------------------------------------------------------------
// per-record processing
// ---------------------------------------------------------------------------

async function processRecord(db, record, { extractor, embedder, errors }) {
  let extracted;
  try {
    extracted = await extractor(record);
  } catch (err) {
    errors.push({ stage: 'extract', hash: record.hash, msg: err.message });
    return { entities: 0, edges: 0, candidates: 0, ok: false };
  }
  const entities = Array.isArray(extracted?.entities) ? extracted.entities : [];
  const edgeProposals = Array.isArray(extracted?.edges) ? extracted.edges : [];
  const now = isoNow();
  const evidenceHash = record.hash || null;

  // Map of normalized_name -> {id, type, accepted}
  const nameMap = new Map();
  let candidates = 0;
  let nodeCount = 0;

  for (const e of entities) {
    if (!e || typeof e.name !== 'string' || !e.name.trim()) continue;
    const t = String(e.type || '').trim();
    if (isCandidateNodeType(t) || !NODE_TYPE_SET.has(t)) {
      const proposed = isCandidateNodeType(t) ? stripCandidatePrefix(t) : (t || '<unspecified>');
      recordCandidate(db, {
        kind: 'node',
        proposedType: proposed,
        exampleName: e.name,
        receiptHash: evidenceHash,
      });
      candidates += 1;
      continue;
    }
    let embedding = null;
    const existsAlready = db.prepare(`SELECT 1 FROM nodes WHERE id = ?`).get(nodeId(t, e.name));
    if (!existsAlready && embedder) {
      try {
        embedding = await embedder(`${t}: ${e.name}`);
      } catch (err) {
        errors.push({ stage: 'embed', hash: record.hash, msg: err.message });
        embedding = null;
      }
    }
    const { id } = upsertNode(db, {
      type: t, name: e.name, attrs: e.attrs || {}, embedding, now,
    });
    nameMap.set(normalizeName(e.name), { id, type: t });
    nodeCount += 1;
  }

  let edgeCount = 0;
  for (const edge of edgeProposals) {
    if (!edge || !edge.source_name || !edge.target_name) continue;
    const pred = String(edge.predicate || '').trim();
    if (isCandidateEdgePred(pred) || !EDGE_PRED_SET.has(pred)) {
      recordCandidate(db, {
        kind: 'edge',
        proposedType: isCandidateEdgePred(pred) ? stripCandidatePrefix(pred) : (pred || '<unspecified>'),
        exampleName: `${edge.source_name} -> ${edge.target_name}`,
        receiptHash: evidenceHash,
      });
      candidates += 1;
      continue;
    }
    const src = nameMap.get(normalizeName(edge.source_name));
    const tgt = nameMap.get(normalizeName(edge.target_name));
    if (!src || !tgt) {
      // Unresolved endpoint: surface as a candidate so the operator can see
      // dangling edges without silently dropping them.
      recordCandidate(db, {
        kind: 'edge',
        proposedType: `Dangling:${pred}`,
        exampleName: `${edge.source_name} -> ${edge.target_name}`,
        receiptHash: evidenceHash,
      });
      candidates += 1;
      continue;
    }
    upsertEdge(db, {
      sourceId: src.id, predicate: pred, targetId: tgt.id, evidenceHash, now,
    });
    edgeCount += 1;
  }

  return { entities: nodeCount, edges: edgeCount, candidates, ok: true };
}

// ---------------------------------------------------------------------------
// tickOnce — process one batch per lane
// ---------------------------------------------------------------------------

export async function tickOnce(opts = {}) {
  const {
    db = null,
    dbPath = DEFAULT_DB,
    schemaPath = DEFAULT_SCHEMA,
    fluxRoot = DEFAULT_FLUX_ROOT,
    ollamaHost = DEFAULT_OLLAMA,
    chatModel = 'qwen3:0.6b',
    embedModel = 'nomic-embed-text',
    extractor: extractorOverride,
    embedder: embedderOverride,
    batchSize = DEFAULT_BATCH,
    lanes = LANES,
    now = Date.now(),
  } = opts;

  const openedHere = !db;
  const store = db || openDb({ dbPath, schemaPath });
  const extractor = extractorOverride || defaultExtractor({ ollamaHost, model: chatModel });
  const embedder  = embedderOverride  || defaultEmbedder({ ollamaHost, model: embedModel });

  const summary = { lanes: {}, errors: [] };
  const watermarks = getWatermarks(store);

  for (const lane of lanes) {
    if (!LANES.includes(lane)) {
      summary.errors.push({ stage: 'lane', msg: `invalid lane: ${lane}` });
      continue;
    }
    const wm = watermarks[lane] || { ts: 0, hash: '' };
    // readFlux is timestamp-inclusive — bump by 1 ms to avoid replaying the
    // last record. We additionally dedupe on hash inside the loop.
    const startMs = (wm.ts || 0) + (wm.ts ? 1 : 0);
    let records;
    try {
      records = readFlux({
        fluxRoot,
        lanes: [lane],
        startMs,
        endMs: now,
        maxRecords: batchSize,
      });
    } catch (err) {
      summary.errors.push({ stage: 'read', lane, msg: err.message });
      summary.lanes[lane] = { processed: 0, entities: 0, edges: 0, candidates: 0 };
      continue;
    }

    let processed = 0, entities = 0, edges = 0, candidates = 0;
    let lastTs = wm.ts, lastHash = wm.hash;
    const errors = [];

    for (const rec of records) {
      if (!rec || typeof rec.ts !== 'number') continue;
      if (rec.hash && rec.hash === wm.hash) continue; // already seen tail
      const r = await processRecord(store, rec, { extractor, embedder, errors });
      if (!r.ok) {
        // Stop advancing the watermark on this lane — we'll retry next tick.
        break;
      }
      processed += 1;
      entities += r.entities;
      edges += r.edges;
      candidates += r.candidates;
      lastTs = rec.ts;
      lastHash = rec.hash || lastHash;
    }
    if (processed > 0) setWatermark(store, lane, lastTs, lastHash);
    summary.lanes[lane] = { processed, entities, edges, candidates };
    if (errors.length) summary.errors.push(...errors.map(e => ({ ...e, lane })));
  }

  if (openedHere) {
    // Caller didn't pass a db — release it so we don't leak handles in tests.
    store.close();
  }
  return summary;
}

// ---------------------------------------------------------------------------
// run — long-running daemon entrypoint (systemd / pm2)
// ---------------------------------------------------------------------------

export async function run(opts = {}) {
  const tickMs = Number.isFinite(opts.tickMs) ? opts.tickMs : DEFAULT_TICK_MS;
  const log = opts.logger || ((evt) => {
    try { process.stdout.write(JSON.stringify({ ts: isoNow(), ...evt }) + '\n'); }
    catch { /* stdout closed */ }
  });

  const db = openDb({
    dbPath: opts.dbPath || DEFAULT_DB,
    schemaPath: opts.schemaPath || DEFAULT_SCHEMA,
  });

  let stopping = false;
  let activeTick = null;

  function requestStop(signal) {
    if (stopping) return;
    stopping = true;
    log({ evt: 'graph-weaver.stop.requested', signal });
  }
  process.on('SIGTERM', () => requestStop('SIGTERM'));
  process.on('SIGINT',  () => requestStop('SIGINT'));

  log({ evt: 'graph-weaver.start', tickMs, dbPath: opts.dbPath || DEFAULT_DB });

  while (!stopping) {
    const t0 = Date.now();
    try {
      activeTick = tickOnce({ ...opts, db });
      const summary = await activeTick;
      log({ evt: 'graph-weaver.tick', durationMs: Date.now() - t0, ...summary });
    } catch (err) {
      log({ evt: 'graph-weaver.tick.error', msg: err.message, stack: err.stack });
    } finally {
      activeTick = null;
    }
    if (stopping) break;
    const elapsed = Date.now() - t0;
    const wait = Math.max(0, tickMs - elapsed);
    await sleep(wait, () => stopping);
  }

  // Wait for any in-flight tick to drain (cooperative — tickOnce itself is
  // bounded by batchSize, so this returns in well under a tick).
  if (activeTick) {
    try { await activeTick; } catch { /* already logged */ }
  }

  try { db.close(); } catch { /* already closed */ }
  log({ evt: 'graph-weaver.stopped' });
}

function sleep(ms, isCancelled = () => false) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const step = 250;
    let waited = 0;
    const t = setInterval(() => {
      waited += step;
      if (isCancelled() || waited >= ms) {
        clearInterval(t);
        resolve();
      }
    }, Math.min(step, ms)).unref?.();
    if (!t) setTimeout(resolve, ms);
  });
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  run({}).catch((err) => {
    process.stderr.write(`graph-weaver fatal: ${err.stack || err.message}\n`);
    process.exit(1);
  });
}
