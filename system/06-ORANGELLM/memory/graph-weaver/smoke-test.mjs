#!/usr/bin/env bun
// graph-weaver/smoke-test.mjs — end-to-end smoke test for the Graph Weaver
//
// Pipeline under test:
//   Æ Cobra writer  ->  flux/<lane>/<date>.jsonl  ->  daemon.tickOnce  ->
//   graph.db (SQLite via better-sqlite3)  ->  /v1/graph/* route handlers
//
// Run with either:
//   bun memory/graph-weaver/smoke-test.mjs
//   node memory/graph-weaver/smoke-test.mjs
//
// The test deliberately uses DETERMINISTIC stub extractor + embedder. Ollama
// is the production extractor/embedder, but the smoke test must run on a host
// without it (and must produce identical receipts across runs). Both the real
// daemon AND the routes are exercised end-to-end — only the LLM calls are
// stubbed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import { __loopInternals } from '../../../03-BACKEND/learning-loop.mjs';
import {
  openDb,
  tickOnce,
  NODE_TYPES,
  EDGE_PREDICATES,
  nodeId,
} from './daemon.mjs';

import {
  registerGraphRoutes,
  dispatchGraph,
} from '../../server/routes/graph.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// scratch dirs
// ---------------------------------------------------------------------------

const stamp   = Date.now();
const scratch = path.join(os.tmpdir(), `ae-graph-weaver-smoke-${stamp}`);
const fluxRoot = path.join(scratch, 'flux');
const dbPath   = path.join(scratch, 'graph.db');
fs.mkdirSync(fluxRoot, { recursive: true });

console.log(`[smoke] scratch dir       : ${scratch}`);
console.log(`[smoke] flux root         : ${fluxRoot}`);
console.log(`[smoke] graph.db          : ${dbPath}`);

// ---------------------------------------------------------------------------
// deterministic stub extractor + embedder
// ---------------------------------------------------------------------------
//
// Extractor surfaces the entities + edges encoded directly in the test
// records' body.extract field. This mirrors what qwen3:0.6b would return on
// well-formed prompts, without needing Ollama to be running.

async function stubExtractor(record) {
  const ex = record?.body?.extract;
  if (!ex || typeof ex !== 'object') return { entities: [], edges: [] };
  return {
    entities: Array.isArray(ex.entities) ? ex.entities : [],
    edges:    Array.isArray(ex.edges)    ? ex.edges    : [],
  };
}

// Embedder produces a stable 768-float pseudo-vector by hashing the input
// repeatedly. Cosine similarity over these vectors is meaningful enough for
// the search-route assertion.

async function stubEmbedder(text) {
  const vec = new Float32Array(768);
  let seed = crypto.createHash('sha256').update(String(text)).digest();
  for (let i = 0; i < 768; i++) {
    if ((i % 32) === 0) {
      seed = crypto.createHash('sha256').update(seed).digest();
    }
    // Map byte to [-1, 1].
    vec[i] = (seed[i % 32] / 127.5) - 1.0;
  }
  return vec;
}

// ---------------------------------------------------------------------------
// step 1 — write 3 sample flux records via Æ Cobra writer
// ---------------------------------------------------------------------------

const SAMPLE_RECORDS = [
  {
    lane:   'reality',
    origin: 'smoke-test',
    kind:   'receipt.observation',
    body: {
      summary: 'Receipt 1: Orange5 boundary check passed.',
      extract: {
        entities: [
          { type: 'Project',  name: 'Orange5',           attrs: { layer: '06-ORANGELLM' } },
          { type: 'Receipt',  name: 'boundary-check-001', attrs: { result: 'pass' } },
          { type: 'Sovereign', name: 'Atom McCree',       attrs: {} },
        ],
        edges: [
          { source_name: 'boundary-check-001', predicate: 'PROVES',      target_name: 'Orange5' },
          { source_name: 'boundary-check-001', predicate: 'APPROVED_BY', target_name: 'Atom McCree' },
        ],
      },
    },
  },
  {
    lane:   'thought',
    origin: 'smoke-test',
    kind:   'doctrine.note',
    body: {
      summary: 'Receipt 2: Frontier Isolation doctrine reaffirmed.',
      extract: {
        entities: [
          { type: 'Doctrine', name: 'Frontier Isolation', attrs: { version: 'v1' } },
          { type: 'Project',  name: 'Orange5',            attrs: {} },
          { type: 'Receipt',  name: 'doctrine-affirm-002', attrs: {} },
        ],
        edges: [
          { source_name: 'doctrine-affirm-002', predicate: 'PROVES',   target_name: 'Frontier Isolation' },
          { source_name: 'Orange5',             predicate: 'REQUIRES', target_name: 'Frontier Isolation' },
        ],
      },
    },
  },
  {
    lane:   'merge',
    origin: 'smoke-test',
    kind:   'ontology.candidate.probe',
    body: {
      summary: 'Receipt 3: Out-of-ontology type proposal (should route to candidates).',
      extract: {
        entities: [
          // This type is NOT in the locked ontology; it must land in
          // ontology_candidates and NOT in nodes.
          { type: 'Candidate:Cymbal', name: 'Mom is Watching', attrs: {} },
          { type: 'Receipt', name: 'candidate-probe-003', attrs: {} },
        ],
        edges: [
          // Edge endpoint is unresolved (candidate is not a real node), so
          // the daemon should surface a Dangling: candidate as well.
          { source_name: 'candidate-probe-003', predicate: 'OBSERVED_BY', target_name: 'Mom is Watching' },
        ],
      },
    },
  },
];

const writtenHashes = [];
for (const r of SAMPLE_RECORDS) {
  const rec = __loopInternals.appendFlux({ ...r, fluxRoot });
  writtenHashes.push(rec.hash);
  console.log(`[smoke] wrote flux record lane=${r.lane} hash=${rec.hash.slice(0,12)}…`);
}

// ---------------------------------------------------------------------------
// step 2 — init schema + run tickOnce with stubs
// ---------------------------------------------------------------------------

const db = openDb({ dbPath });
console.log('[smoke] schema initialized');

const summary = await tickOnce({
  db,
  fluxRoot,
  extractor: stubExtractor,
  embedder:  stubEmbedder,
  lanes:     ['reality', 'thought', 'merge'],
  batchSize: 100,
  now:       Date.now() + 1_000,
});
console.log('[smoke] tick summary       :', JSON.stringify(summary, null, 2));

// ---------------------------------------------------------------------------
// step 3 — assertions on the DB state
// ---------------------------------------------------------------------------

function fail(msg) {
  console.error(`[smoke][FAIL] ${msg}`);
  try { db.close(); } catch {}
  process.exit(1);
}

function pass(msg) {
  console.log(`[smoke][OK] ${msg}`);
}

const totalErrors = (summary.errors || []).length;
if (totalErrors > 0) {
  fail(`tickOnce returned ${totalErrors} errors: ${JSON.stringify(summary.errors)}`);
}

const nodeCount = db.prepare('SELECT COUNT(*) AS n FROM nodes').get().n;
if (nodeCount < 3) fail(`expected >= 3 nodes inserted, got ${nodeCount}`);
pass(`node count = ${nodeCount} (>= 3)`);

// Specific named nodes must exist with the right types.
const expectedNodes = [
  { type: 'Project',   name: 'Orange5' },
  { type: 'Receipt',   name: 'boundary-check-001' },
  { type: 'Sovereign', name: 'Atom McCree' },
  { type: 'Doctrine',  name: 'Frontier Isolation' },
  { type: 'Receipt',   name: 'doctrine-affirm-002' },
  { type: 'Receipt',   name: 'candidate-probe-003' },
];
for (const en of expectedNodes) {
  const id = nodeId(en.type, en.name);
  const row = db.prepare('SELECT id, type, name FROM nodes WHERE id = ?').get(id);
  if (!row) fail(`expected node missing: type=${en.type} name=${en.name}`);
}
pass(`all ${expectedNodes.length} expected canonical nodes present`);

// Out-of-ontology entity MUST NOT be a node.
const cymbalAsNode = db.prepare(
  `SELECT 1 FROM nodes WHERE name = ? OR name = ?`
).get('mom is watching', 'cymbal');
if (cymbalAsNode) fail('out-of-ontology type "Cymbal" leaked into nodes table');
pass('out-of-ontology type did not leak into nodes table');

// It MUST be in ontology_candidates.
const cymbalCandidate = db.prepare(
  `SELECT * FROM ontology_candidates WHERE proposed_type = ?`
).get('Cymbal');
if (!cymbalCandidate) fail('Cymbal candidate missing from ontology_candidates');
if (cymbalCandidate.occurrence_count < 1) fail(`Cymbal candidate occurrence_count = ${cymbalCandidate.occurrence_count}`);
pass(`Cymbal candidate captured, occurrence_count = ${cymbalCandidate.occurrence_count}`);

// Edges — the two valid Receipt edges from record 1 must exist.
const edgeCount = db.prepare('SELECT COUNT(*) AS n FROM edges').get().n;
if (edgeCount < 2) fail(`expected >= 2 edges, got ${edgeCount}`);
pass(`edge count = ${edgeCount} (>= 2)`);

const provesEdge = db.prepare(`
  SELECT e.predicate, s.name AS src, t.name AS tgt
    FROM edges e
    JOIN nodes s ON s.id = e.source
    JOIN nodes t ON t.id = e.target
   WHERE e.predicate = 'PROVES' AND s.name = 'boundary-check-001' AND t.name = 'orange5'
`).get();
if (!provesEdge) fail('expected PROVES edge (boundary-check-001 -> Orange5) missing');
pass('PROVES edge wired correctly');

// ---------------------------------------------------------------------------
// step 4 — exercise /v1/graph/* route handlers via dispatchGraph
// ---------------------------------------------------------------------------

const OPERATOR_TOKEN = 'smoke-test-op-token-' + crypto.randomBytes(8).toString('hex');
const fakeServer = {}; // no .route() — falls through to dispatch mode
const { ctx } = registerGraphRoutes(fakeServer, {
  db,
  operatorToken: OPERATOR_TOKEN,
  embedder: stubEmbedder,
});

function mkReq(method, headers = {}) {
  return { method, headers };
}

async function route(method, pathname, { query = {}, body = null, headers = {} } = {}) {
  const q = new URLSearchParams(query);
  const req = mkReq(method, headers);
  const res = await dispatchGraph(req, pathname, q, body, ctx);
  if (res === null) {
    return { status: 404, body: { error: { code: 'not_found', message: pathname } } };
  }
  const status = res._ae_http_status || 200;
  const out = { ...res };
  delete out._ae_http_status;
  return { status, body: out };
}

// 4a — GET /v1/graph/nodes
const listAll = await route('GET', '/v1/graph/nodes', { query: { limit: '50' } });
if (listAll.status !== 200) fail(`/v1/graph/nodes returned ${listAll.status}`);
if (!Array.isArray(listAll.body.nodes) || listAll.body.nodes.length < 3) {
  fail(`/v1/graph/nodes returned only ${listAll.body.nodes?.length ?? 0} nodes`);
}
pass(`/v1/graph/nodes returned ${listAll.body.nodes.length} nodes`);

// 4b — GET /v1/graph/nodes?type=Receipt
const listReceipts = await route('GET', '/v1/graph/nodes', { query: { type: 'Receipt' } });
if (listReceipts.status !== 200) fail(`/v1/graph/nodes?type=Receipt status=${listReceipts.status}`);
if (listReceipts.body.nodes.length < 3) {
  fail(`expected >= 3 Receipt nodes, got ${listReceipts.body.nodes.length}`);
}
for (const n of listReceipts.body.nodes) {
  if (n.type !== 'Receipt') fail(`Receipt filter leaked a ${n.type} node`);
}
pass(`/v1/graph/nodes?type=Receipt returned ${listReceipts.body.nodes.length} (all Receipt)`);

// 4c — GET /v1/graph/node/:id
const orange5Id = nodeId('Project', 'Orange5');
const nodeGet = await route('GET', `/v1/graph/node/${orange5Id}`);
if (nodeGet.status !== 200) fail(`/v1/graph/node/:id status=${nodeGet.status}`);
if (nodeGet.body.node.type !== 'Project' || nodeGet.body.node.name !== 'orange5') {
  fail(`/v1/graph/node/:id wrong node: ${JSON.stringify(nodeGet.body.node)}`);
}
pass('/v1/graph/node/:id returns the right node');

// 4d — GET /v1/graph/node/:bad
const nodeBad = await route('GET', '/v1/graph/node/not-a-real-id');
if (nodeBad.status !== 400) fail(`/v1/graph/node/<bad> expected 400, got ${nodeBad.status}`);
pass('/v1/graph/node/:bad returns 400');

// 4e — POST /v1/graph/search (semantic via stub embedder)
const search = await route('POST', '/v1/graph/search', { body: { text: 'orange5', top_k: 5 } });
if (search.status !== 200) fail(`/v1/graph/search status=${search.status}`);
if (search.body.mode !== 'semantic') fail(`expected semantic mode, got ${search.body.mode}`);
if (!Array.isArray(search.body.results) || search.body.results.length === 0) {
  fail('/v1/graph/search returned no results');
}
pass(`/v1/graph/search returned ${search.body.results.length} semantic results`);

// 4f — GET /v1/graph/neighbors/:id  (boundary-check-001 -> {Orange5, Atom McCree})
const receiptId = nodeId('Receipt', 'boundary-check-001');
const neighbors = await route('GET', `/v1/graph/neighbors/${receiptId}`, {
  query: { direction: 'out', depth: '1' },
});
if (neighbors.status !== 200) fail(`/v1/graph/neighbors status=${neighbors.status}`);
if (neighbors.body.nodes.length < 2) {
  fail(`expected >= 2 outbound neighbors, got ${neighbors.body.nodes.length}`);
}
pass(`/v1/graph/neighbors returned ${neighbors.body.nodes.length} neighbors`);

// 4g — GET /v1/graph/path?src=&dst=  (Atom McCree -> Orange5 should be reachable)
const sovereignId = nodeId('Sovereign', 'Atom McCree');
const pathRes = await route('GET', '/v1/graph/path', {
  query: { src: sovereignId, dst: orange5Id },
});
if (pathRes.status !== 200) fail(`/v1/graph/path status=${pathRes.status}`);
if (!pathRes.body.found) fail('/v1/graph/path failed to find Sovereign -> Project path');
pass(`/v1/graph/path found a path of length ${pathRes.body.length}`);

// 4h — GET /v1/graph/ontology-candidates
const cand = await route('GET', '/v1/graph/ontology-candidates');
if (cand.status !== 200) fail(`/v1/graph/ontology-candidates status=${cand.status}`);
if (!cand.body.candidates.some((c) => c.proposed_type === 'Cymbal')) {
  fail('Cymbal candidate missing from /v1/graph/ontology-candidates');
}
const lockedNodes = cand.body.locked_ontology?.nodes || [];
const lockedEdges = cand.body.locked_ontology?.edges || [];
if (lockedNodes.length !== NODE_TYPES.length || lockedEdges.length !== EDGE_PREDICATES.length) {
  fail(`locked ontology mismatch: nodes=${lockedNodes.length} edges=${lockedEdges.length}`);
}
pass(`/v1/graph/ontology-candidates listed Cymbal + reported locked ontology (${lockedNodes.length}n/${lockedEdges.length}e)`);

// 4i — POST /v1/graph/promote-ontology without token => 401
const promoteUnauth = await route('POST', '/v1/graph/promote-ontology', {
  body: { type_name: 'Cymbal' },
});
if (promoteUnauth.status !== 401) {
  fail(`promote-ontology without token expected 401, got ${promoteUnauth.status}`);
}
pass('promote-ontology rejects missing X-Operator-Token (401)');

// 4j — POST /v1/graph/promote-ontology with wrong token => 403
const promoteBad = await route('POST', '/v1/graph/promote-ontology', {
  body: { type_name: 'Cymbal' },
  headers: { 'x-operator-token': 'wrong-token' },
});
if (promoteBad.status !== 403) {
  fail(`promote-ontology with bad token expected 403, got ${promoteBad.status}`);
}
pass('promote-ontology rejects bad X-Operator-Token (403)');

// 4k — POST /v1/graph/promote-ontology with the right token => 200, journal updated
const promoteOk = await route('POST', '/v1/graph/promote-ontology', {
  body: { type_name: 'Cymbal' },
  headers: { 'x-operator-token': OPERATOR_TOKEN, 'x-operator-id': 'smoke-atom' },
});
if (promoteOk.status !== 200) fail(`promote-ontology happy path status=${promoteOk.status}`);
if (!promoteOk.body.promoted) fail('promote-ontology happy path: promoted != true');
const promotedRow = db.prepare(
  `SELECT promoted, promoted_by FROM ontology_candidates WHERE proposed_type = ?`
).get('Cymbal');
if (promotedRow.promoted !== 1) fail('Cymbal row not journaled as promoted in DB');
if (promotedRow.promoted_by !== 'smoke-atom') {
  fail(`promoted_by = ${promotedRow.promoted_by}, expected smoke-atom`);
}
pass('promote-ontology with operator token journals candidate and sets promoted_by');

// ---------------------------------------------------------------------------
// step 5 — idempotency: a second tickOnce should NOT duplicate nodes
// ---------------------------------------------------------------------------

const nodeCountBefore = db.prepare('SELECT COUNT(*) AS n FROM nodes').get().n;
const edgeCountBefore = db.prepare('SELECT COUNT(*) AS n FROM edges').get().n;
await tickOnce({
  db, fluxRoot,
  extractor: stubExtractor, embedder: stubEmbedder,
  batchSize: 100, now: Date.now() + 2_000,
});
const nodeCountAfter = db.prepare('SELECT COUNT(*) AS n FROM nodes').get().n;
const edgeCountAfter = db.prepare('SELECT COUNT(*) AS n FROM edges').get().n;
if (nodeCountAfter !== nodeCountBefore) {
  fail(`second tick changed node count: ${nodeCountBefore} -> ${nodeCountAfter}`);
}
if (edgeCountAfter !== edgeCountBefore) {
  fail(`second tick changed edge count: ${edgeCountBefore} -> ${edgeCountAfter}`);
}
pass('second tickOnce is idempotent (no new nodes/edges)');

// ---------------------------------------------------------------------------
// done
// ---------------------------------------------------------------------------

const candidateCount = db.prepare('SELECT COUNT(*) AS n FROM ontology_candidates').get().n;
try { db.close(); } catch {}

console.log('\n[smoke] ============================================================');
console.log('[smoke] ALL CHECKS PASSED');
console.log('[smoke] ============================================================');
console.log(`[smoke] receipts:`);
console.log(`[smoke]   nodes inserted          : ${nodeCountAfter}`);
console.log(`[smoke]   edges inserted          : ${edgeCountAfter}`);
console.log(`[smoke]   ontology candidates     : ${candidateCount}`);
console.log(`[smoke]   flux records written    : ${writtenHashes.length}`);
console.log(`[smoke]   tick summary lanes      : ${JSON.stringify(summary.lanes)}`);
console.log('[smoke] ============================================================');

// Clean up scratch dir on success — leave it on failure for forensics.
try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
process.exit(0);
