const MAX_ITEMS = 2;
const MAX_CHARS = 96;

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'current', 'currently',
  'do', 'does', 'for', 'from', 'how', 'i', 'in', 'is', 'it', 'latest', 'me',
  'of', 'on', 'or', 'our', 'please', 'tell', 'that', 'the', 'this', 'to',
  'what', 'which', 'who', 'why', 'with', 'you', 'your',
]);

function words(value) {
  return [...new Set(String(value || '').toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) || [])]
    .filter((word) => !STOP_WORDS.has(word));
}

function cleanExcerpt(value) {
  return String(value || '')
    .replace(/^\s*(?:[-*#>|]+|\d+[.)])\s*/, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sourceLabel(sourceId) {
  const parts = String(sourceId || 'source').replaceAll('\\', '/').split('/');
  return parts.at(-1) || 'source';
}

function relevantScore(queryWords, value) {
  if (!queryWords.length) return 0;
  const candidateWords = words(value);
  const overlap = queryWords.filter((word) => candidateWords.some((candidate) => (
    candidate === word
    || (Math.min(candidate.length, word.length) >= 4 && (candidate.startsWith(word) || word.startsWith(candidate)))
  ))).length;
  const ratio = overlap / queryWords.length;
  const enough = overlap >= Math.min(2, queryWords.length);
  return enough ? (overlap * 10) + ratio : 0;
}

function boundedCitation(excerpt, label, hash) {
  const source = `src=${sourceLabel(label)}@${String(hash || '').slice(0, 12)}`;
  const room = MAX_CHARS - source.length - 3;
  if (room < 8) return null;
  let text = cleanExcerpt(excerpt);
  if (text.length > room) {
    text = text.slice(0, room + 1).replace(/\s+\S*$/, '').trim();
  }
  return text ? `${text} | ${source}` : null;
}

function projectCandidates(userText, projectSources = [], projectSelected = []) {
  const queryWords = words(userText);
  const byId = new Map(projectSources.map((source) => [String(source.id), source]));
  const candidates = [];
  for (const [selectedIndex, selected] of projectSelected.entries()) {
    const source = byId.get(String(selected?.source_id));
    if (!source || typeof source.content !== 'string') continue;
    const chunk = source.content.slice(Number(selected.start) || 0, Number(selected.end) || source.content.length);
    for (const rawLine of chunk.split(/\r?\n/)) {
      const excerpt = cleanExcerpt(rawLine);
      if (excerpt.length < 4) continue;
      const score = relevantScore(queryWords, excerpt);
      if (!score) continue;
      const item = boundedCitation(excerpt, selected.source_id, selected.source_sha256);
      if (!item) continue;
      candidates.push({
        item,
        score: score + Math.max(0, 3 - selectedIndex),
        sourceKind: 'project',
        sourceId: selected.source_id,
        pointer: selected.pointer || source.pointer || null,
        sourceSha256: selected.source_sha256 || null,
        chunkSha256: selected.chunk_sha256 || null,
      });
    }
  }
  return candidates;
}

function memoryCandidates(userText, memoryMessages = []) {
  const queryWords = words(userText);
  const candidates = [];
  for (const message of memoryMessages) {
    const content = String(message?.content || '');
    if (!content.includes('AIR:MEMORY.v1') || /status=unavailable|memory plane unreachable/i.test(content)) continue;
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^(.*?)\s+\|\s+src=([^|\s]+)\s*$/);
      if (!match || /^(?:unknown|none|error)$/i.test(match[2])) continue;
      const excerpt = cleanExcerpt(match[1]);
      const score = relevantScore(queryWords, excerpt);
      if (!score) continue;
      const item = boundedCitation(excerpt, 'AE-Memory', match[2]);
      if (!item) continue;
      candidates.push({
        item,
        score,
        sourceKind: 'memory',
        sourceId: 'AE-Memory',
        pointer: `ae-memory:${match[2]}`,
        sourceSha256: /^[a-f0-9]{64}$/i.test(match[2]) ? match[2] : null,
        chunkSha256: null,
      });
    }
  }
  return candidates;
}

export function compileGovernedChatEvidence({
  userText = '',
  projectSources = [],
  projectSelected = [],
  memoryMessages = [],
} = {}) {
  const ranked = [
    ...projectCandidates(userText, projectSources, projectSelected),
    ...memoryCandidates(userText, memoryMessages),
  ].sort((a, b) => b.score - a.score || a.item.localeCompare(b.item));

  const citations = [];
  const seen = new Set();
  const seenKinds = new Set();
  for (const candidate of ranked) {
    const key = candidate.item.toLowerCase();
    if (seen.has(key) || seenKinds.has(candidate.sourceKind)) continue;
    citations.push(candidate);
    seen.add(key);
    seenKinds.add(candidate.sourceKind);
    if (citations.length === MAX_ITEMS) break;
  }
  return {
    schema: 'orange.governed-chat-evidence.v1',
    items: citations.map((citation) => citation.item),
    citations: citations.map(({ score: _score, ...citation }) => citation),
  };
}

export const __governedChatEvidenceInternals = Object.freeze({
  words,
  cleanExcerpt,
  relevantScore,
  boundedCitation,
});
