#!/usr/bin/env bun
// recall-engine.test.mjs — standalone Bun harness for the Æ Cobra recall engine.
//
// Zero npm deps. Builds a synthetic Flux ledger fixture on disk (real per-lane/
// per-day JSONL in the LIVE record shape the reader/writer use), points the
// engine at it via AE_FLUX_ROOT / fluxRoot, and asserts the four public recall
// functions plus the empty-safe contract.
//
// Run:  bun 06-ORANGELLM/memory/ae-cobra/tests/recall-engine.test.mjs
// Prints:  Summary: N pass / M fail of T
// Exit:    0 iff all pass (Mom's Law — honest green, no skip-to-green).
//
// Fixture design (dual-index / dual-lane, chosen to exercise every branch):
//   Anchored clock NOW = 2026-07-03T18:00:00Z so relative phrases are deterministic.
//   Reality lane:
//     R1  4y+ ago (2022-03-28)  observation  "Marco Island survey baseline logged"
//     R2  ~2h ago               receipt      "OrangeLLM-fatty v0 training receipt #037 written"
//     R3  ~30m ago              decision      "AE Cobra recall engine promoted to Pillar 3"  (follows T-followed)
//     R4  ~10m ago              error         "guardrail G02 FOUNDER_SALARY env unset — build blocked"
//   Thought lane:
//     T1  ~90m ago  orangellm_reasoning  "Hypothesis: index reality and thought lanes separately, join on shared state"
//                     → FOLLOWED THROUGH by R3 (shares recall/engine/pillar/cobra tokens)
//     T2  ~50m ago  orangellm_reasoning  "Plan: add a brotli q11 pass to the crystal compressor for receipt archives"
//                     → NEVER followed on reality → FORGOTTEN THREAD
//     T3  ~5d ago   orangellm_reasoning  "Idea: build a Marco Island tide-aware scheduler for the boat launch"
//                     → NEVER followed → FORGOTTEN THREAD (older, has next_action → high actionability)
//     T4  ~40m ago  doctrine.guardrails  "guardrails.red.critical G03 Gate0 LBCE"  (mistake on thought lane)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveTimeQuery,
  surfaceForgottenThreads,
  projectState,
  recallMistakes,
  buildDualIndex,
  ledgerHealth,
  parseTimePhrase,
} from '../recall-engine.mjs';

// ── anchored clock ──────────────────────────────────────────────────────────
const NOW = Date.parse('2026-07-03T18:00:00.000Z');
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

// ── fixture root under the scratchpad ───────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const SCRATCH = process.env.AE_TEST_TMP
  || path.join(process.env.TEMP || process.env.TMP || '/tmp', 'ae_cobra_recall_test');
const FIXTURE_ROOT = path.join(SCRATCH, `flux_${process.pid}_${Date.now()}`);
const EMPTY_ROOT = path.join(SCRATCH, `flux_empty_${process.pid}_${Date.now()}`); // never created

// ── record + fixture builders (mirror flux/writer canonical hashing loosely; the
//    reader only needs valid JSON lines with a numeric ts + prev_hash linkage, and
//    tolerates any body — we still chain prev_hash→hash per lane for realism) ──
import crypto from 'node:crypto';
function canonical(v) {
  if (v === null) return 'null';
  if (typeof v === 'number') return JSON.stringify(v);
  if (typeof v === 'string') return JSON.stringify(v);
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
  // Group by UTC day, chain prev_hash→hash per lane across the whole lane.
  const byDay = new Map();
  let prev = 'GENESIS';
  for (const r of records) {
    const rec = { ts: r.ts, lane, origin: r.origin, kind: r.kind, body: r.body, prev_hash: prev };
    rec.hash = sha(prev + canonical({ ts: rec.ts, lane, origin: rec.origin, kind: rec.kind, body: rec.body }));
    prev = rec.hash;
    const day = new Date(r.ts).toISOString().slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(rec);
  }
  const dir = path.join(root, 'events', lane);
  fs.mkdirSync(dir, { recursive: true });
  for (const [day, recs] of byDay) {
    const file = path.join(dir, `${day}.jsonl`);
    fs.writeFileSync(file, recs.map((x) => JSON.stringify(x)).join('\n') + '\n');
  }
}

function buildFixture() {
  fs.mkdirSync(FIXTURE_ROOT, { recursive: true });

  const reality = [
    {
      ts: Date.parse('2022-03-28T14:30:00.000Z'), origin: 'terminal', kind: 'observation',
      body: { lane: 'reality', event_type: 'observation', summary: 'Marco Island survey baseline logged for shoreline erosion study', entities: ['Marco Island', 'shoreline'], files: ['surveys/2022-03-28-baseline.csv'], commands: [], risk: 'low', next_action: 'archive baseline', confidence: 0.95 },
    },
    {
      ts: NOW - 2 * HOUR, origin: 'hermes', kind: 'receipt',
      body: { lane: 'reality', event_type: 'receipt', summary: 'OrangeLLM-fatty v0 training receipt #037 written to reality lane', entities: ['OrangeLLM-fatty', 'receipt-037'], files: ['receipts/037.json'], commands: ['bun train.mjs'], risk: 'low', next_action: 'verify checkpoint', confidence: 0.9 },
    },
    {
      // R3 — the follow-through for T1. Shares tokens: recall, engine, pillar, cobra, index, lane.
      ts: NOW - 30 * MIN, origin: 'operator', kind: 'decision',
      body: { lane: 'reality', event_type: 'decision', summary: 'AE Cobra recall engine promoted to Pillar 3 — dual index over reality and thought lanes shipped', entities: ['AE Cobra', 'recall engine', 'Pillar 3'], files: ['06-ORANGELLM/memory/ae-cobra/recall-engine.mjs'], commands: ['bun tests/recall-engine.test.mjs'], risk: 'low', next_action: 'wire into Mirage', confidence: 0.92 },
    },
    {
      ts: NOW - 10 * MIN, origin: 'doctrine.27guardrails.triage', kind: 'error',
      body: { lane: 'reality', event_type: 'error', summary: 'guardrail G02 FOUNDER_SALARY_PER_INSTALL_CENTS env unset — build blocked', guardrail_id: 'G02', severity: 'CRITICAL', entities: ['G02', 'FOUNDER_SALARY'], files: ['runtime/node.py'], commands: [], risk: 'high', next_action: 'set env var', confidence: 0.99, disclosure_id: 'ATOM-27GUARD-TRIAGE-2026-0624' },
    },
  ];

  const thought = [
    {
      // T3 — oldest forgotten idea, concrete (next_action + files) → high actionability.
      ts: NOW - 5 * DAY, origin: 'orangellm_reasoning', kind: 'decision',
      body: { lane: 'thought', event_type: 'decision', summary: 'Idea: build a Marco Island tide-aware scheduler for the boat launch window', entities: ['Marco Island', 'tide scheduler'], files: ['tools/tide-sched.mjs'], commands: ['bun tide-sched.mjs --forecast'], risk: 'low', next_action: 'prototype tide table ingestion', confidence: 0.6 },
    },
    {
      // T1 — followed through by R3. Should NOT be forgotten.
      ts: NOW - 90 * MIN, origin: 'orangellm_reasoning', kind: 'decision',
      body: { lane: 'thought', event_type: 'decision', summary: 'Hypothesis: index reality and thought lanes separately in the recall engine, join on shared state per Pillar 3 Cobra', entities: ['recall engine', 'Pillar 3', 'Cobra'], files: ['06-ORANGELLM/memory/ae-cobra/recall-engine.mjs'], commands: [], risk: 'low', next_action: 'implement dual index', confidence: 0.7 },
    },
    {
      // T4 — a mistake logged on the thought lane (guardrail red). Feeds recallMistakes.
      ts: NOW - 40 * MIN, origin: 'doctrine.27guardrails.triage', kind: 'guardrails.red.critical',
      body: { lane: 'thought', event_type: 'risk', summary: 'guardrails.red.critical G03 Gate0 LatticeIntegrityGate LBCE missing from chain', guardrail_id: 'G03', severity: 'CRITICAL', entities: ['G03', 'Gate0', 'LBCE'], files: [], commands: [], risk: 'high', next_action: 'restore Gate 0', confidence: 0.99, disclosure_id: 'ATOM-27GUARD-TRIAGE-2026-0624' },
    },
    {
      // T2 — forgotten thread, never followed on reality (brotli/crystal tokens appear nowhere in reality).
      ts: NOW - 50 * MIN, origin: 'orangellm_reasoning', kind: 'decision',
      body: { lane: 'thought', event_type: 'decision', summary: 'Plan: add a brotli q11 pass to the crystal compressor for receipt archives', entities: ['brotli', 'crystal compressor'], files: ['12-ATOMSMASHER/crystal/compress.mjs'], commands: ['bun compress.mjs --q11'], risk: 'low', next_action: 'benchmark brotli q11 vs zlib', confidence: 0.65 },
    },
  ];

  writeLedger(FIXTURE_ROOT, 'reality', reality);
  writeLedger(FIXTURE_ROOT, 'thought', thought);
}

// ── tiny assert harness ─────────────────────────────────────────────────────
let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; /* quiet on pass */ }
  else { fail++; fails.push({ name, detail }); console.log(`  FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq(name, got, want) { ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }

// ── run ─────────────────────────────────────────────────────────────────────
function cleanup() { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best-effort */ } }

function main() {
  cleanup();
  buildFixture();

  // ---- 0. dual index built correctly ----------------------------------------
  const idx = buildDualIndex({ fluxRoot: FIXTURE_ROOT, endMs: NOW });
  eq('dualindex.reality count', idx.counts.reality, 4);
  eq('dualindex.thought count', idx.counts.thought, 4);
  ok('dualindex.tokens attached', idx.reality.every((e) => e.tokens instanceof Set));

  // ---- 1. resolveTimeQuery --------------------------------------------------
  // 1a. "an hour ago" → last 60m window. R2(2h) excluded; R3(30m),R4(10m),T1... included.
  const tqHour = resolveTimeQuery({ fluxRoot: FIXTURE_ROOT, phrase: 'an hour ago', nowMs: NOW });
  ok('time.hour ok', tqHour.ok === true);
  ok('time.hour excludes 2h-old receipt', !tqHour.events.some((e) => e.summary.includes('receipt #037')));
  ok('time.hour includes 30m decision', tqHour.events.some((e) => e.summary.includes('promoted to Pillar 3')));
  ok('time.hour includes 10m error', tqHour.events.some((e) => e.summary.includes('build blocked')));

  // 1b. calendar date "March 28 2022" → only R1 that whole day.
  const tqCal = resolveTimeQuery({ fluxRoot: FIXTURE_ROOT, phrase: 'March 28 2022', nowMs: NOW });
  ok('time.cal ok', tqCal.ok === true);
  eq('time.cal count', tqCal.count, 1);
  ok('time.cal is the survey baseline', tqCal.events[0]?.summary.includes('Marco Island survey baseline'));

  // 1c. "four years ago" year-shift on a bare month/day. 2026-4 = 2022 → hits R1.
  const tqShift = resolveTimeQuery({ fluxRoot: FIXTURE_ROOT, phrase: 'March 28 four years ago', nowMs: NOW });
  ok('time.yearshift ok', tqShift.ok === true);
  ok('time.yearshift finds 2022 survey', tqShift.events.some((e) => e.summary.includes('survey baseline')));

  // 1d. explicit {fromMs,toMs} range around R2 only (2h ago ± 5m).
  const tqRange = resolveTimeQuery({ fluxRoot: FIXTURE_ROOT, fromMs: NOW - 2 * HOUR - 5 * MIN, toMs: NOW - 2 * HOUR + 5 * MIN });
  eq('time.range count', tqRange.count, 1);
  ok('time.range is receipt', tqRange.events[0]?.summary.includes('receipt #037'));

  // 1e. unparseable phrase → ok:false, no throw, empty events.
  const tqBad = resolveTimeQuery({ fluxRoot: FIXTURE_ROOT, phrase: 'sometime maybe', nowMs: NOW });
  eq('time.bad ok=false', tqBad.ok, false);
  eq('time.bad empty', tqBad.events.length, 0);

  // 1f. parseTimePhrase relative unit table.
  eq('parse.today interp', parseTimePhrase('today', NOW).interpretation, 'today');
  eq('parse.yesterday ok', parseTimePhrase('yesterday', NOW).ok, true);
  eq('parse.2days ok', parseTimePhrase('2 days ago', NOW).ok, true);

  // ---- 2. surfaceForgottenThreads -------------------------------------------
  const ft = surfaceForgottenThreads({ fluxRoot: FIXTURE_ROOT, nowMs: NOW });
  ok('forgotten.ok', ft.ok === true);
  const ftSummaries = ft.threads.map((t) => t.summary);
  ok('forgotten includes brotli plan (T2, never followed)', ftSummaries.some((s) => s.includes('brotli q11')));
  ok('forgotten includes tide scheduler (T3, never followed)', ftSummaries.some((s) => s.includes('tide-aware scheduler')));
  ok('forgotten EXCLUDES T1 (followed through by R3)', !ftSummaries.some((s) => s.includes('index reality and thought lanes separately')));
  // T3 is older + concrete → should outrank by actionability then age; assert both forgotten present.
  eq('forgotten total is exactly 2', ft.total_forgotten, 2);
  ok('forgotten carries actionability', ft.threads.every((t) => typeof t.actionability === 'number'));
  ok('forgotten carries age_days', ft.threads.every((t) => Number.isInteger(t.age_days)));

  // ---- 3. projectState ------------------------------------------------------
  const psCobra = projectState({ fluxRoot: FIXTURE_ROOT, project: 'recall engine', nowMs: NOW });
  ok('project.found', psCobra.found === true);
  ok('project.latest is R3 decision', psCobra.latest?.summary.includes('promoted to Pillar 3'));
  ok('project.latest from reality (not hypothesis)', psCobra.latest_is_hypothesis === false);
  ok('project.reality has the promotion', psCobra.reality.some((r) => r.summary.includes('promoted to Pillar 3')));
  ok('project.thought has the hypothesis', psCobra.thought.some((r) => r.summary.includes('index reality and thought lanes')));

  // Unknown project → found:false, empty arrays, no throw.
  const psNone = projectState({ fluxRoot: FIXTURE_ROOT, project: 'nonexistent-quux-project', nowMs: NOW });
  eq('project.unknown found=false', psNone.found, false);
  eq('project.unknown reality empty', psNone.reality.length, 0);

  // Project whose newest touch is a thought → latest_is_hypothesis true.
  const psTide = projectState({ fluxRoot: FIXTURE_ROOT, project: 'tide scheduler', nowMs: NOW });
  ok('project.tide found', psTide.found === true);
  ok('project.tide latest is hypothesis', psTide.latest_is_hypothesis === true);

  // ---- 4. recallMistakes ----------------------------------------------------
  // 4a. all mistakes (no kind) → R4 (error) + T4 (guardrails.red.critical) + high-risk turns.
  const mAll = recallMistakes({ fluxRoot: FIXTURE_ROOT, nowMs: NOW });
  ok('mistakes.all ok', mAll.ok === true);
  ok('mistakes.all has G02 error', mAll.mistakes.some((m) => m.summary.includes('FOUNDER_SALARY')));
  ok('mistakes.all has G03 guardrail', mAll.mistakes.some((m) => m.summary.includes('Gate0')));
  ok('mistakes.all newest first', mAll.mistakes.length >= 2 && mAll.mistakes[0].ts >= mAll.mistakes[1].ts);

  // 4b. kind="guardrail" narrows to guardrail-tagged records (both G02 origin + G03 kind).
  const mGuard = recallMistakes({ fluxRoot: FIXTURE_ROOT, kind: 'guardrail', nowMs: NOW });
  ok('mistakes.guardrail nonempty', mGuard.count >= 1);
  ok('mistakes.guardrail all match', mGuard.mistakes.every((m) =>
    (m.summary + m.kind + m.origin).toLowerCase().includes('guardrail') || m.origin.includes('27guardrails')));

  // 4c. kind="G03" → just the Gate0 record.
  const mG03 = recallMistakes({ fluxRoot: FIXTURE_ROOT, kind: 'G03', nowMs: NOW });
  ok('mistakes.G03 found', mG03.mistakes.some((m) => m.summary.includes('Gate0')));
  ok('mistakes.G03 excludes G02', !mG03.mistakes.some((m) => m.summary.includes('FOUNDER_SALARY')));

  // 4d. a routine observation is NOT a mistake.
  ok('mistakes exclude routine observation', !mAll.mistakes.some((m) => m.summary.includes('survey baseline')));

  // ---- 5. empty / offline-safe contract (never throw) -----------------------
  let threw = false;
  let empties = null;
  try {
    empties = {
      t: resolveTimeQuery({ fluxRoot: EMPTY_ROOT, phrase: 'an hour ago', nowMs: NOW }),
      f: surfaceForgottenThreads({ fluxRoot: EMPTY_ROOT, nowMs: NOW }),
      p: projectState({ fluxRoot: EMPTY_ROOT, project: 'anything', nowMs: NOW }),
      m: recallMistakes({ fluxRoot: EMPTY_ROOT, kind: 'error', nowMs: NOW }),
      h: ledgerHealth({ fluxRoot: EMPTY_ROOT }),
    };
  } catch (e) { threw = true; fails.push({ name: 'empty.no-throw', detail: e.message }); }
  ok('empty.no-throw', threw === false);
  if (empties) {
    eq('empty.time count', empties.t.count, 0);
    ok('empty.time ok', empties.t.ok === true);
    eq('empty.forgotten count', empties.f.total_forgotten, 0);
    eq('empty.project found', empties.p.found, false);
    eq('empty.mistakes count', empties.m.total, 0);
    eq('empty.health empty flag', empties.h.empty, true);
  }

  // 5b. undefined fluxRoot (no arg at all) must also not throw → empties.
  let threw2 = false;
  try {
    resolveTimeQuery({ phrase: 'an hour ago', nowMs: NOW });
    surfaceForgottenThreads({ nowMs: NOW });
    projectState({ project: 'x', nowMs: NOW });
    recallMistakes({ nowMs: NOW });
  } catch (e) { threw2 = true; fails.push({ name: 'undef-root.no-throw', detail: e.message }); }
  ok('undef-root.no-throw', threw2 === false);

  cleanup();

  // ── summary ────────────────────────────────────────────────────────────────
  const total = pass + fail;
  console.log('');
  console.log(`Summary: ${pass} pass / ${fail} fail of ${total}`);
  if (fail > 0) {
    console.log('Failures:');
    for (const f of fails) console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`);
  }
  process.exit(fail === 0 ? 0 : 1);
}

try {
  main();
} catch (e) {
  cleanup();
  console.error('FATAL harness error:', e.stack || e.message);
  console.log(`Summary: ${pass} pass / ${fail + 1} fail of ${pass + fail + 1}`);
  process.exit(1);
}
