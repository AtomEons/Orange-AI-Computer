#!/usr/bin/env bun
// AtomSmasher Full-Scope — feature-distinctness test
//
// Closes the gap that audit-01-features-2026-06-27 opened: the
// `all_620_execute_live` test asserts that every feature dispatches
// without throwing and writes a receipt, but it does NOT assert that
// the engine handlers actually behave differently for different
// features in the same bucket. After 2026-06-27's hollow-handler
// fixes, this suite measures the distinct-behavior count honestly:
//
//   case feature_branches_distinct:
//     - For each engine bucket, run executeFeature(A) and
//       executeFeature(B) on the first two features in the bucket and
//       confirm their outputs differ after stripping IDs and timestamps.
//     - Across all 620 registered features, count how many produce
//       structurally-distinct output from at least one other feature in
//       their bucket. Report the count.
//
// Exits 0 only if (a) the bucket-pair check finds distinct behavior in
// every multi-feature bucket and (b) the distinct count exceeds the
// pre-fix audit baseline of 16 / 50 ~= 198 / 620.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../storage.mjs';
import { FeatureExecutor } from '../engines.mjs';
import { FEATURE_NAMES } from '../feature_data.mjs';

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) { if (!cond) throw new Error(`assertion failed: ${msg}`); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)} — ${msg}`); }
function assertGE(a, b, msg) { if (!(a >= b)) throw new Error(`expected ${a} >= ${b} — ${msg}`); }

function makeStore() {
  const tmp = path.join(os.tmpdir(), `feature-distinctness-${process.hrtime.bigint()}.db`);
  return { store: new Store(tmp), tmpPath: tmp };
}
function teardown(s) {
  try { s.store.close(); } catch { /* noop */ }
  try { fs.unlinkSync(s.tmpPath); } catch { /* noop */ }
}

async function runCase(name, fn) {
  const t0 = Number(process.hrtime.bigint() / 1000000n);
  try {
    await fn();
    const t1 = Number(process.hrtime.bigint() / 1000000n);
    console.log(`  PASS  ${name.padEnd(56)} ${String(t1 - t0).padStart(5)}ms`);
    passed++;
  } catch (e) {
    const t1 = Number(process.hrtime.bigint() / 1000000n);
    console.log(`  FAIL  ${name.padEnd(56)} ${String(t1 - t0).padStart(5)}ms  ${e.message}`);
    failed++;
    failures.push([name, e.message, e.stack]);
  }
}

// Strip IDs, timestamps, and call-order artifacts so we compare actual
// shape and content, not autogen nonces.
//
// Patterns scrubbed:
//   - any field key ending in "_id" or named "id"
//   - any field key matching /at$/i (created_at, updated_at, ...)
//   - 16+ hex strings (uniqueRuntimeId nonces)
//   - ISO 8601-ish timestamps
//   - keys: receipt_id, route_id, source_id, atom_id, eq_id, cache_id, lease_id, debt_id
//   - numbers that look like counters (we keep them — if branch logic
//     uses receipts.count, we want to see the differing count)
function canonicalize(obj, seen = new WeakSet()) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    // strip 16+ hex nonces and ISO timestamps from strings
    let s = obj.replace(/\b[a-f0-9]{16,}\b/g, '<HEX>');
    s = s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<TS>');
    return s;
  }
  if (typeof obj !== 'object') return obj;
  if (seen.has(obj)) return '<CIRCULAR>';
  seen.add(obj);
  if (Array.isArray(obj)) return obj.map(v => canonicalize(v, seen));
  const out = {};
  for (const k of Object.keys(obj).sort()) {
    if (k === 'id') continue;
    if (k.endsWith('_id')) continue;
    if (k === 'created_at' || k === 'updated_at' || k.endsWith('_at')) continue;
    if (k === 'iso' || k === 'timestamp' || k === 'timestamp_iso') continue;
    if (k === 'air') continue;                 // AIR addr embeds atom id
    if (k === 'hash' || k === 'repo_map_hash') continue; // content-derived but same shape across
    if (k === 'receipts') continue;            // call-order artifact
    out[k] = canonicalize(obj[k], seen);
  }
  return out;
}

function canonicalJSON(obj) { return JSON.stringify(canonicalize(obj)); }

console.log('AtomSmasher Full-Scope — feature distinctness sweep');
console.log(`Bun ${process.versions.bun ?? '?'}`);
console.log('');

// ---------------------------------------------------------------------------
// Pair-check: two features in the same engine class diverge.
await runCase('paired_features_in_same_class_diverge', () => {
  const s = makeStore();
  try {
    const ex = new FeatureExecutor(s.store);
    // Group by engine
    const byEngine = {};
    for (const f of s.store.all('SELECT id, name, engine FROM features ORDER BY engine, id')) {
      if (!byEngine[f.engine]) byEngine[f.engine] = [];
      byEngine[f.engine].push(f);
    }
    const buckets = Object.entries(byEngine).filter(([_eng, feats]) => feats.length >= 2);
    let identicalPairs = 0;
    let comparedPairs = 0;
    const samples = [];
    for (const [engine, feats] of buckets) {
      const a = ex.executeFeature(feats[0].name).output;
      const b = ex.executeFeature(feats[feats.length - 1].name).output;
      const ja = canonicalJSON(a);
      const jb = canonicalJSON(b);
      comparedPairs++;
      if (ja === jb) {
        identicalPairs++;
        samples.push({ engine, a: feats[0].name, b: feats[feats.length - 1].name, ja_preview: ja.slice(0, 160) });
      }
    }
    if (identicalPairs > 0) {
      console.log(`    identical-pair leak (${identicalPairs}/${comparedPairs}):`);
      for (const s of samples) console.log(`      ${s.engine}: ${s.a} vs ${s.b} -> ${s.ja_preview}`);
    }
    assertEqual(identicalPairs, 0, `every multi-feature engine class must have at least 2 distinct behaviors; ${identicalPairs}/${comparedPairs} buckets still identical`);
    console.log(`    paired check: ${comparedPairs}/${comparedPairs} multi-feature buckets produced distinct outputs`);
  } finally {
    teardown(s);
  }
});

// ---------------------------------------------------------------------------
// Bulk: across all 620 features, count how many produce distinct output
// from at least one other feature in their bucket.
await runCase('feature_branches_distinct', () => {
  const s = makeStore();
  try {
    const ex = new FeatureExecutor(s.store);
    const rows = s.store.all('SELECT id, name, engine FROM features ORDER BY engine, id');
    assertEqual(rows.length, 620, 'features registered');

    // Group by engine.
    const byEngine = {};
    for (const f of rows) {
      if (!byEngine[f.engine]) byEngine[f.engine] = [];
      byEngine[f.engine].push(f);
    }

    // Two honest measures:
    //   D = "strict distinct signatures across all 620"   (most conservative)
    //   E = "features whose signature is not shared by 100% of peers"
    // Audit-1 reported ~16/50 (32%) strict name-specific behavior; we
    // gate on D >= 50% so the post-fix story is unambiguously better
    // than the pre-fix one.
    let featuresWithUnsharedSig = 0;    // E
    let totalInMultiBuckets = 0;
    const allSigs = [];                  // for D
    const perEngineReport = {};

    for (const [engine, feats] of Object.entries(byEngine)) {
      const sigs = [];
      for (const f of feats) {
        try {
          const o = ex.executeFeature(f.name).output;
          sigs.push(canonicalJSON(o));
        } catch (e) {
          sigs.push(`__ERROR__:${e.message}`);
        }
      }
      allSigs.push(...sigs);
      if (feats.length < 2) {
        perEngineReport[engine] = { size: feats.length, distinct_sigs: 1, distinct_features: feats.length };
        continue;
      }
      const counts = {};
      for (const sig of sigs) counts[sig] = (counts[sig] ?? 0) + 1;
      const bucketSize = feats.length;
      const distinctSigs = Object.keys(counts).length;
      let localUnshared = 0;
      if (distinctSigs >= 2) {
        for (const sig of sigs) if (counts[sig] < bucketSize) localUnshared++;
      }
      featuresWithUnsharedSig += localUnshared;
      totalInMultiBuckets += bucketSize;
      perEngineReport[engine] = { size: bucketSize, distinct_sigs: distinctSigs, distinct_features: localUnshared };
    }

    // D — strict global distinct signatures
    const globalSigCounts = {};
    for (const sig of allSigs) globalSigCounts[sig] = (globalSigCounts[sig] ?? 0) + 1;
    const D_strict = Object.keys(globalSigCounts).length;
    // strict-D as features = feature is "strictly distinct" if its
    // signature appears once globally. Counting features (not sigs):
    let strictlyUnique = 0;
    for (const sig of allSigs) if (globalSigCounts[sig] === 1) strictlyUnique++;

    // Per-engine breakdown
    console.log('    per-engine distinctness:');
    for (const [eng, r] of Object.entries(perEngineReport).sort()) {
      const ratio = r.size > 0 ? (r.distinct_sigs / r.size * 100).toFixed(0) + '%' : '—';
      console.log(`      ${eng.padEnd(20)} size=${String(r.size).padStart(3)}  distinct_sigs=${String(r.distinct_sigs).padStart(3)} (${ratio.padStart(4)})  distinct_features=${String(r.distinct_features).padStart(3)}`);
    }
    console.log(`    metric E (features with !all-shared sig)  : ${featuresWithUnsharedSig}/620`);
    console.log(`    metric D (strictly-unique signature count): ${strictlyUnique}/620 (${D_strict} distinct sigs out of 620 features)`);

    // Audit-1 baseline: 16/50 (32%) had strict name-specific behavior.
    // Post-fix we require strictly-unique >= 60% (372/620). This is the
    // honest, conservative gate.
    assertGE(strictlyUnique, 372, `strictly-unique features should clear 60%; got ${strictlyUnique}/620`);
    // And no bucket should have 100% shared output across all features.
    assertGE(featuresWithUnsharedSig, 580, `features in multi-feature buckets with at least one differing peer; got ${featuresWithUnsharedSig}/620`);

    // Stash counts on a global so other tools can read them back.
    globalThis.__featureDistinctnessCount = strictlyUnique;
    globalThis.__featureDistinctnessE = featuresWithUnsharedSig;
  } finally {
    teardown(s);
  }
});

// ---------------------------------------------------------------------------
// Sanity: an outright dupe in registry (e.g. SkillQuarantineRegistry appears
// twice) should still produce identical output by construction. We allow that.
await runCase('exact_name_duplicates_allowed_to_match', () => {
  const s = makeStore();
  try {
    const dupes = {};
    for (const f of s.store.all('SELECT name, COUNT(*) c FROM features GROUP BY name HAVING c > 1')) {
      dupes[f.name] = f.c;
    }
    // The registry has known intentional dupes — assert they exist so this
    // case is real, not vacuous.
    assert(Object.keys(dupes).length >= 1, 'at least one intentional name dupe exists in registry');
    console.log(`    intentional name duplicates in registry: ${Object.keys(dupes).length} (e.g. ${Object.keys(dupes)[0]})`);
  } finally {
    teardown(s);
  }
});

// ---------------------------------------------------------------------------
console.log('');
console.log(`Summary: ${passed} pass / ${failed} fail of ${passed + failed}`);
if (failed > 0) {
  console.log('');
  console.log('Failures:');
  for (const [name, msg, stack] of failures) {
    console.log(`  ${name}:`);
    console.log(`    ${msg}`);
    if (process.env.VERBOSE) console.log(stack);
  }
  process.exit(1);
}
process.exit(0);
