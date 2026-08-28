import { createHash } from 'node:crypto';

export const CALIBRATED_ROUTER_SCHEMA = 'orange5.calibrated-cost-router.alpha.v1';

export const ROUTES = Object.freeze({
  REFLEX: 'reflex',
  NAVIGATOR: 'navigator',
  SPECIALIST: 'specialist',
  GUARDED_SPECIALIST: 'guarded_specialist',
});

export const ROUTE_IDS = Object.freeze(Object.values(ROUTES));

export const COST_DIMENSIONS = Object.freeze([
  'wallTimeMs',
  'computeProxy',
  'failureProbability',
  'qualityPenalty',
  'monetaryCostUsd',
]);

export const COST_SCALES = Object.freeze({
  wallTimeMs: 12_000,
  computeProxy: 16,
  failureProbability: 1,
  qualityPenalty: 1,
  monetaryCostUsd: 0.08,
});

export const DEFAULT_OBJECTIVE_WEIGHTS = Object.freeze({
  wallTimeMs: 0.20,
  computeProxy: 0.15,
  failureProbability: 0.25,
  qualityPenalty: 0.35,
  monetaryCostUsd: 0.05,
  uncertainty: 0.08,
});

// These are declared route priors, not values fitted on the frozen fixture.
export const STATIC_LEAST_ACTION_PRIORS = Object.freeze({
  [ROUTES.REFLEX]: Object.freeze({
    wallTimeMs: 700,
    computeProxy: 0.90,
    failureProbability: 0.23,
    qualityPenalty: 0.29,
    monetaryCostUsd: 0,
  }),
  [ROUTES.NAVIGATOR]: Object.freeze({
    wallTimeMs: 1_450,
    computeProxy: 1.60,
    failureProbability: 0.10,
    qualityPenalty: 0.13,
    monetaryCostUsd: 0.0025,
  }),
  [ROUTES.SPECIALIST]: Object.freeze({
    wallTimeMs: 2_800,
    computeProxy: 3.50,
    failureProbability: 0.045,
    qualityPenalty: 0.065,
    monetaryCostUsd: 0.018,
  }),
  [ROUTES.GUARDED_SPECIALIST]: Object.freeze({
    wallTimeMs: 4_800,
    computeProxy: 5.50,
    failureProbability: 0.012,
    qualityPenalty: 0.035,
    monetaryCostUsd: 0.045,
  }),
});

const FEATURE_NAMES = Object.freeze([
  'bias',
  'complexity',
  'contextLoad',
  'novelty',
  'risk',
  'toolIntensity',
  'complexityContext',
  'riskNovelty',
]);

const SYNTHETIC_COEFFICIENTS = Object.freeze({
  [ROUTES.REFLEX]: Object.freeze({
    wallTimeMs: [150, 800, 350, 200, 100, 300, 400, 100],
    computeProxy: [0.15, 0.90, 0.35, 0.20, 0.10, 0.45, 0.35, 0.10],
    failureProbability: [0.03, 0.18, 0.07, 0.16, 0.18, 0.08, 0.15, 0.08],
    qualityPenalty: [0.04, 0.30, 0.10, 0.22, 0.12, 0.08, 0.22, 0.08],
    monetaryCostUsd: [0, 0, 0, 0, 0, 0, 0, 0],
  }),
  [ROUTES.NAVIGATOR]: Object.freeze({
    wallTimeMs: [450, 900, 500, 260, 160, 450, 350, 140],
    computeProxy: [0.50, 1.30, 0.65, 0.40, 0.25, 0.70, 0.55, 0.20],
    failureProbability: [0.015, 0.07, 0.025, 0.065, 0.07, 0.035, 0.05, 0.03],
    qualityPenalty: [0.025, 0.11, 0.045, 0.10, 0.04, 0.035, 0.07, 0.03],
    monetaryCostUsd: [0.0006, 0.002, 0.001, 0.0006, 0.0005, 0.001, 0.0008, 0.0003],
  }),
  [ROUTES.SPECIALIST]: Object.freeze({
    wallTimeMs: [1_200, 1_200, 800, 350, 250, 700, 300, 100],
    computeProxy: [1.40, 2.00, 0.90, 0.50, 0.40, 1.10, 0.55, 0.20],
    failureProbability: [0.008, 0.025, 0.01, 0.025, 0.025, 0.015, 0.015, 0.01],
    qualityPenalty: [0.012, 0.04, 0.02, 0.035, 0.018, 0.015, 0.025, 0.01],
    monetaryCostUsd: [0.006, 0.012, 0.006, 0.003, 0.002, 0.007, 0.004, 0.002],
  }),
  [ROUTES.GUARDED_SPECIALIST]: Object.freeze({
    wallTimeMs: [2_200, 1_500, 900, 450, 450, 800, 400, 200],
    computeProxy: [2.30, 2.40, 1.10, 0.60, 0.80, 1.30, 0.60, 0.30],
    failureProbability: [0.002, 0.008, 0.004, 0.008, 0.004, 0.006, 0.004, 0.002],
    qualityPenalty: [0.008, 0.02, 0.01, 0.018, 0.008, 0.01, 0.012, 0.004],
    monetaryCostUsd: [0.015, 0.02, 0.01, 0.005, 0.006, 0.012, 0.006, 0.003],
  }),
});

const NOISE_AMPLITUDES = Object.freeze({
  wallTimeMs: 60,
  computeProxy: 0.06,
  failureProbability: 0.008,
  qualityPenalty: 0.008,
  monetaryCostUsd: 0.00015,
});

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashCanonical(value) {
  return createHash('sha256').update(stableSerialize(value)).digest('hex');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function round(value, digits = 8) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function deterministicNoise(key) {
  const hex = createHash('sha256').update(key).digest('hex').slice(0, 8);
  return (Number.parseInt(hex, 16) / 0xffffffff) * 2 - 1;
}

function featureVector(task) {
  const { complexity, contextLoad, novelty, risk, toolIntensity } = task.features;
  return [
    1,
    complexity,
    contextLoad,
    novelty,
    risk,
    toolIntensity,
    complexity * contextLoad,
    risk * novelty,
  ];
}

function dot(left, right) {
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result += left[index] * right[index];
  return result;
}

function normalizeCost(metric, value) {
  return value / COST_SCALES[metric];
}

function normalizePrediction(metric, value) {
  if (metric === 'failureProbability' || metric === 'qualityPenalty') return clamp(value, 0, 1);
  return Math.max(0, value);
}

function observedCostVector(task, route) {
  const features = featureVector(task);
  const costs = {};
  for (const metric of COST_DIMENSIONS) {
    const nominal = dot(SYNTHETIC_COEFFICIENTS[route][metric], features);
    const noise = deterministicNoise(`${task.taskId}|${route}|${metric}`) * NOISE_AMPLITUDES[metric];
    costs[metric] = round(normalizePrediction(metric, nominal + noise));
  }
  return costs;
}

export function createFrozenTelemetryFixture({ count = 120, seed = 0x0A5EED } = {}) {
  if (!Number.isInteger(count) || count < 20) throw new TypeError('count must be an integer of at least 20');
  const random = mulberry32(seed);
  const epoch = Date.parse('2026-01-01T00:00:00.000Z');
  const tasks = [];
  for (let index = 0; index < count; index += 1) {
    const sequence = index + 1;
    const rawRisk = 0.03 + random() * 0.84;
    const safetyCritical = sequence % 13 === 0 || (rawRisk > 0.82 && sequence % 7 === 0);
    const task = {
      schema: 'orange5.calibrated-cost-router.telemetry-task.v1',
      taskId: `route-task-${String(sequence).padStart(3, '0')}`,
      sequence,
      observedAt: new Date(epoch + index * 3_600_000).toISOString(),
      safetyCritical,
      features: {
        complexity: round(0.06 + random() * 0.91, 6),
        contextLoad: round(0.05 + random() * 0.93, 6),
        novelty: round(0.03 + random() * 0.94, 6),
        risk: round(safetyCritical ? Math.max(0.82, rawRisk) : rawRisk, 6),
        toolIntensity: round(0.02 + random() * 0.95, 6),
      },
    };
    task.observations = Object.fromEntries(ROUTE_IDS.map((route) => [route, observedCostVector(task, route)]));
    tasks.push(task);
  }
  return deepFreeze(tasks);
}

export function chronologicalSplit(tasks, { trainCount = 84 } = {}) {
  if (!Array.isArray(tasks) || tasks.length < 2) throw new TypeError('tasks must contain at least two telemetry tasks');
  if (!Number.isInteger(trainCount) || trainCount < 1 || trainCount >= tasks.length) {
    throw new RangeError('trainCount must leave at least one held-out task');
  }
  for (let index = 1; index < tasks.length; index += 1) {
    if (Date.parse(tasks[index - 1].observedAt) >= Date.parse(tasks[index].observedAt)) {
      throw new Error('telemetry tasks must be strictly chronological');
    }
  }
  const train = tasks.slice(0, trainCount);
  const heldOut = tasks.slice(trainCount);
  const cutoffExclusive = heldOut[0].observedAt;
  return deepFreeze({ train, heldOut, cutoffExclusive });
}

function solveLinearSystem(matrix, vector) {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-12) throw new Error('calibration matrix is singular');
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let cell = column; cell <= size; cell += 1) augmented[column][cell] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let cell = column; cell <= size; cell += 1) {
        augmented[row][cell] -= factor * augmented[column][cell];
      }
    }
  }
  return augmented.map((row) => row[size]);
}

function fitRidge(rows, values, lambda = 1e-7) {
  const width = rows[0].length;
  const gram = Array.from({ length: width }, () => Array(width).fill(0));
  const target = Array(width).fill(0);
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    for (let left = 0; left < width; left += 1) {
      target[left] += rows[rowIndex][left] * values[rowIndex];
      for (let right = 0; right < width; right += 1) {
        gram[left][right] += rows[rowIndex][left] * rows[rowIndex][right];
      }
    }
  }
  for (let index = 1; index < width; index += 1) gram[index][index] += lambda;
  gram[0][0] += lambda * 0.01;
  return solveLinearSystem(gram, target).map((value) => round(value, 12));
}

function summarizeResiduals(residuals) {
  const count = residuals.length;
  const mean = residuals.reduce((sum, value) => sum + value, 0) / count;
  const mae = residuals.reduce((sum, value) => sum + Math.abs(value), 0) / count;
  const rmse = Math.sqrt(residuals.reduce((sum, value) => sum + value ** 2, 0) / count);
  const maxAbs = Math.max(...residuals.map(Math.abs));
  return { count, mean: round(mean), mae: round(mae), rmse: round(rmse), maxAbs: round(maxAbs) };
}

function assertTaskShape(task) {
  if (!task || typeof task !== 'object') throw new TypeError('telemetry task must be an object');
  if (!task.taskId || !Number.isFinite(Date.parse(task.observedAt))) throw new TypeError('telemetry task identity is invalid');
  if (!task.features || !task.observations) throw new TypeError('telemetry task must include features and observations');
  for (const route of ROUTE_IDS) {
    if (!task.observations[route]) throw new TypeError(`telemetry task is missing ${route} observations`);
    for (const metric of COST_DIMENSIONS) {
      if (!Number.isFinite(task.observations[route][metric])) throw new TypeError(`${route}.${metric} must be finite`);
    }
  }
}

export function trainCalibratedRouter(trainTasks, { cutoffExclusive, ridge = 1e-7 } = {}) {
  if (!Array.isArray(trainTasks) || trainTasks.length < FEATURE_NAMES.length + 2) {
    throw new RangeError(`at least ${FEATURE_NAMES.length + 2} training tasks are required`);
  }
  const cutoffMs = cutoffExclusive ? Date.parse(cutoffExclusive) : Number.POSITIVE_INFINITY;
  if (cutoffExclusive && !Number.isFinite(cutoffMs)) throw new TypeError('cutoffExclusive must be a valid timestamp');
  let previous = Number.NEGATIVE_INFINITY;
  for (const task of trainTasks) {
    assertTaskShape(task);
    const observedMs = Date.parse(task.observedAt);
    if (observedMs <= previous) throw new Error('training telemetry must be strictly chronological');
    if (observedMs >= cutoffMs) throw new Error(`future-data leakage rejected for ${task.taskId}`);
    previous = observedMs;
  }

  const rows = trainTasks.map(featureVector);
  const featureMean = rows[0].map((_, column) => rows.reduce((sum, row) => sum + row[column], 0) / rows.length);
  const coefficients = {};
  const diagnostics = {};
  for (const route of ROUTE_IDS) {
    coefficients[route] = {};
    diagnostics[route] = {};
    for (const metric of COST_DIMENSIONS) {
      const values = trainTasks.map((task) => task.observations[route][metric]);
      const fitted = fitRidge(rows, values, ridge);
      coefficients[route][metric] = fitted;
      diagnostics[route][metric] = summarizeResiduals(rows.map((row, index) => values[index] - dot(fitted, row)));
    }
  }

  const modelCore = {
    schema: CALIBRATED_ROUTER_SCHEMA,
    featureNames: FEATURE_NAMES,
    trainedThrough: trainTasks.at(-1).observedAt,
    cutoffExclusive: cutoffExclusive ?? null,
    sourceTaskIds: trainTasks.map((task) => task.taskId),
    routeEvidenceCount: Object.fromEntries(ROUTE_IDS.map((route) => [route, trainTasks.length])),
    featureMean: featureMean.map((value) => round(value, 12)),
    coefficients,
    diagnostics,
  };
  return deepFreeze({ ...modelCore, fingerprint: hashCanonical(modelCore) });
}

function predictionUncertainty(model, task, route, evidenceCount) {
  const available = model.routeEvidenceCount[route];
  const count = clamp(evidenceCount ?? available, 1, available);
  const features = featureVector(task);
  const distance = Math.sqrt(features.reduce((sum, value, index) => sum + (value - model.featureMean[index]) ** 2, 0) / features.length);
  const sparsity = 1 / Math.sqrt(count);
  const perDimension = {};
  for (const metric of COST_DIMENSIONS) {
    const residual = model.diagnostics[route][metric];
    const residualScale = normalizeCost(metric, residual.rmse);
    perDimension[metric] = round(clamp(residualScale + 0.25 * sparsity + 0.05 * distance, 0, 1));
  }
  const overall = COST_DIMENSIONS.reduce((sum, metric) => sum + perDimension[metric], 0) / COST_DIMENSIONS.length;
  return deepFreeze({
    overall: round(overall),
    perDimension,
    evidenceCount: count,
    availableEvidenceCount: available,
    featureDistance: round(distance),
  });
}

export function predictCostVector(model, task, route, { evidenceCount } = {}) {
  if (!model || model.schema !== CALIBRATED_ROUTER_SCHEMA) throw new TypeError('a calibrated router model is required');
  if (!ROUTE_IDS.includes(route)) throw new RangeError(`unknown route: ${route}`);
  const features = featureVector(task);
  const costs = {};
  const residuals = {};
  for (const metric of COST_DIMENSIONS) {
    costs[metric] = round(normalizePrediction(metric, dot(model.coefficients[route][metric], features)));
    residuals[metric] = model.diagnostics[route][metric];
  }
  return deepFreeze({
    route,
    costs,
    uncertainty: predictionUncertainty(model, task, route, evidenceCount),
    residuals,
    modelFingerprint: model.fingerprint,
  });
}

export function staticCostPrediction(route) {
  if (!ROUTE_IDS.includes(route)) throw new RangeError(`unknown route: ${route}`);
  return deepFreeze({
    route,
    costs: { ...STATIC_LEAST_ACTION_PRIORS[route] },
    uncertainty: { overall: 0.25, method: 'declared-static-prior' },
    residuals: null,
  });
}

export function scoreCostVector(costs, { weights = DEFAULT_OBJECTIVE_WEIGHTS, uncertainty = 0 } = {}) {
  let score = 0;
  for (const metric of COST_DIMENSIONS) score += normalizeCost(metric, costs[metric]) * weights[metric];
  return round(score + uncertainty * weights.uncertainty, 12);
}

function eligibleRoutes(task) {
  // Both policies share this non-negotiable safety fence.
  if (task.safetyCritical) return [ROUTES.GUARDED_SPECIALIST];
  return [ROUTES.REFLEX, ROUTES.NAVIGATOR, ROUTES.SPECIALIST];
}

function chooseRoute(task, predictor, weights) {
  const candidates = eligibleRoutes(task).map((route) => {
    const prediction = predictor(route);
    return {
      route,
      predictedCosts: prediction.costs,
      uncertainty: prediction.uncertainty,
      residuals: prediction.residuals,
      score: scoreCostVector(prediction.costs, {
        weights,
        uncertainty: prediction.uncertainty?.overall ?? 0,
      }),
    };
  }).sort((left, right) => left.score - right.score || left.route.localeCompare(right.route));
  return deepFreeze({
    selectedRoute: candidates[0].route,
    safetyFenceApplied: task.safetyCritical,
    candidates,
  });
}

export function selectCalibratedRoute(model, task, { weights = DEFAULT_OBJECTIVE_WEIGHTS, evidenceCount } = {}) {
  return chooseRoute(task, (route) => predictCostVector(model, task, route, { evidenceCount }), weights);
}

export function selectStaticLeastActionRoute(task, { weights = DEFAULT_OBJECTIVE_WEIGHTS } = {}) {
  return chooseRoute(task, staticCostPrediction, weights);
}

export function isSafetyCriticalRouteError(task, route) {
  return Boolean(task.safetyCritical && route !== ROUTES.GUARDED_SPECIALIST);
}

function predictionError(tasks, predictor) {
  const dimensionTotals = Object.fromEntries(COST_DIMENSIONS.map((metric) => [metric, 0]));
  let observations = 0;
  for (const task of tasks) {
    for (const route of ROUTE_IDS) {
      const predicted = predictor(task, route).costs;
      const actual = task.observations[route];
      for (const metric of COST_DIMENSIONS) {
        dimensionTotals[metric] += Math.abs(predicted[metric] - actual[metric]) / COST_SCALES[metric];
        observations += 1;
      }
    }
  }
  const divisor = tasks.length * ROUTE_IDS.length;
  const byDimension = Object.fromEntries(COST_DIMENSIONS.map((metric) => [metric, round(dimensionTotals[metric] / divisor, 12)]));
  return {
    aggregateMae: round(Object.values(byDimension).reduce((sum, value) => sum + value, 0) / COST_DIMENSIONS.length, 12),
    byDimension,
    scalarObservations: observations,
  };
}

function selectionEvaluation(tasks, selector) {
  let safetyErrors = 0;
  let realizedObjective = 0;
  const routeCounts = Object.fromEntries(ROUTE_IDS.map((route) => [route, 0]));
  for (const task of tasks) {
    const selection = selector(task);
    routeCounts[selection.selectedRoute] += 1;
    if (isSafetyCriticalRouteError(task, selection.selectedRoute)) safetyErrors += 1;
    realizedObjective += scoreCostVector(task.observations[selection.selectedRoute]);
  }
  return {
    safetyCriticalRouteErrors: safetyErrors,
    averageRealizedObjective: round(realizedObjective / tasks.length, 12),
    routeCounts,
  };
}

export function assessAlphaPromotion(metrics) {
  const baseline = Number(metrics.baselineAggregateMae);
  const calibrated = Number(metrics.calibratedAggregateMae);
  const improvementRate = baseline > 0 ? (baseline - calibrated) / baseline : Number.NEGATIVE_INFINITY;
  const checks = {
    frozen_fixture_has_120_tasks: metrics.fixtureCount === 120,
    chronological_train_test_split: metrics.trainCount > 0 && metrics.testCount > 0 && metrics.noFutureDataLeakage === true,
    held_out_mae_improved_at_least_10_percent: Number.isFinite(improvementRate) && improvementRate >= 0.10,
    no_increase_in_safety_critical_route_errors:
      Number.isInteger(metrics.baselineSafetyErrors)
      && Number.isInteger(metrics.calibratedSafetyErrors)
      && metrics.calibratedSafetyErrors <= metrics.baselineSafetyErrors,
    deterministic_replay: metrics.deterministicReplay === true,
    uncertainty_monotonic_under_sparse_evidence: metrics.uncertaintyMonotonic === true,
    focused_tests_passed: metrics.focusedTestsPassed === true,
  };
  const green = Object.values(checks).every(Boolean);
  return deepFreeze({
    status: green ? 'CALIBRATED_COST_ROUTER_ALPHA_GREEN' : 'CALIBRATED_COST_ROUTER_ALPHA_NEEDS_WORK',
    green,
    improvementRate: Number.isFinite(improvementRate) ? round(improvementRate, 12) : null,
    checks,
  });
}

export function runHeldOutBenchmark({ tasks = createFrozenTelemetryFixture(), trainCount = 84 } = {}) {
  const split = chronologicalSplit(tasks, { trainCount });
  const model = trainCalibratedRouter(split.train, { cutoffExclusive: split.cutoffExclusive });
  const baselineError = predictionError(split.heldOut, (_task, route) => staticCostPrediction(route));
  const calibratedError = predictionError(split.heldOut, (task, route) => predictCostVector(model, task, route));
  const baselineSelection = selectionEvaluation(split.heldOut, (task) => selectStaticLeastActionRoute(task));
  const calibratedSelection = selectionEvaluation(split.heldOut, (task) => selectCalibratedRoute(model, task));
  const noFutureDataLeakage = model.sourceTaskIds.every((id) => split.train.some((task) => task.taskId === id))
    && model.sourceTaskIds.every((id) => !split.heldOut.some((task) => task.taskId === id))
    && Date.parse(model.trainedThrough) < Date.parse(split.cutoffExclusive);
  const probeTask = split.heldOut[0];
  const sparse = predictCostVector(model, probeTask, ROUTES.NAVIGATOR, { evidenceCount: 4 }).uncertainty;
  const dense = predictCostVector(model, probeTask, ROUTES.NAVIGATOR, { evidenceCount: trainCount }).uncertainty;
  const uncertaintyMonotonic = sparse.overall > dense.overall
    && COST_DIMENSIONS.every((metric) => sparse.perDimension[metric] >= dense.perDimension[metric]);
  const core = {
    schema: 'orange5.calibrated-cost-router.benchmark.v1',
    fixtureCount: tasks.length,
    fixtureHash: hashCanonical(tasks),
    trainCount: split.train.length,
    testCount: split.heldOut.length,
    cutoffExclusive: split.cutoffExclusive,
    modelFingerprint: model.fingerprint,
    noFutureDataLeakage,
    uncertaintyMonotonic,
    baseline: { prediction: baselineError, selection: baselineSelection },
    calibrated: { prediction: calibratedError, selection: calibratedSelection },
    objectiveImprovementRate: round(
      (baselineSelection.averageRealizedObjective - calibratedSelection.averageRealizedObjective)
        / baselineSelection.averageRealizedObjective,
      12,
    ),
    uncertaintyProbe: { sparse, dense },
  };
  return deepFreeze({ ...core, benchmarkFingerprint: hashCanonical(core), model });
}

