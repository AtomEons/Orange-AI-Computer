import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const RESEARCH_CORPUS_SCHEMA = 'orange.research-corpus.v1';
export const PROMOTION_QUEUE_SCHEMA = 'orange.research-promotion-queue.v1';

const DEFAULT_ROOT = path.resolve(import.meta.dir, '..');
const DEFAULT_SOURCE_ROOTS = Object.freeze([
  '00-CHARTER',
  '01-DOCTRINE',
  '04-CONTROL-PLANE/workflows',
  '13-TOOLMESH',
  '16-TRAINING',
]);

const RESEARCH_NAME = /research|alpha|innovation|candidate|radar|theory|design|future|experiment|grounding|adoption|idea|plan|paper|lab/i;
const RESEARCH_BODY = /\b(?:research|candidate|hypothesis|falsif|adopt|promot|experiment|paper|arxiv|novel|mechanism|benchmark|shadow[- ]only)\b/i;
const REJECT_BODY = /\b(?:rejected|superseded|retired|do not adopt|archive only|historical only)\b/i;
const ACTIVE_BODY = /\b(?:active|production|implemented|runtime[- ]enforced|adopted)\b/i;
const SHADOW_BODY = /\b(?:shadow|candidate|research[- ]only|quarantine|proposed|pending)\b/i;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const clean = (value, max = 4_000) => String(value ?? '').replace(/\u0000/g, '').replace(/\r\n/g, '\n').trim().slice(0, max);

function walk(root, output = []) {
  if (!fs.existsSync(root)) return output;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'target', 'artifacts'].includes(entry.name)) continue;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) walk(absolute, output);
    else if (/\.(?:md|mdx|txt|json|mjs|js|ts)$/i.test(entry.name)) output.push(absolute);
  }
  return output;
}

function titleOf(text, filePath) {
  const heading = text.match(/^#\s+(.+)$/m)?.[1];
  return clean(heading || path.basename(filePath, path.extname(filePath)), 512);
}

function statusOf(text) {
  if (REJECT_BODY.test(text)) return 'rejected_or_superseded';
  if (SHADOW_BODY.test(text)) return 'research_or_shadow';
  if (ACTIVE_BODY.test(text)) return 'claims_active_unverified';
  return 'unclassified';
}

function candidateLines(text) {
  const lines = text.split('\n');
  const candidates = [];
  let heading = null;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const headingMatch = raw.match(/^#{2,5}\s+(.+)/);
    if (headingMatch) {
      heading = clean(headingMatch[1], 512);
      if (RESEARCH_BODY.test(heading)) candidates.push({ line: index + 1, text: heading, kind: 'heading' });
      continue;
    }
    const table = raw.match(/^\s*\|\s*(?:[A-Z]{2,8}-?\d{1,4}|\d{1,3})\s*\|\s*([^|]{4,240})\|/);
    const bullet = raw.match(/^\s*[-*]\s+(?:\*\*)?([^*\n]{8,300})/);
    const numbered = raw.match(/^\s*\d+[.)]\s+(.{8,300})/);
    const item = table?.[1] || bullet?.[1] || numbered?.[1];
    if (item && (RESEARCH_BODY.test(item) || RESEARCH_BODY.test(heading || ''))) {
      candidates.push({ line: index + 1, text: clean(item.replace(/\*\*/g, ''), 512), kind: table ? 'table' : 'list', section: heading });
    }
  }
  return candidates.slice(0, 1_000);
}

function normalizedMechanism(value) {
  return clean(value, 512)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[`*_#:[\](){},.;]/g, ' ')
    .replace(/\b(?:the|a|an|and|or|for|with|from|into|of|to|in|on|v\d+)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sourceRecord(absolute, projectRoot) {
  const body = fs.readFileSync(absolute, 'utf8');
  if (!RESEARCH_NAME.test(path.basename(absolute)) && !RESEARCH_BODY.test(body.slice(0, 24_000))) return null;
  const relativePath = path.relative(projectRoot, absolute).replace(/\\/g, '/');
  const candidates = candidateLines(body);
  return {
    sourceId: `source-${sha256(relativePath).slice(0, 20)}`,
    path: relativePath,
    title: titleOf(body, absolute),
    sha256: sha256(body),
    bytes: Buffer.byteLength(body, 'utf8'),
    statusSignal: statusOf(body.slice(0, 40_000)),
    candidateCount: candidates.length,
    candidates,
  };
}

export function compileResearchCorpus({ projectRoot = DEFAULT_ROOT, sourceRoots = DEFAULT_SOURCE_ROOTS } = {}) {
  const files = sourceRoots.flatMap((relative) => walk(path.resolve(projectRoot, relative)));
  const sources = files.map((file) => sourceRecord(file, projectRoot)).filter(Boolean);
  const mechanismMap = new Map();
  for (const source of sources) {
    for (const candidate of source.candidates) {
      const key = normalizedMechanism(candidate.text);
      if (key.length < 6) continue;
      const existing = mechanismMap.get(key) || {
        mechanismId: `mechanism-${sha256(key).slice(0, 20)}`,
        canonicalText: candidate.text,
        normalized: key,
        sourceRefs: [],
        statusSignals: [],
      };
      existing.sourceRefs.push({ sourceId: source.sourceId, path: source.path, line: candidate.line, section: candidate.section || null, sha256: source.sha256 });
      existing.statusSignals.push(source.statusSignal);
      mechanismMap.set(key, existing);
    }
  }
  const mechanisms = [...mechanismMap.values()]
    .map((item) => ({ ...item, sourceRefs: item.sourceRefs.slice(0, 32), statusSignals: [...new Set(item.statusSignals)] }))
    .sort((a, b) => b.sourceRefs.length - a.sourceRefs.length || a.canonicalText.localeCompare(b.canonicalText));
  const corpus = {
    schema: RESEARCH_CORPUS_SCHEMA,
    generatedAt: new Date().toISOString(),
    projectRoot,
    sourceRoots,
    sourceCount: sources.length,
    mechanismCount: mechanisms.length,
    sources,
    mechanisms,
  };
  corpus.corpusHash = sha256(JSON.stringify({ sources: sources.map(({ path: p, sha256: hash }) => [p, hash]), mechanisms: mechanisms.map((item) => item.mechanismId) }));
  return corpus;
}

export function compilePromotionQueue(corpus, { activeLaws = [], activeCapabilities = [] } = {}) {
  const lawText = activeLaws.map((item) => normalizedMechanism(`${item.id || ''} ${item.name || ''} ${item.invariant || ''}`));
  const capabilityText = activeCapabilities.map((item) => normalizedMechanism(typeof item === 'string' ? item : `${item.id || ''} ${item.name || ''}`));
  const items = corpus.mechanisms.map((mechanism) => {
    const tokens = new Set(mechanism.normalized.split(' ').filter((token) => token.length > 3));
    const overlap = (candidate) => {
      const other = new Set(candidate.split(' ').filter((token) => token.length > 3));
      if (!tokens.size || !other.size) return 0;
      let matches = 0;
      for (const token of tokens) if (other.has(token)) matches += 1;
      return matches / Math.max(tokens.size, other.size);
    };
    const lawScore = Math.max(0, ...lawText.map(overlap));
    const capabilityScore = Math.max(0, ...capabilityText.map(overlap));
    const status = lawScore >= 0.6 || capabilityScore >= 0.6 ? 'mapped' : 'unmapped';
    return {
      mechanismId: mechanism.mechanismId,
      mechanism: mechanism.canonicalText,
      status,
      reuseEvidence: mechanism.sourceRefs.length,
      lawSimilarity: Number(lawScore.toFixed(4)),
      capabilitySimilarity: Number(capabilityScore.toFixed(4)),
      ownerRequired: status === 'unmapped',
      enforcementRequired: status === 'unmapped',
      falsifierRequired: true,
      sourceRefs: mechanism.sourceRefs,
    };
  });
  return {
    schema: PROMOTION_QUEUE_SCHEMA,
    generatedAt: new Date().toISOString(),
    corpusHash: corpus.corpusHash,
    total: items.length,
    mapped: items.filter((item) => item.status === 'mapped').length,
    unmapped: items.filter((item) => item.status === 'unmapped').length,
    items,
  };
}

export function writeResearchArtifacts({ corpus, queue, outputRoot }) {
  if (!corpus || !queue) throw new Error('corpus and queue are required');
  const root = path.resolve(outputRoot);
  fs.mkdirSync(root, { recursive: true });
  const corpusPath = path.join(root, 'research-corpus.json');
  const queuePath = path.join(root, 'promotion-queue.json');
  fs.writeFileSync(corpusPath, `${JSON.stringify(corpus, null, 2)}\n`, 'utf8');
  fs.writeFileSync(queuePath, `${JSON.stringify(queue, null, 2)}\n`, 'utf8');
  return { corpusPath, queuePath, corpusHash: corpus.corpusHash };
}

if (import.meta.main) {
  const outputIndex = process.argv.indexOf('--out');
  const outputRoot = outputIndex >= 0 ? process.argv[outputIndex + 1] : path.join(process.env.ORANGE5_DATA_ROOT || path.join(process.env.USERPROFILE || '.', 'OrangeBox-Data', 'orange5'), 'research');
  const corpus = compileResearchCorpus();
  const queue = compilePromotionQueue(corpus);
  const written = writeResearchArtifacts({ corpus, queue, outputRoot });
  console.log(JSON.stringify({ schema: PROMOTION_QUEUE_SCHEMA, sourceCount: corpus.sourceCount, mechanismCount: corpus.mechanismCount, ...written }, null, 2));
}
