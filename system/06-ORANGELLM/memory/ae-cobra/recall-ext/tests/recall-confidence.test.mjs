#!/usr/bin/env bun
// recall-confidence.test.mjs — standalone Bun harness for recall-ext #6 (recall-confidence).
//
// Zero npm deps. Verifies the confidence heuristic's ordering properties (reality
// + corroboration + recency + volume all push up; ok:false / empty push to zero),
// then exercises the convenience recallers against a synthetic ledger where one
// project is corroborated across both lanes (high) and another is a lone stale
// thought (low).
//
// Run:  bun recall-ext/tests/recall-confidence.test.mjs
// Prints:  Summary: N pass / M fail of T   (exit 0 iff all pass)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  scoreEvidence, confidenceForProject, confidenceForTime, CONF_WEIGHTS,
} from '../recall-confidence.mjs';

const NOW = Date.parse('2026-07-03T18:00:00.000Z');
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

const SCRATCH = process.env.AE_TEST_TMP
  || path.join(process.env.TEMP || process.env.TMP || '/tmp', 'ae_cobra_conf_test');
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

// Build helpers for synthetic supporting-record arrays (live record shape).
function rec(lane, ts, summary, hash = 'h' + Math.random().toString(36).slice(2)) {
  return { ts, lane, origin: 'x', kind: 'decision', body: { summary }, hash };
}

function buildFixture() {
  fs.mkdirSync(FIXTURE_ROOT, { recursive: true });
  // "Aurora engine" — corroborated: 2 reality + 1 thought, all recent → HIGH.
  const reality = [
    { ts: NOW - 2 * HOUR, origin: 'operator', kind: 'decision',
      body: { lane: 'reality', event_type: 'decision', summary: 'Aurora engine dual pass shipped and verified', entities: ['Aurora', 'engine'], files: ['x/aurora.mjs'], commands: ['bun test'], risk: 'low', next_action: null, confidence: 0.9 } },
    { ts: NOW - 1 * HOUR, origin: 'hermes', kind: 'receipt',
      body: { lane: 'reality', event_type: 'receipt', summary: 'Aurora engine receipt #200 written', entities: ['Aurora', 'engine'], files: ['receipts/200.json'], commands: [], risk: 'low', next_action: null, confidence: 0.9 } },
  ];
  const thought = [
    { ts: NOW - 3 * HOUR, origin: 'orangellm_reasoning', kind: 'decision',
      body: { lane: 'thought', event_type: 'decision', summary: 'Aurora engine plan: add a dual verification pass', entities: ['Aurora', 'engine'], files: [], commands: [], risk: 'low', next_action: 'implement', confidence: 0.7 } },
    // "Nimbus sketch" — lone stale thought, 40 days old, no reality → LOW.
    { ts: NOW - 40 * DAY, origin: 'orangellm_reasoning', kind: 'decision',
      body: { lane: 'thought', event_type: 'decision', summary: 'Nimbus sketch: maybe a floating widget idea someday', entities: ['Nimbus'], files: [], commands: [], risk: 'low', next_action: null, confidence: 0.3 } },
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

  // ---- 0. hard floors --------------------------------------------------------
  const cFalse = scoreEvidence([rec(REALITYlane(), NOW, 'x')], { ok: false });
  eq('ok:false → 0', cFalse.confidence, 0);
  eq('ok:false → band none', cFalse.band, 'none');
  const cEmpty = scoreEvidence([], { ok: true, answered: false });
  eq('empty → 0', cEmpty.confidence, 0);
  eq('empty → none', cEmpty.band, 'none');
  const cUndef = scoreEvidence(undefined, {});
  eq('undefined support → 0', cUndef.confidence, 0);

  // ---- 1. ordering properties ------------------------------------------------
  // more evidence → higher
  const one = scoreEvidence([r('reality', NOW - HOUR)], { nowMs: NOW });
  const three = scoreEvidence([r('reality', NOW - HOUR), r('reality', NOW - 2 * HOUR), r('reality', NOW - 3 * HOUR)], { nowMs: NOW });
  ok('more evidence → higher confidence', three.confidence > one.confidence, `3=${three.confidence} 1=${one.confidence}`);

  // reality-only > thought-only (same count, same recency)
  const realOnly = scoreEvidence([r('reality', NOW - HOUR), r('reality', NOW - 2 * HOUR)], { nowMs: NOW });
  const thoughtOnly = scoreEvidence([r('thought', NOW - HOUR), r('thought', NOW - 2 * HOUR)], { nowMs: NOW });
  ok('reality-only > thought-only', realOnly.confidence > thoughtOnly.confidence, `R=${realOnly.confidence} T=${thoughtOnly.confidence}`);

  // corroboration (both lanes) > single lane of same size
  const both = scoreEvidence([r('reality', NOW - HOUR), r('thought', NOW - 2 * HOUR)], { nowMs: NOW });
  const single = scoreEvidence([r('reality', NOW - HOUR), r('reality', NOW - 2 * HOUR)], { nowMs: NOW });
  ok('corroborated across lanes > single-lane', both.confidence > single.confidence, `both=${both.confidence} single=${single.confidence}`);

  // recent > stale (same lane/count)
  const recent = scoreEvidence([r('reality', NOW - HOUR), r('reality', NOW - 2 * HOUR)], { nowMs: NOW });
  const stale = scoreEvidence([r('reality', NOW - 60 * DAY), r('reality', NOW - 61 * DAY)], { nowMs: NOW });
  ok('recent > stale', recent.confidence > stale.confidence, `recent=${recent.confidence} stale=${stale.confidence}`);

  // ambiguity penalty lowers confidence
  const clean = scoreEvidence([r('reality', NOW - HOUR), r('reality', NOW - 2 * HOUR)], { nowMs: NOW });
  const ambiguous = scoreEvidence([r('reality', NOW - HOUR), r('reality', NOW - 2 * HOUR)], { nowMs: NOW, ambiguityCandidates: 5 });
  ok('ambiguity lowers confidence', ambiguous.confidence < clean.confidence, `amb=${ambiguous.confidence} clean=${clean.confidence}`);

  // ---- 2. bounds + breakdown -------------------------------------------------
  ok('confidence in [0,1]', three.confidence >= 0 && three.confidence <= 1);
  ok('signals present', typeof three.signals.evidence === 'number' && Array.isArray(three.reasons));
  ok('band is a known label', ['high', 'medium', 'low', 'none'].includes(three.band));

  // A strongly-corroborated recent 3-record answer should reach medium or better.
  const strong = scoreEvidence([r('reality', NOW - HOUR), r('reality', NOW - 2 * HOUR), r('thought', NOW - 3 * HOUR)], { nowMs: NOW });
  ok('strong answer ≥ medium', strong.band === 'medium' || strong.band === 'high', `band=${strong.band} conf=${strong.confidence}`);

  // ---- 3. convenience: confidenceForProject ----------------------------------
  const aurora = confidenceForProject({ fluxRoot: FIXTURE_ROOT, project: 'Aurora engine', nowMs: NOW });
  ok('project conf ok', aurora.ok === true);
  ok('project conf found', aurora.found === true);
  ok('Aurora is corroborated (reality+thought)', aurora.signals.counts.reality >= 2 && aurora.signals.counts.thought >= 1);
  ok('Aurora confidence is solid (≥ medium)', aurora.band === 'medium' || aurora.band === 'high', `band=${aurora.band} conf=${aurora.confidence}`);

  const nimbus = confidenceForProject({ fluxRoot: FIXTURE_ROOT, project: 'Nimbus', nowMs: NOW });
  ok('Nimbus found', nimbus.found === true);
  ok('Nimbus is thought-only', nimbus.signals.counts.reality === 0 && nimbus.signals.counts.thought >= 1);
  ok('Nimbus confidence weaker than Aurora', nimbus.confidence < aurora.confidence, `nimbus=${nimbus.confidence} aurora=${aurora.confidence}`);
  ok('Nimbus band is low/medium (stale lone thought)', ['low', 'medium'].includes(nimbus.band), `band=${nimbus.band}`);

  // Unknown project → found:false → confidence 0 / none.
  const unknown = confidenceForProject({ fluxRoot: FIXTURE_ROOT, project: 'zzz-nonexistent', nowMs: NOW });
  eq('unknown project confidence 0', unknown.confidence, 0);
  eq('unknown project band none', unknown.band, 'none');

  // ---- 4. convenience: confidenceForTime -------------------------------------
  const t = confidenceForTime({ fluxRoot: FIXTURE_ROOT, phrase: 'an hour ago', nowMs: NOW });
  ok('time conf ok', t.ok === true);
  ok('time conf has a band', ['high', 'medium', 'low', 'none'].includes(t.band));

  // bad phrase → ok:false, confidence 0.
  const tBad = confidenceForTime({ fluxRoot: FIXTURE_ROOT, phrase: 'whenever-ish', nowMs: NOW });
  eq('time bad ok=false', tBad.ok, false);
  eq('time bad confidence 0', tBad.confidence, 0);

  // ---- 5. determinism --------------------------------------------------------
  const again = confidenceForProject({ fluxRoot: FIXTURE_ROOT, project: 'Aurora engine', nowMs: NOW });
  eq('deterministic confidence', again.confidence, aurora.confidence);

  // ---- 6. empty / offline-safe (never throw) ---------------------------------
  let threw = false, e = null;
  try {
    e = {
      p: confidenceForProject({ fluxRoot: EMPTY_ROOT, project: 'anything', nowMs: NOW }),
      t: confidenceForTime({ fluxRoot: EMPTY_ROOT, phrase: 'an hour ago', nowMs: NOW }),
      u: confidenceForProject({ project: 'x', nowMs: NOW }),
    };
  } catch (err) { threw = true; fails.push({ name: 'empty.no-throw', detail: err.message }); }
  ok('empty.no-throw', threw === false);
  if (e) {
    eq('empty.project confidence 0', e.p.confidence, 0);
    eq('empty.project band none', e.p.band, 'none');
    eq('empty.time confidence 0', e.t.confidence, 0);
    eq('undef-root project confidence 0', e.u.confidence, 0);
  }

  cleanup();
  const total = pass + fail;
  console.log('');
  console.log(`Summary: ${pass} pass / ${fail} fail of ${total}`);
  if (fail > 0) { console.log('Failures:'); for (const f of fails) console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`); }
  process.exit(fail === 0 ? 0 : 1);
}

// tiny record factory for synthetic supporting arrays
function r(lane, ts) { return { ts, lane, origin: 'x', kind: 'decision', body: { summary: `${lane} rec` }, hash: 'h' + lane + ts }; }
function REALITYlane() { return 'reality'; }
const REALITY = 'reality';

try { main(); }
catch (e) { cleanup(); console.error('FATAL harness error:', e.stack || e.message); console.log(`Summary: ${pass} pass / ${fail + 1} fail of ${pass + fail + 1}`); process.exit(1); }
