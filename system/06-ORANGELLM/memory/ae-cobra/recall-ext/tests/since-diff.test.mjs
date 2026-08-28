#!/usr/bin/env bun
// since-diff.test.mjs — standalone Bun harness for recall-ext #4 (since-diff).
//
// Zero npm deps. Synthetic Flux ledger where a project has records BEFORE and
// AFTER a "since" boundary, proving the diff includes only the after-window and
// buckets them correctly (decisions / receipts / mistakes / files / commands).
//
// Run:  bun recall-ext/tests/since-diff.test.mjs
// Prints:  Summary: N pass / M fail of T   (exit 0 iff all pass)
//
// Fixture (NOW = 2026-07-03T18:00:00Z), project = "Cobra recall":
//   Reality:
//     old   ~3 days ago  decision "Cobra recall engine scaffold committed"    (BEFORE 1-day cutoff)
//     dec   ~4 hours ago decision "Cobra recall engine dual-index shipped"    (AFTER)
//     rcpt  ~3 hours ago receipt  "Cobra recall receipt #051 written"         (AFTER)
//     err   ~2 hours ago error    "Cobra recall guardrail G09 tripped"        (AFTER, mistake)
//   Thought:
//     idea  ~1 hour ago  decision "Cobra recall: idea to add fuzzy topic pass" (AFTER, forgotten → open thread)
//   Unrelated:
//     noise ~30m ago     observation "kitchen thermostat set to 68"           (AFTER, but not the project)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sinceDiff } from '../since-diff.mjs';

const NOW = Date.parse('2026-07-03T18:00:00.000Z');
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

const SCRATCH = process.env.AE_TEST_TMP
  || path.join(process.env.TEMP || process.env.TMP || '/tmp', 'ae_cobra_since_test');
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
      ts: NOW - 3 * DAY, origin: 'operator', kind: 'decision',
      body: { lane: 'reality', event_type: 'decision', summary: 'Cobra recall engine scaffold committed to the repo', entities: ['Cobra', 'recall'], files: ['06-ORANGELLM/memory/ae-cobra/scaffold.mjs'], commands: ['git commit'], risk: 'low', next_action: 'flesh out', confidence: 0.8 },
    },
    {
      ts: NOW - 4 * HOUR, origin: 'operator', kind: 'decision',
      body: { lane: 'reality', event_type: 'decision', summary: 'Cobra recall engine dual-index shipped to Pillar 3', entities: ['Cobra', 'recall'], files: ['06-ORANGELLM/memory/ae-cobra/recall-engine.mjs'], commands: ['bun test'], risk: 'low', next_action: 'wire mirage', confidence: 0.92 },
    },
    {
      ts: NOW - 3 * HOUR, origin: 'hermes', kind: 'receipt',
      body: { lane: 'reality', event_type: 'receipt', summary: 'Cobra recall receipt #051 written to reality lane', entities: ['Cobra', 'recall', 'receipt-051'], files: ['receipts/051.json'], commands: [], risk: 'low', next_action: null, confidence: 0.9 },
    },
    {
      ts: NOW - 2 * HOUR, origin: 'doctrine.27guardrails.triage', kind: 'error',
      body: { lane: 'reality', event_type: 'error', summary: 'Cobra recall guardrail G09 tripped on recall query path', guardrail_id: 'G09', severity: 'HIGH', entities: ['Cobra', 'recall', 'G09'], files: [], commands: [], risk: 'high', next_action: 'patch query path', confidence: 0.95 },
    },
  ];
  const thought = [
    {
      ts: NOW - 1 * HOUR, origin: 'orangellm_reasoning', kind: 'decision',
      body: { lane: 'thought', event_type: 'decision', summary: 'Cobra recall: idea to add a fuzzy topic pass for forgotten threads', entities: ['Cobra', 'recall', 'fuzzy'], files: [], commands: [], risk: 'low', next_action: 'prototype fuzzy matcher', confidence: 0.6 },
    },
    {
      ts: NOW - 30 * MIN, origin: 'sensor', kind: 'observation',
      body: { lane: 'thought', event_type: 'observation', summary: 'kitchen thermostat set to 68 degrees', entities: ['thermostat'], files: [], commands: [], risk: 'low', next_action: null, confidence: 0.5 },
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

  // ---- 1. diff since "an hour ago" (explicit-ish via phrase) -----------------
  // Boundary = NOW - 1 day. The 3-day-old scaffold is BEFORE; everything else AFTER.
  const d = sinceDiff({ fluxRoot: FIXTURE_ROOT, project: 'Cobra recall', sinceMs: NOW - 1 * DAY, nowMs: NOW });
  ok('diff ok', d.ok === true);
  ok('diff changed', d.changed === true);
  // 3-day scaffold excluded.
  ok('excludes the 3-day-old scaffold', !d.decisions.some((x) => x.summary.includes('scaffold committed')));
  // after-window project records present, bucketed.
  ok('includes dual-index decision', d.decisions.some((x) => x.summary.includes('dual-index shipped')));
  ok('includes receipt #051', d.receipts.some((x) => x.summary.includes('receipt #051')));
  ok('includes G09 mistake', d.mistakes.some((x) => x.summary.includes('G09')));
  // unrelated thermostat is NOT the project.
  ok('excludes unrelated thermostat', ![...d.decisions, ...d.receipts, ...d.mistakes, ...d.other].some((x) => x.summary.includes('thermostat')));

  // ---- 2. counts + rolled-up surface -----------------------------------------
  // Two decision-kind records in-window: the reality "dual-index shipped" AND the
  // thought-lane "fuzzy topic pass" idea (also surfaced separately as an open thread).
  eq('counts.decisions 2', d.counts.decisions, 2);
  eq('counts.receipts 1', d.counts.receipts, 1);
  eq('counts.mistakes 1', d.counts.mistakes, 1);
  ok('files_touched includes recall-engine', d.files_touched.some((f) => f.includes('recall-engine.mjs')));
  ok('files_touched excludes scaffold (before window)', !d.files_touched.some((f) => f.includes('scaffold.mjs')));
  ok('commands_run includes bun test', d.commands_run.includes('bun test'));

  // ---- 3. open threads (new forgotten on the project in-window) ---------------
  ok('open_threads has the fuzzy idea', d.open_threads.some((t) => t.summary.includes('fuzzy topic pass')),
     `open=${JSON.stringify(d.open_threads.map((t) => t.summary))}`);

  // ---- 4. natural phrase boundary --------------------------------------------
  const dp = sinceDiff({ fluxRoot: FIXTURE_ROOT, project: 'Cobra recall', since: '5 hours ago', nowMs: NOW });
  ok('phrase diff ok', dp.ok === true);
  ok('phrase includes dual-index (4h < 5h)', dp.decisions.some((x) => x.summary.includes('dual-index shipped')));
  ok('phrase interpretation recorded', typeof dp.window.interpretation === 'string' && dp.window.interpretation.startsWith('phrase:'));

  // ---- 5. bad phrase → ok:false, no throw ------------------------------------
  const dbad = sinceDiff({ fluxRoot: FIXTURE_ROOT, project: 'Cobra recall', since: 'whenever-ish', nowMs: NOW });
  eq('bad phrase ok=false', dbad.ok, false);
  ok('bad phrase has reason', typeof dbad.reason === 'string' && dbad.reason.length > 0);

  // ---- 6. empty window (recent since, nothing after) → changed:false ---------
  const dEmptyWin = sinceDiff({ fluxRoot: FIXTURE_ROOT, project: 'Cobra recall', sinceMs: NOW - 1 * MIN, nowMs: NOW });
  ok('empty-window ok', dEmptyWin.ok === true);
  eq('empty-window changed false', dEmptyWin.changed, false);
  eq('empty-window total 0', dEmptyWin.counts.total, 0);

  // ---- 7. determinism --------------------------------------------------------
  const again = sinceDiff({ fluxRoot: FIXTURE_ROOT, project: 'Cobra recall', sinceMs: NOW - 1 * DAY, nowMs: NOW });
  eq('deterministic total', again.counts.total, d.counts.total);
  eq('deterministic decisions', again.counts.decisions, d.counts.decisions);

  // ---- 8. empty / offline-safe (never throw) ---------------------------------
  let threw = false, e = null;
  try {
    e = {
      d: sinceDiff({ fluxRoot: EMPTY_ROOT, project: 'anything', sinceMs: NOW - DAY, nowMs: NOW }),
      u: sinceDiff({ project: 'x', sinceMs: NOW - DAY, nowMs: NOW }),
      n: sinceDiff({ fluxRoot: FIXTURE_ROOT, sinceMs: NOW - DAY, nowMs: NOW }), // no project
    };
  } catch (err) { threw = true; fails.push({ name: 'empty.no-throw', detail: err.message }); }
  ok('empty.no-throw', threw === false);
  if (e) {
    ok('empty.ledger ok', e.d.ok === true);
    eq('empty.ledger changed false', e.d.changed, false);
    eq('empty.ledger total 0', e.d.counts.total, 0);
    eq('undef-root ok', e.u.ok, true);
    eq('no-project ok=false', e.n.ok, false);
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
