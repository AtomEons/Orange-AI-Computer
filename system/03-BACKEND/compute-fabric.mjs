import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const FABRIC_SCHEMA = 'orange.compute-fabric.v1';
export const DEFAULT_CODEXA_NODE = Object.freeze({
  id: 'codexa',
  physicalNodeId: 'codexa',
  pathId: 'wifi',
  name: 'Codexa',
  host: '10.0.0.4',
  trusted: true,
  priority: 100,
  source: 'orange_default',
});
export const DEFAULT_CODEXA_DIRECT_NODE = Object.freeze({
  id: 'codexa-direct',
  physicalNodeId: 'codexa',
  pathId: 'direct-cat8',
  name: 'Codexa Direct',
  host: '10.0.99.1',
  trusted: true,
  // The dedicated point-to-point link is the canonical compute backplane.
  // Wi-Fi remains automatic recovery when the cable or peer is unavailable.
  priority: 120,
  source: 'orange_known_alias',
});
export const DEFAULT_CODEXA_TUNNEL_NODE = Object.freeze({
  id: 'codexa-tunnel',
  physicalNodeId: 'codexa',
  pathId: 'private-tunnel',
  name: 'Codexa Private Tunnel',
  host: 'localhost',
  physicalRemote: true,
  trusted: true,
  // Prefer the trusted low-latency LAN node when both paths are healthy.
  // The SSH tunnel remains the automatic fallback for blocked service ports.
  priority: 90,
  source: 'orange_private_tunnel',
  ports: { ollama: 11437, openai: 11436, rail: 18097, eyes: 7440 },
});

const PRIVATE_IPV4 = /^(?:10\.|127\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;
let stateCache = { path: null, mtimeMs: -1, value: null };

export function defaultFabricPath(env = process.env) {
  const explicit = String(env.ORANGE5_COMPUTE_FABRIC_PATH || '').trim();
  if (explicit) return path.resolve(explicit);
  const home = env.USERPROFILE || env.HOME || os.homedir();
  return path.join(home, 'OrangeBox-Data', 'orange5', 'compute-fabric.json');
}

export function defaultFabricReceiptPath(env = process.env) {
  const home = env.USERPROFILE || env.HOME || os.homedir();
  return path.join(home, 'OrangeBox-Data', 'orange5', 'receipts', 'orange5-compute-fabric-latest.json');
}

export function defaultRailTokenPath(env = process.env) {
  const explicit = String(env.ORANGEBOX_RAIL_TOKEN_FILE || '').trim();
  if (explicit) return path.resolve(explicit);
  const home = env.USERPROFILE || env.HOME || os.homedir();
  return path.join(home, 'OrangeBox-Data', 'orange5', 'secrets', 'rail-token.txt');
}

export function resolveRailToken(env = process.env) {
  try {
    const value = fs.readFileSync(defaultRailTokenPath(env), 'utf8').trim();
    if (value) return value;
  } catch {}
  return String(env.ORANGEBOX_RAIL_TOKEN || '').trim() || null;
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function safeHost(value) {
  const host = String(value || '').trim().replace(/^\[|\]$/g, '');
  if (!host || host.length > 253 || /[\s/@?#\\]/.test(host)) return null;
  if (net.isIP(host) === 4 && !PRIVATE_IPV4.test(host)) return null;
  if (net.isIP(host) === 6 && host !== '::1' && !/^f[cd]/i.test(host) && !/^fe80:/i.test(host)) return null;
  if (!net.isIP(host) && !/^[a-z0-9][a-z0-9.-]*$/i.test(host)) return null;
  return host;
}

function nodeId(value, host) {
  const requested = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '');
  return requested || `node-${sha256(host).slice(0, 10)}`;
}

export function normalizeComputeNode(input = {}, defaults = {}) {
  const host = safeHost(input.host ?? defaults.host);
  if (!host) return null;
  const physicalRemote = input.physicalRemote === true || defaults.physicalRemote === true;
  const local = !physicalRemote && (input.local === true || defaults.local === true || ['127.0.0.1', 'localhost', '::1'].includes(host.toLowerCase()));
  const id = nodeId(input.id ?? defaults.id, host);
  return {
    id,
    physicalNodeId: nodeId(input.physicalNodeId ?? defaults.physicalNodeId ?? id, host),
    pathId: nodeId(input.pathId ?? defaults.pathId ?? id, host),
    name: String(input.name ?? defaults.name ?? input.id ?? host).slice(0, 80),
    host,
    local,
    physicalRemote,
    trusted: local || input.trusted === true || defaults.trusted === true,
    priority: Math.max(-1000, Math.min(1000, Number(input.priority ?? defaults.priority ?? (local ? 10 : 0)) || 0)),
    source: String(input.source ?? defaults.source ?? 'configured').slice(0, 40),
    ports: {
      ollama: Number(input.ports?.ollama ?? defaults.ports?.ollama ?? 11434),
      openai: Number(input.ports?.openai ?? defaults.ports?.openai ?? 11436),
      rail: Number(input.ports?.rail ?? defaults.ports?.rail ?? 8097),
      eyes: Number(input.ports?.eyes ?? defaults.ports?.eyes ?? 7440),
    },
  };
}

function parseEnvNodes(raw) {
  const value = String(raw || '').trim();
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    const rows = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.nodes) ? parsed.nodes : [parsed]);
    return rows.map((row) => normalizeComputeNode({ ...row, source: row.source || 'environment' })).filter(Boolean);
  } catch {
    return value.split(',').map((entry, index) => {
      const [id, host = id] = entry.trim().split('@');
      return normalizeComputeNode({ id: host === id ? `env-${index + 1}` : id, host, trusted: false, source: 'environment' });
    }).filter(Boolean);
  }
}

export function readFabricState(statePath = defaultFabricPath()) {
  try {
    const stat = fs.statSync(statePath);
    if (stateCache.path === statePath && stateCache.mtimeMs === stat.mtimeMs) return stateCache.value;
    const value = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    stateCache = { path: statePath, mtimeMs: stat.mtimeMs, value };
    return value;
  } catch {
    return null;
  }
}

function configuredNodesFromState(state) {
  const rows = Array.isArray(state?.configuredNodes) ? state.configuredNodes : [];
  return rows.map((row) => normalizeComputeNode(row)).filter(Boolean);
}

export function buildDiscoveryCandidates({ env = process.env, statePath = defaultFabricPath(env), neighborHosts = [] } = {}) {
  const state = readFabricState(statePath);
  const directEnabled = String(env.ORANGE5_DISABLE_CODEXA_DIRECT || '').trim() !== '1';
  const rows = [
    normalizeComputeNode({ id: 'local', physicalNodeId: 'local', pathId: 'loopback', name: os.hostname(), host: '127.0.0.1', local: true, trusted: true, priority: 10, source: 'local' }),
    normalizeComputeNode(DEFAULT_CODEXA_NODE),
    ...(directEnabled ? [normalizeComputeNode(DEFAULT_CODEXA_DIRECT_NODE)] : []),
    normalizeComputeNode(DEFAULT_CODEXA_TUNNEL_NODE),
    ...configuredNodesFromState(state),
    ...parseEnvNodes(env.ORANGE5_COMPUTE_NODES),
    ...neighborHosts.map((host) => normalizeComputeNode({ host, trusted: false, priority: -10, source: 'neighbor_cache' })),
  ].filter(Boolean);

  const merged = new Map();
  for (const row of rows) {
    const key = row.host.toLowerCase();
    const current = merged.get(key);
    if (!current) {
      merged.set(key, row);
      continue;
    }
    merged.set(key, {
      ...current,
      ...row,
      id: current.source === 'local' || current.source === 'orange_default' ? current.id : row.id,
      name: current.source === 'local' || current.source === 'orange_default' ? current.name : row.name,
      trusted: current.trusted || row.trusted,
      priority: Math.max(current.priority, row.priority),
      source: current.source === 'configured' || row.source === 'configured' ? 'configured' : current.source,
    });
  }
  return [...merged.values()].slice(0, 32);
}

async function fetchProbe(fetchFn, url, { timeoutMs, headers } = {}) {
  const started = Date.now();
  try {
    const response = await fetchFn(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs ?? 900),
    });
    let body = null;
    if (response.ok) body = await response.json().catch(() => null);
    return { reachable: response.ok, servicePresent: response.ok || response.status === 401 || response.status === 403, status: response.status, latencyMs: Date.now() - started, body };
  } catch (error) {
    return { reachable: false, servicePresent: false, status: 0, latencyMs: Date.now() - started, error: error?.message || String(error) };
  }
}

export async function tcpProbe(host, port, timeoutMs = 700) {
  return await new Promise((resolve) => {
    const started = Date.now();
    const socket = net.createConnection({ host, port });
    let settled = false;
    const done = (reachable) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ reachable, latencyMs: Date.now() - started });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

export async function probeComputeNode(node, { fetchFn = globalThis.fetch, tcpFn = tcpProbe, timeoutMs = 900, railToken = resolveRailToken() } = {}) {
  const host = node.host;
  const railHeaders = railToken ? { 'X-Orangebox-Token': railToken } : undefined;
  // The authenticated receipt index can be larger than the unauthenticated
  // health payload. Keep discovery fast without letting concurrent model
  // inventory parsing create a false "unauthorized" rail result.
  const railTimeoutMs = Math.max(Number(timeoutMs) || 900, 2_500);
  const [ollama, openai, railHealth, railAuth, railTcp, eyes] = await Promise.all([
    fetchProbe(fetchFn, `http://${host}:${node.ports.ollama}/api/tags`, { timeoutMs }),
    fetchProbe(fetchFn, `http://${host}:${node.ports.openai}/v1/models`, { timeoutMs }),
    fetchProbe(fetchFn, `http://${host}:${node.ports.rail}/health`, { timeoutMs: railTimeoutMs }),
    fetchProbe(fetchFn, `http://${host}:${node.ports.rail}/receipts`, { timeoutMs: railTimeoutMs, headers: railHeaders }),
    tcpFn(host, node.ports.rail, timeoutMs),
    fetchProbe(fetchFn, `http://${host}:${node.ports.eyes}/health`, { timeoutMs }),
  ]);
  const ollamaModels = Array.isArray(ollama.body?.models) ? ollama.body.models.map((row) => row?.name || row?.model).filter(Boolean) : [];
  const openaiModels = Array.isArray(openai.body?.data) ? openai.body.data.map((row) => row?.id).filter(Boolean) : [];
  const capabilities = {
    ollama: {
      ready: ollama.reachable,
      kind: 'ollama',
      url: ollama.reachable ? `http://${host}:${node.ports.ollama}` : null,
      models: ollamaModels,
      modelInventory: ollama.body?.models || [],
      latencyMs: ollama.latencyMs,
    },
    openai: {
      ready: openai.reachable,
      kind: 'openai',
      url: openai.reachable ? `http://${host}:${node.ports.openai}` : null,
      models: openaiModels,
      modelInventory: openai.body?.data || [],
      latencyMs: openai.latencyMs,
    },
    inference: {
      ready: ollama.reachable || openai.reachable,
      kind: ollama.reachable ? 'ollama' : (openai.reachable ? 'openai' : null),
      url: ollama.reachable ? `http://${host}:${node.ports.ollama}` : (openai.reachable ? `http://${host}:${node.ports.openai}` : null),
      models: ollama.reachable ? ollamaModels : openaiModels,
      modelInventory: ollama.reachable ? (ollama.body?.models || []) : (openai.body?.data || []),
      latencyMs: Math.min(...[ollama, openai].filter((row) => row.reachable).map((row) => row.latencyMs), Number.POSITIVE_INFINITY),
    },
    rail: {
      ready: railHealth.servicePresent || railTcp.reachable,
      authorized: railAuth.reachable,
      tokenConfigured: railHealth.body?.tokenConfigured === true,
      status: railHealth.body?.status || null,
      authStatus: railAuth.status,
      authLatencyMs: railAuth.latencyMs,
      url: (railHealth.servicePresent || railTcp.reachable) ? `http://${host}:${node.ports.rail}` : null,
      latencyMs: Math.min(railHealth.latencyMs, railAuth.latencyMs, railTcp.latencyMs),
    },
    eyes: {
      ready: eyes.reachable,
      url: eyes.reachable ? `http://${host}:${node.ports.eyes}` : null,
      latencyMs: eyes.latencyMs,
    },
  };
  const capable = Object.values(capabilities).some((capability) => capability.ready);
  return { ...node, online: capable, probedAt: new Date().toISOString(), capabilities };
}

function selectionScore(node, capability) {
  const latency = Number.isFinite(node.capabilities?.[capability]?.latencyMs) ? node.capabilities[capability].latencyMs : 10_000;
  return (node.priority * 1000) + (node.local ? 0 : 100) - latency;
}

function selectNode(nodes, capability) {
  const eligible = nodes.filter((node) => node.trusted && node.capabilities?.[capability]?.ready);
  eligible.sort((a, b) => selectionScore(b, capability) - selectionScore(a, capability) || a.id.localeCompare(b.id));
  const node = eligible[0];
  if (!node) return null;
  const cap = node.capabilities[capability];
  return {
    nodeId: node.id,
    physicalNodeId: node.physicalNodeId,
    pathId: node.pathId,
    name: node.name,
    host: node.host,
    local: node.local,
    kind: cap.kind || capability,
    url: cap.url,
    latencyMs: cap.latencyMs,
    models: cap.models || [],
    ...(capability === 'rail' ? { authorized: cap.authorized === true, tokenConfigured: cap.tokenConfigured === true, status: cap.status || null } : {}),
  };
}

function parameterBillions(name) {
  const matches = [...String(name).toLowerCase().matchAll(/(\d+(?:\.\d+)?)b\b/g)];
  return matches.length ? Math.max(...matches.map((match) => Number(match[1]))) : null;
}

function modelRoleScore(name, role, local) {
  const value = String(name).toLowerCase();
  if (/(?:embed|rerank|whisper|clip)/.test(value)) return -10_000;
  let score = 0;
  if (role === 'navigator') {
    if (/orange[-_]?navigator/.test(value)) score += 2_000;
    if (/qwen3/.test(value)) score += 1_000;
    if (/hermes/.test(value)) score += 800;
    if (/llama|mistral|gemma/.test(value)) score += 500;
  } else if (role === 'code') {
    if (/coder|code[-_]/.test(value)) score += 2_000;
    if (/qwen/.test(value)) score += 600;
  } else if (role === 'heavy') {
    if (/qwen3.*(?:30b|32b|35b)|deepseek|glm|mixtral|70b|72b/.test(value)) score += 2_000;
    if (/qwen3|hermes/.test(value)) score += 700;
  }
  const billions = parameterBillions(value);
  if (billions != null) score += local ? Math.max(-800, 400 - billions * 80) : Math.min(800, billions * 15);
  return score;
}

function modelQualifies(name, role) {
  const value = String(name || '').toLowerCase();
  if (role === 'code') return /coder|code[-_:]/.test(value);
  if (role === 'heavy') return /deepseek|glm|mixtral/.test(value) || (parameterBillions(value) ?? 0) >= 14;
  return true;
}

function selectModelRole(nodes, role, preferredModel = null) {
  const eligible = nodes.filter((node) => node.trusted && node.capabilities?.inference?.ready);
  const ranked = eligible.flatMap((node) => {
    const services = role === 'navigator' ? ['openai', 'ollama'] : ['ollama', 'openai'];
    return services.filter((kind) => node.capabilities[kind]?.ready).map((kind) => {
      const capability = node.capabilities[kind];
      const models = capability.models || [];
      const actualModel = [...models].sort((a, b) => {
        const aPreferred = preferredModel && (a === preferredModel || a === `${preferredModel}:latest`) ? 1 : 0;
        const bPreferred = preferredModel && (b === preferredModel || b === `${preferredModel}:latest`) ? 1 : 0;
        return bPreferred - aPreferred || modelRoleScore(b, role, node.local) - modelRoleScore(a, role, node.local) || a.localeCompare(b);
      })[0] || null;
      // A dedicated llama.cpp endpoint commonly exposes only its GGUF path.
      // Orange owns the role alias; keep the backend path as evidence while
      // selecting the operator-facing model name deterministically.
      const model = role === 'navigator' && kind === 'openai' && preferredModel && models.length === 1
        ? preferredModel
        : actualModel;
      const transportBonus = role === 'navigator' && kind === 'openai' ? 30_000_000 : (role !== 'navigator' && kind === 'ollama' ? 5_000_000 : 0);
      const preferredBonus = preferredModel && (model === preferredModel || model === `${preferredModel}:latest`) ? 100_000_000 : 0;
      return { node, capability, model, actualModel, score: selectionScore(node, 'inference') + modelRoleScore(model, role, node.local) * 10_000 + transportBonus + preferredBonus };
    });
  }).sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id));
  const picked = ranked.find((row) => modelQualifies(row.model, role));
  if (!picked) return null;
  const cap = picked.capability;
  return {
    nodeId: picked.node.id,
    physicalNodeId: picked.node.physicalNodeId,
    pathId: picked.node.pathId,
    name: picked.node.name,
    host: picked.node.host,
    local: picked.node.local,
    kind: cap.kind,
    url: cap.url,
    latencyMs: cap.latencyMs,
    model: picked.model,
    actualModel: picked.actualModel,
    models: cap.models || [],
  };
}

function publicConfiguredNode(node) {
  return { id: node.id, physicalNodeId: node.physicalNodeId, pathId: node.pathId, name: node.name, host: node.host, local: node.local, physicalRemote: node.physicalRemote, trusted: node.trusted, priority: node.priority, source: node.source, ports: node.ports };
}

export async function discoverComputeFabric({
  env = process.env,
  statePath = defaultFabricPath(env),
  receiptPath = defaultFabricReceiptPath(env),
  neighborHosts = [],
  fetchFn = globalThis.fetch,
  tcpFn = tcpProbe,
  timeoutMs = 900,
  persist = true,
} = {}) {
  const candidates = buildDiscoveryCandidates({ env, statePath, neighborHosts });
  const railToken = resolveRailToken(env);
  const nodes = await Promise.all(candidates.map((node) => probeComputeNode(node, { fetchFn, tcpFn, timeoutMs, railToken })));
  const selections = {
    inference: selectNode(nodes, 'inference'),
    navigator: selectModelRole(nodes, 'navigator', env.ORANGE5_NAVIGATOR_MODEL || 'orange-navigator:ornith-1.5-9b-q4km'),
    code: selectModelRole(nodes, 'code', env.ORANGE5_CODEXA_CODE_MODEL || 'qwen3-coder:30b'),
    heavy: selectModelRole(nodes, 'heavy', env.ORANGE5_CODEXA_HEAVY_MODEL || 'qwen3:30b-a3b'),
    rail: selectNode(nodes, 'rail'),
    eyes: selectNode(nodes, 'eyes'),
  };
  const trustedRemote = nodes.filter((node) => !node.local && node.trusted && node.online);
  const untrustedDiscovered = nodes.filter((node) => !node.local && !node.trusted && node.online);
  const localCapable = nodes.some((node) => node.local && node.capabilities.inference.ready);
  const mode = trustedRemote.length ? 'distributed' : 'single_machine';
  const operational = Boolean(selections.inference);
  const status = operational
    ? (untrustedDiscovered.length ? 'OPERATIONAL_WITH_UNTRUSTED_DISCOVERY' : `OPERATIONAL_${mode.toUpperCase()}`)
    : 'NO_INFERENCE_RUNTIME';
  const previous = readFabricState(statePath);
  const configuredNodes = configuredNodesFromState(previous).map(publicConfiguredNode);
  const state = {
    schema: FABRIC_SCHEMA,
    status,
    operational,
    mode,
    generatedAt: new Date().toISOString(),
    localFallbackReady: localCapable,
    operatorDecisionRequired: untrustedDiscovered.length > 0,
    decisionReason: untrustedDiscovered.length ? 'Untrusted network AI capability discovered; trust and priority require operator confirmation.' : null,
    configuredNodes,
    selections,
    nodes,
    untrustedDiscovered: untrustedDiscovered.map((node) => ({ id: node.id, name: node.name, host: node.host, capabilities: node.capabilities })),
  };
  state.sha256 = sha256(stableJson(state));
  if (persist) {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    fs.writeFileSync(receiptPath, `${JSON.stringify({ ...state, configuredNodes: undefined, receiptType: 'compute_fabric_discovery' }, null, 2)}\n`, 'utf8');
    stateCache = { path: null, mtimeMs: -1, value: null };
  }
  return state;
}

export function resolveComputeEndpointsSync({ env = process.env, statePath = defaultFabricPath(env) } = {}) {
  const state = readFabricState(statePath);
  const inference = state?.selections?.inference;
  const navigator = state?.selections?.navigator || inference;
  const code = state?.selections?.code || null;
  const heavy = state?.selections?.heavy || null;
  const rail = state?.selections?.rail;
  const eyes = state?.selections?.eyes;
  return {
    mode: state?.mode || 'unknown',
    inferenceUrl: inference?.url || null,
    inferenceHost: inference?.host || null,
    inferenceNodeId: inference?.nodeId || null,
    inferenceKind: inference?.kind || null,
    navigatorUrl: navigator?.url || inference?.url || null,
    navigatorHost: navigator?.host || inference?.host || null,
    navigatorNodeId: navigator?.nodeId || inference?.nodeId || null,
    navigatorPhysicalRemote: navigator?.local === false,
    navigatorKind: navigator?.kind || inference?.kind || null,
    navigatorModel: navigator?.model || null,
    codeUrl: code?.url || null,
    codeHost: code?.host || null,
    codeNodeId: code?.nodeId || null,
    codeKind: code?.kind || null,
    codeModel: code?.model || null,
    heavyUrl: heavy?.url || null,
    heavyHost: heavy?.host || null,
    heavyNodeId: heavy?.nodeId || null,
    heavyKind: heavy?.kind || null,
    heavyModel: heavy?.model || null,
    railUrl: rail?.url || null,
    railHost: rail?.host || null,
    eyesUrl: eyes?.url || null,
    eyesHost: eyes?.host || null,
    eyesNodeId: eyes?.nodeId || null,
    stateHash: state?.sha256 || null,
    generatedAt: state?.generatedAt || null,
  };
}

export function configureComputeNode(input, { env = process.env, statePath = defaultFabricPath(env) } = {}) {
  const node = normalizeComputeNode({ ...input, source: 'configured' });
  if (!node) throw new TypeError('a private/local host and valid node definition are required');
  const current = readFabricState(statePath) || { schema: FABRIC_SCHEMA, configuredNodes: [] };
  const configured = configuredNodesFromState(current).filter((row) => row.id !== node.id && row.host.toLowerCase() !== node.host.toLowerCase());
  configured.push(node);
  const next = { ...current, configuredNodes: configured.map(publicConfiguredNode), generatedAt: new Date().toISOString() };
  next.sha256 = sha256(stableJson({ ...next, sha256: undefined }));
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  stateCache = { path: null, mtimeMs: -1, value: null };
  return publicConfiguredNode(node);
}

export const __fabricInternals = Object.freeze({ modelQualifies, modelRoleScore, parameterBillions, parseEnvNodes, safeHost, selectNode, selectModelRole, stableJson });
