import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CUP_SCHEMA = 'orange.cup-topology.v1';

const DEFAULT_ROOT = process.env.ORANGE5_DATA_ROOT || path.join(os.homedir(), 'OrangeBox-Data', 'orange5');
const DEFAULT_STATE_PATH = path.join(DEFAULT_ROOT, 'topology', 'cup-state.json');
const sha256 = (value) => createHash('sha256').update(String(value ?? '')).digest('hex');
const cleanUrl = (value) => String(value ?? '').trim().replace(/\/+$/, '');

const TRANSPORT_SCORE = Object.freeze({
  loopback: 130,
  direct_ethernet: 125,
  local_hostname: 112,
  wifi_static: 105,
  lan_hostname: 100,
  substitute: 80,
});

export const DEFAULT_SERVICE_CUPS = Object.freeze({
  orangebrain: {
    healthPath: '/healthz',
    candidates: [
      { url: 'http://127.0.0.1:1337', transport: 'loopback' },
      { url: 'http://localhost:1337', transport: 'local_hostname' },
    ],
    semantic: (body) => body?.primary?.live === true || body?.status === 'ok' || body?.ok === true,
  },
  hermes: {
    healthPath: '/healthz',
    candidates: [
      { url: 'http://127.0.0.1:7430', transport: 'loopback' },
      { url: 'http://localhost:7430', transport: 'local_hostname' },
    ],
    semantic: (body) => body?.ok === true || /ready|healthy|ok/i.test(String(body?.status || '')),
  },
  codexa_rail: {
    healthPath: '/health',
    candidates: [
      { url: 'http://10.0.99.1:8097', transport: 'direct_ethernet' },
      { url: 'http://CODEXA:8097', transport: 'lan_hostname' },
      { url: 'http://CODEXA.local:8097', transport: 'lan_hostname' },
      { url: 'http://10.0.0.4:8097', transport: 'wifi_static' },
    ],
    acceptUnauthorized: true,
    semantic: (body, status) => status === 401 || body?.ok === true || /ready|healthy|unauthorized/i.test(String(body?.status || body?.error || '')),
  },
  codexa_ollama: {
    healthPath: '/api/tags',
    candidates: [
      { url: 'http://10.0.99.1:11434', transport: 'direct_ethernet' },
      { url: 'http://CODEXA:11434', transport: 'lan_hostname' },
      { url: 'http://CODEXA.local:11434', transport: 'lan_hostname' },
      { url: 'http://10.0.0.4:11434', transport: 'wifi_static' },
    ],
    semantic: (body) => Array.isArray(body?.models),
  },
});

function readState(filePath = DEFAULT_STATE_PATH) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return { schema: CUP_SCHEMA, services: {} }; }
}

function writeState(state, filePath = DEFAULT_STATE_PATH) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

async function request(url, { timeoutMs = 2_500, headers = {}, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetchImpl(url, { headers: { accept: 'application/json', ...headers }, signal: controller.signal });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = { text: text.slice(0, 1_000) }; }
    return { reachable: true, status: response.status, latencyMs: Number((performance.now() - started).toFixed(1)), body };
  } catch (error) {
    return { reachable: false, status: 0, latencyMs: Number((performance.now() - started).toFixed(1)), error: error?.name === 'AbortError' ? 'timeout' : String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

function configuredCandidates(serviceId, spec, env = process.env) {
  const envKey = `ORANGE5_${serviceId.toUpperCase()}_URL`;
  const configured = cleanUrl(env[envKey]);
  const candidates = [...(spec.candidates || [])];
  if (configured && !candidates.some((candidate) => cleanUrl(candidate.url) === configured)) {
    candidates.unshift({ url: configured, transport: 'operator_configured' });
  }
  return candidates.map((candidate, index) => ({ ...candidate, url: cleanUrl(candidate.url), priority: candidate.priority ?? (TRANSPORT_SCORE[candidate.transport] || 90) - index }));
}

export async function probeCup(serviceId, spec = DEFAULT_SERVICE_CUPS[serviceId], options = {}) {
  if (!spec) throw new Error(`unknown Cup service: ${serviceId}`);
  const headers = { ...(options.headers || {}) };
  if (serviceId === 'codexa_rail' && process.env.ORANGEBOX_RAIL_TOKEN) headers.authorization = `Bearer ${process.env.ORANGEBOX_RAIL_TOKEN}`;
  const probes = await Promise.all(configuredCandidates(serviceId, spec, options.env).map(async (candidate) => {
    const result = await request(`${candidate.url}${spec.healthPath || '/healthz'}`, { ...options, headers });
    const semantic = result.reachable && (spec.acceptUnauthorized && result.status === 401
      ? true
      : Boolean(spec.semantic?.(result.body, result.status) ?? (result.status >= 200 && result.status < 300)));
    const score = semantic ? candidate.priority - Math.min(35, result.latencyMs / 25) : -1_000;
    return { ...candidate, ...result, semantic, score: Number(score.toFixed(3)) };
  }));
  return probes.sort((a, b) => b.score - a.score);
}

export async function fillCup(serviceId, options = {}) {
  const statePath = options.statePath || DEFAULT_STATE_PATH;
  const state = readState(statePath);
  const previous = state.services?.[serviceId] || null;
  const probes = await probeCup(serviceId, options.spec || DEFAULT_SERVICE_CUPS[serviceId], options);
  const best = probes.find((probe) => probe.semantic) || null;
  const previousProbe = previous?.selectedUrl ? probes.find((probe) => probe.url === previous.selectedUrl) : null;
  const hysteresis = Number(options.hysteresis ?? 8);
  const selected = previousProbe?.semantic && best && best.score < previousProbe.score + hysteresis ? previousProbe : best;
  const now = new Date().toISOString();
  const record = {
    serviceId,
    identity: `service:${serviceId}`,
    status: selected ? 'ready' : 'unreachable',
    selectedUrl: selected?.url || null,
    transport: selected?.transport || null,
    latencyMs: selected?.latencyMs ?? null,
    lastCheckedAt: now,
    lastHealthyAt: selected ? now : previous?.lastHealthyAt || null,
    consecutiveFailures: selected ? 0 : Number(previous?.consecutiveFailures || 0) + 1,
    changed: previous?.selectedUrl !== (selected?.url || null) || previous?.status !== (selected ? 'ready' : 'unreachable'),
    probes: probes.map(({ body, ...probe }) => ({ ...probe, bodyHash: body == null ? null : sha256(JSON.stringify(body)) })),
  };
  state.schema = CUP_SCHEMA;
  state.updatedAt = now;
  state.services ||= {};
  state.services[serviceId] = record;
  state.stateHash = sha256(JSON.stringify(state.services));
  writeState(state, statePath);
  return record;
}

export function cupState(filePath = DEFAULT_STATE_PATH) {
  return readState(filePath);
}
