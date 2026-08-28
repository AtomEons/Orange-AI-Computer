// AE OrangeLLM — Spiral Reasoning gateway routes (/v1/spiral/*)
// Path: 06-ORANGELLM/server/routes/spiral.mjs
//
// Doctrine (Atom McCree, ATOM-SPIRAL-INTEGRATION-v1-2026-0618):
//
//   The Spiral-of-Thought (SoT) update rule is the canonical reasoning
//   primitive for any iterative multi-step thinking Orange5 does. From the
//   manuscript:
//
//     u_t = (z_t - z_0) / ||z_t - z_0||                    (radial unit)
//     g_t^∥ = (g_t · u_t) · u_t                            (radial component)
//     g_t^⊥ = g_t - g_t^∥                                  (orthogonal comp)
//     v_t = g_t^⊥ / ||g_t^⊥||                              (orthogonal unit)
//     Δθ_t = α · tanh(||g_t^⊥|| / ||g_t||)                 (Belief Discipline)
//     r_t = ||z_t - z_0||
//     z_{t+1} = z_0 + r_t · exp(β·Δθ_t) ·
//                 ( cos(Δθ_t)·u_t + sin(Δθ_t)·v_t )        (closed-form spiral)
//
//   - z_0 is the Soul Genome anchor (substrate identity at ignition).
//   - α (alpha) bounds Δθ_t — Belief Discipline. Default α = 0.25 rad.
//   - β (beta) couples LEARN to turn: radius grows only when the substrate
//     authentically turns. Default β = 0.05 per rad.
//   - Graceful degeneration (Proposition 3 of the paper): when
//     ||g_t^⊥|| < epsilon OR r_t < epsilon, there is no genuine orthogonal
//     novelty — we DO NOT invent curvature. We fall back to a small linear
//     step z_{t+1} = z_t + linear_step · ĝ_t. "No curvature without signal."
//
//   z_0 is derived from canonical Soul Genome identity fields by a
//   deterministic SHA-256 → Gaussian → normalize pipeline. The Soul Genome
//   itself is NEVER mutated by these routes. Anchor pulls are read-only.
//
//   Mom's Law applies. Every step that returns is also written to the
//   append-only audit log at 10-RECEIPTS/spiral-audit/spiral-audit.jsonl.
//   No theater 200s. Bad input → structured 400. Real numerics only:
//   NaN / Infinity / non-finite vectors are rejected, never silently
//   coerced.
//
// Endpoints (all under /v1/spiral/):
//
//   POST /v1/spiral/anchor
//     body:   { dim?: 64, salt?: "string" }
//     ->      200 { ok:true, data:{ z_0:[..], dim, anchor_hash, source } }
//             400 invalid_request, 503 soul_genome_unreachable
//
//   POST /v1/spiral/step
//     body:   { z_t:[..], z_0?:[..], g_t:[..], alpha?:0.25, beta?:0.05,
//               epsilon?:1e-9, linear_step?:1e-3, step_index?:0,
//               trajectory_id?:"string" }
//     ->      200 { ok:true, data:{ z_next, delta_theta, r_t, r_next,
//                                   orth_norm, total_norm, mode, ... } }
//             400 invalid_request
//
//   POST /v1/spiral/trajectory
//     body:   { z_0?:[..], z_init?:[..], signals:[ [..], [..], ... ],
//               alpha?, beta?, epsilon?, linear_step?, trajectory_id? }
//     ->      200 { ok:true, data:{ trajectory_id, steps:[ ... ], summary } }
//             400 invalid_request
//
//   GET  /v1/spiral/audit?since=<ISO|epoch_ms>&limit=<N>&trajectory_id=<id>
//     ->      200 { ok:true, data:{ count, since, items:[ ... ] } }
//             400 invalid_request
//
//   The boundary allow-list lives in ./spiral-boundary.mjs.

import { URL } from "node:url";
import { createHash, createHmac } from "node:crypto";
import { readFile, appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SPIRAL_PATH_PREFIX,
  SPIRAL_ANCHOR_PATH,
  SPIRAL_STEP_PATH,
  SPIRAL_TRAJECTORY_PATH,
  SPIRAL_AUDIT_PATH,
  isSpiralPath,
  isSpiralRouteAllowed,
  SPIRAL_ALLOWED,
} from "./spiral-boundary.mjs";

export {
  SPIRAL_PATH_PREFIX,
  SPIRAL_ANCHOR_PATH,
  SPIRAL_STEP_PATH,
  SPIRAL_TRAJECTORY_PATH,
  SPIRAL_AUDIT_PATH,
  isSpiralPath,
  isSpiralRouteAllowed,
  SPIRAL_ALLOWED,
};

// ---------------------------------------------------------------------------
// Module-local paths
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

// 06-ORANGELLM/server/routes/  ->  Orange5/13-MODELS/orange-llm/soul_genome.json
const DEFAULT_SOUL_GENOME_PATH = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "13-MODELS",
  "orange-llm",
  "soul_genome.json",
);

// 06-ORANGELLM/server/routes/  ->  Orange5/10-RECEIPTS/spiral-audit/spiral-audit.jsonl
const DEFAULT_AUDIT_DIR = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "10-RECEIPTS",
  "spiral-audit",
);
const DEFAULT_AUDIT_PATH = join(DEFAULT_AUDIT_DIR, "spiral-audit.jsonl");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB — trajectories can carry many signals
const MAX_DIM = 4096;
const MIN_DIM = 2;
const DEFAULT_DIM = 64;
const MAX_SIGNALS_PER_TRAJECTORY = 4096;
const MAX_AUDIT_ITEMS = 10_000;
const DEFAULT_AUDIT_LIMIT = 200;

const DEFAULT_ALPHA = 0.25; // Belief Discipline ceiling (radians/step)
const DEFAULT_BETA = 0.05; // LEARN coupling (radial growth per radian of turn)
const DEFAULT_EPSILON = 1e-9;
const DEFAULT_LINEAR_STEP = 1e-3;

// Hard upper bounds — refuse to operate beyond these (Mom's Law: no theater).
const MAX_ALPHA = Math.PI; // half-turn per step is the hard ceiling
const MAX_BETA = 4.0; // a single step cannot more than e^4 ≈ 54x the radius
const MAX_LINEAR_STEP = 1.0;

// ---------------------------------------------------------------------------
// HTTP shape helpers
// ---------------------------------------------------------------------------

function jsonResponse(res, body, status = 200) {
  if (res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function errorBody(message, status = 400, code = "invalid_request_error", extra = {}) {
  return {
    ok: false,
    error: {
      message,
      type: code,
      code: status,
      ...extra,
    },
  };
}

function errorResponse(res, message, status = 400, code = "invalid_request_error", extra = {}) {
  jsonResponse(res, errorBody(message, status, code, extra), status);
}

async function readJsonBody(req, capBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > capBytes) {
        req.destroy();
        reject(new Error(`request body exceeds ${capBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const buf = Buffer.concat(chunks);
      if (!buf.length) return resolve({});
      try {
        const parsed = JSON.parse(buf.toString("utf8"));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(new Error("body must be a JSON object"));
          return;
        }
        resolve(parsed);
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Numeric helpers (real math, no fakes)
// ---------------------------------------------------------------------------

function isFiniteNumber(x) {
  return typeof x === "number" && Number.isFinite(x);
}

function isFiniteVector(v) {
  if (!Array.isArray(v) || v.length === 0) return false;
  for (let i = 0; i < v.length; i++) {
    if (!isFiniteNumber(v[i])) return false;
  }
  return true;
}

function vectorDim(v) {
  return Array.isArray(v) ? v.length : 0;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function norm(v) {
  return Math.sqrt(dot(v, v));
}

function add(a, b) {
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + b[i];
  return out;
}

function sub(a, b) {
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] - b[i];
  return out;
}

function scale(v, s) {
  const out = new Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] * s;
  return out;
}

/**
 * Deterministic Gaussian sampler seeded by a SHA-256 stream from `seedHex`.
 * Produces `count` floats by box-muller from a uniform-on-(0,1) sequence
 * derived from sequential HMAC-SHA-256 blocks of the seed. Same seed →
 * same vector, byte-for-byte. No PRNG state leaks across calls.
 */
function deterministicGaussianVector(seedBytes, count) {
  // Build a stream of 64-bit unsigned integers from HMAC(key=seedBytes, msg=ctr).
  // Convert to uniform (0,1) by dividing by 2^64.
  const out = new Array(count);
  let writeIdx = 0;
  let ctr = 0;
  // We need pairs of uniforms per box-muller. Generate as needed.
  let pending = null;

  function nextUniformPair() {
    // HMAC produces 32 bytes; we use the first 16 as two uint64 little-endian.
    const msg = Buffer.alloc(8);
    msg.writeBigUInt64BE(BigInt(ctr++), 0);
    const h = createHmac("sha256", seedBytes).update(msg).digest();
    // Treat first 8 bytes as u0, next 8 as u1.
    const u0_raw = h.readBigUInt64BE(0);
    const u1_raw = h.readBigUInt64BE(8);
    // Map to (0, 1) — avoid exactly 0.
    const denom = 18446744073709551616n; // 2^64
    let u0 = Number(u0_raw) / Number(denom);
    let u1 = Number(u1_raw) / Number(denom);
    if (u0 <= 0) u0 = 1e-300;
    if (u1 <= 0) u1 = 1e-300;
    return [u0, u1];
  }

  while (writeIdx < count) {
    if (pending !== null) {
      out[writeIdx++] = pending;
      pending = null;
      continue;
    }
    const [u0, u1] = nextUniformPair();
    // Box-Muller: produces two independent N(0,1) samples.
    const mag = Math.sqrt(-2.0 * Math.log(u0));
    const z0 = mag * Math.cos(2 * Math.PI * u1);
    const z1 = mag * Math.sin(2 * Math.PI * u1);
    out[writeIdx++] = z0;
    if (writeIdx < count) {
      out[writeIdx++] = z1;
    } else {
      pending = z1;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Soul Genome anchor derivation
// ---------------------------------------------------------------------------

/**
 * Pull a deterministic identity-anchor vector z_0 from the Soul Genome.
 *
 * Strategy:
 *   1. Read soul_genome.json.
 *   2. Extract a canonical, stable identity payload (sovereign.name,
 *      sovereign.alias, sovereign.email, sovereign.lab_name,
 *      active_project.name, active_project.charter_id, schema_id).
 *      These are the fields the doctrine treats as "who the substrate
 *      is at first ignition." Mutable fields (current_intent, blockers,
 *      receipts pointers) are deliberately excluded so the anchor does
 *      not drift on every Soul Genome update.
 *   3. SHA-256(canonical JSON of payload || ":" || optional_salt) -> 32 bytes.
 *   4. Seed a deterministic Gaussian stream → `dim` samples.
 *   5. Normalize to unit length, then scale to `||z_0|| = sqrt(dim)`
 *      so that per-coordinate variance is ~1 (Gaussian-prior convention,
 *      keeps downstream r_t comparable to a "natural" identity radius).
 *
 *   This makes z_0 byte-deterministic for a given (Soul Genome canonical
 *   payload, dim, salt) triple. Different sovereigns get different anchors.
 *   Same sovereign across machines gets the same anchor.
 */
export async function deriveAnchorFromSoulGenome(opts = {}) {
  const path = opts.soulGenomePath || DEFAULT_SOUL_GENOME_PATH;
  const dim = Number.isInteger(opts.dim) ? opts.dim : DEFAULT_DIM;
  const salt = typeof opts.salt === "string" ? opts.salt : "";

  if (dim < MIN_DIM || dim > MAX_DIM) {
    throw new Error(`dim out of range [${MIN_DIM}, ${MAX_DIM}]: got ${dim}`);
  }

  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    const reason = err && err.message ? err.message : String(err);
    const e = new Error(
      `Soul Genome unreachable at ${path}: ${reason}. ` +
        `Refusing to mint a synthetic anchor — Mom's Law (no fake-green).`,
    );
    e.code = "soul_genome_unreachable";
    e.detail = { path, reason };
    throw e;
  }

  let genome;
  try {
    genome = JSON.parse(raw);
  } catch (err) {
    const e = new Error(
      `Soul Genome at ${path} is not valid JSON: ${err && err.message ? err.message : err}`,
    );
    e.code = "soul_genome_invalid";
    e.detail = { path };
    throw e;
  }

  // Canonical identity payload — stable across Soul Genome edits to
  // non-identity fields. Missing fields collapse to empty strings so a
  // partially-populated genome still yields a deterministic anchor (with
  // a clear `source.missing_fields` audit trail).
  const sov = (genome && genome.sovereign) || {};
  const proj = (genome && genome.active_project) || {};
  const identityPayload = {
    schema_id: typeof genome.schema_id === "string" ? genome.schema_id : "",
    sovereign_name: typeof sov.name === "string" ? sov.name : "",
    sovereign_alias: typeof sov.alias === "string" ? sov.alias : "",
    sovereign_email: typeof sov.email === "string" ? sov.email : "",
    sovereign_lab_name: typeof sov.lab_name === "string" ? sov.lab_name : "",
    project_name: typeof proj.name === "string" ? proj.name : "",
    project_charter_id: typeof proj.charter_id === "string" ? proj.charter_id : "",
  };
  const missingFields = Object.entries(identityPayload)
    .filter(([, v]) => v === "")
    .map(([k]) => k);

  // Canonical JSON: sorted keys, no whitespace, UTF-8. SHA-256 then HMAC
  // with that hash as the key to seed the Gaussian stream.
  const canonical = JSON.stringify(identityPayload, Object.keys(identityPayload).sort());
  const seedMaterial = `${canonical}:${salt}`;
  const anchorHash = createHash("sha256").update(seedMaterial, "utf8").digest();
  const anchorHashHex = anchorHash.toString("hex");

  const samples = deterministicGaussianVector(anchorHash, dim);

  // Normalize, then scale to ||z_0|| = sqrt(dim).
  const n = norm(samples);
  if (!isFiniteNumber(n) || n === 0) {
    // Astronomically unlikely from a Gaussian sampler, but Mom's Law:
    // never return a degenerate anchor.
    const e = new Error("derived anchor has zero norm; refusing to return degenerate z_0");
    e.code = "anchor_degenerate";
    throw e;
  }
  const targetRadius = Math.sqrt(dim);
  const z0 = scale(samples, targetRadius / n);

  return {
    z_0: z0,
    dim,
    anchor_hash: anchorHashHex,
    source: {
      soul_genome_path: path,
      schema_id: identityPayload.schema_id,
      missing_fields: missingFields,
      salt: salt.length > 0 ? `[provided, len=${salt.length}]` : "[none]",
      target_radius: targetRadius,
    },
  };
}

// ---------------------------------------------------------------------------
// SoT update — single step
// ---------------------------------------------------------------------------

/**
 * Compute one Spiral-of-Thought update.
 *
 * Returns:
 *   {
 *     z_next: number[],
 *     r_t: number,
 *     r_next: number,
 *     delta_theta: number,
 *     orth_norm: number,
 *     total_norm: number,
 *     u_t: number[]|null,
 *     v_t: number[]|null,
 *     mode: "spiral"|"linear_fallback"|"identity_origin",
 *     fallback_reason?: string,
 *     alpha, beta, epsilon, linear_step
 *   }
 *
 * Graceful degeneration (Proposition 3):
 *   - If r_t < epsilon (we are AT identity origin): linear step in direction
 *     of g_t. We cannot define a radial direction yet.
 *   - If ||g_t|| < epsilon: identity step (z_next = z_t). No signal, no motion.
 *     This is the BREATHE imperative — emit a receipt, do not invent motion.
 *   - If ||g_t^⊥|| < epsilon: linear step along g_t (no genuine novelty,
 *     no curvature). "No curvature without signal."
 *   - Else: full SoT spiral update.
 */
export function spiralStep({
  z_t,
  z_0,
  g_t,
  alpha = DEFAULT_ALPHA,
  beta = DEFAULT_BETA,
  epsilon = DEFAULT_EPSILON,
  linear_step = DEFAULT_LINEAR_STEP,
}) {
  // Shape checks — caller is expected to have validated, but defense in depth.
  if (!isFiniteVector(z_t) || !isFiniteVector(z_0) || !isFiniteVector(g_t)) {
    throw new Error("z_t, z_0, g_t must be finite numeric vectors");
  }
  if (z_t.length !== z_0.length || z_t.length !== g_t.length) {
    throw new Error(
      `vector dimension mismatch: z_t=${z_t.length}, z_0=${z_0.length}, g_t=${g_t.length}`,
    );
  }
  if (!isFiniteNumber(alpha) || alpha <= 0 || alpha > MAX_ALPHA) {
    throw new Error(`alpha must be a finite number in (0, ${MAX_ALPHA}]`);
  }
  if (!isFiniteNumber(beta) || beta < 0 || beta > MAX_BETA) {
    throw new Error(`beta must be a finite number in [0, ${MAX_BETA}]`);
  }
  if (!isFiniteNumber(epsilon) || epsilon <= 0) {
    throw new Error("epsilon must be a positive finite number");
  }
  if (!isFiniteNumber(linear_step) || linear_step <= 0 || linear_step > MAX_LINEAR_STEP) {
    throw new Error(`linear_step must be in (0, ${MAX_LINEAR_STEP}]`);
  }

  const radialDisplacement = sub(z_t, z_0);
  const r_t = norm(radialDisplacement);
  const totalNorm = norm(g_t);

  // Case A: ||g_t|| ≈ 0  →  BREATHE imperative (no signal, no motion).
  if (totalNorm < epsilon) {
    return {
      z_next: z_t.slice(),
      r_t,
      r_next: r_t,
      delta_theta: 0,
      orth_norm: 0,
      total_norm: totalNorm,
      u_t: null,
      v_t: null,
      mode: "identity_origin",
      fallback_reason: "signal_below_epsilon",
      alpha,
      beta,
      epsilon,
      linear_step,
    };
  }

  // Case B: r_t < epsilon  →  we are at z_0, no radial direction defined.
  // Take a small linear step along ĝ_t to escape the singularity honestly.
  if (r_t < epsilon) {
    const ghat = scale(g_t, 1 / totalNorm);
    return {
      z_next: add(z_t, scale(ghat, linear_step)),
      r_t,
      r_next: linear_step,
      delta_theta: 0,
      orth_norm: 0,
      total_norm: totalNorm,
      u_t: null,
      v_t: null,
      mode: "linear_fallback",
      fallback_reason: "at_identity_origin",
      alpha,
      beta,
      epsilon,
      linear_step,
    };
  }

  // Radial unit u_t.
  const u_t = scale(radialDisplacement, 1 / r_t);

  // Decompose g_t into radial and orthogonal components.
  const radialAmt = dot(g_t, u_t);
  const g_parallel = scale(u_t, radialAmt);
  const g_orth = sub(g_t, g_parallel);
  const orthNorm = norm(g_orth);

  // Case C: ||g_t^⊥|| ≈ 0  →  no genuine novelty. Linear step, no curvature.
  if (orthNorm < epsilon) {
    const ghat = scale(g_t, 1 / totalNorm);
    return {
      z_next: add(z_t, scale(ghat, linear_step)),
      r_t,
      r_next: norm(sub(add(z_t, scale(ghat, linear_step)), z_0)),
      delta_theta: 0,
      orth_norm: orthNorm,
      total_norm: totalNorm,
      u_t,
      v_t: null,
      mode: "linear_fallback",
      fallback_reason: "no_orthogonal_signal",
      alpha,
      beta,
      epsilon,
      linear_step,
    };
  }

  // Case D: full SoT spiral update.
  const v_t = scale(g_orth, 1 / orthNorm);
  const deltaTheta = alpha * Math.tanh(orthNorm / totalNorm);

  const radiusGrowth = Math.exp(beta * deltaTheta);
  const r_next = r_t * radiusGrowth;

  const cosTheta = Math.cos(deltaTheta);
  const sinTheta = Math.sin(deltaTheta);

  // z_{t+1} = z_0 + r_next * (cos·u_t + sin·v_t)
  const turned = add(scale(u_t, cosTheta), scale(v_t, sinTheta));
  const z_next = add(z_0, scale(turned, r_next));

  return {
    z_next,
    r_t,
    r_next,
    delta_theta: deltaTheta,
    orth_norm: orthNorm,
    total_norm: totalNorm,
    u_t,
    v_t,
    mode: "spiral",
    alpha,
    beta,
    epsilon,
    linear_step,
  };
}

// ---------------------------------------------------------------------------
// SoT trajectory — many steps
// ---------------------------------------------------------------------------

/**
 * Compute a full trajectory from an initial state and an array of signals.
 * Each signal is the g_t for that step; z_t is the result of the previous
 * step (z_init for the first).
 */
export function spiralTrajectory({
  z_0,
  z_init,
  signals,
  alpha = DEFAULT_ALPHA,
  beta = DEFAULT_BETA,
  epsilon = DEFAULT_EPSILON,
  linear_step = DEFAULT_LINEAR_STEP,
}) {
  if (!isFiniteVector(z_0)) throw new Error("z_0 must be a finite numeric vector");
  if (!isFiniteVector(z_init)) throw new Error("z_init must be a finite numeric vector");
  if (z_0.length !== z_init.length) {
    throw new Error(`z_0 and z_init dim mismatch: ${z_0.length} vs ${z_init.length}`);
  }
  if (!Array.isArray(signals) || signals.length === 0) {
    throw new Error("signals must be a non-empty array");
  }
  if (signals.length > MAX_SIGNALS_PER_TRAJECTORY) {
    throw new Error(
      `signals length ${signals.length} exceeds cap ${MAX_SIGNALS_PER_TRAJECTORY}`,
    );
  }
  for (let i = 0; i < signals.length; i++) {
    if (!isFiniteVector(signals[i])) {
      throw new Error(`signals[${i}] must be a finite numeric vector`);
    }
    if (signals[i].length !== z_0.length) {
      throw new Error(
        `signals[${i}] dim ${signals[i].length} does not match z_0 dim ${z_0.length}`,
      );
    }
  }

  const steps = [];
  let z_t = z_init.slice();
  let cumulativeAngle = 0;
  const modeCounts = { spiral: 0, linear_fallback: 0, identity_origin: 0 };

  for (let i = 0; i < signals.length; i++) {
    const out = spiralStep({
      z_t,
      z_0,
      g_t: signals[i],
      alpha,
      beta,
      epsilon,
      linear_step,
    });
    steps.push({
      index: i,
      z_t_in: z_t,
      z_next: out.z_next,
      r_t: out.r_t,
      r_next: out.r_next,
      delta_theta: out.delta_theta,
      orth_norm: out.orth_norm,
      total_norm: out.total_norm,
      mode: out.mode,
      ...(out.fallback_reason ? { fallback_reason: out.fallback_reason } : {}),
    });
    z_t = out.z_next;
    cumulativeAngle += Math.abs(out.delta_theta);
    modeCounts[out.mode] = (modeCounts[out.mode] || 0) + 1;
  }

  const r_final = norm(sub(z_t, z_0));
  return {
    steps,
    summary: {
      step_count: steps.length,
      cumulative_angle: cumulativeAngle,
      r_initial: norm(sub(z_init, z_0)),
      r_final,
      mode_counts: modeCounts,
      alpha,
      beta,
      epsilon,
      linear_step,
    },
    z_final: z_t,
  };
}

// ---------------------------------------------------------------------------
// Audit log (append-only JSONL)
// ---------------------------------------------------------------------------

let auditDirEnsured = false;

async function ensureAuditDir(auditPath) {
  if (auditDirEnsured) return;
  await mkdir(dirname(auditPath), { recursive: true });
  auditDirEnsured = true;
}

/**
 * Append one row to the audit JSONL. Each row is a structured envelope:
 *   { ts, event, trajectory_id?, step_index?, payload }
 *
 * Audit writes are best-effort and isolated: a write failure must NOT
 * cause the route to return failure, but it MUST be surfaced in the
 * response so the operator never sees a fake-green audit. Mom's Law.
 */
async function appendAudit(envelope, auditPath = DEFAULT_AUDIT_PATH) {
  try {
    await ensureAuditDir(auditPath);
    const line = JSON.stringify(envelope) + "\n";
    await appendFile(auditPath, line, "utf8");
    return { ok: true, path: auditPath };
  } catch (err) {
    return {
      ok: false,
      path: auditPath,
      error: err && err.message ? err.message : String(err),
    };
  }
}

/**
 * Read audit rows since a given cursor. Linear scan; the file is JSONL
 * and small enough that a streamed scan is fine for operator queries.
 * For very large logs the operator can rotate the file out-of-band and
 * pass `auditPath` to this function via the cfg.
 */
async function readAuditSince({
  since,
  limit = DEFAULT_AUDIT_LIMIT,
  trajectory_id = null,
  auditPath = DEFAULT_AUDIT_PATH,
}) {
  if (!existsSync(auditPath)) {
    return { items: [], count: 0, since_ms: parseSince(since), audit_path: auditPath, exists: false };
  }
  const sinceMs = parseSince(since);
  const raw = await readFile(auditPath, "utf8");
  const lines = raw.split("\n");
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    let env;
    try {
      env = JSON.parse(line);
    } catch {
      // Skip malformed lines but do not crash the audit read.
      continue;
    }
    if (!env || typeof env !== "object") continue;
    const tsMs =
      typeof env.ts === "number"
        ? env.ts
        : typeof env.ts === "string"
        ? Date.parse(env.ts)
        : NaN;
    if (Number.isFinite(sinceMs) && Number.isFinite(tsMs) && tsMs < sinceMs) continue;
    if (trajectory_id && env.trajectory_id !== trajectory_id) continue;
    items.push(env);
    if (items.length >= limit) break;
  }
  return {
    items,
    count: items.length,
    since_ms: sinceMs,
    audit_path: auditPath,
    exists: true,
  };
}

function parseSince(since) {
  if (since === undefined || since === null || since === "") return NaN;
  if (typeof since === "number" && Number.isFinite(since)) return since;
  if (typeof since === "string") {
    // Try epoch ms first, then ISO.
    if (/^\d+$/.test(since)) {
      const n = Number(since);
      if (Number.isFinite(n)) return n;
    }
    const p = Date.parse(since);
    if (Number.isFinite(p)) return p;
  }
  return NaN;
}

// ---------------------------------------------------------------------------
// Body validation
// ---------------------------------------------------------------------------

function validateAnchorBody(body) {
  const errors = [];
  if (body.dim !== undefined) {
    if (!Number.isInteger(body.dim) || body.dim < MIN_DIM || body.dim > MAX_DIM) {
      errors.push(`field 'dim' must be an integer in [${MIN_DIM}, ${MAX_DIM}]`);
    }
  }
  if (body.salt !== undefined && typeof body.salt !== "string") {
    errors.push("field 'salt' must be a string when present");
  }
  return errors;
}

function validateOptionalKnobs(body, errors) {
  if (body.alpha !== undefined && (!isFiniteNumber(body.alpha) || body.alpha <= 0 || body.alpha > MAX_ALPHA)) {
    errors.push(`field 'alpha' must be a finite number in (0, ${MAX_ALPHA}]`);
  }
  if (body.beta !== undefined && (!isFiniteNumber(body.beta) || body.beta < 0 || body.beta > MAX_BETA)) {
    errors.push(`field 'beta' must be a finite number in [0, ${MAX_BETA}]`);
  }
  if (body.epsilon !== undefined && (!isFiniteNumber(body.epsilon) || body.epsilon <= 0)) {
    errors.push("field 'epsilon' must be a positive finite number");
  }
  if (
    body.linear_step !== undefined &&
    (!isFiniteNumber(body.linear_step) || body.linear_step <= 0 || body.linear_step > MAX_LINEAR_STEP)
  ) {
    errors.push(`field 'linear_step' must be a finite number in (0, ${MAX_LINEAR_STEP}]`);
  }
}

function validateStepBody(body) {
  const errors = [];
  if (!isFiniteVector(body.z_t)) {
    errors.push("field 'z_t' is required and must be a finite numeric vector");
  }
  if (body.z_0 !== undefined && !isFiniteVector(body.z_0)) {
    errors.push("field 'z_0' must be a finite numeric vector when present");
  }
  if (!isFiniteVector(body.g_t)) {
    errors.push("field 'g_t' is required and must be a finite numeric vector");
  }
  if (errors.length === 0 && body.z_0) {
    if (body.z_t.length !== body.z_0.length) {
      errors.push(`'z_t' dim ${body.z_t.length} != 'z_0' dim ${body.z_0.length}`);
    }
    if (body.z_t.length !== body.g_t.length) {
      errors.push(`'z_t' dim ${body.z_t.length} != 'g_t' dim ${body.g_t.length}`);
    }
  }
  validateOptionalKnobs(body, errors);
  if (body.trajectory_id !== undefined && typeof body.trajectory_id !== "string") {
    errors.push("field 'trajectory_id' must be a string when present");
  }
  if (body.step_index !== undefined && !Number.isInteger(body.step_index)) {
    errors.push("field 'step_index' must be an integer when present");
  }
  return errors;
}

function validateTrajectoryBody(body) {
  const errors = [];
  if (body.z_0 !== undefined && !isFiniteVector(body.z_0)) {
    errors.push("field 'z_0' must be a finite numeric vector when present");
  }
  if (!isFiniteVector(body.z_init)) {
    errors.push("field 'z_init' is required and must be a finite numeric vector");
  }
  if (!Array.isArray(body.signals) || body.signals.length === 0) {
    errors.push("field 'signals' is required and must be a non-empty array of vectors");
  }
  if (Array.isArray(body.signals) && body.signals.length > MAX_SIGNALS_PER_TRAJECTORY) {
    errors.push(
      `field 'signals' length ${body.signals.length} exceeds cap ${MAX_SIGNALS_PER_TRAJECTORY}`,
    );
  }
  validateOptionalKnobs(body, errors);
  if (body.trajectory_id !== undefined && typeof body.trajectory_id !== "string") {
    errors.push("field 'trajectory_id' must be a string when present");
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * POST /v1/spiral/anchor
 *
 * Derive the substrate's identity anchor z_0 from the Soul Genome.
 * Body fields:
 *   dim     - integer in [MIN_DIM, MAX_DIM]; defaults to DEFAULT_DIM
 *   salt    - optional string; rotates the anchor for a sandbox/test seed
 */
export async function handleSpiralAnchor(rawBody, cfg) {
  const src = rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? rawBody : {};
  const errors = validateAnchorBody(src);
  if (errors.length > 0) {
    return {
      status: 400,
      body: errorBody("anchor body validation failed", 400, "invalid_request_error", {
        detail: { errors },
      }),
    };
  }

  let result;
  try {
    result = await deriveAnchorFromSoulGenome({
      soulGenomePath: cfg.soul_genome_path,
      dim: src.dim,
      salt: src.salt,
    });
  } catch (err) {
    const code = err && err.code ? err.code : "spiral_internal_error";
    const status = code === "soul_genome_unreachable" ? 503 : code === "soul_genome_invalid" ? 502 : 500;
    return {
      status,
      body: errorBody(err && err.message ? err.message : "anchor derivation failed", status, code, {
        detail: err && err.detail ? err.detail : undefined,
      }),
    };
  }

  // Audit the anchor pull — useful when investigating "did z_0 shift?".
  const auditEnv = {
    ts: new Date().toISOString(),
    ts_ms: Date.now(),
    event: "spiral.anchor",
    anchor_hash: result.anchor_hash,
    dim: result.dim,
    source: result.source,
  };
  const auditResult = await appendAudit(auditEnv, cfg.audit_path);

  return {
    status: 200,
    body: {
      ok: true,
      data: {
        z_0: result.z_0,
        dim: result.dim,
        anchor_hash: result.anchor_hash,
        source: result.source,
      },
      audit: auditResult,
    },
  };
}

/**
 * POST /v1/spiral/step
 *
 * Single SoT update. If body omits z_0, the route pulls a fresh anchor at
 * the body's dim (= length of z_t). This is the natural "give me the next
 * thought" call.
 */
export async function handleSpiralStep(rawBody, cfg) {
  const src = rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? rawBody : null;
  if (!src) {
    return {
      status: 400,
      body: errorBody("request body must be a JSON object", 400),
    };
  }

  const errors = validateStepBody(src);
  if (errors.length > 0) {
    return {
      status: 400,
      body: errorBody("step body validation failed", 400, "invalid_request_error", {
        detail: { errors },
      }),
    };
  }

  // Resolve z_0 — either passed in, or derived from Soul Genome at the
  // dimension of z_t.
  let z_0 = src.z_0;
  let anchorMeta = null;
  if (!z_0) {
    try {
      const anchor = await deriveAnchorFromSoulGenome({
        soulGenomePath: cfg.soul_genome_path,
        dim: src.z_t.length,
        salt: src.salt,
      });
      z_0 = anchor.z_0;
      anchorMeta = {
        anchor_hash: anchor.anchor_hash,
        dim: anchor.dim,
        source: anchor.source,
      };
    } catch (err) {
      const code = err && err.code ? err.code : "spiral_internal_error";
      const status = code === "soul_genome_unreachable" ? 503 : 500;
      return {
        status,
        body: errorBody(
          err && err.message ? err.message : "anchor derivation failed",
          status,
          code,
          { detail: err && err.detail ? err.detail : undefined },
        ),
      };
    }
  }

  let stepResult;
  try {
    stepResult = spiralStep({
      z_t: src.z_t,
      z_0,
      g_t: src.g_t,
      alpha: src.alpha,
      beta: src.beta,
      epsilon: src.epsilon,
      linear_step: src.linear_step,
    });
  } catch (err) {
    return {
      status: 400,
      body: errorBody(
        err && err.message ? err.message : "spiral step failed",
        400,
        "invalid_request_error",
      ),
    };
  }

  const tsIso = new Date().toISOString();
  const tsMs = Date.now();
  const auditEnv = {
    ts: tsIso,
    ts_ms: tsMs,
    event: "spiral.step",
    trajectory_id: typeof src.trajectory_id === "string" ? src.trajectory_id : null,
    step_index: Number.isInteger(src.step_index) ? src.step_index : null,
    dim: src.z_t.length,
    anchor_hash: anchorMeta ? anchorMeta.anchor_hash : (src.anchor_hash || null),
    r_t: stepResult.r_t,
    r_next: stepResult.r_next,
    delta_theta: stepResult.delta_theta,
    orth_norm: stepResult.orth_norm,
    total_norm: stepResult.total_norm,
    mode: stepResult.mode,
    fallback_reason: stepResult.fallback_reason || null,
    alpha: stepResult.alpha,
    beta: stepResult.beta,
    epsilon: stepResult.epsilon,
    linear_step: stepResult.linear_step,
  };
  const auditResult = await appendAudit(auditEnv, cfg.audit_path);

  return {
    status: 200,
    body: {
      ok: true,
      data: {
        z_next: stepResult.z_next,
        r_t: stepResult.r_t,
        r_next: stepResult.r_next,
        delta_theta: stepResult.delta_theta,
        orth_norm: stepResult.orth_norm,
        total_norm: stepResult.total_norm,
        mode: stepResult.mode,
        ...(stepResult.fallback_reason ? { fallback_reason: stepResult.fallback_reason } : {}),
        alpha: stepResult.alpha,
        beta: stepResult.beta,
        epsilon: stepResult.epsilon,
        linear_step: stepResult.linear_step,
        anchor: anchorMeta, // null when caller supplied z_0
        ts: tsIso,
      },
      audit: auditResult,
    },
  };
}

/**
 * POST /v1/spiral/trajectory
 *
 * Compute a full SoT trajectory from z_init through every signal in
 * `signals`. Returns the per-step record and a summary (mode counts,
 * cumulative angle, r_initial / r_final).
 */
export async function handleSpiralTrajectory(rawBody, cfg) {
  const src = rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? rawBody : null;
  if (!src) {
    return {
      status: 400,
      body: errorBody("request body must be a JSON object", 400),
    };
  }

  const errors = validateTrajectoryBody(src);
  if (errors.length > 0) {
    return {
      status: 400,
      body: errorBody("trajectory body validation failed", 400, "invalid_request_error", {
        detail: { errors },
      }),
    };
  }

  // Resolve z_0.
  let z_0 = src.z_0;
  let anchorMeta = null;
  if (!z_0) {
    try {
      const anchor = await deriveAnchorFromSoulGenome({
        soulGenomePath: cfg.soul_genome_path,
        dim: src.z_init.length,
        salt: src.salt,
      });
      z_0 = anchor.z_0;
      anchorMeta = {
        anchor_hash: anchor.anchor_hash,
        dim: anchor.dim,
        source: anchor.source,
      };
    } catch (err) {
      const code = err && err.code ? err.code : "spiral_internal_error";
      const status = code === "soul_genome_unreachable" ? 503 : 500;
      return {
        status,
        body: errorBody(
          err && err.message ? err.message : "anchor derivation failed",
          status,
          code,
          { detail: err && err.detail ? err.detail : undefined },
        ),
      };
    }
  }

  // Pre-validate dimensions before computing — the inner function will
  // also throw, but we want a structured 400 for a shape mismatch.
  if (src.z_init.length !== z_0.length) {
    return {
      status: 400,
      body: errorBody(
        `z_init dim ${src.z_init.length} does not match z_0 dim ${z_0.length}`,
        400,
        "invalid_request_error",
      ),
    };
  }
  for (let i = 0; i < src.signals.length; i++) {
    if (!isFiniteVector(src.signals[i]) || src.signals[i].length !== z_0.length) {
      return {
        status: 400,
        body: errorBody(
          `signals[${i}] must be a finite numeric vector of length ${z_0.length}`,
          400,
          "invalid_request_error",
        ),
      };
    }
  }

  let traj;
  try {
    traj = spiralTrajectory({
      z_0,
      z_init: src.z_init,
      signals: src.signals,
      alpha: src.alpha,
      beta: src.beta,
      epsilon: src.epsilon,
      linear_step: src.linear_step,
    });
  } catch (err) {
    return {
      status: 400,
      body: errorBody(
        err && err.message ? err.message : "trajectory computation failed",
        400,
        "invalid_request_error",
      ),
    };
  }

  const tsIso = new Date().toISOString();
  const tsMs = Date.now();
  const trajectoryId =
    typeof src.trajectory_id === "string" && src.trajectory_id.length > 0
      ? src.trajectory_id
      : `traj_${tsMs.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  // Audit a SUMMARY row per trajectory (not one row per step — that would
  // explode the audit log). If callers want per-step audit, they call
  // /step in a loop with a shared trajectory_id.
  const auditEnv = {
    ts: tsIso,
    ts_ms: tsMs,
    event: "spiral.trajectory",
    trajectory_id: trajectoryId,
    dim: z_0.length,
    anchor_hash: anchorMeta ? anchorMeta.anchor_hash : null,
    step_count: traj.summary.step_count,
    cumulative_angle: traj.summary.cumulative_angle,
    r_initial: traj.summary.r_initial,
    r_final: traj.summary.r_final,
    mode_counts: traj.summary.mode_counts,
    alpha: traj.summary.alpha,
    beta: traj.summary.beta,
    epsilon: traj.summary.epsilon,
    linear_step: traj.summary.linear_step,
  };
  const auditResult = await appendAudit(auditEnv, cfg.audit_path);

  return {
    status: 200,
    body: {
      ok: true,
      data: {
        trajectory_id: trajectoryId,
        steps: traj.steps,
        z_final: traj.z_final,
        summary: traj.summary,
        anchor: anchorMeta,
        ts: tsIso,
      },
      audit: auditResult,
    },
  };
}

/**
 * GET /v1/spiral/audit?since=&limit=&trajectory_id=
 *
 * Read the append-only audit JSONL. Filters:
 *   since         - epoch ms or ISO timestamp; rows older are excluded
 *   limit         - max rows to return (default DEFAULT_AUDIT_LIMIT, hard cap MAX_AUDIT_ITEMS)
 *   trajectory_id - only rows tagged with this trajectory id
 */
export async function handleSpiralAudit(url, cfg) {
  const params = url && url.searchParams ? url.searchParams : new URLSearchParams();
  const sinceRaw = params.get("since");
  const limitRaw = params.get("limit");
  const trajectoryId = params.get("trajectory_id");

  let limit = DEFAULT_AUDIT_LIMIT;
  if (limitRaw !== null) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n <= 0 || n > MAX_AUDIT_ITEMS) {
      return {
        status: 400,
        body: errorBody(
          `query 'limit' must be a positive integer <= ${MAX_AUDIT_ITEMS}`,
          400,
          "invalid_request_error",
        ),
      };
    }
    limit = n;
  }
  if (sinceRaw !== null && !Number.isFinite(parseSince(sinceRaw))) {
    return {
      status: 400,
      body: errorBody(
        "query 'since' must be epoch ms or ISO timestamp",
        400,
        "invalid_request_error",
      ),
    };
  }

  let result;
  try {
    result = await readAuditSince({
      since: sinceRaw,
      limit,
      trajectory_id: trajectoryId,
      auditPath: cfg.audit_path,
    });
  } catch (err) {
    return {
      status: 500,
      body: errorBody(
        err && err.message ? err.message : "audit read failed",
        500,
        "spiral_internal_error",
      ),
    };
  }

  return {
    status: 200,
    body: {
      ok: true,
      data: {
        count: result.count,
        since: sinceRaw,
        since_ms: result.since_ms,
        trajectory_id: trajectoryId || null,
        limit,
        audit_path: result.audit_path,
        exists: result.exists,
        items: result.items,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Public: registerSpiralRoutes(server, opts)
// ---------------------------------------------------------------------------

/**
 * Attach the Spiral gateway routes to a node:http Server. Follows the same
 * `prependListener("request", ...)` pattern as the Hermes, AtomSmasher, and
 * Memory routes so each surface stays self-contained.
 *
 * @param {import("node:http").Server} server
 * @param {object} [opts]
 * @param {string} [opts.soul_genome_path]  - override for Soul Genome path
 * @param {string} [opts.audit_path]        - override for audit JSONL path
 * @param {(line:string)=>void} [opts.log]
 * @returns {{ cfg: object, path_prefix: string, routes: Array<{method:string, path:string}> }}
 */
export function registerSpiralRoutes(server, opts = {}) {
  if (!server || typeof server.on !== "function") {
    throw new TypeError("registerSpiralRoutes: server must be a node:http Server");
  }

  const cfg = {
    soul_genome_path: opts.soul_genome_path || DEFAULT_SOUL_GENOME_PATH,
    audit_path: opts.audit_path || DEFAULT_AUDIT_PATH,
    log:
      typeof opts.log === "function"
        ? opts.log
        : (line) => {
            // eslint-disable-next-line no-console
            console.log(line);
          },
  };

  server.prependListener("request", async (req, res) => {
    if (res.writableEnded) return;

    let url;
    try {
      url = new URL(req.url, "http://127.0.0.1");
    } catch {
      return;
    }
    const method = (req.method || "GET").toUpperCase();
    const pathName = url.pathname;

    // Only handle Spiral paths; let the rest of the router fall through.
    if (
      pathName !== SPIRAL_ANCHOR_PATH &&
      pathName !== SPIRAL_STEP_PATH &&
      pathName !== SPIRAL_TRAJECTORY_PATH &&
      pathName !== SPIRAL_AUDIT_PATH
    ) {
      return;
    }

    // Method enforcement per-route.
    if (
      (pathName === SPIRAL_ANCHOR_PATH ||
        pathName === SPIRAL_STEP_PATH ||
        pathName === SPIRAL_TRAJECTORY_PATH) &&
      method !== "POST"
    ) {
      res.setHeader("Allow", "POST");
      return errorResponse(
        res,
        `method ${method} not allowed on ${pathName}`,
        405,
        "method_not_allowed",
        { allowed: ["POST"] },
      );
    }
    if (pathName === SPIRAL_AUDIT_PATH && method !== "GET") {
      res.setHeader("Allow", "GET");
      return errorResponse(
        res,
        `method ${method} not allowed on ${pathName}`,
        405,
        "method_not_allowed",
        { allowed: ["GET"] },
      );
    }

    try {
      if (pathName === SPIRAL_ANCHOR_PATH) {
        let raw;
        try {
          raw = await readJsonBody(req);
        } catch (err) {
          return errorResponse(res, err.message || "bad request body", 400, "invalid_request_body");
        }
        const { status, body } = await handleSpiralAnchor(raw, cfg);
        return jsonResponse(res, body, status);
      }
      if (pathName === SPIRAL_STEP_PATH) {
        let raw;
        try {
          raw = await readJsonBody(req);
        } catch (err) {
          return errorResponse(res, err.message || "bad request body", 400, "invalid_request_body");
        }
        const { status, body } = await handleSpiralStep(raw, cfg);
        return jsonResponse(res, body, status);
      }
      if (pathName === SPIRAL_TRAJECTORY_PATH) {
        let raw;
        try {
          raw = await readJsonBody(req);
        } catch (err) {
          return errorResponse(res, err.message || "bad request body", 400, "invalid_request_body");
        }
        const { status, body } = await handleSpiralTrajectory(raw, cfg);
        return jsonResponse(res, body, status);
      }
      if (pathName === SPIRAL_AUDIT_PATH) {
        const { status, body } = await handleSpiralAudit(url, cfg);
        return jsonResponse(res, body, status);
      }
    } catch (err) {
      cfg.log(`[spiral-gateway] handler error: ${err && err.message ? err.message : err}`);
      return errorResponse(
        res,
        err && err.message ? err.message : "spiral internal error",
        500,
        "spiral_internal_error",
      );
    }
  });

  return {
    cfg,
    path_prefix: SPIRAL_PATH_PREFIX,
    routes: [
      { method: "POST", path: SPIRAL_ANCHOR_PATH },
      { method: "POST", path: SPIRAL_STEP_PATH },
      { method: "POST", path: SPIRAL_TRAJECTORY_PATH },
      { method: "GET", path: SPIRAL_AUDIT_PATH },
    ],
  };
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

export const __spiralInternals = {
  deterministicGaussianVector,
  parseSince,
  readAuditSince,
  appendAudit,
  DEFAULT_SOUL_GENOME_PATH,
  DEFAULT_AUDIT_PATH,
  DEFAULT_ALPHA,
  DEFAULT_BETA,
  DEFAULT_EPSILON,
  DEFAULT_LINEAR_STEP,
  MAX_ALPHA,
  MAX_BETA,
  MAX_LINEAR_STEP,
  MIN_DIM,
  MAX_DIM,
};
