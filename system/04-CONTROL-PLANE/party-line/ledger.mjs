import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const PARTY_LINE_SCHEMA = 'orange.party-line.event.v1';
export const PARTY_LINE_DETAIL_LEVELS = Object.freeze(['quiet', 'normal', 'deep', 'wire']);
export const PARTY_LINE_EVENT_TYPES = Object.freeze([
  'message',
  'order',
  'report',
  'decision',
  'tool',
  'receipt',
  'status',
  'blocker',
  'repair',
]);

const DEFAULT_ROOT = process.env.ORANGE5_DATA_ROOT
  || path.join(os.homedir(), 'OrangeBox-Data', 'orange5');
export const DEFAULT_PARTY_LINE_PATH = process.env.ORANGE5_PARTY_LINE_PATH
  || path.join(DEFAULT_ROOT, 'control', 'party-line', 'events.jsonl');
export const MAX_EVENT_BYTES = 256 * 1024;
export const DEFAULT_SCAN_BYTES = 4 * 1024 * 1024;

const cleanText = (value, max = 64_000) => String(value ?? '').replace(/\u0000/g, '').slice(0, max);
let writeTail = Promise.resolve();
const WAVE3_ACTIVATION_PATTERN = /^[a-f0-9]{25}$/;
const WAVE3_HASH_PATTERN = /^[a-f0-9]{64}$/;

function wave3ActiveIds(activationBitset) {
  const bits = [...activationBitset]
    .map((nibble) => Number.parseInt(nibble, 16).toString(2).padStart(4, '0'))
    .join('');
  return [...bits]
    .map((bit, index) => bit === '1' ? `W3K-${String(index + 1).padStart(3, '0')}` : null)
    .filter(Boolean);
}

function wave3Hex(value, pattern, field) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!pattern.test(normalized)) throw new Error(`party-line wave3Kernel ${field} is invalid`);
  return normalized;
}

function sameWave3Kernel(left, right) {
  return left?.activationBitset === right?.activationBitset
    && left?.manifestHash === right?.manifestHash
    && left?.worksetHash === right?.worksetHash
    && Array.isArray(left?.activeMechanismIds)
    && Array.isArray(right?.activeMechanismIds)
    && left.activeMechanismIds.length === right.activeMechanismIds.length
    && left.activeMechanismIds.every((id, index) => id === right.activeMechanismIds[index]);
}

export function normalizeWave3KernelSummary(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('party-line wave3Kernel summary must be an object');
  }
  const activationBitset = wave3Hex(
    value.activationBitset ?? value.activation_bitset,
    WAVE3_ACTIVATION_PATTERN,
    'activationBitset',
  );
  const manifestHash = wave3Hex(
    value.manifestHash ?? value.manifest_hash,
    WAVE3_HASH_PATTERN,
    'manifestHash',
  );
  const worksetHash = wave3Hex(
    value.worksetHash ?? value.workset_hash,
    WAVE3_HASH_PATTERN,
    'worksetHash',
  );
  const suppliedIds = value.activeMechanismIds
    ?? value.active_mechanism_ids
    ?? value.activeIds
    ?? value.active_ids;
  if (!Array.isArray(suppliedIds)) {
    throw new Error('party-line wave3Kernel activeMechanismIds must be an array');
  }
  const normalizedIds = suppliedIds.map((id) => String(id ?? '').trim().toUpperCase());
  const activeMechanismIds = wave3ActiveIds(activationBitset);
  const suppliedSet = new Set(normalizedIds);
  if (suppliedSet.size !== normalizedIds.length
    || suppliedSet.size !== activeMechanismIds.length
    || activeMechanismIds.some((id) => !suppliedSet.has(id))) {
    throw new Error('party-line wave3Kernel activationBitset does not match activeMechanismIds');
  }
  return { activationBitset, manifestHash, worksetHash, activeMechanismIds };
}

export function extractWave3KernelSummary(raw = {}) {
  const containers = [
    raw,
    raw.detail,
    raw.detail?.order,
    raw.detail?.order?.workObject,
    raw.detail?.order?.payload?.parentOrder?.workObject,
    raw.detail?.receipt,
  ].filter((value) => value && typeof value === 'object');
  const candidates = containers
    .flatMap((container) => [container.wave3Kernel, container.wave3_kernel])
    .filter((value) => value != null)
    .map(normalizeWave3KernelSummary);
  if (candidates.length === 0) return null;
  if (candidates.some((candidate) => !sameWave3Kernel(candidate, candidates[0]))) {
    throw new Error('party-line event contains conflicting wave3Kernel summaries');
  }
  return candidates[0];
}

const hashEvent = (event) => createHash('sha256')
  .update(JSON.stringify(event))
  .digest('hex');

function stableId(event) {
  const material = JSON.stringify({
    createdAt: event.createdAt,
    actor: event.actor,
    eventType: event.eventType,
    summary: event.summary,
    correlationId: event.correlationId,
  });
  return `pl-${createHash('sha256').update(material).digest('hex').slice(0, 20)}`;
}

function normalizeActor(actor = {}) {
  const kind = ['operator', 'model', 'agent', 'tool', 'system'].includes(actor.kind)
    ? actor.kind
    : 'system';
  return {
    id: cleanText(actor.id || actor.name || kind, 128),
    kind,
    displayName: cleanText(actor.displayName || actor.name || actor.id || kind, 160),
    model: actor.model ? cleanText(actor.model, 256) : null,
    node: actor.node ? cleanText(actor.node, 256) : null,
  };
}

function normalizeSourceRef(ref) {
  if (typeof ref === 'string') return { uri: cleanText(ref, 2_048), hash: null, label: null };
  if (!ref || typeof ref !== 'object') return null;
  const uri = cleanText(ref.uri || ref.path || ref.receiptPath || '', 2_048);
  if (!uri) return null;
  return {
    uri,
    hash: ref.hash ? cleanText(ref.hash, 128) : null,
    label: ref.label ? cleanText(ref.label, 256) : null,
  };
}

export function normalizePartyLineEvent(raw = {}, { now = new Date().toISOString() } = {}) {
  const eventType = PARTY_LINE_EVENT_TYPES.includes(raw.eventType) ? raw.eventType : 'status';
  const summary = cleanText(raw.summary || raw.body || '', 2_000).trim();
  if (!summary) throw new Error('party-line summary is required');

  const event = {
    schema: PARTY_LINE_SCHEMA,
    id: cleanText(raw.id || '', 128),
    seq: Number.isInteger(raw.seq) ? raw.seq : null,
    createdAt: cleanText(raw.createdAt || now, 64),
    projectId: cleanText(raw.projectId || 'orange5', 256),
    topic: cleanText(raw.topic || 'operations', 256),
    actor: normalizeActor(raw.actor),
    eventType,
    status: raw.status ? cleanText(raw.status, 128) : null,
    summary,
    body: raw.body == null ? null : cleanText(raw.body),
    detail: raw.detail && typeof raw.detail === 'object' ? raw.detail : null,
    wave3Kernel: extractWave3KernelSummary(raw),
    sourceRefs: (Array.isArray(raw.sourceRefs) ? raw.sourceRefs : [])
      .map(normalizeSourceRef)
      .filter(Boolean)
      .slice(0, 32),
    tags: (Array.isArray(raw.tags) ? raw.tags : [])
      .map((tag) => cleanText(tag, 96).toLowerCase())
      .filter(Boolean)
      .slice(0, 24),
    correlationId: raw.correlationId ? cleanText(raw.correlationId, 256) : null,
    replyTo: raw.replyTo ? cleanText(raw.replyTo, 128) : null,
    importance: Math.max(0, Math.min(1, Number(raw.importance ?? 0.5) || 0)),
    prevHash: raw.prevHash ? cleanText(raw.prevHash, 64) : null,
    entryHash: raw.entryHash ? cleanText(raw.entryHash, 64) : null,
  };
  event.id ||= stableId(event) || `pl-${randomUUID()}`;
  return event;
}

export function validatePartyLineEvent(event) {
  const errors = [];
  if (!event || typeof event !== 'object' || Array.isArray(event)) errors.push('event must be an object');
  if (event?.schema !== PARTY_LINE_SCHEMA) errors.push(`schema must be ${PARTY_LINE_SCHEMA}`);
  if (typeof event?.id !== 'string' || !event.id) errors.push('id is required');
  if (!Number.isInteger(event?.seq) || event.seq < 1) errors.push('seq must be a positive integer');
  if (typeof event?.createdAt !== 'string' || Number.isNaN(Date.parse(event.createdAt))) errors.push('createdAt must be ISO time');
  if (!PARTY_LINE_EVENT_TYPES.includes(event?.eventType)) errors.push('eventType is invalid');
  if (typeof event?.summary !== 'string' || !event.summary.trim()) errors.push('summary is required');
  if (!event?.actor || typeof event.actor.id !== 'string') errors.push('actor is required');
  if (event?.wave3Kernel != null) {
    try {
      const normalized = normalizeWave3KernelSummary(event.wave3Kernel);
      if (!sameWave3Kernel(event.wave3Kernel, normalized)) errors.push('wave3Kernel summary is not canonical');
    } catch (error) {
      errors.push(error?.message || 'wave3Kernel summary is invalid');
    }
  }
  if (event?.prevHash != null && !/^[a-f0-9]{64}$/.test(event.prevHash)) errors.push('prevHash is invalid');
  if (!/^[a-f0-9]{64}$/.test(event?.entryHash || '')) errors.push('entryHash is invalid');
  return { ok: errors.length === 0, errors };
}

async function readLastEvent(filePath) {
  let stat;
  try { stat = await fsp.stat(filePath); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.size) return null;
  const start = Math.max(0, stat.size - 512 * 1024);
  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(stat.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').trimEnd().split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const event = JSON.parse(lines[index]);
        if (event?.schema === PARTY_LINE_SCHEMA) return event;
      } catch {}
    }
    return null;
  } finally {
    await handle.close();
  }
}

export async function appendPartyLineEvent(raw, {
  filePath = DEFAULT_PARTY_LINE_PATH,
  now,
  fsync = false,
} = {}) {
  const run = async () => {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const previous = await readLastEvent(filePath);
    const event = normalizePartyLineEvent(raw, { now });
    event.seq = Number.isInteger(previous?.seq) ? previous.seq + 1 : 1;
    event.prevHash = previous?.entryHash || null;
    event.entryHash = hashEvent({ ...event, entryHash: null });
    const validation = validatePartyLineEvent(event);
    if (!validation.ok) throw new Error(`invalid party-line event: ${validation.errors.join('; ')}`);
    const line = `${JSON.stringify(event)}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes > MAX_EVENT_BYTES) throw new Error(`party-line event exceeds ${MAX_EVENT_BYTES} bytes`);
    await fsp.appendFile(filePath, line, 'utf8');
    if (fsync) {
      const handle = await fsp.open(filePath, 'r+');
      try { await handle.sync(); } finally { await handle.close(); }
    }
    return { event, cursor: (await fsp.stat(filePath)).size };
  };
  const queued = writeTail.then(run, run);
  writeTail = queued.then(() => undefined, () => undefined);
  return queued;
}

function matchesFilters(event, filters = {}) {
  if (filters.projectId && event.projectId !== filters.projectId) return false;
  if (filters.topic && event.topic !== filters.topic) return false;
  if (filters.actor && event.actor?.id !== filters.actor && event.actor?.kind !== filters.actor) return false;
  if (filters.eventType && event.eventType !== filters.eventType) return false;
  if (filters.correlationId && event.correlationId !== filters.correlationId) return false;
  return true;
}

export function projectPartyLineEvent(event, detail = 'normal') {
  const level = PARTY_LINE_DETAIL_LEVELS.includes(detail) ? detail : 'normal';
  const base = {
    schema: event.schema,
    id: event.id,
    seq: event.seq,
    createdAt: event.createdAt,
    projectId: event.projectId,
    topic: event.topic,
    actor: event.actor,
    eventType: event.eventType,
    status: event.status,
    summary: event.summary,
    importance: event.importance,
    entryHash: event.entryHash,
    wave3Kernel: event.wave3Kernel ?? null,
  };
  if (level === 'quiet') return base;
  const normal = {
    ...base,
    body: event.body,
    tags: event.tags,
    correlationId: event.correlationId,
    replyTo: event.replyTo,
    sourceCount: event.sourceRefs.length,
  };
  if (level === 'normal') return normal;
  if (level === 'deep') return { ...normal, detail: event.detail, sourceRefs: event.sourceRefs };
  return event;
}

async function readWindow(filePath, { cursor, tail, scanBytes }) {
  let stat;
  try { stat = await fsp.stat(filePath); } catch (error) {
    if (error.code === 'ENOENT') return { buffer: Buffer.alloc(0), start: 0, end: 0 };
    throw error;
  }
  const end = stat.size;
  const requested = Number.isFinite(Number(cursor)) ? Math.max(0, Number(cursor)) : null;
  const start = requested == null
    ? (tail ? Math.max(0, end - scanBytes) : 0)
    : Math.min(requested, end);
  if (start === end) return { buffer: Buffer.alloc(0), start, end };
  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(end - start);
    await handle.read(buffer, 0, buffer.length, start);
    return { buffer, start, end };
  } finally {
    await handle.close();
  }
}

export async function readPartyLine({
  filePath = DEFAULT_PARTY_LINE_PATH,
  cursor,
  limit = 100,
  detail = 'normal',
  tail = cursor == null,
  scanBytes = DEFAULT_SCAN_BYTES,
  filters = {},
} = {}) {
  const cappedLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const window = await readWindow(filePath, { cursor, tail, scanBytes });
  let text = window.buffer.toString('utf8');
  if (window.start > 0 && cursor == null) {
    const firstBreak = text.indexOf('\n');
    text = firstBreak >= 0 ? text.slice(firstBreak + 1) : '';
  }
  const parsed = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (validatePartyLineEvent(event).ok && matchesFilters(event, filters)) parsed.push(event);
    } catch {
      // A crash-truncated final line is ignored; the append-only file remains readable.
    }
  }
  const selected = tail ? parsed.slice(-cappedLimit) : parsed.slice(0, cappedLimit);
  return {
    schema: 'orange.party-line.page.v1',
    events: selected.map((event) => projectPartyLineEvent(event, detail)),
    cursor: window.end,
    hasMore: !tail && parsed.length > cappedLimit,
    detail: PARTY_LINE_DETAIL_LEVELS.includes(detail) ? detail : 'normal',
    diskPath: filePath,
    chain: Object.values(filters).some(Boolean)
      ? { ok: null, checked: 0, errors: [], reason: 'filtered projection; verify the unfiltered ledger' }
      : verifyPartyLineChain(selected),
  };
}

export function verifyPartyLineChain(events = []) {
  const errors = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const computed = hashEvent({ ...event, entryHash: null });
    if (computed !== event.entryHash) errors.push({ id: event.id, code: 'entry_hash_mismatch' });
    if (index > 0) {
      const previous = events[index - 1];
      if (event.seq !== previous.seq + 1) errors.push({ id: event.id, code: 'sequence_gap' });
      if (event.prevHash !== previous.entryHash) errors.push({ id: event.id, code: 'previous_hash_mismatch' });
    }
  }
  return { ok: errors.length === 0, checked: events.length, errors };
}

const termsFor = (query) => [...new Set(
  (cleanText(query, 8_000).toLowerCase().match(/[a-z0-9][a-z0-9._-]{2,}/g) || [])
    .map((term) => term.replace(/[._-]+$/g, ''))
    .filter((term) => term.length >= 3),
)];

export async function hydratePartyLine({
  query,
  projectId,
  limit = 8,
  filePath = DEFAULT_PARTY_LINE_PATH,
} = {}) {
  const normalizeEcho = (value) => cleanText(value, 8_000).toLowerCase().replace(/[.!?]+$/g, '').trim();
  const normalizedQuery = normalizeEcho(query);
  const terms = termsFor(query);
  const page = await readPartyLine({ filePath, limit: 500, detail: 'wire', tail: true });
  const now = Date.now();
  const scored = page.events.map((event) => {
    const haystack = JSON.stringify([
      event.projectId,
      event.topic,
      event.actor,
      event.eventType,
      event.summary,
      event.body,
      event.tags,
      event.wave3Kernel,
    ]).toLowerCase();
    const lexical = terms.reduce((score, term) => {
      if (!haystack.includes(term)) return score;
      const identifier = term.length >= 16 || /\d.*[-_]|[-_].*\d/.test(term);
      // Exact receipt/order/proof ids must outrank a pile of generic chat
      // words. Otherwise prior questions about "the proof" bury the record
      // that actually owns the requested id.
      return score + (identifier ? 20 : 1);
    }, 0);
    const ageHours = Math.max(0, (now - Date.parse(event.createdAt)) / 3_600_000);
    const recency = 1 / (1 + ageHours / 24);
    const project = !projectId || event.projectId === projectId ? 1 : 0;
    const blocker = event.eventType === 'blocker' ? 0.6 : 0;
    const operational = ['order', 'report', 'decision', 'tool', 'receipt', 'status', 'blocker', 'repair'].includes(event.eventType) ? 1.5 : 0;
    const sourced = Array.isArray(event.sourceRefs) && event.sourceRefs.length ? 1.5 : 0;
    const messagePenalty = event.eventType === 'message' ? -1 : 0;
    const modelMessagePenalty = event.eventType === 'message' && event.actor?.kind === 'model' ? -1 : 0;
    const eventText = normalizeEcho(event.body || event.summary);
    const echoPenalty = normalizedQuery && eventText === normalizedQuery ? -100 : 0;
    return {
      event,
      score: lexical * 2 + recency + project + event.importance + blocker
        + operational + sourced + messagePenalty + modelMessagePenalty + echoPenalty,
    };
  });
  scored.sort((a, b) => b.score - a.score || b.event.createdAt.localeCompare(a.event.createdAt));
  const selected = scored
    .filter((item) => terms.length === 0 || item.score > 1.5)
    .slice(0, Math.max(1, Math.min(20, Number(limit) || 8)))
    .map(({ event, score }) => ({ ...projectPartyLineEvent(event, 'deep'), relevance: Number(score.toFixed(3)) }));
  const context = selected.length
    ? [
        'ORANGE PARTY LINE CONTEXT (source-addressed disk records; usable for continuity and explanation; mutation claims still require linked proof):',
        ...selected.map((event) => {
          const authority = event.eventType === 'message' ? 'conversation-unverified' : 'operational-record';
          const refs = event.sourceRefs?.length ? ` refs=${event.sourceRefs.map((ref) => ref.uri).join(',')}` : '';
          return `[party:${event.id}] authority=${authority} at=${event.createdAt} actor=${event.actor.displayName} type=${event.eventType} :: ${cleanText(event.summary, 240)}${refs}`;
        }),
      ].join('\n')
    : '';
  return {
    schema: 'orange.party-line.hydration.v1',
    query: cleanText(query, 8_000),
    selected,
    context,
    cursor: page.cursor,
  };
}

export function completionText(completion) {
  const content = completion?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part?.text || '').join('\n');
  return '';
}

export function partyLineFileExists(filePath = DEFAULT_PARTY_LINE_PATH) {
  return fs.existsSync(filePath);
}
