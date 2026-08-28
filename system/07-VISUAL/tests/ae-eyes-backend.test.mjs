#!/usr/bin/env bun
// 07-VISUAL/tests/ae-eyes-backend.test.mjs
//
// Standalone Bun harness for the AE Eyes retrieval backend (Pillar 4, visual).
// Verifies retrieval.mjs (indexVisualEvent / searchVisual / stub embedding /
// cosine / hash chain) and bridge.mjs (toStructuredText over all three source
// types + graceful degradation). Offline, deterministic, no network, no UI.
//
// Run:  bun 07-VISUAL/tests/ae-eyes-backend.test.mjs
// Emits a final line:  Summary: N pass / M fail of T

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  indexVisualEvent,
  searchVisual,
  stubEmbedding,
  cosineSimilarity,
  RETRIEVAL_CONTRACT,
  __internal as R,
} from '../retrieval.mjs';

import {
  toStructuredText,
  SOURCE_TYPES,
  ENVELOPE_KINDS,
} from '../bridge.mjs';

let pass = 0;
let fail = 0;
const failures = [];
function check(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  PASS ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(`  FAIL ${msg}`);
  }
}
function throws(fn, msg) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  check(threw, msg);
}

// Disposable index file per run — never touches the repo's index dir.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-eyes-'));
const indexPath = path.join(tmpDir, 'visual-events.jsonl');

console.log('[ae-eyes-backend] retrieval.mjs');

// --- stub embedding: deterministic, unit-norm, correct dim ------------------
{
  const e1 = stubEmbedding('a bar chart of Q4 revenue');
  const e2 = stubEmbedding('a bar chart of Q4 revenue');
  const e3 = stubEmbedding('a login form with two fields');
  check(e1.length === R.STUB_DIM, `stub embedding dim === ${R.STUB_DIM}`);
  check(JSON.stringify(e1) === JSON.stringify(e2), 'stub embedding is deterministic (same text → same vector)');
  const norm = Math.sqrt(e1.reduce((s, x) => s + x * x, 0));
  check(Math.abs(norm - 1) < 1e-9, 'stub embedding is L2-normalized');
  check(cosineSimilarity(e1, e2) > 0.999999, 'identical captions → cosine ≈ 1.0');
  check(cosineSimilarity(e1, e3) < 0.9, 'unrelated captions → cosine noticeably < 1');
}

// --- cosine edge cases ------------------------------------------------------
{
  check(cosineSimilarity([1, 0, 0], [1, 0, 0]) === 1, 'cosine of identical unit vec === 1');
  check(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-12, 'orthogonal vectors → cosine 0');
  check(cosineSimilarity([1, 2, 3], [1, 2]) === 0, 'length mismatch → 0 (no signal)');
  check(cosineSimilarity([0, 0], [1, 1]) === 0, 'zero vector → 0 (no divide-by-zero)');
  check(Math.abs(cosineSimilarity([2, 0], [5, 0]) - 1) < 1e-12, 'un-normalized parallel vectors → cosine 1');
}

// --- indexVisualEvent: validation ------------------------------------------
throws(() => indexVisualEvent({ caption: 'x', indexPath }), 'index rejects missing id');
throws(() => indexVisualEvent({ id: 'a', indexPath }), 'index rejects missing caption');
throws(() => indexVisualEvent({ id: 'a', caption: 'x', embedding: [], indexPath }), 'index rejects empty embedding array');
throws(() => indexVisualEvent({ id: 'a', caption: 'x', embedding: [1, 'nope'], indexPath }), 'index rejects non-numeric embedding');
throws(() => indexVisualEvent({ id: 'a', caption: 'x', embedding: [1, NaN], indexPath }), 'index rejects non-finite embedding');

// --- indexVisualEvent: write + envelope shape + hash chain ------------------
{
  const r1 = indexVisualEvent({
    id: 'evt-1',
    caption: 'dashboard screenshot with revenue bar chart',
    meta: { source: 'ui', doc_id: 'doc-dash-1' },
    indexPath,
    ts: 1_000,
  });
  check(r1.lane === 'reality' && r1.origin === 'receipt.orangeeye' && r1.kind === 'visual.index', 'record envelope: lane/origin/kind fixed');
  check(r1.prev_hash === R.GENESIS, 'first record prev_hash === GENESIS');
  check(/^[0-9a-f]{64}$/.test(r1.hash), 'record hash is 64-char hex');
  check(r1.body.embedding_source === 'stub', 'no embedding supplied → embedding_source "stub"');
  check(Array.isArray(r1.body.embedding) && r1.body.embedding.length === R.STUB_DIM, 'stub embedding stored at STUB_DIM');

  const r2 = indexVisualEvent({
    id: 'evt-2',
    caption: 'a login form with username and password fields',
    embedding: stubEmbedding('a login form with username and password fields'),
    meta: { source: 'ui' },
    indexPath,
    ts: 2_000,
  });
  check(r2.prev_hash === r1.hash, 'second record chains to first (prev_hash === r1.hash)');
  check(r2.body.embedding_source === 'provided', 'explicit embedding → embedding_source "provided"');

  const r3 = indexVisualEvent({
    id: 'evt-3',
    caption: 'invoice PDF page showing total and tax',
    meta: { source: 'doc', page: 3 },
    indexPath,
    ts: 3_000,
  });
  check(r3.prev_hash === r2.hash, 'third record chains to second');

  // Re-read the file and verify the chain independently.
  const recs = R.readIndex(indexPath);
  check(recs.length === 3, 'index file holds exactly 3 records');
  let prev = R.GENESIS;
  let chainOk = true;
  for (const rec of recs) {
    const expected = R.canonicalJSON(rec.body);
    // recompute hash the same way retrieval.mjs does
    const crypto = await import('node:crypto');
    const h = crypto.createHash('sha256').update(prev + expected, 'utf8').digest('hex');
    if (rec.prev_hash !== prev || rec.hash !== h) { chainOk = false; break; }
    prev = rec.hash;
  }
  check(chainOk, 'on-disk hash chain re-verifies from GENESIS');
}

// --- searchVisual: ranking correctness + determinism ------------------------
{
  // Query semantically identical to evt-1's caption → evt-1 must rank #1.
  const q1 = searchVisual({ query: 'dashboard screenshot with revenue bar chart', k: 3, indexPath });
  check(q1.length === 3, 'searchVisual returns k results');
  check(q1[0].id === 'evt-1', 'exact-caption query ranks its own event #1');
  check(q1[0].score > 0.999999, 'top hit for exact caption scores ≈ 1.0');
  check(q1[0].score >= q1[1].score && q1[1].score >= q1[2].score, 'results sorted by descending score');

  // Query matching evt-2 (login form) → evt-2 #1.
  const q2 = searchVisual({ query: 'a login form with username and password fields', k: 1, indexPath });
  check(q2[0].id === 'evt-2', 'login-form query ranks evt-2 #1');

  // Determinism: same query twice → identical ordering + scores.
  const a = searchVisual({ query: 'invoice PDF page showing total and tax', k: 3, indexPath });
  const b = searchVisual({ query: 'invoice PDF page showing total and tax', k: 3, indexPath });
  check(JSON.stringify(a) === JSON.stringify(b), 'searchVisual is deterministic across identical calls');
  check(a[0].id === 'evt-3', 'invoice query ranks evt-3 #1');

  // k larger than corpus → returns all, no crash.
  const all = searchVisual({ query: 'anything', k: 99, indexPath });
  check(all.length === 3, 'k > corpus size returns all records');

  // explicit queryEmbedding path.
  const qe = searchVisual({ queryEmbedding: stubEmbedding('dashboard screenshot with revenue bar chart'), k: 1, indexPath });
  check(qe[0].id === 'evt-1', 'queryEmbedding path ranks correctly');

  // result carries meta + ts through.
  check(q1[0].meta && q1[0].meta.source === 'ui' && q1[0].ts === 1000, 'result surfaces meta + ts from record');
}

// --- searchVisual: validation + empty index --------------------------------
throws(() => searchVisual({ k: 3, indexPath }), 'searchVisual rejects missing query and queryEmbedding');
throws(() => searchVisual({ queryEmbedding: [], indexPath }), 'searchVisual rejects empty queryEmbedding');
{
  const emptyPath = path.join(tmpDir, 'empty.jsonl');
  const res = searchVisual({ query: 'x', k: 5, indexPath: emptyPath });
  check(Array.isArray(res) && res.length === 0, 'search over missing/empty index → [] (no crash)');
}

// --- flux date-file path shape ---------------------------------------------
{
  const fluxRoot = path.join(tmpDir, 'flux');
  const rec = indexVisualEvent({ id: 'f-1', caption: 'flux path test', fluxRoot, date: '2026-07-03' });
  const expectFile = path.join(fluxRoot, 'events', 'reality', '2026-07-03.jsonl');
  check(fs.existsSync(expectFile), 'fluxRoot writes to events/reality/<date>.jsonl (matches spec)');
  check(rec.hash && rec.lane === 'reality', 'flux-path record well-formed');
  const back = searchVisual({ query: 'flux path test', k: 1, fluxRoot, date: '2026-07-03' });
  check(back[0] && back[0].id === 'f-1', 'search reads back from the flux date file');
}

// --- retrieval contract surface --------------------------------------------
check(RETRIEVAL_CONTRACT.collection === 'orange5-vision', 'contract names orange5-vision collection');
check(RETRIEVAL_CONTRACT.vector.comparator === 'max_sim', 'contract preserves MaxSim comparator');
check(RETRIEVAL_CONTRACT.patchesPerPage === 196, 'contract preserves 196 patches/page');

console.log('\n[ae-eyes-backend] bridge.mjs');

// --- bridge: source-type surface -------------------------------------------
check(SOURCE_TYPES.length === 3, 'bridge exposes 3 source types');
check(ENVELOPE_KINDS.join(',') === 'screenshot,dom,doc', 'envelope kinds: screenshot,dom,doc');

// --- bridge: validation -----------------------------------------------------
throws(() => toStructuredText({ source_type: 'nope', payload: {} }), 'bridge rejects unknown source_type');
throws(() => toStructuredText({ source_type: 'doc-extract', payload: null }), 'bridge rejects null payload');
throws(() => toStructuredText({ source_type: 'doc-extract', payload: [] }), 'bridge rejects array payload');

// --- bridge: screenshot-caption --------------------------------------------
{
  const env = toStructuredText({
    source_type: 'screenshot-caption',
    payload: {
      caption: 'Cockpit dashboard: 3 lanes green, one alert on the Vault lane.',
      entities: ['Cockpit', 'Vault lane', 'alert'],
      image_path: 'C:/shots/cockpit.png',
      image_sha256: 'a'.repeat(64),
      qdrant_doc_id: 'q-cockpit-1',
      grounding: [{ patch_idx: 47, bbox: [1, 2, 3, 4], confidence: 0.9 }, { idx: 88, confidence: 0.7 }],
      confidence: 0.86,
      frontier_used: false,
    },
  });
  check(env.kind === 'screenshot', 'screenshot-caption → kind "screenshot"');
  check(env.summary.startsWith('Cockpit dashboard'), 'screenshot summary carries caption');
  check(env.fields.patch_count === 2, 'screenshot fields.patch_count counts grounding');
  check(env.fields.confidence === 0.86, 'screenshot fields.confidence passed through');
  check(env.fields.entities.length === 3, 'screenshot fields.entities carried');
  check(env.cites.includes('C:/shots/cockpit.png'), 'screenshot cites image_path');
  check(env.cites.includes('qdrant:q-cockpit-1'), 'screenshot cites qdrant_doc_id');
  check(env.cites.includes('patch:47') && env.cites.includes('patch:88'), 'screenshot cites patch idx from both grounding shapes');
}

// --- bridge: dom-snapshot ---------------------------------------------------
{
  const env = toStructuredText({
    source_type: 'dom-snapshot',
    payload: {
      url: 'http://127.0.0.1:8787/orange3/',
      title: 'Orange3 Cockpit',
      nodes: [
        { role: 'button', name: 'Run', selector: '#run' },
        { role: 'button', name: 'Stop', selector: '#stop' },
        { role: 'link', name: 'Docs', selector: 'a.docs' },
      ],
      landmarks: ['main', 'nav'],
      forms: [{ id: 'search' }],
    },
  });
  check(env.kind === 'dom', 'dom-snapshot → kind "dom"');
  check(env.fields.node_count === 3, 'dom fields.node_count correct');
  check(env.fields.roles.button === 2 && env.fields.roles.link === 1, 'dom fields.roles rolls up role counts');
  check(env.fields.form_count === 1, 'dom fields.form_count correct');
  check(env.fields.url === 'http://127.0.0.1:8787/orange3/', 'dom fields.url carried');
  check(env.cites.includes('selector:#run'), 'dom cites concrete selectors');
  check(env.cites.includes('http://127.0.0.1:8787/orange3/'), 'dom cites url');
}

// --- bridge: doc-extract ----------------------------------------------------
{
  const env = toStructuredText({
    source_type: 'doc-extract',
    payload: {
      source: 'invoice.pdf',
      page: 3,
      doc_id: 'doc-inv-1',
      text: 'Invoice total: $1,240.00. Tax: $84.00. Due 2026-08-01.',
      tables: [{ rows: 4 }],
      structure: { total: 1240, tax: 84 },
      confidence: 0.95,
    },
  });
  check(env.kind === 'doc', 'doc-extract → kind "doc"');
  check(env.summary.includes('invoice.pdf#page=3'), 'doc summary names source#page');
  check(env.fields.page === 3 && env.fields.table_count === 1, 'doc fields.page + table_count');
  check(env.fields.has_structure === true, 'doc fields.has_structure true when structure present');
  check(env.fields.char_count > 0, 'doc fields.char_count reflects text length');
  check(env.cites.includes('invoice.pdf#page=3') && env.cites.includes('doc:doc-inv-1'), 'doc cites source#page + doc id');
}

// --- bridge: graceful degradation on thin payloads --------------------------
{
  const s = toStructuredText({ source_type: 'screenshot-caption', payload: {} });
  check(s.kind === 'screenshot' && s.summary === '(no caption produced)' && Array.isArray(s.cites) && s.cites.length === 0, 'thin screenshot payload → well-formed empty envelope');

  const d = toStructuredText({ source_type: 'dom-snapshot', payload: {} });
  check(d.kind === 'dom' && d.fields.node_count === 0 && d.summary.length > 0, 'thin dom payload → well-formed envelope');

  const c = toStructuredText({ source_type: 'doc-extract', payload: {} });
  check(c.kind === 'doc' && c.fields.char_count === 0 && c.summary.length > 0, 'thin doc payload → well-formed envelope');

  // Every envelope always has the 4 required keys, correct types.
  for (const env of [s, d, c]) {
    const ok = typeof env.kind === 'string'
      && typeof env.summary === 'string'
      && env.fields && typeof env.fields === 'object'
      && Array.isArray(env.cites);
    check(ok, `envelope always has {kind,summary,fields,cites} (${env.kind})`);
  }
}

// --- cleanup ----------------------------------------------------------------
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }

const total = pass + fail;
console.log(`\nSummary: ${pass} pass / ${fail} fail of ${total}`);
if (fail > 0) {
  console.log('Failed assertions:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail > 0 ? 1 : 0);
