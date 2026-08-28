#!/usr/bin/env bun
import { describe, expect, test } from 'bun:test';
import { __memoryInjectInternals } from '../server/middleware/memory-inject.mjs';

const { buildMemoryHotFrame, latestUserQuery } = __memoryInjectInternals;

function stateBrief(records) {
  return {
    served_by: 'ae_cobra',
    degraded: false,
    reality: records,
    thought: [],
    conflicts: [],
  };
}

function record(id, summary, ts = 1) {
  return {
    id,
    lane: 'reality',
    kind: 'runtime_fact',
    summary,
    confidence: 1,
    ts,
    source_pointer: { hash: `sha256:${id}` },
  };
}

describe('AtomSmasher memory hot frame', () => {
  test('drops irrelevant records instead of flooding hot context', () => {
    const brief = stateBrief([
      record('old-ui', 'Purple marketing homepage card spacing decision'),
      record('music', 'Background playlist curation notes'),
    ]);
    const frame = buildMemoryHotFrame(brief, {
      query: 'Codexa model route health',
      maxRecords: 8,
      byteBudget: 800,
    });

    expect(frame.inputItems).toBe(2);
    expect(frame.keptItems).toBe(0);
    expect(frame.droppedItems).toBe(2);
    expect(frame.text).not.toContain('playlist');
    expect(frame.hotBytes).toBeLessThan(frame.rawBytes);
  });

  test('keeps relevant memory with an auditable source pointer', () => {
    const brief = stateBrief([
      record('route-proof', 'Codexa model route uses Orange Navigator through the governed gateway'),
      record('unrelated', 'Typeface exploration for a retired landing page'),
    ]);
    const frame = buildMemoryHotFrame(brief, {
      query: 'Which Codexa model route is active?',
      maxRecords: 8,
      byteBudget: 1000,
    });

    expect(frame.keptItems).toBe(1);
    expect(frame.text).toContain('Orange Navigator');
    expect(frame.text).toContain('src=sha256:route-proof');
    expect(frame.text).not.toContain('Typeface');
  });

  test('enforces a hard workset byte budget', () => {
    const repeated = 'Codexa routing evidence '.repeat(30);
    const brief = stateBrief([
      record('large-a', repeated, 1),
      record('large-b', repeated, 2),
    ]);
    const frame = buildMemoryHotFrame(brief, {
      query: 'Codexa routing evidence',
      maxRecords: 8,
      byteBudget: 180,
    });

    expect(frame.keptItems).toBe(0);
    expect(frame.droppedItems).toBe(2);
    expect(frame.hotBytes).toBeLessThan(300);
  });

  test('uses the latest user intent and removes explicit recall markup', () => {
    const query = latestUserQuery([
      { role: 'user', content: 'old question' },
      { role: 'assistant', content: 'old response' },
      { role: 'user', content: 'Check Codexa health <recall>secret old history</recall> now' },
    ]);

    expect(query).toBe('Check Codexa health now');
    expect(query).not.toContain('secret old history');
  });
});
