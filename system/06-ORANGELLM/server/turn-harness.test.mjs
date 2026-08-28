import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';
import { __turnHarnessInternals, finalizeChatTurn, fitMessagesToBudget, prepareChatTurn, stabilizeLeadingSystemFrames } from './turn-harness.mjs';

describe('OrangeBrain mandatory chat harness', () => {
  test('classifies mutation language without trusting completion claims', () => {
    expect(__turnHarnessInternals.executionRequested('fix the build and deploy it')).toBe(true);
    expect(__turnHarnessInternals.executionRequested('explain the build architecture')).toBe(false);
  });

  test('mints a compact order without raw prompt in its receipt payload', async () => {
    const turn = await prepareChatTurn({ model: 'orange-auto', messages: [{ role: 'user', content: 'explain OrangeFive' }] }, 'order-test-1');
    expect(turn.order.schema).toBe('orange.order.v1');
    expect(turn.order.action).toBe('query.chat');
    expect(turn.order.payload.message_sha256).toHaveLength(64);
    expect(JSON.stringify(turn.order.payload)).not.toContain('explain OrangeFive');
  });

  test('injects fresh bounded awareness before a technical build turn', async () => {
    const turn = await prepareChatTurn({ model: 'orange-auto', messages: [{ role: 'user', content: 'build a new MCP tool' }] }, 'order-aware-1', {
      awarenessRunner: async () => ({
        status: 'CURRENT_EVIDENCE_READY', sourceCount: 2, cacheHit: false, generatedAt: '2026-08-25T10:00:00Z', expiresAt: '2026-08-25T16:00:00Z', sha256: 'a'.repeat(64),
        brief: 'AIR:CURRENT.v1\nC: current tool evidence', opportunities: [{ title: 'tool', url: 'https://github.com/lab/tool', score: 0.9, nextGate: 'BENCHMARK_REQUIRED' }], compression: { savedBytes: 100 }, errors: [],
      }),
    });
    expect(turn.awareness.status).toBe('CURRENT_EVIDENCE_READY');
    expect(turn.order.payload.current_awareness_sources).toBe(2);
    expect(turn.body.messages.some((message) => String(message.content).includes('AIR:CURRENT.v1'))).toBe(true);
  });

  test('does not spend a scout on nontechnical conversation', async () => {
    let calls = 0;
    const turn = await prepareChatTurn({ model: 'orange-auto', messages: [{ role: 'user', content: 'hello Orange' }] }, 'order-aware-2', { awarenessRunner: async () => { calls++; } });
    expect(calls).toBe(0);
    expect(turn.awareness.status).toBe('NOT_NEEDED');
  });

  test('does not rescout internal child orders carrying research evidence', async () => {
    let calls = 0;
    for (const action of ['analyze.agent', 'synthesize.delegation']) {
      const childOrder = {
        action,
        intent: 'researcher evaluates the latest research evidence already supplied by AE2',
        payload: {
          researchEvidence: {
            sha256: 'a'.repeat(64),
            sourceCount: 1,
            sources: [{ provider: 'arxiv', url: 'https://arxiv.org/abs/2608.00001' }],
          },
        },
      };
      const turn = await prepareChatTurn({
        model: 'orange-auto',
        messages: [{ role: 'user', content: JSON.stringify(childOrder) }],
      }, `order-inherited-research-${action}`, { awarenessRunner: async () => { calls++; } });
      expect(turn.awareness).toMatchObject({
        triggered: false,
        status: 'INHERITED_RESEARCH_EVIDENCE',
        sourceCount: 0,
        inheritedSourceCount: 1,
        inheritedEvidenceSha256: 'a'.repeat(64),
      });
      expect(turn.order.payload.current_awareness_sources).toBe(0);
    }
    expect(calls).toBe(0);
  });

  test('injects existing project lineage before a duplicate-sensitive turn', async () => {
    const turn = await prepareChatTurn({
      model: 'orange-auto',
      messages: [{ role: 'user', content: 'train a new Orange Navigator LoRA on Kaggle' }],
    }, 'order-continuity-1', {
      continuityRunner: () => ({
        available: true,
        stale: false,
        duplicate_sensitive: true,
        existing_lineage_found: true,
        training_lineage_found: true,
        training_paths: ['16-TRAINING/adapters/orange-navigator/README.md'],
        hits: [{
          path: '16-TRAINING/adapters/orange-navigator/README.md',
          category: 'training_lineage',
          source_hash: 'b'.repeat(64),
          excerpt: 'The Orange Navigator compliance adapter is already trained.',
        }],
      }),
      awarenessRunner: async () => ({ status: 'NOT_NEEDED', sourceCount: 0, cacheHit: false, brief: '', opportunities: [], compression: null, errors: [] }),
    });
    expect(turn.order.payload.existing_lineage_found).toBe(true);
    expect(turn.continuity.training_lineage_found).toBe(true);
    expect(turn.body.messages.some((message) => String(message.content).includes('AIR:PROJECT-CONTINUUM.v1'))).toBe(true);
  });

  test('injects a prior failure lesson before routing the same work class', async () => {
    const turn = await prepareChatTurn({
      model: 'orange-auto',
      messages: [{ role: 'user', content: 'fix the TypeScript code and run its unit test' }],
    }, 'order-failure-memory-1', {
      failureRunner: (action) => ({
        action,
        count: 2,
        mistakes: [{ hash: 'f'.repeat(64), summary: 'context exceeded the specialist budget' }],
        patterns: [{ failureClass: 'context_pressure', count: 2, repair: 'Use a smaller source-addressed workset.' }],
        recommendedAction: 'Use a smaller source-addressed workset.',
      }),
      awarenessRunner: async () => ({ status: 'NOT_NEEDED', sourceCount: 0, cacheHit: false, brief: '', opportunities: [], compression: null, errors: [] }),
    });
    expect(turn.order.action).toBe('query.code');
    expect(turn.failure).toMatchObject({ active: true, count: 2, recommendedAction: 'Use a smaller source-addressed workset.' });
    expect(turn.order.payload.prior_failure_classes).toEqual(['context_pressure']);
    expect(turn.body.messages.some((message) => String(message.content).includes('AIR:FAILURE-MEMORY.v1'))).toBe(true);
  });

  test('records a closed failure episode without reinjecting stale failure text', async () => {
    const turn = await prepareChatTurn({
      model: 'orange-auto',
      messages: [{ role: 'user', content: 'fix the TypeScript code and run its unit test' }],
    }, 'order-failure-memory-closed', {
      failureRunner: () => ({
        action: 'query.code',
        count: 0,
        mistakes: [],
        patterns: [],
        resolved_count: 3,
        last_resolution_at: '2026-08-26T18:00:00.000Z',
        last_resolution_disposition: 'success',
        recommendedAction: null,
      }),
      awarenessRunner: async () => ({ status: 'NOT_NEEDED', sourceCount: 0, cacheHit: false, brief: '', opportunities: [], compression: null, errors: [] }),
    });
    expect(turn.failure).toMatchObject({ active: false, count: 0, resolvedCount: 3, lastResolutionDisposition: 'success' });
    expect(turn.order.payload.resolved_failure_count).toBe(3);
    expect(turn.body.messages.some((message) => String(message.content).includes('AIR:FAILURE-MEMORY.v1'))).toBe(false);
  });

  test('treats the validated internal refuter as the terminal verification pass', async () => {
    const turn = await prepareChatTurn({
      model: 'orange-navigator',
      messages: [{ role: 'user', content: JSON.stringify({ role: 'falsifier', checks: ['verify claim'] }) }],
    }, 'order-refuter-1:refuter', { internalRefuter: true });
    expect(turn.order.payload.internal_refuter).toBe(true);
    expect(turn.preflight.topology.topology).toBe('solo');
    expect(turn.preflight.topology.adversarialRequired).toBe(false);
    expect(turn.preflight.topology.reason).toContain('recurse indefinitely');
    expect(turn.memory.bytes).toBe(0);
    expect(turn.memory.sources).toEqual([]);
    expect(turn.continuity.hits).toEqual([]);
    expect(turn.failure.active).toBe(false);
    expect(turn.awareness.status).toBe('NOT_NEEDED_ISOLATED_PROOF');
    expect(turn.body.messages).toHaveLength(1);
    expect(turn.body.messages[0].role).toBe('user');

    const finalized = await finalizeChatTurn({
      turn,
      completion: { choices: [{ message: { content: '{"status":"completed"}' }, finish_reason: 'stop' }] },
      tier: 'navigator',
      model: 'orange-navigator',
      host: 'CODEXA',
    });
    expect(finalized.learning).toMatchObject({ requested: false, queued: false });
    expect(finalized.learning.skippedReason).toContain('duplicate learning is suppressed');
    expect(finalized.continuity.turn_record).toMatchObject({ recorded: false });
    expect(finalized.continuity.turn_record.reason).toContain('duplicate continuity is suppressed');
  });

  test('fits project, awareness, memory, and history inside the model budget', () => {
    const messages = [
      { role: 'system', content: `ORANGE5_GATEWAY_DOCTRINE_V1\nAIR:MEMORY.v1\n${'memory '.repeat(900)}` },
      { role: 'system', content: `AIR:CURRENT.v1\n${'candidate '.repeat(900)}` },
      { role: 'system', content: `ORANGE ACTIVE PROJECT LOCK\n${'governing law '.repeat(900)}` },
      { role: 'user', content: 'old question' },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'current question must survive' },
    ];
    const fitted = fitMessagesToBudget(messages, { budgetTokens: 1_400 });
    expect(fitted.meta.within_budget).toBe(true);
    expect(fitted.meta.truncated_frames).toBeGreaterThan(0);
    expect(fitted.meta.transform_audit.truncated).toHaveLength(fitted.meta.truncated_frames);
    expect(fitted.meta.transform_audit.dropped).toHaveLength(fitted.meta.dropped_messages);
    expect(fitted.meta.transform_audit.truncated.every((item) => item.before_sha256.length === 64 && item.after_sha256.length === 64)).toBe(true);
    expect(fitted.meta.transform_audit.dropped.every((item) => item.before_sha256.length === 64 && item.source_identity)).toBe(true);
    expect(fitted.meta.transform_audit).toMatchObject({ reasoning_blocks_removed: 0, special_tokens_removed: 0 });
    expect(fitted.messages.some((message) => message.content === 'current question must survive')).toBe(true);
  });

  test('retains explicit source identity when prompt history is dropped', () => {
    const fitted = fitMessagesToBudget([
      { role: 'system', content: `AIR:MEMORY.v1\n${'memory '.repeat(700)}` },
      { role: 'assistant', content: 'old answer', metadata: { source_path: 'runtime://turn/older' } },
      { role: 'user', content: 'current question must survive' },
    ], { budgetTokens: 500, minSystemChars: 120, maxPasses: 32 });
    expect(fitted.meta.transform_audit.dropped).toContainEqual(expect.objectContaining({
      source_identity: 'runtime://turn/older',
      before_sha256: __turnHarnessInternals.sha256('old answer'),
      after_sha256: null,
    }));
  });

  test('fails loudly for malformed and hash-corrupted receipt chains', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orange-turn-chain-'));
    const chainPath = path.join(root, 'spine-chain.jsonl');
    try {
      expect(__turnHarnessInternals.loadChain(chainPath)).toEqual([]);

      fs.writeFileSync(chainPath, '{not-json}\n', 'utf8');
      expect(() => __turnHarnessInternals.loadChain(chainPath)).toThrow(/receipt chain parse failed/);

      const body = {
        schema: 'orange5.spine.order-flow.v1',
        seq: 0,
        receipt_id: 'rcpt_test',
        ts: 1,
        action: 'query.chat',
        status: 'completed',
        summary: 'test',
        lane: 'navigator',
        executed: false,
      };
      const valid = {
        ...body,
        prev_hash: __turnHarnessInternals.SPINE_GENESIS,
        hash: __turnHarnessInternals.sha256(`${__turnHarnessInternals.SPINE_GENESIS}|${JSON.stringify(body)}`),
      };
      fs.writeFileSync(chainPath, `${JSON.stringify(valid)}\n`, 'utf8');
      expect(__turnHarnessInternals.loadChain(chainPath)).toEqual([valid]);

      fs.writeFileSync(chainPath, `${JSON.stringify({ ...valid, prev_hash: '0'.repeat(64) })}\n`, 'utf8');
      expect(() => __turnHarnessInternals.loadChain(chainPath)).toThrow(/previous hash mismatch/);

      fs.writeFileSync(chainPath, `${JSON.stringify({ ...valid, hash: '0'.repeat(64) })}\n`, 'utf8');
      expect(() => __turnHarnessInternals.loadChain(chainPath)).toThrow(/content hash mismatch/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('supports a tight specialist prefill budget without dropping the current request', () => {
    const fitted = fitMessagesToBudget([
      { role: 'system', content: `Return compact JSON only.\n${'schema '.repeat(600)}` },
      { role: 'system', content: `ORANGE ACTIVE PROJECT LOCK\n${'law '.repeat(500)}` },
      { role: 'system', content: `AIR:PROJECT-CONTINUUM.v1\n${'lineage '.repeat(500)}` },
      { role: 'system', content: `AIR:MEMORY.v1\n${'memory '.repeat(500)}` },
      { role: 'user', content: 'current architecture request must survive exactly' },
    ], { budgetTokens: 700, minSystemChars: 180, maxPasses: 32 });
    expect(fitted.meta.within_budget).toBe(true);
    expect(fitted.messages.at(-1).content).toBe('current architecture request must survive exactly');
  });

  test('puts stable authority frames before dynamic memory without dropping context', () => {
    const ordered = stabilizeLeadingSystemFrames([
      { role: 'system', content: 'AIR:MEMORY.v1\nrecent result' },
      { role: 'system', content: 'AIR:CURRENT.v1\nnew candidate' },
      { role: 'system', content: 'AIR:FAILURE-MEMORY.v1\nprior context overflow' },
      { role: 'system', content: 'AIR:PROJECT-CONTINUUM.v1\nexisting work' },
      { role: 'system', content: 'ORANGE ACTIVE PROJECT LOCK\ncanonical root' },
      { role: 'system', content: 'Return compact JSON only.\ncontract' },
      { role: 'user', content: 'request' },
    ]);
    expect(ordered.map((message) => message.content.split('\n')[0])).toEqual([
      'Return compact JSON only.',
      'ORANGE ACTIVE PROJECT LOCK',
      'AIR:PROJECT-CONTINUUM.v1',
      'AIR:FAILURE-MEMORY.v1',
      'AIR:CURRENT.v1',
      'AIR:MEMORY.v1',
      'request',
    ]);
  });

  test('uses a non-mutating advisory topology for ordinary chat', () => {
    expect(__turnHarnessInternals.advisoryChatTopology()).toMatchObject({
      topology: 'solo',
      adversarialRequired: false,
      gates: ['procedural'],
    });
  });

  test('binds chat receipts to the lane that actually answered', () => {
    expect(__turnHarnessInternals.advisoryChatRouter('navigator', 'orange-navigator')).toMatchObject({
      lane: 'navigator',
      model: 'orange-navigator',
      eligible: true,
      risk: 'low',
    });
  });
});
