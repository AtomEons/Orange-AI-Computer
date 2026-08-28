// _lib.mjs — shared helpers for Æ Cobra activation gates.
// No external deps. Pure Node/Bun stdlib.

import { performance } from 'node:perf_hooks';

export function now() { return performance.now(); }
export function ms(t0) { return Math.round((performance.now() - t0) * 1000) / 1000; }

/**
 * Wrap a check body so it always returns the canonical shape.
 *   { pass, details, latency_ms }
 * pass === true  → green
 * pass === false → red (test ran, failed)
 * pass === null  → UNKNOWN / not-locally-testable (honest gap; NOT green)
 *
 * `details` must be a JSON-serializable object. It SHOULD include:
 *   - reason         (string, when pass !== true)
 *   - evidence       (object — measurements, sha, counts, samples)
 *   - remote_recipe  (string|null — shell snippet to run on Codexa WSL2 when pass === null)
 */
export async function run(name, env, opts, body) {
  const t0 = now();
  try {
    const r = await body();
    const pass = r.pass;
    if (pass !== true && pass !== false && pass !== null) {
      return {
        pass: false,
        details: { gate: name, reason: 'gate-internal: pass must be true|false|null', got: pass },
        latency_ms: ms(t0),
      };
    }
    return {
      pass,
      details: { gate: name, ...(r.details || {}) },
      latency_ms: ms(t0),
    };
  } catch (e) {
    return {
      pass: false,
      details: { gate: name, reason: 'exception', error: String(e && e.message || e), stack: String(e && e.stack || '') },
      latency_ms: ms(t0),
    };
  }
}

// Default env contract Cobra gates read from. Callers can override via `env`.
export function defaultEnv() {
  return {
    // Where the daemon actually lives
    host_kind: (process.env.AE_COBRA_HOST_KIND || 'auto'),          // 'codexa-wsl2' | 'n150' | 'auto'
    // Loopback inside Codexa WSL2
    llama_url: process.env.AE_COBRA_LLAMA_URL || 'http://127.0.0.1:7418',
    bun_url:   process.env.AE_COBRA_BUN_URL   || 'http://127.0.0.1:7419',
    // Gateway proxy reached from N150 (per Night-1 doctrine)
    gateway_url: process.env.AE_COBRA_GATEWAY_URL || 'http://10.0.99.1:8097/v1/cobra',
    // Flux lanes (per operator's Night-1 doctrine: top-level hash-chained JSONL)
    flux_root:    process.env.AE_FLUX_ROOT || '/mnt/ae_flux',
    flux_reality: process.env.AE_FLUX_REALITY || '/mnt/ae_flux/reality.jsonl',
    flux_thought: process.env.AE_FLUX_THOUGHT || '/mnt/ae_flux/thought.jsonl',
    // Model
    model_path: process.env.AE_COBRA_MODEL || '/opt/atomeons/ae-cobra/models/ae-blackmamba-2.8b-Q5_K_M.gguf',
    model_sha256_expected: process.env.AE_COBRA_MODEL_SHA256 || null,
    // Bounds (operator's 14-point checklist)
    ctx_size_max: Number(process.env.AE_COBRA_CTX_MAX || 1024),
    rss_ceiling_gb: Number(process.env.AE_COBRA_RSS_CEIL_GB || 10),
    ttft_cold_max_s: Number(process.env.AE_COBRA_TTFT_MAX_S || 5),
    json_validity_min: Number(process.env.AE_COBRA_JSON_VALID_MIN || 0.95),
    burn_in_seconds: Number(process.env.AE_COBRA_BURN_IN_S || 60),
  };
}

// Detect whether we're running on Codexa WSL2 (can touch the daemon) or on N150 (can't).
// Heuristic: WSL exposes /proc/version with "microsoft" + /mnt/ae_flux present is even stronger.
export async function detectHost(env) {
  if (env.host_kind && env.host_kind !== 'auto') return env.host_kind;
  try {
    const fs = await import('node:fs/promises');
    const ver = await fs.readFile('/proc/version', 'utf8').catch(() => '');
    const onWsl = /microsoft/i.test(ver);
    const fluxOk = await fs.stat(env.flux_root).then(s => s.isDirectory()).catch(() => false);
    if (onWsl && fluxOk) return 'codexa-wsl2';
    return 'n150';
  } catch {
    return 'n150';
  }
}

// HTTP fetch with timeout (Node 18+/Bun both have global fetch + AbortController).
export async function fetchT(url, opts = {}, timeoutMs = 2000) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(id);
  }
}

// Honest "remote-only" result for gates that physically cannot run on N150.
export function remoteOnly(gate, recipe, extra = {}) {
  return {
    pass: null,
    details: {
      reason: 'not-locally-testable: daemon lives on Codexa WSL2; run this gate from there',
      host_required: 'codexa-wsl2',
      remote_recipe: recipe,
      ...extra,
    },
  };
}
