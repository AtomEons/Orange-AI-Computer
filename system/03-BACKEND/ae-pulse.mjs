import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SERVICE_CUPS, fillCup } from './cup-topology.mjs';

export const AE_PULSE_SCHEMA = 'orange.ae-pulse.v1';

const DATA_ROOT = process.env.ORANGE5_DATA_ROOT || path.join(os.homedir(), 'OrangeBox-Data', 'orange5');
const STATE_PATH = process.env.ORANGE5_AE_PULSE_STATE || path.join(DATA_ROOT, 'topology', 'ae-pulse-state.json');
const EVENTS_PATH = process.env.ORANGE5_AE_PULSE_EVENTS || path.join(DATA_ROOT, 'topology', 'ae-pulse-events.jsonl');
const sha256 = (value) => createHash('sha256').update(String(value ?? '')).digest('hex');

function writeAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

function appendEvent(event) {
  fs.mkdirSync(path.dirname(EVENTS_PATH), { recursive: true });
  fs.appendFileSync(EVENTS_PATH, `${JSON.stringify(event)}\n`, 'utf8');
}

function previousState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return null; }
}

export async function pulseOnce({ services, now = new Date() } = {}) {
  const enabled = services || Object.keys(DEFAULT_SERVICE_CUPS);
  if (process.env.ORANGE5_AE_EYES_ENABLED === '1' && !enabled.includes('ae_eyes')) enabled.push('ae_eyes');
  const prior = previousState();
  const organs = {};
  for (const serviceId of enabled) {
    try {
      organs[serviceId] = await fillCup(serviceId);
    } catch (error) {
      organs[serviceId] = { serviceId, status: 'unreachable', error: String(error?.message || error), lastCheckedAt: now.toISOString() };
    }
  }
  const required = ['orangebrain', 'hermes', 'codexa_rail', 'codexa_ollama'].filter((id) => enabled.includes(id));
  const ready = required.filter((id) => organs[id]?.status === 'ready');
  const state = {
    schema: AE_PULSE_SCHEMA,
    pid: process.pid,
    generatedAt: now.toISOString(),
    status: ready.length === required.length ? 'full' : ready.length ? 'degraded' : 'offline',
    readyRequired: ready.length,
    totalRequired: required.length,
    eyesPolicy: process.env.ORANGE5_AE_EYES_ENABLED === '1' ? 'active_sensing_enabled' : 'held',
    organs,
  };
  state.stateHash = sha256(JSON.stringify({ status: state.status, organs: Object.fromEntries(Object.entries(organs).map(([id, organ]) => [id, [organ.status, organ.selectedUrl, organ.transport]])) }));
  writeAtomic(STATE_PATH, state);
  if (!prior || prior.stateHash !== state.stateHash || now.getTime() - Date.parse(prior.generatedAt || 0) >= 300_000) {
    appendEvent({ ...state, event: prior?.stateHash === state.stateHash ? 'pulse_checkpoint' : 'topology_changed', previousHash: prior?.stateHash || null });
  }
  return state;
}

export function startPulse({ intervalMs = Number(process.env.ORANGE5_AE_PULSE_INTERVAL_MS || 15_000), services } = {}) {
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try { await pulseOnce({ services }); }
    finally { running = false; }
  };
  void tick();
  const timer = setInterval(tick, Math.max(5_000, intervalMs));
  return {
    stop() { stopped = true; clearInterval(timer); },
    statePath: STATE_PATH,
    eventsPath: EVENTS_PATH,
  };
}

if (import.meta.main) {
  const pulse = startPulse();
  const stop = () => { pulse.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
