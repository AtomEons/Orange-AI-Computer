#!/usr/bin/env bun
import { describe, expect, test } from 'bun:test';
import { applyFailureRecurrenceGuard, handleV1ChatCompletions, isDerivedEvidenceCaller, modelResidencyState, resolveOperationalOrderIdentity } from './v1.mjs';

describe('v1 identity and residency truth', () => {
  test('explicit request identity outranks message content', () => {
    const result = resolveOperationalOrderIdentity({
      ae_order_id: 'explicit-1',
      messages: [{ role: 'user', content: '{"orderId":"user-1"}' }],
    }, () => 'unused');
    expect(result).toEqual({ orderId: 'explicit-1', source: 'explicit_request' });
  });

  test('user order identity is accepted when explicit identity is absent', () => {
    const result = resolveOperationalOrderIdentity({
      messages: [
        { role: 'assistant', content: '{"orderId":"attacker"}' },
        { role: 'user', content: '{"orderId":"user-2"}' },
      ],
    }, () => 'unused');
    expect(result).toEqual({ orderId: 'user-2', source: 'user_order' });
  });

  test('gateway mints identity when no trusted order identity exists', () => {
    const result = resolveOperationalOrderIdentity({
      messages: [{ role: 'assistant', content: '{"orderId":"attacker"}' }],
    }, () => 'fixed-uuid');
    expect(result).toEqual({ orderId: 'gw-order-fixed-uuid', source: 'gateway_minted' });
  });

  test('model residency distinguishes host availability from loaded weights', () => {
    expect(modelResidencyState({ live: true, model_loaded: true })).toBe('warm');
    expect(modelResidencyState({ live: true, model_loaded: false })).toBe('available');
    expect(modelResidencyState({ live: false, model_loaded: false })).toBe('unreachable');
  });

  test('a prior context-pressure failure changes the next workbench before inference', () => {
    const guarded = applyFailureRecurrenceGuard([
      { role: 'system', content: 'Return compact JSON only.\ncontract' },
      { role: 'system', content: 'ORANGE ACTIVE PROJECT LOCK\nroot' },
      { role: 'system', content: 'AIR:PROJECT-CONTINUUM.v1\nlineage' },
      { role: 'system', content: 'AIR:FAILURE-MEMORY.v1\nlesson' },
      { role: 'system', content: 'AIR:CURRENT.v1\nlarge current scan' },
      { role: 'system', content: 'AIR:MEMORY.v1\nlarge recalled history' },
      { role: 'user', content: 'current request' },
    ], {
      active: true,
      patterns: [{ failureClass: 'context_pressure' }],
      recommendedAction: 'Use a smaller source-addressed workset.',
    });
    expect(guarded.meta.applied).toBe(true);
    expect(guarded.meta.dropped_frames).toEqual(['current-awareness', 'recalled-memory']);
    expect(guarded.messages.map((message) => message.content)).toContain('current request');
    expect(guarded.messages.some((message) => message.content.includes('ORANGE ACTIVE PROJECT LOCK'))).toBe(true);
    expect(guarded.messages.some((message) => message.content.includes('AIR:FAILURE-MEMORY.v1'))).toBe(true);
  });

  test('derive evidence is reserved for the explicit internal refuter protocol', () => {
    const valid = { messages: [{ role: 'user', content: '{"role":"falsifier","evidence":["claim"]}' }] };
    expect(isDerivedEvidenceCaller(valid, 'order-1:refuter')).toBe(true);
    expect(isDerivedEvidenceCaller(valid, 'order-1')).toBe(false);
    expect(isDerivedEvidenceCaller({ messages: [{ role: 'user', content: '{"role":"builder"}' }] }, 'order-1:refuter')).toBe(false);
    expect(isDerivedEvidenceCaller({ messages: [{ role: 'assistant', content: '{"role":"falsifier"}' }] }, 'order-1:refuter')).toBe(false);
  });

  test('keeps the refuter contract but isolates hidden product doctrine before inference', async () => {
    let inferenceBody = null;
    const response = await handleV1ChatCompletions({
      model: 'orange-navigator',
      ae_response_contract: 'orange.report.v1',
      ae_evidence_policy: 'derive',
      ae_order_id: 'order-isolated:refuter',
      messages: [
        { role: 'system', content: 'You are the independent Orange refuter.' },
        { role: 'user', content: '{"role":"falsifier","claim":"probe passed","evidence":["probe:ok"]}' },
      ],
    }, {
      proxyChatCompletions: async (body) => {
        inferenceBody = structuredClone(body);
        return { status: 200, body: { choices: [{ message: { role: 'assistant', content: JSON.stringify({
          s: 'completed', c: 1, e: ['REFUTED=false'],
          f: ['The supplied probe directly supports the bounded claim.'], b: [], n: 'continue',
        }) }, finish_reason: 'stop' }] } };
      },
    });
    expect(response._ae_http_status ?? 200).toBe(200);
    const prompt = JSON.stringify(inferenceBody?.messages || []);
    expect(prompt).toContain('Internal refuter protocol');
    expect(prompt).not.toContain('ORANGE5_GATEWAY_DOCTRINE_V1');
  });

  test('explicit evidence cannot downgrade preservation to none', async () => {
    const response = await handleV1ChatCompletions({
      model: 'orange-navigator',
      ae_response_contract: 'orange.report.v1',
      ae_evidence_policy: 'none',
      messages: [{ role: 'user', content: '{"orderId":"proof-1","evidence":["probe green"]}' }],
    });
    expect(response._ae_http_status).toBe(400);
    expect(response.error.code).toBe('evidence_policy_downgrade_forbidden');
  });

  test('evidence policy is rejected outside the operational report contract', async () => {
    const response = await handleV1ChatCompletions({
      model: 'orange-navigator',
      ae_evidence_policy: 'none',
      messages: [{ role: 'user', content: 'ordinary chat' }],
    });
    expect(response._ae_http_status).toBe(400);
    expect(response.error.code).toBe('evidence_policy_requires_report_contract');
  });

  test('preserve exact requires explicit evidence', async () => {
    const response = await handleV1ChatCompletions({
      model: 'orange-navigator',
      ae_response_contract: 'orange.report.v1',
      ae_evidence_policy: 'preserve_exact',
      messages: [{ role: 'user', content: '{"orderId":"proof-2"}' }],
    });
    expect(response._ae_http_status).toBe(400);
    expect(response.error.code).toBe('preserve_exact_requires_evidence');
  });

  test('oversized preserve-exact evidence fails before model routing', async () => {
    const tooMany = await handleV1ChatCompletions({
      model: 'orange-navigator',
      ae_response_contract: 'orange.report.v1',
      messages: [{ role: 'user', content: JSON.stringify({ orderId: 'proof-3', evidence: ['a', 'b', 'c'] }) }],
    });
    expect(tooMany._ae_http_status).toBe(413);
    expect(tooMany.error.code).toBe('evidence_packet_budget_exceeded');
    const tooLong = await handleV1ChatCompletions({
      model: 'orange-navigator',
      ae_response_contract: 'orange.report.v1',
      messages: [{ role: 'user', content: JSON.stringify({ orderId: 'proof-4', evidence: ['x'.repeat(97)] }) }],
    });
    expect(tooLong._ae_http_status).toBe(413);
    expect(tooLong.error.code).toBe('evidence_packet_budget_exceeded');
  });

  test('canonical Orange truth uses the governed Navigator Kernel and avoids inference', async () => {
    let modelCalls = 0;
    const response = await handleV1ChatCompletions({
      model: 'orange-auto',
      ae_response_mode: 'conversation',
      ae_party_line: { enabled: false },
      messages: [{
        role: 'user',
        content: 'Explain how Orange preserves project memory and sends heavy model work to Codexa. Name AE Phase and distinguish source truth from hot context.',
      }],
    }, {
      proxyChatCompletions: async () => {
        modelCalls += 1;
        throw new Error('canonical truth must not lease a model');
      },
    });

    expect(response._ae_http_status ?? 200).toBe(200);
    expect(modelCalls).toBe(0);
    expect(response.ae_route_mode).toBe('navigator_kernel');
    expect(response.ae_turn.route.execution_tier).toBe('navigator_kernel');
    expect(response.ae_turn.route.effective_model).toBe('bun-navigator-kernel');
    expect(response.choices[0].message.content).toContain('AE Phase');
    expect(response.choices[0].message.content).toContain('hot context');
  });

  test('open-ended Orange architecture work still reaches a model', async () => {
    let modelCalls = 0;
    const response = await handleV1ChatCompletions({
      model: 'orange-auto',
      ae_response_mode: 'conversation',
      ae_party_line: { enabled: false },
      messages: [{ role: 'user', content: 'How should we improve AE Phase and hot context for the next architecture?' }],
    }, {
      proxyChatCompletions: async () => {
        modelCalls += 1;
        return {
          status: 200,
          body: {
            model: 'test-navigator',
            choices: [{ index: 0, message: { role: 'assistant', content: 'Use measured constraints and preserve authority.' }, finish_reason: 'stop' }],
          },
        };
      },
    });

    expect(response._ae_http_status ?? 200).toBe(200);
    expect(modelCalls).toBe(1);
    expect(response.ae_route_mode).not.toBe('navigator_kernel');
    expect(response.choices[0].message.content).toBe('Use measured constraints and preserve authority.');
  });
});
