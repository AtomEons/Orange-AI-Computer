// 08-HERMES/src/pre-action/kill-switch.mjs
//
// Hermes pre-action kill-switch for the AE Misfit second-opinion gate.
//
// Reads the environment variable HERMES_MISFIT_DISABLED. When it is set to a
// truthy value, the second-opinion middleware is BYPASSED entirely — actions
// fall through to LOOM 8 gates with NO Misfit second-opinion consulted. While
// the bypass is active, a loud "Reality Flux" warning is emitted on the
// configured logger at most once per warning interval (default 5 minutes).
//
// Doctrine anchor (Wave 3-04 + this workflow):
//   - The kill-switch is an explicit, named operator escape hatch.
//   - It is loud, not silent: every check while disabled logs a warning at the
//     interval boundary so the operator cannot forget it is off.
//   - The bypass return value is honest: { bypass: true, reason: 'kill-switch-active' }
//     so the middleware records the bypass in its audit trail.
//   - The default return is { bypass: false } — no second-opinion is skipped
//     unless the env var is explicitly set.
//
// Mom's Law: this module is real enforcement, not theater. Every input is
// inspected. Every warning is emitted. No silent-fallback. No fake success.
//
// Schema: orange5.hermes.kill-switch.v0
// Sovereign: Atom McCree

// ----------------------------------------------------------------------------
// Constants

export const SCHEMA = "orange5.hermes.kill-switch.v0";

export const ENV_VAR = "HERMES_MISFIT_DISABLED";

export const REASON_ACTIVE = "kill-switch-active";

// Default warning interval: 5 minutes, expressed in milliseconds.
export const DEFAULT_WARN_INTERVAL_MS = 5 * 60 * 1000;

// The values that count as "the kill-switch is ON". Anything else is OFF.
// We accept "1", "true", "yes", "on" case-insensitively; "0", "false", "",
// undefined, and unset env are OFF. Anything ambiguous is OFF — to disable
// the gate you must say so explicitly. Mom's Law on ambiguity.
const TRUTHY_VALUES = new Set(["1", "true", "yes", "on"]);

// ----------------------------------------------------------------------------
// Module-private state (the rate-limit cursor)
//
// Stored at module scope so that multiple calls within the same process share
// the cadence. Tests can reset via __resetWarnCursor().

let _lastWarnAtMs = 0;

// ----------------------------------------------------------------------------
// Helpers (pure-ish: env / clock / logger are explicit dependencies)

function readEnvFlag(envObj) {
  const source = envObj || (typeof process !== "undefined" ? process.env : {});
  const raw = source ? source[ENV_VAR] : undefined;
  if (raw === undefined || raw === null) return false;
  const v = String(raw).trim().toLowerCase();
  return TRUTHY_VALUES.has(v);
}

function defaultNow() {
  return Date.now();
}

function defaultLogger(level, payload) {
  // Default logger writes a structured single-line JSON envelope to stderr so
  // the operator sees it even if stdout is being piped into a receipt.
  // Callers in tests pass a mock logger to capture the calls.
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    source: "08-HERMES/kill-switch",
    ...payload,
  });
  // Use console.warn for warn/error so it lands on stderr; info on stdout.
  if (level === "warn" || level === "error") {
    // eslint-disable-next-line no-console
    console.warn(line);
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }
}

function emitRealityFluxWarning(logger, nowMs, intervalMs) {
  // Rate-limit: only emit if at least intervalMs have passed since the last
  // warning. The cursor is updated AFTER emission so the first call always
  // warns (because _lastWarnAtMs starts at 0).
  if (nowMs - _lastWarnAtMs < intervalMs) return false;
  _lastWarnAtMs = nowMs;
  logger("warn", {
    event: "reality_flux.kill_switch_active",
    schema: SCHEMA,
    env_var: ENV_VAR,
    message:
      "REALITY FLUX: Hermes Misfit second-opinion gate is DISABLED via " +
      ENV_VAR +
      "=1. Actions are bypassing the Misfit advisory/blocking layer and " +
      "falling through to LOOM 8 only. Unset the env var to restore the gate.",
    interval_ms: intervalMs,
    next_warning_at: new Date(nowMs + intervalMs).toISOString(),
  });
  return true;
}

// ----------------------------------------------------------------------------
// Public API

/**
 * Check the kill-switch. If active, emits a rate-limited Reality Flux warning
 * and returns { bypass: true, reason: 'kill-switch-active' }. Otherwise
 * returns { bypass: false }.
 *
 * @param {Object} [opts]
 * @param {Object} [opts.env]         - env object override (defaults to process.env)
 * @param {Function} [opts.now]       - clock override () => number (ms)
 * @param {Function} [opts.logger]    - logger override (level, payload) => void
 * @param {number}  [opts.warnIntervalMs] - rate-limit interval in ms (default 5min)
 *
 * @returns {{ bypass: boolean, reason?: string, schema: string, env_var: string, warned?: boolean }}
 */
export function checkKillSwitch(opts = {}) {
  const env = opts.env || (typeof process !== "undefined" ? process.env : {});
  const now = typeof opts.now === "function" ? opts.now : defaultNow;
  const logger = typeof opts.logger === "function" ? opts.logger : defaultLogger;
  const warnIntervalMs =
    Number.isFinite(opts.warnIntervalMs) && opts.warnIntervalMs >= 0
      ? opts.warnIntervalMs
      : DEFAULT_WARN_INTERVAL_MS;

  const active = readEnvFlag(env);

  if (!active) {
    return {
      bypass: false,
      schema: SCHEMA,
      env_var: ENV_VAR,
    };
  }

  // Active: emit (rate-limited) and return bypass verdict.
  const warned = emitRealityFluxWarning(logger, now(), warnIntervalMs);

  return {
    bypass: true,
    reason: REASON_ACTIVE,
    schema: SCHEMA,
    env_var: ENV_VAR,
    warned,
  };
}

/**
 * Pure read of the kill-switch state. Does NOT emit warnings, does NOT touch
 * the rate-limit cursor. Use for introspection / status endpoints.
 *
 * @param {Object} [env] - env object override (defaults to process.env)
 * @returns {boolean}
 */
export function isKillSwitchActive(env) {
  return readEnvFlag(env);
}

// ----------------------------------------------------------------------------
// Test hooks

export function __resetWarnCursor() {
  _lastWarnAtMs = 0;
}

export function __getWarnCursor() {
  return _lastWarnAtMs;
}

export const __internals = Object.freeze({
  SCHEMA,
  ENV_VAR,
  REASON_ACTIVE,
  DEFAULT_WARN_INTERVAL_MS,
  TRUTHY_VALUES,
  readEnvFlag,
  defaultNow,
  defaultLogger,
  emitRealityFluxWarning,
});
