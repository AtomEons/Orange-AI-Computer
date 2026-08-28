// cartridges/loader.mjs
//
// AtomSmasher module #3 — Cartridges.
//
// Pre-compiled domain capability units, hot-swappable into an active model
// session. Each cartridge is:
//
//   {
//     schema: 'orange5.atomsmasher.cartridge.v0',
//     name:           string  — unique registry key
//     version:        string  — semver
//     summary:        string  — one-line human description
//     capabilities:   string[] — dotted ids (e.g. 'memory.read', 'ui.critique')
//     system_prompt:  string  — text injected into the model's system role
//     tool_cards:     ToolCard[] — {name, description, input_schema}
//     tags:           string[] (optional)
//   }
//
// Doctrine:
//   - The registry.json seed is the ON-DISK truth at boot. The loader reads it,
//     validates every cartridge, and builds an in-memory keyed-by-name table.
//   - Cartridges are CONTENT-ADDRESSED: cartridge_id = sha256(canonical(
//       name, version, capabilities, system_prompt, tool_cards
//     )). Two callers seeding the same cartridge get the same id, so a
//     downstream consumer can prove which cartridge it used.
//   - "Hot-swap" means: the loader's mutate methods (load, swap, unload) only
//     touch the in-memory table and emit an event. Persistence is opt-in via
//     persist(): if the caller wants the change to survive a restart, they
//     call persist() and the loader rewrites registry.json atomically (write
//     to tempfile, fsync, rename). The on-disk registry is therefore always
//     a valid, complete snapshot — no half-written state.
//   - Mom's Law: every error returns a structured result. No silent reject of
//     a malformed cartridge. No silent overwrite of a different version
//     under the same name (use swap() with explicit `expected_version` for
//     that).
//
// What this file does NOT do:
//   - It does not execute tool_cards. Those are descriptors handed to the
//     model layer; tool execution lives in the gateway / tool-runner.
//   - It does not import the cartridge's domain code. A cartridge is a
//     descriptor, not an executable bundle.
//
// Exports:
//   createLoader({registryPath?, log?})  -> Loader instance
//   validateCartridge(cartridge)         -> {valid, errors}
//   computeCartridgeId(cartridge)        -> sha256 hex string
//   CARTRIDGE_SCHEMA_ID
//   REGISTRY_SCHEMA_ID

import crypto from "node:crypto";
import { promises as fsp } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CARTRIDGE_SCHEMA_ID = "orange5.atomsmasher.cartridge.v0";
export const REGISTRY_SCHEMA_ID = "orange5.atomsmasher.cartridge-registry.v0";

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const NAME_RE = /^[a-z][a-z0-9-]*[a-z0-9]$/;
const CAPABILITY_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;
const TOOL_NAME_RE = /^[a-z][a-z0-9_]*$/;

function defaultRegistryPath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "registry.json");
}

// ---------------------------------------------------------------------------
// Canonical JSON + hashing (matches commitment-atoms/encoder.mjs convention)
// ---------------------------------------------------------------------------

function canonicalStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalStringify).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map(
    (k) => JSON.stringify(k) + ":" + canonicalStringify(value[k]),
  );
  return "{" + parts.join(",") + "}";
}

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a cartridge descriptor against the v0 schema.
 *
 * @param {unknown} c
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateCartridge(c) {
  const errors = [];

  if (c == null || typeof c !== "object" || Array.isArray(c)) {
    return { valid: false, errors: ["cartridge must be a non-null object"] };
  }

  if (c.schema !== CARTRIDGE_SCHEMA_ID) {
    errors.push(`schema must be '${CARTRIDGE_SCHEMA_ID}', got '${c.schema}'`);
  }

  if (typeof c.name !== "string" || !NAME_RE.test(c.name)) {
    errors.push(`name must match ${NAME_RE} (got '${c.name}')`);
  }

  if (typeof c.version !== "string" || !SEMVER_RE.test(c.version)) {
    errors.push(`version must be semver (got '${c.version}')`);
  }

  if (typeof c.summary !== "string" || c.summary.length === 0) {
    errors.push("summary must be a non-empty string");
  }

  if (!Array.isArray(c.capabilities) || c.capabilities.length === 0) {
    errors.push("capabilities must be a non-empty array");
  } else {
    for (const cap of c.capabilities) {
      if (typeof cap !== "string" || !CAPABILITY_RE.test(cap)) {
        errors.push(`capability '${cap}' must match ${CAPABILITY_RE}`);
      }
    }
  }

  if (typeof c.system_prompt !== "string" || c.system_prompt.length === 0) {
    errors.push("system_prompt must be a non-empty string");
  }

  if (!Array.isArray(c.tool_cards)) {
    errors.push("tool_cards must be an array");
  } else {
    const seenNames = new Set();
    for (let i = 0; i < c.tool_cards.length; i++) {
      const tc = c.tool_cards[i];
      const ctx = `tool_cards[${i}]`;
      if (tc == null || typeof tc !== "object" || Array.isArray(tc)) {
        errors.push(`${ctx} must be an object`);
        continue;
      }
      if (typeof tc.name !== "string" || !TOOL_NAME_RE.test(tc.name)) {
        errors.push(`${ctx}.name must match ${TOOL_NAME_RE} (got '${tc.name}')`);
      } else if (seenNames.has(tc.name)) {
        errors.push(`${ctx}.name duplicate within cartridge: '${tc.name}'`);
      } else {
        seenNames.add(tc.name);
      }
      if (typeof tc.description !== "string" || tc.description.length === 0) {
        errors.push(`${ctx}.description must be a non-empty string`);
      }
      if (tc.input_schema == null || typeof tc.input_schema !== "object" || Array.isArray(tc.input_schema)) {
        errors.push(`${ctx}.input_schema must be an object (JSON Schema fragment)`);
      }
    }
  }

  if (c.tags !== undefined) {
    if (!Array.isArray(c.tags)) {
      errors.push("tags must be an array of strings");
    } else {
      for (const t of c.tags) {
        if (typeof t !== "string") errors.push("tags must contain only strings");
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Compute the content-addressed cartridge_id for a cartridge.
 *
 * @param {Object} c — must already be a valid cartridge shape
 * @returns {string} sha256 hex
 */
export function computeCartridgeId(c) {
  const payload = canonicalStringify({
    name: c.name,
    version: c.version,
    capabilities: c.capabilities,
    system_prompt: c.system_prompt,
    tool_cards: c.tool_cards,
  });
  return sha256(payload);
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} LoaderEvent
 * @property {'loaded'|'unloaded'|'swapped'|'persisted'} kind
 * @property {string} [name]
 * @property {string} [cartridge_id]
 * @property {string} [prev_version]
 * @property {string} [version]
 * @property {string} ts
 */

class Loader extends EventEmitter {
  constructor({ registryPath, log }) {
    super();
    this.registryPath = registryPath;
    this.log = typeof log === "function" ? log : () => {};
    /** @type {Map<string, Object>} keyed by cartridge name */
    this._byName = new Map();
    /** @type {boolean} */
    this._initialized = false;
  }

  // ----- lifecycle -------------------------------------------------------

  /**
   * Read registry.json from disk and populate the in-memory table.
   * Idempotent — calling init() twice on the same loader is a no-op after
   * the first successful run unless force=true.
   *
   * @param {{force?: boolean}} [opts]
   * @returns {Promise<{ok: boolean, loaded: number, errors: Array<{name?: string, errors: string[]}>}>}
   */
  async init({ force = false } = {}) {
    if (this._initialized && !force) {
      return { ok: true, loaded: this._byName.size, errors: [], already_initialized: true };
    }

    let raw;
    try {
      raw = await fsp.readFile(this.registryPath, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") {
        // Fresh install — empty registry is a valid state.
        this._byName.clear();
        this._initialized = true;
        return { ok: true, loaded: 0, errors: [], registry_missing: true };
      }
      throw err;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return {
        ok: false,
        loaded: 0,
        errors: [{ errors: [`registry.json is not valid JSON: ${err.message}`] }],
      };
    }

    if (parsed?.schema !== REGISTRY_SCHEMA_ID) {
      return {
        ok: false,
        loaded: 0,
        errors: [
          {
            errors: [
              `registry.json schema must be '${REGISTRY_SCHEMA_ID}', got '${parsed?.schema}'`,
            ],
          },
        ],
      };
    }
    if (!Array.isArray(parsed.cartridges)) {
      return {
        ok: false,
        loaded: 0,
        errors: [{ errors: ["registry.json missing cartridges[] array"] }],
      };
    }

    const errors = [];
    const next = new Map();
    for (const c of parsed.cartridges) {
      const v = validateCartridge(c);
      if (!v.valid) {
        errors.push({ name: c?.name, errors: v.errors });
        continue;
      }
      if (next.has(c.name)) {
        errors.push({
          name: c.name,
          errors: [`duplicate cartridge name in registry.json: '${c.name}'`],
        });
        continue;
      }
      const cartridge_id = computeCartridgeId(c);
      next.set(c.name, { ...c, cartridge_id });
    }

    if (errors.length > 0) {
      // We refuse to enter a half-loaded state. If any cartridge in the seed
      // is malformed, the loader stays empty and surfaces the failure.
      return { ok: false, loaded: 0, errors };
    }

    this._byName = next;
    this._initialized = true;
    return { ok: true, loaded: next.size, errors: [] };
  }

  // ----- queries ---------------------------------------------------------

  /** Returns true after a successful init(). */
  isReady() {
    return this._initialized;
  }

  /** Returns the cartridge by name, or null. */
  get(name) {
    return this._byName.get(name) || null;
  }

  /** List all loaded cartridge summaries (without system_prompt body). */
  list() {
    const out = [];
    for (const c of this._byName.values()) {
      out.push({
        name: c.name,
        version: c.version,
        cartridge_id: c.cartridge_id,
        summary: c.summary,
        capabilities: [...c.capabilities],
        tool_count: c.tool_cards.length,
        tags: Array.isArray(c.tags) ? [...c.tags] : [],
      });
    }
    return out;
  }

  /** Full cartridge object (including system_prompt + tool_cards). */
  describe(name) {
    const c = this._byName.get(name);
    if (!c) return null;
    return {
      ...c,
      capabilities: [...c.capabilities],
      tool_cards: c.tool_cards.map((tc) => ({ ...tc, input_schema: { ...tc.input_schema } })),
      tags: Array.isArray(c.tags) ? [...c.tags] : [],
    };
  }

  // ----- hot-swap mutations ---------------------------------------------

  /**
   * Insert a brand-new cartridge. Rejects if `name` already exists — use
   * swap() to replace an existing one.
   *
   * @param {Object} cartridge
   * @returns {{ok: boolean, cartridge_id?: string, errors?: string[]}}
   */
  load(cartridge) {
    const v = validateCartridge(cartridge);
    if (!v.valid) return { ok: false, errors: v.errors };
    if (this._byName.has(cartridge.name)) {
      return {
        ok: false,
        errors: [`cartridge '${cartridge.name}' already loaded; use swap() to replace`],
      };
    }
    const cartridge_id = computeCartridgeId(cartridge);
    this._byName.set(cartridge.name, { ...cartridge, cartridge_id });
    const evt = {
      kind: "loaded",
      name: cartridge.name,
      cartridge_id,
      version: cartridge.version,
      ts: new Date().toISOString(),
    };
    this.emit("event", evt);
    return { ok: true, cartridge_id };
  }

  /**
   * Replace an existing cartridge under the same `name`. If `expected_version`
   * is supplied, the swap only proceeds when the currently-loaded cartridge's
   * version matches — this gives callers a compare-and-set primitive.
   *
   * @param {Object} cartridge
   * @param {{expected_version?: string}} [opts]
   * @returns {{ok: boolean, cartridge_id?: string, prev_version?: string, errors?: string[]}}
   */
  swap(cartridge, { expected_version } = {}) {
    const v = validateCartridge(cartridge);
    if (!v.valid) return { ok: false, errors: v.errors };
    const existing = this._byName.get(cartridge.name);
    if (!existing) {
      return {
        ok: false,
        errors: [`cartridge '${cartridge.name}' not loaded; use load() to insert`],
      };
    }
    if (expected_version !== undefined && existing.version !== expected_version) {
      return {
        ok: false,
        errors: [
          `expected_version mismatch on '${cartridge.name}': expected '${expected_version}', currently '${existing.version}'`,
        ],
      };
    }
    if (existing.version === cartridge.version) {
      return {
        ok: false,
        errors: [
          `swap would not change version of '${cartridge.name}' (still ${cartridge.version}); bump version`,
        ],
      };
    }
    const cartridge_id = computeCartridgeId(cartridge);
    this._byName.set(cartridge.name, { ...cartridge, cartridge_id });
    const evt = {
      kind: "swapped",
      name: cartridge.name,
      cartridge_id,
      prev_version: existing.version,
      version: cartridge.version,
      ts: new Date().toISOString(),
    };
    this.emit("event", evt);
    return { ok: true, cartridge_id, prev_version: existing.version };
  }

  /**
   * Remove a cartridge from the in-memory registry. Returns ok:false if it
   * wasn't loaded — never silently succeeds.
   */
  unload(name) {
    const existing = this._byName.get(name);
    if (!existing) {
      return { ok: false, errors: [`cartridge '${name}' not loaded`] };
    }
    this._byName.delete(name);
    const evt = {
      kind: "unloaded",
      name,
      cartridge_id: existing.cartridge_id,
      version: existing.version,
      ts: new Date().toISOString(),
    };
    this.emit("event", evt);
    return { ok: true, cartridge_id: existing.cartridge_id };
  }

  // ----- persistence ----------------------------------------------------

  /**
   * Atomically rewrite registry.json from the in-memory state.
   * Writes to <path>.tmp, fsyncs, then renames over the target.
   *
   * @returns {Promise<{ok: boolean, path: string, count: number}>}
   */
  async persist() {
    const cartridges = [...this._byName.values()].map((c) => {
      // Strip the derived cartridge_id from the on-disk shape; it's recomputed
      // on load. Persisting it would mean two sources of truth.
      const { cartridge_id, ...rest } = c;
      return rest;
    });
    const payload = {
      schema: REGISTRY_SCHEMA_ID,
      version: 1,
      generated_at: new Date().toISOString(),
      cartridges,
    };
    const json = JSON.stringify(payload, null, 2) + "\n";
    const tmpPath = this.registryPath + ".tmp." + process.pid + "." + Date.now();
    await fsp.mkdir(path.dirname(this.registryPath), { recursive: true });
    const fh = await fsp.open(tmpPath, "w");
    try {
      await fh.writeFile(json, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmpPath, this.registryPath);
    const evt = {
      kind: "persisted",
      ts: new Date().toISOString(),
      path: this.registryPath,
      count: cartridges.length,
    };
    this.emit("event", evt);
    return { ok: true, path: this.registryPath, count: cartridges.length };
  }
}

/**
 * Construct a Cartridges loader. The loader is not initialized until init()
 * resolves — call sites should await that before serving requests.
 *
 * @param {{registryPath?: string, log?: (line: string) => void}} [opts]
 * @returns {Loader}
 */
export function createLoader(opts = {}) {
  const registryPath = opts.registryPath || defaultRegistryPath();
  return new Loader({ registryPath, log: opts.log });
}

// ---------------------------------------------------------------------------
// Re-exports for downstream tooling / tests
// ---------------------------------------------------------------------------

export const __internals = Object.freeze({
  canonicalStringify,
  sha256,
  defaultRegistryPath,
  SEMVER_RE,
  NAME_RE,
  CAPABILITY_RE,
  TOOL_NAME_RE,
});
