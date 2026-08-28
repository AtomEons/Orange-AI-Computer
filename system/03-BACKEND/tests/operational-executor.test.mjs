import { describe, expect, test } from 'bun:test';
import { OPERATIONAL_ENDPOINTS, classifyModelExecution, evaluateOperationalSemantics, executeOperationalAction } from '../operational-executor.mjs';

function mockFetch(statusByUrl = {}) {
  return async (url) => {
    const status = statusByUrl[url] ?? 200;
    const body = url.endsWith('/healthz') && url.includes('1337')
      ? { status: 'ok', boundary: 'frontier_isolation_active', primary: { live: true, warm: true } }
      : { status: status === 200 ? 'ok' : 'down' };
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

describe('OrangeFive operational executor', () => {
  test('canonical topology contains only current OrangeFive organs', () => {
    expect(Object.keys(OPERATIONAL_ENDPOINTS)).toEqual([
      'ollama', 'navigator_kernel', 'orangebrain', 'cobra', 'hermes', 'ae_eyes', 'atomsmasher', 'ae_phase',
    ]);
    expect(JSON.stringify(OPERATIONAL_ENDPOINTS)).not.toContain('8797');
  });

  test('read.status observes the requested organ directly', async () => {
    const result = await executeOperationalAction(
      { action: 'read.status', payload: { target: 'orangebrain' } },
      { fetchImpl: mockFetch() },
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe('ok');
    expect(result.model).toBeNull();
    expect(result.output.observations).toHaveLength(1);
    expect(result.output.observations[0].name).toBe('orangebrain');
    expect(result.evidence.source).toBe('direct_http_and_semantic_observation');
  });

  test('read.status honors the configured OrangeBrain endpoint', async () => {
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(url);
      return Response.json({ status: 'ok', boundary: 'frontier_isolation_active', primary: { live: true, warm: true } });
    };
    const result = await executeOperationalAction(
      { action: 'read.status', payload: { target: 'orangebrain' } },
      { fetchImpl, env: { ORANGE5_ORANGEBRAIN_URL: 'http://127.0.0.1:91337/' } },
    );
    expect(result.ok).toBe(true);
    expect(seen).toEqual(['http://127.0.0.1:91337/healthz']);
  });

  test('HTTP 200 cannot hide an evicted Navigator', () => {
    const result = evaluateOperationalSemantics('navigator_kernel', {
      object: 'list', data: [{ id: 'orange-navigator', ae_state: 'available' }],
    });
    expect(result.ok).toBe(false);
    expect(result.reasons[0]).toContain('not warm');
  });

  test('HTTP 200 cannot hide disabled Hermes enforcement', () => {
    const result = evaluateOperationalSemantics('hermes', {
      ok: true, data: { status: 'alive', gates: 8, misfit: { enabled: false, load_error: null } },
    });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('Hermes Misfit middleware is disabled');
  });

  test('semantic contracts accept exact healthy organ shapes', () => {
    expect(evaluateOperationalSemantics('ollama', { models: [{ name: 'nomic-embed-text:latest' }] }).ok).toBe(true);
    expect(evaluateOperationalSemantics('ae_eyes', { ok: true, backend: 'transformers:xpu', resident_worker: { state: 'ready', failures: 0 } }).ok).toBe(true);
    expect(evaluateOperationalSemantics('atomsmasher', { ok: true, service: 'atomsmasher2', counts: { features: 620 } }).ok).toBe(true);
    expect(evaluateOperationalSemantics('ae_phase', { ok: true, status: 'AE_PHASE_FABRIC_ACTIVE', authenticated: true, connectedPeers: 1, backpressured: false }).ok).toBe(true);
  });

  test('read.status reports a failed observation as error', async () => {
    const url = 'http://127.0.0.1:1337/healthz';
    const result = await executeOperationalAction(
      { action: 'read.status', payload: { target: 'orangebrain' } },
      { fetchImpl: mockFetch({ [url]: 503 }) },
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe('error');
    expect(result.output.green).toBe(0);
  });

  test('unknown status target fails honestly without a model guess', async () => {
    const result = await executeOperationalAction(
      { action: 'read.status', payload: { target: 'imaginary' } },
      { fetchImpl: mockFetch() },
    );
    expect(result.status).toBe('needs_action');
    expect(result.evidence.reason).toBe('unknown_target');
  });

  test('model prose cannot complete a mutation action', () => {
    const result = classifyModelExecution(
      { action: 'build.feature' },
      { ok: true, output: { status: 'completed' }, evidence: { gateway: 'local' } },
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe('needs_action');
    expect(result.evidence.execution).toBe('not_performed');
  });

  test('a completed cognitive answer remains a valid deliverable', () => {
    const result = classifyModelExecution(
      { action: 'query.answer' },
      { ok: true, output: { status: 'completed' }, evidence: { gateway: 'local' } },
    );
    expect(result.ok).toBe(true);
  });

  test('a schema-valid cognitive artifact does not need a mutation executor', () => {
    const result = classifyModelExecution(
      { action: 'analyze.agent' },
      { ok: true, output: { status: 'completed', finding: 'receipt writer is single-owner' }, evidence: { gateway: 'local' } },
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.evidence.execution).toBe('cognitive_report_completed');
  });

  test('a cognitive report requiring action cannot be promoted by transport success', () => {
    const result = classifyModelExecution(
      { action: 'analyze.agent' },
      { ok: true, output: { status: 'needs_action', blockers: ['missing proof'] }, evidence: { gateway: 'local' } },
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe('needs_action');
    expect(result.evidence.execution).toBe('cognitive_report_requires_action');
  });

  test('a completed synthesis is a cognitive deliverable, not a mutation', () => {
    const result = classifyModelExecution(
      { action: 'synthesize.delegation' },
      { ok: true, output: { status: 'completed', evidence: ['child receipt'] }, evidence: { gateway: 'local' } },
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe('completed');
  });

  test('receipt-backed delegation synthesis is deterministic and model-free', async () => {
    const result = await executeOperationalAction({
      action: 'synthesize.delegation',
      payload: {
        parentOrder: { governedExecution: { resultHash: 'b'.repeat(64), receiptSha256: 'c'.repeat(64) } },
        childEvidence: [{
          agent: 'builder',
          status: 'completed',
          summary: 'source title verified',
          evidence: ['governed:filesystem.read:abc123'],
          blockers: [],
          receipt: { receipt_id: 'receipt-child', hash: 'a'.repeat(64) },
        }],
      },
    });
    expect(result).toMatchObject({ ok: true, status: 'completed', lane: 'reflex', model: null, host: 'n150' });
    expect(result.output.findings[0].receipt.receipt_id).toBe('receipt-child');
    expect(result.evidence).toMatchObject({
      source: 'receipt_backed_deterministic_synthesis',
      execution: 'cognitive_report_completed',
      mutationPerformed: false,
      parentExecutionHash: 'b'.repeat(64),
    });
  });

  test('delegation synthesis refuses incomplete or unreceipted children', async () => {
    const result = await executeOperationalAction({
      action: 'synthesize.delegation',
      payload: {
        childEvidence: [{ agent: 'builder', status: 'completed', blockers: [], receipt: null }],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('needs_action');
    expect(result.evidence.execution).toBe('cognitive_report_requires_action');
  });

  test('governed source analysis stays on the deterministic reflex path', async () => {
    const result = await executeOperationalAction({
      action: 'analyze.agent',
      evidence: ['governed:filesystem.read:abc123'],
      payload: {
        agent: 'domain-worker',
        parentOrder: { governedExecution: {
          action: 'filesystem.read',
          resultHash: 'b'.repeat(64),
          receiptSha256: 'c'.repeat(64),
          excerpt: '# AE Orange5 - Master Plan',
        } },
      },
    });
    expect(result).toMatchObject({ ok: true, status: 'completed', lane: 'reflex', model: null });
    expect(result.output.evidence).toEqual(['governed:filesystem.read:abc123']);
    expect(result.output.findings).toContain('# AE Orange5 - Master Plan');
    expect(result.evidence.source).toBe('governed_execution_reflex');
  });

  test('unmediated agent analysis still falls through to OrangeBrain', async () => {
    expect(await executeOperationalAction({ action: 'analyze.agent', payload: {} })).toBeNull();
  });
});
