#!/usr/bin/env node
// 11-MIRAGE/tests/cache.test.mjs
//
// Offline-safe test battery for the cache adapter (memory-family, downstream-only
// proxy to N150 shadow cache at 06-ORANGELLM/memory/cache/).
//
// Discipline gates covered:
//   1. healthz never throws (honest stub when sync state missing or dir missing)
//   2. read() routes ops (stateBrief default, readShadowCache explicit), refuses unknown ops
//   3. read() returns shadow:true on every successful path
//   4. write() ALWAYS refuses with reason='cache_is_downstream_only' (downstream invariant)
//   5. read() against a real (or absent) shadow dir does not throw — returns honest reasons
//
// Run: node 11-MIRAGE/tests/cache.test.mjs

import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the shadow cache at a clean temp dir so we don't depend on the real cockpit.
const TMP_BASE = mkdtempSync(join(tmpdir(), 'mirage-cache-test-'));
process.env.ORANGE5_CACHE_DIR = TMP_BASE;
process.env.MIRAGE_FETCH_TIMEOUT_MS = '500';

const { cacheAdapter, __internals } = await import('../adapters/cache.mjs');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  PASS ${msg}`); }
  else      { fail++; console.log(`  FAIL ${msg}`); }
}

// ── 0. __internals exposed for audit ────────────────────────────────────────
{
  assert(typeof __internals === 'object' && __internals !== null,
    '__internals object exposed for tests');
  assert(Array.isArray(__internals.READ_OPS) && __internals.READ_OPS.length === 2,
    '__internals.READ_OPS lists the two supported read ops');
  assert(__internals.READ_OPS.includes('stateBrief') && __internals.READ_OPS.includes('readShadowCache'),
    'READ_OPS includes stateBrief and readShadowCache');
}

// ── 1. write() refuses unconditionally (downstream-only invariant) ──────────
{
  const w1 = await cacheAdapter.write({});
  assert(w1.ok === false, 'write({}) refuses');
  assert(w1.reason === 'cache_is_downstream_only',
    `write reason is cache_is_downstream_only (got ${w1.reason})`);
  assert(typeof w1.redirect === 'string' && w1.redirect.includes('flux'),
    'write refusal points caller at flux adapter');
  assert(typeof w1.spec === 'string' && w1.spec.includes('cache'),
    'write refusal includes spec link');

  // Refusal must hold regardless of what the caller passes.
  const w2 = await cacheAdapter.write({ op: 'set', key: 'k', value: 'v', operator_approved: true });
  assert(w2.ok === false && w2.reason === 'cache_is_downstream_only',
    'write refuses even with operator_approved:true (no bypass)');

  const w3 = await cacheAdapter.write({ records: [{ ts: 1, lane: 'reality' }] });
  assert(w3.ok === false && w3.reason === 'cache_is_downstream_only',
    'write refuses arbitrary record-shaped payloads');
}

// ── 2. read() op routing — unknown op refused honestly ──────────────────────
{
  const r1 = await cacheAdapter.read({ op: 'nope' });
  assert(r1.ok === false, 'read({op:nope}) refuses');
  assert(r1.reason === 'unknown_read_op',
    `read unknown_op reason (got ${r1.reason})`);
  assert(typeof r1.detail === 'string' && r1.detail.includes('stateBrief'),
    'read unknown_op detail lists supported ops');
}

// ── 3. read() against EMPTY shadow dir — no records, no throw ───────────────
// We pointed ORANGE5_CACHE_DIR at a fresh empty dir. shadow-reader treats the
// dir as existing-but-empty: returns zero records, freshness with no sync state.
{
  assert(existsSync(TMP_BASE), 'temp shadow dir exists');

  const r1 = await cacheAdapter.read({});
  assert(r1.ok === true, 'read() default op (stateBrief) succeeds with empty cache');
  assert(r1.op === 'stateBrief', 'default op routed to stateBrief');
  assert(r1.source === 'shadow-cache', 'source tagged shadow-cache');
  assert(r1.shadow === true, 'shadow flag set true (caller MUST honor reality-overrides rule)');
  assert(r1.brief && typeof r1.brief === 'object', 'brief object returned');
  assert(r1.brief.shadow === true, 'brief.shadow:true (consistent with adapter envelope)');
  assert(Array.isArray(r1.brief.reality) && r1.brief.reality.length === 0,
    'brief.reality empty (empty cache)');
  assert(Array.isArray(r1.brief.thought) && r1.brief.thought.length === 0,
    'brief.thought empty');

  const r2 = await cacheAdapter.read({ op: 'readShadowCache' });
  assert(r2.ok === true, 'read({op:readShadowCache}) succeeds with empty cache');
  assert(r2.op === 'readShadowCache', 'explicit op routed correctly');
  assert(r2.source === 'shadow-cache' && r2.shadow === true,
    'readShadowCache result tagged shadow-cache + shadow:true');
  assert(Array.isArray(r2.records) && r2.records.length === 0,
    'records empty');
  assert(typeof r2.by_lane === 'object' && r2.by_lane !== null,
    'by_lane object returned');
  assert(typeof r2.freshness === 'object', 'freshness object returned');
  assert(r2.truncated === false, 'truncated false for empty cache');
}

// ── 4. read() with seeded jsonl records — proxy actually pulls through ──────
{
  const today = new Date().toISOString().slice(0, 10);
  const realityFile = join(TMP_BASE, `reality-${today}.jsonl`);
  const now = Date.now();
  writeFileSync(realityFile,
    JSON.stringify({ ts: now - 1000, subject: 'test_subject', summary: 'cymbal crashed', kind: 'decision' }) + '\n' +
    JSON.stringify({ ts: now - 2000, subject: 'orange3',     summary: 'cockpit up',     kind: 'event'    }) + '\n',
    'utf8',
  );
  // Also seed a .sync-state.json so freshness has a non-null last_sync_ms.
  writeFileSync(join(TMP_BASE, '.sync-state.json'),
    JSON.stringify({
      last_run_ms: now - 5000,
      last_run_at: new Date(now - 5000).toISOString(),
      lanes: { reality: { last_sync_ms: now - 5000, last_sync_at: new Date(now - 5000).toISOString(), ok: true } },
    }),
    'utf8',
  );

  const r1 = await cacheAdapter.read({ op: 'readShadowCache', maxRecords: 10 });
  assert(r1.ok === true, 'seeded read succeeds');
  assert(r1.records.length === 2,
    `seeded read returns 2 records (got ${r1.records.length})`);
  assert(r1.records[0].ts > r1.records[1].ts, 'records sorted newest-first');
  assert(r1.records[0].lane === 'reality', 'records tagged with lane');

  const r2 = await cacheAdapter.read({ op: 'stateBrief' });
  assert(r2.ok === true && r2.brief.reality.length === 2,
    `stateBrief surfaces 2 reality lines (got ${r2.brief.reality?.length})`);
  assert(r2.brief.last_sync_ms != null, 'brief carries last_sync_ms from sync state');

  // Query filter exercised end-to-end through the adapter.
  const r3 = await cacheAdapter.read({ op: 'stateBrief', query: 'orange3' });
  assert(r3.ok === true && r3.brief.reality.length === 1,
    `stateBrief query filter narrows to 1 line (got ${r3.brief.reality?.length})`);
  assert(r3.brief.query === 'orange3', 'brief echoes query');
}

// ── 5. healthz with sync state present — freshness reported ─────────────────
{
  const h = await cacheAdapter.healthz();
  assert(typeof h === 'object' && h !== null, 'healthz returns object, no throw');
  assert(h.source === 'shadow-cache', 'healthz source is shadow-cache');
  assert(typeof h.status === 'string', `healthz status is string (got ${typeof h.status})`);
  assert(['fresh', 'aging', 'stale', 'unknown'].includes(h.status) || h.status === 'no_sync_state' || h.status === 'shadow_cache_dir_missing' || h.status === 'probe_failed',
    `healthz status is one of fresh|aging|stale|unknown|no_sync_state|... (got ${h.status})`);
  assert(typeof h.spec === 'string' && h.spec.includes('cache'),
    'healthz includes spec link');
  // With our seeded state file pointing 5s ago, classification should be 'fresh'.
  assert(h.last_sync_ms != null, 'healthz reports last_sync_ms when sync state present');
}

// ── 6. healthz / read with MISSING dir — honest stub, never throws ──────────
// The adapter resolves SHADOW_CACHE_DIR at module-load (constant capture from
// shadow-reader.mjs). To exercise the missing-dir path we delete the dir the
// adapter is already pointing at, then re-probe.
{
  rmSync(TMP_BASE, { recursive: true, force: true });
  assert(!existsSync(TMP_BASE), 'temp shadow dir removed for missing-dir test');

  const h = await cacheAdapter.healthz();
  assert(h.ok === false, 'healthz with missing dir returns ok:false');
  assert(h.status === 'shadow_cache_dir_missing',
    `healthz with missing dir reports shadow_cache_dir_missing (got ${h.status})`);

  const r = await cacheAdapter.read({});
  assert(r.ok === false, 'read against missing dir refuses');
  assert(r.reason === 'shadow_cache_dir_missing',
    `read against missing dir reason is shadow_cache_dir_missing (got ${r.reason})`);

  const r2 = await cacheAdapter.read({ op: 'readShadowCache' });
  assert(r2.ok === false && r2.reason === 'shadow_cache_dir_missing',
    'read({op:readShadowCache}) against missing dir reports shadow_cache_dir_missing');

  // write still refuses with the downstream-only reason — invariant holds regardless of cache state.
  const w = await cacheAdapter.write({ anything: true });
  assert(w.ok === false && w.reason === 'cache_is_downstream_only',
    'write refuses with downstream-only reason even when dir missing');
}

// ── Cleanup (already removed; double-rm is safe) ────────────────────────────
try { rmSync(TMP_BASE, { recursive: true, force: true }); } catch {}

console.log(`\n[mirage/cache] ${pass} passed / ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
