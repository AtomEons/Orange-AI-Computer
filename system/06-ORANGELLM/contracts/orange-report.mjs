// Shared deterministic compiler for model-to-model Orange operational reports.
// Ordinary chat never enters this path; callers opt in with
// ae_response_contract="orange.report.v1".

import { createHash } from 'node:crypto';

export const ORANGE_REPORT_SCHEMA = 'orange.report.v1';
export const ORANGE_REPORT_EVIDENCE_MAX_ITEMS = 2;
export const ORANGE_REPORT_EVIDENCE_MAX_CHARS = 96;
const COMPACT_TEXT = Object.freeze({ type: 'string', maxLength: ORANGE_REPORT_EVIDENCE_MAX_CHARS });
const COMPACT_FINDING = Object.freeze({ type: 'string', maxLength: 240 });
// Internal inference packet. Fixed provenance fields are compiled by Bun,
// which saves model decode work and prevents the model from asserting them.
export const ORANGE_REPORT_DRAFT_JSON_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    s: { type: 'string', enum: ['completed', 'needs_action', 'blocked', 'rejected'] },
    c: { type: 'number', minimum: 0, maximum: 1 },
    e: { type: 'array', maxItems: ORANGE_REPORT_EVIDENCE_MAX_ITEMS, items: COMPACT_TEXT },
    f: { type: 'array', minItems: 1, maxItems: 3, items: COMPACT_FINDING },
    b: { type: 'array', maxItems: 2, items: COMPACT_TEXT },
    n: { type: 'string', minLength: 1, maxLength: 96 },
  },
  required: ['s', 'c', 'e', 'f', 'b', 'n'],
  additionalProperties: false,
});
// Evidence-free chat needs judgment, not six model-authored protocol fields.
// Bun owns the fixed needs_action/evidence/blocker envelope, leaving the model
// only a bounded finding and next action. This lowers decode cost and prevents
// a valid structured response from being truncated before the closing brace.
export const ORANGE_REPORT_NO_EVIDENCE_JSON_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    answer: { type: 'string', minLength: 24, maxLength: 1200 },
    nextAction: { type: 'string', minLength: 1, maxLength: 160 },
  },
  required: ['answer', 'nextAction'],
  additionalProperties: false,
});
// No-evidence operational reports do not need model-authored provenance or
// findings. This fixed-order grammar removes formatting tokens while Bun still
// compiles the public orange.report.v1 envelope and routing semantics.
export const ORANGE_REPORT_NO_EVIDENCE_GBNF = String.raw`root ::= "{" "\"answer\":" string "," "\"nextAction\":" string "}"
string ::= "\"" char* "\""
char ::= [^"\\\x7F\x00-\x1F] | "\\" (["\\/bfnrt] | "u" [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F])`;
export const ORANGE_REPORT_JSON_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    schema: { type: 'string', const: ORANGE_REPORT_SCHEMA },
    orderId: { type: 'string' },
    status: { type: 'string', enum: ['completed', 'needs_action', 'blocked', 'rejected'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    actionsTaken: { type: 'array', items: { type: 'string' } },
    evidence: { type: 'array', items: { type: 'string' } },
    findings: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: { type: 'string' } },
    nextAction: { type: 'string', minLength: 1 },
    // The model cannot attest a host receipt path. The governed runtime adds
    // provenance after execution; model-produced operational reports use null.
    receiptPath: { type: 'null' },
  },
  required: ['schema', 'orderId', 'status', 'confidence', 'actionsTaken', 'evidence', 'blockers', 'nextAction', 'receiptPath'],
  additionalProperties: false,
});
const SUCCESS = new Set(['green', 'passed', 'complete', 'completed', 'ok', 'ready']);
const STATUSES = new Set(['completed', 'needs_action', 'blocked', 'rejected']);
const REPORT_KEYS = new Set(['schema', 'orderId', 'status', 'confidence', 'actionsTaken', 'evidence', 'findings', 'blockers', 'nextAction', 'receiptPath']);
const UNSAFE_COMPLETION_ACTION = /\b(?:claim|declare|mark|report|set)\b.{0,48}\b(?:complete|completed|completion|green|passed|ready)\b/i;
const UNSAFE_RECEIPT_ACTION = /receipt(?:\s*|[_-])path/i;
const RECEIPT_VERBS = '(?:generated|created|written|saved|emitted|issued|attached)';
const UNSAFE_RECEIPT_ATTESTATION = new RegExp(
  `(?:\\breceipt\\b.{0,40}\\b${RECEIPT_VERBS}\\b|\\b${RECEIPT_VERBS}\\b.{0,40}\\breceipt\\b)`,
  'i',
);
const INTERNAL_CONTROL_TOKEN = /\$?(?:ORANGE5_GATEWAY_DOCTRINE_V1|ORANGE5_CONVERSATION_SURFACE_V1|AIR:RUNTIME-CAPABILITIES\.v1|AIR:ORANGE5-NAV\.v1)/gi;
const INTERNAL_PROTOCOL_ONLY = /^(?:orange\.report\.v1|orange refuter verdict|internal refuter protocol|return compact json only)$/i;

function scrubInternalRefuterText(value) {
  const scrubbed = String(value ?? '')
    .replace(INTERNAL_CONTROL_TOKEN, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s:;|,-]+|[\s:;|,-]+$/g, '')
    .trim();
  if (!scrubbed || INTERNAL_PROTOCOL_ONLY.test(scrubbed)) return null;
  return scrubbed;
}

function sanitizeInternalRefuterReport(report) {
  let removed = 0;
  const scrubList = (items = []) => items.flatMap((item) => {
    const scrubbed = scrubInternalRefuterText(item);
    if (scrubbed !== String(item).trim()) removed += 1;
    return scrubbed ? [scrubbed] : [];
  });
  const findings = scrubList(report.findings || []);
  const blockers = scrubList(report.blockers || []);
  const nextAction = scrubInternalRefuterText(report.nextAction);
  if (nextAction !== String(report.nextAction ?? '').trim()) removed += 1;
  if (removed === 0) return { removed: 0, protocolOnly: false };

  report.findings = [...new Set(findings)];
  report.blockers = [...new Set(blockers)];
  // The compact refuter contract requires a substantive finding or blocker.
  // Wire markers are representation, never evidence or semantic objections.
  const protocolOnly = report.findings.length === 0 && report.blockers.length === 0;
  if (protocolOnly) {
    report.status = 'needs_action';
    report.confidence = Math.min(Number(report.confidence) || 0.5, 0.5);
    report.evidence = [];
    report.blockers = ['model draft required deterministic orange.report.v1 schema repair'];
    report.nextAction = 'continue through the governed operational path';
  } else {
    report.nextAction = nextAction || (report.blockers.length
      ? 'verify the concrete blocker against supplied evidence'
      : 'continue bounded evidence review');
  }
  return { removed, protocolOnly };
}

function delegatesRouteChoice(value) {
  const text = String(value ?? '');
  return /\b(?:ask|request)\b/i.test(text)
    && /\b(?:user|operator)\b/i.test(text)
    && /\b(?:route|fallback|lane|model)\b/i.test(text);
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function validateOrangeReport(report, orderId = null) {
  const required = ['schema', 'orderId', 'status', 'confidence', 'actionsTaken', 'evidence', 'blockers', 'nextAction', 'receiptPath'];
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('OrangeBrain did not return a JSON object');
  for (const field of required) if (!(field in report)) throw new Error(`OrangeBrain report missing ${field}`);
  const extras = Object.keys(report).filter((key) => !REPORT_KEYS.has(key));
  if (extras.length) throw new Error(`OrangeBrain report has unsupported fields: ${extras.join(', ')}`);
  if (report.schema !== ORANGE_REPORT_SCHEMA) throw new Error(`OrangeBrain schema must be ${ORANGE_REPORT_SCHEMA}`);
  if (typeof report.orderId !== 'string' || !report.orderId) throw new Error('OrangeBrain orderId must be a non-empty string');
  if (orderId != null && report.orderId !== orderId) throw new Error(`OrangeBrain orderId mismatch: expected ${orderId}`);
  if (!STATUSES.has(String(report.status))) throw new Error(`OrangeBrain status is not allowed: ${report.status}`);
  for (const field of ['actionsTaken', 'evidence', 'blockers']) {
    if (!Array.isArray(report[field]) || report[field].some((item) => typeof item !== 'string')) {
      throw new Error(`OrangeBrain ${field} must be an array of strings`);
    }
  }
  const confidence = Number(report.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('OrangeBrain confidence must be between 0 and 1');
  if (typeof report.nextAction !== 'string' || !report.nextAction.trim()) throw new Error('OrangeBrain nextAction must be a non-empty string');
  if (SUCCESS.has(String(report.status).toLowerCase()) && report.evidence.length === 0) throw new Error('OrangeBrain success status requires evidence');
  if (SUCCESS.has(String(report.status).toLowerCase()) && report.blockers.length > 0) throw new Error('OrangeBrain success status cannot carry blockers');
  if (report.receiptPath !== null) throw new Error('OrangeBrain model reports cannot self-attest receiptPath');
  return {
    schema: ORANGE_REPORT_SCHEMA,
    orderId: report.orderId,
    status: report.status,
    confidence,
    actionsTaken: report.actionsTaken,
    evidence: report.evidence,
    findings: Array.isArray(report.findings) && report.findings.every((item) => typeof item === 'string') ? report.findings : [],
    blockers: report.blockers,
    nextAction: report.nextAction,
    receiptPath: null,
  };
}

export function compileOrangeReport(draft, orderId = null) {
  const repairReasons = [];
  try {
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new Error('OrangeBrain did not return a JSON object');
    const compactKeys = ['status', 'confidence', 'evidence', 'blockers', 'nextAction'];
    const shortKeys = ['s', 'c', 'e', 'b', 'n'];
    const isLongCompactDraft = Object.keys(draft).length === compactKeys.length
      && compactKeys.every((key) => key in draft);
    const isShortDraft = (Object.keys(draft).length === shortKeys.length || Object.keys(draft).length === shortKeys.length + 1)
      && shortKeys.every((key) => key in draft) && Object.keys(draft).every((key) => shortKeys.includes(key) || key === 'f');
    const isLegacyNoEvidenceDraft = Object.keys(draft).length === 2
      && Array.isArray(draft.f)
      && typeof draft.n === 'string';
    const isNoEvidenceDraft = Object.keys(draft).length === 2
      && typeof draft.answer === 'string'
      && typeof draft.nextAction === 'string';
    const isCompactDraft = isLongCompactDraft || isShortDraft || isNoEvidenceDraft || isLegacyNoEvidenceDraft;
    const draftFindings = isShortDraft ? draft.f : draft.findings;
    const evidenceValue = isShortDraft ? draft.e : draft.evidence;
    const quarantinedEvidenceFinding = typeof evidenceValue === 'string' && evidenceValue.trim()
      ? [evidenceValue.trim().slice(0, 240)]
      : [];
    if (quarantinedEvidenceFinding.length) repairReasons.push('non-array evidence quarantined as an unverified finding');
    const candidate = {
      schema: ORANGE_REPORT_SCHEMA,
      orderId: orderId ?? draft.orderId,
      status: (isNoEvidenceDraft || isLegacyNoEvidenceDraft) ? 'needs_action' : (isShortDraft ? draft.s : draft.status),
      confidence: (isNoEvidenceDraft || isLegacyNoEvidenceDraft) ? 0.5 : (isShortDraft ? draft.c : draft.confidence),
      // Model inference proposes judgment; only the governed executor may
      // attest actions. The compact packet therefore compiles to no actions.
      actionsTaken: isCompactDraft ? [] : (Array.isArray(draft.actionsTaken) ? draft.actionsTaken : []),
      evidence: Array.isArray(evidenceValue) ? evidenceValue : [],
      findings: [
        ...(isNoEvidenceDraft
          ? [draft.answer]
          : (Array.isArray(isLegacyNoEvidenceDraft ? draft.f : draftFindings)
            ? (isLegacyNoEvidenceDraft ? draft.f : draftFindings)
            : [])),
        ...quarantinedEvidenceFinding,
      ].slice(0, 3),
      blockers: (isNoEvidenceDraft || isLegacyNoEvidenceDraft) ? ['no governed evidence supplied'] : (isShortDraft ? draft.b : draft.blockers),
      nextAction: isLegacyNoEvidenceDraft ? draft.n : (isShortDraft ? draft.n : draft.nextAction),
      receiptPath: null,
    };
    if (candidate.status === 'completed' && candidate.evidence.length === 0) {
      candidate.status = 'needs_action';
      candidate.confidence = Math.min(Number(candidate.confidence) || 0.5, 0.5);
      candidate.blockers = [...new Set([
        ...(Array.isArray(candidate.blockers) ? candidate.blockers : []),
        'no governed evidence supplied',
      ])];
      candidate.nextAction = 'run a governed probe or provide evidence';
      repairReasons.push('evidence-free completion downgraded');
    }
    if (candidate.status === 'completed'
      && Array.isArray(candidate.blockers)
      && candidate.blockers.length > 0) {
      candidate.status = 'needs_action';
      candidate.confidence = Math.min(Number(candidate.confidence) || 0.5, 0.5);
      repairReasons.push('completion with blockers downgraded');
    }
    if (candidate.status !== 'completed' && UNSAFE_COMPLETION_ACTION.test(String(candidate.nextAction ?? ''))) {
      candidate.nextAction = 'gather evidence before any completion claim';
      repairReasons.push('unsafe completion nextAction replaced');
    }
    if (UNSAFE_RECEIPT_ACTION.test(String(candidate.nextAction ?? ''))
      || UNSAFE_RECEIPT_ATTESTATION.test(String(candidate.nextAction ?? ''))) {
      candidate.nextAction = 'continue through the governed runtime for receipt provenance';
      repairReasons.push('unsafe receipt provenance nextAction replaced');
    }
    if (delegatesRouteChoice(candidate.nextAction)) {
      candidate.nextAction = 'run deterministic routing and use an eligible fallback';
      repairReasons.push('operator route-choice burden replaced');
    }
    if (!isCompactDraft) {
      if (draft.schema !== ORANGE_REPORT_SCHEMA) repairReasons.push('schema replaced');
      if (orderId != null && draft.orderId !== orderId) repairReasons.push('orderId replaced from trusted request context');
      if (draft.receiptPath !== null) repairReasons.push('untrusted model receiptPath cleared');
      if (!Array.isArray(draft.actionsTaken)) repairReasons.push('actionsTaken defaulted');
      const extras = Object.keys(draft).filter((key) => !REPORT_KEYS.has(key));
      if (extras.length) repairReasons.push(`unsupported fields removed: ${extras.join(', ')}`);
    }
    const report = validateOrangeReport(candidate, orderId);
    return {
      report,
      repair_applied: repairReasons.length > 0,
      validation_error: repairReasons.length > 0 ? repairReasons.join('; ') : null,
    };
  } catch (error) {
    const descriptor = draft && typeof draft === 'object'
      ? { schema: draft.schema ?? null, keys: Object.keys(draft).sort(), sha256: sha256(JSON.stringify(draft)) }
      : { schema: null, type: typeof draft, sha256: sha256(String(draft)) };
    const repaired = {
      schema: ORANGE_REPORT_SCHEMA,
      orderId,
      status: 'needs_action',
      confidence: 0.5,
      actionsTaken: [],
      evidence: [`model_draft_preserved:${JSON.stringify(descriptor)}`],
      findings: [],
      blockers: ['model draft required deterministic orange.report.v1 schema repair'],
      nextAction: 'continue through the governed operational path',
      receiptPath: null,
    };
    return { report: validateOrangeReport(repaired, orderId), repair_applied: true, validation_error: error.message };
  }
}

export function parseModelDraft(content) {
  if (content && typeof content === 'object') return content;
  if (typeof content !== 'string') return content;
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try { return JSON.parse(candidate); } catch { return content; }
}

export function isOperationalReportDraft(content) {
  const draft = parseModelDraft(content);
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return false;
  if (draft.schema === ORANGE_REPORT_SCHEMA) return true;
  const keys = new Set(Object.keys(draft));
  const longSignals = ['status', 'confidence', 'evidence', 'blockers', 'nextAction'];
  const shortSignals = ['s', 'c', 'e', 'b', 'n'];
  return longSignals.filter((key) => keys.has(key)).length >= 3
    || shortSignals.filter((key) => keys.has(key)).length >= 4;
}

export function orderIdFromMessages(messages = []) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    // Only operator/user input may contribute order identity. Historical
    // assistant and system messages are untrusted model/context material.
    if (messages[i]?.role !== 'user') continue;
    const content = messages[i]?.content;
    if (typeof content !== 'string') continue;
    try {
      const parsed = JSON.parse(content);
      const candidate = parsed?.orderId ?? parsed?.id;
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    } catch {}
  }
  return null;
}

function messageText(messages = []) {
  return messages
    .filter((message) => typeof message?.content === 'string')
    .map((message) => message.content)
    .join('\n');
}

export function explicitEvidenceFromMessages(messages = []) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role !== 'user' || typeof messages[i].content !== 'string') continue;
    try {
      const parsed = JSON.parse(messages[i].content);
      if (!Array.isArray(parsed?.evidence)) return [];
      return parsed.evidence.map((item) => typeof item === 'string' ? item : JSON.stringify(item));
    } catch {
      return [];
    }
  }
  return [];
}

export function classifyEvidenceFidelity(modelEvidence = [], suppliedEvidence = []) {
  if (!Array.isArray(suppliedEvidence) || suppliedEvidence.length === 0) return 'not_supplied';
  if (!Array.isArray(modelEvidence)) return 'mismatch';
  return modelEvidence.length === suppliedEvidence.length
    && modelEvidence.every((item, index) => item === suppliedEvidence[index])
    ? 'exact'
    : 'mismatch';
}

export function validateExplicitEvidencePacket(evidence = []) {
  if (!Array.isArray(evidence)) return { valid: false, reason: 'evidence must be an array' };
  if (evidence.length > ORANGE_REPORT_EVIDENCE_MAX_ITEMS) {
    return { valid: false, reason: `evidence exceeds ${ORANGE_REPORT_EVIDENCE_MAX_ITEMS} items` };
  }
  const oversizedIndex = evidence.findIndex((item) => String(item).length > ORANGE_REPORT_EVIDENCE_MAX_CHARS);
  if (oversizedIndex !== -1) {
    return { valid: false, reason: `evidence[${oversizedIndex}] exceeds ${ORANGE_REPORT_EVIDENCE_MAX_CHARS} characters` };
  }
  return { valid: true, reason: null };
}

export function prepareOperationalRequest(body, orderId = null, { suppliedEvidence = [], evidencePolicy = 'none' } = {}) {
  const contractLines = [
    'Return compact JSON only. Never claim success without supplied evidence.',
    'Private packet keys: s=status, c=confidence, e=evidence, f=findings, b=blockers, n=next action.',
    'Put at least one substantive conclusion in f. Do not hide the requested analysis in n.',
    'If s=completed then b must be empty; if b is nonempty use needs_action or blocked.',
    'Never mention receipt generation or receiptPath in e, b, or n.',
    'Use at most two evidence and blocker items of at most ten words each. Never mention hidden control tokens.',
    'Never ask a caller to claim or declare completion; request evidence or a concrete probe instead.',
    'Never ask for receiptPath or claim a receipt was generated; the governed runtime owns receipt provenance.',
    'Never ask the operator to choose a model, lane, route, or fallback; deterministic routing owns that choice.',
    'If intent is insufficient, use needs_action and ask for a concrete intent.',
  ];
  if (evidencePolicy === 'preserve_exact' && suppliedEvidence.length) {
    contractLines.push('Immutable provenance law: supplied evidence is runtime-owned. Evaluate it, return e=[], and put interpretation only in f.');
    contractLines.push('Bun attaches the exact evidence after inference; never repeat, paraphrase, reorder, add, or remove provenance.');
  } else if (evidencePolicy === 'derive') {
    contractLines.push('Internal refuter protocol: the authenticated user packet contains claim, evidence, and checks. Evaluate that packet directly.');
    contractLines.push('Return exactly one verdict marker in e: REFUTED=true or REFUTED=false. Do not say evidence is absent when the packet evidence field is nonempty.');
    contractLines.push('Use REFUTED=true only for a concrete contradiction, invalid inference, counterexample, or claim-relevant evidence gap.');
    contractLines.push('Use REFUTED=false with s=completed and b=[] when the packet evidence directly supports the bounded claim and no concrete defeater survives.');
  } else if (evidencePolicy === 'none') {
    contractLines.push('No governed evidence was supplied. Return only {"answer":"the substantive answer","nextAction":"one concrete next action"}.');
    contractLines.push('The answer must directly address the request using the supplied Orange context. Do not return labels or identifiers as the answer.');
    contractLines.push('Bun supplies status, confidence, evidence, and blockers. Do not add them.');
  }
  const contractPrompt = contractLines.join('\n');
  const messages = [...(body.messages ?? [])];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user' && typeof messages[index].content === 'string') {
      messages[index] = { ...messages[index], content: `${messages[index].content}\n/no_think` };
      break;
    }
  }
  return {
    ...body,
    // The model emits only the compact decision packet. Bun deterministically
    // compiles the fixed schema, identity, action and receipt fields.
    max_tokens: Math.max(Number(body.max_tokens ?? body.max_completion_tokens ?? 0) || 0, 128),
    messages: [{ role: 'system', content: contractPrompt }, ...messages],
    response_format: {
      type: 'json_schema',
      json_schema: evidencePolicy === 'none'
        ? { name: 'orange_report_no_evidence_draft', strict: true, schema: ORANGE_REPORT_NO_EVIDENCE_JSON_SCHEMA }
        : { name: 'orange_report_draft', strict: true, schema: ORANGE_REPORT_DRAFT_JSON_SCHEMA },
    },
    temperature: 0,
    stream: false,
    ae_compiler_order_id: orderId,
    ae_report_evidence_policy: evidencePolicy,
  };
}

export function compileCompletionEnvelope(envelope, orderId = null, {
  suppliedEvidence = [], evidencePolicy = 'none', requestMessages = [],
} = {}) {
  const choice = envelope?.choices?.[0];
  if (!choice?.message) throw new Error('OrangeBrain completion envelope has no assistant message');
  const compiled = compileOrangeReport(parseModelDraft(choice.message.content), orderId);
  const modelEvidence = [...compiled.report.evidence];
  const modelEvidenceFidelity = classifyEvidenceFidelity(compiled.report.evidence, suppliedEvidence);
  let evidenceFidelity = modelEvidenceFidelity;
  if (evidencePolicy === 'none' && (modelEvidence.length > 0 || compiled.report.status === 'completed')) {
    compiled.report.status = 'needs_action';
    compiled.report.confidence = Math.min(compiled.report.confidence, 0.5);
    compiled.report.evidence = [];
    compiled.report.findings = [...new Set([
      ...(compiled.report.findings || []),
      ...modelEvidence.map((item) => `unverified_model_observation: ${String(item).slice(0, 208)}`),
    ])].slice(0, 3);
    compiled.report.blockers = [...new Set([
      ...compiled.report.blockers,
      'no governed evidence supplied',
    ])];
    compiled.report.nextAction = 'run a governed probe or provide evidence';
    compiled.repair_applied = true;
    compiled.validation_error = [compiled.validation_error, 'model-authored evidence quarantined']
      .filter(Boolean).join('; ');
  }
  if (evidencePolicy === 'preserve_exact' && suppliedEvidence.length) {
    compiled.report.evidence = [...suppliedEvidence];
    evidenceFidelity = 'exact';
    if (modelEvidenceFidelity !== 'exact') {
      compiled.report.findings = [...new Set([
        ...(compiled.report.findings || []),
        ...modelEvidence.map((item) => `unverified_model_observation: ${String(item).slice(0, 208)}`),
      ])].slice(0, 3);
    }
    compiled.repair_applied = true;
    compiled.validation_error = [compiled.validation_error, 'caller evidence attached exactly by runtime']
      .filter(Boolean).join('; ');
  }
  if (evidencePolicy === 'derive') {
    const controlSanitization = sanitizeInternalRefuterReport(compiled.report);
    if (controlSanitization.removed > 0) {
      compiled.repair_applied = true;
      compiled.validation_error = [
        compiled.validation_error,
        `internal control representation removed from refuter semantics (${controlSanitization.removed})`,
      ].filter(Boolean).join('; ');
    }
    const markers = compiled.report.evidence
      .map((item) => String(item).trim().match(/^REFUTED=(true|false)$/i))
      .filter(Boolean);
    if (markers.length === 0) {
      const verdictText = [
        ...(compiled.report.findings || []),
        ...(compiled.report.blockers || []),
        compiled.report.nextAction,
      ].filter(Boolean).join(' ');
      const blockingStatus = ['blocked', 'rejected', 'halted', 'needs_action', 'error'].includes(String(compiled.report.status).toLowerCase());
      const evidenceGap = /\b(?:no|missing|insufficient|absent|unsubstantiated|unsupported)\b.{0,32}\bevidence\b|\bevidence\b.{0,32}\b(?:missing|absent|insufficient)\b/i.test(verdictText);
      const refuted = blockingStatus || evidenceGap;
      compiled.report.evidence = [`REFUTED=${refuted}`];
      if (refuted && compiled.report.status === 'completed') compiled.report.status = 'blocked';
      if (refuted && compiled.report.blockers.length === 0) {
        compiled.report.blockers = ['refuter found claim-relevant missing evidence'];
      }
      compiled.repair_applied = true;
      compiled.validation_error = [compiled.validation_error, 'internal refuter verdict marker compiled deterministically']
        .filter(Boolean).join('; ');
    }
  }
  const requestText = messageText(requestMessages);
  const applyDeterministicRoute = ({ nextAction, finding, reason, blocker = null, status = null }) => {
    if (status) compiled.report.status = status;
    if (blocker) {
      compiled.report.blockers = [...new Set([...(compiled.report.blockers || []), blocker])];
    }
    compiled.report.nextAction = nextAction;
    compiled.report.findings = [...new Set([...(compiled.report.findings || []), finding])].slice(0, 3);
    compiled.repair_applied = true;
    compiled.validation_error = [compiled.validation_error, reason].filter(Boolean).join('; ');
  };
  if (requestText && /\bhealth\b/i.test(requestText)) {
    applyDeterministicRoute({
      nextAction: 'call GET /healthz and inspect its evidence before claiming system status',
      finding: 'deterministic route: GET /healthz',
      reason: 'health request deterministically routed to GET /healthz',
    });
  }
  if (requestText && /\bmemory\b/i.test(requestText)
    && /\b(?:recall|remember|retrieve|search|query|route|state)\b/i.test(requestText)) {
    applyDeterministicRoute({
      nextAction: 'call POST /v1/memory/recall with the project recall query',
      finding: 'deterministic route: POST /v1/memory/recall',
      reason: 'memory recall request deterministically routed to POST /v1/memory/recall',
    });
  }
  if (requestText && /\b(?:image|screenshot|visual|document)\b/i.test(requestText)
    && !/\bAE Eyes\b/i.test(JSON.stringify(compiled.report))) {
    compiled.report.nextAction = 'provide the visual artifact to AE Eyes for governed analysis';
    compiled.report.findings = [...new Set([
      ...(compiled.report.findings || []),
      'deterministic route: AE Eyes',
    ])].slice(0, 3);
    compiled.repair_applied = true;
    compiled.validation_error = [compiled.validation_error, 'visual request deterministically routed to AE Eyes']
      .filter(Boolean).join('; ');
  }
  if (requestText && /\bCodexa\b/i.test(requestText) && /\b(?:down|offline|unreachable|unavailable)\b/i.test(requestText)) {
    applyDeterministicRoute({
      status: 'blocked',
      blocker: 'Codexa unavailable under the requested scenario',
      nextAction: 'continue deterministic N150 Bun control and queue model-dependent work until Codexa reconnects',
      finding: 'deterministic fallback: N150 control only; no local answer model',
      reason: 'Codexa offline scenario deterministically held to the N150 control-only fallback',
    });
  }
  if (requestText && /\b(?:edit|write|modify|patch|change|mutation)\b/i.test(requestText)
    && /\b(?:receipt|proof|evidence|execut|claim)\b/i.test(requestText)
    && evidencePolicy === 'none') {
    compiled.report.status = 'needs_action';
    compiled.report.confidence = Math.min(compiled.report.confidence, 0.5);
    compiled.report.blockers = [...new Set([
      ...(compiled.report.blockers || []),
      'no governed mutation receipt supplied',
    ])];
    compiled.report.nextAction = 'execute through a governed Hermes lease and verify the resulting receipt';
    compiled.report.findings = [...new Set([
      ...(compiled.report.findings || []),
      'mutation was not executed',
    ])].slice(0, 3);
    compiled.repair_applied = true;
    compiled.validation_error = [compiled.validation_error, 'mutation claim deterministically held for receipt proof']
      .filter(Boolean).join('; ');
  }
  choice.message.content = JSON.stringify(compiled.report);
  envelope.ae_response_contract = ORANGE_REPORT_SCHEMA;
  envelope.ae_report_repair_applied = compiled.repair_applied;
  envelope.ae_report_validation_error = compiled.validation_error;
  // A model can complete a cognitive review, but it cannot attest that an
  // operational action executed or that its evidence is independently true.
  // Downstream clients must cross the governed spine for those authorities.
  envelope.ae_execution_performed = false;
  envelope.ae_evidence_authority = evidencePolicy === 'preserve_exact'
    ? 'caller_supplied_exact'
    : (evidencePolicy === 'none' ? 'not_supplied' : 'model_draft_unverified');
  envelope.ae_receipt_authority = 'governed_runtime_only';
  envelope.ae_supplied_evidence_count = suppliedEvidence.length;
  envelope.ae_evidence_policy = evidencePolicy;
  envelope.ae_evidence_fidelity = evidenceFidelity;
  envelope.ae_model_evidence_fidelity = modelEvidenceFidelity;
  envelope.ae_supplied_evidence_sha256 = suppliedEvidence.length ? sha256(JSON.stringify(suppliedEvidence)) : null;
  envelope.ae_model_evidence_sha256 = sha256(JSON.stringify(modelEvidence));
  envelope.ae_model_evidence_discarded_count = evidencePolicy === 'none'
    || (evidencePolicy === 'preserve_exact' && modelEvidenceFidelity !== 'exact')
    ? modelEvidence.length
    : 0;
  return { envelope, ...compiled };
}
