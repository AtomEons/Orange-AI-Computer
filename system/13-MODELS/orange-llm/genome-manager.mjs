// genome-manager.mjs
// Soul Genome manager for Orange5 / orange-llm.
//
// Single source of truth for operator continuity across model swaps.
// File-based JSON (no DB) to keep the genome diff-readable and grep-able.
// Atomic writes via temp-file + rename to survive crashes mid-write.
//
// Public API:
//   load()                                  -> Promise<Genome>
//   update(patch, opts?)                    -> Promise<Genome>   // shallow merge by default; deep merge when opts.deep
//   inject_into_chat_system_role(messages?) -> Promise<Messages> // returns messages array with a system-role first-turn injection
//
// Used by the gateway memory-inject middleware as the first-turn context.
//
// Node 20+. No external deps.

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ---- Paths -----------------------------------------------------------------

const GENOME_PATH = process.env.SOUL_GENOME_PATH
  ? path.resolve(process.env.SOUL_GENOME_PATH)
  : path.join(__dirname, "soul_genome.json");

// ---- In-process cache ------------------------------------------------------

let _cache = null;        // last parsed genome object
let _cache_mtime_ms = 0;  // mtime of file when cached
let _write_lock = Promise.resolve(); // serialize concurrent update() calls

// ---- Helpers ---------------------------------------------------------------

function is_plain_object(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function deep_merge(target, patch) {
  if (!is_plain_object(target)) return structuredClone(patch);
  const out = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    if (is_plain_object(v) && is_plain_object(out[k])) {
      out[k] = deep_merge(out[k], v);
    } else {
      out[k] = structuredClone(v);
    }
  }
  return out;
}

async function file_mtime_ms(p) {
  try {
    const st = await fs.stat(p);
    return st.mtimeMs;
  } catch (err) {
    if (err.code === "ENOENT") return 0;
    throw err;
  }
}

async function atomic_write_json(target_path, obj) {
  const dir = path.dirname(target_path);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(target_path)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  const body = JSON.stringify(obj, null, 2) + "\n";
  await fs.writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, target_path);
}

// ---- Public: load() --------------------------------------------------------

/**
 * Load the Soul Genome from disk. Returns the cached copy if the file's mtime
 * hasn't moved since the last read. Throws if the file is missing or malformed
 * — the gateway should NOT silently fall back to defaults (fake-green intolerance).
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force] - skip cache, re-read from disk
 * @returns {Promise<object>}
 */
export async function load(opts = {}) {
  const force = !!opts.force;
  const mtime = await file_mtime_ms(GENOME_PATH);

  if (!force && _cache && mtime === _cache_mtime_ms && mtime > 0) {
    return structuredClone(_cache);
  }

  let raw;
  try {
    raw = await fs.readFile(GENOME_PATH, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(
        `Soul Genome missing at ${GENOME_PATH}. ` +
        `Bootstrap it (soul_genome.json) before starting the gateway. ` +
        `No silent default — operator continuity must be explicit.`,
      );
    }
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Soul Genome at ${GENOME_PATH} is malformed JSON: ${err.message}`);
  }

  if (!is_plain_object(parsed) || !parsed.sovereign || !parsed.sovereign.name) {
    throw new Error(`Soul Genome at ${GENOME_PATH} is missing required field 'sovereign.name'`);
  }

  _cache = parsed;
  _cache_mtime_ms = mtime;
  return structuredClone(parsed);
}

// ---- Public: update() ------------------------------------------------------

/**
 * Apply a patch to the Soul Genome and write it back atomically.
 * Serialized via an internal write lock so concurrent calls don't tear the file.
 *
 * @param {object} patch - fields to merge
 * @param {object} [opts]
 * @param {boolean} [opts.deep]    - deep-merge nested objects (default true)
 * @param {string}  [opts.actor]   - free-form actor label written to updated_by
 * @returns {Promise<object>} the new genome
 */
export async function update(patch, opts = {}) {
  if (!is_plain_object(patch)) {
    throw new TypeError("update(patch): patch must be a plain object");
  }
  const deep = opts.deep !== false;
  const actor = typeof opts.actor === "string" && opts.actor.length > 0
    ? opts.actor
    : "genome-manager.update";

  // Serialize writes — last writer waits.
  const run = _write_lock.then(async () => {
    const current = await load({ force: true });
    const merged = deep ? deep_merge(current, patch) : { ...current, ...patch };
    merged.updated_at = new Date().toISOString();
    merged.updated_by = actor;
    await atomic_write_json(GENOME_PATH, merged);
    _cache = merged;
    _cache_mtime_ms = await file_mtime_ms(GENOME_PATH);
    return structuredClone(merged);
  });

  // Keep the chain alive even on failure so subsequent updates still run.
  _write_lock = run.catch(() => {});
  return run;
}

// ---- Render: genome -> system-role text ------------------------------------

/**
 * Render a compact, model-readable system-role payload from the genome.
 * Stays terse on purpose — the gateway should not flood the context window
 * with the full doctrine corpus; this is the orientation header.
 */
export function render_system_role_text(g) {
  const lines = [];
  lines.push("# Operator Soul Genome (Orange5 — first-turn context)");
  lines.push("");
  lines.push(`Sovereign: ${g.sovereign?.name || "(unset)"} <${g.sovereign?.email || "?"}>`);
  if (g.sovereign?.role)      lines.push(`Role: ${g.sovereign.role}`);
  if (g.sovereign?.authority) lines.push(`Authority: ${g.sovereign.authority}`);
  if (g.location) {
    const loc = [g.location.city, g.location.region, g.location.country].filter(Boolean).join(", ");
    lines.push(`Location: ${loc}${g.location.timezone ? ` (${g.location.timezone})` : ""}`);
  }
  lines.push("");
  if (g.preferences) {
    lines.push("## Preferences");
    if (g.preferences.response_register)       lines.push(`- Register: ${g.preferences.response_register}`);
    if (g.preferences.tight_responses)         lines.push(`- Tight responses: required`);
    if (g.preferences.fake_green_intolerance)  lines.push(`- Fake-green intolerance: ${g.preferences.fake_green_intolerance}`);
    if (g.preferences.moms_law)                lines.push(`- Mom's Law: ${g.preferences.moms_law}`);
    if (g.preferences.no_simulation)           lines.push(`- No simulation: ${g.preferences.no_simulation}`);
    if (g.preferences.search_before_claim)     lines.push(`- Search before claim: required for present-day facts`);
    if (g.preferences.receipts_required)       lines.push(`- Receipts: ${g.preferences.receipts_required}`);
    if (g.preferences.model_hierarchy) {
      const h = g.preferences.model_hierarchy;
      lines.push(`- Model hierarchy: claude=${h.claude}; gpt=${h.gpt}; gemini=${h.gemini}`);
    }
    lines.push("");
  }
  if (g.current_intent_id || g.current_intent_summary) {
    lines.push("## Current intent");
    if (g.current_intent_id)      lines.push(`- id: ${g.current_intent_id}`);
    if (g.current_intent_summary) lines.push(`- summary: ${g.current_intent_summary}`);
    lines.push("");
  }
  if (g.active_project) {
    lines.push("## Active project");
    lines.push(`- name: ${g.active_project.name}`);
    if (g.active_project.root)          lines.push(`- root: ${g.active_project.root}`);
    if (g.active_project.doctrine_root) lines.push(`- doctrine root: ${g.active_project.doctrine_root}`);
    if (Array.isArray(g.active_project.lanes_immutable) && g.active_project.lanes_immutable.length) {
      lines.push(`- immutable lanes: ${g.active_project.lanes_immutable.join(", ")}`);
    }
    lines.push("");
  }
  if (g.hardware) {
    lines.push("## Hardware");
    if (g.hardware.primary_node) {
      const n = g.hardware.primary_node;
      lines.push(`- ${n.name}: ${n.cpu || "?"} / ${n.ram_gb ? n.ram_gb + "GB" : "?"} RAM / ${n.storage || "?"} (${n.os || "?"})`);
    }
    if (g.hardware.orchestrator) {
      const o = g.hardware.orchestrator;
      lines.push(`- ${o.name}: ${o.role || ""}${o.interface ? " — " + o.interface : ""}`);
    }
    lines.push("");
  }
  if (g.runtime_pointers) {
    lines.push("## Runtime pointers");
    const rp = g.runtime_pointers;
    if (rp.gateway_url)       lines.push(`- gateway: ${rp.gateway_url}`);
    if (rp.cockpit_url)       lines.push(`- cockpit: ${rp.cockpit_url}`);
    if (rp.ae_cobra_url)      lines.push(`- AE Cobra: ${rp.ae_cobra_url}`);
    if (rp.soul_genome_path)  lines.push(`- soul genome: ${rp.soul_genome_path}`);
    if (rp.ledger_root)       lines.push(`- ledger root: ${rp.ledger_root}`);
    lines.push("");
  }
  if (g.guardrails && Array.isArray(g.guardrails.invariants)) {
    lines.push(`## Guardrails: ${g.guardrails.count || g.guardrails.invariants.length} constitutional invariants ENFORCED`);
    lines.push("Top-bound invariants (full set in soul_genome.json):");
    const headline = g.guardrails.invariants.slice(0, 9);
    for (const inv of headline) {
      lines.push(`- ${inv.id}. ${inv.name}: ${inv.rule}`);
    }
    if (g.guardrails.invariants.length > headline.length) {
      lines.push(`- ... (${g.guardrails.invariants.length - headline.length} more in genome file)`);
    }
    lines.push("");
  }
  lines.push(`updated_at: ${g.updated_at || "(unset)"}`);
  return lines.join("\n");
}

// ---- Public: inject_into_chat_system_role() --------------------------------

/**
 * Take an OpenAI/Anthropic-style messages array and inject the Soul Genome as
 * a system-role message at index 0 (or merge into an existing system block).
 * Designed for the gateway memory-inject middleware.
 *
 * @param {Array<{role: string, content: string|object}>} [messages]
 * @param {object} [opts]
 * @param {"prepend"|"merge"} [opts.mode]  - "prepend" (default) inserts a new system msg; "merge" concats into existing system msg if present
 * @param {object} [opts.genome]            - pass a preloaded genome to skip a disk read
 * @returns {Promise<Array>} new messages array (input is not mutated)
 */
export async function inject_into_chat_system_role(messages = [], opts = {}) {
  const mode = opts.mode === "merge" ? "merge" : "prepend";
  const genome = opts.genome || await load();
  const text = render_system_role_text(genome);
  const sys = { role: "system", content: text };

  const out = Array.isArray(messages) ? messages.slice() : [];

  if (mode === "merge") {
    const idx = out.findIndex((m) => m && m.role === "system");
    if (idx >= 0) {
      const existing = out[idx];
      const existing_text = typeof existing.content === "string"
        ? existing.content
        : JSON.stringify(existing.content);
      out[idx] = { role: "system", content: `${text}\n\n---\n\n${existing_text}` };
      return out;
    }
  }
  out.unshift(sys);
  return out;
}

// ---- Default export --------------------------------------------------------

export default {
  load,
  update,
  inject_into_chat_system_role,
  render_system_role_text,
  GENOME_PATH,
};
