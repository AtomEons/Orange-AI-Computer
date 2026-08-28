import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deleteSemanticSource,
  upsertSemanticRecords,
} from '../06-ORANGELLM/memory/ae-cobra/semantic-index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const RECEIPT_ROOT = path.join(ROOT, '10-RECEIPTS', 'orange5-build');
const DATA_ROOT = process.env.ORANGE5_DATA_ROOT
  || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'OrangeBox-Data', 'orange5');

const SOURCE_MANIFEST = Object.freeze([
  { path: '00-CHARTER/ORANGE5_OPERATIONAL_LAW.md', authority: 1.0 },
  { path: '00-CHARTER/ORANGE5_RUNTIME_AUTHORITY.md', authority: 1.0 },
  { path: '00-CHARTER/ORANGE5_NOT_GREEN_LEDGER.md', authority: 1.0 },
  { path: '00-CHARTER/ORANGEFIVE_HOW_TO_USE.md', authority: 0.98 },
  { path: 'ORANGEFIVE_CURRENT_OPERATIONAL_TRUTH.md', authority: 0.95 },
  { latest: '10-RECEIPTS/orange5-build/orange5-operational-audit-*.json', authority: 1.0 },
  { latest: '10-RECEIPTS/orange5-build/*hot-navigator-live-proof.json', authority: 1.0 },
  { latest: '10-RECEIPTS/orange5-build/*system-performance-benchmark.json', authority: 1.0 },
  { latest: '10-RECEIPTS/orange5-build/*learning-behavior-proof.json', authority: 1.0 },
  { latest: '10-RECEIPTS/orange5-build/orange5-mission-*.json', authority: 1.0 },
  { latest: '10-RECEIPTS/orange5-build/*durable-cross-organ-proof.json', authority: 1.0 },
  { latest: '10-RECEIPTS/orange5-build/*aeyes-human-grade-live-proof.json', authority: 1.0 },
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function wildcardRegex(pattern) {
  return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
}

function resolveLatest(pattern) {
  const normalized = pattern.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  const dir = path.join(ROOT, normalized.slice(0, slash));
  const namePattern = normalized.slice(slash + 1);
  if (!fs.existsSync(dir)) return null;
  const matcher = wildcardRegex(namePattern);
  const matches = fs.readdirSync(dir)
    .filter((name) => matcher.test(name))
    .map((name) => ({ name, full: path.join(dir, name), stat: fs.statSync(path.join(dir, name)) }))
    .filter((item) => item.stat.isFile())
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || b.name.localeCompare(a.name));
  return matches[0]?.full || null;
}

function compactText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitOversize(value, maxChars) {
  const text = compactText(value);
  if (text.length <= maxChars) return [text];
  const pieces = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    let cut = remaining.lastIndexOf('\n', maxChars);
    if (cut < Math.floor(maxChars * 0.55)) cut = remaining.lastIndexOf(' ', maxChars);
    if (cut < Math.floor(maxChars * 0.55)) cut = maxChars;
    pieces.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) pieces.push(remaining);
  return pieces.filter(Boolean);
}

function packChunks(items, maxChars = 1_400) {
  const chunks = [];
  let current = '';
  const boundedItems = items.map(compactText).filter(Boolean).flatMap((item) => splitOversize(item, maxChars));
  for (const item of boundedItems) {
    if (!current) {
      current = item;
      continue;
    }
    if (current.length + item.length + 2 <= maxChars) {
      current += `\n\n${item}`;
    } else {
      chunks.push(current);
      current = item;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function markdownSections(text, maxChars = 1_400) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const sections = [];
  const headingStack = [];
  let body = [];

  function flush() {
    const content = compactText(body.join('\n'));
    if (!content) return;
    const section = headingStack.filter(Boolean).join(' > ') || 'Document';
    const chunks = packChunks(content.split(/\n\n+/), maxChars);
    for (const chunk of chunks) sections.push({ section, text: `${section}\n${chunk}` });
    body = [];
  }

  for (const line of lines) {
    const match = /^(#{1,6})\s+(.+)$/.exec(line.trim());
    if (!match) {
      body.push(line);
      continue;
    }
    flush();
    const level = match[1].length;
    headingStack.length = level - 1;
    headingStack[level - 1] = compactText(match[2]);
  }
  flush();
  return sections;
}

function flattenJson(value, prefix = '$', lines = [], depth = 0, maxLines = 600) {
  if (depth > 9 || lines.length >= maxLines) return lines;
  if (value === null || typeof value !== 'object') {
    const rendered = typeof value === 'string' ? value : JSON.stringify(value);
    if (rendered !== undefined && String(rendered).length <= 2_000) lines.push(`${prefix}: ${rendered}`);
    return lines;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => flattenJson(item, `${prefix}[${index}]`, lines, depth + 1, maxLines));
    return lines;
  }
  const priority = /status|summary|result|model|route|health|metric|evidence|receipt|blocker|next/i;
  const entries = Object.entries(value).sort(([a], [b]) => Number(priority.test(b)) - Number(priority.test(a)));
  for (const [key, item] of entries) {
    flattenJson(item, `${prefix}.${key}`, lines, depth + 1, maxLines);
    if (lines.length >= maxLines) break;
  }
  return lines;
}

export function jsonSections(text, maxChars = 2_200) {
  const value = JSON.parse(String(text || '').replace(/^\uFEFF/, ''));
  return packChunks(flattenJson(value), maxChars).slice(0, 48).map((chunk, index) => ({
    section: `JSON evidence ${index + 1}`,
    text: chunk,
  }));
}

function resolveManifest() {
  const found = [];
  const missing = [];
  for (const item of SOURCE_MANIFEST) {
    const full = item.path ? path.join(ROOT, item.path) : resolveLatest(item.latest);
    if (!full || !fs.existsSync(full)) {
      missing.push(item.path || item.latest);
      continue;
    }
    found.push({ full, relative: path.relative(ROOT, full).replace(/\\/g, '/'), authority: item.authority });
  }
  return { found, missing };
}

function checkpointPathFor(relative) {
  return path.join(DATA_ROOT, 'knowledge', 'project-source-checkpoints', `${sha256(relative).slice(0, 24)}.json`);
}

function checkpointState(checkpointPath) {
  if (!fs.existsSync(checkpointPath)) return null;
  try { return JSON.parse(fs.readFileSync(checkpointPath, 'utf8')); }
  catch { return null; }
}

export function recordsForSource({ full, relative, authority }) {
  const raw = fs.readFileSync(full, 'utf8');
  const sourceHash = sha256(raw);
  const stat = fs.statSync(full);
  const ext = path.extname(full).toLowerCase();
  const sections = ext === '.json' ? jsonSections(raw) : markdownSections(raw, 1_200);
  return sections.map((chunk, index) => ({
    hash: sha256(`${relative}\n${sourceHash}\n${index}\n${chunk.section}\n${chunk.text}`),
    ts: Math.floor(stat.mtimeMs),
    lane: 'reality',
    origin: 'doctrine.project-source',
    kind: 'source',
    body: {
      summary: chunk.text,
      entities: ['OrangeFive', chunk.section],
      files: [relative],
      commands: [],
      confidence: authority,
      authority,
      source_file: relative,
      source_hash: sourceHash,
      section: chunk.section,
      chunk_index: index,
    },
  }));
}

export async function ingestProjectKnowledge() {
  const started = Date.now();
  const { found, missing } = resolveManifest();
  const sources = [];
  let indexed = 0;
  let embeddingRequests = 0;
  let adaptiveRetries = 0;
  for (const source of found) {
    const records = recordsForSource(source);
    const sourceHash = records[0]?.body?.source_hash || null;
    const indexedSourceHash = sha256(`${sourceHash}\norange5-project-source-codec-v3-1200`);
    const checkpointPath = checkpointPathFor(source.relative);
    const priorState = checkpointState(checkpointPath);
    const changed = priorState?.source_hash !== indexedSourceHash || priorState?.complete !== true;
    let sourceResult = { indexed: 0, embedding_requests: 0, adaptive_retries: 0, complete: true };
    if (changed) {
      if (priorState?.source_hash !== indexedSourceHash) await deleteSemanticSource(source.relative);
      sourceResult = await upsertSemanticRecords(records, {
        batchSize: 16,
        checkpointPath,
        sourceHash: indexedSourceHash,
      });
      indexed += sourceResult.indexed || 0;
      embeddingRequests += sourceResult.embedding_requests || 0;
      adaptiveRetries += sourceResult.adaptive_retries || 0;
      if (sourceResult.complete) {
        fs.writeFileSync(checkpointPath, `${JSON.stringify({
          schema: 'orange5.project-source-state.v2',
          source_file: source.relative,
          source_hash: indexedSourceHash,
          raw_source_hash: sourceHash,
          completed_hashes: records.map((record) => record.hash),
          complete: true,
          updated_at: new Date().toISOString(),
        }, null, 2)}\n`, 'utf8');
      }
    }
    sources.push({
      file: source.relative,
      authority: source.authority,
      chunks: records.length,
      indexed: sourceResult.indexed || 0,
      changed,
      source_hash: sourceHash,
    });
  }

  const receipt = {
    schema: 'orange5.project-knowledge-index.receipt.v1',
    status: missing.length ? 'INDEXED_WITH_MISSING_SOURCES' : 'INDEXED',
    sources: sources.length,
    chunks: sources.reduce((sum, item) => sum + item.chunks, 0),
    indexed,
    unchanged_sources: sources.filter((item) => !item.changed).length,
    embedding_requests: embeddingRequests,
    adaptive_retries: adaptiveRetries,
    missing,
    source_details: sources,
    elapsed_ms: Date.now() - started,
    generated_at: new Date().toISOString(),
  };
  receipt.receipt_sha256 = sha256(JSON.stringify(receipt));
  fs.mkdirSync(RECEIPT_ROOT, { recursive: true });
  const stamp = receipt.generated_at.replace(/[:.]/g, '-');
  const receiptPath = path.join(RECEIPT_ROOT, `${stamp}-project-knowledge-index.json`);
  const latestPath = path.join(DATA_ROOT, 'receipts', 'project-knowledge-index-latest.json');
  fs.mkdirSync(path.dirname(latestPath), { recursive: true });
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  fs.writeFileSync(latestPath, `${JSON.stringify({ ...receipt, receipt_path: receiptPath }, null, 2)}\n`, 'utf8');
  return { ...receipt, receipt_path: receiptPath, latest_path: latestPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await ingestProjectKnowledge(), null, 2));
}

export const __projectKnowledgeInternals = Object.freeze({
  wildcardRegex,
  compactText,
  packChunks,
  splitOversize,
  flattenJson,
  resolveManifest,
});
