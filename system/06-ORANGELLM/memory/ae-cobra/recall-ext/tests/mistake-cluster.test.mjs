#!/usr/bin/env bun
// mistake-cluster.test.mjs — standalone Bun harness for recall-ext #5 (mistake-cluster).
//
// Zero npm deps. Synthetic Flux ledger with RECURRING mistakes of the same kind
// (same guardrail id → one cluster, count≥2), a distinct error family, and a
// repair that lands after one cluster (proving repair-detection + recurrence).
//
// Run:  bun recall-ext/tests/mistake-cluster.test.mjs
// Prints:  Summary: N pass / M fail of T   (exit 0 iff all pass)
//
// Fixture (NOW = 2026-07-03T18:00:00Z):
//   Reality:
//     E1 ~5 days ago  error "guardrail G02 FOUNDER_SALARY env unset — build blocked" (guardrail_id G02)
//     E2 ~3 days ago  error "guardrail G02 FOUNDER_SALARY env unset again on rebuild" (guardrail_id G02)  ← recurrence
//     E3 ~2 days ago  error "connection to model host timed out after 30s"            (timeout family)
//     FIX ~1 day ago  decision "FOUNDER_SALARY env var set; G02 guardrail resolved and build unblocked"  ← repair for G02
//     OBS ~1 hour ago observation "Marco Island survey baseline logged"               (NOT a mistake)
//   Thought:
//     R1 ~4 days ago  risk "risk: brotli q11 pass may blow the rss ceiling / oom on big corpora" (oom family)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { clusterMistakes, clusterKeyFor } from '../mistake-cluster.mjs';

const NOW = Date.parse('2026-07-03T18:00:00.000Z');
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

const SCRATCH = process.env.AE_TEST_TMP
  || path.join(process.env.TEMP || process.env.TMP || '/tmp', 'ae_cobra_cluster_test');
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
      ts: NOW - 5 * DAY, origin: 'doctrine.27guardrails.triage', kind: 'error',
      body: { lane: 'reality', event_type: 'error', summary: 'guardrail G02 FOUNDER_SALARY env unset — build blocked', guardrail_id: 'G02', severity: 'CRITICAL', entities: ['G02', 'FOUNDER_SALARY'], files: ['runtime/node.py'], commands: [], risk: 'high', next_action: 'set env var', confidence: 0.99 },
    },
    {
      ts: NOW - 3 * DAY, origin: 'doctrine.27guardrails.triage', kind: 'error',
      body: { lane: 'reality', event_type: 'error', summary: 'guardrail G02 FOUNDER_SALARY env unset again on rebuild attempt', guardrail_id: 'G02', severity: 'CRITICAL', entities: ['G02', 'FOUNDER_SALARY'], files: ['runtime/node.py'], commands: [], risk: 'high', next_action: 'set env var', confidence: 0.99 },
    },
    {
      ts: NOW - 2 * DAY, origin: 'net', kind: 'error',
      body: { lane: 'reality', event_type: 'error', summary: 'connection to the model host timed out after 30s during warmup', severity: 'HIGH', entities: ['model host'], files: [], commands: [], risk: 'high', next_action: 'retry with backoff', confidence: 0.9 },
    },
    {
      ts: NOW - 1 * DAY, origin: 'operator', kind: 'decision',
      body: { lane: 'reality', event_type: 'decision', summary: 'FOUNDER_SALARY env var set; G02 guardrail resolved and build unblocked', entities: ['G02', 'FOUNDER_SALARY'], files: ['runtime/node.py'], commands: ['bun build'], risk: 'low', next_action: null, confidence: 0.95 },
    },
    {
      ts: NOW - 1 * HOUR, origin: 'terminal', kind: 'observation',
      body: { lane: 'reality', event_type: 'observation', summary: 'Marco Island survey baseline logged for shoreline study', entities: ['Marco Island'], files: [], commands: [], risk: 'low', next_action: null, confidence: 0.95 },
    },
  ];
  const thought = [
    {
      ts: NOW - 4 * DAY, origin: 'orangellm_reasoning', kind: 'risk',
      body: { lane: 'thought', event_type: 'risk', summary: 'risk: brotli q11 pass may blow the rss ceiling and trigger oom on big corpora', severity: 'HIGH', entities: ['brotli', 'rss ceiling'], files: ['12-ATOMSMASHER/crystal/compress.mjs'], commands: [], risk: 'high', next_action: 'bound memory', confidence: 0.7 },
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

  // ---- 0. clusterKeyFor priority ---------------------------------------------
  eq('key: guardrail id wins', clusterKeyFor({ body: { guardrail_id: 'G02', summary: 'x' } }).key, 'guardrail:G02');
  eq('key: env family', clusterKeyFor({ kind: 'error', body: { summary: 'the API key env var was unset' } }).key, 'family:env');
  eq('key: timeout family', clusterKeyFor({ kind: 'error', body: { summary: 'request timed out after 10s' } }).key, 'family:timeout');
  eq('key: oom family', clusterKeyFor({ kind: 'error', body: { summary: 'process ran out of memory (oom)' } }).key, 'family:oom');

  // ---- 1. clustering the ledger ----------------------------------------------
  const c = clusterMistakes({ fluxRoot: FIXTURE_ROOT, nowMs: NOW });
  ok('clusters ok', c.ok === true);
  ok('has clusters', c.clusters.length >= 3, `got ${c.clusters.length}`);

  // G02 recurred twice → single cluster, count 2, recurring.
  const g02 = c.clusters.find((x) => x.key === 'guardrail:G02');
  ok('G02 cluster exists', !!g02);
  eq('G02 count is 2', g02?.count, 2);
  ok('G02 marked recurring', g02?.recurring === true);
  ok('G02 members are both G02 errors', !!g02 && g02.members.every((m) => m.summary.includes('G02') || m.summary.includes('FOUNDER_SALARY')));

  // G02 got a repair after its last occurrence → repaired:true.
  ok('G02 repaired detected', g02?.repaired === true);
  ok('G02 repaired_by is the fix decision', !!g02?.repaired_by && g02.repaired_by.summary.includes('resolved and build unblocked'));

  // timeout cluster (single occurrence, NOT recurring, NOT repaired).
  const timeout = c.clusters.find((x) => x.key === 'family:timeout');
  ok('timeout cluster exists', !!timeout);
  eq('timeout count 1', timeout?.count, 1);
  ok('timeout not recurring', timeout?.recurring === false);
  ok('timeout not repaired', timeout?.repaired === false);

  // oom risk from the thought lane clustered too.
  const oom = c.clusters.find((x) => x.key === 'family:oom');
  ok('oom cluster exists (thought-lane risk counted)', !!oom);

  // The routine observation must NOT be clustered (engine says it's no mistake).
  ok('routine observation excluded', !c.clusters.some((x) =>
    x.members.some((m) => m.summary.includes('survey baseline'))));

  // ---- 2. counts rollup ------------------------------------------------------
  ok('counts.mistakes >= 4', c.counts.mistakes >= 4, `got ${c.counts.mistakes}`);
  ok('counts.recurring >= 1', c.counts.recurring >= 1);
  ok('counts.repaired >= 1', c.counts.repaired >= 1);
  eq('counts.clusters matches array', c.counts.clusters, c.clusters.length);
  ok('ranked most-recurring first', c.clusters[0].count >= c.clusters[c.clusters.length - 1].count);

  // ---- 3. engine kind-filter passthrough -------------------------------------
  const cg = clusterMistakes({ fluxRoot: FIXTURE_ROOT, nowMs: NOW, kind: 'G02' });
  ok('kind-filter narrows to G02 only', cg.clusters.length === 1 && cg.clusters[0].key === 'guardrail:G02');

  // ---- 4. determinism --------------------------------------------------------
  const again = clusterMistakes({ fluxRoot: FIXTURE_ROOT, nowMs: NOW });
  eq('deterministic cluster count', again.counts.clusters, c.counts.clusters);
  eq('deterministic top key', again.clusters[0].key, c.clusters[0].key);

  // ---- 5. empty / offline-safe (never throw) ---------------------------------
  let threw = false, e = null;
  try {
    e = { c: clusterMistakes({ fluxRoot: EMPTY_ROOT, nowMs: NOW }), u: clusterMistakes({ nowMs: NOW }) };
  } catch (err) { threw = true; fails.push({ name: 'empty.no-throw', detail: err.message }); }
  ok('empty.no-throw', threw === false);
  if (e) {
    eq('empty.clusters 0', e.c.counts.clusters, 0);
    ok('empty.ok', e.c.ok === true);
    eq('empty.clusters array empty', e.c.clusters.length, 0);
    eq('undef-root clusters 0', e.u.counts.clusters, 0);
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
