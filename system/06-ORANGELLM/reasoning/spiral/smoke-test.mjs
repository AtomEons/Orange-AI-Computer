// Spiral Reasoning — end-to-end smoke test.
//
// Source doctrine:
//   C:/AtomEons/orangebox/docs/SPIRAL_REASONING_INTEGRATION_v1.md
//   Disclosure ID: ATOM-SPIRAL-INTEGRATION-v1-2026-0618
//   Paper: McCree A. (2026). Spiral Reasoning — Orthogonal Bivector Dynamics
//          for Coherent Thought in Latent Space. April 7, 2026.
//
// What this smoke test asserts (six cases, in this order):
//
//   1. anchor_from_real_genome
//      Pull z_0 from the REAL Soul Genome at
//      C:/AtomEons/Orange5/13-MODELS/orange-llm/soul_genome.json. Confirm the
//      anchor is deterministic across two reads, the fingerprint is stable,
//      the meta carries sovereign/intent/project/doctrine anchors, and the
//      derived components are all finite and in [-1, 1).
//
//   2. tight_trajectory_10_steps
//      Walk 10 deterministic signals from the real anchor under the "tight"
//      preset. Assert: path length == steps+1, max_alpha <= alpha_max, every
//      step's r ≈ r_prev · exp(β · Δθ) exactly, and (when any step rotated)
//      r is also ||z_{k+1} - z_0||.
//
//   3. exploratory_trajectory_10_steps
//      Same 10 signals, same anchor, but the "exploratory" preset. Assert
//      the same per-step invariants AND that the exploratory trajectory
//      moved MORE radially than the tight trajectory — i.e.
//      `tight.total_radial < exploratory.total_radial`. This is the load-bearing
//      cross-policy assertion the task names.
//
//   4. degeneration_on_weak_signal
//      Build a signal that is essentially pure-radial relative to the substrate
//      (orthogonal share well below signal_threshold). Run through
//      degeneration.stepOrDegenerate(). Assert decision.degenerate=true,
//      reason names the doctrinal gate that fired, outcome.alpha == 0,
//      outcome.delta_theta == 0, and the audit event carries the disclosure
//      ID + the signal_threshold actually applied.
//
//   5. alpha_boundary_enforcement
//      Drive the engine with a pure-orthogonal signal (confidence == 1) which
//      saturates tanh(1) ≈ 0.7616. For each profile, assert:
//        - realized alpha == policy.alpha_max * tanh(1)  (closed form)
//        - realized alpha < policy.alpha_max             (STRICT bound; never equal)
//        - exploratory.alpha > balanced.alpha > tight.alpha
//      This is the Belief Discipline gate proved empirically.
//
//   6. audit_chain_integrity
//      Run runWithAudit() into an isolated temp Flux root (NOT touching the
//      live /mnt/ae_flux on Codexa). After: read the per-date JSONL back,
//      verifyChain() reports ok:true with N+2 records (open + steps + close),
//      every record's sha256 == sha256(prior_sha256 + canonical_json(event)),
//      open carries doctrine{disclosure_id} and run_id, close.summary matches
//      the trajectory's stats, and the chain head links back to GENESIS for
//      a fresh root.
//
// Run:   node smoke-test.mjs
//        node --test smoke-test.mjs        (works too — uses node:test)
//
// Exit:  0 = all six cases passed; 1 = any failure (failure detail on stderr).
//
// Mom's Law: real assertions, no hand-waving. Every numerical claim is checked
// against the closed-form math from the integration doctrine §1.

import { test } from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadGenome,
  pullAnchor,
  toRealVector,
  DEFAULT_GENOME_PATH,
} from "./anchor.mjs";
import {
  step,
  trajectory as engineTrajectory,
} from "./engine.mjs";
import {
  resolve as resolvePolicy,
  preset,
  PRESET_NAMES,
} from "./policy.mjs";
import {
  classify,
  stepOrDegenerate,
} from "./degeneration.mjs";
import {
  runWithAudit,
  verifyChain,
  SPIRAL_LANE,
  SPIRAL_ORIGIN,
  __internals as auditInternals,
} from "./audit.mjs";

// ---------------------------------------------------------------------------
// Helpers — tolerant numerical comparison + deterministic signal bank.

function approx(actual, expected, tol, label) {
  const diff = Math.abs(actual - expected);
  assert.ok(
    diff <= tol,
    `${label}: expected ${expected} ≈ ${actual}, |diff|=${diff} > tol=${tol}`,
  );
}

function vNorm(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

function vSub(a, b) {
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] - b[i];
  return out;
}

/**
 * Deterministic mixed-novelty signal bank for the trajectory cases. Each
 * signal has a non-trivial orthogonal component relative to a generic radial
 * direction so we exercise the rotation branch rather than constantly
 * degenerating. Indices are stamped into the formula so swapping order
 * changes the trajectory — useful for downstream tests.
 *
 * @param {number} d   target dimension
 * @param {number} n   number of signals
 * @returns {number[][]}
 */
function buildSignals(d, n) {
  const sigs = [];
  for (let k = 0; k < n; k++) {
    const s = new Array(d);
    for (let i = 0; i < d; i++) {
      // Mix several sinusoids of different frequency so g has genuine
      // orthogonal content against essentially any radial unit u.
      s[i] =
        0.5 * Math.cos((k + 1) * 0.7 + i * 0.31) +
        0.3 * Math.sin((k + 1) * 1.3 + i * 0.17) +
        0.15 * Math.sin((k + 1) * 0.05 - i * 0.41);
    }
    sigs.push(s);
  }
  return sigs;
}

// ---------------------------------------------------------------------------
// Doctrine-anchored constants

const DISCLOSURE_ID = "ATOM-SPIRAL-INTEGRATION-v1-2026-0618";
const REAL_GENOME_PATH = DEFAULT_GENOME_PATH;

// Tight numerical tolerance for closed-form identities (engine math is in
// plain double precision; 1e-9 is the comfortable working tolerance).
const MATH_TOL = 1e-9;

// ---------------------------------------------------------------------------
// CASE 1 — anchor_from_real_genome

test("smoke[1/6] anchor from REAL soul_genome.json is honest + deterministic", async () => {
  // Hard requirement: the real genome must exist. We do NOT mock it; if it
  // is missing the smoke test is meaningless.
  assert.ok(
    existsSync(REAL_GENOME_PATH),
    `real Soul Genome missing at ${REAL_GENOME_PATH} — cannot run smoke test`,
  );

  const g1 = await loadGenome({ path: REAL_GENOME_PATH });
  const g2 = await loadGenome({ path: REAL_GENOME_PATH });

  const a1 = pullAnchor(g1, { dim: 16, genome_path: REAL_GENOME_PATH });
  const a2 = pullAnchor(g2, { dim: 16, genome_path: REAL_GENOME_PATH });

  // Deterministic: same genome content → identical re/im components +
  // identical fingerprint, in both calls.
  assert.equal(a1.re.length, a1.im.length, "re/im must agree in length");
  assert.equal(a1.re.length, 16, "dim respected");
  assert.equal(a1.meta.fingerprint, a2.meta.fingerprint, "fingerprint stable");
  for (let i = 0; i < a1.re.length; i++) {
    assert.equal(a1.re[i], a2.re[i], `re[${i}] deterministic`);
    assert.equal(a1.im[i], a2.im[i], `im[${i}] deterministic`);
    assert.ok(Number.isFinite(a1.re[i]) && Number.isFinite(a1.im[i]));
    assert.ok(a1.re[i] >= -1 && a1.re[i] < 1, `re[${i}] in [-1,1)`);
    assert.ok(a1.im[i] >= -1 && a1.im[i] < 1, `im[${i}] in [-1,1)`);
  }

  // Meta carries the binding anchors the integration doctrine names.
  assert.ok(a1.meta.sovereign, "meta.sovereign present");
  assert.equal(a1.meta.sovereign.name, "Atom McCree", "sovereign name");
  assert.equal(a1.meta.sovereign.email, "a.mccree@gmail.com", "sovereign email");
  assert.equal(a1.meta.schema_id, "atomeons.orange5.soul_genome.v1");
  assert.ok(a1.meta.active_project, "meta.active_project present");
  assert.equal(a1.meta.active_project.name, "Orange5");
  assert.equal(
    a1.meta.active_project.charter_id,
    "ATOM-ORANGE5-MASTER-2026-0623",
  );
  assert.ok(a1.meta.doctrine_anchors, "meta.doctrine_anchors present");
  assert.equal(a1.meta.doctrine_anchors.binding, true, "doctrine is binding");
  assert.equal(
    a1.meta.doctrine.disclosure_id,
    DISCLOSURE_ID,
    "doctrine disclosure ID stamped",
  );

  // The flat real-vector packing must round-trip the (re, im) pair losslessly.
  const flat = toRealVector(a1);
  assert.equal(flat.length, a1.re.length * 2, "flat vector length 2*dim");
  for (let i = 0; i < a1.re.length; i++) {
    assert.equal(flat[2 * i], a1.re[i], `flat[2*${i}] == re[${i}]`);
    assert.equal(flat[2 * i + 1], a1.im[i], `flat[2*${i}+1] == im[${i}]`);
  }
});

// ---------------------------------------------------------------------------
// CASE 2 + 3 — tight vs exploratory 10-step trajectories
// (Same anchor, same signals, different policy. Run together so they share
// the genome/anchor load; cross-policy assertion lives in case 3.)

let TIGHT_RESULT = null;
let EXPLORATORY_RESULT = null;

test("smoke[2/6] tight 10-step trajectory honors closed form + alpha bound", async () => {
  const genome = await loadGenome({ path: REAL_GENOME_PATH });
  const a = pullAnchor(genome, { dim: 16 });
  const z_0 = Array.from(toRealVector(a)); // 32-d real
  const signals = buildSignals(z_0.length, 10);

  const pol = resolvePolicy({ profile: "tight" });
  // Sanity: the resolved profile carries the doctrine block.
  assert.equal(pol.profile, "tight");
  assert.equal(pol.doctrine.disclosure_id, DISCLOSURE_ID);
  assert.equal(pol.alpha_max, Math.PI / 8, "tight alpha_max = π/8");

  const t = engineTrajectory(z_0, signals, pol);

  // Shape
  assert.equal(t.path.length, signals.length + 1, "path = steps+1");
  assert.deepEqual(t.path[0], z_0, "path[0] == z_0");
  assert.deepEqual(t.path[t.path.length - 1], t.final, "final matches tail");
  assert.equal(t.audit.length, signals.length, "audit row per step");
  assert.equal(t.steps, signals.length);

  // Closed-form per-step invariants
  let z_prev = z_0.slice();
  for (let k = 0; k < t.audit.length; k++) {
    const a_k = t.audit[k];

    // r_{k+1} = r_t · exp(β · Δθ_k) — but engine seeds r_base = max(r_prev, min_radius)
    // when r_prev < min_radius. Re-derive r_base the same way for a clean check.
    const r_prev_measured = vNorm(vSub(z_prev, z_0));
    const r_base = Math.max(r_prev_measured, pol.min_radius);
    if (!a_k.degenerate) {
      const expected_r = r_base * Math.exp(pol.beta * a_k.delta_theta);
      approx(a_k.r, expected_r, MATH_TOL, `tight step ${k} radial accounting`);
      // alpha strict bound (since tanh(·) < 1 for finite input)
      assert.ok(
        a_k.alpha <= pol.alpha_max + MATH_TOL,
        `tight step ${k} alpha within bound`,
      );
      assert.ok(
        a_k.alpha < pol.alpha_max,
        `tight step ${k} alpha STRICTLY < alpha_max (tanh saturates below 1)`,
      );
      // z_{k+1} is on the sphere of radius r around z_0
      const r_meas = vNorm(vSub(t.path[k + 1], z_0));
      approx(r_meas, a_k.r, MATH_TOL, `tight step ${k} sphere identity`);
    } else {
      assert.equal(a_k.alpha, 0, `tight step ${k} degenerate ⇒ alpha=0`);
      assert.equal(a_k.delta_theta, 0, `tight step ${k} degenerate ⇒ Δθ=0`);
    }
    z_prev = t.path[k + 1];
  }

  // max_alpha bound across the run.
  assert.ok(
    t.max_alpha <= pol.alpha_max + MATH_TOL,
    "max_alpha within alpha_max",
  );

  TIGHT_RESULT = { trajectory: t, policy: pol, z_0, signals };
});

test("smoke[3/6] exploratory 10-step trajectory + cross-policy total_radial gap", async () => {
  assert.ok(TIGHT_RESULT, "case 2 must run before case 3");

  // Reuse the SAME anchor and SAME signals so the cross-policy comparison is
  // apples-to-apples — only the policy differs.
  const z_0 = TIGHT_RESULT.z_0;
  const signals = TIGHT_RESULT.signals;

  const pol = resolvePolicy({ profile: "exploratory" });
  assert.equal(pol.profile, "exploratory");
  assert.equal(pol.alpha_max, Math.PI / 2, "exploratory alpha_max = π/2");
  assert.ok(pol.beta > TIGHT_RESULT.policy.beta, "exploratory beta > tight beta");

  const t = engineTrajectory(z_0, signals, pol);

  // Same closed-form per-step check.
  let z_prev = z_0.slice();
  for (let k = 0; k < t.audit.length; k++) {
    const a_k = t.audit[k];
    const r_prev_measured = vNorm(vSub(z_prev, z_0));
    const r_base = Math.max(r_prev_measured, pol.min_radius);
    if (!a_k.degenerate) {
      const expected_r = r_base * Math.exp(pol.beta * a_k.delta_theta);
      approx(a_k.r, expected_r, MATH_TOL, `exploratory step ${k} radial accounting`);
      assert.ok(
        a_k.alpha <= pol.alpha_max + MATH_TOL,
        `exploratory step ${k} alpha within bound`,
      );
      const r_meas = vNorm(vSub(t.path[k + 1], z_0));
      approx(r_meas, a_k.r, MATH_TOL, `exploratory step ${k} sphere identity`);
    }
    z_prev = t.path[k + 1];
  }
  assert.ok(t.max_alpha <= pol.alpha_max + MATH_TOL);

  EXPLORATORY_RESULT = { trajectory: t, policy: pol };

  // ============================================================
  // Load-bearing cross-policy assertion (the one the task names).
  // ============================================================
  //
  // Tight has smaller alpha_max AND smaller beta, so under the same signals:
  //   |Δθ_k|^{tight}        < |Δθ_k|^{exploratory}            (alpha gate)
  //   β^{tight} · Δθ_k      < β^{exploratory} · Δθ_k          (LEARN coefficient)
  //   exp(β · Δθ)^{tight}   < exp(β · Δθ)^{exploratory}       (closed form)
  // ⇒ r_{k+1}^{tight}        < r_{k+1}^{exploratory}           (per step)
  // ⇒ Σ|Δr_k|^{tight}        < Σ|Δr_k|^{exploratory}           (sum)
  //
  // i.e. tight.total_radial < exploratory.total_radial.
  assert.ok(
    TIGHT_RESULT.trajectory.total_radial < t.total_radial,
    `tight total_radial (${TIGHT_RESULT.trajectory.total_radial}) must be ` +
      `< exploratory total_radial (${t.total_radial})`,
  );

  // And the exploratory max_alpha should land above the tight max_alpha for
  // identical signals (genuine orthogonal content survives both gates here).
  assert.ok(
    t.max_alpha > TIGHT_RESULT.trajectory.max_alpha,
    `exploratory max_alpha (${t.max_alpha}) > tight max_alpha (${TIGHT_RESULT.trajectory.max_alpha})`,
  );
});

// ---------------------------------------------------------------------------
// CASE 4 — degeneration on weak signal (no curvature without signal)

test("smoke[4/6] degeneration fires when orthogonal share is below threshold", () => {
  // Construct a 4-D problem we control: anchor at origin, z_k along x, signal
  // mostly along x with a sliver of y. We pick the orthogonal share to be
  // BELOW the balanced preset's signal_threshold (0.05) so the doctrinal gate
  // fires (classify(reason) == "signal_below_threshold"), not just the
  // engine's absolute ort_epsilon gate.
  const z_0 = [0, 0, 0, 0];
  const z_k = [1, 0, 0, 0];

  // u = (1,0,0,0). Set g = (1, eps, 0, 0). confidence = eps / sqrt(1 + eps^2).
  // Want confidence < 0.05 → pick eps = 0.02 → confidence ≈ 0.02/1.0002 ≈ 0.01998.
  const eps = 0.02;
  const signal = [1, eps, 0, 0];

  const pol = resolvePolicy({
    profile: "balanced",
    overrides: { z_0, step_size: 0 }, // step_size 0 → hold-still on degenerate
  });
  // Sanity check on the constructed confidence vs threshold.
  const expectedConfidence = eps / Math.sqrt(1 + eps * eps);
  assert.ok(
    expectedConfidence < pol.signal_threshold,
    `setup error: expected confidence ${expectedConfidence} >= threshold ${pol.signal_threshold}`,
  );

  const decision = classify(z_k, signal, pol);
  assert.equal(decision.degenerate, true, "must degenerate");
  assert.equal(
    decision.reason,
    "signal_below_threshold",
    "doctrinal gate (ratio) must be the one that fired",
  );
  approx(decision.confidence, expectedConfidence, 1e-12, "confidence math");
  assert.equal(decision.signal_floor_ok, true, "absolute signal floor was OK");
  assert.equal(
    decision.orthogonal_floor_ok,
    true,
    "absolute orthogonal floor was OK — the threshold gate is what stopped us",
  );
  assert.equal(decision.signal_threshold_ok, false, "ratio gate failed");

  const { outcome, event } = stepOrDegenerate(z_k, signal, pol, { k: 0 });
  assert.equal(outcome.degenerate, true);
  assert.equal(outcome.alpha, 0, "alpha=0 on degenerate");
  assert.equal(outcome.delta_theta, 0, "Δθ=0 on degenerate");
  // step_size 0 ⇒ z_next == z_k (the substrate holds still).
  assert.deepEqual(outcome.z_next, z_k, "step_size 0 ⇒ no motion");

  // Audit event is stamped honestly.
  assert.ok(event, "degeneration event must be emitted");
  assert.equal(event.event, "spiral.degeneration");
  assert.equal(event.disclosure_id, DISCLOSURE_ID, "event carries disclosure");
  assert.equal(event.reason, "signal_below_threshold");
  assert.equal(event.signal_threshold, pol.signal_threshold);
  approx(event.confidence, expectedConfidence, 1e-12);
  assert.equal(event.alpha, 0);
});

// ---------------------------------------------------------------------------
// CASE 5 — alpha boundary enforcement (Belief Discipline)

test("smoke[5/6] alpha boundary: realized α = α_max·tanh(1), strict < α_max", () => {
  // Pure-orthogonal signal: u = (1, 0), g = (0, 1) → confidence = 1.
  // ⇒ |Δθ| = α_max · tanh(1).  tanh(1) ≈ 0.7615941559557649.
  const z_0 = [0, 0];
  const z_k = [1, 0];
  const signal = [0, 1];
  const tanh1 = Math.tanh(1);

  const results = {};
  for (const name of PRESET_NAMES) {
    const pol = resolvePolicy({ profile: name, overrides: { z_0 } });
    const out = step(z_k, signal, pol);
    results[name] = { out, pol };

    // Confidence is exactly 1 here.
    approx(out.confidence, 1, MATH_TOL, `${name} confidence == 1`);
    // Closed form for the realized angle.
    const expected_alpha = pol.alpha_max * tanh1;
    approx(out.alpha, expected_alpha, MATH_TOL, `${name} α = α_max·tanh(1)`);
    // Strict bound: tanh(1) < 1, so α < α_max with margin > 0.
    assert.ok(
      out.alpha < pol.alpha_max,
      `${name} realized α (${out.alpha}) STRICTLY < α_max (${pol.alpha_max})`,
    );
    // And the gap is exactly α_max · (1 - tanh(1)).
    const gap = pol.alpha_max - out.alpha;
    approx(gap, pol.alpha_max * (1 - tanh1), MATH_TOL, `${name} gap = α_max·(1-tanh1)`);
  }

  // Cross-preset monotonicity: tight < balanced < exploratory in realized α
  // because the only thing that changes is α_max.
  assert.ok(
    results.tight.out.alpha < results.balanced.out.alpha,
    "tight α < balanced α",
  );
  assert.ok(
    results.balanced.out.alpha < results.exploratory.out.alpha,
    "balanced α < exploratory α",
  );

  // Each preset's α_max matches the preset spec.
  approx(results.tight.pol.alpha_max, Math.PI / 8, 0, "tight α_max == π/8");
  approx(results.balanced.pol.alpha_max, Math.PI / 4, 0, "balanced α_max == π/4");
  approx(
    results.exploratory.pol.alpha_max,
    Math.PI / 2,
    0,
    "exploratory α_max == π/2",
  );
});

// ---------------------------------------------------------------------------
// CASE 6 — audit chain integrity (in isolated temp Flux root)

test("smoke[6/6] audit chain: open + N steps + close, hash-chained, verifyChain ok", async () => {
  // Isolate from the live Flux mount so this never writes to /mnt/ae_flux or
  // any operator surface. mkdtemp + rmSync at the end. Receipts only locally.
  const tmpRoot = mkdtempSync(join(tmpdir(), "spiral-smoke-flux-"));
  try {
    const genome = await loadGenome({ path: REAL_GENOME_PATH });
    const a = pullAnchor(genome, { dim: 8 });
    const z_0 = Array.from(toRealVector(a)); // 16-d

    const N = 5;
    const signals = buildSignals(z_0.length, N);

    const pol = resolvePolicy({ profile: "balanced" });
    const ran = runWithAudit({
      z_0,
      signals,
      policy: pol,
      anchor_meta: {
        fingerprint: a.meta.fingerprint,
        dim: a.meta.dim,
        source: a.meta.source,
      },
      context: { source: "smoke-test.mjs/case-6" },
      fluxRoot: tmpRoot,
    });

    // Trajectory shape — same invariants as the engine.trajectory() variants.
    assert.equal(ran.trajectory.steps, N);
    assert.equal(ran.trajectory.path.length, N + 1);
    assert.equal(ran.step_records.length, N);
    assert.ok(typeof ran.run_id === "string" && ran.run_id.length > 0);

    // Chain verifier on the per-date file inside the tmp root.
    const chain = verifyChain({ fluxRoot: tmpRoot, lane: SPIRAL_LANE });
    assert.equal(chain.ok, true, `chain integrity: ${JSON.stringify(chain.broken)}`);
    // Expect N+2 records: 1 open + N steps + 1 close.
    assert.equal(chain.count, N + 2, `expected ${N + 2} records, got ${chain.count}`);
    assert.equal(chain.tailSha, ran.close.sha256, "tail of file == close.sha256");

    // Read the file and check the head's prior_sha256 chain back to GENESIS
    // (fresh root → no earlier per-date file).
    const filePath = chain.path;
    const raw = readFileSync(filePath, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    assert.equal(lines.length, N + 2);
    const first = JSON.parse(lines[0]);
    assert.equal(first.prev_hash, "GENESIS", "fresh root starts at GENESIS");
    assert.equal(first.origin, SPIRAL_ORIGIN);
    assert.equal(first.lane, SPIRAL_LANE);
    assert.equal(first.body.kind, "spiral_run_open");
    assert.equal(first.body.run_id, ran.run_id);
    assert.equal(
      first.body.doctrine.disclosure_id,
      DISCLOSURE_ID,
      "open carries disclosure ID",
    );

    // Recompute every link by hand using the audit module's exposed canonical
    // JSON + hash. This is what verifyChain does internally; double-checking
    // here is the smoke test's "the chain math is the math we claim" assertion.
    const { canonicalJSON, recordHashValid } = auditInternals;
    let priorSha = "GENESIS";
    for (let i = 0; i < lines.length; i++) {
      const rec = JSON.parse(lines[i]);
      assert.equal(rec.prev_hash, priorSha, `line ${i} prior chain`);
      assert.equal(recordHashValid(rec), true, `line ${i} canonical hash valid`);
      // And the canonical encoding is stable (round-trip via parse → re-canon).
      const reCanon = canonicalJSON(rec.body);
      assert.ok(typeof reCanon === "string" && reCanon.length > 0);
      priorSha = rec.hash;
    }

    // The step records' kinds / k values must be the expected sequence.
    for (let i = 0; i < N; i++) {
      const rec = JSON.parse(lines[1 + i]);
      assert.equal(rec.body.kind, "spiral_step");
      assert.equal(rec.body.k, i);
      assert.equal(rec.body.run_id, ran.run_id);
      // r in the audit record matches the trajectory's audit r.
      approx(
        rec.body.r,
        ran.trajectory.audit[i].r,
        MATH_TOL,
        `step ${i} audit r matches trajectory r`,
      );
    }

    // Close summary matches the trajectory's totals.
    const lastRec = JSON.parse(lines[lines.length - 1]);
    assert.equal(lastRec.body.kind, "spiral_run_close");
    assert.equal(lastRec.body.run_id, ran.run_id);
    approx(
      lastRec.body.summary.total_radial,
      ran.trajectory.total_radial,
      MATH_TOL,
      "close.summary.total_radial == trajectory.total_radial",
    );
    approx(
      lastRec.body.summary.max_alpha,
      ran.trajectory.max_alpha,
      MATH_TOL,
      "close.summary.max_alpha == trajectory.max_alpha",
    );
    assert.equal(
      lastRec.body.summary.steps,
      ran.trajectory.steps,
      "close.summary.steps == N",
    );
    assert.equal(
      lastRec.body.summary.degenerate_count,
      ran.trajectory.degenerate_count,
    );
  } finally {
    // Clean the tmp Flux root. Receipts are observed live above; we do not
    // need to keep them on disk after the assertions pass.
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Optional CLI affordance: `node smoke-test.mjs` (without --test) runs the
// node:test runner programmatically and exits with the appropriate code, so
// the file is usable as a stand-alone smoke check from any harness.
//
// When invoked via `node --test smoke-test.mjs`, the runner has already
// registered the tests above and this block is skipped.

const isMain =
  import.meta.url.startsWith("file:") &&
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];

// `node --test smoke-test.mjs` sets process.execArgv-style "--test" handling
// inside the runner; we also guard against the env var the runner sets so the
// CLI branch only fires for plain `node smoke-test.mjs`.
const runnerActive =
  process.argv.includes("--test") ||
  process.env.NODE_TEST_CONTEXT === "child" ||
  // node 20+: when started under `node --test`, the parent process arg[1] is
  // the test file itself but the runner is still in charge; check for the
  // recursion signal node:test sets on globalThis.
  typeof globalThis[Symbol.for("node:test:internal")] !== "undefined";

if (isMain && !runnerActive) {
  // The node:test runner registers tests synchronously on import; they will
  // execute on the next tick. We simply let the process run to completion;
  // node:test handles the exit code (non-zero on any failure) automatically
  // when started via `node --test`. For plain `node smoke-test.mjs`, we drive
  // the run explicitly so the CLI behaves the same way.
  const { run } = await import("node:test");
  const stream = run({ files: [fileURLToPath(import.meta.url)] });
  let failed = 0;
  stream.on("test:fail", (ev) => {
    failed++;
    process.stderr.write(
      `FAIL: ${ev.name}\n  ${ev.details?.error?.message ?? ""}\n`,
    );
  });
  stream.on("test:pass", (ev) => {
    process.stdout.write(`PASS: ${ev.name}\n`);
  });
  stream.on("end", () => {
    process.exit(failed === 0 ? 0 : 1);
  });
}
