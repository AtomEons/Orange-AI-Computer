const DEFAULT_TIMEOUT_MS = Number(process.env.ORANGE5_SPECIALIST_LOAD_TIMEOUT_MS || 120_000);
const DEFAULT_KEEP_ALIVE = process.env.ORANGE5_SPECIALIST_KEEP_ALIVE || '15m';
const LIVE_MODEL_MEMORY_CEILING = Number(process.env.ORANGE5_LIVE_MODEL_MEMORY_CEILING_BYTES || 50 * 1024 ** 3);
const UTILITY_MODEL_MEMORY_CEILING = Number(process.env.ORANGE5_UTILITY_MODEL_MEMORY_CEILING_BYTES || 6 * 1024 ** 3);

const jobs = new Map();
const states = new Map();
let serial = Promise.resolve();

function sameModel(name, model) {
  const clean = (value) => String(value || '').replace(/:latest$/, '');
  return clean(name) === clean(model);
}

function isUtilityRuntime(row) {
  const name = String(row?.name || row?.model || '').toLowerCase();
  const bytes = Number(row?.size || 0);
  return /(?:embed|rerank)/.test(name) && bytes > 0 && bytes <= UTILITY_MODEL_MEMORY_CEILING;
}

function residentAllowed(row, targetModel) {
  return sameModel(row?.name || row?.model, targetModel) || isUtilityRuntime(row);
}

function totalResidentBytes(rows) {
  return rows.reduce((sum, row) => sum + Math.max(0, Number(row?.size || 0)), 0);
}

async function fetchBudgeted(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function residentRuntime(baseUrl, model) {
  const response = await fetchBudgeted(`${baseUrl}/api/ps`, {}, 5_000);
  if (!response.ok) return null;
  const payload = await response.json().catch(() => ({}));
  return (payload.models || []).find((row) => sameModel(row?.name || row?.model, model)) || null;
}

async function residentRuntimes(baseUrl) {
  const response = await fetchBudgeted(`${baseUrl}/api/ps`, {}, 5_000);
  if (!response.ok) throw new Error(`resident inventory returned HTTP ${response.status}`);
  const payload = await response.json().catch(() => ({}));
  return Array.isArray(payload.models) ? payload.models : [];
}

async function unloadRuntime(baseUrl, model) {
  const response = await fetchBudgeted(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt: '', stream: false, keep_alive: 0 }),
  }, 30_000);
  if (!response.ok) throw new Error(`specialist unload returned HTTP ${response.status}`);
  await response.json().catch(() => ({}));
}

async function waitForResidents(baseUrl, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let running = [];
  do {
    running = await residentRuntimes(baseUrl);
    if (predicate(running)) return running;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  throw new Error(`resident transition timed out: ${running.map((row) => row?.name || row?.model).filter(Boolean).join(', ') || 'none'}`);
}

async function enforceSingleResident(baseUrl, targetModel) {
  const running = await residentRuntimes(baseUrl);
  const evicted = [];
  for (const row of running) {
    const model = row?.name || row?.model;
    if (!model || residentAllowed(row, targetModel)) continue;
    await unloadRuntime(baseUrl, model);
    evicted.push(model);
  }
  await waitForResidents(
    baseUrl,
    (rows) => rows.every((row) => residentAllowed(row, targetModel)),
  );
  return evicted;
}

function snapshot(model) {
  const state = states.get(model);
  return state ? { ...state } : {
    schema: 'orange.specialist-lease.v1',
    model,
    status: 'idle',
    measured_at: null,
  };
}

async function activate({ tier, baseUrl, model, keepAlive = DEFAULT_KEEP_ALIVE, loadTimeoutMs = DEFAULT_TIMEOUT_MS }) {
  const started = performance.now();
  const evicted_models = await enforceSingleResident(baseUrl, model);
  const existing = await residentRuntime(baseUrl, model).catch(() => null);
  if (existing) {
    const specialistBytes = Number(existing.size || 0);
    const running = await residentRuntimes(baseUrl);
    const teamBytes = totalResidentBytes(running);
    if (teamBytes > LIVE_MODEL_MEMORY_CEILING) {
      await unloadRuntime(baseUrl, model);
      throw new Error(`specialist team exceeds 50 GiB live ceiling: ${teamBytes} bytes`);
    }
    const state = {
      schema: 'orange.specialist-lease.v1', tier, model, status: 'ready',
      source: 'already_resident', load_ms: 0, resident_bytes: specialistBytes,
      total_resident_bytes: teamBytes,
      retained_utility_models: running.filter(isUtilityRuntime).map((row) => row?.name || row?.model),
      memory_ceiling_bytes: LIVE_MODEL_MEMORY_CEILING, evicted_models,
      measured_at: new Date().toISOString(),
    };
    states.set(model, state);
    return { ...state };
  }

  states.set(model, {
    schema: 'orange.specialist-lease.v1', tier, model, status: 'warming',
    source: 'ollama_minimal_warmup', measured_at: new Date().toISOString(),
  });
  let warmupRecoveredAfterTimeout = false;
  try {
    const response = await fetchBudgeted(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Empty-prompt `done_reason=load` is not a residency guarantee on every
      // Ollama build. One bounded token forces actual runner materialization;
      // the following /api/ps probe remains the authority.
      body: JSON.stringify({ model, prompt: '.', stream: false, think: false, keep_alive: keepAlive, options: { num_predict: 1, num_ctx: 2048 } }),
    }, loadTimeoutMs);
    if (!response.ok) throw new Error(`specialist preload returned HTTP ${response.status}`);
    await response.json().catch(() => ({}));
  } catch (error) {
    if (error?.name !== 'AbortError') throw error;
    const recovered = await waitForResidents(
      baseUrl,
      (rows) => rows.some((row) => sameModel(row?.name || row?.model, model)),
      5_000,
    ).catch(() => null);
    if (!recovered) throw error;
    warmupRecoveredAfterTimeout = true;
  }
  const finalRuntimes = await waitForResidents(
    baseUrl,
    (rows) => rows.some((row) => sameModel(row?.name || row?.model, model))
      && rows.every((row) => residentAllowed(row, model)),
  );
  const resident = finalRuntimes.find((row) => sameModel(row?.name || row?.model, model));
  const specialistBytes = Number(resident?.size || 0);
  const teamBytes = totalResidentBytes(finalRuntimes);
  if (teamBytes > LIVE_MODEL_MEMORY_CEILING) {
    await unloadRuntime(baseUrl, model);
    throw new Error(`specialist team exceeds 50 GiB live ceiling: ${teamBytes} bytes`);
  }
  const state = {
    schema: 'orange.specialist-lease.v1', tier, model, status: 'ready',
    source: warmupRecoveredAfterTimeout ? 'ollama_warmup_timeout_residency_recovered' : 'ollama_minimal_warmup',
    load_ms: Number((performance.now() - started).toFixed(2)),
    resident_bytes: specialistBytes, total_resident_bytes: teamBytes,
    retained_utility_models: finalRuntimes.filter(isUtilityRuntime).map((row) => row?.name || row?.model),
    memory_ceiling_bytes: LIVE_MODEL_MEMORY_CEILING,
    evicted_models, keep_alive: keepAlive,
    measured_at: new Date().toISOString(),
  };
  states.set(model, state);
  return { ...state };
}

function enqueue(options) {
  const current = jobs.get(options.model);
  if (current) return current;
  const job = serial.then(() => activate(options));
  serial = job.catch(() => undefined);
  jobs.set(options.model, job);
  job.catch((error) => {
    states.set(options.model, {
      schema: 'orange.specialist-lease.v1', tier: options.tier, model: options.model,
      status: 'failed', error: error?.message || String(error), measured_at: new Date().toISOString(),
    });
  }).finally(() => jobs.delete(options.model));
  return job;
}

export async function ensureSpecialistReady(options) {
  return enqueue(options);
}

export function scheduleSpecialistPrewarm(options) {
  const existing = jobs.get(options.model);
  if (existing) return { ...snapshot(options.model), scheduled: false };
  void enqueue(options);
  return {
    schema: 'orange.specialist-lease.v1', tier: options.tier, model: options.model,
    status: 'warming', source: 'background_prewarm', scheduled: true,
    measured_at: new Date().toISOString(),
  };
}

export function specialistLeaseSnapshot(model) {
  return snapshot(model);
}

export const __specialistLeaseInternals = Object.freeze({
  sameModel,
  residentRuntime,
  residentRuntimes,
  unloadRuntime,
  waitForResidents,
  enforceSingleResident,
  isUtilityRuntime,
  residentAllowed,
  LIVE_MODEL_MEMORY_CEILING,
  UTILITY_MODEL_MEMORY_CEILING,
});
