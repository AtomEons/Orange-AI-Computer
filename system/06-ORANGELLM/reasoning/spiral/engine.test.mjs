// Tests for the Spiral Reasoning engine.
// Run:  node --test engine.test.mjs
//
// No external deps. Uses the built-in node:test runner (Node 20+).
// Every test asserts a property the doctrine names, not an arbitrary number.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  anchor,
  step,
  trajectory,
  DEFAULT_POLICY,
  __internals,
} from "./engine.mjs";

const { vNorm, vSub, vDot, vScale, vAdd } = __internals;

// ---------------------------------------------------------------------------
// Helpers

function approx(a, b, tol = 1e-9, msg = "") {
  assert.ok(
    Math.abs(a - b) <= tol,
    `${msg} expected ${a} ≈ ${b} (tol=${tol}), diff=${Math.abs(a - b)}`,
  );
}

function vec(...xs) { return xs; }

// ---------------------------------------------------------------------------
// anchor()

test("anchor: pulls explicit identity_vector when present", () => {
  const g = { identity_vector: [0.1, 0.2, 0.3, 0.4] };
  const a = anchor(g);
  assert.equal(a.source, "genome.identity_vector");
  assert.deepEqual(a.z_0, [0.1, 0.2, 0.3, 0.4]);
  assert.equal(a.dim, 4);
  assert.equal(typeof a.fingerprint, "string");
  assert.equal(a.fingerprint.length, 16);
});

test("anchor: pulls nested anchor.vector when no identity_vector", () => {
  const g = { anchor: { vector: [1, -1, 0.5] } };
  const a = anchor(g);
  assert.equal(a.source, "genome.anchor.vector");
  assert.deepEqual(a.z_0, [1, -1, 0.5]);
});

test("anchor: derives deterministic vector from identity fields", () => {
  const g = {
    sovereign: { name: "Atom McCree", email: "a.mccree@gmail.com" },
    schema_id: "atomeons.orange5.soul_genome.v1",
    current_intent_id: "orange5.bootstrap.soul_genome.full_population",
    active_project: { charter_id: "ATOM-ORANGE5-MASTER-2026-0623" },
  };
  const a = anchor(g, { dim: 32 });
  const b = anchor(g, { dim: 32 });
  assert.equal(a.source, "derived:identity-hash");
  assert.equal(a.z_0.length, 32);
  assert.deepEqual(a.z_0, b.z_0, "same input must yield same anchor");
  assert.equal(a.fingerprint, b.fingerprint);
  // every component must be finite and in [-1, 1)
  for (const x of a.z_0) {
    assert.ok(Number.isFinite(x));
    assert.ok(x >= -1 && x < 1, `component ${x} out of [-1, 1)`);
  }
});

test("anchor: different identities produce different vectors", () => {
  const a = anchor({ sovereign: { name: "A" }, schema_id: "x" });
  const b = anchor({ sovereign: { name: "B" }, schema_id: "x" });
  assert.notDeepEqual(a.z_0, b.z_0);
});

test("anchor: rejects non-object genome", () => {
  assert.throws(() => anchor(null), TypeError);
  assert.throws(() => anchor(42), TypeError);
});

// ---------------------------------------------------------------------------
// step() — basic shape

test("step: requires policy.z_0", () => {
  assert.throws(() => step([1, 0], [0, 1], {}), TypeError);
});

test("step: rejects dimension mismatch", () => {
  assert.throws(
    () => step([1, 0, 0], [0, 1], { z_0: [0, 0, 0] }),
    RangeError,
  );
});

test("step: output keys and types", () => {
  const out = step([1, 0], [0, 1], { z_0: [0, 0] });
  assert.equal(typeof out.r, "number");
  assert.equal(typeof out.delta_r, "number");
  assert.equal(typeof out.alpha, "number");
  assert.equal(typeof out.delta_theta, "number");
  assert.equal(typeof out.confidence, "number");
  assert.equal(typeof out.degenerate, "boolean");
  assert.ok(Array.isArray(out.z_next));
  assert.equal(out.z_next.length, 2);
});

// ---------------------------------------------------------------------------
// step() — Belief Discipline (alpha bound)

test("step: |Δθ| is strictly bounded by alpha_max", () => {
  // Pick a pure-orthogonal signal so tanh saturates as much as possible.
  // ||g_ort|| / ||g|| = 1 → Δθ = α_max · tanh(1) ≈ 0.7616·α_max < α_max.
  const z0 = [0, 0];
  const z = [1, 0];          // r_prev = 1, u = (1, 0)
  const g = [0, 1];          // purely orthogonal to u
  const policy = { z_0: z0, alpha_max: Math.PI / 4, beta: 0.5 };
  const out = step(z, g, policy);
  assert.ok(out.alpha < policy.alpha_max, "alpha must be strictly < alpha_max");
  assert.ok(out.alpha > 0);
  approx(out.alpha, policy.alpha_max * Math.tanh(1), 1e-12);
});

test("step: tighter alpha_max produces tighter rotation", () => {
  const z0 = [0, 0];
  const z = [1, 0];
  const g = [0, 1];
  const wide = step(z, g, { z_0: z0, alpha_max: Math.PI / 4 });
  const tight = step(z, g, { z_0: z0, alpha_max: Math.PI / 32 });
  assert.ok(tight.alpha < wide.alpha, "smaller alpha_max ⇒ smaller realized turn");
});

// ---------------------------------------------------------------------------
// step() — LEARN imperative (radial accounting)

test("step: r_{t+1} = r_t · exp(β · Δθ) exactly", () => {
  const z0 = [0, 0];
  const z = [2, 0];           // r_prev = 2
  const g = [0, 1];           // pure orthogonal
  const beta = 0.7;
  const out = step(z, g, { z_0: z0, alpha_max: Math.PI / 4, beta });
  const expected = 2 * Math.exp(beta * out.delta_theta);
  approx(out.r, expected, 1e-12, "exact radial accounting");
});

test("step: pure radial signal does NOT rotate (graceful degeneration)", () => {
  const z0 = [0, 0];
  const z = [1, 0];
  const g = [3, 0];           // entirely along u = (1, 0); g_ort ≈ 0
  const out = step(z, g, { z_0: z0 });
  assert.equal(out.degenerate, true);
  assert.equal(out.alpha, 0);
  assert.equal(out.delta_theta, 0);
  // Linear fallback: z_next = z + g_par * step_size = (1,0) + (3,0) = (4,0)
  assert.deepEqual(out.z_next, [4, 0]);
});

test("step: zero signal yields no motion (BREATHE without curvature)", () => {
  const z0 = [0, 0, 0];
  const z = [0.5, 0.5, 0];
  const g = [0, 0, 0];
  const out = step(z, g, { z_0: z0 });
  assert.equal(out.degenerate, true);
  assert.equal(out.alpha, 0);
  // confidence is 0 (or undefined-NaN-protected) and z does not move
  approx(vNorm(vSub(out.z_next, z)), 0, 1e-12);
});

test("step: z_next lies in the plane spanned by u and v (closed form)", () => {
  // With Δθ > 0 and a 3D problem, z_next - z_0 must equal r_next · (cosΔθ·u + sinΔθ·v).
  const z0 = [0, 0, 0];
  const z = [1, 0, 0];
  const g = [0, 1, 0];        // u=(1,0,0), v=(0,1,0)
  const out = step(z, g, { z_0: z0, alpha_max: Math.PI / 3, beta: 0.4 });

  const r_next = out.r;
  const dt = out.delta_theta;
  const expected = [
    r_next * Math.cos(dt),
    r_next * Math.sin(dt),
    0,
  ];
  const diff = vSub(out.z_next, z0);
  for (let i = 0; i < 3; i++) approx(diff[i], expected[i], 1e-12, `axis ${i}`);
});

test("step: z_next lies on a sphere of radius r_next around z_0", () => {
  const z0 = [0.3, -0.1, 0.7];
  const z = [1.3, 0.4, 0.7];
  const g = [0.2, 0.9, -0.1];
  const out = step(z, g, { z_0: z0, alpha_max: Math.PI / 5, beta: 0.6 });
  const r_measured = vNorm(vSub(out.z_next, z0));
  approx(r_measured, out.r, 1e-12, "radius from anchor matches reported r");
});

test("step: first step from anchor seeds u from signal direction", () => {
  // z_k == z_0 → r_prev = 0. The engine seeds u from g, computes Δθ = 0
  // (g_ort = 0 because g is parallel to u=g/||g||), so degenerate=true and
  // it falls back to linear. Net effect: substrate breathes outward along g.
  const z0 = [0, 0, 0];
  const z = [0, 0, 0];
  const g = [1, 2, 0];
  const out = step(z, g, { z_0: z0 });
  assert.equal(out.degenerate, true);
  assert.deepEqual(out.z_next, [1, 2, 0]);
});

// ---------------------------------------------------------------------------
// step() — confidence semantic

test("step: confidence = ||g_ort|| / ||g||", () => {
  const z0 = [0, 0];
  const z = [1, 0];           // u = (1, 0)
  // 45-degree signal: g = (1, 1) → g_par = (1, 0), g_ort = (0, 1)
  // ||g_ort||/||g|| = 1/√2.
  const out = step(z, [1, 1], { z_0: z0 });
  approx(out.confidence, 1 / Math.SQRT2, 1e-12);
});

// ---------------------------------------------------------------------------
// trajectory()

test("trajectory: path length = signals.length + 1, first entry == z_0", () => {
  const z0 = [0, 0];
  const sigs = [[0, 1], [1, 0], [-1, 0.5]];
  const t = trajectory(z0, sigs);
  assert.equal(t.path.length, sigs.length + 1);
  assert.deepEqual(t.path[0], z0);
  assert.deepEqual(t.path[t.path.length - 1], t.final);
  assert.equal(t.steps, sigs.length);
  assert.equal(t.audit.length, sigs.length);
});

test("trajectory: empty signals returns just the anchor", () => {
  const z0 = [1, 2, 3];
  const t = trajectory(z0, []);
  assert.deepEqual(t.path, [z0]);
  assert.deepEqual(t.final, z0);
  assert.equal(t.steps, 0);
  assert.equal(t.total_radial, 0);
  assert.equal(t.max_alpha, 0);
});

test("trajectory: max_alpha never exceeds policy.alpha_max", () => {
  const z0 = [0, 0];
  const sigs = [];
  for (let i = 0; i < 50; i++) {
    sigs.push([Math.cos(i * 0.7), Math.sin(i * 1.1)]);
  }
  const policy = { alpha_max: Math.PI / 6 };
  const t = trajectory(z0, sigs, policy);
  assert.ok(t.max_alpha <= policy.alpha_max + 1e-12, "max_alpha bounded");
  for (const a of t.audit) {
    assert.ok(a.alpha <= policy.alpha_max + 1e-12);
  }
});

test("trajectory: total_radial accumulates |Δr_k|", () => {
  const z0 = [0, 0];
  const sigs = [[0, 1], [1, 0.5], [-0.5, 0.7]];
  const t = trajectory(z0, sigs);
  let sum = 0;
  for (const a of t.audit) sum += Math.abs(a.delta_r);
  approx(t.total_radial, sum, 1e-12);
});

test("trajectory: degenerate steps counted; LEARN log records every r_k", () => {
  const z0 = [0, 0];
  // Mix: one zero-signal breath, one pure-radial breath, one real turn.
  const sigs = [[0, 0], [1, 0], [0, 1]];
  const t = trajectory(z0, sigs);
  // First two should be degenerate=true (pure-radial / zero-novelty fallback).
  assert.equal(t.audit[0].degenerate, true);
  assert.equal(t.audit[1].degenerate, true);
  // Third has orthogonal novelty.
  assert.equal(t.audit[2].degenerate, false);
  assert.ok(t.audit[2].alpha > 0);
  assert.equal(t.degenerate_count, 2);
  for (const a of t.audit) {
    assert.equal(typeof a.r, "number");
    assert.ok(Number.isFinite(a.r));
  }
});

// ---------------------------------------------------------------------------
// Integration: anchor → trajectory using a soul-genome-shaped object

test("integration: anchor + trajectory on a genome-shaped object", () => {
  const genome = {
    sovereign: { name: "Atom McCree", email: "a.mccree@gmail.com" },
    schema_id: "atomeons.orange5.soul_genome.v1",
    current_intent_id: "test.integration",
    active_project: { charter_id: "ATOM-ORANGE5-MASTER-2026-0623" },
  };
  const a = anchor(genome, { dim: 8 });
  // Build signals that perturb each axis in turn.
  const sigs = [];
  for (let i = 0; i < 8; i++) {
    const s = new Array(8).fill(0);
    s[i] = 1;
    sigs.push(s);
  }
  const t = trajectory(a.z_0, sigs, { alpha_max: Math.PI / 4, beta: 0.5 });
  assert.equal(t.path.length, 9);
  assert.equal(t.audit.length, 8);
  for (const z of t.path) {
    for (const x of z) assert.ok(Number.isFinite(x));
  }
  // Audit log records radial r for every step — the LEARN imperative.
  for (const a of t.audit) {
    assert.equal(typeof a.r, "number");
    assert.ok(a.r >= 0);
  }
});

// ---------------------------------------------------------------------------
// DEFAULT_POLICY sanity

test("DEFAULT_POLICY: alpha_max default is π/4", () => {
  approx(DEFAULT_POLICY.alpha_max, Math.PI / 4, 0);
});
