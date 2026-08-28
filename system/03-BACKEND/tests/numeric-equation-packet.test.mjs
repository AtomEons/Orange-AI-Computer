import { describe, expect, test } from 'bun:test';
import {
  __numericEquationInternals,
  fitEquationPacket,
  reconstructEquationPacket,
  verifyEquationPacket,
} from '../numeric-equation-packet.mjs';
import { runNumericEquationPacketBenchmark } from '../numeric-equation-packet-benchmark.mjs';
import { compileContextCrystal } from '../context-crystal.mjs';

describe('numeric equation and residual packets', () => {
  test('linear state with sparse anomalies reconstructs exactly', () => {
    const values = Array.from({ length: 10_000 }, (_, index) => 12 + index * 0.5);
    values[77] += 9;
    values[5_555] -= 3;
    const packet = fitEquationPacket({ name: 'rail_latency', values, units: 'ms', sourcePointer: 'receipt://latency' });
    const reconstructed = reconstructEquationPacket(packet, { expectedValues: values });
    expect(packet.equation_type).toBe('linear');
    expect(packet.metrics.residual_count).toBe(2);
    expect(packet.metrics.storage_beneficial).toBe(true);
    expect(packet.metrics.packet_bytes).toBeGreaterThan(packet.metrics.model_payload_bytes);
    expect(reconstructed.verified).toBe(true);
    expect(reconstructed.source_verified).toBe(true);
    expect(reconstructed.values).toEqual(values);
    expect(packet.source_values_sha256).toHaveLength(64);
    expect(packet.residuals_sha256).toHaveLength(64);
  });

  test('seasonal state beats raw and retains every value', () => {
    const cycle = [10, 11, 12, 13, 14, 15, 16];
    const values = Array.from({ length: 700 }, (_, index) => cycle[index % cycle.length]);
    values[333] = 99;
    const packet = fitEquationPacket({ name: 'weekly_load', values });
    expect(packet.equation_type).toBe('seasonal_7');
    expect(reconstructEquationPacket(packet).values).toEqual(values);
  });

  test('Context Crystal carries bounded numeric equations while full proof remains out of band', () => {
    const crystal = compileContextCrystal({
      task: 'explain the latency trend',
      sources: [{ id: 'law', content: 'Latency reports must preserve source truth.', pointer: 'inline://law', pinned: true }],
      budgetBytes: 1_500,
      numericSeries: [{ name: 'latency', values: Array.from({ length: 1_000 }, (_, index) => 5 + index) }],
    });
    expect(crystal.hot_context).toContain('N:latency=');
    expect(crystal.equation_packets).toHaveLength(1);
    expect(crystal.equation_packets[0].reconstruction_sha256).toHaveLength(64);
    expect(crystal.hot_context).toContain('"s":');
  });

  test('rejects packet, residual, and stale-source tampering', () => {
    const values = Array.from({ length: 1_000 }, (_, index) => 3 + index * 2);
    values[91] += 7;
    const packet = fitEquationPacket({ name: 'tamper_target', values, sourcePointer: 'receipt://source' });

    const changedEquation = structuredClone(packet);
    changedEquation.parameters.intercept += 1;
    changedEquation.reconstruction_sha256 = __numericEquationInternals.hashSeries(
      values.map((value) => value + 1),
    );
    expect(verifyEquationPacket(changedEquation).ok).toBe(false);

    const changedResidual = structuredClone(packet);
    changedResidual.residuals[0][1] += 1;
    expect(verifyEquationPacket(changedResidual).errors).toContain('residual hash mismatch');

    const staleSource = [...values];
    staleSource[0] += 1;
    expect(verifyEquationPacket(packet, { expectedValues: staleSource })).toMatchObject({
      ok: false,
      source_verified: false,
    });
  });

  test('preserves incompressible data with an honest raw fallback', () => {
    let state = 0x12345678;
    const values = Array.from({ length: 512 }, () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    });
    const packet = fitEquationPacket({ name: 'irregular', values });
    expect(packet.equation_type).toBe('raw');
    expect(packet.metrics.storage_beneficial).toBe(false);
    expect(packet.metrics.compression_ratio).toBeLessThan(1);
    expect(verifyEquationPacket(packet, { expectedValues: values }).ok).toBe(true);
  });

  test('benchmark proves model families, falsifiers, and quality-first fallback', () => {
    const receipt = runNumericEquationPacketBenchmark({ writeReceipt: false });
    expect(receipt.status).toBe('ORANGE5_NUMERIC_EQUATION_PACKET_GREEN');
    expect(receipt.cases_passed).toBe(receipt.cases_total);
    expect(receipt.falsifiers_passed).toBe(receipt.falsifiers_total);
    expect(receipt.methodology.ratio_is_observation_not_gate).toBe(true);
  });
});
