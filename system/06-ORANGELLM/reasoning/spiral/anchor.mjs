// Spiral Reasoning anchor — z_0 resolver from the Soul Genome.
//
// Source doctrine:
//   C:/AtomEons/orangebox/docs/SPIRAL_REASONING_INTEGRATION_v1.md
//   Disclosure ID: ATOM-SPIRAL-INTEGRATION-v1-2026-0618
//   Paper: McCree A. (2026). Spiral Reasoning — Orthogonal Bivector Dynamics
//          for Coherent Thought in Latent Space. April 7, 2026.
//
// Contract (per the integration doctrine §2 variable map):
//   z_0 = "Soul Genome at boot — the substrate's identity at first ignition"
//
// This module produces z_0 as a *complex-vector-like* structure {re, im, meta}.
// `re` and `im` are real Float64 arrays of equal length (the substrate's identity
// embedding in a 2D bivector-friendly form); `meta` carries the audit anchors
// that prove the embedding is honest (sovereign, current_intent_id,
// active_project, doctrine_anchors), plus a deterministic fingerprint.
//
// Determinism: the same Soul Genome content always yields the same anchor.
// That is the whole point — every Orange5 chat starts spinning from the same
// origin so trajectories are comparable across sessions.
//
// Mom's Law: real math. No fake init. The embedding is computed from the
// genome's *stable identity surface* (not from volatile fields like clocks or
// queue sizes), so swapping a flow-state value does not silently move z_0.
//
// Node 20+ ESM. No external deps beyond node:crypto and node:fs/promises.

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Canonical anchor pointer

/**
 * Canonical filesystem location of the Soul Genome that anchors Orange5.
 * Override via opts.path on resolveAnchor / loadGenome.
 */
export const DEFAULT_GENOME_PATH =
  resolve(
    process.env.ORANGE5_SOUL_GENOME ||
      resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "13-MODELS", "orange-llm", "soul_genome.json"),
  );

/** Default embedding dimension (matches a bivector-plane-friendly width). */
export const DEFAULT_DIM = 16;

// ---------------------------------------------------------------------------
// Public API

/**
 * Load the Soul Genome from disk.
 * @param {object} [opts]
 * @param {string} [opts.path]  override path; defaults to DEFAULT_GENOME_PATH
 * @returns {Promise<object>}   parsed JSON
 */
export async function loadGenome(opts = {}) {
  const path = opts.path ?? DEFAULT_GENOME_PATH;
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    const e = new Error(
      `anchor.loadGenome: cannot read Soul Genome at ${path}: ${err.message}`,
    );
    e.cause = err;
    e.path = path;
    throw e;
  }
  let genome;
  try {
    genome = JSON.parse(raw);
  } catch (err) {
    const e = new Error(
      `anchor.loadGenome: Soul Genome at ${path} is not valid JSON: ${err.message}`,
    );
    e.cause = err;
    e.path = path;
    throw e;
  }
  if (!genome || typeof genome !== "object" || Array.isArray(genome)) {
    throw new TypeError(
      `anchor.loadGenome: Soul Genome at ${path} did not parse to an object`,
    );
  }
  return genome;
}

/**
 * Pull z_0 from a parsed Soul Genome object.
 *
 * Returns a complex-vector-like structure:
 *   {
 *     re:   Float64Array,   // identity-real component (length = dim)
 *     im:   Float64Array,   // identity-imag component (length = dim)
 *     meta: {
 *       source:           "genome.identity_vector" | "genome.anchor" | "derived:identity-hash",
 *       dim:              number,
 *       fingerprint:      string,           // 16-hex-char digest of (re, im)
 *       genome_path:      string|null,      // null when called directly with a genome object
 *       sovereign:        { name, email, alias, lab_name } | null,
 *       current_intent_id:string|null,
 *       active_project:   { name, charter_id, root } | null,
 *       doctrine_anchors: { operating_manual_root, spiral_reasoning_paper, integration_doctrine } | null,
 *       schema_id:        string|null,
 *       resolved_at_iso:  string,
 *       doctrine: {
 *         disclosure_id: "ATOM-SPIRAL-INTEGRATION-v1-2026-0618",
 *         rule:          "z_0 = Soul Genome anchor",
 *         constraints:   string[],
 *       },
 *     },
 *   }
 *
 * Resolution precedence for the (re, im) components:
 *   1. genome.identity_vector            (object {re, im} or flat [number])
 *   2. genome.anchor.vector / anchor.{re,im}
 *   3. Deterministic SHA-256 embedding seeded by (sovereign, current_intent_id,
 *      active_project.charter_id, schema_id, doctrine_anchors).
 *
 * Same genome content → same z_0. Always.
 *
 * @param {object} genome           parsed soul_genome.json
 * @param {object} [opts]
 * @param {number} [opts.dim=16]    target dimension when deriving the embedding
 * @param {string} [opts.genome_path] for meta.genome_path; informational only
 * @returns {{ re: Float64Array, im: Float64Array, meta: object }}
 */
export function pullAnchor(genome, opts = {}) {
  if (!genome || typeof genome !== "object" || Array.isArray(genome)) {
    throw new TypeError("anchor.pullAnchor: genome must be an object");
  }
  const dim = sanitizeDim(opts.dim, DEFAULT_DIM);

  const { re, im, source } = resolveComponents(genome, dim);
  if (re.length !== im.length) {
    throw new Error(
      `anchor.pullAnchor: re/im dimension mismatch (${re.length} vs ${im.length})`,
    );
  }

  const meta = buildMeta({
    genome,
    re,
    im,
    source,
    genome_path: opts.genome_path ?? null,
  });

  return { re, im, meta };
}

/**
 * Convenience: load the Soul Genome from disk and resolve z_0 in one call.
 *
 * @param {object} [opts]
 * @param {string} [opts.path]   override genome path
 * @param {number} [opts.dim=16] target dimension when deriving
 * @returns {Promise<{ re: Float64Array, im: Float64Array, meta: object }>}
 */
export async function resolveAnchor(opts = {}) {
  const path = opts.path ?? DEFAULT_GENOME_PATH;
  const genome = await loadGenome({ path });
  return pullAnchor(genome, { dim: opts.dim, genome_path: path });
}

/**
 * Pack the complex-vector anchor into a single real Float64Array of length 2*dim
 * by interleaving [re_0, im_0, re_1, im_1, ...]. Useful for feeding the existing
 * engine.mjs `step()` and `trajectory()` (which operate on real d-dim vectors)
 * while preserving the bivector pair structure.
 *
 * @param {{re: ArrayLike<number>, im: ArrayLike<number>}} anchor
 * @returns {Float64Array}  length 2 * dim
 */
export function toRealVector(anchor) {
  if (!anchor || !anchor.re || !anchor.im) {
    throw new TypeError("anchor.toRealVector: expected {re, im}");
  }
  const n = anchor.re.length;
  if (anchor.im.length !== n) {
    throw new RangeError(
      `anchor.toRealVector: re/im length mismatch (${n} vs ${anchor.im.length})`,
    );
  }
  const out = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    out[2 * i] = Number(anchor.re[i]);
    out[2 * i + 1] = Number(anchor.im[i]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Component resolution

function resolveComponents(genome, dim) {
  // 1) explicit identity_vector
  const iv = genome.identity_vector;
  if (iv && typeof iv === "object" && !Array.isArray(iv)
      && Array.isArray(iv.re) && Array.isArray(iv.im)) {
    return {
      re: asF64(iv.re),
      im: asF64(iv.im),
      source: "genome.identity_vector",
    };
  }
  if (Array.isArray(iv) && iv.length > 0) {
    return splitFlatVector(iv, "genome.identity_vector");
  }

  // 2) nested anchor block
  const a = genome.anchor;
  if (a && typeof a === "object") {
    if (Array.isArray(a.re) && Array.isArray(a.im)) {
      return {
        re: asF64(a.re),
        im: asF64(a.im),
        source: "genome.anchor",
      };
    }
    if (Array.isArray(a.vector) && a.vector.length > 0) {
      return splitFlatVector(a.vector, "genome.anchor.vector");
    }
  }

  // 3) deterministic embedding from stable identity surface
  const seed = stableIdentitySeed(genome);
  return {
    re: deriveComponent(seed, "re", dim),
    im: deriveComponent(seed, "im", dim),
    source: "derived:identity-hash",
  };
}

/** Split a flat real array of even length into (re, im); odd length → pad im. */
function splitFlatVector(flat, source) {
  const arr = asF64(flat);
  const half = Math.ceil(arr.length / 2);
  const re = new Float64Array(half);
  const im = new Float64Array(half);
  for (let i = 0; i < half; i++) {
    re[i] = arr[2 * i] ?? 0;
    im[i] = arr[2 * i + 1] ?? 0;
  }
  return { re, im, source };
}

function asF64(x) {
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const v = Number(x[i]);
    if (!Number.isFinite(v)) {
      throw new TypeError(`anchor: component index ${i} is not finite: ${x[i]}`);
    }
    out[i] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Deterministic embedding (when no explicit vector exists in the genome)

function stableIdentitySeed(genome) {
  // ONLY stable identity surface — sovereign, intent, project, schema, doctrine
  // anchors. Volatile bookkeeping (flow_state pressure, queue sizes, timestamps)
  // is intentionally excluded so that workflow churn does not move z_0.
  const sovereign = genome.sovereign ?? {};
  const project = genome.active_project ?? {};
  const doctrine = genome.doctrine_anchors ?? {};

  const parts = [
    `schema:${genome.schema_id ?? genome.$schema ?? ""}`,
    `name:${sovereign.name ?? ""}`,
    `email:${sovereign.email ?? ""}`,
    `alias:${sovereign.alias ?? ""}`,
    `lab:${sovereign.lab_name ?? ""}`,
    `intent:${genome.current_intent_id ?? ""}`,
    `project_name:${project.name ?? ""}`,
    `project_charter:${project.charter_id ?? ""}`,
    `project_root:${project.root ?? ""}`,
    `doctrine_root:${doctrine.operating_manual_root ?? ""}`,
    `spiral_paper:${doctrine?.spiral_reasoning?.paper_path ?? ""}`,
    `spiral_doctrine:${doctrine?.spiral_reasoning?.integration_doctrine_path ?? ""}`,
  ];
  return parts.join("\n");
}

function deriveComponent(seed, label, dim) {
  const out = new Float64Array(dim);
  for (let i = 0; i < dim; i++) {
    const h = createHash("sha256").update(`${seed}|${label}|${i}`).digest();
    // First 8 bytes → uint64 → [-1, 1)
    let v = 0;
    for (let b = 0; b < 8; b++) v = v * 256 + h[b];
    v = v / 2 ** 64;
    out[i] = v * 2 - 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Meta + fingerprint

function buildMeta({ genome, re, im, source, genome_path }) {
  const sovereign = genome.sovereign
    ? {
        name: genome.sovereign.name ?? null,
        email: genome.sovereign.email ?? null,
        alias: genome.sovereign.alias ?? null,
        lab_name: genome.sovereign.lab_name ?? null,
      }
    : null;

  const project = genome.active_project
    ? {
        name: genome.active_project.name ?? null,
        charter_id: genome.active_project.charter_id ?? null,
        root: genome.active_project.root ?? null,
      }
    : null;

  const doctrine_anchors = genome.doctrine_anchors
    ? {
        operating_manual_root: genome.doctrine_anchors.operating_manual_root ?? null,
        spiral_reasoning_paper:
          genome.doctrine_anchors?.spiral_reasoning?.paper_path ?? null,
        integration_doctrine:
          genome.doctrine_anchors?.spiral_reasoning?.integration_doctrine_path ?? null,
        binding: !!genome.doctrine_anchors.binding,
      }
    : null;

  return {
    source,
    dim: re.length,
    fingerprint: fingerprintPair(re, im),
    genome_path,
    sovereign,
    current_intent_id: genome.current_intent_id ?? null,
    active_project: project,
    doctrine_anchors,
    schema_id: genome.schema_id ?? genome.$schema ?? null,
    resolved_at_iso: new Date().toISOString(),
    doctrine: Object.freeze({
      disclosure_id: "ATOM-SPIRAL-INTEGRATION-v1-2026-0618",
      rule: "z_0 = Soul Genome anchor",
      constraints: Object.freeze([
        "bounded angle alpha (Belief Discipline)",
        "exact radial accounting (LEARN imperative)",
        "graceful degeneration (no curvature without signal)",
      ]),
    }),
  };
}

function fingerprintPair(re, im) {
  const h = createHash("sha256");
  const buf = Buffer.alloc(8);
  for (let i = 0; i < re.length; i++) {
    buf.writeDoubleLE(re[i], 0);
    h.update(buf);
  }
  for (let i = 0; i < im.length; i++) {
    buf.writeDoubleLE(im[i], 0);
    h.update(buf);
  }
  return h.digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Helpers

function sanitizeDim(x, fallback) {
  const n = Number.parseInt(x, 10);
  if (!Number.isFinite(n) || n < 2) return fallback;
  return n;
}

// ---------------------------------------------------------------------------
// Internals (exported for tests; kept narrow)

export const __internals = Object.freeze({
  resolveComponents,
  stableIdentitySeed,
  deriveComponent,
  fingerprintPair,
  splitFlatVector,
});

// ---------------------------------------------------------------------------
// CLI: `node anchor.mjs [path]` → print the anchor meta + fingerprint.
// Receipts only, no theater.

const isMain =
  import.meta.url.startsWith("file:") &&
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const argPath = process.argv[2];
  resolveAnchor(argPath ? { path: argPath } : {})
    .then((a) => {
      const out = {
        ok: true,
        source: a.meta.source,
        dim: a.meta.dim,
        fingerprint: a.meta.fingerprint,
        sovereign: a.meta.sovereign,
        current_intent_id: a.meta.current_intent_id,
        active_project: a.meta.active_project,
        doctrine_anchors: a.meta.doctrine_anchors,
        schema_id: a.meta.schema_id,
        resolved_at_iso: a.meta.resolved_at_iso,
        doctrine: a.meta.doctrine,
        re_head: Array.from(a.re.slice(0, 4)),
        im_head: Array.from(a.im.slice(0, 4)),
      };
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    })
    .catch((err) => {
      process.stderr.write(
        JSON.stringify(
          { ok: false, error: err.message, path: err.path ?? null },
          null,
          2,
        ) + "\n",
      );
      process.exit(1);
    });
}
