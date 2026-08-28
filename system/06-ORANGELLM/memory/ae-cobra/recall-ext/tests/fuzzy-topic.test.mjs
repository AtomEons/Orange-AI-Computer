#!/usr/bin/env bun
// fuzzy-topic.test.mjs — standalone Bun harness for recall-ext #1 (fuzzy-topic).
//
// Zero npm deps. Builds a synthetic Flux ledger (live per-lane/per-day JSONL,
// live record shape) crafted to isolate FUZZY behavior: a thought that is only
// "followed through" under stem/synonym matching, and a thread that stays
// forgotten under both exact and fuzzy. Points the module at it via fluxRoot.
//
// Run:  bun recall-ext/tests/fuzzy-topic.test.mjs
// Prints:  Summary: N pass / M fail of T   (exit 0 iff all pass — Mom's Law)
//
// Fixture (NOW anchored = 2026-07-03T18:00:00Z):
//   Reality:
//     R1 ~40m ago  decision  "Compression shipped for the receipt archives"
//                    → the follow-through for T1 ONLY under stem/synonym
//                      ("compression"≈"compress", "receipt"=receipt, "shipped"≈"ship")
//     R2 ~20m ago  observation "Marco Island tide table verified"  (unrelated noise)
//   Thought:
//     T1 ~90m ago  orangellm_reasoning "Plan: compress the receipts and ship to cold storage"
//                    → FOLLOWED under fuzzy (via R1), NOT followed under exact
//     T2 ~80m ago  orangellm_reasoning "Idea: build a quantum flux capacitor for the boat"
//                    → forgotten under BOTH exact and fuzzy (no reality overlap)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  stem, canon, canonSet, fuzzyOverlap, fuzzySharedCount, matchTopic,
  surfaceForgottenThreadsFuzzy,
} from '../fuzzy-topic.mjs';
import { surfaceForgottenThreads } from '../../recall-engine.mjs';

const NOW = Date.parse('2026-07-03T18:00:00.000Z');
const MIN = 60_000, HOUR = 3_600_000;

const __filename = fileURLToPath(import.meta.url);
const SCRATCH = process.env.AE_TEST_TMP
  || path.join(process.env.TEMP || process.env.TMP || '/tmp', 'ae_cobra_fuzzy_test');
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
    fs.writeFileSync(path.join(dir, `${day}.jsonl`), recs.map((x) => JSON.stringify(x)).join('\n') + '\n');
  }
}

function buildFixture() {
  fs.mkdirSync(FIXTURE_ROOT, { recursive: true });
  // Reality R1 shares with thought T1 ONLY via morphology/synonyms:
  //   compression↔compress (stem), receipt↔receipts (stem), shipped↔ship (stem/synonym).
  // NO exact token is shared (deliberately: no "archives"/"storage"/"cold" overlap),
  // so the EXACT engine must miss it and only FUZZY can catch the follow-through.
  const reality = [
    {
      ts: NOW - 40 * MIN, origin: 'operator', kind: 'decision',
      body: { lane: 'reality', event_type: 'decision', summary: 'Compression shipped; receipt volume reduced substantially', entities: ['compression'], files: [], commands: [], risk: 'low', next_action: 'measure ratio', confidence: 0.9 },
    },
    {
      ts: NOW - 20 * MIN, origin: 'terminal', kind: 'observation',
      body: { lane: 'reality', event_type: 'observation', summary: 'Marco Island tide table verified against NOAA station', entities: ['Marco Island', 'tide'], files: [], commands: [], risk: 'low', next_action: null, confidence: 0.95 },
    },
  ];
  const thought = [
    {
      ts: NOW - 90 * MIN, origin: 'orangellm_reasoning', kind: 'decision',
      body: { lane: 'thought', event_type: 'decision', summary: 'Plan: compress the receipts and ship them onward', entities: ['receipts'], files: [], commands: ['bun compress.mjs'], risk: 'low', next_action: 'wire compressor', confidence: 0.7 },
    },
    {
      ts: NOW - 80 * MIN, origin: 'orangellm_reasoning', kind: 'decision',
      body: { lane: 'thought', event_type: 'decision', summary: 'Idea: build a quantum flux capacitor for the boat propulsion prototype', entities: ['quantum', 'capacitor'], files: [], commands: [], risk: 'low', next_action: 'sketch design', confidence: 0.4 },
    },
  ];
  writeLedger(FIXTURE_ROOT, 'reality', reality);
  writeLedger(FIXTURE_ROOT, 'thought', thought);
}

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) pass++;
  else { fail++; fails.push({ name, detail }); console.log(`  FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq(name, got, want) { ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
function cleanup() { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {} }

function main() {
  cleanup();
  buildFixture();

  // ---- 0. stemmer / canon ----------------------------------------------------
  eq('stem compression', stem('compression'), stem('compress'));   // collapse to same stem
  eq('stem shipping→ship', stem('shipping'), 'ship');
  eq('stem studies→study', stem('studies'), 'study');
  eq('stem short word unchanged', stem('cat'), 'cat');
  // synonyms collapse to class head
  eq('canon bug→error', canon('bug'), 'error');
  eq('canon ship→deploy', canon('ship'), 'deploy');
  eq('canon receipts→receipt', canon('receipts'), 'receipt');
  ok('canon compress family same', canon('compression') === canon('compressor'));

  // ---- 1. fuzzy set metrics --------------------------------------------------
  const a = canonSet(['compress', 'receipts', 'ship']);
  const b = canonSet(['compression', 'receipt', 'deploy']);   // all fuzzy-equal to a
  eq('fuzzy shared full', fuzzySharedCount(a, b), 3);
  ok('fuzzy overlap high', fuzzyOverlap(a, b) > 0.9);
  eq('fuzzy overlap empty-left', fuzzyOverlap(new Set(), b), 0);
  eq('fuzzy overlap empty-right', fuzzyOverlap(a, new Set()), 0);

  // ---- 2. matchTopic ---------------------------------------------------------
  const rec = { body: { summary: 'Compression shipped for the receipt archives', entities: [], files: [], commands: [] } };
  const mt = matchTopic('compress receipts', rec);
  ok('matchTopic finds overlap', mt.shared >= 2);
  ok('matchTopic overlap positive', mt.overlap > 0);

  // ---- 3. fuzzy vs exact forgotten (the core value) --------------------------
  const exact = surfaceForgottenThreads({ fluxRoot: FIXTURE_ROOT, nowMs: NOW });
  const fuzzy = surfaceForgottenThreadsFuzzy({ fluxRoot: FIXTURE_ROOT, nowMs: NOW });
  ok('fuzzy.ok', fuzzy.ok === true);
  const exactSumm = exact.threads.map((t) => t.summary);
  const fuzzySumm = fuzzy.threads.map((t) => t.summary);

  // EXACT wrongly calls the compress/ship plan forgotten (morphological miss).
  ok('exact WRONGLY forgets the compress plan', exactSumm.some((s) => s.includes('compress the receipts')));
  // FUZZY correctly recognizes it as followed → NOT forgotten.
  ok('fuzzy CORRECTLY drops the compress plan (followed)', !fuzzySumm.some((s) => s.includes('compress the receipts')));
  // Both agree the quantum capacitor idea is genuinely forgotten.
  ok('exact keeps quantum idea forgotten', exactSumm.some((s) => s.includes('quantum flux capacitor')));
  ok('fuzzy keeps quantum idea forgotten', fuzzySumm.some((s) => s.includes('quantum flux capacitor')));
  // Net: fuzzy surfaces strictly fewer false forgottens here.
  ok('fuzzy total < exact total', fuzzy.total_forgotten < exact.total_forgotten,
     `fuzzy=${fuzzy.total_forgotten} exact=${exact.total_forgotten}`);
  eq('fuzzy total is exactly 1', fuzzy.total_forgotten, 1);
  ok('fuzzy threads carry canon_tokens', fuzzy.threads.every((t) => Array.isArray(t.canon_tokens)));
  ok('fuzzy threads flagged _fuzzy', fuzzy.threads.every((t) => t._fuzzy === true));

  // ---- 4. determinism --------------------------------------------------------
  const again = surfaceForgottenThreadsFuzzy({ fluxRoot: FIXTURE_ROOT, nowMs: NOW });
  eq('deterministic total', again.total_forgotten, fuzzy.total_forgotten);
  eq('deterministic first summary', again.threads[0]?.summary, fuzzy.threads[0]?.summary);

  // ---- 5. empty / offline-safe (never throw) ---------------------------------
  let threw = false, e = null;
  try {
    e = {
      f: surfaceForgottenThreadsFuzzy({ fluxRoot: EMPTY_ROOT, nowMs: NOW }),
      m: matchTopic('anything', { body: { summary: '' } }),
      u: surfaceForgottenThreadsFuzzy({ nowMs: NOW }),   // undefined root
    };
  } catch (err) { threw = true; fails.push({ name: 'empty.no-throw', detail: err.message }); }
  ok('empty.no-throw', threw === false);
  if (e) {
    eq('empty.forgotten count', e.f.total_forgotten, 0);
    ok('empty.forgotten ok', e.f.ok === true);
    eq('empty.match shared 0', e.m.shared, 0);
    eq('undef-root forgotten count', e.u.total_forgotten, 0);
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
