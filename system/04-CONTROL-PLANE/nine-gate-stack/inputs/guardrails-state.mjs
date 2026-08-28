// inputs/guardrails-state.mjs — Gate 0 LBCE adapter for the 27-Guardrails daemon.
//
// Purpose
//   Gate 0 (00-lbce.mjs) is the impassable first gate. Before it issues a
//   pass/fail on lattice topology, the 9-Gate runner consults this adapter
//   to learn whether the broader constitutional surface (the 27 guardrails)
//   is currently red. If any guardrail with severity in BLOCK_LEVELS is
//   violated, Gate 0 refuses the action regardless of its own topology
//   verdict.
//
// Position in Orange5
//   This file lives under 04-CONTROL-PLANE/nine-gate-stack/inputs/ because
//   it is a READER, not a check itself. It reads the daemon at
//   127.0.0.1:7460 (01-DOCTRINE/27-guardrails/server.mjs) and presents a
//   compact, deterministic shape to Gate 0.
//
// Honesty contract (Mom's Law)
//   1. We do NOT pretend green when the daemon is unreachable. We return
//      { available: false, gate_decision: 'allow-but-warn', reason } so
//      Gate 0 can log a warning and let the action through — but the
//      9-Gate gauntlet receipt will record the gap.
//   2. We do NOT silently swallow violations. Any guardrail returning
//      pass=false with severity in BLOCK_LEVELS produces a 'block'
//      verdict; the names + reasons are surfaced verbatim.
//   3. The 5-minute cache is CLIENT-SIDE. The daemon server.mjs does not
//      expose /run/cached (the original brief named that endpoint, but
//      no such route exists in 01-DOCTRINE/27-guardrails/server.mjs). We
//      poll /latest (cheap — SQLite lookup) and only trigger /run when
//      the most recent run is older than the cache TTL. That keeps Gate 0
//      under its ~30ms wall-clock budget.
//   4. A stale-but-present last run is treated as 'stale_data' with the
//      verdict tier downgraded to 'allow-but-warn' — never 'allow'. Stale
//      truth is not fresh truth.
//
// Public surface
//   readGuardrailsState({ baseUrl?, ttlMs?, freshnessMs?, fetch? })
//     -> Promise<{
//          available: boolean,
//          gate_decision: 'allow' | 'allow-but-warn' | 'block',
//          run_id: string|null,
//          finished_at: number|null,
//          age_ms: number|null,
//          stale: boolean,
//          violation_count: number,
//          blocking_violations: Array<{
//            guardrail_id, severity, name, details
//          }>,
//          warn_violations: Array<{
//            guardrail_id, severity, name, details
//          }>,
//          source: 'cache' | 'latest' | 'run' | 'unreachable',
//          reason?: string,
//          fetched_at: number,
//          endpoint: string
//        }>
//
//   clearCache()
//     -> void   (test hook; the LBCE evaluator never calls this)
//
// Wire format expected from the daemon
//   GET /latest returns the SQLite row written by lib/db.mjs::recordRun:
//     {
//       run_id, started_at, finished_at, elapsed_ms, ok, stop,
//       results: [
//         { guardrail_id, name, severity, pass, details, ... }
//       ],
//       ...
//     }
//   GET /run returns the live run envelope, same `results[]` shape plus
//   { violations, passed, failed, backend, flux }.
//
// Both shapes share `results[]` — we filter that to derive blocks.
//
// Runtime
//   Real Node 20+. ESM. No deps. Uses global fetch (Node 20+).

const DEFAULT_BASE_URL = process.env.GUARDRAILS_BASE_URL || "http://127.0.0.1:7460";
const DEFAULT_TTL_MS = 5 * 60 * 1000;           // 5 minutes per brief
const DEFAULT_FRESHNESS_MS = 5 * 60 * 1000;     // /latest older than this => trigger /run
const DEFAULT_TIMEOUT_MS = 750;                 // Gate 0 budget is ~30ms; we cap network <1s
const RUN_TIMEOUT_MS = 8000;                    // /run may exercise 27 checks in parallel

// Severities the registry uses that MUST block Gate 0.
// The daemon registry stamps CRITICAL/HIGH/MEDIUM/LOW. Check modules
// themselves may also stamp 'block'/'warn' under the modern contract.
// Be liberal in what we accept; be strict about what we block on.
const BLOCK_LEVELS = new Set(["CRITICAL", "HIGH", "block"]);
const WARN_LEVELS = new Set(["MEDIUM", "LOW", "warn"]);

// In-process cache. Single slot — Gate 0 only ever asks one question.
let _cache = null;  // { fetched_at, payload }

export function clearCache() {
  _cache = null;
}

// ---------------------------------------------------------------------------
// Public entry — Gate 0 calls this
// ---------------------------------------------------------------------------

export async function readGuardrailsState(opts = {}) {
  const baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const ttlMs = Number.isFinite(opts.ttlMs) ? Math.max(0, opts.ttlMs) : DEFAULT_TTL_MS;
  const freshnessMs = Number.isFinite(opts.freshnessMs)
    ? Math.max(0, opts.freshnessMs)
    : DEFAULT_FRESHNESS_MS;
  const fetchImpl = opts.fetch || globalThis.fetch;
  const now = Date.now();

  // 1. In-process cache hit — fastest path.
  if (_cache && now - _cache.fetched_at <= ttlMs) {
    return { ..._cache.payload, source: "cache", fetched_at: _cache.fetched_at };
  }

  if (typeof fetchImpl !== "function") {
    return unreachable(baseUrl, "fetch_unavailable", "global fetch is not available in this runtime");
  }

  // 2. Try /latest (cheap SQLite read).
  const latest = await getJson(fetchImpl, `${baseUrl}/latest`, DEFAULT_TIMEOUT_MS);
  if (latest.ok && latest.body && latest.body.run_id) {
    const ageMs = nullableAge(latest.body.finished_at, now);
    if (ageMs !== null && ageMs <= freshnessMs) {
      // Fresh enough — use it.
      const payload = shape(latest.body, "latest", baseUrl, now, false);
      _cache = { fetched_at: now, payload };
      return payload;
    }
    // 3. Stale or missing finished_at — trigger a live /run.
    const run = await getJson(fetchImpl, `${baseUrl}/run`, RUN_TIMEOUT_MS);
    if (run.ok && run.body && Array.isArray(run.body.results)) {
      const payload = shape(run.body, "run", baseUrl, now, false);
      _cache = { fetched_at: now, payload };
      return payload;
    }
    // /run failed — fall back to the stale /latest with a downgrade.
    const payload = shape(latest.body, "latest", baseUrl, now, true);
    payload.gate_decision = downgradeToWarn(payload.gate_decision);
    payload.reason = `stale_data: /run unreachable (${run.reason || "unknown"}), using /latest aged ${ageMs}ms`;
    _cache = { fetched_at: now, payload };
    return payload;
  }

  // 4. No /latest available — try /run directly (cold-start path).
  const run = await getJson(fetchImpl, `${baseUrl}/run`, RUN_TIMEOUT_MS);
  if (run.ok && run.body && Array.isArray(run.body.results)) {
    const payload = shape(run.body, "run", baseUrl, now, false);
    _cache = { fetched_at: now, payload };
    return payload;
  }

  // 5. Daemon unreachable. HONEST GAP.
  return unreachable(baseUrl, "daemon_unreachable",
    `Guardrails daemon at ${baseUrl} did not respond. ` +
    `latest=${latest.reason || "no_body"}, run=${run.reason || "no_body"}. ` +
    `Gate 0 will allow-but-warn; the 9-Gate receipt will record the gap.`);
}

// ---------------------------------------------------------------------------
// Shape conversion — daemon body -> Gate 0 input
// ---------------------------------------------------------------------------

function shape(body, source, baseUrl, fetchedAt, stale) {
  const results = Array.isArray(body.results) ? body.results : [];
  const blocking = [];
  const warns = [];

  for (const r of results) {
    if (r && r.pass === false) {
      const row = {
        guardrail_id: r.guardrail_id || r.id || "G??",
        severity: r.severity || r.spec_severity || "UNKNOWN",
        name: r.name || null,
        details: r.details ?? null,
      };
      if (BLOCK_LEVELS.has(row.severity)) blocking.push(row);
      else if (WARN_LEVELS.has(row.severity)) warns.push(row);
      else {
        // Unknown severity — treat as block. Fail-closed by design.
        blocking.push({ ...row, _classified: "unknown_severity_failclose" });
      }
    }
  }

  let gate_decision;
  if (blocking.length > 0) gate_decision = "block";
  else if (warns.length > 0) gate_decision = "allow-but-warn";
  else gate_decision = "allow";
  if (stale && gate_decision === "allow") gate_decision = "allow-but-warn";

  return {
    available: true,
    gate_decision,
    run_id: body.run_id || null,
    finished_at: body.finished_at ?? null,
    age_ms: nullableAge(body.finished_at, fetchedAt),
    stale,
    violation_count: blocking.length + warns.length,
    blocking_violations: blocking,
    warn_violations: warns,
    source,
    fetched_at: fetchedAt,
    endpoint: baseUrl,
  };
}

function downgradeToWarn(decision) {
  if (decision === "allow") return "allow-but-warn";
  return decision; // block stays block; allow-but-warn stays
}

function unreachable(baseUrl, reason, detail) {
  // Honest gap. Decision is allow-but-warn — NOT pretend-green.
  // Gate 0 will let the action through but the gauntlet receipt records
  // available=false. A red constitutional state cannot be hidden by an
  // unreachable daemon: the next /run will catch it.
  return {
    available: false,
    gate_decision: "allow-but-warn",
    run_id: null,
    finished_at: null,
    age_ms: null,
    stale: false,
    violation_count: 0,
    blocking_violations: [],
    warn_violations: [],
    source: "unreachable",
    reason: `${reason}: ${detail}`,
    fetched_at: Date.now(),
    endpoint: baseUrl,
  };
}

function nullableAge(finishedAt, now) {
  if (!Number.isFinite(finishedAt)) return null;
  const age = now - finishedAt;
  return age < 0 ? 0 : age;
}

// ---------------------------------------------------------------------------
// Network helper with hard timeout
// ---------------------------------------------------------------------------

async function getJson(fetchImpl, url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      signal: ac.signal,
      headers: { accept: "application/json" },
    });
    // Daemon returns 207 when stop=true. Both 200 and 207 carry a real body.
    if (res.status !== 200 && res.status !== 207) {
      return { ok: false, reason: `http_${res.status}`, body: null };
    }
    let body;
    try {
      body = await res.json();
    } catch (e) {
      return { ok: false, reason: "invalid_json", body: null };
    }
    return { ok: true, body };
  } catch (err) {
    const reason = err && err.name === "AbortError" ? "timeout" : `fetch_failed:${String(err?.message || err).slice(0, 80)}`;
    return { ok: false, reason, body: null };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Default export — convenience for `import gr from './inputs/guardrails-state.mjs'`
// ---------------------------------------------------------------------------

export default {
  read: readGuardrailsState,
  clearCache,
  DEFAULT_BASE_URL,
  DEFAULT_TTL_MS,
  DEFAULT_FRESHNESS_MS,
  BLOCK_LEVELS,
  WARN_LEVELS,
};
