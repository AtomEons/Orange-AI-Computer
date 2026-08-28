// 07-VISUAL/structural/axis-tap.mjs
//
// AEYES1-AXIS-TAP-0.1 — generic tap contract per GPT doctrine v4 (spine seq 112).
//
// Every audited axis emits a tap record with four evidence levels:
//   T0 source     — raw source field (input to axis, pre-localization)
//   T1 local      — localized representation (grid/fixations/channels)
//   T2 pooled     — pooled axis output (current scalars)
//   T3 aggregate  — downstream contribution (axis_bundle range + it80 ref)
//
// Different axes have different shapes. Contract requires identical LEVELS
// and PROVENANCE, not identical shapes.

export const TAP_SCHEMA_VERSION = "AEYES1-AXIS-TAP-0.1";

/** Deterministic hash of a numeric field (uses xorshift on bit representation). */
export function hashField(field) {
  if (!field) return "null";
  const arr = field.data ?? field;
  if (!arr || !arr.length) return "empty";
  const len = arr.length;
  let h = 0x811c9dc5 | 0;   // FNV-1a offset
  const buf = new Float64Array(1);
  const bytes = new Uint8Array(buf.buffer);
  const step = Math.max(1, Math.floor(len / 512));   // sample up to 512 points
  let count = 0;
  for (let i = 0; i < len; i += step) {
    buf[0] = Number(arr[i]) || 0;
    for (let b = 0; b < 8; b++) {
      h ^= bytes[b];
      h = Math.imul(h, 0x01000193);
    }
    count++;
  }
  h ^= count;
  h = Math.imul(h, 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Compute statistics on a numeric field. */
export function computeDiagnostics(field) {
  if (!field) return { valid: false, reason: "NULL_FIELD" };
  const arr = field.data ?? field;
  if (!arr || !arr.length) return { valid: false, reason: "EMPTY_FIELD" };
  let min = Infinity, max = -Infinity, sum = 0, sum2 = 0, nz = 0, finite = true;
  const N = arr.length;
  for (let i = 0; i < N; i++) {
    const v = Number(arr[i]);
    if (!Number.isFinite(v)) { finite = false; continue; }
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    sum2 += v * v;
    if (v !== 0) nz++;
  }
  const mean = sum / N;
  const variance = Math.max(0, sum2 / N - mean * mean);
  const clippingFraction = arr.length ? (
    Array.prototype.reduce.call(arr, (a, x) => a + ((x >= 0.995 || x <= 0.005) ? 1 : 0), 0) / N
  ) : 0;
  return {
    valid: finite,
    finite,
    nonzeroFraction: nz / N,
    min: Number.isFinite(min) ? min : null,
    max: Number.isFinite(max) ? max : null,
    mean,
    variance,
    clippingFraction,
    length: N,
  };
}

/** Build the tap record for one axis. */
export function buildTap({
  axisId, axisVersion, coordinateFrame = "canonical-256", units = "normalized",
  taps, flags = {}, metadata = {},
}) {
  if (!axisId) throw new Error("buildTap: axisId required");
  if (!axisVersion) throw new Error("buildTap: axisVersion required");
  if (!taps) throw new Error("buildTap: taps required");
  const tapRecord = {
    axisId, axisVersion,
    tapSchema: TAP_SCHEMA_VERSION,
    coordinateFrame, units,
    taps: {
      source:    buildTapLevel(taps.source, "T0"),
      local:     buildTapLevel(taps.local, "T1"),
      pooled:    buildTapLevel(taps.pooled, "T2"),
      aggregate: buildTapLevel(taps.aggregate, "T3"),
    },
    diagnostics: {
      T0: taps.source ? computeDiagnostics(taps.source.data) : { valid: false, reason: "MISSING_T0" },
      T1: taps.local ? computeDiagnostics(taps.local.data) : { valid: false, reason: "MISSING_T1" },
      T2: taps.pooled ? computeDiagnostics(taps.pooled.data) : { valid: false, reason: "MISSING_T2" },
      T3: taps.aggregate ? computeDiagnostics(taps.aggregate.data) : { valid: false, reason: "MISSING_T3" },
    },
    flags,
    metadata,
  };
  return tapRecord;
}

function buildTapLevel(level, tag) {
  if (!level) return { present: false, reason: `MISSING_${tag}` };
  const { shape, dtype, data, layout, cells, ...rest } = level;
  return {
    present: true,
    shape: shape ?? (data?.length !== undefined ? [data.length] : null),
    dtype: dtype ?? (data instanceof Float32Array ? "float32"
                    : data instanceof Float64Array ? "float64"
                    : Array.isArray(data) ? "array" : "unknown"),
    layout: layout ?? null,
    cells: cells ?? null,
    dataHash: hashField(data),
    dataLen: data?.length ?? 0,
    ...rest,
  };
}

// ---- verdict math per GPT doctrine v4-5 ----
// PRESERVED requires gap ≥ absolute_floor AND ratio ≥ preserve_ratio
// COLLAPSED_CONSTANT when gap < absolute_floor AND noise < absolute_floor
// UNAVAILABLE when lane is marked availability=false in static mode
export function verdictForTap(gap, noiseA, noiseB, {
  absoluteFloor = 1e-4,
  preserveRatio = 3.0,
  weakRatio = 1.0,
} = {}) {
  const noise = Math.max(noiseA, noiseB, 1e-9);
  if (gap < absoluteFloor && noise < absoluteFloor) {
    return { verdict: "COLLAPSED_CONSTANT", gap, noise, ratio: 0, absoluteFloor, preserveRatio };
  }
  const ratio = gap / noise;
  let verdict;
  if (gap >= absoluteFloor && ratio >= preserveRatio) verdict = "PRESERVED";
  else if (gap >= absoluteFloor && ratio >= weakRatio) verdict = "WEAK";
  else verdict = "COLLAPSED";
  return { verdict, gap, noise, ratio, absoluteFloor, preserveRatio };
}

// Verdict for a lane that is unavailable in current acquisition mode.
// GPT doctrine v5: unavailable ≠ zero-observed. Never score UNAVAILABLE lanes
// as PRESERVED/WEAK/COLLAPSED — they should be counted separately.
export function unavailableVerdict(availability = "UNKNOWN") {
  return { verdict: "UNAVAILABLE", availability, gap: null, noise: null, ratio: null };
}

/** Check if a lane level is available (non-null data). */
export function laneAvailable(level) {
  return level && level.data !== undefined && level.data !== null;
}

// L2-normalized L2 distance between two same-shape numeric arrays
export function l2n(a, b) {
  const arrA = a?.data ?? a;
  const arrB = b?.data ?? b;
  if (!arrA || !arrB) return 0;
  const n = Math.min(arrA.length, arrB.length);
  if (n === 0) return 0;
  let na = 0, nb = 0;
  for (let i = 0; i < n; i++) { na += arrA[i] * arrA[i]; nb += arrB[i] * arrB[i]; }
  na = Math.sqrt(na) || 1; nb = Math.sqrt(nb) || 1;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const d = arrA[i] / na - arrB[i] / nb;
    s += d * d;
  }
  return Math.sqrt(s);
}
