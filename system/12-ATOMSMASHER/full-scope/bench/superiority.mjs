#!/usr/bin/env bun
// AtomSmasher Full-Scope — Superiority Benchmark (Bun vs Python on identical workload)
//
// Runs identical workloads through:
//   1. The Bun port at 12-ATOMSMASHER/full-scope/
//   2. The canonical Python source at orangebox-delta/integrations/atomsmasher_full_scope_v1_0/
//
// Measures: wall-clock, 620-feature throughput, AIR codec compression ratio,
// equation-fit compression, sparse-workset compression, saved-work token totals,
// receipt count, DB size.
//
// Run: bun 12-ATOMSMASHER/full-scope/bench/superiority.mjs

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../storage.mjs';
import {
  SourceEngine, OrderSpine, CommitmentCodec, EquationMemory,
  CacheEngine, FeatureExecutor, TotalWorkCompiler, demo,
} from '../engines.mjs';

const PY_DIR = 'C:/AtomEons/orangebox-delta/integrations/atomsmasher_full_scope_v1_0';

function ms() { return Number(process.hrtime.bigint() / 1000000n); }

function tmpDb(prefix) {
  return path.join(os.tmpdir(), `${prefix}-${process.hrtime.bigint()}.db`);
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

function equationPacketBytes(row) {
  return Buffer.byteLength(JSON.stringify({
    name: row.name,
    equation_type: row.equation_type,
    formula: row.formula,
    parameters: JSON.parse(row.parameters_json),
    residuals: JSON.parse(row.residuals_json),
    source_pointer: row.source_pointer,
    reconstruction_hash: row.reconstruction_hash,
  }), 'utf8');
}

// ---------------------------------------------------------------------------
// Workload definition — a realistic Orange5 doctrine corpus.
// ---------------------------------------------------------------------------
const WORKLOAD_DOC = `# Orange5 Doctrine Demo

orders: Keep marching orders HOT_ALWAYS until explicitly superseded.
orders: Full ingest first; selective activation after.
orders: AtomSmasher compresses every passage of data through the system.
must always preserve operator authority over uploaded content.
never let idea volume overpower mission gravity.

# Section: AE Cobra
Æ Cobra is the always-on Mamba-2 (SSD) memory engine inside the AE Memory pillar.
It runs on Docker, holds Reality.flux + Thought.flux records, and drives AtomSmasher 2
as the active sieve. Numbers across the run history: 10 20 30 40 50 60 70 80 90 100.

# Section: Five Pillars
1. Atomic Orange — UI / Navigation / Project Management.
2. OrangeBrain — the big-LLM hub with Flowstate trained in.
3. AE Memory — AE Cobra + Mem tools, dual-memory wisdom layer.
4. AE Eyes — visual pillar, comic-book quality bar.
5. AtomSmasher 2 — compression engine driving every tool call.

# Section: Receipts
Every action emits a hash-chained receipt. Saved-work certificates accumulate.
Compression-debt ledger tracks every passage where compression slowed delivery.
`;

const EQUATION_SERIES = [
  // Linear (perfect): y = 2 + 3t for t in [0..49]
  Array.from({ length: 50 }, (_, i) => 2 + 3 * i),
  // Run-length (perfect): three runs
  Array.from({ length: 30 }, (_, i) => i < 10 ? 7 : i < 22 ? 13 : 19),
  // Seasonal-7: weekly cycle over 28 points
  Array.from({ length: 28 }, (_, i) => [1, 3, 5, 7, 5, 3, 1][i % 7]),
  // Mixed deltas
  Array.from({ length: 40 }, (_, i) => Math.sin(i / 4) * 10 + i),
];

const COMPILE_QUERIES = [
  'continue AtomSmasher without losing orders',
  'compress the doctrine corpus into a sparse workset',
  'what is the heat governance pattern for HOT_ALWAYS items',
  'route this query through least-action without expansion',
  'fit the numeric series and reconstruct',
];

// ---------------------------------------------------------------------------
// Bun pass
// ---------------------------------------------------------------------------
function runBunPass() {
  const dbPath = tmpDb('bench-bun');
  const t0 = ms();

  const store = new Store(dbPath);
  const tInit = ms() - t0;

  // 1. Ingest corpus
  const tIngest0 = ms();
  const ingestResult = new SourceEngine(store).ingestText('Orange5 Doctrine Demo', WORKLOAD_DOC);
  const tIngest = ms() - tIngest0;

  const corpusBytes = Buffer.byteLength(WORKLOAD_DOC, 'utf8');
  const chunkCount = ingestResult.chunks;
  const orderCount = ingestResult.orders.length;

  // 2. Fit equations
  const tEq0 = ms();
  const equationMemory = new EquationMemory(store);
  const eqResults = EQUATION_SERIES.map((vals, i) => equationMemory.fitSeries(vals, `bench_series_${i}`));
  const tEq = ms() - tEq0;

  // Keep model payload and persisted packet measurements separate. The packet
  // includes the metadata required to verify hydration and can be larger even
  // when the selected equation model itself compresses.
  let eqRawBytes = 0;
  let eqModelPayloadBytes = 0;
  let eqPersistedPacketBytes = 0;
  let eqExactReconstructions = 0;
  let eqIdentityFallbacks = 0;
  let eqResiduals = 0;
  let eqModelBeneficial = 0;
  let eqPacketBeneficial = 0;
  for (let i = 0; i < EQUATION_SERIES.length; i++) {
    const rawBytes = Buffer.byteLength(JSON.stringify(EQUATION_SERIES[i]), 'utf8');
    const modelPayloadBytes = Buffer.byteLength(eqResults[i].parameters_json + eqResults[i].residuals_json, 'utf8');
    const packetBytes = equationPacketBytes(eqResults[i]);
    eqRawBytes += rawBytes;
    eqModelPayloadBytes += modelPayloadBytes;
    eqPersistedPacketBytes += packetBytes;
    if (modelPayloadBytes < rawBytes) eqModelBeneficial += 1;
    if (packetBytes < rawBytes) eqPacketBeneficial += 1;
    if (eqResults[i].equation_type === 'raw') eqIdentityFallbacks += 1;
    eqResiduals += Object.keys(JSON.parse(eqResults[i].residuals_json)).length;
    const reconstructed = equationMemory.reconstruct(eqResults[i].id);
    const exact = reconstructed.length === EQUATION_SERIES[i].length
      && reconstructed.every((value, j) => Object.is(value, Object.is(EQUATION_SERIES[i][j], -0) ? 0 : EQUATION_SERIES[i][j]));
    if (exact && equationMemory.verifyReconstruction(eqResults[i].id).verified) eqExactReconstructions += 1;
  }

  // 3. Cache + total-work compile across multiple queries
  const tCompile0 = ms();
  const compileResults = COMPILE_QUERIES.map(q => new TotalWorkCompiler(store).compile(q));
  const tCompile = ms() - tCompile0;

  // 4. Run all 620 features
  const tAll0 = ms();
  const runAllReport = new FeatureExecutor(store).runAll(null, { canonicalParity: true });
  const tAll = ms() - tAll0;

  // 5. Final tallies
  const tTotal = ms() - t0;
  const receipts = store.one('SELECT COUNT(*) c FROM receipts').c;
  const savedWork = store.all('SELECT tokens_not_injected FROM saved_work');
  const savedTokensTotal = savedWork.reduce((s, r) => s + r.tokens_not_injected, 0);
  const features = store.one('SELECT COUNT(*) c FROM features').c;
  const atoms = store.one('SELECT COUNT(*) c FROM atoms').c;
  const equations = store.one('SELECT COUNT(*) c FROM equations').c;
  const dbSize = fileSize(dbPath);

  store.close();
  try { fs.unlinkSync(dbPath); } catch { /* noop */ }
  // Also clean the WAL/SHM siblings.
  for (const sfx of ['-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + sfx); } catch { /* noop */ }
  }

  return {
    runtime: 'bun',
    bun_version: process.versions.bun,
    timings_ms: {
      init: tInit,
      ingest: tIngest,
      equations: tEq,
      compile_queries: tCompile,
      run_all_620: tAll,
      total: tTotal,
    },
    counts: {
      features_registered: features,
      atoms: atoms,
      equations: equations,
      receipts: receipts,
      chunks: chunkCount,
      orders: orderCount,
      run_all_attempted: runAllReport.attempted,
      run_all_ok: runAllReport.ok,
      run_all_errors: runAllReport.errors,
    },
    compression: {
      corpus_input_bytes: corpusBytes,
      saved_tokens_total: savedTokensTotal,
      saved_tokens_per_query_avg: Math.round(savedTokensTotal / COMPILE_QUERIES.length),
      equation_raw_bytes: eqRawBytes,
      equation_model_payload_bytes: eqModelPayloadBytes,
      equation_model_payload_ratio: Number((eqRawBytes / Math.max(1, eqModelPayloadBytes)).toFixed(3)),
      equation_persisted_packet_bytes: eqPersistedPacketBytes,
      equation_persisted_packet_ratio: Number((eqRawBytes / Math.max(1, eqPersistedPacketBytes)).toFixed(3)),
      equation_exact_reconstructions: eqExactReconstructions,
      equation_series_measured: EQUATION_SERIES.length,
      equation_identity_fallbacks: eqIdentityFallbacks,
      equation_residual_values: eqResiduals,
      equation_model_beneficial_series: eqModelBeneficial,
      equation_packet_beneficial_series: eqPacketBeneficial,
      equation_numeric_contract: 'finite-float64; signed zero normalized',
      db_size_bytes: dbSize,
    },
    features_per_sec: Math.round(runAllReport.attempted / (tAll / 1000)),
  };
}

// ---------------------------------------------------------------------------
// Python pass (canonical source) — only if Python is on PATH.
// ---------------------------------------------------------------------------
function runPyPass() {
  const py = spawnSync('python', ['-c', 'import sys; print(sys.version)'], { encoding: 'utf8' });
  if (py.status !== 0) {
    return { skipped: true, reason: 'python not on PATH', note: py.stderr };
  }
  const pyVersion = py.stdout.trim().split('\n')[0];

  const dbPath = tmpDb('bench-py');
  const driverScript = `
import json, struct, sys, time
sys.path.insert(0, r'${PY_DIR}')
from atomsmasher.storage import Store
from atomsmasher.engines import SourceEngine, OrderSpine, EquationMemory, TotalWorkCompiler, FeatureExecutor

WORKLOAD_DOC = ${JSON.stringify(WORKLOAD_DOC)}
EQUATION_SERIES = ${JSON.stringify(EQUATION_SERIES)}
COMPILE_QUERIES = ${JSON.stringify(COMPILE_QUERIES)}

def ms(start): return int((time.perf_counter() - start) * 1000)

t0 = time.perf_counter()
store = Store(r'${dbPath.replaceAll('\\', '\\\\')}')
t_init = ms(t0)

t = time.perf_counter()
ingest = SourceEngine(store).ingest_text('Orange5 Doctrine Demo', WORKLOAD_DOC)
t_ingest = ms(t)

t = time.perf_counter()
equation_memory = EquationMemory(store)
eq_results = [equation_memory.fit_series([float(x) for x in v], name=f'bench_series_{i}') for i,v in enumerate(EQUATION_SERIES)]
t_eq = ms(t)

t = time.perf_counter()
compiles = [TotalWorkCompiler(store).compile(q) for q in COMPILE_QUERIES]
t_compile = ms(t)

t = time.perf_counter()
report = FeatureExecutor(store).run_all()
t_all = ms(t)

t_total = ms(t0)

receipts = store.one('SELECT COUNT(*) c FROM receipts')['c']
saved = store.all('SELECT tokens_not_injected FROM saved_work')
saved_total = sum(r['tokens_not_injected'] for r in saved)
features = store.one('SELECT COUNT(*) c FROM features')['c']
atoms = store.one('SELECT COUNT(*) c FROM atoms')['c']
equations = store.one('SELECT COUNT(*) c FROM equations')['c']

def compact_bytes(value):
  return len(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))

eq_raw = sum(compact_bytes(v) for v in EQUATION_SERIES)
eq_model_payload = sum(len((r['parameters_json'] + r['residuals_json']).encode('utf-8')) for r in eq_results)
eq_packets = sum(compact_bytes({
  'name': r['name'], 'equation_type': r['equation_type'], 'formula': r['formula'],
  'parameters': json.loads(r['parameters_json']), 'residuals': json.loads(r['residuals_json']),
  'source_pointer': r['source_pointer'], 'reconstruction_hash': r['reconstruction_hash'],
}) for r in eq_results)
eq_exact = 0
for values, row in zip(EQUATION_SERIES, eq_results):
  reconstructed = equation_memory.reconstruct(row['id'], len(values))
  if len(reconstructed) == len(values) and all(struct.pack('>d', a) == struct.pack('>d', b) for a,b in zip(reconstructed, values)):
    eq_exact += 1
eq_residuals = sum(len(json.loads(r['residuals_json'])) for r in eq_results)
eq_model_beneficial = sum(1 for values,row in zip(EQUATION_SERIES,eq_results) if len((row['parameters_json'] + row['residuals_json']).encode('utf-8')) < compact_bytes(values))
eq_packet_beneficial = sum(1 for values,row in zip(EQUATION_SERIES,eq_results) if compact_bytes({
  'name': row['name'], 'equation_type': row['equation_type'], 'formula': row['formula'],
  'parameters': json.loads(row['parameters_json']), 'residuals': json.loads(row['residuals_json']),
  'source_pointer': row['source_pointer'], 'reconstruction_hash': row['reconstruction_hash'],
}) < compact_bytes(values))
eq_model_max_err = max(r['max_error'] for r in eq_results)

out = {
  'runtime': 'python',
  'python_version': '${pyVersion}'.split()[0],
  'timings_ms': {'init': t_init, 'ingest': t_ingest, 'equations': t_eq, 'compile_queries': t_compile, 'run_all_620': t_all, 'total': t_total},
  'counts': {'features_registered': features, 'atoms': atoms, 'equations': equations, 'receipts': receipts,
             'chunks': ingest['chunks'], 'orders': len(ingest['orders']),
             'run_all_attempted': report['attempted'], 'run_all_ok': report['ok'], 'run_all_errors': report['errors']},
  'compression': {'corpus_input_bytes': len(WORKLOAD_DOC.encode('utf-8')),
                  'saved_tokens_total': saved_total,
                  'saved_tokens_per_query_avg': saved_total // max(1, len(COMPILE_QUERIES)),
                  'equation_raw_bytes': eq_raw,
                  'equation_model_payload_bytes': eq_model_payload,
                  'equation_model_payload_ratio': round(eq_raw/max(1,eq_model_payload), 3),
                  'equation_persisted_packet_bytes': eq_packets,
                  'equation_persisted_packet_ratio': round(eq_raw/max(1,eq_packets), 3),
                  'equation_exact_reconstructions': eq_exact,
                  'equation_series_measured': len(EQUATION_SERIES),
                  'equation_residual_values': eq_residuals,
                  'equation_model_beneficial_series': eq_model_beneficial,
                  'equation_packet_beneficial_series': eq_packet_beneficial,
                  'equation_model_fit_max_error': eq_model_max_err,
                  'equation_metric_semantics': 'legacy Python max_error is pre-residual model error'},
  'features_per_sec': int(report['attempted'] / max(0.001, t_all/1000)),
}
print(json.dumps(out, sort_keys=True))
store.close()
`;

  const res = spawnSync('python', ['-c', driverScript], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  for (const sfx of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + sfx); } catch { /* noop */ }
  }
  if (res.status !== 0) {
    return { skipped: true, reason: 'python driver failed', stderr: res.stderr.slice(-500), stdout: res.stdout.slice(-500) };
  }
  try { return JSON.parse(res.stdout.trim().split('\n').pop()); }
  catch (e) { return { skipped: true, reason: 'json parse', stdout: res.stdout.slice(-500), error: e.message }; }
}

// ---------------------------------------------------------------------------
// Comparison + report
// ---------------------------------------------------------------------------
function compare(bun, py) {
  if (py.skipped) {
    return {
      verdict: 'bun-only',
      python_status: `skipped — ${py.reason}`,
      python_detail: py,
    };
  }
  const ratio = (a, b) => b === 0 ? null : (a / b);
  const cmp = {};
  for (const k of ['init', 'ingest', 'equations', 'compile_queries', 'run_all_620', 'total']) {
    const bunMs = bun.timings_ms[k];
    const pyMs = py.timings_ms[k];
    cmp[k] = {
      bun_ms: bunMs,
      python_ms: pyMs,
      speedup_x: ratio(pyMs, bunMs) ? +(pyMs / bunMs).toFixed(2) : null,
      bun_faster: bunMs < pyMs,
    };
  }
  const parityCheck = {
    features_match: bun.counts.features_registered === py.counts.features_registered,
    atoms_match: bun.counts.atoms === py.counts.atoms,
    atoms_diff: Math.abs(bun.counts.atoms - py.counts.atoms),
    equations_match: bun.counts.equations === py.counts.equations,
    receipts_match: bun.counts.receipts === py.counts.receipts,
    run_all_ok_match: bun.counts.run_all_ok === py.counts.run_all_ok,
    run_all_errors_match: bun.counts.run_all_errors === py.counts.run_all_errors,
  };
  parityCheck.aggregate_counts_match = parityCheck.features_match
    && parityCheck.atoms_match
    && parityCheck.equations_match
    && parityCheck.receipts_match
    && parityCheck.run_all_ok_match
    && parityCheck.run_all_errors_match;
  const performanceVerdict = cmp.run_all_620.bun_faster && cmp.total.bun_faster ? 'BUN SUPERIOR' : 'mixed';
  return {
    verdict: parityCheck.aggregate_counts_match ? performanceVerdict : 'PARITY MISMATCH',
    bun_features_per_sec: bun.features_per_sec,
    python_features_per_sec: py.features_per_sec,
    throughput_speedup_x: ratio(bun.features_per_sec, py.features_per_sec) ? +(bun.features_per_sec / py.features_per_sec).toFixed(2) : null,
    per_phase: cmp,
    parity_check: parityCheck,
  };
}

// ---------------------------------------------------------------------------
console.log('AtomSmasher Full-Scope Superiority Benchmark');
console.log('=============================================');
console.log('');
console.log('Running Bun pass...');
const bunResult = runBunPass();
console.log('Running Python pass (canonical source)...');
const pyResult = runPyPass();
console.log('');

const report = {
  workload: {
    doc_bytes: Buffer.byteLength(WORKLOAD_DOC, 'utf8'),
    equation_series_count: EQUATION_SERIES.length,
    equation_total_points: EQUATION_SERIES.reduce((s, v) => s + v.length, 0),
    compile_queries: COMPILE_QUERIES.length,
  },
  bun: bunResult,
  python: pyResult,
  comparison: compare(bunResult, pyResult),
  generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
};

const aggregateParityPassed = report.comparison?.parity_check?.aggregate_counts_match === true;
const exactEquationsPassed = bunResult.compression.equation_exact_reconstructions
  === bunResult.compression.equation_series_measured;
report.status = bunResult.counts.run_all_ok === 620
  && bunResult.counts.run_all_errors === 0
  && exactEquationsPassed
  && aggregateParityPassed
  ? 'ATOMSMASHER_BOUNDED_AUDIT_GREEN'
  : 'ATOMSMASHER_BOUNDED_AUDIT_NEEDS_WORK';
report.performance_observation = report.comparison?.verdict || 'not measured';
report.parity_contract = {
  mode: 'canonical-python-v1',
  measured_level: 'aggregate counts only',
  aggregate_passed: aggregateParityPassed,
  exact_database_parity_established: false,
  note: 'The benchmark replays canonical Python feature defaults. Exact row and payload parity is outside this performance receipt and must not be inferred from matching counts.',
};
report.limits = [
  'Compression ratios are workload-specific, not universal guarantees.',
  'Model-payload ratio excludes packet metadata; persisted-packet ratio includes verification metadata.',
  'Numeric inputs are finite float64 values and signed zero is normalized to zero.',
  'Python parity in this receipt is aggregate count parity, not exact database parity.',
];
const receiptName = `superiority-${report.generated_at.replace(/[:.]/g, '-')}.json`;
const receiptPath = path.resolve(import.meta.dirname, '..', 'receipts', receiptName);
report.receipt_file = receiptName;
report.receipt_hash_contract = 'sha256 of compact JSON before receipt_sha256 is added';
report.receipt_sha256 = crypto.createHash('sha256').update(JSON.stringify(report)).digest('hex');
fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
fs.writeFileSync(receiptPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
report.receipt_path = receiptPath;

console.log(JSON.stringify(report, null, 2));

// Concise human summary
console.log('\n=== Summary ===');
console.log(`Workload: ${report.workload.doc_bytes}B corpus, ${report.workload.equation_series_count} series (${report.workload.equation_total_points} points), ${report.workload.compile_queries} compile queries`);
console.log(`Bun ${bunResult.bun_version}: total ${bunResult.timings_ms.total}ms · ${bunResult.features_per_sec} features/sec · ${bunResult.counts.run_all_ok}/620 ok · receipts ${bunResult.counts.receipts}`);
if (!pyResult.skipped) {
  console.log(`Aggregate parity: ${report.comparison.parity_check.aggregate_counts_match ? 'PASS' : 'FAIL'} | atoms diff ${report.comparison.parity_check.atoms_diff} | equations match ${report.comparison.parity_check.equations_match} | receipts match ${report.comparison.parity_check.receipts_match}`);
  console.log(`Python ${pyResult.python_version}: total ${pyResult.timings_ms.total}ms · ${pyResult.features_per_sec} features/sec · ${pyResult.counts.run_all_ok}/620 ok · receipts ${pyResult.counts.receipts}`);
  console.log(`Verdict: ${report.comparison.verdict} · throughput speedup ${report.comparison.throughput_speedup_x}x · run-all-620 speedup ${report.comparison.per_phase.run_all_620.speedup_x}x`);
} else {
  console.log(`Python: skipped (${pyResult.reason})`);
}
console.log(`Equation model payload: ${bunResult.compression.equation_raw_bytes}B raw -> ${bunResult.compression.equation_model_payload_bytes}B (${bunResult.compression.equation_model_payload_ratio}x)`);
console.log(`Equation persisted packet: ${bunResult.compression.equation_raw_bytes}B raw -> ${bunResult.compression.equation_persisted_packet_bytes}B (${bunResult.compression.equation_persisted_packet_ratio}x) | exact ${bunResult.compression.equation_exact_reconstructions}/${bunResult.compression.equation_series_measured}`);
console.log(`Saved-work tokens (Bun): ${bunResult.compression.saved_tokens_total} across ${report.workload.compile_queries} queries (avg ${bunResult.compression.saved_tokens_per_query_avg}/query)`);
console.log(`DB size on disk (Bun): ${bunResult.compression.db_size_bytes}B`);
console.log(`Status: ${report.status} · receipt ${receiptPath}`);
if (report.status !== 'ATOMSMASHER_BOUNDED_AUDIT_GREEN') process.exitCode = 1;
