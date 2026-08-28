// Upstream config for OrangeLLM gateway.
// The N150 performs deterministic Bun routing and keeps no answer model resident.
// Generated answers run on Codexa through Navigator or a bounded specialist lease.
// Navigator is the default Orange conductor, loaded under a bounded lease on
// first use. Heavy models remain explicit leases.

import { ORANGE_NAVIGATOR_SYSTEM } from '../contracts/navigator-system.mjs';
import { ORANGE_REPORT_DRAFT_JSON_SCHEMA, ORANGE_REPORT_NO_EVIDENCE_GBNF, ORANGE_REPORT_NO_EVIDENCE_JSON_SCHEMA } from '../contracts/orange-report.mjs';
import { resolveComputeEndpointsSync } from '../../03-BACKEND/compute-fabric.mjs';
import { probeAEPhaseModel, requestAEPhaseModel } from '../../03-BACKEND/ae-phase-model-client.mjs';
import { compileModelResponse } from './response-compiler.mjs';
import { ensureSpecialistReady, scheduleSpecialistPrewarm, specialistLeaseSnapshot } from './specialist-lease.mjs';

export const DEFAULT_CODEXA_ETHERNET_OLLAMA_URL = "http://10.0.99.1:11434";
export const DEFAULT_CODEXA_OLLAMA_URL = "http://10.0.0.4:11434";
export const DEFAULT_CODEXA_RAIL_URL = "http://10.0.0.4:8097";
export const DEFAULT_MAX_TOKENS = 256;
export const MIN_MAX_TOKENS = 1;
export const MAX_MAX_TOKENS = 4096;
export const DEFAULT_NAVIGATOR_MODEL = "orange-navigator:ornith-1.5-9b-q4km";
export const DEFAULT_NAVIGATOR_KEEP_ALIVE = "15m";
export const RETIRED_NAVIGATOR_MODELS = Object.freeze([
  "orange-navigator:hot-v1",
]);

export function resolveNavigatorModel({ configuredModel, fabricModel, transport = "ollama" } = {}) {
  const retired = new Set(RETIRED_NAVIGATOR_MODELS);
  const configured = String(configuredModel || "").trim();
  const selected = String(fabricModel || "").trim();
  const usable = (model) => model && !retired.has(model);

  if (usable(configured)) return configured;
  if (usable(selected)) return selected;
  if (transport !== "ollama" && configured) return configured;
  return DEFAULT_NAVIGATOR_MODEL;
}

function fabricEndpoints() {
  return resolveComputeEndpointsSync();
}

function crossNodeTransport() {
  return String(process.env.ORANGE5_CROSS_NODE_TRANSPORT || 'ae-phase').trim().toLowerCase();
}

export function normalizeLoopbackUrl(value) {
  if (!value) return value;
  try {
    const url = new URL(String(value));
    if (url.hostname.toLowerCase() === 'localhost') url.hostname = '127.0.0.1';
    return url.toString().replace(/\/$/, '');
  } catch {
    return value;
  }
}

function fabricOllamaUrl() {
  const fabric = fabricEndpoints();
  return fabric.inferenceKind === 'ollama' ? normalizeLoopbackUrl(fabric.inferenceUrl) : null;
}

function splitUrlList(value) {
  return String(value || '')
    .split(/[;,\s]+/)
    .map((item) => normalizeLoopbackUrl(item.trim()))
    .filter(Boolean);
}

export function resolveOllamaCandidates({
  configuredUrl = process.env.ORANGE5_CODEXA_OLLAMA_URL,
  ethernetUrl = process.env.ORANGE5_CODEXA_ETHERNET_OLLAMA_URL ?? DEFAULT_CODEXA_ETHERNET_OLLAMA_URL,
  fabricUrl = fabricOllamaUrl(),
  fallbackUrls = process.env.ORANGE5_CODEXA_OLLAMA_FALLBACK_URLS,
  wifiUrl = DEFAULT_CODEXA_OLLAMA_URL,
  includeDefaults = process.env.ORANGE5_CODEXA_OLLAMA_DISABLE_DEFAULTS !== '1',
} = {}) {
  const ordered = [
    normalizeLoopbackUrl(configuredUrl),
    ...(includeDefaults ? [normalizeLoopbackUrl(ethernetUrl)] : []),
    normalizeLoopbackUrl(fabricUrl),
    ...splitUrlList(fallbackUrls),
    ...(includeDefaults ? [normalizeLoopbackUrl(wifiUrl)] : []),
  ].filter(Boolean);
  return [...new Set(ordered)];
}

function navigatorTransport() {
  const configured = String(process.env.ORANGE5_NAVIGATOR_TRANSPORT || '').trim().toLowerCase();
  if (configured) return configured;
  return process.env.ORANGE5_NAVIGATOR_URL ? 'openai' : 'ollama';
}

function navigatorUrl() {
  const fabric = fabricEndpoints();
  if (navigatorTransport() === 'ollama') {
    return resolveOllamaCandidates()[0] ?? DEFAULT_CODEXA_ETHERNET_OLLAMA_URL;
  }
  return normalizeLoopbackUrl(process.env.ORANGE5_NAVIGATOR_URL
    ?? (fabric.navigatorKind === 'openai' ? fabric.navigatorUrl : null)
    ?? process.env.ORANGE5_CODEXA_OLLAMA_URL
    ?? fabric.navigatorUrl
    ?? fabricEndpoints().inferenceUrl
    ?? DEFAULT_CODEXA_OLLAMA_URL);
}

function roleOllamaUrl(role) {
  const fabric = fabricEndpoints();
  const roleKind = fabric[`${role}Kind`];
  const roleUrl = fabric[`${role}Url`];
  return resolveOllamaCandidates({
    fabricUrl: roleKind === 'ollama' ? roleUrl : fabricOllamaUrl(),
  })[0] ?? DEFAULT_CODEXA_ETHERNET_OLLAMA_URL;
}

function roleOllamaCandidates(role) {
  const fabric = fabricEndpoints();
  return resolveOllamaCandidates({
    fabricUrl: fabric[`${role}Kind`] === 'ollama' ? fabric[`${role}Url`] : fabricOllamaUrl(),
  });
}

function railUrl() {
  return normalizeLoopbackUrl(process.env.ORANGE5_CODEXA_RAIL_URL ?? fabricEndpoints().railUrl ?? DEFAULT_CODEXA_RAIL_URL);
}

export function loadedModelNames(payload = {}) {
  return Array.isArray(payload.models)
    ? payload.models.map((item) => item?.name || item?.model).filter(Boolean)
    : [];
}

export function modelIsLoaded(payload, model) {
  return loadedModelNames(payload).some((name) => name === model || name === `${model}:latest`);
}

export function modelIsAvailable(payload, model) {
  return loadedModelNames(payload).some((name) => name === model || name === `${model}:latest` || name.replace(/:latest$/, '') === String(model).replace(/:latest$/, ''));
}

export function resolveMaxTokens(body = {}) {
  const raw = body.max_tokens ?? body.max_completion_tokens;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_MAX_TOKENS;
  const requested = Number(raw);
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_MAX_TOKENS;
  return Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, Math.trunc(requested)));
}

export function resolveSpecialistContext(body = {}, tier = 'code') {
  const explicit = Number(body.options?.num_ctx || body.num_ctx || 0);
  const cap = Number(process.env[tier === 'heavy' ? 'ORANGE5_HEAVY_CONTEXT_MAX' : 'ORANGE5_CODE_CONTEXT_MAX'] || 32_768);
  if (Number.isFinite(explicit) && explicit > 0) return Math.min(cap, Math.max(2_048, Math.trunc(explicit)));
  const chars = (body.messages || []).reduce((sum, message) => sum + String(message?.content || '').length, 0);
  const estimatedTokens = Math.ceil(chars / 4) + resolveMaxTokens(body) + 512;
  if (estimatedTokens <= 3_500) return 4_096;
  if (estimatedTokens <= 7_000) return 8_192;
  if (estimatedTokens <= 14_000) return 16_384;
  return Math.min(cap, 32_768);
}

export function isNoEvidenceOperationalReport(body = {}, tier = 'light') {
  return tier === 'navigator'
    && ['orange_report_draft', 'orange_report_no_evidence_draft'].includes(body.response_format?.json_schema?.name)
    && (body.ae_report_evidence_policy === 'none'
      || body.messages?.some((message) => /No governed evidence was supplied/i.test(String(message?.content || ''))))
    && (!Array.isArray(body.tools) || body.tools.length === 0);
}

export function canUseCompactNoEvidenceGrammar(body = {}, tier = 'light', backend = '') {
  return backend === 'llama.cpp-vulkan' && isNoEvidenceOperationalReport(body, tier);
}

function systemContentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === 'string' ? part : (part?.text || JSON.stringify(part))).join('\n');
  }
  return JSON.stringify(content ?? '');
}

export function coalesceSystemMessages(messages = []) {
  const input = Array.isArray(messages) ? messages : [];
  const systems = input.filter((message) => message?.role === 'system');
  if (systems.length === 0) return input;
  if (systems.length === 1 && input[0] === systems[0]) return input;
  return [
    { ...systems[0], role: 'system', content: systems.map((message) => systemContentText(message.content)).join('\n\n') },
    ...input.filter((message) => message?.role !== 'system'),
  ];
}

export function normalizeNativeOllamaChat(payload = {}) {
  const content = payload?.message?.content ?? '';
  return {
    id: `ollama-${payload.created_at || Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: payload.model ?? null,
    choices: [{
      index: 0,
      message: { role: payload?.message?.role || 'assistant', content },
      finish_reason: payload.done_reason === 'length' ? 'length' : 'stop',
    }],
    usage: {
      prompt_tokens: Number(payload.prompt_eval_count || 0),
      completion_tokens: Number(payload.eval_count || 0),
      total_tokens: Number(payload.prompt_eval_count || 0) + Number(payload.eval_count || 0),
    },
    ae_native_ollama: {
      done: payload.done === true,
      done_reason: payload.done_reason ?? null,
      total_duration_ns: Number(payload.total_duration || 0),
      load_duration_ns: Number(payload.load_duration || 0),
      prompt_eval_duration_ns: Number(payload.prompt_eval_duration || 0),
      eval_duration_ns: Number(payload.eval_duration || 0),
    },
  };
}

export const UPSTREAM = {
  light: {
    name: "smart-skinny",
    get base_url() { return process.env.ORANGE5_LIGHT_URL ?? "http://127.0.0.1:8797"; },
    chat_completions_path: "/v1/chat/completions",
    health_path: "/healthz",
    // N150 + Ollama qwen3:0.6b can take >60s on first/warm prompt under load.
    // Keep the light lane honest instead of falsely reporting a gateway failure.
    timeout_ms: 120_000,
    host: "n150",
    state: "always-warm",
    model: "orangellm-smart-skinny-0.5b",
  },
  navigator: {
    name: "orange-navigator",
    get base_url() { return navigatorUrl(); },
    get candidates() { return resolveOllamaCandidates(); },
    get backend() {
      if (navigatorTransport() === 'ollama') return 'ollama';
      if (process.env.ORANGE5_NAVIGATOR_URL) return "llama.cpp-vulkan";
      return fabricEndpoints().navigatorKind === 'openai' ? 'openai-compatible' : 'ollama';
    },
    chat_completions_path: "/v1/chat/completions",
    tags_path: "/api/tags",
    // Codexa may need to swap weights after a specialist lease. The measured
    // warm response is normally below 30s, but a cold swap can exceed 60s.
    timeout_ms: 180_000,
    get host() {
      return navigatorTransport() === 'ollama'
        ? (fabricEndpoints().inferenceHost || "codexa")
        : (fabricEndpoints().navigatorHost || fabricEndpoints().inferenceHost || "codexa");
    },
    get node() {
      return navigatorTransport() === 'ollama'
        ? (fabricEndpoints().inferenceNodeId || "codexa")
        : (fabricEndpoints().navigatorNodeId || fabricEndpoints().inferenceNodeId || "codexa");
    },
    state: "leased-on-demand",
    // Explicit Ollama transport rejects stale compute-fabric selections such as
    // the retired 4B Vulkan endpoint and keeps model identity stable.
    get model() {
      const transport = navigatorTransport();
      return resolveNavigatorModel({
        configuredModel: process.env.ORANGE5_NAVIGATOR_MODEL,
        fabricModel: !process.env.ORANGE5_NAVIGATOR_URL ? fabricEndpoints().navigatorModel : null,
        transport,
      });
    },
    fallback: {
      name: "orange-navigator-ollama-fallback",
      get base_url() { return roleOllamaUrl('navigator'); },
      chat_completions_path: "/v1/chat/completions",
      tags_path: "/api/tags",
    },
  },
  code: {
    name: "orange-code-specialist",
    get base_url() { return roleOllamaUrl('code'); },
    get candidates() { return roleOllamaCandidates('code'); },
    chat_completions_path: "/v1/chat/completions",
    tags_path: "/api/tags",
    timeout_ms: 180_000,
    get host() { return fabricEndpoints().codeHost || fabricEndpoints().inferenceHost || "codexa"; },
    get node() { return fabricEndpoints().codeNodeId || fabricEndpoints().inferenceNodeId || "codexa"; },
    state: "leased",
    get model() { return process.env.ORANGE5_CODEXA_CODE_MODEL ?? fabricEndpoints().codeModel ?? "qwen3-coder:30b"; },
    fallback: {
      name: "orange-code-via-rail",
      get base_url() { return railUrl(); },
      chat_completions_path: "/api/ollama/v1/chat/completions",
      health_path: "/api/status?fast=1",
      timeout_ms: 180_000,
    },
    hot_fallback: {
      name: 'orange-navigator-code-fallback',
      get base_url() { return navigatorUrl(); },
      chat_completions_path: '/v1/chat/completions',
      get backend() { return UPSTREAM.navigator.backend; },
      get model() { return UPSTREAM.navigator.model; },
    },
  },
  heavy: {
    name: "fatty-codexa",
    // Primary path: direct Ollama on Codexa
    get base_url() { return roleOllamaUrl('heavy'); },
    get candidates() { return roleOllamaCandidates('heavy'); },
    chat_completions_path: "/v1/chat/completions",
    tags_path: "/api/tags",
    timeout_ms: 120_000,
    get host() { return fabricEndpoints().heavyHost || fabricEndpoints().inferenceHost || "codexa"; },
    get node() { return fabricEndpoints().heavyNodeId || fabricEndpoints().inferenceNodeId || "codexa"; },
    state: "warm",
    get model() { return process.env.ORANGE5_CODEXA_HEAVY_MODEL ?? "qwen3.8:27b-current"; },
    // Fallback path: through command rail (Orangebox mediates)
    fallback: {
      name: "fatty-codexa-via-rail",
      get base_url() { return railUrl(); },
      chat_completions_path: "/api/ollama/v1/chat/completions",
      health_path: "/api/status?fast=1",
      timeout_ms: 120_000,
    },
    hot_fallback: {
      name: 'orange-navigator-heavy-fallback',
      get base_url() { return navigatorUrl(); },
      chat_completions_path: '/v1/chat/completions',
      get backend() { return UPSTREAM.navigator.backend; },
      get model() { return UPSTREAM.navigator.model; },
    },
  },
};

async function fetchWithTimeout(url, options = {}, timeoutMs = 5_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function probeOllamaCandidate(baseUrl, model, timeoutMs = 1_200) {
  const startedAt = performance.now();
  try {
    const [tagsResponse, psResponse] = await Promise.all([
      fetchWithTimeout(`${baseUrl}/api/tags`, {}, timeoutMs),
      fetchWithTimeout(`${baseUrl}/api/ps`, {}, timeoutMs).catch(() => null),
    ]);
    if (!tagsResponse.ok) {
      return { reachable: false, path: baseUrl, http: tagsResponse.status, latency_ms: Math.round(performance.now() - startedAt) };
    }
    const tags = await tagsResponse.json().catch(() => ({}));
    const processState = psResponse?.ok ? await psResponse.json().catch(() => ({})) : {};
    const loaded = loadedRuntime(processState, model);
    return {
      reachable: true,
      path: baseUrl,
      models_seen: Array.isArray(tags.models) ? tags.models.length : 0,
      model_loaded: modelIsLoaded(processState, model),
      model_available: modelIsAvailable(tags, model),
      loaded_models: loadedModelNames(processState),
      latency_ready: latencyReadyRuntime(loaded, model),
      latency_ms: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    return { reachable: false, path: baseUrl, error: error.message, latency_ms: Math.round(performance.now() - startedAt) };
  }
}

async function probeOllamaCandidates(urls, model) {
  const unique = [...new Set((urls || []).filter(Boolean))];
  if (unique.length === 0) return [];
  const primary = await probeOllamaCandidate(unique[0], model, 800);
  if (primary.reachable && primary.model_available === true) return [primary];
  const recovery = await Promise.all(unique.slice(1).map((url) => probeOllamaCandidate(url, model)));
  return [primary, ...recovery];
}

export function selectOllamaCandidate(candidates = [], tier = 'navigator') {
  const ready = candidates.find((candidate) => candidate.reachable
    && candidate.model_available === true
    && (tier === 'navigator' || (candidate.model_loaded === true && candidate.latency_ready === true))) ?? null;
  const lease = ready ?? candidates.find((candidate) => candidate.reachable && candidate.model_available === true) ?? null;
  return { ready, lease };
}

function railHeaders(extra = {}) {
  const headers = { ...extra };
  if (process.env.ORANGEBOX_RAIL_TOKEN) {
    headers["X-Orangebox-Token"] = process.env.ORANGEBOX_RAIL_TOKEN;
  }
  return headers;
}

function loadedRuntime(payload, model) {
  const rows = Array.isArray(payload?.models) ? payload.models : [];
  return rows.find((row) => {
    const name = row?.name || row?.model || '';
    return name === model || name === `${model}:latest` || name.replace(/:latest$/, '') === String(model).replace(/:latest$/, '');
  }) || null;
}

const MEASURED_INTERACTIVE_MODELS = new Set([
  DEFAULT_NAVIGATOR_MODEL,
  'qwen3-coder:30b',
  'qwen3:30b-a3b',
]);

function latencyReadyRuntime(row, model) {
  if (!row) return false;
  const vram = Number(row.size_vram || 0);
  const size = Number(row.size || 0);
  const name = String(row.name || row.model || model || '').replace(/:latest$/, '');
  const parameterSize = String(row.details?.parameter_size || '').toLowerCase();
  const parameterBillions = Number(parameterSize.match(/(\d+(?:\.\d+)?)b/)?.[1] || Number.POSITIVE_INFINITY);
  // Ollama's resident `size` includes the context allocation. A 4B Q4 model
  // at 32K can therefore report more than 13 GB even though it remains the
  // measured interactive Navigator. Use the model class when Ollama provides
  // it, and keep the loaded-allocation check as a fallback for older servers.
  return vram > 0
    || parameterBillions <= 8
    || (size > 0 && size <= 6 * 1024 ** 3)
    || MEASURED_INTERACTIVE_MODELS.has(name);
}

async function probeHotFallback(upstream) {
  const baseUrl = upstream?.hot_fallback?.base_url;
  if (!baseUrl) return { reachable: false, path: null };
  if (upstream.hot_fallback.backend === 'ollama') {
    try {
      const [tagsResponse, psResponse] = await Promise.all([
        fetchWithTimeout(`${baseUrl}/api/tags`, {}, 3_000),
        fetchWithTimeout(`${baseUrl}/api/ps`, {}, 3_000),
      ]);
      const tags = tagsResponse.ok ? await tagsResponse.json().catch(() => ({})) : {};
      const processState = psResponse.ok ? await psResponse.json().catch(() => ({})) : {};
      const model = upstream.hot_fallback.model;
      const loaded = loadedRuntime(processState, model);
      const ready = tagsResponse.ok
        && modelIsAvailable(tags, model)
        && modelIsLoaded(processState, model)
        && latencyReadyRuntime(loaded, model);
      return {
        reachable: ready,
        path: baseUrl,
        backend: 'ollama',
        model,
        model_loaded: modelIsLoaded(processState, model),
        latency_ready: latencyReadyRuntime(loaded, model),
      };
    } catch (error) {
      return { reachable: false, path: baseUrl, backend: 'ollama', error: error.message };
    }
  }
  try {
    const response = await fetchWithTimeout(`${baseUrl}/health`, {}, 3_000);
    return { reachable: response.ok, path: baseUrl, backend: 'openai-compatible', http: response.status };
  } catch (error) {
    return { reachable: false, path: baseUrl, backend: 'openai-compatible', error: error.message };
  }
}

/**
 * probeUpstream with a HARD answer budget.
 *
 * probeUpstream("heavy") resolves CODEXA.local (mDNS). A stalled mDNS lookup
 * blocks BEFORE AbortController can cancel it — an abort signal cannot
 * interrupt a hung DNS resolve in Node's fetch — so any route awaiting it can
 * hang forever. Every ROUTE (as opposed to a real request) must use this, so a
 * slow upstream degrades the report instead of killing the endpoint.
 */
export function probeUpstreamBudgeted(tier = "light", budgetMs = 1_500) {
  return Promise.race([
    probeUpstream(tier),
    new Promise((resolve) =>
      setTimeout(
        () =>
          resolve({
            tier,
            status: "probe_timeout",
            live: false,
            note: `no answer within ${budgetMs}ms (mDNS or upstream stall)`,
          }),
        budgetMs,
      ),
    ),
  ]);
}

export async function probeUpstream(tier = "light") {
  const u = UPSTREAM[tier];
  if (!u) return { tier, status: "unknown_tier", live: false };
  if (tier === "light") {
    if (!u.base_url) return { tier, status: "not_configured", live: false };
    try {
      const res = await fetchWithTimeout(`${u.base_url}${u.health_path}`, {}, u.timeout_ms);
      return { tier, status: res.ok ? "live" : `http_${res.status}`, live: res.ok, base_url: u.base_url };
    } catch (err) {
      return { tier, status: "unreachable", live: false, error: err.message, base_url: u.base_url };
    }
  }
  if (crossNodeTransport() === 'ae-phase') {
    const phase = await probeAEPhaseModel({ tier, model: u.model, timeoutMs: 3_000 });
    return {
      tier,
      status: phase.live ? 'live' : phase.status,
      live: phase.live === true,
      primary: {
        reachable: phase.live === true,
        path: 'ae-phase://CODEXA',
        backend: 'ae-phase',
        model_available: phase.modelAvailable === true,
        model_loaded: phase.modelLoaded === true,
        loaded_models: phase.loadedModels || [],
      },
      fallback: null,
      preferred_route: phase.live ? 'ae-phase' : 'none',
      selected_base_url: phase.live ? 'ae-phase://CODEXA' : null,
      capability_mode: phase.modelLoaded ? 'phase_resident' : (phase.modelAvailable ? 'phase_lease_on_demand' : 'unavailable'),
      model: phase.model || u.model,
      model_loaded: phase.modelLoaded === true,
      transport: phase,
    };
  }
  if (tier === "navigator" || tier === "code" || tier === "heavy") {
    if (tier === "navigator" && (u.backend === "llama.cpp-vulkan" || u.backend === "openai-compatible")) {
      let primary;
      try {
        const res = await fetchWithTimeout(`${u.base_url}/health`, {}, 3_000);
        const data = res.ok ? await res.json().catch(() => ({})) : {};
        const live = res.ok && data.status === "ok";
        primary = { reachable: live, path: u.base_url, backend: u.backend, model_loaded: live, loaded_models: live ? [u.model] : [] };
        if (live) return { tier, status: "live", live: true, primary, fallback: null, preferred_route: "direct_openai", model: u.model, model_loaded: true };
      } catch (err) {
        primary = { reachable: false, path: u.base_url, backend: u.backend, error: err.message };
      }
      const fallbacks = await probeOllamaCandidates(resolveOllamaCandidates(), u.model);
      const fallback = fallbacks.find((candidate) => candidate.reachable && candidate.model_available) ?? fallbacks[0] ?? {
        reachable: false,
        path: u.fallback?.base_url ?? null,
      };
      return {
        tier,
        status: fallback.reachable ? "live" : "unreachable",
        live: fallback.reachable,
        primary,
        fallback,
        preferred_route: fallback.reachable ? "direct_ollama" : "none",
        selected_base_url: fallback.reachable ? fallback.path : null,
        candidates: fallbacks,
        model: u.model,
        model_loaded: fallback.model_loaded === true,
      };
    }
    // Probe literal/discovered paths in parallel. Ordered candidates preserve
    // operator override, then CAT8, then discovered fabric, then Wi-Fi.
    const candidates = await probeOllamaCandidates(u.candidates ?? [u.base_url], u.model);
    const primary = candidates[0] ?? { reachable: false, path: u.base_url };
    const { ready: readyCandidate, lease: leaseCandidate } = selectOllamaCandidate(candidates, tier);
    // Navigator is direct. Code/heavy may fall back through the governed rail.
    let fallback = null;
    if ((tier === "code" || tier === "heavy") && (!primary.reachable || primary.model_available === false)) {
      try {
        const res = await fetchWithTimeout(`${u.fallback.base_url}${u.fallback.health_path}`, {
          headers: railHeaders(),
        }, 3_000);
        fallback = { reachable: res.ok, path: u.fallback.base_url, http: res.status };
      } catch (err) {
        fallback = { reachable: false, path: u.fallback.base_url, error: err.message };
      }
    }
    const hotFallback = (tier === 'code' || tier === 'heavy') ? await probeHotFallback(u) : null;
    const directReady = Boolean(readyCandidate);
    const leaseOnDemand = (tier === 'code' || tier === 'heavy')
      && !directReady
      && Boolean(leaseCandidate);
    const live = directReady || hotFallback?.reachable || leaseOnDemand || (fallback && fallback.reachable);
    const preferredRoute = directReady
      ? 'direct_ollama'
      : (hotFallback?.reachable
          ? 'hot_navigator'
          : (leaseOnDemand ? 'direct_ollama' : (fallback && fallback.reachable ? 'command_rail' : 'none')));
    return {
      tier,
      status: live ? "live" : "unreachable",
      live,
      primary,
      candidates,
      fallback,
      hot_fallback: hotFallback,
      preferred_route: preferredRoute,
      selected_base_url: (readyCandidate ?? leaseCandidate)?.path ?? null,
      capability_mode: directReady
        ? (tier === 'navigator' ? (primary.model_loaded ? 'leased_ready' : 'lease_on_demand') : 'specialist')
        : (leaseOnDemand ? 'lease_on_demand' : (hotFallback?.reachable ? 'shared_hot_fallback' : 'unavailable')),
      model: u.model,
      model_loaded: (readyCandidate ?? leaseCandidate)?.model_loaded === true,
    };
  }
  return { tier, status: "unknown", live: false };
}

export async function consumeOpenAiSse(response, onChunk) {
  if (!response?.body) throw new Error('streaming upstream returned no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let id = null;
  let created = null;
  let model = null;
  let role = 'assistant';
  let content = '';
  let finishReason = null;
  let usage = null;
  const toolCalls = new Map();

  const consumeFrame = async (frame) => {
    const data = frame.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') return;
    const chunk = JSON.parse(data);
    if (chunk.error) throw new Error(chunk.error.message || 'streaming upstream error');
    id ||= chunk.id || null;
    created ||= chunk.created || null;
    model ||= chunk.model || null;
    usage = chunk.usage || usage;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    const delta = { ...(choice.delta || {}) };
    delete delta.reasoning;
    delete delta.reasoning_content;
    delete delta.thinking;
    if (typeof delta.role === 'string') role = delta.role;
    if (typeof delta.content === 'string') content += delta.content;
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const index = Number.isInteger(call.index) ? call.index : toolCalls.size;
        const prior = toolCalls.get(index) || { index, id: '', type: 'function', function: { name: '', arguments: '' } };
        if (call.id) prior.id += call.id;
        if (call.type) prior.type = call.type;
        if (call.function?.name) prior.function.name += call.function.name;
        if (call.function?.arguments) prior.function.arguments += call.function.arguments;
        toolCalls.set(index, prior);
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const outbound = {
      ...chunk,
      choices: [{ ...choice, delta }],
    };
    if (typeof onChunk === 'function' && (delta.role || delta.content || delta.tool_calls)) {
      await onChunk(outbound);
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() || '';
    for (const frame of frames) await consumeFrame(frame);
    if (done) break;
  }
  if (buffer.trim()) await consumeFrame(buffer);

  const message = { role, content };
  if (toolCalls.size) message.tool_calls = [...toolCalls.values()].sort((a, b) => a.index - b.index);
  return {
    id: id || `chatcmpl-orange-stream-${Date.now()}`,
    object: 'chat.completion',
    created: created || Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason || 'stop' }],
    ...(usage ? { usage } : {}),
  };
}

export async function proxyChatCompletions(body, tier = "light", options = {}) {
  const u = UPSTREAM[tier];
  if (!u) {
    return { status: 400, body: { error: { message: `unknown tier: ${tier}`, type: "invalid_request_error", code: "unknown_tier" } } };
  }

  if (tier !== 'light' && crossNodeTransport() === 'ae-phase') {
    const result = await requestAEPhaseModel({
      tier,
      model: u.model,
      body,
      onChunk: options.onChunk,
      timeoutMs: u.timeout_ms,
    });
    if (result.status !== 200 || !result.body || typeof result.body !== 'object') return result;
    compileModelResponse(result.body, body.messages ?? []);
    if (Array.isArray(result.body.choices)) {
      for (const choice of result.body.choices) {
        if (!choice?.message || typeof choice.message !== 'object') continue;
        delete choice.message.reasoning;
        delete choice.message.reasoning_content;
        delete choice.message.thinking;
      }
    }
    const lane = tier === 'navigator' ? 'navigator' : tier;
    result.body.ae_lane = lane;
    result.body.ae_requested_lane = lane;
    result.body.ae_requested_tier = tier;
    result.body.ae_execution_tier = tier;
    result.body.ae_host = 'codexa';
    result.body.ae_requested_host = 'codexa';
    result.body.ae_effective_host = 'codexa';
    result.body.ae_requested_node = 'CODEXA';
    result.body.ae_effective_node = 'CODEXA';
    result.body.ae_upstream = u.name;
    result.body.ae_selected_endpoint = 'ae-phase://CODEXA';
    result.body.ae_route_mode = 'phase_model_lease';
    result.body.ae_requested_model = u.model;
    result.body.ae_effective_model = result.body.model || u.model;
    result.body.ae_phase = result.phase;
    return result;
  }

  const specialistPolicy = body.ae_specialist_policy || 'prewarm_fallback';
  let specialistLease = null;
  if ((tier === 'code' || tier === 'heavy') && specialistPolicy === 'wait_for_specialist') {
    try {
      specialistLease = await ensureSpecialistReady({ tier, baseUrl: u.base_url, model: u.model });
    } catch (error) {
      return {
        status: 503,
        body: { error: { message: `specialist lease failed: ${error.message}`, type: 'upstream_error', code: 'specialist_lease_failed' } },
      };
    }
  }

  // Navigator and heavy run on Codexa. Heavy may fall back to the command rail.
  let endpoint;
  let selectedRoute = 'direct';
  let selectedBaseUrl = u.base_url;
  if (tier === "navigator" || tier === "code") {
    const probe = await probeUpstreamBudgeted(tier, 5_000);
    if (!probe.live) {
      return {
        status: probe.status === "probe_timeout" ? 504 : 502,
        body: {
          error: {
            message: `${u.name} is not reachable on Codexa`,
            type: "upstream_error",
            code: probe.status === "probe_timeout" ? `${tier}_probe_timeout` : `${tier}_unreachable`,
            detail: probe,
          },
        },
      };
    }
    selectedRoute = probe.preferred_route;
    selectedBaseUrl = probe.selected_base_url ?? u.base_url;
    if (selectedRoute === "command_rail") endpoint = `${u.fallback.base_url}${u.fallback.chat_completions_path}`;
    else if (selectedRoute === 'hot_navigator') endpoint = `${u.hot_fallback.base_url}${u.hot_fallback.chat_completions_path}`;
    else if (tier === "navigator" && u.backend !== "ollama" && selectedRoute === "direct_ollama") {
      selectedRoute = 'navigator_ollama_fallback';
      endpoint = `${u.fallback.base_url}${u.fallback.chat_completions_path}`;
    } else endpoint = `${selectedBaseUrl}${u.chat_completions_path}`;
  } else if (tier === "heavy") {
    // BUDGETED ROUTE DECISION (5s — generous; a healthy probe measures ~300-600ms).
    // This runs before EVERY heavy request, so an mDNS stall here hangs the caller
    // for its entire timeout (120s for Atomic Orange's autopilot, which reads on
    // screen as THINKING forever). A fast honest failure beats a silent hang: the
    // caller can fail-stop, report, and retry. Real request bodies keep full time.
    const probe = await probeUpstreamBudgeted("heavy", 5_000);
    if (probe.preferred_route === "direct_ollama") {
      selectedRoute = 'direct_ollama';
      selectedBaseUrl = probe.selected_base_url ?? u.base_url;
      endpoint = `${selectedBaseUrl}${u.chat_completions_path}`;
    } else if (probe.preferred_route === 'hot_navigator') {
      selectedRoute = 'hot_navigator';
      endpoint = `${u.hot_fallback.base_url}${u.hot_fallback.chat_completions_path}`;
    } else if (probe.preferred_route === "command_rail") {
      selectedRoute = 'command_rail';
      endpoint = `${u.fallback.base_url}${u.fallback.chat_completions_path}`;
    } else if (probe.status === "probe_timeout") {
      // distinct from "unreachable": we never learned. Say so precisely — a
      // caller that knows the difference can retry instead of standing down.
      return {
        status: 504,
        body: {
          error: {
            message: "heavy route undecidable: upstream probe stalled (mDNS or network)",
            type: "upstream_error",
            code: "heavy_probe_timeout",
            detail: probe,
          },
        },
      };
    } else {
      return {
        status: 502,
        body: {
          error: {
            message: "heavy tier unreachable on both direct and rail paths",
            type: "upstream_error",
            code: "heavy_unreachable",
            detail: probe,
          },
        },
      };
    }
  } else {
    endpoint = `${u.base_url}${u.chat_completions_path}`;
  }

  try {
    const headers = (tier === "heavy" || tier === "code") && endpoint.startsWith(u.fallback?.base_url || "__none__")
      ? railHeaders({ "Content-Type": "application/json" })
      : { "Content-Type": "application/json" };

    const hotFallbackRoute = (tier === 'code' || tier === 'heavy') && selectedRoute === 'hot_navigator';
    const directOllamaSpecialist = (tier === 'code' || tier === 'heavy') && selectedRoute === 'direct_ollama';
    const directOllamaNavigator = tier === 'navigator' && u.backend === 'ollama' && selectedRoute === 'direct_ollama';
    if (directOllamaNavigator) {
      try {
        specialistLease = await ensureSpecialistReady({
          tier,
          baseUrl: selectedBaseUrl,
          model: u.model,
          keepAlive: process.env.ORANGE5_NAVIGATOR_KEEP_ALIVE || DEFAULT_NAVIGATOR_KEEP_ALIVE,
        });
      } catch (error) {
        return {
          status: 503,
          body: { error: { message: `Navigator lease failed: ${error.message}`, type: 'upstream_error', code: 'navigator_lease_failed' } },
        };
      }
    }
    if (directOllamaSpecialist && !specialistLease) {
      try {
        specialistLease = await ensureSpecialistReady({ tier, baseUrl: selectedBaseUrl, model: u.model });
      } catch (error) {
        return {
          status: 503,
          body: { error: { message: `specialist lease failed: ${error.message}`, type: 'upstream_error', code: 'specialist_lease_failed' } },
        };
      }
    }
    const noEvidenceReport = isNoEvidenceOperationalReport(body, tier);
    const compactNoEvidence = canUseCompactNoEvidenceGrammar(body, tier, u.backend);
    const {
      ae_specialist_policy: _specialistPolicy,
      ae_report_evidence_policy: _reportEvidencePolicy,
      ...publicBody
    } = body;
    const routedMessages = (tier === "navigator" && (u.backend === "llama.cpp-vulkan" || u.backend === "openai-compatible") && endpoint.startsWith(u.base_url)) || hotFallbackRoute
      ? [{ role: "system", content: ORANGE_NAVIGATOR_SYSTEM }, ...(body.messages ?? [])]
      : body.messages;
    const strictOllamaTemplate = directOllamaNavigator
      || directOllamaSpecialist
      || (hotFallbackRoute && UPSTREAM.navigator.backend === 'ollama');
    const ollamaReportName = body.response_format?.json_schema?.name;
    const ollamaOperationalReport = strictOllamaTemplate
      && ['orange_report_draft', 'orange_report_no_evidence_draft'].includes(ollamaReportName);
    const ollamaNoEvidenceReport = ollamaOperationalReport && noEvidenceReport;
    const liveStream = body.stream === true
      && typeof options.onChunk === 'function'
      && !ollamaOperationalReport;
    const openAiRequestBody = {
      ...publicBody,
      messages: strictOllamaTemplate ? coalesceSystemMessages(routedMessages) : routedMessages,
      model: hotFallbackRoute ? UPSTREAM.navigator.model : u.model,
      stream: liveStream,
      think: false,
      reasoning_effort: "none",
      reasoning: { effort: "none" },
      max_tokens: noEvidenceReport ? Math.min(resolveMaxTokens(body), 192) : resolveMaxTokens(body),
      ...(directOllamaNavigator ? { keep_alive: process.env.ORANGE5_NAVIGATOR_KEEP_ALIVE || DEFAULT_NAVIGATOR_KEEP_ALIVE } : {}),
      ...((directOllamaNavigator || directOllamaSpecialist) ? {
        options: { ...(publicBody.options || {}), num_ctx: resolveSpecialistContext(publicBody, tier) },
      } : {}),
      ...(ollamaOperationalReport ? {
        response_format: ollamaNoEvidenceReport ? { type: 'json_object' } : publicBody.response_format,
        format: ollamaNoEvidenceReport ? ORANGE_REPORT_NO_EVIDENCE_JSON_SCHEMA : ORANGE_REPORT_DRAFT_JSON_SCHEMA,
      } : {}),
      ...(compactNoEvidence ? {
        response_format: undefined,
        grammar: ORANGE_REPORT_NO_EVIDENCE_GBNF,
        cache_prompt: true,
        timings_per_token: true,
      } : {}),
    };

    const nativeOllamaReport = (directOllamaNavigator || directOllamaSpecialist) && ollamaOperationalReport;
    const requestBody = nativeOllamaReport ? {
      model: openAiRequestBody.model,
      messages: openAiRequestBody.messages,
      stream: false,
      think: false,
      format: ollamaNoEvidenceReport ? ORANGE_REPORT_NO_EVIDENCE_JSON_SCHEMA : ORANGE_REPORT_DRAFT_JSON_SCHEMA,
      ...(directOllamaNavigator ? { keep_alive: process.env.ORANGE5_NAVIGATOR_KEEP_ALIVE || DEFAULT_NAVIGATOR_KEEP_ALIVE } : {}),
      options: {
        ...(openAiRequestBody.options || {}),
        temperature: 0,
        num_predict: openAiRequestBody.max_tokens,
      },
    } : openAiRequestBody;
    if (nativeOllamaReport) endpoint = `${selectedBaseUrl}/api/chat`;

    const res = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    }, u.timeout_ms);

    if (!res.ok) {
      const text = await res.text();
      return {
        status: res.status,
        body: {
          error: {
            message: `Upstream ${u.name} returned ${res.status}`,
            type: "upstream_error",
            code: `upstream_${res.status}`,
            detail: text.slice(0, 500),
          },
        },
      };
    }

    const contentType = String(res.headers.get('content-type') || '').toLowerCase();
    const streamed = liveStream && contentType.includes('text/event-stream');
    let json = streamed
      ? await consumeOpenAiSse(res, options.onChunk)
      : await res.json();
    if (nativeOllamaReport) json = normalizeNativeOllamaChat(json);
    if (hotFallbackRoute && specialistPolicy === 'prewarm_fallback') {
      specialistLease = scheduleSpecialistPrewarm({ tier, baseUrl: u.base_url, model: u.model });
    }
    compileModelResponse(json, body.messages ?? []);
    if (Array.isArray(json?.choices)) {
      for (const choice of json.choices) {
        if (choice?.message && typeof choice.message === "object") {
          delete choice.message.reasoning;
          delete choice.message.reasoning_content;
          delete choice.message.thinking;
        }
      }
    }
    if (json && typeof json === "object") {
      const requestedLane = tier === "navigator" ? "navigator" : (tier === "heavy" ? "heavy" : (tier === 'code' ? 'code' : "reflex"));
      const executionTier = hotFallbackRoute ? 'navigator' : tier;
      const executionLane = executionTier === 'light' ? 'reflex' : executionTier;
      const requestedHost = tier === "light" ? "n150" : u.host;
      const effectiveHost = hotFallbackRoute ? UPSTREAM.navigator.host : requestedHost;
      const requestedNode = tier === "light" ? "n150" : (u.node || u.host);
      const effectiveNode = hotFallbackRoute ? (UPSTREAM.navigator.node || UPSTREAM.navigator.host) : requestedNode;
      json.ae_lane = executionLane;
      json.ae_requested_lane = requestedLane;
      json.ae_requested_tier = tier;
      json.ae_execution_tier = executionTier;
      json.ae_host = effectiveHost;
      json.ae_requested_host = requestedHost;
      json.ae_effective_host = effectiveHost;
      json.ae_requested_node = requestedNode;
      json.ae_effective_node = effectiveNode;
      json.ae_upstream = u.name;
      json.ae_selected_endpoint = selectedBaseUrl;
      json.ae_route_mode = hotFallbackRoute ? 'shared_hot_fallback' : 'specialist';
      json.ae_requested_model = u.model;
      json.ae_effective_model = hotFallbackRoute ? UPSTREAM.navigator.model : u.model;
      json.ae_specialist_lease = specialistLease || specialistLeaseSnapshot(u.model);
      if (directOllamaNavigator || directOllamaSpecialist) {
        json.ae_specialist_context = {
          schema: 'orange.specialist-context.v1',
          num_ctx: requestBody.options.num_ctx,
          policy: publicBody.options?.num_ctx ? 'bounded_explicit' : 'adaptive_least_action',
        };
      }
      if (noEvidenceReport) {
        const promptTokens = Number(json.usage?.prompt_tokens || 0);
        const cachedTokens = Number(json.usage?.prompt_tokens_details?.cached_tokens || 0);
        json.ae_inference_optimization = {
          schema: 'orange.navigator-inference-optimization.v1',
          mode: compactNoEvidence
            ? 'compact_no_evidence_gbnf'
            : (ollamaNoEvidenceReport ? 'compact_no_evidence_ollama_json_object' : 'compact_no_evidence_json_schema'),
          max_tokens: requestBody.max_tokens,
          prompt_tokens: promptTokens,
          cached_prompt_tokens: cachedTokens,
          cache_ratio: promptTokens > 0 ? Number((cachedTokens / promptTokens).toFixed(4)) : 0,
          predicted_tokens: Number(json.timings?.predicted_n ?? json.usage?.completion_tokens ?? 0),
          predicted_tokens_per_second: Number(json.timings?.predicted_per_second ?? 0),
        };
      }
    }
    return { status: 200, body: json, streamed };
  } catch (err) {
    const isTimeout = err.name === "AbortError";
    return {
      status: isTimeout ? 504 : 502,
      body: {
        error: {
          message: isTimeout ? `Upstream ${u.name} timeout after ${u.timeout_ms}ms` : `Upstream ${u.name} unreachable`,
          type: "upstream_error",
          code: isTimeout ? "upstream_timeout" : "upstream_unreachable",
          detail: err.message,
        },
      },
    };
  }
}
