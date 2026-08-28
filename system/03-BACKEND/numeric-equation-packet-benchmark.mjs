#!/usr/bin/env bun
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fitEquationPacket,
  reconstructEquationPacket,
  verifyEquationPacket,
} from './numeric-equation-packet.mjs';
import { writeChainedJsonReceipt } from '../10-RECEIPTS/tools/json-receipt-chain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECEIPT_DIR = path.join(ROOT, '10-RECEIPTS', 'orange5-build');

function fixtures() {
  const linear = Array.from({ length: 10_000 }, (_, index) => 12 + index * 0.5);
  linear[77] += 9;
  linear[5_555] -= 3;

  const cycle = [10, 11, 12, 13, 14, 15, 16];
  const seasonal = Array.from({ length: 1_400 }, (_, index) => cycle[index % cycle.length]);
  seasonal[333] = 99;

  const stepped = [];
  let value = 5;
  for (const [delta, count] of [[1, 500], [0, 400], [-2, 300], [4, 200]]) {
    for (let index = 0; index < count; index += 1) {
      stepped.push(value);
      value += delta;
    }
  }

  let state = 0x12345678;
  const irregular = Array.from({ length: 1_024 }, () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  });

  return [
    { id: 'sparse_linear_residuals', expectedType: 'linear', values: linear, units: 'ms' },
    { id: 'seasonal_residual', expectedType: 'seasonal_7', values: seasonal, units: 'requests' },
    { id: 'delta_runs', expectedType: 'delta_rle', values: stepped, units: 'state' },
    { id: 'incompressible_raw_fallback', expectedType: 'raw', values: irregular, units: 'count' },
  ];
}

function runCase(testCase) {
  const started = performance.now();
  const packet = fitEquationPacket({
    name: testCase.id,
    values: testCase.values,
    units: testCase.units,
    sourcePointer: `fixture://${testCase.id}`,
  });
  const reconstruction = reconstructEquationPacket(packet, { expectedValues: testCase.values });
  const exactValues = reconstruction.values.length === testCase.values.length
    && reconstruction.values.every((value, index) => Object.is(value, testCase.values[index]));
  const verification = verifyEquationPacket(packet, { expectedValues: testCase.values });
  const passed = verification.ok && exactValues && packet.equation_type === testCase.expectedType;
  return {
    id: testCase.id,
    passed,
    expected_equation_type: testCase.expectedType,
    equation_type: packet.equation_type,
    count: packet.count,
    units: packet.units,
    packet_id: packet.id,
    source_pointer: packet.source_pointer,
    source_values_sha256: packet.source_values_sha256,
    reconstruction_sha256: packet.reconstruction_sha256,
    residuals_sha256: packet.residuals_sha256,
    exact_values: exactValues,
    verification,
    metrics: packet.metrics,
    elapsed_ms: Number((performance.now() - started).toFixed(2)),
    packet,
  };
}

function runFalsifiers(testCases, results) {
  const linearCase = testCases.find((item) => item.id === 'sparse_linear_residuals');
  const linearResult = results.find((item) => item.id === linearCase.id);
  const rawResult = results.find((item) => item.id === 'incompressible_raw_fallback');

  const changedEquation = structuredClone(linearResult.packet);
  changedEquation.parameters.intercept += 1;
  const equationVerification = verifyEquationPacket(changedEquation);

  const changedResidual = structuredClone(linearResult.packet);
  changedResidual.residuals[0][1] += 1;
  const residualVerification = verifyEquationPacket(changedResidual);

  const staleValues = [...linearCase.values];
  staleValues[0] += 1;
  const sourceVerification = verifyEquationPacket(linearResult.packet, { expectedValues: staleValues });

  return {
    equation_tamper_rejected: !equationVerification.ok
      && equationVerification.errors.includes('packet id mismatch'),
    residual_tamper_rejected: !residualVerification.ok
      && residualVerification.errors.includes('residual hash mismatch'),
    stale_source_rejected: !sourceVerification.ok && sourceVerification.source_verified === false,
    ratio_does_not_override_quality: rawResult.passed
      && rawResult.equation_type === 'raw'
      && rawResult.metrics.storage_beneficial === false
      && rawResult.metrics.compression_ratio < 1,
  };
}

export function runNumericEquationPacketBenchmark({ writeReceipt = true } = {}) {
  const started = performance.now();
  const testCases = fixtures();
  const verboseResults = testCases.map(runCase);
  const falsifiers = runFalsifiers(testCases, verboseResults);
  const results = verboseResults.map(({ packet, ...result }) => result);
  const casesPassed = results.filter((item) => item.passed).length;
  const falsifiersPassed = Object.values(falsifiers).every(Boolean);
  const receipt = {
    schema: 'orange5.numeric-equation-packet-benchmark.v1',
    status: casesPassed === results.length && falsifiersPassed
      ? 'ORANGE5_NUMERIC_EQUATION_PACKET_GREEN'
      : 'ORANGE5_NUMERIC_EQUATION_PACKET_NEEDS_WORK',
    generated_at: new Date().toISOString(),
    methodology: {
      exact_source_bound_reconstruction: true,
      packet_and_residual_integrity_checked: true,
      ratio_is_observation_not_gate: true,
      raw_fallback_required_for_incompressible_data: true,
    },
    cases_passed: casesPassed,
    cases_total: results.length,
    falsifiers_passed: Object.values(falsifiers).filter(Boolean).length,
    falsifiers_total: Object.keys(falsifiers).length,
    falsifiers,
    results,
    elapsed_ms: Number((performance.now() - started).toFixed(2)),
  };
  if (!writeReceipt) return receipt;
  const stamp = receipt.generated_at.replace(/[:.]/g, '-');
  const receiptPath = path.join(RECEIPT_DIR, `${stamp}-numeric-equation-packet-benchmark.json`);
  const chained = writeChainedJsonReceipt(receiptPath, receipt);
  return { ...chained, receipt_path: receiptPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runNumericEquationPacketBenchmark();
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'ORANGE5_NUMERIC_EQUATION_PACKET_GREEN') process.exitCode = 1;
}
