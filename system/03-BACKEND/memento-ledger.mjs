import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MEMENTO_SCHEMA = 'orange.memento.v1';

const DATA_ROOT = process.env.ORANGE5_DATA_ROOT || path.join(os.homedir(), 'OrangeBox-Data', 'orange5');
export const DEFAULT_MEMENTO_LEDGER = process.env.ORANGE5_MEMENTO_LEDGER
  || path.join(DATA_ROOT, 'memory', 'memento', 'mementos.jsonl');
export const DEFAULT_MEMENTO_MIRROR = process.env.ORANGE5_MEMENTO_MIRROR
  || path.join(os.homedir(), 'Desktop', 'ORANGE_AI_COMPUTER_MEMENTO_LEDGER.md');

const sha256 = (value) => createHash('sha256').update(String(value ?? '')).digest('hex');

function readLines(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function normalizedList(value) {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).filter(Boolean).map(String);
}

function normalizedSource(value) {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).filter(Boolean).map((item) => {
    if (typeof item === 'string') return { pointer: item, hash: sha256(item) };
    const pointer = item.pointer || item.path || item.uri || item.id || 'inline';
    return { pointer, hash: item.hash || item.sha256 || sha256(JSON.stringify(item)), note: item.note || null };
  });
}

function renderSection(title, values) {
  if (!values.length) return '';
  return `\n**${title}**\n${values.map((value) => `- ${value}`).join('\n')}\n`;
}

export function renderMementos(entries) {
  const body = entries.map((entry) => [
    `## ${entry.recordedAt} - ${entry.title}`,
    '',
    `- Type: \`${entry.type}\``,
    `- Status: \`${entry.status}\``,
    `- ID: \`${entry.id}\``,
    `- Hash: \`${entry.hash}\``,
    `- Previous: \`${entry.previousHash || 'GENESIS'}\``,
    '',
    entry.summary,
    renderSection('Why it matters', entry.why),
    renderSection('Implementation', entry.implementation),
    renderSection('Evidence', entry.evidence),
    renderSection('Limits', entry.limits),
    renderSection('Next entry point', entry.next),
  ].join('\n')).join('\n---\n\n');

  return `# AE Orange AI Computer - Memento Ledger\n\n`
    + `This is the durable, disk-backed continuation record for major Orange upgrades. `
    + `It is generated from the append-only JSONL ledger and must not be used as proof by itself.\n\n`
    + `Entries: **${entries.length}**\n\n${body}\n`;
}

export function rebuildMementoMirror({ ledgerPath = DEFAULT_MEMENTO_LEDGER, mirrorPath = DEFAULT_MEMENTO_MIRROR } = {}) {
  const entries = readLines(ledgerPath);
  const mirrorDirectory = path.dirname(mirrorPath);
  if (!fs.existsSync(mirrorDirectory)) fs.mkdirSync(mirrorDirectory, { recursive: true });
  const temporary = `${mirrorPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, renderMementos(entries), 'utf8');
  fs.renameSync(temporary, mirrorPath);
  return { ok: true, entries: entries.length, ledgerPath, mirrorPath };
}

export function recordMemento(input, { ledgerPath = DEFAULT_MEMENTO_LEDGER, mirrorPath = DEFAULT_MEMENTO_MIRROR } = {}) {
  if (!input?.title || !input?.summary) throw new Error('memento title and summary are required');
  const existing = readLines(ledgerPath);
  const duplicate = input.id ? existing.find((entry) => entry.id === input.id) : null;
  if (duplicate) {
    const mirror = rebuildMementoMirror({ ledgerPath, mirrorPath });
    return { ok: true, duplicate: true, entry: duplicate, ...mirror };
  }
  const previousHash = existing.at(-1)?.hash || null;
  const entry = {
    schema: MEMENTO_SCHEMA,
    id: input.id || `memento-${randomUUID()}`,
    recordedAt: input.recordedAt || new Date().toISOString(),
    type: input.type || 'upgrade',
    status: input.status || 'implemented_unverified',
    title: String(input.title),
    summary: String(input.summary),
    originalIdea: input.originalIdea ? String(input.originalIdea) : String(input.summary),
    fidelity: input.fidelity || 'FULL_STRENGTH_PRESERVED',
    sourceRefs: normalizedSource(input.sourceRefs),
    why: normalizedList(input.why),
    implementation: normalizedList(input.implementation),
    evidence: normalizedList(input.evidence),
    limits: normalizedList(input.limits),
    next: normalizedList(input.next),
    previousHash,
  };
  entry.hash = sha256(JSON.stringify(entry));
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`, 'utf8');
  const mirror = rebuildMementoMirror({ ledgerPath, mirrorPath });
  return { ok: true, entry, ...mirror };
}

export function verifyMementoLedger(filePath = DEFAULT_MEMENTO_LEDGER) {
  const entries = readLines(filePath);
  const errors = [];
  let previousHash = null;
  for (const [index, entry] of entries.entries()) {
    if (entry.previousHash !== previousHash) errors.push({ index, code: 'CHAIN_LINK_MISMATCH' });
    const { hash, ...body } = entry;
    if (sha256(JSON.stringify(body)) !== hash) errors.push({ index, code: 'HASH_MISMATCH' });
    previousHash = hash;
  }
  return { ok: errors.length === 0, entries: entries.length, errors, head: previousHash };
}

if (import.meta.main) {
  const fileIndex = process.argv.indexOf('--record-file');
  if (fileIndex >= 0) {
    const input = JSON.parse(fs.readFileSync(path.resolve(process.argv[fileIndex + 1]), 'utf8'));
    console.log(JSON.stringify(recordMemento(input), null, 2));
  } else {
    console.log(JSON.stringify({ ...verifyMementoLedger(), ...rebuildMementoMirror() }, null, 2));
  }
}
