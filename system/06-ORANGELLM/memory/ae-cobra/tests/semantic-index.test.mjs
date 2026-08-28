import { describe, expect, test } from 'bun:test';
import { __semanticInternals, mergeSemanticMemory } from '../semantic-index.mjs';

describe('AE Cobra semantic index', () => {
  test('derives stable Qdrant UUIDs from receipt hashes', () => {
    const hash = 'a'.repeat(64);
    expect(__semanticInternals.pointId(hash)).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(__semanticInternals.pointId(hash)).toBe(__semanticInternals.pointId(hash));
  });

  test('merges semantic results without duplicating lexical proof', () => {
    const shared = 'b'.repeat(64);
    const added = 'c'.repeat(64);
    const brief = {
      reality: [{ summary: 'lexical', source_pointer: { hash: shared } }],
      thought: [],
      retrieval: { method: 'lexical' },
    };
    const semantic = {
      model: 'qwen3-embedding:0.6b', collection: 'orange5-memory', threshold: 0.55, elapsed_ms: 12,
      hits: [
        { score: 0.9, payload: { hash: shared, lane: 'reality', summary: 'duplicate' } },
        { score: 0.8, payload: { hash: added, lane: 'thought', summary: 'semantic only' } },
      ],
    };
    const merged = mergeSemanticMemory(brief, semantic, 8);
    expect(merged.reality).toHaveLength(1);
    expect(merged.thought).toHaveLength(1);
    expect(merged.thought[0].summary).toBe('semantic only');
    expect(merged.thought[0].source_pointer.hash).toBe(added);
    expect(merged.retrieval.semantic).toMatchObject({ active: true, hits: 2, added: 1 });
  });

  test('splits failed embedding batches without losing order', async () => {
    const calls = [];
    const embedder = async (texts) => {
      calls.push([...texts]);
      if (texts.length > 2) throw new Error('batch too large');
      return texts.map((text) => [Number(text)]);
    };
    const result = await __semanticInternals.adaptiveEmbed(['1', '2', '3', '4', '5'], { embedder });
    expect(result.vectors).toEqual([[1], [2], [3], [4], [5]]);
    expect(result.retries).toBeGreaterThan(0);
    expect(calls.some((batch) => batch.length === 2)).toBe(true);
  });

  test('demotes generic telemetry and promotes actionable term matches', () => {
    const ranked = __semanticInternals.rerankHits('markerless refuter verification action', [
      { score: 0.72, payload: { summary: 'Verified runtime event', entities: [], files: [], commands: [] } },
      {
        score: 0.64,
        payload: {
          summary: 'markerless refuter report lacks an explicit verification action',
          files: ['receipt.json'],
          next_action: 'Add the verification action.',
        },
      },
    ]);
    expect(ranked[0].payload.summary).toContain('markerless refuter');
    expect(ranked[0].lexical_coverage).toBe(1);
    expect(ranked[1].low_information).toBe(true);
  });

  test('normalizes authentication wording and boosts authoritative project sources', () => {
    const ranked = __semanticInternals.rerankHits('Codexa rail authentication', [
      { score: 0.7, payload: { summary: 'generic Codexa status event' } },
      {
        score: 0.64,
        payload: {
          summary: 'Authenticated Codexa Command Rail',
          source_file: 'receipt.json',
          section: 'Runtime evidence',
          authority: 1,
        },
      },
    ]);
    expect(ranked[0].payload.summary).toContain('Authenticated Codexa');
    expect(ranked[0].lexical_coverage).toBe(1);
  });

  test('does not index empty generic runtime telemetry', () => {
    expect(__semanticInternals.usefulRecord({
      hash: 'x', lane: 'reality', origin: 'test', kind: 'observation',
      body: { summary: 'Verified runtime event', entities: [], files: [], commands: [] },
    })).toBe(false);
  });

  test('preserves file and section provenance for project-source memories', () => {
    const hash = 'd'.repeat(64);
    const semantic = {
      model: 'qwen3-embedding:0.6b', collection: 'orange5-memory', threshold: 0.55, elapsed_ms: 12,
      hits: [{
        score: 0.9,
        payload: {
          hash,
          lane: 'reality',
          summary: 'Navigator runs on Codexa',
          source_file: '00-CHARTER/ORANGE5_RUNTIME_AUTHORITY.md',
          source_hash: 'e'.repeat(64),
          section: 'Model hierarchy',
          chunk_index: 2,
        },
      }],
    };
    const merged = mergeSemanticMemory({ reality: [], thought: [] }, semantic, 8);
    expect(merged.reality[0].source_pointer).toMatchObject({
      type: 'project-source',
      file: '00-CHARTER/ORANGE5_RUNTIME_AUTHORITY.md',
      section: 'Model hierarchy',
      chunk_index: 2,
      hash,
    });
  });

  test('normalizes halt wording so procedural recovery laws rank above telemetry', () => {
    const ranked = __semanticInternals.rerankHits('what to do after a LOOM halt', [
      { score: 0.5, payload: { summary: 'status=halted: read the blocker; do not retry blindly', section: 'Operator recovery', authority: 1 } },
      { score: 0.6, payload: { summary: 'operator dashboard status', section: 'Telemetry' } },
    ]);
    expect(ranked[0].payload.summary).toContain('do not retry blindly');
  });

  test('promotes failure lessons when asked how failed work is recalled before another action', () => {
    const ranked = __semanticInternals.rerankHits('How is failed work stored and recalled before another action?', [
      { score: 0.65, payload: { summary: 'outcome=failure; action=query.code; status=needs_action' } },
      { score: 0.45, payload: { summary: 'repair=Read the failed gate and satisfy its evidence before retrying.' } },
    ]);
    expect(ranked[0].payload.summary).toContain('Read the failed gate');
  });

  test('demotes recursively embedded benchmark summaries for operational recall', () => {
    const ranked = __semanticInternals.rerankHits('markerless refuter explicit verification action', [
      {
        score: 0.72,
        payload: {
          source_file: '10-RECEIPTS/orange5-build/run-system-performance-benchmark.json',
          summary: '$.services.gateway.p95_ms: 10\n\n$.semantic_recall.top_summary: markerless refuter explicit verification action\n\n$.routing.ok: true\n\n$.status: green',
        },
      },
      {
        score: 0.63,
        payload: {
          summary: 'analyze.agent halted: markerless refuter report lacks an explicit verification action',
          next_action: 'Review the blocker before retrying.',
        },
      },
    ]);
    expect(ranked[0].payload.summary).toContain('analyze.agent halted');
    expect(ranked[1].recursive_telemetry).toBe(true);
    expect(ranked[1].telemetry_penalty).toBe(0.7);
  });

  test('keeps machine telemetry eligible for explicit performance questions', () => {
    const ranked = __semanticInternals.rerankHits('what was the gateway p95 latency benchmark', [{
      score: 0.72,
      payload: {
        source_file: '10-RECEIPTS/orange5-build/run-system-performance-benchmark.json',
        summary: '$.services.gateway.p95_ms: 113\n\n$.status: PERFORMANCE_TARGETS_MET\n\n$.runs: 5\n\n$.mean_ms: 85',
      },
    }]);
    expect(ranked[0].machine_telemetry).toBe(true);
    expect(ranked[0].telemetry_penalty).toBe(0);
  });

  test('keeps fresh proof receipts eligible for explicit current-status questions', () => {
    const ranked = __semanticInternals.rerankHits('Is AE Eyes fully operational and green?', [{
      score: 0.7,
      payload: {
        source_file: '10-RECEIPTS/orange5-build/aeyes-human-grade-live-proof.json',
        summary: '$.status: AE_EYES_HUMAN_GRADE_NEEDS_WORK\n\n$.passed: 15\n\n$.total: 16\n\n$.score: 94%',
      },
    }]);
    expect(ranked[0].machine_telemetry).toBe(true);
    expect(ranked[0].telemetry_penalty).toBe(0);
  });
});
