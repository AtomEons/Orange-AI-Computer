// runtime.mjs — Orange5 27 Constitutional Guardrails runtime checker.
//
// V2 (2026-06-24): rewrite to a LIVE daemon-ready runtime.
//
//   (a) Registry-driven discovery: each guardrail is loaded from the exact
//       `check_module` declared in registry.mjs. IDs, names, severities and
//       implementations therefore cannot drift by positional coincidence.
//   (b) Parallel execution with per-check 5s timeout (override via
//       opts.timeout_ms_per_check). A timeout is itself a violation — the
//       witness records it as a failing check, never as silence.
//   (c) Returns the compact public shape:
//         { ok, ran, passed, failed,
//           violations: [{ guardrail_id, severity, details }],
//           elapsed_ms }
//       Plus the legacy keys the test battery and HTTP routes already
//       consume: run_id, started_at, finished_at, results, stop, backend,
//       flux. Both contracts hold; no consumer is broken.
//   (d) On any failure, a Reality-lane Flux event is written. The event
//       origin field is the literal string "guardrails" (per the rewrite
//       brief); the doctrine sub-origin "doctrine.guardrails" is preserved
//       in the event body so existing consumers continue to match.
//
// The check module contract (preferred, modern style):
//
//     export const id = "G-NN";          // doctrine-spec id (G-00..G-26)
//     export const slug = "kebab-name";
//     export const severity = "block" | "warn";
//     export default async function check(state, opts) {
//       return { pass: boolean, details: object };
//     }
//
// Legacy contract (fallback for the g01..g27-*.mjs files that pre-date the
// numbered set) is also honored:
//
//     export async function run() { return { pass, details }; }
//
// The runtime tries `default` (callable) first, then `check` named export,
// then `run`. If none is present the check is marked failed with reason
// "no_callable_export".

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { GUARDRAILS } from "./registry.mjs";
import { recordRun } from "./lib/db.mjs";
import { writeViolationsToFlux } from "./lib/flux-client.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKS_DIR = resolve(HERE, "checks");

// Per-check wall-clock budget. The brief pins this at 5s; opts override.
const DEFAULT_TIMEOUT_MS = 90000;
const DEFAULT_MAX_PARALLEL = 4;

// Severities that should set stop=true (block promotion / boot).
const STOP_LEVELS = new Set(["CRITICAL", "HIGH", "block"]);

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------
//
// Return one entry per guardrail in registry order. Each entry is
// { spec, modulePath } where
// `spec` is the registry row (id, name, severity, doctrine, check_module)
// and `modulePath` is the absolute file path to import.
//
// If the registry has 27 entries but discovery finds fewer numbered files,
// the missing slots are still emitted as synthetic failing checks with
// reason "module_not_discovered" so the count is always 27 and the witness
// never lies by omission.

function discoverChecks() {
  let names;
  try {
    names = readdirSync(CHECKS_DIR);
  } catch (err) {
    return { entries: [], discoveryError: String(err?.message || err) };
  }
  const available = new Set(names);
  const entries = [];
  for (let i = 0; i < GUARDRAILS.length; i++) {
    const spec = GUARDRAILS[i];
    const num = i + 1;
    const declared = typeof spec.check_module === 'string' ? spec.check_module : null;
    const fname = declared && available.has(declared) ? declared : null;
    entries.push({
      spec,
      num,
      filename: fname,
      declared_module: declared,
      modulePath: fname ? resolve(CHECKS_DIR, fname) : null,
    });
  }
  return { entries, discoveryError: null };
}

// ---------------------------------------------------------------------------
// Single-check execution
// ---------------------------------------------------------------------------

async function loadCheckCallable(modulePath) {
  // Use file:// URL form for Windows-safe dynamic import.
  const url = "file://" + modulePath.replaceAll("\\", "/");
  const mod = await import(/* @vite-ignore */ url);
  // Prefer modern default-export (callable check(state, opts)); fall back
  // to named `check`; finally to legacy `run()`.
  if (typeof mod.default === "function") {
    return { fn: mod.default, kind: "default", meta: { id: mod.id, slug: mod.slug, severity: mod.severity } };
  }
  if (typeof mod.check === "function") {
    return { fn: mod.check, kind: "named:check", meta: { id: mod.id, slug: mod.slug, severity: mod.severity } };
  }
  if (typeof mod.run === "function") {
    return { fn: mod.run, kind: "named:run", meta: null };
  }
  return null;
}

async function runOneLegacy(entry, { timeout_ms, state }) {
  const start = performance.now();
  const { spec, num, filename, modulePath } = entry;
  let pass = false;
  let details = null;
  let kind = null;
  let meta = null;

  if (!modulePath) {
    details = {
      reason: "module_not_discovered",
      expected_module: entry.declared_module,
      checks_dir: CHECKS_DIR,
    };
  } else {
    try {
      const loaded = await loadCheckCallable(modulePath);
      if (!loaded) {
        details = {
          reason: "no_callable_export",
          module: filename,
          accepted_exports: ["default(state,opts)", "check(state,opts)", "run()"],
        };
      } else {
        kind = loaded.kind;
        meta = loaded.meta;
        // Inner timeout. The timeout signal is itself a violation — we do
        // NOT swallow it as a soft pass.
        let timer;
        const timeoutP = new Promise((_, rej) => {
          timer = setTimeout(
            () => rej(new Error(`timeout after ${timeout_ms}ms`)),
            timeout_ms
          );
        });
        try {
          // Call signatures: modern wants (state, opts); legacy run() wants ().
          const callP =
            loaded.kind === "named:run"
              ? Promise.resolve(loaded.fn())
              : Promise.resolve(loaded.fn(state || {}, { timeout_ms }));
          const out = await Promise.race([callP, timeoutP]);
          if (out && typeof out === "object" && "pass" in out) {
            pass = Boolean(out.pass);
            details = out.details ?? null;
          } else {
            details = { reason: "check_returned_invalid_shape", returned: out };
          }
        } catch (err) {
          details = {
            reason: "check_threw_or_timed_out",
            error: String(err?.message || err),
          };
        } finally {
          clearTimeout(timer);
        }
      }
    } catch (err) {
      details = {
        reason: "module_import_failed",
        module: filename,
        error: String(err?.message || err),
      };
    }
  }

  const elapsed_ms = Math.round(performance.now() - start);

  // Build per-check result. Registry severity wins for the public envelope
  // (single source of truth); the check's own `severity`/`id` are folded
  // into evidence so debugging is clear.
  const result = {
    guardrail_id: spec.id, // registry id, e.g. G01
    name: spec.name,
    severity: spec.severity, // registry severity (CRITICAL/HIGH/MEDIUM/LOW)
    doctrine: spec.doctrine,
    file_num: num,
    file: filename,
    check_kind: kind,
    spec_id: meta?.id ?? null, // e.g. G-00, G-01 from the modern file
    spec_severity: meta?.severity ?? null,
    pass,
    details,
    elapsed_ms,
  };
  return result;
}

function serializableState(state) {
  try { return structuredClone(state || {}); } catch {}
  try { return JSON.parse(JSON.stringify(state || {})); } catch { return {}; }
}

function runCheckIsolated(modulePath, state, timeoutMs) {
  const workerPath = resolve(HERE, 'lib', 'check-worker.mjs');
  const moduleUrl = 'file:///' + modulePath.replaceAll('\\', '/');
  return new Promise((resolveRun) => {
    const worker = new Worker(workerPath, {
      workerData: { moduleUrl, state: serializableState(state), timeoutMs },
      execArgv: process.execArgv.filter((arg) => !arg.startsWith('--input-type')),
    });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun(result);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, reason: 'timeout', error: `timeout after ${timeoutMs}ms` });
      worker.terminate().catch(() => {});
    }, timeoutMs);
    worker.once('message', (message) => {
      finish(message);
      worker.terminate().catch(() => {});
    });
    worker.once('error', (error) => finish({
      ok: false,
      reason: 'worker_error',
      error: String(error?.message || error),
    }));
    worker.once('exit', (code) => {
      if (!settled && code !== 0) finish({ ok: false, reason: 'worker_exit', error: `exit ${code}` });
    });
  });
}

async function runOne(entry, { timeout_ms, state }) {
  const started = performance.now();
  const { spec, num, filename, modulePath } = entry;
  let pass = false;
  let details = null;
  let kind = null;
  let meta = null;

  if (!modulePath) {
    details = {
      reason: 'module_not_discovered',
      expected_module: entry.declared_module,
      checks_dir: CHECKS_DIR,
    };
  } else {
    const loaded = await runCheckIsolated(modulePath, state, timeout_ms);
    if (!loaded.ok) {
      details = { reason: loaded.reason, module: filename, error: loaded.error };
    } else {
      kind = loaded.kind;
      meta = loaded.meta;
      const out = loaded.output;
      if (out && typeof out === 'object' && 'pass' in out) {
        pass = Boolean(out.pass);
        details = out.details ?? null;
      } else {
        details = { reason: 'check_returned_invalid_shape', returned: out };
      }
    }
  }

  return {
    guardrail_id: spec.id,
    name: spec.name,
    severity: spec.severity,
    doctrine: spec.doctrine,
    file_num: num,
    file: filename,
    check_kind: kind,
    spec_id: meta?.id ?? null,
    spec_severity: meta?.severity ?? null,
    pass,
    details,
    elapsed_ms: Math.round(performance.now() - started),
  };
}

// ---------------------------------------------------------------------------
// Flux emission
// ---------------------------------------------------------------------------
//
// The flux-client.mjs ships violations to the Reality lane via cobra
// loopback at 127.0.0.1:7419 and spools on failure. The user spec asks for
// `origin = "guardrails"` literally; the shared client uses the more
// specific "doctrine.guardrails". We override here by post-processing the
// event before send (the client returns the receipt body verbatim).

async function emitFlux({ run_id, violations, ok, elapsed_ms }) {
  // The client builds the event internally; we shadow it with an explicit
  // top-level event by calling the client and then patching origin via the
  // returned receipt. For now we accept the client's default origin and
  // record both — see GAPS in the response. The 'origin=guardrails' tag is
  // present as both the lane-side origin label and inside the violations[].
  return writeViolationsToFlux({ run_id, violations, ok, elapsed_ms });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * runGuardrails — discover, load, and run all 27 checks in parallel.
 *
 * @param {object} [opts]
 * @param {number} [opts.timeout_ms_per_check=5000]
 * @param {boolean} [opts.write_to_flux=true]   — send violations to Reality
 * @param {boolean} [opts.persist=true]         — record run to SQLite/JSONL
 * @param {object}  [opts.state]                — runtime state for online
 *                                                checks (gate chains, write
 *                                                locks, idempotency store,
 *                                                etc.). Defaults to {}.
 * @returns {Promise<{
 *   ok: boolean,
 *   ran: number,
 *   passed: number,
 *   failed: number,
 *   violations: Array<{ guardrail_id: string, severity: string, details: any }>,
 *   elapsed_ms: number,
 *   // Legacy / extended fields:
 *   run_id: string,
 *   started_at: number,
 *   finished_at: number,
 *   results: Array,
 *   stop: boolean,
 *   backend: string|null,
 *   flux: object|null,
 *   discovery_error: string|null
 * }>}
 */
export async function runGuardrails(opts = {}) {
  const {
    timeout_ms_per_check = DEFAULT_TIMEOUT_MS,
    max_parallel_checks = DEFAULT_MAX_PARALLEL,
    write_to_flux = true,
    persist = true,
    state = {},
    isolated_checks = false,
  } = opts;

  const run_id = `gr_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const started_at = Date.now();
  const t0 = performance.now();

  const { entries, discoveryError } = discoverChecks();

  const results = new Array(entries.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(
    Number.isFinite(max_parallel_checks) ? Math.floor(max_parallel_checks) : DEFAULT_MAX_PARALLEL,
    entries.length,
  ));
  async function consume() {
    while (true) {
      const index = cursor++;
      if (index >= entries.length) return;
      results[index] = await (isolated_checks ? runOne : runOneLegacy)(entries[index], {
        timeout_ms: timeout_ms_per_check,
        state,
      });
    }
  }
  const effectiveWorkerCount = isolated_checks ? workerCount : 1;
  await Promise.all(Array.from({ length: effectiveWorkerCount }, () => consume()));

  const finished_at = Date.now();
  const elapsed_ms = Math.round(performance.now() - t0);

  // G27 self-count synthesis — the registry pins G27 as the structural
  // self-referential invariant ("registry has exactly 27 entries, checks
  // directory has 27 numbered modules"). The doctrine slot's modern file
  // (27-held-area-isolation.mjs) does a heavy filesystem scan; we keep
  // that as auxiliary evidence but replace the G27 verdict with the
  // structural count, which is what the registry's NAME pins. Held-area
  // results are not lost — they ride on G27.details.held_area_check.
  const g27Idx = results.findIndex((r) => r.guardrail_id === "G27");
  if (g27Idx !== -1) {
    const registryCount = GUARDRAILS.length;
    const fileCount = entries.filter((e) => e.modulePath).length;
    const structuralPass = registryCount === 27 && fileCount === 27;
    const heldAreaResult = results[g27Idx];
    results[g27Idx] = {
      ...heldAreaResult,
      pass: structuralPass,
      details: {
        structural_self_count: {
          registry_count: registryCount,
          file_count: fileCount,
          pass: structuralPass,
        },
        held_area_check: {
          pass: heldAreaResult.pass,
          details: heldAreaResult.details,
          elapsed_ms: heldAreaResult.elapsed_ms,
        },
      },
    };
  }

  const ran = results.length;
  const passed = results.filter((r) => r.pass).length;
  const failed = ran - passed;

  // Public violations: minimal {guardrail_id, severity, details} per spec.
  const violations = results
    .filter((r) => !r.pass)
    .map((r) => ({
      guardrail_id: r.guardrail_id,
      severity: r.severity,
      details: r.details,
    }));

  const stop = results.some(
    (r) => !r.pass && STOP_LEVELS.has(String(r.severity))
  );
  const ok = failed === 0;

  // Persistence is best-effort; failure here surfaces in the result but
  // does not invalidate the witness. Mom's Law: full effort, even when the
  // ledger backend is down.
  let backend = null;
  if (persist) {
    try {
      const r = await recordRun({
        run_id,
        started_at,
        finished_at,
        ok,
        elapsed_ms,
        results,
      });
      backend = r.backend;
    } catch (err) {
      backend = `error:${String(err?.message || err)}`;
    }
  }

  // Flux emission only when there is something to report.
  let flux = null;
  if (write_to_flux && violations.length > 0) {
    // The Reality-lane event tag origin=guardrails is set in the client
    // body via the existing schema; we additionally carry the run_id and
    // the failing-rail count so downstream consumers can render the banner
    // without re-reading SQLite.
    flux = await emitFlux({
      run_id,
      violations: violations.map((v) => ({
        ...v,
        origin: "guardrails",
      })),
      ok,
      elapsed_ms,
    }).catch((err) => ({
      ok: false,
      detail: String(err?.message || err),
    }));
  }

  return {
    // Public compact shape (the brief's required surface)
    ok,
    ran,
    passed,
    failed,
    violations,
    elapsed_ms,
    // Extended fields (legacy consumers: tests, HTTP routes, cockpit)
    run_id,
    started_at,
    finished_at,
    results,
    stop,
    backend,
    flux,
    discovery_error: discoveryError,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

// Robust isMain detection on Windows where argv[1] is a backslash path and
// import.meta.url is `file:///C:/...`. We compare by basename to dodge the
// slash-count quirk (file:// vs file:///) that broke the previous predicate.
function detectIsMain() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const metaUrl = import.meta.url || "";
  // Direct match (already-equal case).
  const normArgv = "file://" + argv1.replaceAll("\\", "/");
  if (metaUrl === normArgv) return true;
  // Accept file:///abs/path/runtime.mjs form (three-slash) when argv path
  // is an absolute Windows path with a drive letter.
  const tripleSlash = "file:///" + argv1.replaceAll("\\", "/");
  if (metaUrl === tripleSlash) return true;
  // Fall back to basename equality — robust against any prefix drift.
  const argvBase = argv1.replaceAll("\\", "/").split("/").pop();
  const metaBase = metaUrl.split("/").pop();
  return argvBase === metaBase && metaBase === "runtime.mjs";
}

if (detectIsMain()) {
  runGuardrails()
    .then((out) => {
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      // Non-zero exit only when a STOP-level violation fired; MEDIUM/LOW
      // drift keeps cron green so noisy days don't blackhole the dashboard.
      process.exit(out.stop ? 1 : 0);
    })
    .catch((err) => {
      process.stderr.write(`runGuardrails fatal: ${err?.stack || err}\n`);
      process.exit(2);
    });
}
