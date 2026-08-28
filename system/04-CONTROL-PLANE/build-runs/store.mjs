import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const BUILD_RUN_SCHEMA = 'atomic-orange.build-run.v1';
export const BUILD_RUN_EVENT_SCHEMA = 'atomic-orange.build-run.event.v1';
export const BUILD_RUN_MODES = Object.freeze(['plan', 'execute', 'repair', 'verify', 'release']);
export const BUILD_RUN_STAGES = Object.freeze(['intake', 'route', 'plan', 'approve', 'lease', 'execute', 'observe', 'verify', 'settle']);
export const BUILD_RUN_STATUSES = Object.freeze(['draft', 'planned', 'awaiting_approval', 'working', 'blocked', 'failed', 'completed', 'cancelled']);

const DEFAULT_ROOT = process.env.ORANGE5_DATA_ROOT
  || path.join(os.homedir(), 'OrangeBox-Data', 'orange5');
export const DEFAULT_BUILD_RUN_PATH = process.env.ORANGE5_BUILD_RUN_PATH
  || path.join(DEFAULT_ROOT, 'control', 'build-runs', 'events.jsonl');

const writeTails = new Map();
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const text = (value, max = 4_000) => String(value ?? '').replace(/\u0000/g, '').slice(0, max);
const array = (value) => Array.isArray(value) ? value : [];

function normalizeRun(raw = {}, previous = null) {
  const now = new Date().toISOString();
  const runId = text(raw.runId || previous?.runId || `run-${randomUUID()}`, 160);
  const mode = BUILD_RUN_MODES.includes(raw.mode) ? raw.mode : (previous?.mode || 'plan');
  const stage = BUILD_RUN_STAGES.includes(raw.stage) ? raw.stage : (previous?.stage || 'intake');
  const status = BUILD_RUN_STATUSES.includes(raw.status) ? raw.status : (previous?.status || 'draft');
  return {
    schema: BUILD_RUN_SCHEMA,
    runId,
    threadId: raw.threadId === null ? null : text(raw.threadId || previous?.threadId || '', 256) || null,
    goal: text(raw.goal ?? previous?.goal ?? '', 16_000),
    projectRoot: text(raw.projectRoot ?? previous?.projectRoot ?? '', 2_048),
    workspaceRoots: array(raw.workspaceRoots ?? previous?.workspaceRoots).map((item) => text(item, 2_048)).filter(Boolean).slice(0, 32),
    mode,
    stage,
    status,
    order: raw.order === undefined ? (previous?.order ?? null) : raw.order,
    route: raw.route === undefined ? (previous?.route ?? null) : raw.route,
    modelLane: raw.modelLane === undefined ? (previous?.modelLane ?? null) : raw.modelLane,
    leases: array(raw.leases ?? previous?.leases).slice(0, 128),
    tasks: array(raw.tasks ?? previous?.tasks).slice(0, 512),
    tools: array(raw.tools ?? previous?.tools).slice(0, 256),
    approvals: array(raw.approvals ?? previous?.approvals).slice(0, 128),
    evidence: array(raw.evidence ?? previous?.evidence).slice(0, 512),
    receipts: array(raw.receipts ?? previous?.receipts).slice(0, 512),
    blockers: array(raw.blockers ?? previous?.blockers).slice(0, 128),
    nextAction: raw.nextAction === null ? null : text(raw.nextAction ?? previous?.nextAction ?? '', 4_000) || null,
    createdAt: previous?.createdAt || text(raw.createdAt || now, 64),
    updatedAt: now,
  };
}

export function validateBuildRun(run) {
  const errors = [];
  if (run?.schema !== BUILD_RUN_SCHEMA) errors.push(`schema must be ${BUILD_RUN_SCHEMA}`);
  if (!run?.runId) errors.push('runId is required');
  if (!BUILD_RUN_MODES.includes(run?.mode)) errors.push('mode is invalid');
  if (!BUILD_RUN_STAGES.includes(run?.stage)) errors.push('stage is invalid');
  if (!BUILD_RUN_STATUSES.includes(run?.status)) errors.push('status is invalid');
  for (const field of ['workspaceRoots', 'leases', 'tasks', 'tools', 'approvals', 'evidence', 'receipts', 'blockers']) {
    if (!Array.isArray(run?.[field])) errors.push(`${field} must be an array`);
  }
  return { ok: errors.length === 0, errors };
}

function parseEvents(filePath) {
  if (!fs.existsSync(filePath)) return { events: [], errors: [] };
  const events = [];
  const errors = [];
  fs.readFileSync(filePath, 'utf8').split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      if (event?.schema === BUILD_RUN_EVENT_SCHEMA) events.push(event);
      else errors.push({ line: index + 1, code: 'invalid_event_schema' });
    } catch (error) {
      errors.push({ line: index + 1, code: 'malformed_jsonl', message: error.message });
    }
  });
  return { events, errors };
}

export function verifyBuildRunChain(events, parseErrors = []) {
  const errors = [...parseErrors];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const expected = sha256(JSON.stringify({ ...event, eventHash: null }));
    if (event.eventHash !== expected) errors.push({ seq: event.seq, code: 'event_hash_mismatch' });
    if (index > 0) {
      const previous = events[index - 1];
      if (event.seq !== previous.seq + 1) errors.push({ seq: event.seq, code: 'sequence_gap' });
      if (event.prevHash !== previous.eventHash) errors.push({ seq: event.seq, code: 'previous_hash_mismatch' });
    }
  }
  return { ok: errors.length === 0, checked: events.length, errors };
}

function projections(events) {
  const runs = new Map();
  for (const event of events) runs.set(event.run.runId, event.run);
  return [...runs.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function appendEvent(filePath, type, run) {
  const execute = async () => {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const parsed = parseEvents(filePath);
    const { events } = parsed;
    const chain = verifyBuildRunChain(events, parsed.errors);
    if (!chain.ok) {
      const detail = chain.errors.map((error) => `${error.code}${error.line ? ` at line ${error.line}` : ''}`).join(', ');
      throw new Error(`build run event chain verification failed: ${detail}`);
    }
    const previous = events.at(-1) || null;
    const event = {
      schema: BUILD_RUN_EVENT_SCHEMA,
      seq: (previous?.seq || 0) + 1,
      eventId: `bre-${randomUUID()}`,
      eventType: type,
      createdAt: new Date().toISOString(),
      run,
      prevHash: previous?.eventHash || null,
      eventHash: null,
    };
    event.eventHash = sha256(JSON.stringify({ ...event, eventHash: null }));
    await fsp.appendFile(filePath, `${JSON.stringify(event)}\n`, 'utf8');
    return event;
  };
  const tail = writeTails.get(filePath) || Promise.resolve();
  const queued = tail.then(execute, execute);
  writeTails.set(filePath, queued.then(() => undefined, () => undefined));
  return queued;
}

export class BuildRunStore {
  constructor(filePath = DEFAULT_BUILD_RUN_PATH) {
    this.filePath = filePath;
  }

  list({ threadId, status, limit = 100 } = {}) {
    const parsed = parseEvents(this.filePath);
    const { events } = parsed;
    const runs = projections(events).filter((run) => {
      if (threadId && run.threadId !== threadId) return false;
      if (status && run.status !== status) return false;
      return true;
    }).slice(0, Math.max(1, Math.min(500, Number(limit) || 100)));
    return { schema: 'atomic-orange.build-run.page.v1', runs, chain: verifyBuildRunChain(events, parsed.errors), diskPath: this.filePath };
  }

  get(runId) {
    return this.list({ limit: 500 }).runs.find((run) => run.runId === runId) || null;
  }

  async create(input = {}) {
    const run = normalizeRun(input);
    const validation = validateBuildRun(run);
    if (!validation.ok) throw new Error(validation.errors.join('; '));
    if (this.get(run.runId)) throw new Error(`build run already exists: ${run.runId}`);
    const event = await appendEvent(this.filePath, 'created', run);
    return { run, event };
  }

  async update(runId, patch = {}, eventType = 'updated') {
    const previous = this.get(runId);
    if (!previous) throw new Error(`build run not found: ${runId}`);
    const run = normalizeRun({ ...patch, runId }, previous);
    const validation = validateBuildRun(run);
    if (!validation.ok) throw new Error(validation.errors.join('; '));
    const event = await appendEvent(this.filePath, eventType, run);
    return { run, event };
  }

  async ensureForThread({ threadId, goal, projectRoot = '', workspaceRoots = [], mode = 'plan' } = {}) {
    if (!threadId) return this.create({ goal, projectRoot, workspaceRoots, mode });
    const existing = this.list({ threadId, limit: 1 }).runs[0];
    if (existing && !['completed', 'cancelled', 'failed'].includes(existing.status)) return { run: existing, event: null, existing: true };
    return this.create({ threadId, goal, projectRoot, workspaceRoots, mode });
  }
}
