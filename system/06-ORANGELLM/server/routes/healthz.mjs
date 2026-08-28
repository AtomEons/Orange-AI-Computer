// /healthz — operator-visible system check.
// Probes upstream Smart Skinny and reports live/dead.
//
// HANG FIX (2026-07-28, found via the Atomic Orange heartbeat): this endpoint
// could block indefinitely. probeUpstream("heavy") fetches CODEXA.local — an
// mDNS name — and a stalled mDNS lookup blocks BEFORE AbortController can
// cancel it: an abort signal cannot interrupt a hung DNS resolve in Node fetch.
// /v1/models shares the same probes and was only fast when the lookup was
// cached. A health endpoint that can hang is worse than one reporting failure,
// because every consumer then reads a LIVE system as dead — which is exactly
// what happened to Atomic Orange for an entire session.
// It now always answers within the budget and says probe_timeout honestly.

import { probeUpstreamBudgeted } from "../upstream.mjs";
import { resolveComputeEndpointsSync } from "../../../03-BACKEND/compute-fabric.mjs";
import { learningQueueSnapshot } from "../../../03-BACKEND/learning-queue.mjs";
import { __memoryHandlers, createMemoryRouteConfig } from "./memory.mjs";

const MEMORY_CFG = createMemoryRouteConfig();
const SPECIALIST_TTL_MS = Math.max(5_000, Number(process.env.ORANGE5_HEALTH_SPECIALIST_TTL_MS || 30_000));
let specialistCache = null;
let specialistRefresh = null;

function scheduleSpecialistRefresh() {
  if (specialistRefresh) return specialistRefresh;
  specialistRefresh = Promise.all([
    probeUpstreamBudgeted("code"),
    probeUpstreamBudgeted("heavy"),
  ]).then(([code, heavy]) => {
    specialistCache = { at: Date.now(), code, heavy };
    return specialistCache;
  }).catch((error) => {
    specialistCache = {
      at: Date.now(),
      code: { tier: 'code', status: 'probe_error', live: false, note: error?.message || String(error) },
      heavy: { tier: 'heavy', status: 'probe_error', live: false, note: error?.message || String(error) },
    };
    return specialistCache;
  }).finally(() => {
    specialistRefresh = null;
  });
  return specialistRefresh;
}

function specialistSnapshot() {
  const ageMs = specialistCache ? Math.max(0, Date.now() - specialistCache.at) : null;
  const stale = ageMs == null || ageMs > SPECIALIST_TTL_MS;
  if (stale) void scheduleSpecialistRefresh();
  const pending = (tier) => ({
    tier,
    status: 'probe_pending',
    live: false,
    note: 'specialist inventory refresh is running outside the critical health path',
  });
  return {
    code: specialistCache?.code || pending('code'),
    heavy: specialistCache?.heavy || pending('heavy'),
    cache: {
      hit: specialistCache != null,
      stale,
      age_ms: ageMs,
      ttl_ms: SPECIALIST_TTL_MS,
      refresh_running: specialistRefresh != null,
    },
  };
}

export async function handleHealthz({ version }) {
  const fabric = resolveComputeEndpointsSync();
  // Critical readiness only waits for the always-hot Navigator and memory.
  // Slow specialist discovery refreshes outside this request and is reported
  // with explicit age/staleness metadata below.
  const [navigator, memory] = await Promise.all([
    probeUpstreamBudgeted("navigator"),
    __memoryHandlers.handleMemoryHealth(MEMORY_CFG),
  ]);
  const specialists = specialistSnapshot();
  const learningQueue = learningQueueSnapshot();

  return {
    status: navigator.live ? "ok" : "degraded",
    service: "orangellm-gateway",
    version,
    boundary: "frontier_isolation_active",
    upstream: {
      reflex: {
        tier: "reflex",
        status: "live",
        live: true,
        runtime: "bun-deterministic-router",
        model_resident: false,
      },
      navigator,
      code: specialists.code,
      fatty: specialists.heavy,
    },
    primary: {
      tier: "navigator",
      live: navigator.live,
      warm: navigator.model_loaded === true,
      model: navigator.model,
      host: fabric.inferenceHost || "codexa",
    },
    memory,
    learning_queue: learningQueue,
    fabric,
    specialist_probe_cache: specialists.cache,
    routes: {
      allowed: [
        "GET /livez",
        "GET /healthz",
        "GET /v1/models",
        "GET /v1/ops/learning",
        "GET /v1/ops/traces",
        "GET|POST /v1/party-line",
        "GET /v1/party-line/stream",
        "POST /v1/party-line/hydrate",
        "POST /v1/chat/completions",
        "GET /v1/memory/healthz",
        "POST /v1/memory/state-brief",
        "POST /v1/memory/recall",
        "POST /v1/cobra/turn",
        "GET /v1/cobra/healthz",
        "GET /v1/cobra/flux/tail",
      ],
      law: "Frontier-Isolation: only OrangeLLM reachable; never Orange5 internals.",
    },
    generated_at: new Date().toISOString(),
  };
}

export const __healthzInternals = Object.freeze({ specialistSnapshot, scheduleSpecialistRefresh, SPECIALIST_TTL_MS });
