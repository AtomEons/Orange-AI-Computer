#!/usr/bin/env bun
// decay-rank.test.mjs — standalone Bun harness for recall-ext #2 (decay-rank).
//
// Zero npm deps. Synthetic Flux ledger crafted to prove the two axes interact:
// importance can lift an OLDER critical record above a NEWER routine one, while
// recency still dominates between records of similar importance. Also checks the
// decay kernel math, query relevance, determinism, and the empty-safe contract.
//
// Run:  bun recall-ext/tests/decay-rank.test.mjs
// Prints:  Summary: N pass / M fail of T   (exit 0 iff all pass)
//
// Fixture (NOW = 2026-07-03T18:00:00Z):
//   Reality:
//     R_old_crit  ~2 days ago  error "guardrail G02 FOUNDER_SALARY unset — build blocked" (risk high, mistake)
//     R_new_noise ~5 min ago   observation "ambient temperature logged 24C"              (risk low, routine)
//     R_recent_dec ~1 hour ago decision "recall engine promoted to Pillar 3"             (decision, files, next_action)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  recencyWeight, importanceBoost, relevanceScore, rankRecall, WEIGHTS,
} from '../decay-rank.mjs';

const NOW = Date.parse('2026-07-03T18:00:00.000Z');
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

const SCRATCH = process.env.AE_TEST_TMP
  || path.join(process.env.TEMP || process.env.TMP || '/tmp', 'ae_cobra_decay_test');
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
      ts: NOW - 2 * DAY, origin: 'doctrine.27guardrails.triage', kind: 'error',
      body: { lane: 'reality', event_type: 'error', summary: 'guardrail G02 FOUNDER_SALARY_PER_INSTALL_CENTS unset — build blocked', guardrail_id: 'G02', severity: 'CRITICAL', entities: ['G02', 'FOUNDER_SALARY'], files: ['runtime/node.py'], commands: [], risk: 'high', next_action: 'set env var', confidence: 0.99 },
    },
    {
      ts: NOW - 5 * MIN, origin: 'sensor', kind: 'observation',
      body: { lane: 'reality', event_type: 'observation', summary: 'ambient temperature logged 24C in the lab', entities: ['temperature'], files: [], commands: [], risk: 'low', next_action: null, confidence: 0.5 },
    },
    {
      ts: NOW - 1 * HOUR, origin: 'operator', kind: 'decision',
      body: { lane: 'reality', event_type: 'decision', summary: 'AE Cobra recall engine promoted to Pillar 3', entities: ['AE Cobra', 'recall engine'], files: ['06-ORANGELLM/memory/ae-cobra/recall-engine.mjs'], commands: ['bun test'], risk: 'low', next_action: 'wire into Mirage', confidence: 0.92 },
    },
  ];
  writeLedger(FIXTURE_ROOT, 'reality', reality);
  writeLedger(FIXTURE_ROOT, 'thought', []); // empty thought lane is valid
}

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, detail) { if (cond) pass++; else { fail++; fails.push({ name, detail }); console.log(`  FAIL: ${name}${detail ? ` — ${detail}` : ''}`); } }
function eq(name, got, want) { ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
function approx(name, got, want, eps = 1e-6) { ok(name, Math.abs(got - want) <= eps, `got ${got}, want ${want}`); }
function cleanup() { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {} }

function main() {
  cleanup(); buildFixture();

  // ---- 0. recency kernel math ------------------------------------------------
  approx('recency age 0 → 1', recencyWeight(0, 7 * DAY), 1);
  approx('recency one half-life → 0.5', recencyWeight(7 * DAY, 7 * DAY), 0.5);
  approx('recency two half-lives → 0.25', recencyWeight(14 * DAY, 7 * DAY), 0.25);
  ok('recency monotone decreasing', recencyWeight(1 * DAY, 7 * DAY) > recencyWeight(3 * DAY, 7 * DAY));
  approx('recency negative age clamps to 1', recencyWeight(-500, 7 * DAY), 1);

  // ---- 1. importance boost ---------------------------------------------------
  const critRec = { kind: 'error', body: { risk: 'high', summary: 'guardrail blocked', files: ['x'], next_action: 'fix', confidence: 1 } };
  const routineRec = { kind: 'observation', body: { risk: 'low', summary: 'temp logged', confidence: 0.5 } };
  ok('importance crit > routine', importanceBoost(critRec) > importanceBoost(routineRec));
  ok('importance crit includes mistake+riskHigh', importanceBoost(critRec) >= WEIGHTS.mistake + WEIGHTS.riskHigh);
  eq('importance empty rec is 0', importanceBoost({ body: {} }), 0);

  // ---- 2. relevance composite: importance flips recency ----------------------
  // OLD critical (2d) vs NEW routine (5m). With 7-day half-life the routine's
  // recency edge must NOT overcome the critical's importance.
  const rOldCrit = relevanceScore(critRec ? { ts: NOW - 2 * DAY, ...critRec } : {}, { nowMs: NOW });
  const rNewNoise = relevanceScore({ ts: NOW - 5 * MIN, ...routineRec }, { nowMs: NOW });
  ok('old-critical outranks new-routine', rOldCrit > rNewNoise, `crit=${rOldCrit} noise=${rNewNoise}`);

  // ---- 3. rankRecall end-to-end on the ledger --------------------------------
  const r = rankRecall({ fluxRoot: FIXTURE_ROOT, nowMs: NOW });
  ok('rank ok', r.ok === true);
  eq('rank scanned 3', r.scanned, 3);
  const top = r.ranked[0];
  ok('rank #1 is the critical guardrail', top.summary.includes('FOUNDER_SALARY'),
     `top was: ${top.summary}`);
  ok('rank #1 beats the 5-min temperature note', !r.ranked[0].summary.includes('temperature'));
  ok('every ranked has a breakdown', r.ranked.every((x) => x.breakdown && typeof x.breakdown.recency_weight === 'number'));
  ok('relevance sorted descending', r.ranked.every((x, i, arr) => i === 0 || arr[i - 1].relevance >= x.relevance));

  // ---- 4. query relevance re-weights -----------------------------------------
  // Query "temperature" adds a topic boost ONLY to the matching record. It must
  // raise that record's own relevance, and lift it above the non-matching recall-
  // engine decision — without dishonestly overtaking the far-higher critical
  // guardrail (importance is real, a topical query does not erase it).
  const baseNoQuery = rankRecall({ fluxRoot: FIXTURE_ROOT, nowMs: NOW });
  const rq = rankRecall({ fluxRoot: FIXTURE_ROOT, nowMs: NOW, query: 'temperature' });
  const tempBase = baseNoQuery.ranked.find((x) => x.summary.includes('temperature'));
  const tempQ = rq.ranked.find((x) => x.summary.includes('temperature'));
  const decisionQ = rq.ranked.find((x) => x.summary.includes('promoted to Pillar 3'));
  ok('query raises the matching record relevance', tempQ.relevance > tempBase.relevance,
     `q=${tempQ.relevance} base=${tempBase.relevance}`);
  ok('query lifts temp above the non-matching decision', tempQ.relevance > decisionQ.relevance,
     `temp=${tempQ.relevance} decision=${decisionQ.relevance}`);
  ok('non-matching records get no query boost', decisionQ.breakdown.importance_boost
     === baseNoQuery.ranked.find((x) => x.summary.includes('promoted to Pillar 3')).breakdown.importance_boost);

  // ---- 5. determinism --------------------------------------------------------
  const again = rankRecall({ fluxRoot: FIXTURE_ROOT, nowMs: NOW });
  eq('deterministic top summary', again.ranked[0].summary, r.ranked[0].summary);
  eq('deterministic top relevance', again.ranked[0].relevance, r.ranked[0].relevance);

  // ---- 6. empty / offline-safe (never throw) ---------------------------------
  let threw = false, e = null;
  try {
    e = { r: rankRecall({ fluxRoot: EMPTY_ROOT, nowMs: NOW }), u: rankRecall({ nowMs: NOW }) };
  } catch (err) { threw = true; fails.push({ name: 'empty.no-throw', detail: err.message }); }
  ok('empty.no-throw', threw === false);
  if (e) {
    eq('empty.count 0', e.r.count, 0);
    ok('empty.ok', e.r.ok === true);
    eq('empty.ranked empty', e.r.ranked.length, 0);
    eq('undef-root count 0', e.u.count, 0);
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
