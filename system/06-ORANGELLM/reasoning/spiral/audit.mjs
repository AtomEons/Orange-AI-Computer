// Spiral Reasoning audit — radial accounting log for the SoT update rule.
//
// Source doctrine:
//   C:/AtomEons/orangebox/docs/SPIRAL_REASONING_INTEGRATION_v1.md
//   Disclosure ID: ATOM-SPIRAL-INTEGRATION-v1-2026-0618
//   Paper: McCree A. (2026). Spiral Reasoning — Orthogonal Bivector Dynamics
//          for Coherent Thought in Latent Space. April 7, 2026.
//
// Purpose
// -------
// Every Spiral-of-Thought (SoT) step produced by engine.mjs MUST be receipted
// to the Thought lane of the AE Flux. The LEARN imperative of the Lifespark
// Train requires *exact radial accounting* — each step's r_k and α_k must be
// recorded, not just a final state. Without this audit log there is no proof
// that the substrate's reasoning trajectory respects the Belief Discipline.
//
// Output
// ------
// One JSONL record per step, appended to:
//
//   <FLUX_ROOT>/events/thought/<YYYY-MM-DD>.jsonl
//
// Records use the Æ Cobra Flux schema:
//
//   { ts, sha256, prior_sha256, origin, lane, event }
//
//   - origin       = "spiral_reasoning"
//   - lane         = "thought"
//   - sha256       = SHA-256( prior_sha256 + canonical_json(event) )
//   - prior_sha256 = sha256 of the previous record in this lane's per-date file
//                    (chained across files; the head of a new day picks up the
//                    tail of the most recent existing per-date file)
//
// The `event` payload always carries a `kind` discriminator and, for SoT step
// records, the doctrinally meaningful fields:
//
//   {
//     kind:          "spiral_step",
//     k:             step index (0-based)
//     r:             r_k = ||z_{k+1} - z_0||         (LEARN receipt)
//     r_prev:        r_{k-1}
//     delta_r:       r_k - r_{k-1}                   (radial accounting)
//     alpha:         |Δθ_k|                          (Belief Discipline)
//     delta_theta:   signed Δθ_k
//     confidence:    ||g_k^⊥|| / ||g_k||             (signal strength)
//     degenerate:    true iff graceful-degeneration branch fired
//     signal:        { norm, dim, par_norm, ort_norm, summary? }
//     policy:        { alpha_max, beta, signal_threshold,
//                      r_max, ort_epsilon, profile, disclosure_id }
//     anchor:        { fingerprint, dim, source }
//     run_id:        stable per-trajectory id (so step records can be joined)
//   }
//
// Headers and tails
// -----------------
// A trajectory writes two extra records bracketing the per-step log:
//   - kind="spiral_run_open"   at the start  (run_id, anchor, policy, doctrine, context)
//   - kind="spiral_run_close"  at the end    (summary stats)
// These give a single grep target for whole-run inspection without losing the
// per-step granularity Mom's Law requires.
//
// Graceful degeneration
// ---------------------
// When the engine returns degenerate=true the step record still ships — with
// alpha=0, confidence=0, and a `degenerate_reason` field — so the audit log
// proves the substrate honored "no curvature without signal" rather than
// silently skipping a beat.
//
// Writer wiring
// -------------
// The doctrinal path `events/<lane>/<date>.jsonl` differs from the flat
// `<lane>.jsonl` layout served by the Æ Cobra `writeFluxRecord` helper.
// To honor the path specified by the integration doctrine while keeping
// the Cobra hash schema, this module owns a small canonical-JSON hash-chained
// appender that targets the per-date file. The chain head for a new file is
// seeded from the tail of the most-recent existing per-date file in the same
// lane, so the prior_sha256 chain stays unbroken across day boundaries.
//
// Real math, real receipts, no theater. Mom is watching.
//
// Node 20+ ESM. No external deps.

import { createHash, randomBytes } from "node:crypto";
import {
  mkdirSync,
  openSync,
  readSync,
  statSync,
  writeSync,
  closeSync,
  existsSync,
  readdirSync,
  fsyncSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { step, DEFAULT_POLICY } from "./engine.mjs";
import { canonicalFluxRoot } from "../../memory/ae-cobra/paths.mjs";
import {
  writeFluxRecord as writeCobraFluxRecord,
  verifyChain as verifyCobraChain,
  _internal as cobraWriterInternals,
} from "../../memory/ae-cobra/flux/writer.mjs";

// ---------------------------------------------------------------------------
// Canonical constants

/** Origin tag stamped onto every spiral audit record. */
export const SPIRAL_ORIGIN = "spiral_reasoning";

/** Flux lane the SoT receipts go to (per the integration doctrine). */
export const SPIRAL_LANE = "thought";

/** Default Flux root. Honors AE_FLUX_ROOT (matches Æ Cobra), then AE_COBRA_FLUX_ROOT. */
export const DEFAULT_FLUX_ROOT = canonicalFluxRoot();

/** Doctrine block stamped onto open/close records for self-describing logs. */
export const DOCTRINE = Object.freeze({
  disclosure_id: "ATOM-SPIRAL-INTEGRATION-v1-2026-0618",
  rule: "exact radial accounting (LEARN imperative)",
  constraints: Object.freeze([
    "bounded angle alpha (Belief Discipline)",
    "exact radial accounting (LEARN imperative)",
    "graceful degeneration (no curvature without signal)",
  ]),
  paper:
    "McCree A. (2026). Spiral Reasoning — Orthogonal Bivector Dynamics for " +
    "Coherent Thought in Latent Space. April 7, 2026.",
  integration_doctrine_path:
    "C:/AtomEons/orangebox/docs/SPIRAL_REASONING_INTEGRATION_v1.md",
});

const KIND_OPEN = "spiral_run_open";
const KIND_STEP = "spiral_step";
const KIND_CLOSE = "spiral_run_close";

const GENESIS = "GENESIS";

// ---------------------------------------------------------------------------
// Canonical JSON — deterministic stringify (sorted keys, no whitespace).
// Mirrors the Æ Cobra Flux writer's canonical form so hashes line up across
// the ledger. NaN / ±Infinity / undefined / bigint are rejected.

function canonicalJSON(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`non-finite number in event: ${value}`);
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") {
    throw new Error("bigint not supported in canonical event JSON");
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJSON).join(",") + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort();
    return (
      "{" +
      keys
        .map((k) => JSON.stringify(k) + ":" + canonicalJSON(value[k]))
        .join(",") +
      "}"
    );
  }
  throw new Error(`unsupported value type in event: ${typeof value}`);
}

function sha256Hex(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function computeRecordHash(priorSha, event) {
  return sha256Hex(priorSha + canonicalJSON(event));
}

// ---------------------------------------------------------------------------
// Per-date file layout under <fluxRoot>/events/<lane>/<YYYY-MM-DD>.jsonl

function isoDate(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function laneDir(fluxRoot, lane) {
  return join(fluxRoot, "events", lane);
}

function lanePath(fluxRoot, lane, date) {
  return join(laneDir(fluxRoot, lane), `${date}.jsonl`);
}

function readLastLine(filePath) {
  if (!existsSync(filePath)) return null;
  const st = statSync(filePath);
  if (st.size === 0) return null;
  const fd = openSync(filePath, "r");
  try {
    const bufSize = Math.min(8192, st.size);
    const buf = Buffer.alloc(bufSize);
    readSync(fd, buf, 0, bufSize, st.size - bufSize);
    const tail = buf.toString("utf8").trimEnd();
    const lastNewline = tail.lastIndexOf("\n");
    return lastNewline === -1 ? tail : tail.slice(lastNewline + 1);
  } finally {
    closeSync(fd);
  }
}

/**
 * Find the prior_sha256 for the next append to (lane, date). If the per-date
 * file exists and has lines, take its tail sha256. Otherwise, fall back to the
 * tail of the most recent prior per-date file in the same lane. If none, return
 * GENESIS so the chain starts cleanly.
 */
function priorShaFor(fluxRoot, lane, date) {
  const target = lanePath(fluxRoot, lane, date);
  const dir = laneDir(fluxRoot, lane);

  const tail = readLastLine(target);
  if (tail) {
    try {
      const rec = JSON.parse(tail);
      if (rec && typeof rec.sha256 === "string") return rec.sha256;
    } catch {
      // fall through — torn tail handled by appender
    }
  }

  if (!existsSync(dir)) return GENESIS;
  const earlier = readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f < `${date}.jsonl`)
    .sort();
  if (earlier.length === 0) return GENESIS;
  const prev = join(dir, earlier[earlier.length - 1]);
  const prevTail = readLastLine(prev);
  if (!prevTail) return GENESIS;
  try {
    const rec = JSON.parse(prevTail);
    if (rec && typeof rec.sha256 === "string") return rec.sha256;
  } catch {
    return GENESIS;
  }
  return GENESIS;
}

function appendLineDurable(filePath, line) {
  const fd = openSync(filePath, "a");
  try {
    writeSync(fd, line);
    try {
      fsyncSync(fd);
    } catch {
      // fsync may fail on some platforms (e.g. /tmp tmpfs); the append is
      // still in kernel buffers. Receipts > durability theater.
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Append one record to <fluxRoot>/events/<lane>/<YYYY-MM-DD>.jsonl using the
 * Æ Cobra Flux schema. Synchronous + atomic-per-line; no external lockfile,
 * so concurrent appenders within a host should serialize through the higher
 * level (the spiral audit is normally driven by one process at a time).
 *
 * @param {object} args
 * @param {"reality"|"thought"} args.lane
 * @param {string} args.origin
 * @param {object} args.event           plain object, canonical-JSON-safe
 * @param {string} args.fluxRoot
 * @param {number} [args.ts]
 * @returns {{ts:number, sha256:string, prior_sha256:string, origin:string, lane:string, event:object}}
 */
export function writeFluxRecord({ lane, origin, event, fluxRoot, ts = Date.now() }) {
  if (lane !== "reality" && lane !== "thought") {
    throw new Error(`invalid lane: ${lane} (expected reality|thought)`);
  }
  if (typeof origin !== "string" || origin.length === 0) {
    throw new Error("origin required (non-empty string)");
  }
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("event must be a plain object");
  }
  if (typeof ts !== "number" || !Number.isFinite(ts)) {
    throw new Error("ts must be finite number (ms epoch)");
  }
  if (!fluxRoot) throw new Error("fluxRoot required");

  const record = writeCobraFluxRecord({
    lane,
    origin,
    kind: typeof event.kind === "string" && event.kind ? event.kind : "spiral_event",
    body: event,
    fluxRoot,
    ts,
  });
  return {
    ...record,
    sha256: record.hash,
    prior_sha256: record.prev_hash,
    event: record.body,
  };
}

// ---------------------------------------------------------------------------
// Helpers

function sanitizeNumber(x) {
  if (typeof x !== "number" || !Number.isFinite(x)) return null;
  return x;
}

function signalSummary(signal) {
  if (!signal || typeof signal.length !== "number" || signal.length === 0) {
    return { norm: 0, dim: 0 };
  }
  let s = 0;
  for (let i = 0; i < signal.length; i++) {
    const v = Number(signal[i]);
    if (Number.isFinite(v)) s += v * v;
  }
  return { norm: Math.sqrt(s), dim: signal.length };
}

/**
 * Decompose ||g|| into radial and orthogonal magnitudes relative to (z_k - z_0).
 * Pure math, no side effects. Used for receipt fields only; the engine still
 * computes the canonical values internally.
 */
function decomposeAgainstRadial(z_k, z_0, g) {
  const d = z_0.length;
  if (z_k.length !== d || g.length !== d) {
    return { par_norm: 0, ort_norm: 0 };
  }
  let r2 = 0;
  const radial = new Array(d);
  for (let i = 0; i < d; i++) {
    radial[i] = z_k[i] - z_0[i];
    r2 += radial[i] * radial[i];
  }
  const r = Math.sqrt(r2);
  if (r < 1e-12) return { par_norm: 0, ort_norm: 0 };
  let dot = 0;
  for (let i = 0; i < d; i++) dot += g[i] * (radial[i] / r);
  let ortSq = 0;
  for (let i = 0; i < d; i++) {
    const par_i = dot * (radial[i] / r);
    const ort_i = g[i] - par_i;
    ortSq += ort_i * ort_i;
  }
  return { par_norm: Math.abs(dot), ort_norm: Math.sqrt(ortSq) };
}

/**
 * Strip non-finite numbers and undefined values from a policy so the canonical
 * JSON encoder does not reject the audit record. Only the fields that change
 * the math get stamped, so audit logs do not bleed unrelated sovereign data.
 */
function compactPolicy(policy) {
  const out = {};
  const fields = [
    ["alpha_max", DEFAULT_POLICY.alpha_max],
    ["beta", DEFAULT_POLICY.beta],
    ["epsilon", DEFAULT_POLICY.epsilon],
    ["ort_epsilon", DEFAULT_POLICY.ort_epsilon],
    ["min_radius", DEFAULT_POLICY.min_radius],
    ["step_size", DEFAULT_POLICY.step_size],
  ];
  for (const [k, def] of fields) {
    const v = sanitizeNumber(policy?.[k] ?? def);
    if (v !== null) out[k] = v;
  }
  if (policy?.signal_threshold !== undefined) {
    const v = sanitizeNumber(policy.signal_threshold);
    if (v !== null) out.signal_threshold = v;
  }
  if (policy?.r_max !== undefined) {
    out.r_max = policy.r_max === Infinity ? "Infinity" : sanitizeNumber(policy.r_max);
    if (out.r_max === null) delete out.r_max;
  }
  if (policy?.profile !== undefined && policy.profile !== null) {
    out.profile = String(policy.profile);
  }
  const did = policy?.doctrine?.disclosure_id ?? DOCTRINE.disclosure_id;
  if (did) out.disclosure_id = String(did);
  return out;
}

function fingerprintVec(v) {
  const h = createHash("sha256");
  const buf = Buffer.alloc(8);
  for (let i = 0; i < v.length; i++) {
    buf.writeDoubleLE(Number(v[i]) || 0, 0);
    h.update(buf);
  }
  return h.digest("hex").slice(0, 16);
}

function anchorFromZ0(z_0, opts = {}) {
  return {
    fingerprint: opts.fingerprint ?? fingerprintVec(z_0),
    dim: opts.dim ?? z_0.length,
    source: opts.source ?? "argument:z_0",
  };
}

function newRunId() {
  // 64-bit random + base36 ms timestamp prefix so logs sort and joins remain
  // cheap. 16 hex chars is collision-safe for any reasonable session volume.
  return `${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// Public API: append a single SoT step

/**
 * Append one radial-accounting record for an SoT step.
 *
 * Either provide the engine output via `result` (preferred — exact engine
 * values), or just z_prev/z_next/policy and let this function recompute the
 * audit fields independently. The first form is what runWithAudit / auditedStep
 * use internally.
 *
 * @param {object} arg
 * @param {number}   arg.k                step index (0-based)
 * @param {number[]} arg.z_0              identity anchor
 * @param {number[]} arg.z_prev           z_k (state before step)
 * @param {number[]} arg.signal           g_k
 * @param {object}   arg.policy           merged policy used by engine.step()
 * @param {object}   [arg.result]         engine.step() return value, if known
 * @param {string}   [arg.run_id]         join key; auto-generated if missing
 * @param {object}   [arg.anchor_meta]    optional {fingerprint, dim, source}
 * @param {string}   [arg.fluxRoot]       overrides DEFAULT_FLUX_ROOT
 * @param {number}   [arg.ts]             record timestamp (ms epoch)
 * @returns {object}                      the written record (with sha256)
 */
export function appendSpiralStep({
  k,
  z_0,
  z_prev,
  signal,
  policy,
  result,
  run_id,
  anchor_meta,
  fluxRoot = DEFAULT_FLUX_ROOT,
  ts,
}) {
  if (!Array.isArray(z_0)) throw new TypeError("appendSpiralStep: z_0 must be an array");
  if (!Array.isArray(z_prev)) throw new TypeError("appendSpiralStep: z_prev must be an array");
  if (!Array.isArray(signal)) throw new TypeError("appendSpiralStep: signal must be an array");
  if (z_0.length !== z_prev.length || z_0.length !== signal.length) {
    throw new RangeError(
      `appendSpiralStep: dimension mismatch (z_0=${z_0.length}, z_prev=${z_prev.length}, signal=${signal.length})`,
    );
  }
  if (!Number.isInteger(k) || k < 0) {
    throw new RangeError(`appendSpiralStep: k must be a non-negative integer, got ${k}`);
  }

  // If no engine result was provided, run the step ourselves so the audit log
  // never asserts numbers we did not compute. Mom's Law: no theater.
  const engineResult = result ?? step(z_prev, signal, { ...policy, z_0 });

  const sig = signalSummary(signal);
  const { par_norm, ort_norm } = decomposeAgainstRadial(z_prev, z_0, signal);

  const event = {
    kind: KIND_STEP,
    k,
    r: sanitizeNumber(engineResult.r) ?? 0,
    r_prev: sanitizeNumber(engineResult.r_prev) ?? 0,
    delta_r: sanitizeNumber(engineResult.delta_r) ?? 0,
    alpha: sanitizeNumber(engineResult.alpha) ?? 0,
    delta_theta: sanitizeNumber(engineResult.delta_theta) ?? 0,
    confidence: sanitizeNumber(engineResult.confidence) ?? 0,
    degenerate: !!engineResult.degenerate,
    signal: {
      norm: sig.norm,
      dim: sig.dim,
      par_norm,
      ort_norm,
    },
    policy: compactPolicy(policy),
    anchor: anchorFromZ0(z_0, anchor_meta),
    run_id: run_id ?? newRunId(),
  };

  if (event.degenerate) {
    event.degenerate_reason =
      sig.norm < (policy?.epsilon ?? DEFAULT_POLICY.epsilon)
        ? "signal_norm_below_epsilon"
        : "orthogonal_below_ort_epsilon";
  }

  return writeFluxRecord({
    lane: SPIRAL_LANE,
    origin: SPIRAL_ORIGIN,
    event,
    fluxRoot,
    ts,
  });
}

// ---------------------------------------------------------------------------
// Public API: open a run (header) and close a run (summary)

/**
 * Append a run-open header. Returns the record (incl. assigned run_id).
 *
 * @param {object} arg
 * @param {number[]} arg.z_0
 * @param {object}   arg.policy
 * @param {string}   [arg.run_id]
 * @param {object}   [arg.anchor_meta]
 * @param {object}   [arg.context]    free-form caller metadata (cwd, task, etc.)
 * @param {string}   [arg.fluxRoot]
 * @param {number}   [arg.ts]
 * @returns {{ record: object, run_id: string }}
 */
export function appendSpiralRunOpen({
  z_0,
  policy,
  run_id,
  anchor_meta,
  context,
  fluxRoot = DEFAULT_FLUX_ROOT,
  ts,
}) {
  if (!Array.isArray(z_0)) throw new TypeError("appendSpiralRunOpen: z_0 must be an array");
  const id = run_id ?? newRunId();
  const event = {
    kind: KIND_OPEN,
    run_id: id,
    started_at_iso: new Date(ts ?? Date.now()).toISOString(),
    anchor: anchorFromZ0(z_0, anchor_meta),
    policy: compactPolicy(policy),
    doctrine: {
      disclosure_id: DOCTRINE.disclosure_id,
      rule: DOCTRINE.rule,
      constraints: [...DOCTRINE.constraints],
      paper: DOCTRINE.paper,
      integration_doctrine_path: DOCTRINE.integration_doctrine_path,
    },
    context: context ?? null,
  };
  const record = writeFluxRecord({
    lane: SPIRAL_LANE,
    origin: SPIRAL_ORIGIN,
    event,
    fluxRoot,
    ts,
  });
  return { record, run_id: id };
}

/**
 * Append a run-close footer with the trajectory summary.
 *
 * @param {object} arg
 * @param {string} arg.run_id
 * @param {object} arg.summary       { steps, total_radial, max_alpha, degenerate_count, final_radius }
 * @param {string} [arg.fluxRoot]
 * @param {number} [arg.ts]
 * @returns {object}
 */
export function appendSpiralRunClose({
  run_id,
  summary,
  fluxRoot = DEFAULT_FLUX_ROOT,
  ts,
}) {
  if (!run_id) throw new TypeError("appendSpiralRunClose: run_id required");
  if (!summary || typeof summary !== "object") {
    throw new TypeError("appendSpiralRunClose: summary object required");
  }
  const event = {
    kind: KIND_CLOSE,
    run_id,
    ended_at_iso: new Date(ts ?? Date.now()).toISOString(),
    summary: {
      steps: sanitizeNumber(summary.steps) ?? 0,
      total_radial: sanitizeNumber(summary.total_radial) ?? 0,
      max_alpha: sanitizeNumber(summary.max_alpha) ?? 0,
      degenerate_count: sanitizeNumber(summary.degenerate_count) ?? 0,
      final_radius: sanitizeNumber(summary.final_radius) ?? 0,
    },
  };
  return writeFluxRecord({
    lane: SPIRAL_LANE,
    origin: SPIRAL_ORIGIN,
    event,
    fluxRoot,
    ts,
  });
}

// ---------------------------------------------------------------------------
// Public API: wrap engine.step so callers cannot accidentally bypass the audit

/**
 * Drop-in replacement for engine.step that also writes one audit record.
 *
 * @param {number[]} z_k
 * @param {number[]} signal
 * @param {object}   policy   must carry z_0
 * @param {object}   [opts]
 * @param {number}   [opts.k=0]              step index for the audit record
 * @param {string}   [opts.run_id]
 * @param {object}   [opts.anchor_meta]
 * @param {string}   [opts.fluxRoot]
 * @returns {{ result: object, record: object }}
 */
export function auditedStep(z_k, signal, policy, opts = {}) {
  if (!policy || !Array.isArray(policy.z_0)) {
    throw new TypeError("auditedStep: policy.z_0 required");
  }
  const result = step(z_k, signal, policy);
  const record = appendSpiralStep({
    k: opts.k ?? 0,
    z_0: policy.z_0,
    z_prev: z_k,
    signal,
    policy,
    result,
    run_id: opts.run_id,
    anchor_meta: opts.anchor_meta,
    fluxRoot: opts.fluxRoot,
  });
  return { result, record };
}

// ---------------------------------------------------------------------------
// Public API: walk a trajectory with full open/step.../close audit logging

/**
 * Walk a sequence of signals from z_0 and emit a complete audit trail:
 *   1 spiral_run_open
 *   N spiral_step  (one per signal)
 *   1 spiral_run_close
 *
 * @param {object}     arg
 * @param {number[]}   arg.z_0
 * @param {number[][]} arg.signals
 * @param {object}     [arg.policy]
 * @param {object}     [arg.anchor_meta]
 * @param {object}     [arg.context]
 * @param {string}     [arg.fluxRoot]
 * @param {string}     [arg.run_id]
 * @returns {{
 *   trajectory: {
 *     path: number[][],
 *     final: number[],
 *     audit: object[],
 *     total_radial: number,
 *     max_alpha: number,
 *     steps: number,
 *     degenerate_count: number,
 *   },
 *   run_id: string,
 *   open: object,
 *   close: object,
 *   step_records: object[],
 * }}
 */
export function runWithAudit({
  z_0,
  signals,
  policy = {},
  anchor_meta,
  context,
  fluxRoot = DEFAULT_FLUX_ROOT,
  run_id,
}) {
  if (!Array.isArray(z_0)) throw new TypeError("runWithAudit: z_0 must be an array");
  if (!Array.isArray(signals)) throw new TypeError("runWithAudit: signals must be an array");

  const startTs = Date.now();
  const { record: open, run_id: id } = appendSpiralRunOpen({
    z_0,
    policy,
    run_id,
    anchor_meta,
    context,
    fluxRoot,
    ts: startTs,
  });

  // Walk the trajectory step by step so each record matches the exact engine
  // result for that step (rather than re-deriving from a final path, which
  // could drift if the policy is non-deterministic).
  const pol = { ...DEFAULT_POLICY, ...policy, z_0 };
  let z = z_0.slice();
  const audit = [];
  const step_records = [];
  let total_radial = 0;
  let max_alpha = 0;
  let degenerate_count = 0;
  const path = [z.slice()];

  for (let i = 0; i < signals.length; i++) {
    const result = step(z, signals[i], pol);
    const record = appendSpiralStep({
      k: i,
      z_0,
      z_prev: z,
      signal: signals[i],
      policy: pol,
      result,
      run_id: id,
      anchor_meta,
      fluxRoot,
    });
    step_records.push(record);
    audit.push({
      k: i,
      r: result.r,
      delta_r: result.delta_r,
      alpha: result.alpha,
      delta_theta: result.delta_theta,
      confidence: result.confidence,
      degenerate: result.degenerate,
    });
    z = result.z_next;
    path.push(z.slice());
    total_radial += Math.abs(result.delta_r);
    if (result.alpha > max_alpha) max_alpha = result.alpha;
    if (result.degenerate) degenerate_count++;
  }

  // Final radius for the close summary (||z_N - z_0||).
  let r2 = 0;
  for (let i = 0; i < z.length; i++) {
    const d = z[i] - z_0[i];
    r2 += d * d;
  }
  const final_radius = Math.sqrt(r2);

  const close = appendSpiralRunClose({
    run_id: id,
    summary: {
      steps: signals.length,
      total_radial,
      max_alpha,
      degenerate_count,
      final_radius,
    },
    fluxRoot,
    ts: Date.now(),
  });

  return {
    trajectory: {
      path,
      final: z,
      audit,
      total_radial,
      max_alpha,
      steps: signals.length,
      degenerate_count,
    },
    run_id: id,
    open,
    close,
    step_records,
  };
}

// ---------------------------------------------------------------------------
// Chain verifier — recompute every sha256 + prior_sha256 link for a given
// per-date file. O(n). Useful for "show me the chain is sound" receipts.

/**
 * Verify the prior_sha256 chain for a per-date file.
 *
 * @param {object} arg
 * @param {string} [arg.lane="thought"]
 * @param {string} [arg.fluxRoot]
 * @param {string} [arg.date]                 default = today (UTC)
 * @returns {{ok:boolean, count:number, broken:Array<{idx:number,reason:string}>, tailSha:string, path:string}}
 */
function verifyLegacyChain({
  lane = SPIRAL_LANE,
  fluxRoot = DEFAULT_FLUX_ROOT,
  date = isoDate(),
} = {}) {
  const file = lanePath(fluxRoot, lane, date);
  if (!existsSync(file)) {
    return { ok: true, count: 0, broken: [], tailSha: GENESIS, path: file };
  }
  const data = readFileSync(file, "utf8");
  const torn = !data.endsWith("\n") && data.length > 0;
  const completePart = torn ? data.slice(0, data.lastIndexOf("\n") + 1) : data;
  const lines = completePart.split("\n").filter(Boolean);
  const broken = [];

  // Chain head: pick up the tail of the most-recent earlier per-date file.
  let priorSha = GENESIS;
  const dir = laneDir(fluxRoot, lane);
  if (existsSync(dir)) {
    const earlier = readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f < `${date}.jsonl`)
      .sort();
    if (earlier.length > 0) {
      const prevTail = readLastLine(join(dir, earlier[earlier.length - 1]));
      if (prevTail) {
        try {
          const rec = JSON.parse(prevTail);
          if (rec && typeof rec.sha256 === "string") priorSha = rec.sha256;
        } catch {
          // leave priorSha at GENESIS — chain integrity will report it
        }
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      broken.push({ idx: i, reason: "parse error" });
      break;
    }
    if (rec.prior_sha256 !== priorSha) {
      broken.push({
        idx: i,
        reason: `prior_sha256 mismatch: expected ${priorSha}, got ${rec.prior_sha256}`,
      });
      break;
    }
    let expected;
    try {
      expected = computeRecordHash(rec.prior_sha256, rec.event);
    } catch (e) {
      broken.push({ idx: i, reason: `canonical encode failed: ${e.message}` });
      break;
    }
    if (rec.sha256 !== expected) {
      broken.push({ idx: i, reason: `sha256 mismatch at line ${i}` });
      break;
    }
    priorSha = rec.sha256;
  }

  return {
    ok: broken.length === 0 && !torn,
    count: lines.length,
    broken,
    tailSha: priorSha,
    path: file,
  };
}

export function verifyChain({
  lane = SPIRAL_LANE,
  fluxRoot = DEFAULT_FLUX_ROOT,
  date = isoDate(),
} = {}) {
  const dir = laneDir(fluxRoot, lane);
  const latest = existsSync(dir)
    ? readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().at(-1)
    : null;
  const result = verifyCobraChain({ lane, fluxRoot });
  return { ...result, path: latest ? join(dir, latest) : lanePath(fluxRoot, lane, date) };
}

// ---------------------------------------------------------------------------
// Internals exposed for tests; intentionally narrow.

export const __internals = Object.freeze({
  canonicalJSON,
  computeRecordHash,
  decomposeAgainstRadial,
  signalSummary,
  compactPolicy,
  anchorFromZ0,
  fingerprintVec,
  newRunId,
  priorShaFor,
  lanePath,
  laneDir,
  sanitizeNumber,
  readLastLine,
  recordHashValid: cobraWriterInternals.recordHashValid,
  verifyLegacyChain,
});

// ---------------------------------------------------------------------------
// CLI: `node audit.mjs <fluxRoot?> <steps?>` — synthesize a small trajectory
// against a deterministic anchor and write the full open/step.../close trail.
// Useful as a smoke test against a live /mnt/ae_flux mount. Receipts only.

const isMain =
  import.meta.url.startsWith("file:") &&
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const fluxRoot = process.argv[2] || DEFAULT_FLUX_ROOT;
  const steps = Math.max(1, parseInt(process.argv[3] || "3", 10) || 3);

  // Tiny 4-dim deterministic anchor + signals so the smoke test is reproducible.
  const z_0 = [0.1, -0.2, 0.3, -0.4];
  const signals = [];
  for (let i = 0; i < steps; i++) {
    signals.push([
      Math.cos(i + 1) * 0.5,
      Math.sin(i + 1) * 0.5,
      0.1,
      -0.1,
    ]);
  }

  try {
    const { run_id, trajectory, open, close, step_records } = runWithAudit({
      z_0,
      signals,
      policy: { alpha_max: Math.PI / 4, beta: 0.5 },
      context: { source: "audit.mjs CLI smoke" },
      fluxRoot,
    });

    const chain = verifyChain({ fluxRoot });

    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          run_id,
          fluxRoot,
          path: chain.path,
          wrote: {
            open: open.sha256,
            steps: step_records.map((r) => r.sha256),
            close: close.sha256,
          },
          summary: {
            steps: trajectory.steps,
            total_radial: trajectory.total_radial,
            max_alpha: trajectory.max_alpha,
            degenerate_count: trajectory.degenerate_count,
          },
          chain: { ok: chain.ok, count: chain.count, tailSha: chain.tailSha },
          doctrine: {
            disclosure_id: DOCTRINE.disclosure_id,
            rule: DOCTRINE.rule,
            integration_doctrine_path: DOCTRINE.integration_doctrine_path,
          },
        },
        null,
        2,
      ) + "\n",
    );
  } catch (err) {
    process.stderr.write(
      JSON.stringify({ ok: false, error: err.message, stack: err.stack }, null, 2) + "\n",
    );
    process.exit(1);
  }
}
