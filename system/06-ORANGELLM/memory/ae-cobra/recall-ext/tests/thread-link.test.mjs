#!/usr/bin/env bun
// thread-link.test.mjs — standalone Bun harness for recall-ext #3 (thread-link).
//
// Zero npm deps. Synthetic Flux ledger with records bucketed into distinct
// projects (via leading file-path segment) that DO and DON'T share vocabulary,
// to prove cross-project links form on shared surface and never within a project.
//
// Run:  bun recall-ext/tests/thread-link.test.mjs
// Prints:  Summary: N pass / M fail of T   (exit 0 iff all pass)
//
// Fixture (NOW = 2026-07-03T18:00:00Z). Two projects share "compression"/"brotli"
// vocabulary; a third is isolated:
//   Reality:
//     A1 (12-ATOMSMASHER) "brotli compression benchmark for receipt archives"
//     C1 (07-VISUAL)      "render the dashboard sparkline widget"           (isolated)
//   Thought:
//     B1 (06-ORANGELLM)   "plan: reuse the brotli compression pass for memory archives"
//                           → LINKS to A1 (shares brotli, compression, archives)
//     A2 (12-ATOMSMASHER) "note: brotli compression tuning q11"  (same project as A1 → NO self-link)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { linkThreads, linksForProject, projectLabel } from '../thread-link.mjs';

const NOW = Date.parse('2026-07-03T18:00:00.000Z');
const MIN = 60_000, HOUR = 3_600_000;

const SCRATCH = process.env.AE_TEST_TMP
  || path.join(process.env.TEMP || process.env.TMP || '/tmp', 'ae_cobra_link_test');
const FIXTURE_ROOT = path.join(SCRATCH, `flux_${process.pid}_${Date.now()}`);
const EMPTY_ROOT = path.join(SCRATCH, `flux_empty_${process.pid}_${Date.now()}`);

function canonical(v) {
  if (v === null) return 'null';
  if (typeof v === 'number' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (typeof v === 'object') {
    const ks = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return '{' + ks.map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return 'null';
}
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
function writeLedger(root, lane, records) {
  const byDay = new Map(); let prev = 'GENESIS';
  for (const r of records) {
    const rec = { ts: r.ts, lane, origin: r.origin, kind: r.kind, body: r.body, prev_hash: prev };
    rec.hash = sha(prev + canonical({ ts: rec.ts, lane, origin: rec.origin, kind: rec.kind, body: rec.body }));
    prev = rec.hash;
    const day = new Date(r.ts).toISOString().slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(rec);
  }
  const dir = path.join(root, 'events', lane); fs.mkdirSync(dir, { recursive: true });
  for (const [day, recs] of byDay) fs.writeFileSync(path.join(dir, `${day}.jsonl`), recs.map((x) => JSON.stringify(x)).join('\n') + '\n');
}

function buildFixture() {
  fs.mkdirSync(FIXTURE_ROOT, { recursive: true });
  const reality = [
    {
      ts: NOW - 3 * HOUR, origin: 'operator', kind: 'decision',
      body: { lane: 'reality', event_type: 'decision', summary: 'brotli compression benchmark for receipt archives completed', entities: ['brotli', 'compression'], files: ['12-ATOMSMASHER/crystal/bench.mjs'], commands: ['bun bench.mjs'], risk: 'low', next_action: 'record ratio', confidence: 0.9 },
    },
    {
      ts: NOW - 2 * HOUR, origin: 'operator', kind: 'decision',
      body: { lane: 'reality', event_type: 'decision', summary: 'render the dashboard sparkline widget on the visual panel', entities: ['sparkline', 'dashboard'], files: ['07-VISUAL/widgets/sparkline.tsx'], commands: [], risk: 'low', next_action: null, confidence: 0.8 },
    },
  ];
  const thought = [
    {
      ts: NOW - 90 * MIN, origin: 'orangellm_reasoning', kind: 'decision',
      body: { lane: 'thought', event_type: 'decision', summary: 'plan: reuse the brotli compression pass for memory archives in the recall store', entities: ['brotli', 'compression', 'archives'], files: ['06-ORANGELLM/memory/store.mjs'], commands: [], risk: 'low', next_action: 'wire compressor into memory', confidence: 0.7 },
    },
    {
      ts: NOW - 80 * MIN, origin: 'operator', kind: 'decision',
      body: { lane: 'thought', event_type: 'decision', summary: 'note: brotli compression tuning q11 vs q9 on the archive corpus', entities: ['brotli', 'compression'], files: ['12-ATOMSMASHER/crystal/tune.mjs'], commands: [], risk: 'low', next_action: null, confidence: 0.65 },
    },
  ];
  writeLedger(FIXTURE_ROOT, 'reality', reality);
  writeLedger(FIXTURE_ROOT, 'thought', thought);
}

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, detail) { if (cond) pass++; else { fail++; fails.push({ name, detail }); console.log(`  FAIL: ${name}${detail ? ` — ${detail}` : ''}`); } }
function eq(name, got, want) { ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
function cleanup() { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {} }

function main() {
  cleanup(); buildFixture();

  // ---- 0. projectLabel inference ---------------------------------------------
  eq('label from path segment', projectLabel({ body: { files: ['12-ATOMSMASHER/x/y.mjs'] } }), '12-ATOMSMASHER');
  eq('label from explicit project', projectLabel({ body: { project: 'MyProj', files: ['a/b'] } }), 'MyProj');
  eq('label unlabeled fallback', projectLabel({ body: {} }), 'unlabeled');

  // ---- 1. linkThreads graph --------------------------------------------------
  const g = linkThreads({ fluxRoot: FIXTURE_ROOT, nowMs: NOW });
  ok('graph ok', g.ok === true);
  ok('graph found 3 projects', g.projects.length === 3, `projects=${JSON.stringify(g.projects)}`);
  ok('graph includes ATOMSMASHER + ORANGELLM + VISUAL',
     g.projects.includes('12-ATOMSMASHER') && g.projects.includes('06-ORANGELLM') && g.projects.includes('07-VISUAL'));

  // The ORANGELLM plan links to ATOMSMASHER bench/tune (shared brotli+compression).
  const orangeAtom = g.edges.find((e) =>
    e.projects.includes('06-ORANGELLM') && e.projects.includes('12-ATOMSMASHER'));
  ok('edge ORANGELLM⇄ATOMSMASHER exists', !!orangeAtom);
  ok('edge carries shared vocab (brotli/compression)', !!orangeAtom &&
     (orangeAtom.vocab.includes('brotli') || orangeAtom.vocab.includes('compression')));

  // The isolated VISUAL project must NOT link to anything (no shared vocab).
  const visualEdge = g.edges.find((e) => e.projects.includes('07-VISUAL'));
  ok('VISUAL is isolated (no edges)', !visualEdge, `unexpected: ${JSON.stringify(visualEdge)}`);

  // No link may be within the same project (A1↔A2 both ATOMSMASHER).
  ok('no self-project links', g.record_links.every((l) => l.a.project !== l.b.project));

  // ---- 2. linksForProject ----------------------------------------------------
  const lp = linksForProject({ fluxRoot: FIXTURE_ROOT, project: '06-ORANGELLM', nowMs: NOW });
  ok('linksForProject found', lp.found === true);
  ok('related includes ATOMSMASHER', lp.related.some((r) => r.project === '12-ATOMSMASHER'));
  ok('every link touches ORANGELLM', lp.links.every((l) => l.a.project === '06-ORANGELLM' || l.b.project === '06-ORANGELLM'));

  // Isolated project → found:false, empty related.
  const lpVis = linksForProject({ fluxRoot: FIXTURE_ROOT, project: '07-VISUAL', nowMs: NOW });
  eq('isolated project found=false', lpVis.found, false);
  eq('isolated related empty', lpVis.related.length, 0);

  // ---- 3. determinism --------------------------------------------------------
  const again = linkThreads({ fluxRoot: FIXTURE_ROOT, nowMs: NOW });
  eq('deterministic edge count', again.counts.edges, g.counts.edges);
  eq('deterministic first edge key', again.edges[0]?.projects.join('|'), g.edges[0]?.projects.join('|'));

  // ---- 4. empty / offline-safe (never throw) ---------------------------------
  let threw = false, e = null;
  try {
    e = {
      g: linkThreads({ fluxRoot: EMPTY_ROOT, nowMs: NOW }),
      p: linksForProject({ fluxRoot: EMPTY_ROOT, project: 'anything', nowMs: NOW }),
      u: linkThreads({ nowMs: NOW }),
    };
  } catch (err) { threw = true; fails.push({ name: 'empty.no-throw', detail: err.message }); }
  ok('empty.no-throw', threw === false);
  if (e) {
    eq('empty.edges 0', e.g.counts.edges, 0);
    ok('empty.graph ok', e.g.ok === true);
    eq('empty.project found false', e.p.found, false);
    eq('undef-root edges 0', e.u.counts.edges, 0);
  }

  cleanup();
  const total = pass + fail;
  console.log('');
  console.log(`Summary: ${pass} pass / ${fail} fail of ${total}`);
  if (fail > 0) { console.log('Failures:'); for (const f of fails) console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`); }
  process.exit(fail === 0 ? 0 : 1);
}

try { main(); }
catch (e) { cleanup(); console.error('FATAL harness error:', e.stack || e.message); console.log(`Summary: ${pass} pass / ${fail + 1} fail of ${pass + fail + 1}`); process.exit(1); }
