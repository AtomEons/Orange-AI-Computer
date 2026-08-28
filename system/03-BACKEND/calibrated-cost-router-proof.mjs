import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  COST_DIMENSIONS,
  assessAlphaPromotion,
  runHeldOutBenchmark,
} from './calibrated-cost-router.mjs';
import { writeChainedJsonReceipt } from '../10-RECEIPTS/tools/json-receipt-chain.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const RECEIPT_DIR = path.join(ROOT, '10-RECEIPTS', 'orange5-build');
const TEST_FILE = '03-BACKEND/tests/calibrated-cost-router.test.mjs';
const SOURCE_FILES = [
  '03-BACKEND/calibrated-cost-router.mjs',
  TEST_FILE,
  '03-BACKEND/calibrated-cost-router-proof.mjs',
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sourceHashes() {
  return Object.fromEntries(SOURCE_FILES.map((relativePath) => {
    const absolutePath = path.join(ROOT, relativePath);
    return [relativePath, sha256(fs.readFileSync(absolutePath))];
  }));
}

function runFocusedTests() {
  const command = [process.execPath, 'test', TEST_FILE];
  const result = spawnSync(command[0], command.slice(1), {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const passMatch = output.match(/(\d+) pass/);
  const failMatch = output.match(/(\d+) fail/);
  return {
    command,
    exit_code: result.status ?? 1,
    passed: result.status === 0,
    tests_passed: passMatch ? Number(passMatch[1]) : null,
    tests_failed: failMatch ? Number(failMatch[1]) : null,
    output_sha256: sha256(output),
    output_tail: output.trim().split(/\r?\n/).slice(-12),
  };
}

export function runCalibratedCostRouterProof() {
  const focusedTests = runFocusedTests();
  const first = runHeldOutBenchmark();
  const replay = runHeldOutBenchmark();
  const deterministicReplay = first.benchmarkFingerprint === replay.benchmarkFingerprint
    && first.modelFingerprint === replay.modelFingerprint;
  const promotion = assessAlphaPromotion({
    fixtureCount: first.fixtureCount,
    trainCount: first.trainCount,
    testCount: first.testCount,
    noFutureDataLeakage: first.noFutureDataLeakage,
    baselineAggregateMae: first.baseline.prediction.aggregateMae,
    calibratedAggregateMae: first.calibrated.prediction.aggregateMae,
    baselineSafetyErrors: first.baseline.selection.safetyCriticalRouteErrors,
    calibratedSafetyErrors: first.calibrated.selection.safetyCriticalRouteErrors,
    deterministicReplay,
    uncertaintyMonotonic: first.uncertaintyMonotonic,
    focusedTestsPassed: focusedTests.passed,
  });
  const generatedAt = new Date().toISOString();
  const receipt = {
    schema: 'orange5.calibrated-cost-router-proof.v1',
    status: promotion.status,
    generated_at: generatedAt,
    scope: 'isolated calibrated multi-objective route-selection alpha over a frozen deterministic telemetry fixture',
    checks: promotion.checks,
    promotion: {
      required_held_out_mae_improvement_rate: 0.10,
      observed_held_out_mae_improvement_rate: promotion.improvementRate,
      baseline_aggregate_mae: first.baseline.prediction.aggregateMae,
      calibrated_aggregate_mae: first.calibrated.prediction.aggregateMae,
      baseline_safety_critical_route_errors: first.baseline.selection.safetyCriticalRouteErrors,
      calibrated_safety_critical_route_errors: first.calibrated.selection.safetyCriticalRouteErrors,
      realized_objective_improvement_rate: first.objectiveImprovementRate,
    },
    fixture: {
      task_count: first.fixtureCount,
      train_count: first.trainCount,
      held_out_count: first.testCount,
      chronological_cutoff_exclusive: first.cutoffExclusive,
      fixture_sha256: first.fixtureHash,
      scalar_held_out_observations: first.calibrated.prediction.scalarObservations,
      cost_dimensions: COST_DIMENSIONS,
    },
    baseline: first.baseline,
    calibrated: first.calibrated,
    calibration_evidence: {
      model_fingerprint: first.modelFingerprint,
      benchmark_fingerprint: first.benchmarkFingerprint,
      deterministic_replay_fingerprint: replay.benchmarkFingerprint,
      no_future_data_leakage: first.noFutureDataLeakage,
      uncertainty_monotonic_under_sparse_evidence: first.uncertaintyMonotonic,
      uncertainty_probe: first.uncertaintyProbe,
      residuals_by_route_and_dimension: first.model.diagnostics,
      source_task_ids: first.model.sourceTaskIds,
      trained_through: first.model.trainedThrough,
    },
    focused_tests: focusedTests,
    source_files: sourceHashes(),
    claim_boundary: {
      isolated_alpha_proven: promotion.green,
      live_orange_routing_changed: false,
      production_router_promoted: false,
      real_operator_traffic_benchmarked: false,
      synthetic_fixture_disclosed: true,
      statement: 'This receipt proves only the deterministic isolated alpha and its held-out synthetic telemetry result; production routing requires shadow traffic and a separate promotion receipt.',
    },
  };
  const receiptPath = path.join(
    RECEIPT_DIR,
    `${generatedAt.replace(/[:.]/g, '-')}-calibrated-cost-router-alpha.json`,
  );
  const written = writeChainedJsonReceipt(receiptPath, receipt);
  return { ...written, receipt_path: receiptPath };
}

if (import.meta.main) {
  const result = runCalibratedCostRouterProof();
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'CALIBRATED_COST_ROUTER_ALPHA_GREEN') process.exitCode = 1;
}

