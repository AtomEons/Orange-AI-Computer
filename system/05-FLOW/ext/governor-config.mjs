// Flowstate ext — configurable backpressure thresholds.
// Path: 05-FLOW/ext/governor-config.mjs
//
// The built-in governor hardcodes cap=3 at the tick() call site. This module
// gives the spine a validated, frozen config object to thread into
// tick(state, { concurrency_cap: cfg.max_concurrent_currents }) and into
// ext/governor-decide.mjs. Pure: no I/O, no globals, no Date.now.
// Imports nothing from 05-FLOW/src and modifies nothing there.

export const DEFAULT_GOVERNOR_CONFIG = Object.freeze({
  // Hard cap on currents in_progress at once (mirrors the built-in
  // governorConcurrencyCap default of 3).
  max_concurrent_currents: 3,
  // New currents admitted per tick window (spawn rate).
  max_spawn_per_tick: 5,
  // Total non-closed currents before admission stops.
  max_open_currents: 50,
});

const FIELD_RULES = Object.freeze({
  max_concurrent_currents: { min: 1, max: 10_000 },
  max_spawn_per_tick: { min: 1, max: 10_000 },
  max_open_currents: { min: 1, max: 1_000_000 },
});

export const GOVERNOR_CONFIG_KEYS = Object.freeze(Object.keys(FIELD_RULES));

// Pressure-level doctrine shared by governor-decide + backpressure-metrics.
export const ELEVATED_AT = 0.7;
export const PRESSURE_LEVELS = Object.freeze(["ok", "elevated", "saturated"]);

/** Map a utilization ratio (0..inf) to a pressure level. */
export function levelForRatio(ratio) {
  if (!Number.isFinite(ratio) || ratio < 0) return "ok";
  if (ratio >= 1) return "saturated";
  if (ratio >= ELEVATED_AT) return "elevated";
  return "ok";
}

/**
 * Validate a complete config object.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateGovernorConfig(cfg) {
  if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) {
    return { ok: false, errors: ["config must be a plain object"] };
  }
  const errors = [];
  for (const key of Object.keys(cfg)) {
    if (!(key in FIELD_RULES)) errors.push(`unknown key: ${key}`);
  }
  for (const [key, rule] of Object.entries(FIELD_RULES)) {
    if (!(key in cfg)) {
      errors.push(`missing key: ${key}`);
      continue;
    }
    const v = cfg[key];
    if (typeof v !== "number" || !Number.isInteger(v)) {
      errors.push(`${key} must be an integer, got ${typeof v === "number" ? v : typeof v}`);
    } else if (v < rule.min || v > rule.max) {
      errors.push(`${key} out of range [${rule.min}..${rule.max}]: ${v}`);
    }
  }
  if (errors.length === 0 && cfg.max_concurrent_currents > cfg.max_open_currents) {
    errors.push("max_concurrent_currents cannot exceed max_open_currents");
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Merge overrides onto DEFAULT_GOVERNOR_CONFIG, validate, freeze.
 * Throws TypeError on unknown keys or invalid values — a misconfigured
 * governor must fail loudly at boot, not silently mis-throttle at runtime.
 */
export function createGovernorConfig(overrides = {}) {
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("governor config overrides must be a plain object");
  }
  for (const key of Object.keys(overrides)) {
    if (!(key in FIELD_RULES)) throw new TypeError(`unknown governor config key: ${key}`);
  }
  const cfg = { ...DEFAULT_GOVERNOR_CONFIG, ...overrides };
  const { ok, errors } = validateGovernorConfig(cfg);
  if (!ok) throw new TypeError(`invalid governor config: ${errors.join("; ")}`);
  return Object.freeze(cfg);
}

/**
 * Build a config from environment-style key/values. Pure: the caller passes
 * the env object (the scheduler passes process.env at its edge).
 * Recognized keys: FLOW_MAX_CONCURRENT_CURRENTS, FLOW_MAX_SPAWN_PER_TICK,
 * FLOW_MAX_OPEN_CURRENTS (prefix configurable). Unset/empty keys fall back
 * to defaults; present-but-non-numeric keys throw.
 */
export function configFromEnv(env = {}, { prefix = "FLOW_" } = {}) {
  const overrides = {};
  for (const key of GOVERNOR_CONFIG_KEYS) {
    const envKey = prefix + key.toUpperCase();
    const raw = env[envKey];
    if (raw === undefined || raw === null || raw === "") continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      throw new TypeError(`${envKey} is not numeric: ${JSON.stringify(raw)}`);
    }
    overrides[key] = n; // non-integers rejected by createGovernorConfig
  }
  return createGovernorConfig(overrides);
}
