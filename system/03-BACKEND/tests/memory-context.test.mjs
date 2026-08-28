import { describe, expect, test } from 'bun:test';
import { buildMemoryContext, buildModelMemoryBrief, memoryContextEvidence } from '../memory-context.mjs';

describe('OrangeFive bounded memory context', () => {
  test('compacts prior mistakes and preserves receipt identity', () => {
    const context = buildMemoryContext({
      mistakes: [{ id: 'mem-1', lane: 'reality', kind: 'error', summary: 'prior route timed out', receipt_id: 'rcpt-1' }],
      prior: { verdict: 'CAUTION', advice: 'use the measured timeout', penalty: 0.2 },
    });
    expect(context.mistakeCount).toBe(1);
    expect(context.mistakes[0]).toMatchObject({ id: 'mem-1', receiptId: 'rcpt-1', summary: 'prior route timed out' });
    expect(memoryContextEvidence(context)).toEqual({
      schema: 'orange.memory-context.v1', mistakeCount: 1, suppressedMistakeCount: 0, sourceIds: ['mem-1'], project: null, projectRecords: 0, priorVerdict: 'CAUTION',
    });
  });

  test('caps injected mistakes at five', () => {
    const context = buildMemoryContext({ mistakes: Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, summary: `mistake ${i}` })) });
    expect(context.mistakes).toHaveLength(5);
  });

  test('suppresses same-action mistakes that do not match current intent', () => {
    const context = buildMemoryContext({
      order: { action: 'query.chat', intent: 'Explain current runtime routing', targetProject: 'OrangeFive' },
      mistakes: [
        { id: 'old-visual', kind: 'mistake:query.chat', summary: 'image generation failed because the diffusion model timed out' },
        { id: 'route', kind: 'mistake:query.chat', summary: 'runtime routing selected an unavailable specialist' },
      ],
    });
    expect(context.mistakes.map((item) => item.id)).toEqual(['route']);
    expect(context.suppressedMistakeCount).toBe(1);
    expect(context.retrieval).toMatchObject({ candidatesConsidered: 2, relevantMatches: 1, suppressedMatches: 1 });
    expect(memoryContextEvidence(context).suppressedMistakeCount).toBe(1);
  });

  test('rejects a project mismatch even when intent words overlap', () => {
    const context = buildMemoryContext({
      order: { action: 'build.api', intent: 'repair schema validation', targetProject: 'OrangeFive' },
      mistakes: [{ id: 'other', action: 'build.api', target_project: 'OtherProject', summary: 'schema validation failed' }],
    });
    expect(context.mistakeCount).toBe(0);
    expect(context.retrieval.suppressionReasons).toEqual({ project_mismatch: 1 });
  });

  test('does not inject obsolete gateway timeout prose into a new live model call', () => {
    const context = buildMemoryContext({ mistakes: [
      { id: 'm1', summary: 'OrangeBrain unreachable: The operation timed out.' },
      { id: 'm2', summary: 'prior tool selected the wrong path' },
    ] });
    expect(buildModelMemoryBrief(context).latestMistake).toBe('prior tool selected the wrong path');
    expect(memoryContextEvidence(context).mistakeCount).toBe(2);
  });

  test('can omit stale failure prose while preserving project recall for synthesis', () => {
    const context = buildMemoryContext({
      mistakes: [{ id: 'm1', summary: 'old transport timeout' }],
      project: { ok: true, project: 'OrangeFive', found: true, reality: [{ ts: 1, summary: 'current receipt truth' }] },
    });
    const brief = buildModelMemoryBrief(context, { includeMistake: false });
    expect(brief.latestMistake).toBeNull();
    expect(brief.projectRecords).toEqual(['current receipt truth']);
    expect(memoryContextEvidence(context).mistakeCount).toBe(1);
  });

  test('injects bounded project reality before model execution', () => {
    const context = buildMemoryContext({
      project: {
        ok: true, project: 'OrangeFive', found: true, latest_is_hypothesis: false,
        reality: Array.from({ length: 7 }, (_, i) => ({ ts: 100 - i, lane: 'reality', summary: `proof ${i}`, receipt_id: `r${i}` })),
        thought: Array.from({ length: 4 }, (_, i) => ({ ts: 50 - i, lane: 'thought', summary: `idea ${i}`, receipt_id: `t${i}` })),
        open_threads: [{ summary: 'finish universal mediation', next_action: 'wire all entrypoints' }],
        conflicts: [],
      },
    });
    expect(context.project.name).toBe('OrangeFive');
    expect(context.project.records).toHaveLength(8);
    expect(context.project.records[0]).toMatchObject({ id: 'r0', summary: 'proof 0' });
    expect(context.project.openThreads).toHaveLength(1);
    expect(memoryContextEvidence(context).projectRecords).toBe(8);
    const brief = buildModelMemoryBrief(context);
    expect(brief.projectRecords).toEqual(['proof 0', 'proof 1', 'proof 2']);
    expect(JSON.stringify(brief).length).toBeLessThan(JSON.stringify(context).length);
  });

  test('preserves a hash-addressed source citation through compact model context', () => {
    const sourceHash = 'b'.repeat(64);
    const context = buildMemoryContext({
      project: {
        ok: true, project: 'OrangeFive', found: true,
        reality: [{
          ts: 2, lane: 'reality', receipt_id: 'receipt-cited',
          summary: `decision_reason=fresh probe passed; source_path=10-RECEIPTS/probe.json; source_sha256=${sourceHash}; source_offset=9`,
          files: ['10-RECEIPTS/probe.json'],
        }],
        thought: [], conflicts: [], open_threads: [],
      },
    });
    expect(context.project.sourcePointers[0]).toMatchObject({
      path: '10-RECEIPTS/probe.json', sha256: sourceHash, offset: 9, receiptId: 'receipt-cited',
    });
    expect(buildModelMemoryBrief(context).sourcePointers[0].sha256).toBe(sourceHash);
    expect(memoryContextEvidence(context).sourceCitationCount).toBe(1);
  });

  test('reduces contradiction revisions and repaired failure debt to current state', () => {
    const context = buildMemoryContext({
      project: {
        ok: true, project: 'OrangeFive', found: true,
        reality: [
          { ts: 5, lane: 'reality', receipt_id: 'success', summary: 'outcome=success; action=build.api; debt_type=none; debt_status=none' },
          { ts: 4, lane: 'reality', receipt_id: 'resolved', summary: 'debt_id=conflict-1; debt_type=memory_contradiction; debt_status=resolved; resolution=fresh receipt wins' },
        ],
        thought: [
          { ts: 3, lane: 'thought', receipt_id: 'failure', summary: 'outcome=failure; action=build.api; debt_id=failure-1; debt_type=execution_failure; debt_status=open' },
          { ts: 2, lane: 'thought', receipt_id: 'open', summary: 'debt_id=conflict-1; debt_type=memory_contradiction; debt_status=open' },
        ],
        conflicts: [], open_threads: [],
      },
    });
    expect(context.project.openDebtCount).toBe(0);
    expect(buildModelMemoryBrief(context).openDebtCount).toBe(0);
  });
});
