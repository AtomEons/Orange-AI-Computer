// Orange5 Learning Loop (Phase 5) — the leap from tool to wisdom.
//
// The spine already SURFACES prior mistakes before acting (its recall step).
// This closes the other half: every receipt is fed BACK into AE Cobra memory,
// so the next order of the same class carries its own lesson. Over time the
// system stops repeating what it already learned.
//
// Real round-trip: append to the live flux ledger -> bounded episode recall reads it.
// NOTE: writes in the reader's ACTUAL layout (<fluxRoot>/events/<lane>/<day>.jsonl,
// flat {ts,lane,origin,kind,body,prev_hash,hash} lines) — NOT the drifted
// flux/writer.mjs, which uses an incompatible path+shape. See flux/reader.mjs.
// Bun only. Offline-safe. Ingestion runs OFF the hot path.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalFluxRoot } from '../06-ORANGELLM/memory/ae-cobra/paths.mjs';
import { _internal as fluxWriterInternals } from '../06-ORANGELLM/memory/ae-cobra/flux/writer.mjs';
import { readFluxTail } from '../06-ORANGELLM/memory/ae-cobra/flux/reader.mjs';
import { persistMemoryRecord, recordContradictionDebt } from './memory-runtime.mjs';

// Reader and live Cobra writers define the first record in each lane with the
// literal sentinel below. A derived hash here created valid-looking records
// that the canonical chain verifier correctly rejected.
const FLUX_GENESIS = 'GENESIS';
const VALID_LANES = new Set(['reality', 'thought', 'merge']);
const SUCCESS_STATUSES = new Set(['ok', 'completed', 'ready', 'planned', 'passed', 'green']);
const GUARDED_STOP_STATUSES = new Set(['needs_action', 'rejected', 'deferred']);
const GUARDED_STOP_REASON = /no governed evidence|run a governed probe|provide evidence|gather evidence|approval (?:is )?required|awaiting approval|requires approval|forbidden|outside (?:the )?scope|policy boundary|unsafe request|not allowed/i;

// Append a record in the exact layout readFlux() reads. The chain is continuous
// across daily files for each lane; only the first-ever lane record uses genesis.
function appendFlux({ fluxRoot, lane, origin, kind, body, ts }) {
  if (!fluxRoot) throw new Error('learning-loop: fluxRoot required to persist memory');
  if (!VALID_LANES.has(lane)) throw new Error(`learning-loop: invalid lane ${lane}`);
  const when = typeof ts === 'number' && Number.isFinite(ts) ? ts : Date.now();
  const dir = path.join(fluxRoot, 'events', lane);
  fs.mkdirSync(dir, { recursive: true });
  const utcDay = new Date(when).toISOString().slice(0, 10);
  const latestDay = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name))
    .map((entry) => entry.name.slice(0, 10))
    .sort().at(-1);
  const day = latestDay && latestDay > utcDay ? latestDay : utcDay;
  const file = path.join(dir, `${day}.jsonl`);
  let prev = FLUX_GENESIS;
  try {
    const files = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => entry.name)
      .sort();
    const tailFile = files.at(-1);
    if (tailFile) {
      const lines = fs.readFileSync(path.join(dir, tailFile), 'utf8').trim().split('\n').filter(Boolean);
      if (lines.length) prev = JSON.parse(lines.at(-1)).hash || FLUX_GENESIS;
    }
  } catch { /* first record in lane */ }
  const base = { ts: when, lane, origin, kind, body, prev_hash: prev };
  const hash = fluxWriterInternals.computeRecordHash(prev, { lane, origin, kind, body });
  const rec = { ...base, hash };
  fs.appendFileSync(file, JSON.stringify(rec) + '\n');
  return rec;
}

/**
 * Feed a spine receipt back into AE Cobra memory. Failures (error/halted) carry
 * explicit failure signals so recall-engine's isMistakeRecord() counts them.
 * @param receipt { action, status, summary, receipt_id }
 * @param opts.fluxRoot  ledger root (required)
 * @param opts.lane      'thought' (default) | 'reality'
 * @param opts.ts        timestamp (default now — must be within recall lookback)
 * @param opts.writer    injectable writer (defaults to the real appendFlux)
 */
export async function ingestReceipt(receipt, opts = {}) {
  if (!receipt || typeof receipt !== 'object' || !receipt.action) {
    throw new Error('learning-loop: receipt with an action is required');
  }
  const action = String(receipt.action);
  const disposition = classifyOutcomeDisposition(receipt);
  const isMistake = disposition === 'failure';
  const lane = opts.lane || 'thought';
  const failureClass = isMistake ? classifyFailure(receipt) : null;
  const lesson = compileLesson(receipt, { isMistake, failureClass, disposition });
  const fingerprint = createHash('sha256').update([
    actionFamily(action), failureClass || 'success', normalizeText(receipt.summary), receipt.targetProject || '',
  ].join('|')).digest('hex');
  const decisionMemoryId = `decision_${createHash('sha256').update([
    fingerprint, receipt.hash || '', receipt.receipt_id || '', receipt.seq ?? '', receipt.ts ?? '',
  ].join('|')).digest('hex').slice(0, 32)}`;
  const lineage = decisionLineage(receipt, { action, disposition, failureClass, lesson, fingerprint });
  const debts = receiptDebts(receipt, { action, disposition, failureClass, fingerprint });
  const sourcePointers = receiptSourcePointers(receipt);
  const body = {
    action, status: receipt.status ?? 'ok', summary: receipt.summary ?? '',
    receipt_id: receipt.receipt_id ?? null, is_mistake: isMistake,
    outcome: disposition, failure_class: failureClass,
    lesson, lesson_fingerprint: fingerprint,
    target_project: receipt.targetProject || receipt.target_project || null,
    source_pointers: sourcePointers,
    decision: lineage,
    debts,
    blockers: Array.isArray(receipt.blockers) ? receipt.blockers.map(String).slice(0, 8) : [],
    next_action: receipt.nextAction || receipt.next_action || (isMistake ? repairFor(failureClass, action) : 'Reuse this proven path when relevant.'),
    // real failure signals -> isMistakeRecord() true. Only on genuine failures.
    ...(isMistake ? { overall_ok: false, severity: 'error' } : {}),
  };
  const cobraUrl = opts.cobraUrl || null;
  if (cobraUrl) {
    try {
      const response = await (opts.fetchImpl || fetch)(`${String(cobraUrl).replace(/\/$/, '')}/event`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          origin: 'terminal',
          event: {
            event_type: isMistake ? 'error' : (disposition === 'guarded_stop' ? 'decision' : 'receipt'),
            // Put the machine cause before prose so recall remains useful even
            // when downstream memory compacts or truncates the event.
            summary: `outcome=${disposition}; failure_class=${failureClass || 'none'}; action=${action}; status=${body.status}; cause=${body.summary}; repair=${lesson}`.slice(0, 500),
            entities: [action, actionFamily(action), failureClass, fingerprint, body.receipt_id, receipt.hash].filter(Boolean),
            files: [receipt.receiptPath || receipt.receipt_path || '10-RECEIPTS/spine-chain.jsonl'],
            risk: isMistake ? 'high' : (disposition === 'guarded_stop' ? 'medium' : 'low'),
            next_action: body.next_action,
            confidence: isMistake ? 0.9 : (disposition === 'guarded_stop' ? 0.95 : 1),
          },
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok || !result.accepted) {
        throw new Error(`AE-Cobra rejected learning receipt: HTTP ${response.status} ${result.reason || result.error || 'unknown'}`);
      }
      const durable = persistMemoryRecord({
        lane: disposition === 'success' || disposition === 'guarded_stop' ? 'reality' : 'thought',
        kind: 'decision_receipt',
        memory_id: decisionMemoryId,
        summary: `decision_reason=${lineage.reason}; outcome=${disposition}; debt_id=${debts[0]?.debt_id || 'none'}; debt_type=${debts[0]?.debt_type || 'none'}; debt_status=${debts[0]?.status || 'none'}; failure_class=${failureClass || 'none'}; action=${action}; status=${body.status}`,
        entities: [action, actionFamily(action), failureClass, fingerprint, body.receipt_id, receipt.hash].filter(Boolean),
        files: [receipt.receiptPath || receipt.receipt_path || '10-RECEIPTS/spine-chain.jsonl'],
        source_pointers: sourcePointers,
        decision: lineage,
        debts,
        risk: isMistake ? 'high' : (disposition === 'guarded_stop' ? 'medium' : 'low'),
        next_action: body.next_action,
        confidence: isMistake ? 0.9 : 1,
        receipt_id: body.receipt_id,
      }, { fluxRoot: opts.fluxRoot || canonicalFluxRoot(), writer: opts.memoryWriter });
      const contradictionRecords = [];
      for (const debt of contradictionDebts(receipt, { action, fingerprint, sourcePointers, lineage })) {
        contradictionRecords.push(recordContradictionDebt(debt, {
          fluxRoot: opts.fluxRoot || canonicalFluxRoot(),
          writer: opts.memoryWriter,
        }));
      }
      return {
        ...result,
        transport: 'ae-cobra-http+canonical-flux',
        canonical_memory: {
          memory_id: durable.memory_id,
          hash: durable.hash,
          lane: durable.lane,
          deduped: durable.deduped === true,
          sqlite_projection: 'graph-weaver-derived',
        },
        contradiction_debts: contradictionRecords.map((record) => ({
          memory_id: record.memory_id, hash: record.hash, lane: record.lane, deduped: record.deduped === true,
        })),
      };
    } catch (error) {
      if (opts.requireCobra) throw error;
      // Offline/test fallback preserves learning, but production callers set
      // requireCobra so a split writer cannot be silently introduced.
    }
  }
  const rec = { fluxRoot: opts.fluxRoot || canonicalFluxRoot(), lane, origin: `spine:${action}`, kind: (isMistake ? `mistake:${action}` : `receipt:${action}`), body, ts: opts.ts };
  const write = typeof opts.writer === 'function' ? opts.writer : appendFlux;
  return write(rec);
}

/**
 * The lesson to inject BEFORE executing an order of this class. Pure read.
 * Offline-safe: empty/missing ledger -> count 0, warning null, never throws.
 */
export function lessonFor(action, opts = {}) {
  const act = String(action || '');
  const nowMs = opts.nowMs || Date.now();
  const lookbackMs = opts.lookbackMs || 365 * 86_400_000;
  const episode = recentFailureEpisode(act, {
    fluxRoot: opts.fluxRoot || canonicalFluxRoot(),
    nowMs,
    lookbackMs,
    limit: opts.limit ?? 5,
    scanLimit: opts.scanLimit ?? 2_000,
    intent: opts.intent || opts.order?.intent || opts.order?.payload?.intent || opts.order?.payload?.text || '',
    targetProject: opts.targetProject || opts.order?.targetProject || opts.order?.payload?.targetProject || '',
    failureClass: opts.failureClass || opts.order?.failureClass || opts.order?.payload?.failureClass || '',
  });
  const mistakes = episode.mistakes;
  const count = mistakes.length;
  const patterns = aggregatePatterns(mistakes);
  return {
    action: act, count, mistakes, patterns,
    resolved_count: episode.resolvedCount,
    suppressed_count: episode.suppressedCount,
    candidates_considered: episode.candidatesConsidered,
    last_resolution_at: episode.resolution?.iso || null,
    last_resolution_disposition: episode.resolution?.disposition || null,
    recommendedAction: patterns[0]?.repair || null,
    warning: count > 0 ? `AE Cobra: ${count} prior issue(s) recorded for "${act}" — review before proceeding` : null,
  };
}

/**
 * Close the loop around one spine result: surface the lesson (to inject) and
 * schedule the receipt ingest OFF the hot path. Returns { lesson, ingestDone }.
 */
export function closeLoop(spineResult, opts = {}) {
  const action = spineResult?.report?.action ?? spineResult?.order?.action;
  const lesson = action ? lessonFor(action, opts) : { action: null, count: 0, mistakes: [], warning: null };
  let ingestDone = Promise.resolve(null);
  if (spineResult?.receipt) {
    const enriched = {
      ...spineResult.receipt,
      action: spineResult.report?.action || spineResult.receipt.action,
      status: spineResult.report?.status || spineResult.receipt.status,
      summary: spineResult.report?.summary || spineResult.receipt.summary,
      blockers: spineResult.report?.blockers || spineResult.report?.output?.blockers || [],
      nextAction: spineResult.report?.nextAction || spineResult.report?.output?.nextAction || null,
      targetProject: spineResult.order?.targetProject || spineResult.order?.payload?.targetProject || null,
      decision_reason: spineResult.report?.decision_reason
        || spineResult.report?.reason
        || spineResult.plan?.gate_first_fail?.reason
        || spineResult.report?.summary
        || null,
      decision_basis: [
        spineResult.plan?.lane ? `lane:${spineResult.plan.lane}` : null,
        spineResult.plan?.topology ? `topology:${spineResult.plan.topology}` : null,
        spineResult.prior?.verdict ? `prior:${spineResult.prior.verdict}` : null,
      ].filter(Boolean),
      contradictions: spineResult.report?.contradictions
        || spineResult.report?.conflicts
        || spineResult.project?.conflicts
        || [],
    };
    ingestDone = new Promise((resolve) => {
      queueMicrotask(() => ingestReceipt(enriched, opts).then(resolve).catch((e) => resolve({ ok: false, note: e?.message })));
    });
  }
  return { lesson, ingestDone };
}

function classifyFailure(receipt = {}) {
  const text = `${receipt.status || ''} ${receipt.summary || ''} ${(receipt.blockers || []).join(' ')}`.toLowerCase();
  const explicit = text.match(/failure_class\s*=\s*([a-z_]+)/)?.[1];
  if (explicit && Object.hasOwn(FAILURE_REPAIRS, explicit)) return explicit;
  if (/timeout|unreachable|connect(?:ion|ed|ing)?|network|dns|socket|offline|401|403/.test(text)) return 'connectivity_or_auth';
  if (/loom|gate|approval|denied|refus|forbidden|policy/.test(text)) return 'governance_boundary';
  if (/test|build|typecheck|lint|compile|assert|verification/.test(text)) return 'verification_failure';
  if (/context|token|overflow|budget|too large/.test(text)) return 'context_pressure';
  if (/schema|json|parse|contract|format/.test(text)) return 'contract_failure';
  if (/evidence|hallucin|fake|unsupported|citation|claim/.test(text)) return 'epistemic_failure';
  if (/memory|recall|retriev|stale/.test(text)) return 'memory_failure';
  if (/resource|ram|vram|gpu|cpu|disk|oom|out of memory/.test(text)) return 'resource_pressure';
  if (/(?:specialist|model|lease|capability).*(?:unavailable|failed|missing|restore|insufficient|not resident)|restore.*(?:specialist|model|capability)/.test(text)) return 'capability_route_failure';
  return 'unclassified_failure';
}

function decisionLineage(receipt, { action, disposition, failureClass, lesson, fingerprint }) {
  const reason = receipt.decision_reason || receipt.decisionReason || receipt.reason || receipt.summary || lesson;
  return {
    decision_id: receipt.decision_id || receipt.decisionId || receipt.receipt_id || receipt.hash || `decision_${fingerprint.slice(0, 24)}`,
    reason: String(reason || `${action} ended with ${disposition}`),
    basis: [
      `action:${action}`,
      `outcome:${disposition}`,
      failureClass ? `failure_class:${failureClass}` : null,
      ...(Array.isArray(receipt.evidence_refs) ? receipt.evidence_refs : []),
      ...(Array.isArray(receipt.decision_basis) ? receipt.decision_basis : []),
    ].filter(Boolean),
    parent_ids: [
      receipt.parent_receipt,
      receipt.prev_hash,
      ...(Array.isArray(receipt.supersedes) ? receipt.supersedes : []),
    ].filter((value) => value !== null && value !== undefined).map(String),
    decided_by: receipt.decided_by || receipt.expert_id || 'orange5-spine',
  };
}

function receiptSourcePointers(receipt = {}) {
  const sourcePath = receipt.receiptPath || receipt.receipt_path || '10-RECEIPTS/spine-chain.jsonl';
  return [{
    kind: 'receipt',
    path: sourcePath,
    sha256: receipt.hash || null,
    offset: Number.isFinite(receipt.seq) ? Number(receipt.seq) : null,
    line: Number.isFinite(receipt.source_line) ? Number(receipt.source_line) : null,
    end_line: Number.isFinite(receipt.source_end_line) ? Number(receipt.source_end_line) : null,
  }];
}

function receiptDebts(receipt, { action, disposition, failureClass, fingerprint }) {
  if (disposition !== 'failure') return [];
  return [{
    debt_id: `failure_${fingerprint.slice(0, 32)}`,
    debt_type: 'execution_failure',
    status: 'open',
    severity: 0.8,
    reason: receipt.summary || `${action} failed`,
    contradicts: Array.isArray(receipt.supersedes) ? receipt.supersedes.map(String) : [],
    resolution: null,
    failure_class: failureClass,
  }];
}

function contradictionDebts(receipt, { action, fingerprint, sourcePointers, lineage }) {
  const values = [
    ...(Array.isArray(receipt.contradictions) ? receipt.contradictions : []),
    ...(Array.isArray(receipt.conflicts) ? receipt.conflicts : []),
    ...(Array.isArray(receipt.memory_debts) ? receipt.memory_debts.filter((item) => item?.debt_type === 'memory_contradiction') : []),
  ];
  return values.slice(0, 12).map((value, index) => {
    const item = value && typeof value === 'object' ? value : { summary: String(value) };
    const resolution = item.resolution || item.resolved_by || null;
    const reason = item.reason || item.summary || JSON.stringify(item);
    const debtId = item.debt_id || `memory_conflict_${createHash('sha256').update(`${fingerprint}|${index}|${reason}`).digest('hex').slice(0, 24)}`;
    return {
      debt_id: debtId,
      status: resolution ? 'resolved' : 'open',
      severity: Number.isFinite(item.severity) ? item.severity : 0.8,
      reason,
      contradicts: [item.reality_id, item.thought_id, item.against].filter(Boolean).map(String),
      resolution,
      entities: [action, debtId, ...(Array.isArray(item.shared_subjects) ? item.shared_subjects : [])],
      files: sourcePointers.map((pointer) => pointer.path),
      source_pointers: sourcePointers,
      decision: { ...lineage, decision_id: `decision:${debtId}`, reason: resolution || lineage.reason },
      receipt_id: receipt.receipt_id || null,
    };
  });
}

function classifyOutcomeDisposition(receipt = {}) {
  const status = String(receipt.status || '').toLowerCase();
  if (SUCCESS_STATUSES.has(status)) return 'success';
  const text = `${receipt.summary || ''} ${(receipt.blockers || []).join(' ')} ${receipt.nextAction || receipt.next_action || ''}`;
  if (GUARDED_STOP_STATUSES.has(status) && GUARDED_STOP_REASON.test(text)) return 'guarded_stop';
  return 'failure';
}

function recordAction(record = {}) {
  const body = record?.body && typeof record.body === 'object' ? record.body : {};
  if (typeof body.action === 'string' && body.action) return body.action.toLowerCase();
  for (const entity of Array.isArray(body.entities) ? body.entities : []) {
    if (/^[a-z][a-z0-9_-]*\.[a-z0-9_.-]+$/i.test(String(entity))) return String(entity).toLowerCase();
  }
  const surface = `${body.summary || ''} ${record.kind || ''} ${record.origin || ''}`;
  const explicit = surface.match(/\baction=([a-z][a-z0-9_-]*\.[a-z0-9_.-]+)/i)?.[1];
  if (explicit) return explicit.toLowerCase();
  const embedded = surface.match(/\b([a-z][a-z0-9_-]*\.[a-z0-9_.-]+)\b/i)?.[1];
  return embedded ? embedded.toLowerCase() : null;
}

function recordDisposition(record = {}) {
  const body = record?.body && typeof record.body === 'object' ? record.body : {};
  if (['success', 'guarded_stop', 'failure'].includes(body.outcome)) return body.outcome;
  const summary = String(body.summary || '');
  const explicit = summary.match(/\boutcome=(success|guarded_stop|failure)\b/i)?.[1];
  if (explicit) return explicit.toLowerCase();
  const kind = String(record.kind || body.event_type || '').toLowerCase();
  if (/error|fail|risk|mistake/.test(kind) || body.overall_ok === false) return 'failure';
  const status = String(body.status || summary.match(/\bstatus=([a-z_]+)\b/i)?.[1] || '').toLowerCase();
  if (SUCCESS_STATUSES.has(status)) return 'success';
  if (GUARDED_STOP_STATUSES.has(status) && GUARDED_STOP_REASON.test(summary)) return 'guarded_stop';
  if (/receipt/.test(kind)) return 'success';
  return null;
}

function projectEpisodeRecord(record = {}) {
  const body = record?.body && typeof record.body === 'object' ? record.body : {};
  return {
    ts: record.ts,
    iso: Number.isFinite(record.ts) ? new Date(record.ts).toISOString() : null,
    lane: record.lane || null,
    origin: record.origin || null,
    kind: record.kind || null,
    summary: String(body.summary || body.next_action || record.kind || ''),
    entities: Array.isArray(body.entities) ? body.entities.slice(0, 20) : [],
    files: Array.isArray(body.files) ? body.files.slice(0, 20) : [],
    commands: Array.isArray(body.commands) ? body.commands.slice(0, 20) : [],
    next_action: typeof body.next_action === 'string' ? body.next_action : null,
    risk: typeof body.risk === 'string' ? body.risk : null,
    receipt_id: record.hash || null,
    action: recordAction(record),
    target_project: body.target_project || body.targetProject || null,
    failure_class: body.failure_class || null,
  };
}

function recentFailureEpisode(action, {
  fluxRoot,
  nowMs = Date.now(),
  lookbackMs = 365 * 86_400_000,
  limit = 5,
  scanLimit = 2_000,
  intent = '',
  targetProject = '',
  failureClass = '',
} = {}) {
  const act = String(action || '').toLowerCase();
  let records = [];
  try {
    records = readFluxTail({
      fluxRoot,
      lanes: ['reality', 'thought'],
      startMs: Math.max(0, nowMs - lookbackMs),
      endMs: nowMs,
      maxRecords: scanLimit,
    });
  } catch { return { mistakes: [], resolution: null, resolvedCount: 0, suppressedCount: 0, candidatesConsidered: 0, scanned: 0 }; }

  const actionCandidates = records.filter((record) => {
    const observedAction = recordAction(record);
    if (!observedAction) return false;
    if (act.startsWith('query.')) return observedAction === act;
    return observedAction === act || actionFamily(observedAction) === actionFamily(act);
  });
  const query = {
    action: act,
    intent: String(intent || ''),
    targetProject: normalizeProject(targetProject),
    failureClass: normalizeFailureClass(failureClass),
  };
  const contextual = Boolean(query.intent || query.targetProject || query.failureClass);
  const scored = actionCandidates.map((record) => ({ record, verdict: contextual ? recordRelevance(record, query) : { relevant: true } }));
  const relevant = scored.filter((row) => row.verdict.relevant).map((row) => row.record);
  const suppressedCount = scored.length - relevant.length;
  const resolutionRecord = relevant.find((record) => ['success', 'guarded_stop'].includes(recordDisposition(record)));
  const resolution = resolutionRecord ? {
    ts: Number(resolutionRecord.ts),
    iso: new Date(Number(resolutionRecord.ts)).toISOString(),
    disposition: recordDisposition(resolutionRecord),
    hash: resolutionRecord.hash || null,
  } : null;
  const failures = relevant.filter((record) => recordDisposition(record) === 'failure');
  const unresolved = resolution ? failures.filter((record) => Number(record.ts) > resolution.ts) : failures;
  return {
    mistakes: unresolved.slice(0, Math.max(1, Number(limit) || 5)).map(projectEpisodeRecord),
    resolution,
    resolvedCount: Math.max(0, failures.length - unresolved.length),
    suppressedCount,
    candidatesConsidered: actionCandidates.length,
    scanned: records.length,
  };
}

function recordRelevance(record, query) {
  const body = record?.body && typeof record.body === 'object' ? record.body : {};
  const observedAction = recordAction(record);
  const actionExact = observedAction === query.action;
  const actionFamilyMatch = !actionExact && actionFamily(observedAction) === actionFamily(query.action);
  if (!actionExact && !actionFamilyMatch) return { relevant: false, reason: 'action_mismatch' };

  const observedProject = normalizeProject(body.target_project || body.targetProject);
  if (query.targetProject && observedProject && query.targetProject !== observedProject) {
    return { relevant: false, reason: 'project_mismatch' };
  }
  const projectMatch = Boolean(query.targetProject && observedProject === query.targetProject);
  const intentTokens = lexicalTokens(query.intent);
  const recordTokens = lexicalTokens([
    body.summary, body.next_action, body.lesson, ...(Array.isArray(body.blockers) ? body.blockers : []),
  ].filter(Boolean).join(' '));
  const intentMatch = [...intentTokens].some((token) => recordTokens.has(token));
  const observedFailure = normalizeFailureClass(body.failure_class || classifyFailure({
    status: body.status, summary: body.summary, blockers: body.blockers,
  }));
  if (query.failureClass && observedFailure && query.failureClass !== observedFailure) {
    return { relevant: false, reason: 'failure_class_mismatch' };
  }
  const failureClassMatch = Boolean(query.failureClass && observedFailure === query.failureClass);
  const supportingSignals = Number(projectMatch) + Number(intentMatch) + Number(failureClassMatch);
  const intentRequiredButMissing = Boolean(query.intent && !intentMatch && !failureClassMatch);
  return {
    relevant: !intentRequiredButMissing && supportingSignals >= (actionExact ? 1 : 2),
    reason: !intentRequiredButMissing && supportingSignals >= (actionExact ? 1 : 2) ? null : 'insufficient_context_overlap',
  };
}

const RECALL_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'before', 'by', 'do', 'for', 'from', 'in', 'is',
  'it', 'of', 'on', 'or', 'the', 'this', 'to', 'with', 'without', 'work', 'task', 'question',
  'answer', 'current', 'new', 'please', 'orange', 'orangefive',
]);

function lexicalTokens(value) {
  const tokens = String(value || '').toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || [];
  return new Set(tokens.map(stemRecallToken).filter((token) => token && !RECALL_STOP_WORDS.has(token)));
}

function stemRecallToken(token) {
  if (token.length > 6 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 5 && token.endsWith('ed')) return token.slice(0, -2);
  if (token.length > 5 && token.endsWith('s')) return token.slice(0, -1);
  return token;
}

function normalizeProject(value) { return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, ''); }
function normalizeFailureClass(value) { return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, ''); }

const FAILURE_REPAIRS = Object.freeze({
  connectivity_or_auth: 'Probe reachability and credentials once, preserve the exact error, then choose a proven alternate route.',
  governance_boundary: 'Read the failed gate and satisfy its evidence or approval condition before retrying.',
  verification_failure: 'Fix the first deterministic failure, rerun the narrow proof, then broaden verification.',
  context_pressure: 'Build a smaller AtomSmasher workset and hydrate only the missing source evidence.',
  contract_failure: 'Validate the exact schema at the boundary and repair the producer before downstream work.',
  epistemic_failure: 'Separate observation from inference and require source or execution evidence before the claim.',
  memory_failure: 'Repair source pointers and retrieval precision before trusting recalled context.',
  resource_pressure: 'Measure the bottleneck, reduce residency or concurrency, and route heavy work to Codexa.',
  capability_route_failure: 'Probe the required capability, repair or select a proven route, and rerun the capability covenant before continuing.',
});

function repairFor(failureClass, action) {
  return FAILURE_REPAIRS[failureClass]
    || `Inspect the source receipt for ${action}, identify the first falsifiable failure, and prove the smallest repair.`;
}

function compileLesson(receipt, { isMistake, failureClass, disposition = 'success' }) {
  if (!isMistake && disposition === 'guarded_stop') return `The ${receipt.action} path correctly withheld completion until its stated evidence or approval condition is met.`;
  if (!isMistake) return `The ${receipt.action} path completed; reuse only while its dependencies and proof remain current.`;
  return repairFor(failureClass, receipt.action);
}

function actionFamily(action) { return String(action || '').toLowerCase().split(/[.:/]/)[0] || 'unknown'; }
function inferredMistakeAction(item = {}) {
  const text = `${item.summary || ''} ${item.kind || ''} ${item.origin || ''}`;
  const match = text.match(/\b([a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)+)\b/i);
  return match ? match[1].toLowerCase() : null;
}
function normalizeText(value) { return String(value || '').toLowerCase().replace(/[a-f0-9]{12,}/g, '<hash>').replace(/\d+/g, '<n>').replace(/\s+/g, ' ').trim().slice(0, 500); }
function sharedActionFamily(action, text) { return new RegExp(`(?:^|[^a-z0-9])${escapeRegex(actionFamily(action))}(?:[^a-z0-9]|$)`, 'i').test(String(text)); }
function escapeRegex(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function aggregatePatterns(mistakes) {
  const map = new Map();
  for (const item of mistakes) {
    const failureClass = classifyFailure({ status: item.kind, summary: item.summary });
    const row = map.get(failureClass) || { failureClass, count: 0, latestAt: null, repair: repairFor(failureClass, item.kind || 'work') };
    row.count++;
    const ts = Number(item.ts);
    if (Number.isFinite(ts) && (!row.latestAt || ts > Date.parse(row.latestAt))) row.latestAt = new Date(ts).toISOString();
    map.set(failureClass, row);
  }
  return [...map.values()].sort((a, b) => b.count - a.count || String(b.latestAt).localeCompare(String(a.latestAt)));
}

export const __loopInternals = Object.freeze({ appendFlux, FLUX_GENESIS, classifyFailure, classifyOutcomeDisposition, compileLesson, actionFamily, inferredMistakeAction, aggregatePatterns, recordAction, recordDisposition, recentFailureEpisode });
