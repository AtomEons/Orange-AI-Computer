#!/usr/bin/env bun
import { describe, expect, test } from 'bun:test';
import { evaluateReportPromotion } from './report-promotion-policy.mjs';

const result = (validity_rate, repair_rate, mean_latency_ms) => ({ validity_rate, repair_rate, mean_latency_ms });

describe('Navigator report promotion policy', () => {
  test('a single model is a measurement, not a promotion', () => {
    expect(evaluateReportPromotion([result(1, 0, 3000)])).toEqual({
      comparison_available: false, promoted: false, verdict: 'BASELINE_MEASURED',
    });
  });

  test('equal validity with no extra repairs and faster latency promotes', () => {
    expect(evaluateReportPromotion([result(1, 0, 4000), result(1, 0, 3600)]).promoted).toBe(true);
  });

  test('a faster challenger with more repairs does not promote', () => {
    const verdict = evaluateReportPromotion([result(1, 0, 4000), result(1, 0.2, 3000)]);
    expect(verdict.promoted).toBe(false);
    expect(verdict.checks.repairsNoWorse).toBe(false);
  });

  test('quality cannot regress for a latency win', () => {
    const verdict = evaluateReportPromotion([result(1, 0, 4000), result(0.8, 0, 2000)]);
    expect(verdict.promoted).toBe(false);
    expect(verdict.checks.validityNoWorse).toBe(false);
  });
});
