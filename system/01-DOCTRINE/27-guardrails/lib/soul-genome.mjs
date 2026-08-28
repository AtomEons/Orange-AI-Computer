// soul-genome.mjs — operator continuity config that survives model swaps.
//
// File-based JSON, single source of truth at state/soul-genome.json. This is
// the z_0 anchor for Spiral Reasoning: identity facts, preferences, project
// state pointers, current intent anchors. Read on session start, written on
// explicit operator update — never silently mutated by an agent.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { ORANGE5_ROOT, SOUL_GENOME_PATH } from "./paths.mjs";

const DEFAULT_GENOME = Object.freeze({
  schema: "orange5.soul-genome.v1",
  operator: {
    name: "Operator",
    handle: "Ætom ÆoNs",
    role: "Owner and human final authority",
    location: null,
    email: null,
  },
  preferences: {
    response_register: "engineering-spec, terse, directive",
    no_preamble: true,
    receipts_required: true,
    moms_law_above_all: true,
  },
  project_state: {
    orange5_root: ORANGE5_ROOT,
    active_doctrine_root: resolve(ORANGE5_ROOT, "01-DOCTRINE"),
    cobra_base: "http://127.0.0.1:7419",
    brain_gateway: "http://127.0.0.1:1337",
    cockpit_base: "atomic-orange://native",
  },
  intent_anchors: [
    "OrangeFive governed spine and OrangeBrain routing",
    "27 Constitutional Guardrails preserved",
    "4 lanes immutable (Chat/Cockpit/Vault/Settings)",
    "Reality overrides Thought on conflict",
  ],
  spiral_reasoning: {
    anchor_set: true,
    alpha_bound_radians: 0.35,
    integration_doc:
      "C:/AtomEons/orangebox/docs/SPIRAL_REASONING_INTEGRATION_v1.md",
  },
  updated_at: 0,
});

function ensureParent(p) {
  mkdirSync(dirname(p), { recursive: true });
}

export function readSoulGenome(path = SOUL_GENOME_PATH) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { _read_error: String(e?.message || e), _path: path };
  }
}

export function writeSoulGenome(genome, path = SOUL_GENOME_PATH) {
  ensureParent(path);
  const body = {
    ...genome,
    schema: genome.schema || "orange5.soul-genome.v1",
    updated_at: Date.now(),
  };
  const json = JSON.stringify(body, null, 2);
  writeFileSync(path, json, "utf8");
  return { path, sha256: createHash("sha256").update(json).digest("hex") };
}

export function ensureSoulGenome(path = SOUL_GENOME_PATH) {
  const existing = readSoulGenome(path);
  if (existing && !existing._read_error && existing.schema) return existing;
  writeSoulGenome(DEFAULT_GENOME, path);
  return readSoulGenome(path);
}

export function soulGenomeIsHealthy(genome) {
  if (!genome) return { ok: false, reason: "missing" };
  if (genome._read_error) return { ok: false, reason: genome._read_error };
  if (!genome.schema?.startsWith("orange5.soul-genome.")) {
    return { ok: false, reason: "schema_mismatch" };
  }
  if (!genome.operator?.name) return { ok: false, reason: "operator_name_missing" };
  if (!Array.isArray(genome.intent_anchors) || genome.intent_anchors.length === 0) {
    return { ok: false, reason: "intent_anchors_empty" };
  }
  return { ok: true };
}

// CLI: `node lib/soul-genome.mjs show`
if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}`) {
  const cmd = process.argv[2] || "show";
  if (cmd === "show") {
    const g = ensureSoulGenome();
    process.stdout.write(JSON.stringify(g, null, 2) + "\n");
  } else if (cmd === "init") {
    const r = writeSoulGenome(DEFAULT_GENOME);
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  } else {
    process.stderr.write(`unknown command: ${cmd}\n`);
    process.exit(2);
  }
}

export { DEFAULT_GENOME };
