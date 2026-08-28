#!/usr/bin/env bun
import { describe, expect, test } from 'bun:test';
import {
  compileCompletionEnvelope,
  compileOrangeReport,
  isOperationalReportDraft,
  parseModelDraft,
  explicitEvidenceFromMessages,
  validateExplicitEvidencePacket,
  orderIdFromMessages,
  prepareOperationalRequest,
  validateOrangeReport,
} from '../contracts/orange-report.mjs';

const valid = {
  schema: 'orange.report.v1', orderId: 'ord-1', status: 'needs_action', confidence: 0.8, actionsTaken: [], evidence: [],
  blockers: ['waiting for governed execution'], nextAction: 'execute through Hermes', receiptPath: null,
};

describe('shared Orange operational report contract', () => {
  test('recognizes and parses fenced operational JSON without treating prose as a report', () => {
    const fenced = '```json\n{"schema":"orange.report.v1","status":"completed","confidence":1,"evidence":[],"blockers":[],"nextAction":"done"}\n```';
    expect(isOperationalReportDraft(fenced)).toBe(true);
    expect(parseModelDraft(fenced).schema).toBe('orange.report.v1');
    expect(isOperationalReportDraft('ordinary useful chat response')).toBe(false);
  });

  test('quarantines string evidence as an unverified finding', () => {
    const out = compileOrangeReport({
      schema: 'orange.report.v1', orderId: 'fake', status: 'completed', confidence: 1,
      actionsTaken: [], evidence: 'memory-shaped model claim', blockers: [], nextAction: 'done', receiptPath: 'fake.txt',
    }, 'real-order');
    expect(out.report.orderId).toBe('real-order');
    expect(out.report.evidence).toEqual([]);
    expect(out.report.findings).toEqual(['memory-shaped model claim']);
    expect(out.report.receiptPath).toBeNull();
    expect(out.report.status).not.toBe('completed');
  });

  test('preserves a valid report without repair', () => {
    const out = compileOrangeReport(valid, 'ord-1');
    expect(out.repair_applied).toBe(false);
    expect(out.report.schema).toBe('orange.report.v1');
    expect(out.report.orderId).toBe('ord-1');
  });

  test('repairs echoed orders and records draft identity', () => {
    const out = compileOrangeReport({ schema: 'orange.order.v1', orderId: 'ord-2' }, 'ord-2');
    expect(out.repair_applied).toBe(true);
    expect(out.report.status).toBe('needs_action');
    expect(out.report.evidence[0]).toContain('model_draft_preserved:');
    expect(out.report.evidence[0]).toMatch(/[a-f0-9]{64}/);
  });

  test('refuses evidence-free false green', () => {
    expect(() => validateOrangeReport({ ...valid, orderId: 'ord-3', status: 'completed', blockers: [], evidence: [] }, 'ord-3')).toThrow('requires evidence');
  });

  test('replaces hallucinated order identity and receipt provenance without discarding valid work', () => {
    const out = compileOrangeReport({
      ...valid,
      orderId: 'truncated-order',
      status: 'completed',
      evidence: ['receipt-backed observation'],
      blockers: [],
      receiptPath: 'qwen2.5-coder:32b',
    }, 'ord-real');
    expect(out.repair_applied).toBe(true);
    expect(out.validation_error).toContain('orderId replaced');
    expect(out.validation_error).toContain('receiptPath cleared');
    expect(out.report.orderId).toBe('ord-real');
    expect(out.report.receiptPath).toBeNull();
    expect(out.report.status).toBe('completed');
  });

  test('rejects unknown status and non-string evidence into needs_action', () => {
    const out = compileOrangeReport({ ...valid, status: 'probably_green', evidence: [{ claim: 'no' }] }, 'ord-1');
    expect(out.repair_applied).toBe(true);
    expect(out.report.status).toBe('needs_action');
    expect(out.report.blockers).not.toHaveLength(0);
  });

  test('compiles an OpenAI envelope in place', () => {
    const envelope = { choices: [{ message: { role: 'assistant', content: JSON.stringify({ schema: 'orange.order.v1' }) } }] };
    const out = compileCompletionEnvelope(envelope, 'ord-4');
    expect(out.envelope.ae_response_contract).toBe('orange.report.v1');
    expect(out.envelope.ae_report_repair_applied).toBe(true);
    expect(out.envelope.ae_execution_performed).toBe(false);
    expect(out.envelope.ae_evidence_authority).toBe('not_supplied');
    expect(out.envelope.ae_receipt_authority).toBe('governed_runtime_only');
    expect(JSON.parse(out.envelope.choices[0].message.content).orderId).toBe('ord-4');
  });

  test('deterministically routes visual requests to AE Eyes', () => {
    const envelope = { choices: [{ message: { role: 'assistant', content: JSON.stringify({
      s: 'needs_action', c: 0.8, e: [], b: ['no screenshot supplied'], n: 'provide a screenshot',
    }) } }] };
    const out = compileCompletionEnvelope(envelope, 'ord-eyes', {
      requestMessages: [{ role: 'user', content: 'Route this screenshot understanding request.' }],
    });
    expect(out.report.nextAction).toContain('AE Eyes');
    expect(out.report.findings).toContain('deterministic route: AE Eyes');
    expect(out.validation_error).toContain('visual request deterministically routed to AE Eyes');
  });

  test('deterministically routes health and memory questions to real gateway contracts', () => {
    const draft = () => ({ choices: [{ message: { role: 'assistant', content: JSON.stringify({
      s: 'needs_action', c: 0.8, e: [], b: [], n: 'guess a route',
    }) } }] });
    const health = compileCompletionEnvelope(draft(), 'ord-health', {
      requestMessages: [{ role: 'user', content: 'Report the OrangeFive health route.' }],
    });
    expect(health.report.nextAction).toContain('GET /healthz');
    expect(health.report.findings).toContain('deterministic route: GET /healthz');

    const memory = compileCompletionEnvelope(draft(), 'ord-memory', {
      requestMessages: [{ role: 'user', content: 'Which OrangeFive memory route handles project recall?' }],
    });
    expect(memory.report.nextAction).toContain('POST /v1/memory/recall');
    expect(memory.report.findings).toContain('deterministic route: POST /v1/memory/recall');

    const architecture = compileCompletionEnvelope(draft(), 'ord-architecture', {
      requestMessages: [{ role: 'user', content: 'Review project architecture across runtime, memory, and proof.' }],
    });
    expect(architecture.report.nextAction).not.toContain('POST /v1/memory/recall');
  });

  test('deterministically holds a Codexa-offline scenario to N150 control only', () => {
    const envelope = { choices: [{ message: { role: 'assistant', content: JSON.stringify({
      s: 'needs_action', c: 0.9, e: [], b: [], n: 'use AE Eyes',
    }) } }] };
    const out = compileCompletionEnvelope(envelope, 'ord-offline', {
      requestMessages: [{ role: 'user', content: 'Assume Codexa is unreachable. State the honest fallback.' }],
    });
    expect(out.report.status).toBe('blocked');
    expect(out.report.nextAction).toContain('N150 Bun control');
    expect(out.report.nextAction).not.toContain('AE Eyes');
    expect(out.report.findings).toContain('deterministic fallback: N150 control only; no local answer model');
  });

  test('deterministically holds mutation claims for governed receipt proof', () => {
    const envelope = { choices: [{ message: { role: 'assistant', content: JSON.stringify({
      s: 'needs_action', c: 0.8, e: [], b: [], n: 'continue',
    }) } }] };
    const out = compileCompletionEnvelope(envelope, 'ord-mutation', {
      requestMessages: [{ role: 'user', content: 'Plan a source edit, but do not claim any file changed without a governed execution receipt.' }],
    });
    expect(out.report.status).toBe('needs_action');
    expect(out.report.blockers).toContain('no governed mutation receipt supplied');
    expect(out.report.nextAction).toContain('Hermes lease');
    expect(out.report.findings).toContain('mutation was not executed');
  });

  test('never lets model-authored evidence support completion', () => {
    const envelope = { choices: [{ message: { role: 'assistant', content: JSON.stringify({
      status: 'completed', confidence: 0.9, evidence: ['REFUTED=false'], blockers: [], nextAction: 'continue',
    }) } }] };
    const out = compileCompletionEnvelope(envelope, 'ord-cognitive-complete');
    const report = JSON.parse(out.envelope.choices[0].message.content);
    expect(report.status).toBe('needs_action');
    expect(report.evidence).toEqual([]);
    expect(report.findings).toContain('unverified_model_observation: REFUTED=false');
    expect(report.blockers).toContain('no governed evidence supplied');
    expect(out.envelope.ae_report_validation_error).toContain('model-authored evidence quarantined');
    expect(out.envelope.ae_execution_performed).toBe(false);
    expect(out.envelope.ae_evidence_authority).toBe('not_supplied');
    expect(out.envelope.ae_model_evidence_discarded_count).toBe(1);
  });

  test('binds caller evidence exactly without making the model copy provenance', () => {
    const draft = (evidence) => ({ choices: [{ message: { role: 'assistant', content: JSON.stringify({
      status: 'completed', confidence: 0.9, evidence, blockers: [], nextAction: 'continue',
    }) } }] });
    const suppliedEvidence = ['health endpoint returned ok', 'verifier passed 138/138'];
    const exact = compileCompletionEnvelope(draft([...suppliedEvidence]), 'ord-exact', { suppliedEvidence, evidencePolicy: 'preserve_exact' });
    expect(exact.envelope.ae_evidence_fidelity).toBe('exact');
    expect(exact.envelope.ae_evidence_policy).toBe('preserve_exact');
    expect(exact.envelope.ae_evidence_authority).toBe('caller_supplied_exact');
    expect(exact.report.status).toBe('completed');
    expect(exact.envelope.ae_supplied_evidence_count).toBe(2);
    expect(exact.envelope.ae_supplied_evidence_sha256).toMatch(/^[a-f0-9]{64}$/);
    const drift = compileCompletionEnvelope(draft(['health endpoint returned ok', 'verifier passed 1:138']), 'ord-drift', { suppliedEvidence, evidencePolicy: 'preserve_exact' });
    expect(drift.envelope.ae_evidence_fidelity).toBe('exact');
    expect(drift.envelope.ae_model_evidence_fidelity).toBe('mismatch');
    expect(drift.envelope.ae_model_evidence_sha256).not.toBe(drift.envelope.ae_supplied_evidence_sha256);
    expect(drift.report.status).toBe('completed');
    expect(drift.report.evidence).toEqual(suppliedEvidence);
    expect(drift.report.blockers).toEqual([]);
    expect(drift.validation_error).toContain('caller evidence attached exactly by runtime');
    expect(drift.envelope.ae_model_evidence_discarded_count).toBe(2);
    const derived = compileCompletionEnvelope(draft(['REFUTED=false']), 'ord-derived', { suppliedEvidence, evidencePolicy: 'derive' });
    expect(derived.envelope.ae_evidence_fidelity).toBe('mismatch');
    expect(derived.report.status).toBe('completed');
    expect(derived.envelope.ae_evidence_policy).toBe('derive');
  });

  test('deterministically compiles a markerless internal refuter verdict', () => {
    const envelope = { choices: [{ message: { role: 'assistant', content: JSON.stringify({
      status: 'completed', confidence: 0.9, evidence: ['model prose instead of marker'],
      findings: ['The supplied packet supports the bounded claim.'], blockers: [], nextAction: 'continue',
    }) } }] };
    const out = compileCompletionEnvelope(envelope, 'ord-refuter:refuter', {
      suppliedEvidence: ['receipt-backed packet'], evidencePolicy: 'derive',
    });
    expect(out.report.status).toBe('completed');
    expect(out.report.evidence).toEqual(['REFUTED=false']);
    expect(out.validation_error).toContain('verdict marker compiled deterministically');

    const missing = { choices: [{ message: { role: 'assistant', content: JSON.stringify({
      status: 'completed', confidence: 0.7, evidence: ['model prose instead of marker'],
      findings: ['The claim is unsubstantiated because evidence is missing.'], blockers: [], nextAction: 'provide evidence',
    }) } }] };
    const blocked = compileCompletionEnvelope(missing, 'ord-refuter-gap:refuter', {
      suppliedEvidence: ['partial packet'], evidencePolicy: 'derive',
    });
    expect(blocked.report.status).toBe('blocked');
    expect(blocked.report.evidence).toEqual(['REFUTED=true']);
    expect(blocked.report.blockers).toContain('refuter found claim-relevant missing evidence');
  });

  test('treats internal control leakage as protocol repair, not a semantic objection', () => {
    const envelope = { choices: [{ message: { role: 'assistant', content: JSON.stringify({
      s: 'blocked', c: 0.9, e: ['REFUTED=true'],
      f: ['ORANGE refuter verdict'], b: ['$ORANGE5_GATEWAY_DOCTRINE_V1'], n: 'orange.report.v1',
    }) } }] };
    const out = compileCompletionEnvelope(envelope, 'ord-control-leak:refuter', {
      suppliedEvidence: ['probe:ok'], evidencePolicy: 'derive',
    });
    expect(out.report.blockers).toEqual(['model draft required deterministic orange.report.v1 schema repair']);
    expect(JSON.stringify(out.report)).not.toContain('ORANGE5_GATEWAY_DOCTRINE_V1');
    expect(out.validation_error).toContain('internal control representation removed');
  });

  test('keeps a concrete refuter blocker while removing adjacent control leakage', () => {
    const envelope = { choices: [{ message: { role: 'assistant', content: JSON.stringify({
      s: 'blocked', c: 0.9, e: ['REFUTED=true'],
      f: ['$ORANGE5_GATEWAY_DOCTRINE_V1'],
      b: ['source hash does not match', 'orange.report.v1'],
      n: '$ORANGE5_GATEWAY_DOCTRINE_V1',
    }) } }] };
    const out = compileCompletionEnvelope(envelope, 'ord-real-blocker:refuter', {
      suppliedEvidence: ['source:hash'], evidencePolicy: 'derive',
    });
    expect(out.report.blockers).toEqual(['source hash does not match']);
    expect(out.report.nextAction).toBe('verify the concrete blocker against supplied evidence');
    expect(JSON.stringify(out.report)).not.toContain('ORANGE5_GATEWAY_DOCTRINE_V1');
  });

  test('compiles the compact inference packet without treating deterministic fields as repair', () => {
    const out = compileOrangeReport({
      s: 'needs_action', c: 0.9, e: [],
      b: ['missing runtime evidence'], n: 'run health probe',
    }, 'ord-compact');
    expect(out.repair_applied).toBe(false);
    expect(out.report).toEqual({
      schema: 'orange.report.v1', orderId: 'ord-compact', status: 'needs_action', confidence: 0.9,
      actionsTaken: [], evidence: [], findings: [], blockers: ['missing runtime evidence'],
      nextAction: 'run health probe', receiptPath: null,
    });
  });

  test('compiles the descriptive evidence-free packet without repair', () => {
    const result = compileOrangeReport({
      answer: 'Operational claims require governed evidence before they can be called complete.',
      nextAction: 'Run a governed probe',
    }, 'ord-none');
    expect(result.repair_applied).toBe(false);
    expect(result.report).toMatchObject({
      schema: 'orange.report.v1',
      orderId: 'ord-none',
      status: 'needs_action',
      confidence: 0.5,
      evidence: [],
      findings: ['Operational claims require governed evidence before they can be called complete.'],
      blockers: ['no governed evidence supplied'],
      nextAction: 'Run a governed probe',
    });
  });

  test('keeps legacy two-field packets readable during upgrade', () => {
    const result = compileOrangeReport({ f: ['Evidence is required'], n: 'Run a governed probe' }, 'ord-legacy-none');
    expect(result.repair_applied).toBe(false);
    expect(result.report.findings).toEqual(['Evidence is required']);
  });

  test('repairs a false-green next action even when the report status is honest', () => {
    const out = compileOrangeReport({
      status: 'needs_action', confidence: 0.95, evidence: [], blockers: ['missing proof'],
      nextAction: 'Claim system completion status',
    }, 'ord-false-green-action');
    expect(out.repair_applied).toBe(true);
    expect(out.validation_error).toContain('unsafe completion nextAction replaced');
    expect(out.report.nextAction).toBe('gather evidence before any completion claim');
  });

  test('keeps receipt provenance inside the governed runtime', () => {
    const out = compileOrangeReport({
      status: 'needs_action', confidence: 0.8, evidence: [], blockers: ['waiting'],
      nextAction: 'Provide receiptPath to proceed',
    }, 'ord-receipt-action');
    expect(out.repair_applied).toBe(true);
    expect(out.validation_error).toContain('unsafe receipt provenance nextAction replaced');
    expect(out.report.nextAction).toBe('continue through the governed runtime for receipt provenance');
  });

  test('rejects receipt provenance instructions across API-style casing', () => {
    const out = compileOrangeReport({
      status: 'needs_action', confidence: 0.8, evidence: [], blockers: ['waiting'],
      nextAction: 'request_receiptPath',
    }, 'ord-receipt-casing');
    expect(out.repair_applied).toBe(true);
    expect(out.report.nextAction).toBe('continue through the governed runtime for receipt provenance');
  });

  test('rejects model claims that a governed receipt already exists', () => {
    for (const nextAction of ['receipt generated via Hermes', 'Emitted receipt for the completed review']) {
      const out = compileOrangeReport({
        status: 'completed', confidence: 0.9, evidence: ['cognitive review finished'], blockers: [], nextAction,
      }, 'ord-fake-receipt');
      expect(out.repair_applied).toBe(true);
      expect(out.validation_error).toContain('unsafe receipt provenance nextAction replaced');
      expect(out.report.nextAction).toBe('continue through the governed runtime for receipt provenance');
    }
  });

  test('does not push fallback selection back onto the operator', () => {
    for (const nextAction of [
      'Request explicit fallback path from user',
      'Ask the operator which model route to use',
    ]) {
      const out = compileOrangeReport({
        status: 'needs_action', confidence: 0.8, evidence: [], blockers: ['primary unavailable'], nextAction,
      }, 'ord-route-burden');
      expect(out.repair_applied).toBe(true);
      expect(out.validation_error).toContain('operator route-choice burden replaced');
      expect(out.report.nextAction).toBe('run deterministic routing and use an eligible fallback');
    }
  });

  test('preserves genuine approval and missing-intent requests', () => {
    for (const nextAction of ['Request approval for destructive action', 'Ask the operator for a concrete intent']) {
      const out = compileOrangeReport({
        status: 'needs_action', confidence: 0.8, evidence: [], blockers: ['input required'], nextAction,
      }, 'ord-legitimate-question');
      expect(out.repair_applied).toBe(false);
      expect(out.report.nextAction).toBe(nextAction);
    }
  });

  test('extracts order identity from the latest JSON message', () => {
    expect(orderIdFromMessages([{ role: 'user', content: '{"orderId":"ord-5"}' }])).toBe('ord-5');
  });

  test('never trusts assistant or system history for order identity', () => {
    expect(orderIdFromMessages([
      { role: 'system', content: '{"orderId":"system-injection"}' },
      { role: 'assistant', content: '{"orderId":"assistant-injection"}' },
      { role: 'user', content: 'ordinary request' },
    ])).toBeNull();
  });

  test('extracts explicit evidence only from the latest user JSON order', () => {
    expect(explicitEvidenceFromMessages([
      { role: 'system', content: '{"evidence":["system"]}' },
      { role: 'assistant', content: '{"evidence":["assistant"]}' },
      { role: 'user', content: '{"evidence":["one",7,{"probe":"ok"},"two"]}' },
    ])).toEqual(['one', '7', '{"probe":"ok"}', 'two']);
    expect(explicitEvidenceFromMessages([{ role: 'user', content: 'plain text' }])).toEqual([]);
  });

  test('matches explicit evidence limits to the compact model packet', () => {
    expect(validateExplicitEvidencePacket(['a', 'b'.repeat(96)])).toEqual({ valid: true, reason: null });
    expect(validateExplicitEvidencePacket(['a', 'b', 'c'])).toEqual({ valid: false, reason: 'evidence exceeds 2 items' });
    expect(validateExplicitEvidencePacket(['a'.repeat(97)])).toEqual({ valid: false, reason: 'evidence[0] exceeds 96 characters' });
  });

  test('prepares native JSON Schema constrained inference', () => {
    const suppliedEvidence = ['source:one', 'source:two'];
    const prepared = prepareOperationalRequest({ messages: [{ role: 'user', content: '{}' }], temperature: 0.9, stream: true }, 'ord-6', { suppliedEvidence, evidencePolicy: 'preserve_exact' });
    expect(prepared.response_format.type).toBe('json_schema');
    expect(prepared.response_format.json_schema.strict).toBe(true);
    expect(prepared.response_format.json_schema.schema.required).toContain('f');
    expect(prepared.response_format.json_schema.schema.properties.f.minItems).toBe(1);
    expect(prepared.response_format.json_schema.schema.properties.n.minLength).toBe(1);
    expect(prepared.response_format.json_schema.schema.properties.n.maxLength).toBe(96);
    expect(prepared.response_format.json_schema.schema.properties.receiptPath).toBeUndefined();
    expect(prepared.response_format.json_schema.schema.properties.f.maxItems).toBe(3);
    expect(prepared.max_tokens).toBe(128);
    expect(prepared.messages[0].role).toBe('system');
    expect(prepared.messages[0].content).toContain('return e=[]');
    expect(prepared.messages[0].content).not.toContain(JSON.stringify(suppliedEvidence));
    expect(prepared.temperature).toBe(0);
    expect(prepared.stream).toBe(false);
  });
});
