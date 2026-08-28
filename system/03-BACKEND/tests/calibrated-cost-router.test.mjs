import { describe, expect, test } from 'bun:test';
import {
  COST_DIMENSIONS,
  ROUTES,
  assessAlphaPromotion,
  chronologicalSplit,
  createFrozenTelemetryFixture,
  hashCanonical,
  isSafetyCriticalRouteError,
  predictCostVector,
  runHeldOutBenchmark,
  selectCalibratedRoute,
  selectStaticLeastActionRoute,
  staticCostPrediction,
  trainCalibratedRouter,
} from '../calibrated-cost-router.mjs';

function promotionInput(benchmark, overrides = {}) {
  return {
    fixtureCount: benchmark.fixtureCount,
    trainCount: benchmark.trainCount,
    testCount: benchmark.testCount,
    noFutureDataLeakage: benchmark.noFutureDataLeakage,
    baselineAggregateMae: benchmark.baseline.prediction.aggregateMae,
    calibratedAggregateMae: benchmark.calibrated.prediction.aggregateMae,
    baselineSafetyErrors: benchmark.baseline.selection.safetyCriticalRouteErrors,
    calibratedSafetyErrors: benchmark.calibrated.selection.safetyCriticalRouteErrors,
    deterministicReplay: true,
    uncertaintyMonotonic: benchmark.uncertaintyMonotonic,
    focusedTestsPassed: true,
    ...overrides,
  };
}

describe('calibrated multi-objective cost router alpha', () => {
  test('builds exactly 120 deeply frozen chronological telemetry tasks deterministically', () => {
    const first = createFrozenTelemetryFixture();
    const second = createFrozenTelemetryFixture();

    expect(first).toHaveLength(120);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0])).toBe(true);
    expect(Object.isFrozen(first[0].features)).toBe(true);
    expect(Object.isFrozen(first[0].observations)).toBe(true);
    expect(hashCanonical(first)).toBe(hashCanonical(second));
    expect(first.map((task) => task.taskId)).toEqual(second.map((task) => task.taskId));
    for (let index = 1; index < first.length; index += 1) {
      expect(Date.parse(first[index].observedAt)).toBeGreaterThan(Date.parse(first[index - 1].observedAt));
    }
  });

  test('uses a chronological 84/36 split and records every training source identity', () => {
    const tasks = createFrozenTelemetryFixture();
    const split = chronologicalSplit(tasks, { trainCount: 84 });
    const model = trainCalibratedRouter(split.train, { cutoffExclusive: split.cutoffExclusive });

    expect(split.train).toHaveLength(84);
    expect(split.heldOut).toHaveLength(36);
    expect(split.cutoffExclusive).toBe(split.heldOut[0].observedAt);
    expect(model.sourceTaskIds).toEqual(split.train.map((task) => task.taskId));
    expect(model.sourceTaskIds.some((id) => split.heldOut.some((task) => task.taskId === id))).toBe(false);
    expect(Date.parse(model.trainedThrough)).toBeLessThan(Date.parse(split.cutoffExclusive));
  });

  test('rejects future telemetry rather than silently contaminating calibration', () => {
    const tasks = createFrozenTelemetryFixture();
    const split = chronologicalSplit(tasks, { trainCount: 84 });

    expect(() => trainCalibratedRouter(tasks, { cutoffExclusive: split.cutoffExclusive }))
      .toThrow('future-data leakage rejected');
  });

  test('future outcome mutation cannot change the trained model or prior', () => {
    const original = createFrozenTelemetryFixture();
    const split = chronologicalSplit(original, { trainCount: 84 });
    const firstModel = trainCalibratedRouter(split.train, { cutoffExclusive: split.cutoffExclusive });
    const firstPrior = staticCostPrediction(ROUTES.NAVIGATOR);

    const mutated = structuredClone(original);
    for (const task of mutated.slice(84)) {
      for (const route of Object.values(ROUTES)) {
        for (const metric of COST_DIMENSIONS) task.observations[route][metric] = 999_999;
      }
    }
    const mutatedSplit = chronologicalSplit(mutated, { trainCount: 84 });
    const secondModel = trainCalibratedRouter(mutatedSplit.train, { cutoffExclusive: mutatedSplit.cutoffExclusive });

    expect(secondModel.fingerprint).toBe(firstModel.fingerprint);
    expect(staticCostPrediction(ROUTES.NAVIGATOR)).toEqual(firstPrior);
  });

  test('predicts every cost dimension and exposes residual and uncertainty evidence', () => {
    const tasks = createFrozenTelemetryFixture();
    const split = chronologicalSplit(tasks, { trainCount: 84 });
    const model = trainCalibratedRouter(split.train, { cutoffExclusive: split.cutoffExclusive });
    const prediction = predictCostVector(model, split.heldOut[0], ROUTES.NAVIGATOR);

    expect(Object.keys(prediction.costs).sort()).toEqual([...COST_DIMENSIONS].sort());
    expect(Object.keys(prediction.residuals).sort()).toEqual([...COST_DIMENSIONS].sort());
    expect(Object.keys(prediction.uncertainty.perDimension).sort()).toEqual([...COST_DIMENSIONS].sort());
    expect(prediction.uncertainty.evidenceCount).toBe(84);
    for (const metric of COST_DIMENSIONS) {
      expect(Number.isFinite(prediction.costs[metric])).toBe(true);
      expect(prediction.residuals[metric].count).toBe(84);
      expect(prediction.residuals[metric].rmse).toBeGreaterThanOrEqual(0);
    }
  });

  test('uncertainty rises monotonically as historical evidence becomes sparse', () => {
    const tasks = createFrozenTelemetryFixture();
    const split = chronologicalSplit(tasks, { trainCount: 84 });
    const model = trainCalibratedRouter(split.train, { cutoffExclusive: split.cutoffExclusive });
    const task = split.heldOut[7];
    const counts = [84, 42, 16, 4, 1];
    const values = counts.map((evidenceCount) =>
      predictCostVector(model, task, ROUTES.SPECIALIST, { evidenceCount }).uncertainty);

    for (let index = 1; index < values.length; index += 1) {
      expect(values[index].overall).toBeGreaterThan(values[index - 1].overall);
      for (const metric of COST_DIMENSIONS) {
        expect(values[index].perDimension[metric]).toBeGreaterThan(values[index - 1].perDimension[metric]);
      }
    }
  });

  test('replays the held-out benchmark byte-for-byte deterministically', () => {
    const first = runHeldOutBenchmark();
    const second = runHeldOutBenchmark();

    expect(first.benchmarkFingerprint).toBe(second.benchmarkFingerprint);
    expect(first.modelFingerprint).toBe(second.modelFingerprint);
    expect(first).toEqual(second);
  });

  test('beats the static baseline by at least ten percent on held-out aggregate MAE', () => {
    const benchmark = runHeldOutBenchmark();
    const improvement = (benchmark.baseline.prediction.aggregateMae - benchmark.calibrated.prediction.aggregateMae)
      / benchmark.baseline.prediction.aggregateMae;

    expect(benchmark.noFutureDataLeakage).toBe(true);
    expect(improvement).toBeGreaterThanOrEqual(0.10);
    expect(benchmark.calibrated.prediction.aggregateMae).toBeLessThan(benchmark.baseline.prediction.aggregateMae);
    expect(benchmark.calibrated.prediction.scalarObservations).toBe(36 * 4 * 5);
  });

  test('never increases safety-critical route errors versus the static policy', () => {
    const tasks = createFrozenTelemetryFixture();
    const split = chronologicalSplit(tasks, { trainCount: 84 });
    const model = trainCalibratedRouter(split.train, { cutoffExclusive: split.cutoffExclusive });
    let staticErrors = 0;
    let calibratedErrors = 0;

    for (const task of split.heldOut) {
      const staticRoute = selectStaticLeastActionRoute(task).selectedRoute;
      const calibratedRoute = selectCalibratedRoute(model, task).selectedRoute;
      if (isSafetyCriticalRouteError(task, staticRoute)) staticErrors += 1;
      if (isSafetyCriticalRouteError(task, calibratedRoute)) calibratedErrors += 1;
      if (task.safetyCritical) {
        expect(staticRoute).toBe(ROUTES.GUARDED_SPECIALIST);
        expect(calibratedRoute).toBe(ROUTES.GUARDED_SPECIALIST);
      }
    }
    expect(calibratedErrors).toBeLessThanOrEqual(staticErrors);
  });

  test('refuses alpha green whenever the calibrated model does not beat baseline', () => {
    const benchmark = runHeldOutBenchmark();
    const noWin = assessAlphaPromotion(promotionInput(benchmark, {
      baselineAggregateMae: 0.10,
      calibratedAggregateMae: 0.095,
    }));
    const regression = assessAlphaPromotion(promotionInput(benchmark, {
      baselineSafetyErrors: 0,
      calibratedSafetyErrors: 1,
    }));

    expect(noWin.status).toBe('CALIBRATED_COST_ROUTER_ALPHA_NEEDS_WORK');
    expect(noWin.checks.held_out_mae_improved_at_least_10_percent).toBe(false);
    expect(regression.status).toBe('CALIBRATED_COST_ROUTER_ALPHA_NEEDS_WORK');
    expect(regression.checks.no_increase_in_safety_critical_route_errors).toBe(false);
  });

  test('promotes only the complete held-out evidence bundle and keeps alpha scope explicit', () => {
    const benchmark = runHeldOutBenchmark();
    const promotion = assessAlphaPromotion(promotionInput(benchmark));

    expect(promotion.status).toBe('CALIBRATED_COST_ROUTER_ALPHA_GREEN');
    expect(promotion.improvementRate).toBeGreaterThanOrEqual(0.10);
    expect(Object.values(promotion.checks).every(Boolean)).toBe(true);
  });
});

