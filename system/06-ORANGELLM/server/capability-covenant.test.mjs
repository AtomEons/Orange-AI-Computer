import { describe, expect, test } from 'bun:test';
import {
  capabilityRepairInstruction,
  classifyCapabilityCovenant,
  enforceCapabilityFailure,
  specialistPolicyFor,
  validateCapabilityOutput,
} from './capability-covenant.mjs';

function envelope(report, metadata = {}) {
  return {
    choices: [{ message: { role: 'assistant', content: JSON.stringify(report) } }],
    ...metadata,
  };
}

describe('Orange capability covenant', () => {
  test('keeps bounded delegation synthesis on the Navigator', () => {
    const covenant = classifyCapabilityCovenant({
      messages: [{ role: 'user', content: JSON.stringify({
        action: 'synthesize.delegation',
        intent: 'Summarize one completed receipt-backed specialist finding.',
        payload: { childEvidence: [{ status: 'completed' }] },
      }) }],
      tier: 'navigator',
    });
    expect(covenant.class).toBe('general');
    expect(covenant.minimumTier).toBe('navigator');
  });

  test('keeps complex architecture synthesis on the heavy covenant', () => {
    const covenant = classifyCapabilityCovenant({
      messages: [{ role: 'user', content: 'Synthesize a complex distributed system architecture and its trade-offs.' }],
      tier: 'heavy',
    });
    expect(covenant.class).toBe('architecture_judge');
    expect(covenant.minimumTier).toBe('heavy');
  });

  test('architecture work earns a non-fallback heavy covenant', () => {
    const covenant = classifyCapabilityCovenant({
      messages: [{ role: 'user', content: 'Review the OrangeFive runtime architecture and trade-offs.' }],
      tier: 'heavy',
    });
    expect(covenant.class).toBe('architecture_judge');
    expect(covenant.minimumTier).toBe('heavy');
    expect(covenant.fallbackAllowed).toBe(false);
    expect(specialistPolicyFor(covenant, 'heavy')).toBe('wait_for_specialist');
  });

  test('rejects an invisible heavy-to-Navigator downgrade', () => {
    const covenant = classifyCapabilityCovenant({
      messages: [{ role: 'user', content: 'Explain the system architecture and root causes.' }],
      tier: 'heavy',
    });
    const verdict = validateCapabilityOutput(envelope({ findings: ['AE Eyes should inspect it.'], blockers: [], nextAction: 'Use AE Eyes.' }), covenant, {
      requestedTier: 'heavy', executionTier: 'navigator', routeMode: 'shared_hot_fallback',
    });
    expect(verdict.valid).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('silently used');
    expect(capabilityRepairInstruction(verdict)).toContain('CAPABILITY COVENANT REPAIR');
  });

  test('accepts substantive architecture coverage on the specialist', () => {
    const covenant = classifyCapabilityCovenant({
      messages: [{ role: 'user', content: 'Review the OrangeFive runtime architecture and trade-offs.' }],
      tier: 'heavy',
    });
    const verdict = validateCapabilityOutput(envelope({
      findings: [
        'The Bun routing gateway keeps deterministic control separate from model inference.',
        'Receipt proof and source-addressed memory prevent false completion while Codexa supplies compute.',
      ],
      blockers: [], nextAction: 'Benchmark the heavy model and memory recall end to end.',
    }), covenant, { requestedTier: 'heavy', executionTier: 'heavy', routeMode: 'specialist' });
    expect(verdict.valid).toBe(true);
    expect(verdict.coverage.length).toBeGreaterThanOrEqual(2);
  });

  test('does not count deterministic boilerplate as architecture findings', () => {
    const covenant = classifyCapabilityCovenant({
      messages: [{ role: 'user', content: 'Review the OrangeFive runtime architecture.' }],
      tier: 'heavy',
    });
    const verdict = validateCapabilityOutput(envelope({
      findings: [
        'unverified_model_observation: model packet hash only',
        'deterministic route: POST /v1/memory/recall',
      ],
      blockers: ['no governed evidence supplied'],
      nextAction: 'call POST /v1/memory/recall with the project recall query',
    }), covenant, { requestedTier: 'heavy', executionTier: 'heavy', routeMode: 'specialist' });
    expect(verdict.valid).toBe(false);
    expect(verdict.reasons).toContain('architecture report has fewer than two substantive findings');
  });

  test('replaces a failed draft with an honest blocked report', () => {
    const payload = envelope({ orderId: 'o-1', findings: [], blockers: [], nextAction: 'Guess.' });
    const verdict = { class: 'architecture_judge', minimumTier: 'heavy', reasons: ['failed semantic proof'] };
    const report = enforceCapabilityFailure(payload, verdict);
    expect(report.status).toBe('blocked');
    expect(report.blockers).toEqual(['failed semantic proof']);
    expect(payload.ae_execution_performed).toBe(false);
  });
});
