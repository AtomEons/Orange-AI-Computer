// Memory audit probe for AtomSmasher 2 full-scope.
// READ-ONLY against production sources — does not modify any engine.
// Run from the checkout: bun 12-ATOMSMASHER/research/memory-probe.mjs

import { Store } from '../full-scope/storage.mjs';
import { demo } from '../full-scope/engines.mjs';

function gc() {
  // Bun exposes Bun.gc(true) for synchronous, full GC.
  if (typeof Bun !== 'undefined' && typeof Bun.gc === 'function') {
    try { Bun.gc(true); } catch { /* noop */ }
  } else if (typeof global !== 'undefined' && typeof global.gc === 'function') {
    try { global.gc(); } catch { /* noop */ }
  }
}

function mb(n) { return +(n / (1024 * 1024)).toFixed(2); }
function bytes(n) { return n; }

function snap(label, extra = {}) {
  // Take TWO readings: live (pre-GC) and post-GC. Bun's process.memoryUsage()
  // returns a JSC heap snapshot that lags after recent allocations until the
  // collector ticks; we report both so we don't undercount retention.
  const preGc = process.memoryUsage();
  gc();
  const postGc = process.memoryUsage();
  return {
    label,
    // post-GC = retained working set
    heapUsed_MB: mb(postGc.heapUsed),
    heapTotal_MB: mb(postGc.heapTotal),
    external_MB: mb(postGc.external),
    rss_MB: mb(postGc.rss),
    arrayBuffers_MB: mb(postGc.arrayBuffers || 0),
    heapUsed_bytes: postGc.heapUsed,
    // pre-GC = peak transient pressure for that step
    pre_gc_heapUsed_MB: mb(preGc.heapUsed),
    pre_gc_heapTotal_MB: mb(preGc.heapTotal),
    pre_gc_external_MB: mb(preGc.external),
    pre_gc_rss_MB: mb(preGc.rss),
    ...extra,
  };
}

const checkpoints = [];

// ─── Checkpoint 0: baseline (process start) ─────────────────────────────────
checkpoints.push(snap('00_baseline_before_store'));

// ─── Checkpoint 1: empty Store created ─────────────────────────────────────
// NOTE: Store ctor runs init() which registers 620 features inside one txn.
const store = new Store(':memory:');
gc();
const featureCount = store.one('SELECT COUNT(*) c FROM features').c;
const baseReceipts = store.one('SELECT COUNT(*) c FROM receipts').c;
checkpoints.push(snap('01_store_created_620_features', { features: featureCount, receipts: baseReceipts }));

// ─── Checkpoint 2: 100 receipts inserted ───────────────────────────────────
for (let i = 0; i < 100; i++) {
  store.insertReceipt('probe.fill', 'ok', `probe receipt #${i} with some payload`, { i, payload: 'x'.repeat(64) });
}
checkpoints.push(snap('02_after_100_receipts', { receipts: store.one('SELECT COUNT(*) c FROM receipts').c }));

// ─── Checkpoint 3: 1000 receipts inserted (cumulative) ──────────────────────
for (let i = 100; i < 1000; i++) {
  store.insertReceipt('probe.fill', 'ok', `probe receipt #${i} with some payload`, { i, payload: 'x'.repeat(64) });
}
checkpoints.push(snap('03_after_1000_receipts', { receipts: store.one('SELECT COUNT(*) c FROM receipts').c }));

// ─── Checkpoint 4: full demo() complete ────────────────────────────────────
// demo() calls FeatureExecutor.runAll() inside a txn, plus ingest + equation +
// cache. Receipts after demo() should be ~1,491 per task spec.
const tDemoStart = Number(process.hrtime.bigint() / 1000000n);
const demoResult = demo(store);
const tDemoEnd = Number(process.hrtime.bigint() / 1000000n);
checkpoints.push(snap('04_after_demo_complete', {
  receipts: store.one('SELECT COUNT(*) c FROM receipts').c,
  features_attempted: demoResult.all_features.attempted,
  features_ok: demoResult.all_features.ok,
  demo_ms: tDemoEnd - tDemoStart,
}));

// ─── Checkpoint 5: exportCompressedAuditLog done ───────────────────────────
const tExpStart = Number(process.hrtime.bigint() / 1000000n);
const exp = store.exportCompressedAuditLog();
const tExpEnd = Number(process.hrtime.bigint() / 1000000n);
checkpoints.push(snap('05_after_exportCompressedAuditLog', {
  encoded_bytes: exp.encoded.length,
  original_bytes: exp.originalBytes,
  ratio: exp.ratio,
  receipts: exp.n_receipts,
  export_ms: tExpEnd - tExpStart,
}));

// ─── Checkpoint 6: after dropping exp + forcing GC ─────────────────────────
// Test: can the export buffer be reclaimed? (it's still on `exp` so no — we
// null it and force GC to see what falls away.)
const expBytes = exp.encoded.length;
const expRatio = exp.ratio;
const expRcpts = exp.n_receipts;
// drop ref to encoded buffer
exp.encoded = null;
checkpoints.push(snap('06_after_drop_export_buffer_gc', { encoded_bytes_was: expBytes, ratio_was: expRatio, receipts_was: expRcpts }));

// ─── Checkpoint 7: store.close() then full GC ──────────────────────────────
const finalReceipts = store.one('SELECT COUNT(*) c FROM receipts').c;
store.close();
checkpoints.push(snap('07_after_store_close_gc', { final_receipts: finalReceipts }));

// ─── per-receipt cost calc ─────────────────────────────────────────────────
// Bun's `heapUsed` lags behind allocations until the collector ticks (it
// reports JSC's reported live size, which is conservative). The honest
// signal for "how much RAM is this organism actually holding" is RSS + the
// external arena (native bun:sqlite rows live here, NOT on the JS heap).
// We compute per-receipt cost over BOTH the clean 100→1000 window and the
// full demo window for context.
function delta(field, fromIdx, toIdx) {
  const from = checkpoints[fromIdx];
  const to = checkpoints[toIdx];
  return +(to[field] - from[field]).toFixed(2);
}

// Clean window: 100 → 1000 receipts, purely receipt-driven (no demo features).
const cleanRcptDelta = checkpoints[3].receipts - checkpoints[2].receipts; // 900
const clean_rss_delta_MB = delta('rss_MB', 2, 3);
const clean_external_delta_MB = delta('external_MB', 2, 3);
const clean_heapTotal_delta_MB = delta('heapTotal_MB', 2, 3);
const cleanBytesPerReceipt = cleanRcptDelta > 0
  ? Math.round((clean_rss_delta_MB * 1024 * 1024) / cleanRcptDelta)
  : 0;

// Demo window: empty store (post-feature-register) → after demo() complete.
const demoRcptDelta = checkpoints[4].receipts - checkpoints[1].receipts;
const demo_rss_delta_MB = delta('rss_MB', 1, 4);
const demo_external_delta_MB = delta('external_MB', 1, 4);
const demoBytesPerReceipt = demoRcptDelta > 0
  ? Math.round((demo_rss_delta_MB * 1024 * 1024) / demoRcptDelta)
  : 0;

// Export spike: cost of exportCompressedAuditLog() itself.
const export_rss_spike_MB = delta('rss_MB', 4, 5);
const export_heapTotal_spike_MB = delta('heapTotal_MB', 4, 5);
const export_pre_gc_spike_MB = +(checkpoints[5].pre_gc_rss_MB - checkpoints[4].rss_MB).toFixed(2);

// Peak finder: RSS is the real ceiling.
let peakRss = checkpoints[0];
for (const c of checkpoints) if (c.rss_MB > peakRss.rss_MB) peakRss = c;
let peakPreGcRss = checkpoints[0];
for (const c of checkpoints) if (c.pre_gc_rss_MB > peakPreGcRss.pre_gc_rss_MB) peakPreGcRss = c;
let peakHeap = checkpoints[0];
for (const c of checkpoints) if (c.heapTotal_MB > peakHeap.heapTotal_MB) peakHeap = c;

console.log(JSON.stringify({
  bun_version: typeof Bun !== 'undefined' ? Bun.version : 'unknown',
  note: 'Bun process.memoryUsage().heapUsed lags allocations; RSS + external + heapTotal are the honest signals.',
  checkpoints,
  per_receipt_clean_window: {
    receipts_added: cleanRcptDelta,
    rss_delta_MB: clean_rss_delta_MB,
    external_delta_MB: clean_external_delta_MB,
    heapTotal_delta_MB: clean_heapTotal_delta_MB,
    bytes_per_receipt: cleanBytesPerReceipt,
    KB_per_receipt: +(cleanBytesPerReceipt / 1024).toFixed(2),
  },
  per_receipt_demo_window: {
    receipts_added: demoRcptDelta,
    rss_delta_MB: demo_rss_delta_MB,
    external_delta_MB: demo_external_delta_MB,
    bytes_per_receipt: demoBytesPerReceipt,
    KB_per_receipt: +(demoBytesPerReceipt / 1024).toFixed(2),
  },
  export_buffer_cost: {
    export_rss_post_gc_delta_MB: export_rss_spike_MB,
    export_heapTotal_post_gc_delta_MB: export_heapTotal_spike_MB,
    export_rss_pre_gc_spike_MB: export_pre_gc_spike_MB,
  },
  peaks: {
    peak_rss_post_gc: { label: peakRss.label, rss_MB: peakRss.rss_MB, heapTotal_MB: peakRss.heapTotal_MB, external_MB: peakRss.external_MB },
    peak_rss_pre_gc: { label: peakPreGcRss.label, rss_MB: peakPreGcRss.pre_gc_rss_MB },
    peak_heapTotal: { label: peakHeap.label, heapTotal_MB: peakHeap.heapTotal_MB },
  },
}, null, 2));
