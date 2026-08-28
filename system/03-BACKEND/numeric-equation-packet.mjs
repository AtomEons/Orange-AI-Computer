import { createHash } from 'node:crypto';

export const NUMERIC_EQUATION_SCHEMA = 'orange5.numeric-equation-packet.v1';

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function bytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function hashSeries(values) {
  const hash = createHash('sha256');
  const encoded = Buffer.allocUnsafe(8);
  for (const value of values) {
    encoded.writeDoubleBE(value, 0);
    hash.update(encoded);
  }
  return hash.digest('hex');
}

function hashResiduals(residuals) {
  const hash = createHash('sha256');
  const encoded = Buffer.allocUnsafe(8);
  for (const [index, residual] of residuals) {
    hash.update(`${index}:`);
    encoded.writeDoubleBE(residual, 0);
    hash.update(encoded);
  }
  return hash.digest('hex');
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function finiteSeries(values) {
  if (!Array.isArray(values) || values.length === 0) throw new TypeError('numeric equation requires a non-empty array');
  const normalized = values.map((value) => {
    const number = Number(value);
    return Object.is(number, -0) ? 0 : number;
  });
  if (normalized.some((value) => !Number.isFinite(value))) throw new TypeError('numeric equation accepts finite numbers only');
  return normalized;
}

function modelCandidate(type, values, parameters, predict, formula) {
  const residuals = [];
  for (let index = 0; index < values.length; index += 1) {
    const predicted = predict(index);
    if (!Object.is(predicted, values[index])) residuals.push([index, values[index] - predicted]);
  }
  return { type, formula, parameters, residuals };
}

function deltaRuns(values) {
  if (values.length === 1) return [];
  const runs = [];
  let delta = values[1] - values[0];
  let count = 1;
  for (let index = 2; index < values.length; index += 1) {
    const next = values[index] - values[index - 1];
    if (Object.is(next, delta)) count += 1;
    else { runs.push([delta, count]); delta = next; count = 1; }
  }
  runs.push([delta, count]);
  return runs;
}

function candidates(values) {
  const constant = median(values);
  const deltas = values.slice(1).map((value, index) => value - values[index]);
  const slope = deltas.length ? median(deltas) : 0;
  const intercept = median(values.map((value, index) => value - slope * index));
  const output = [
    modelCandidate('constant', values, { value: constant }, () => constant, 'y(t)=c'),
    modelCandidate('linear', values, { intercept, slope }, (index) => intercept + slope * index, 'y(t)=a+b*t'),
  ];
  for (const period of [7, 24]) {
    if (values.length < period * 2) continue;
    const cycle = Array.from({ length: period }, (_, offset) =>
      median(values.filter((_, index) => index % period === offset)));
    output.push(modelCandidate(
      `seasonal_${period}`,
      values,
      { period, cycle },
      (index) => cycle[index % period],
      `y(t)=cycle[t mod ${period}]`,
    ));
  }
  output.push({
    type: 'delta_rle', formula: 'y(0)=first; y(t)=y(t-1)+delta(t)',
    parameters: { first: values[0], runs: deltaRuns(values) }, residuals: [],
  });
  output.push({ type: 'raw', formula: 'y(t)=values[t]', parameters: { values }, residuals: [] });
  return output;
}

function packetCore(packet) {
  return {
    schema: packet.schema,
    name: packet.name,
    equation_type: packet.equation_type,
    formula: packet.formula,
    parameters: packet.parameters,
    count: packet.count,
    valid_range: packet.valid_range,
    units: packet.units,
    residuals: packet.residuals,
    source_pointer: packet.source_pointer,
    source_values_sha256: packet.source_values_sha256,
    residuals_sha256: packet.residuals_sha256,
    numeric_hash_algorithm: packet.numeric_hash_algorithm,
  };
}

function validatePacketShape(packet) {
  const errors = [];
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return ['packet must be an object'];
  if (packet.schema !== NUMERIC_EQUATION_SCHEMA) errors.push('schema mismatch');
  if (typeof packet.name !== 'string' || !packet.name) errors.push('name required');
  if (!Number.isSafeInteger(packet.count) || packet.count < 1) errors.push('count must be a positive safe integer');
  if (!Array.isArray(packet.valid_range)
    || packet.valid_range.length !== 2
    || packet.valid_range[0] !== 0
    || packet.valid_range[1] !== packet.count - 1) errors.push('valid_range mismatch');
  if (!packet.parameters || typeof packet.parameters !== 'object' || Array.isArray(packet.parameters)) errors.push('parameters required');
  if (!Array.isArray(packet.residuals)) errors.push('residuals must be an array');
  if (packet.units !== null && typeof packet.units !== 'string') errors.push('units must be a string or null');
  if (packet.source_pointer !== null && typeof packet.source_pointer !== 'string') errors.push('source pointer must be a string or null');
  if (packet.numeric_hash_algorithm !== 'sha256-float64be-v1') errors.push('numeric hash algorithm mismatch');
  if (!/^[a-f0-9]{64}$/.test(packet.source_values_sha256 || '')) errors.push('source values hash invalid');
  if (!/^[a-f0-9]{64}$/.test(packet.residuals_sha256 || '')) errors.push('residual hash invalid');
  if (!/^[a-f0-9]{64}$/.test(packet.reconstruction_sha256 || '')) errors.push('reconstruction hash invalid');
  if (!/^[a-f0-9]{64}$/.test(packet.id || '')) errors.push('packet id invalid');

  const seenResiduals = new Set();
  for (const residual of Array.isArray(packet.residuals) ? packet.residuals : []) {
    if (!Array.isArray(residual) || residual.length !== 2) {
      errors.push('residual entry malformed');
      continue;
    }
    const [index, delta] = residual;
    if (!Number.isSafeInteger(index) || index < 0 || index >= packet.count) errors.push(`residual index out of range: ${index}`);
    if (!Number.isFinite(delta)) errors.push(`residual is not finite: ${index}`);
    if (seenResiduals.has(index)) errors.push(`duplicate residual index: ${index}`);
    seenResiduals.add(index);
  }
  const parameters = packet.parameters || {};
  if (packet.equation_type === 'constant') {
    if (!Number.isFinite(parameters.value)) errors.push('constant value must be finite');
    if (packet.formula !== 'y(t)=c') errors.push('constant formula mismatch');
  } else if (packet.equation_type === 'linear') {
    if (!Number.isFinite(parameters.intercept) || !Number.isFinite(parameters.slope)) errors.push('linear parameters must be finite');
    if (packet.formula !== 'y(t)=a+b*t') errors.push('linear formula mismatch');
  } else if (typeof packet.equation_type === 'string' && packet.equation_type.startsWith('seasonal_')) {
    const declaredPeriod = Number(packet.equation_type.slice('seasonal_'.length));
    if (!Number.isSafeInteger(parameters.period) || parameters.period < 1 || parameters.period !== declaredPeriod) errors.push('seasonal period mismatch');
    if (!Array.isArray(parameters.cycle) || parameters.cycle.length !== parameters.period
      || parameters.cycle.some((value) => !Number.isFinite(value))) errors.push('seasonal cycle invalid');
    if (packet.formula !== `y(t)=cycle[t mod ${parameters.period}]`) errors.push('seasonal formula mismatch');
  } else if (packet.equation_type === 'delta_rle') {
    if (!Number.isFinite(parameters.first) || !Array.isArray(parameters.runs)) errors.push('delta_rle parameters invalid');
    let runTotal = 0;
    for (const run of Array.isArray(parameters.runs) ? parameters.runs : []) {
      if (!Array.isArray(run) || run.length !== 2 || !Number.isFinite(run[0])
        || !Number.isSafeInteger(run[1]) || run[1] < 1) errors.push('delta_rle run invalid');
      else runTotal += run[1];
    }
    if (runTotal !== packet.count - 1) errors.push('delta_rle run count mismatch');
    if (packet.formula !== 'y(0)=first; y(t)=y(t-1)+delta(t)') errors.push('delta_rle formula mismatch');
  } else if (packet.equation_type === 'raw') {
    if (!Array.isArray(parameters.values) || parameters.values.length !== packet.count
      || parameters.values.some((value) => !Number.isFinite(value))) errors.push('raw values invalid');
    if (packet.formula !== 'y(t)=values[t]') errors.push('raw formula mismatch');
  } else {
    errors.push(`unsupported equation type: ${packet.equation_type}`);
  }
  if (Array.isArray(packet.residuals) && /^[a-f0-9]{64}$/.test(packet.residuals_sha256 || '')
    && hashResiduals(packet.residuals) !== packet.residuals_sha256) errors.push('residual hash mismatch');

  if (/^[a-f0-9]{64}$/.test(packet.id || '') && sha256(JSON.stringify(packetCore(packet))) !== packet.id) {
    errors.push('packet id mismatch');
  }
  return errors;
}

function reconstructCore(core) {
  const count = core.count;
  let values;
  if (core.equation_type === 'constant') {
    values = Array(count).fill(core.parameters.value);
  } else if (core.equation_type === 'linear') {
    values = Array.from({ length: count }, (_, index) => core.parameters.intercept + core.parameters.slope * index);
  } else if (core.equation_type.startsWith('seasonal_')) {
    values = Array.from({ length: count }, (_, index) => core.parameters.cycle[index % core.parameters.period]);
  } else if (core.equation_type === 'delta_rle') {
    values = [core.parameters.first];
    for (const [delta, run] of core.parameters.runs) {
      for (let index = 0; index < run; index += 1) values.push(values.at(-1) + delta);
    }
  } else if (core.equation_type === 'raw') {
    values = [...core.parameters.values];
  } else {
    throw new Error(`unsupported equation type: ${core.equation_type}`);
  }
  for (const [index, residual] of core.residuals || []) values[index] += residual;
  return values.slice(0, count);
}

export function fitEquationPacket({ name = 'series', values, units = null, sourcePointer = null } = {}) {
  const series = finiteSeries(values);
  const normalizedUnits = units === null || units === undefined ? null : String(units);
  const normalizedSourcePointer = sourcePointer === null || sourcePointer === undefined ? null : String(sourcePointer);
  const rawBytes = bytes(series);
  const sourceValuesSha256 = hashSeries(series);
  const allCandidates = candidates(series);
  const ranked = allCandidates.map((candidate) => {
    const core = {
      schema: NUMERIC_EQUATION_SCHEMA,
      name: String(name),
      equation_type: candidate.type,
      formula: candidate.formula,
      parameters: candidate.parameters,
      count: series.length,
      valid_range: [0, series.length - 1],
      units: normalizedUnits,
      residuals: candidate.residuals,
      source_pointer: normalizedSourcePointer,
      source_values_sha256: sourceValuesSha256,
      residuals_sha256: hashResiduals(candidate.residuals),
      numeric_hash_algorithm: 'sha256-float64be-v1',
    };
    const reconstructed = reconstructCore(core);
    const errors = reconstructed.map((value, index) => Math.abs(value - series[index]));
    const maxError = Math.max(...errors);
    return {
      core,
      reconstructed,
      maxError,
      exact: hashSeries(reconstructed) === sourceValuesSha256,
      encodedBytes: bytes(core),
    };
  }).filter((candidate) => candidate.exact)
    .sort((a, b) => a.encodedBytes - b.encodedBytes || a.core.equation_type.localeCompare(b.core.equation_type));
  if (!ranked.length) throw new Error('no exact numeric equation candidate survived reconstruction');
  const winner = ranked[0];
  const reconstructionHash = hashSeries(winner.reconstructed);
  const packetId = sha256(JSON.stringify(winner.core));
  const packet = {
    ...winner.core,
    id: packetId,
    max_error: 0,
    mean_error: 0,
    reconstruction_sha256: reconstructionHash,
  };
  const packetBytes = bytes(packet);
  return {
    ...packet,
    metrics: {
      raw_bytes: rawBytes,
      model_payload_bytes: winner.encodedBytes,
      packet_bytes: packetBytes,
      compression_ratio: Number((rawBytes / Math.max(1, packetBytes)).toFixed(3)),
      storage_savings_bytes: rawBytes - packetBytes,
      storage_beneficial: packetBytes < rawBytes,
      residual_count: winner.core.residuals.length,
      candidates_compared: ranked.length,
      candidates_attempted: allCandidates.length,
      exact_reconstruction: true,
    },
  };
}

export function reconstructEquationPacket(packet, { expectedValues } = {}) {
  const errors = validatePacketShape(packet);
  if (errors.length) {
    return {
      values: [],
      reconstruction_sha256: null,
      source_values_sha256: null,
      source_verified: expectedValues === undefined ? null : false,
      verified: false,
      errors,
    };
  }
  let values;
  try {
    values = reconstructCore(packet);
  } catch (error) {
    return {
      values: [],
      reconstruction_sha256: null,
      source_values_sha256: null,
      source_verified: expectedValues === undefined ? null : false,
      verified: false,
      errors: [`reconstruction failed: ${error.message}`],
    };
  }
  const reconstructionSha256 = hashSeries(values);
  if (reconstructionSha256 !== packet.reconstruction_sha256) errors.push('reconstruction hash mismatch');
  if (reconstructionSha256 !== packet.source_values_sha256) errors.push('reconstruction does not match source hash');
  let sourceVerified = null;
  if (expectedValues !== undefined) {
    try {
      const expected = finiteSeries(expectedValues);
      sourceVerified = expected.length === packet.count && hashSeries(expected) === packet.source_values_sha256;
      if (!sourceVerified) errors.push('expected source values mismatch');
    } catch (error) {
      sourceVerified = false;
      errors.push(`expected source values invalid: ${error.message}`);
    }
  }
  return {
    values,
    reconstruction_sha256: reconstructionSha256,
    source_values_sha256: packet.source_values_sha256,
    source_verified: sourceVerified,
    verified: errors.length === 0,
    errors,
  };
}

export function verifyEquationPacket(packet, options) {
  const result = reconstructEquationPacket(packet, options);
  return {
    ok: result.verified && (result.source_verified === null || result.source_verified === true),
    errors: result.errors,
    reconstruction_sha256: result.reconstruction_sha256,
    source_values_sha256: result.source_values_sha256,
    source_verified: result.source_verified,
  };
}

export function renderEquationPacketAir(packet) {
  const compact = {
    id: packet.id.slice(0, 16), type: packet.equation_type, n: packet.count,
    p: packet.parameters, x: packet.residuals, u: packet.units,
    h: packet.reconstruction_sha256.slice(0, 16), s: packet.source_values_sha256.slice(0, 16),
    r: packet.residuals_sha256.slice(0, 16),
  };
  return `N:${packet.name}=${JSON.stringify(compact)}`;
}

export const __numericEquationInternals = Object.freeze({
  hashSeries,
  hashResiduals,
  packetCore,
  validatePacketShape,
});
