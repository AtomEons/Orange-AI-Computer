import { createHash } from 'node:crypto';
import { compressWorkset, validateWorkset } from '../12-ATOMSMASHER/sparse-worksets/compressor.mjs';
import { fitEquationPacket, renderEquationPacketAir } from './numeric-equation-packet.mjs';

export const CONTEXT_CRYSTAL_SCHEMA = 'orange5.context-crystal.v1';

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function byteLength(value) {
  return Buffer.byteLength(String(value), 'utf8');
}

function estimateTokens(value) {
  return Math.ceil(byteLength(value) / 2.5);
}

const TASK_STOPWORDS = new Set(['about', 'after', 'also', 'and', 'answer', 'are', 'does', 'exactly', 'for', 'from', 'happens', 'how', 'into', 'is', 'its', 'mean', 'the', 'this', 'too', 'what', 'when', 'with']);

function stemToken(token) {
  if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith('ed')) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith('er')) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith('s')) return token.slice(0, -1);
  return token;
}

function orderedTokens(value) {
  return (String(value).toLowerCase().match(/[a-z0-9][a-z0-9_\-]*/g) || [])
    .map(stemToken)
    .filter((token) => token.length > 2 && !TASK_STOPWORDS.has(token));
}

function contentTokens(value) {
  return new Set(orderedTokens(value));
}

function lexicalScore(task, content) {
  const orderedTask = orderedTokens(task);
  const taskTokens = new Set(orderedTask);
  const contentSet = contentTokens(content);
  let hits = 0;
  for (const token of taskTokens) if (contentSet.has(token)) hits += 1;
  const normalizedContent = orderedTokens(content).join(' ');
  const phrases = [];
  for (let index = 0; index < orderedTask.length - 1; index += 1) phrases.push(`${orderedTask[index]} ${orderedTask[index + 1]}`);
  const phraseHits = phrases.filter((phrase) => normalizedContent.includes(phrase)).length;
  const headingContent = String(content).split(/\r?\n/)
    .filter((line) => /^#{1,6}\s+/.test(line.trim()))
    .map(orderedTokens)
    .map((tokens) => tokens.join(' '))
    .join(' | ');
  const headingHits = phrases.filter((phrase) => headingContent.includes(phrase)).length;
  return (hits / Math.max(1, taskTokens.size))
    + (phraseHits / Math.max(1, phrases.length)) * 0.75
    + (headingHits / Math.max(1, phrases.length)) * 1.5;
}

function normalizeSource(source, index) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new TypeError(`context source ${index} must be an object`);
  }
  const content = typeof source.content === 'string' ? source.content : '';
  if (!content) throw new TypeError(`context source ${index} has no content`);
  const id = String(source.id || `source_${index}`);
  return {
    id,
    content,
    pointer: String(source.pointer || `inline://${id}`),
    authority: Math.min(1, Math.max(0, Number(source.authority ?? 0))),
    pinned: source.pinned === true,
    source_sha256: sha256(content),
  };
}

function chunkSource(source, maxChunkChars = 900) {
  const chunks = [];
  let start = 0;
  while (start < source.content.length) {
    let end = Math.min(source.content.length, start + maxChunkChars);
    if (end < source.content.length) {
      const window = source.content.slice(start, end);
      const headingPattern = /(?:^|\n)(?=#{1,6}\s+)/g;
      let headingBoundary = -1;
      for (const match of window.matchAll(headingPattern)) {
        const candidate = match.index + (match[0] === '\n' ? 1 : 0);
        if (candidate > 0) headingBoundary = candidate;
      }
      if (headingBoundary > Math.floor(maxChunkChars * 0.5)) {
        // Keep a heading with the section it governs. Fixed windows that leave
        // a heading at the tail of one chunk damage retrieval for the body.
        end = start + headingBoundary;
      } else {
        const lineBreak = source.content.lastIndexOf('\n', end);
        if (lineBreak > start + Math.floor(maxChunkChars * 0.5)) end = lineBreak + 1;
      }
    }
    const content = source.content.slice(start, end).trim();
    if (content) {
      chunks.push({
        id: `${source.id}#${start}-${end}`,
        source_id: source.id,
        pointer: `${source.pointer}#chars=${start}-${end}`,
        source_sha256: source.source_sha256,
        chunk_sha256: sha256(content),
        content,
        start,
        end,
        pinned: source.pinned,
        size: byteLength(content),
        score_hint: source.authority,
      });
    }
    start = end;
  }
  return chunks;
}

function orderSelectedChunks(chunks) {
  return [...chunks].sort((a, b) =>
    Number(b?.pinned === true) - Number(a?.pinned === true)
    || Number(b?.task_score || 0) - Number(a?.task_score || 0)
    || Number(b?.score_hint || 0) - Number(a?.score_hint || 0)
    || String(a?.source_id || '').localeCompare(String(b?.source_id || ''))
    || Number(a?.start || 0) - Number(b?.start || 0));
}

function renderCrystal(task, workset, byId, sourceSetHash, equationPackets = []) {
  // Small local models tend to cite early source labels. Put task-relevant
  // required evidence first so that bias follows authority, not insertion order.
  const selected = orderSelectedChunks(workset.working_set.map((kept) => byId.get(kept.id)));
  const sourceIds = [...new Set(selected.map((chunk) => chunk.source_id))];
  const sourceIndex = new Map(sourceIds.map((id, index) => [id, index]));
  const lines = [
    'AIR:CC1',
    `P:${sha256(task).slice(0, 16)}:${sourceSetHash.slice(0, 16)}:${workset.workset_id.slice(0, 16)}`,
    ...sourceIds.map((id, index) => `S${index}:${id}`),
    ...equationPackets.map(renderEquationPacketAir),
  ];
  for (const chunk of selected) {
    lines.push(`@${sourceIndex.get(chunk.source_id)}:${chunk.start}-${chunk.end}`);
    lines.push(chunk.content);
  }
  return lines.join('\n');
}

export function compileContextCrystal({ task, sources, budgetBytes = 6_000, requiredSourceIds = [], numericSeries = [] } = {}) {
  if (typeof task !== 'string' || !task.trim()) throw new TypeError('context crystal requires a task');
  if (!Array.isArray(sources) || sources.length === 0) throw new TypeError('context crystal requires sources');
  const normalized = sources.map(normalizeSource);
  const equationPackets = numericSeries.slice(0, 3).map((series) => fitEquationPacket(series));
  const equationBytes = equationPackets.reduce((sum, packet) => sum + byteLength(renderEquationPacketAir(packet)) + 1, 0);
  const sourceBudget = Math.max(512, budgetBytes - Math.min(equationBytes, Math.floor(budgetBytes / 2)));
  const required = new Set(requiredSourceIds.map(String));
  const chunks = normalized.flatMap((source) => chunkSource(source));
  for (const chunk of chunks) chunk.task_score = lexicalScore(task, chunk.content);
  // A required large source contributes its best task-relevant window, not its
  // entire body. Pinning a whole manual would defeat sparse context by design.
  for (const requiredId of required) {
    const candidates = chunks.filter((chunk) => chunk.source_id === requiredId);
    candidates.sort((a, b) => b.task_score - a.task_score || a.start - b.start);
    if (candidates[0]) candidates[0].pinned = true;
  }
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const workset = compressWorkset({
    task,
    context: chunks.map((chunk) => ({
      id: chunk.id,
      content: chunk.content,
      tag: chunk.source_id,
      pinned: chunk.pinned,
      size: chunk.size,
      // Authority only breaks ties between task-relevant evidence. It must not
      // make an unrelated charter chunk outrank a relevant lower-authority
      // source. The stemmed task score also rescues morphology the generic
      // sparse-workset tokenizer deliberately does not guess about.
      score_hint: chunk.task_score > 0
        ? Math.min(0.25, chunk.task_score * 0.15) + Math.min(0.01, chunk.score_hint * 0.01)
        : 0,
    })),
  }, { keepThreshold: 0.01, budget: sourceBudget });
  const validation = validateWorkset(workset);
  if (!validation.valid) throw new Error(`invalid sparse workset: ${validation.errors.join('; ')}`);
  const selectedChunks = orderSelectedChunks(workset.working_set.map((item) => byId.get(item.id)));
  const selectedSourceIds = new Set(selectedChunks.map((chunk) => chunk.source_id));
  const missingRequired = [...required].filter((id) => !selectedSourceIds.has(id));
  const sourceSetHash = sha256(normalized.map((source) => `${source.id}:${source.source_sha256}`).sort().join('|'));
  const hot = renderCrystal(task, workset, byId, sourceSetHash, equationPackets);
  const rawBytes = normalized.reduce((sum, source) => sum + byteLength(source.content), 0);
  const hotBytes = byteLength(hot);
  const rawTokens = estimateTokens(normalized.map((source) => source.content).join('\n'));
  const hotTokens = estimateTokens(hot);
  const sourcePointersValid = selectedChunks.every((chunk) =>
    chunk && chunk.chunk_sha256 === sha256(chunk.content) && typeof chunk.pointer === 'string' && chunk.pointer.length > 0);
  const proof = {
    workset_valid: validation.valid,
    source_pointers_valid: sourcePointersValid,
    required_sources_retained: missingRequired.length === 0,
    missing_required_sources: missingRequired,
    no_hidden_cache: true,
  };
  const crystal = {
    schema: CONTEXT_CRYSTAL_SCHEMA,
    crystal_id: sha256(`${sha256(task)}:${sourceSetHash}:${workset.workset_id}:${sha256(hot)}`),
    task,
    source_set_sha256: sourceSetHash,
    workset_id: workset.workset_id,
    hot_context: hot,
    selected: selectedChunks.map((chunk) => ({
      source_id: chunk.source_id,
      pointer: chunk.pointer,
      source_sha256: chunk.source_sha256,
      chunk_sha256: chunk.chunk_sha256,
      start: chunk.start,
      end: chunk.end,
    })),
    equation_packets: equationPackets,
    dropped: workset.dropped,
    proof,
    metrics: {
      raw_bytes: rawBytes,
      hot_bytes: hotBytes,
      physical_context_ratio: Number((rawBytes / Math.max(1, hotBytes)).toFixed(3)),
      raw_tokens_estimated: rawTokens,
      hot_tokens_estimated: hotTokens,
      tokens_not_injected: Math.max(0, rawTokens - hotTokens),
      operational_context_ratio: Number((rawTokens / Math.max(1, hotTokens)).toFixed(3)),
      input_sources: normalized.length,
      input_chunks: chunks.length,
      selected_chunks: selectedChunks.length,
      equation_packets: equationPackets.length,
      target_200x_met: rawTokens / Math.max(1, hotTokens) >= 200,
      target_1000x_met: rawTokens / Math.max(1, hotTokens) >= 1_000,
    },
  };
  crystal.proof.complete = Object.entries(proof)
    .filter(([key]) => key !== 'missing_required_sources')
    .every(([, value]) => value === true);
  return crystal;
}

export function verifyContextCrystal(crystal, sourceResolver) {
  if (!crystal || crystal.schema !== CONTEXT_CRYSTAL_SCHEMA) return { ok: false, errors: ['schema mismatch'] };
  if (typeof sourceResolver !== 'function') return { ok: false, errors: ['sourceResolver required'] };
  const errors = [];
  for (const selected of crystal.selected || []) {
    const source = sourceResolver(selected.source_id, selected.pointer);
    if (typeof source !== 'string') {
      errors.push(`source unavailable: ${selected.source_id}`);
      continue;
    }
    if (sha256(source) !== selected.source_sha256) errors.push(`source changed: ${selected.source_id}`);
    const excerpt = source.slice(selected.start, selected.end).trim();
    if (sha256(excerpt) !== selected.chunk_sha256) errors.push(`chunk mismatch: ${selected.pointer}`);
  }
  return { ok: errors.length === 0, errors, selected: crystal.selected?.length || 0 };
}

export const __contextCrystalInternals = Object.freeze({ sha256, chunkSource, estimateTokens, lexicalScore, orderedTokens, orderSelectedChunks });
