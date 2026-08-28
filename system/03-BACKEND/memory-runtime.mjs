import crypto from 'node:crypto';
import { canonicalFluxRoot } from '../06-ORANGELLM/memory/ae-cobra/paths.mjs';
import { readFluxTail } from '../06-ORANGELLM/memory/ae-cobra/flux/reader.mjs';
import { writeFluxRecord } from '../06-ORANGELLM/memory/ae-cobra/flux/writer.mjs';

const VALID_LANES = new Set(['reality', 'thought', 'merge']);
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function boundedText(value, max = 1_000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function boundedStrings(values, limit = 12, max = 1_000) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => boundedText(value, max)).filter(Boolean))].slice(0, limit);
}

function compactSourcePointer(pointer = {}) {
  const out = {
    kind: boundedText(pointer.kind || 'file', 80),
    path: boundedText(pointer.path || pointer.source_path || pointer.sourcePath, 2_048),
    sha256: boundedText(pointer.sha256 || pointer.hash, 128) || null,
    offset: Number.isFinite(pointer.offset) ? Number(pointer.offset) : null,
    bytes: Number.isFinite(pointer.bytes) ? Number(pointer.bytes) : null,
    line: Number.isFinite(pointer.line) ? Number(pointer.line) : null,
    end_line: Number.isFinite(pointer.end_line ?? pointer.endLine) ? Number(pointer.end_line ?? pointer.endLine) : null,
  };
  if (!out.path) return null;
  return out;
}

function compactDecision(decision = {}) {
  const reason = boundedText(decision.reason, 1_200);
  if (!reason) return null;
  return {
    decision_id: boundedText(decision.decision_id || decision.decisionId, 160) || null,
    reason,
    basis: boundedStrings(decision.basis, 12, 500),
    parent_ids: boundedStrings(decision.parent_ids || decision.parentIds, 12, 160),
    decided_by: boundedText(decision.decided_by || decision.decidedBy, 160) || null,
  };
}

function compactDebt(debt = {}) {
  const debtType = boundedText(debt.debt_type || debt.debtType || debt.type, 120);
  if (!debtType) return null;
  const status = boundedText(debt.status || 'open', 40).toLowerCase();
  return {
    debt_id: boundedText(debt.debt_id || debt.debtId, 160) || null,
    debt_type: debtType,
    status,
    severity: Number.isFinite(debt.severity) ? Number(debt.severity) : null,
    reason: boundedText(debt.reason || debt.summary, 1_200),
    contradicts: boundedStrings(debt.contradicts, 12, 200),
    resolution: boundedText(debt.resolution || debt.resolved_by, 1_000) || null,
  };
}

function findExistingRecord(fluxRoot, memoryId) {
  let records = [];
  try {
    records = readFluxTail({
      fluxRoot,
      lanes: ['reality', 'thought', 'merge'],
      // Writes are off the hot path. Exact idempotency is more important here
      // than a tail-only optimization that duplicates an older stable ID.
      maxRecords: Number.MAX_SAFE_INTEGER,
    });
  } catch { return null; }
  return records.find((record) => record?.body?.memory_id === memoryId) || null;
}

function summaryWithCitation(value, pointer) {
  const sourcePath = boundedText(pointer?.path, 600);
  if (!sourcePath) return boundedText(value, 2_000);
  const fields = [
    `source_path=${sourcePath}`,
    pointer.sha256 ? `source_sha256=${boundedText(pointer.sha256, 128)}` : null,
    Number.isFinite(pointer.offset) ? `source_offset=${pointer.offset}` : null,
    Number.isFinite(pointer.line) ? `source_line=${pointer.line}` : null,
    Number.isFinite(pointer.end_line) ? `source_end_line=${pointer.end_line}` : null,
  ].filter(Boolean).join('; ');
  const suffix = `; ${fields}`;
  return `${boundedText(value, Math.max(0, 2_000 - suffix.length))}${suffix}`.slice(0, 2_000);
}

/**
 * Persist a compact memory record in the canonical AE-Cobra Flux ledger.
 * Graph Weaver consumes that same ledger into its existing SQLite graph; this
 * module deliberately owns neither another ledger nor another database.
 */
export function persistMemoryRecord(record = {}, opts = {}) {
  const lane = record.lane || 'thought';
  if (!VALID_LANES.has(lane)) throw new Error(`memory-runtime: invalid lane ${lane}`);
  const kind = boundedText(record.kind || 'memory_event', 120);
  const rawSummary = boundedText(record.summary, 2_000);
  if (!rawSummary) throw new Error('memory-runtime: summary is required');

  const sourcePointers = (record.source_pointers || record.sourcePointers || [])
    .map(compactSourcePointer)
    .filter(Boolean)
    .slice(0, 12);
  const summary = summaryWithCitation(rawSummary, sourcePointers[0]);
  const decision = compactDecision(record.decision);
  const debts = (Array.isArray(record.debts) ? record.debts : [record.debt])
    .map(compactDebt)
    .filter(Boolean)
    .slice(0, 12);
  const identity = {
    kind,
    summary,
    sourcePointers,
    decision,
    debts,
    receiptId: record.receipt_id || record.receiptId || null,
  };
  const memoryId = boundedText(record.memory_id || record.memoryId, 160)
    || `mem_${sha256(stableJson(identity)).slice(0, 32)}`;
  const fluxRoot = opts.fluxRoot || canonicalFluxRoot();

  if (opts.dedupe !== false) {
    const existing = findExistingRecord(fluxRoot, memoryId);
    if (existing) return { ...existing, deduped: true, memory_id: memoryId };
  }

  const body = {
    schema: 'orange5.memory-record.v1',
    memory_id: memoryId,
    event_type: kind,
    summary,
    entities: boundedStrings(record.entities, 20, 200),
    files: boundedStrings(record.files, 20, 2_048),
    commands: boundedStrings(record.commands, 8, 1_000),
    source_pointers: sourcePointers,
    source_file: sourcePointers[0]?.path || null,
    source_hash: sourcePointers[0]?.sha256 || null,
    decision,
    debts,
    risk: boundedText(record.risk || (debts.some((debt) => debt.status === 'open') ? 'high' : 'low'), 40),
    next_action: boundedText(record.next_action || record.nextAction, 1_000) || null,
    confidence: Number.isFinite(record.confidence) ? Number(record.confidence) : null,
    receipt_id: boundedText(record.receipt_id || record.receiptId, 160) || null,
    archive: record.archive && typeof record.archive === 'object' ? record.archive : null,
  };
  const writer = typeof opts.writer === 'function' ? opts.writer : writeFluxRecord;
  const written = writer({
    fluxRoot,
    lane,
    origin: boundedText(record.origin || 'orange5-memory-runtime', 160),
    kind,
    body,
    ts: Number.isFinite(record.ts) ? Number(record.ts) : Date.now(),
  });
  return { ...written, deduped: false, memory_id: memoryId };
}

export function recordTranscriptArchive(archive = {}, opts = {}) {
  const provider = boundedText(archive.provider, 80);
  const sessionId = boundedText(archive.session_id || archive.sessionId, 200);
  const rawPath = archive.raw_path || archive.rawPath;
  const rawHash = archive.raw_sha256 || archive.rawSha256;
  if (!provider || !sessionId || !rawPath || !rawHash) {
    throw new Error('memory-runtime: provider, session_id, raw_path, and raw_sha256 are required');
  }
  return persistMemoryRecord({
    lane: 'reality',
    kind: 'source_archive',
    memory_id: `source_${sha256(`${provider}|${sessionId}|${rawHash}`).slice(0, 32)}`,
    summary: `source_archive=${provider}; session=${sessionId}; raw_sha256=${rawHash}; exact provider transcript preserved on disk`,
    entities: ['OrangeFive', 'AE Cobra', provider, sessionId],
    files: [rawPath, archive.markdown_path || archive.markdownPath, archive.source_path || archive.sourcePath].filter(Boolean),
    source_pointers: [{
      kind: 'transcript-raw',
      path: rawPath,
      sha256: rawHash,
      bytes: archive.archived_bytes ?? archive.archivedBytes,
    }],
    decision: {
      decision_id: `archive:${sessionId}:${String(rawHash).slice(0, 16)}`,
      reason: 'Preserve full source truth on disk and inject only compact, hydratable pointers into working context.',
      basis: [archive.source_path || archive.sourcePath, `sha256:${rawHash}`].filter(Boolean),
      parent_ids: archive.prior_flux_hash ? [archive.prior_flux_hash] : [],
      decided_by: 'orange5-transcript-archive',
    },
    archive: {
      provider,
      session_id: sessionId,
      source_path: archive.source_path || archive.sourcePath,
      raw_path: rawPath,
      markdown_path: archive.markdown_path || archive.markdownPath || null,
      index_path: archive.index_path || archive.indexPath || null,
      raw_sha256: rawHash,
      archived_bytes: archive.archived_bytes ?? archive.archivedBytes ?? null,
      indexed_records: archive.indexed_records ?? archive.indexedRecords ?? null,
    },
    next_action: 'Hydrate the raw source pointer only when compact retrieval is insufficient.',
    confidence: 1,
  }, opts);
}

export function recordContradictionDebt(debt = {}, opts = {}) {
  const supplied = compactDebt({ ...debt, debt_type: 'memory_contradiction' });
  const compact = supplied?.resolution && supplied.status !== 'resolved'
    ? { ...supplied, status: 'resolved' }
    : supplied;
  if (!compact?.reason) throw new Error('memory-runtime: contradiction reason is required');
  const resolved = compact.status === 'resolved' || Boolean(compact.resolution);
  const debtId = compact.debt_id || `debt_${sha256(stableJson(compact)).slice(0, 32)}`;
  const revisionId = `debt_revision_${sha256(debtId).slice(0, 24)}_${compact.status}_${sha256(stableJson({ ...compact, debt_id: debtId })).slice(0, 24)}`;
  return persistMemoryRecord({
    lane: resolved ? 'reality' : 'thought',
    kind: 'memory_debt',
    memory_id: revisionId,
    summary: `debt_id=${debtId}; debt_type=${compact.debt_type}; debt_status=${compact.status}; reason=${compact.reason}${compact.resolution ? `; resolution=${compact.resolution}` : ''}`,
    entities: debt.entities || ['OrangeFive', 'AE Cobra', debtId],
    files: debt.files || [],
    source_pointers: debt.source_pointers || debt.sourcePointers || [],
    decision: debt.decision || {
      decision_id: `decision:${debtId}`,
      reason: compact.resolution || 'Keep the contradiction open until a newer receipt or live probe resolves it.',
      basis: compact.contradicts,
      parent_ids: debt.parent_ids || debt.parentIds || [],
      decided_by: 'orange5-memory-runtime',
    },
    debt: { ...compact, debt_id: debtId },
    risk: resolved ? 'low' : 'high',
    next_action: debt.next_action || debt.nextAction || (resolved
      ? 'Retain the resolution lineage and continue to prefer the newer evidence.'
      : 'Resolve against a fresh receipt or live probe; do not silently choose a side.'),
    confidence: Number.isFinite(debt.confidence) ? debt.confidence : 1,
    receipt_id: debt.receipt_id || debt.receiptId || null,
  }, opts);
}

export const __memoryRuntimeInternals = Object.freeze({
  stableJson,
  sha256,
  boundedText,
  compactSourcePointer,
  compactDecision,
  compactDebt,
  findExistingRecord,
  summaryWithCitation,
});
