import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import {
  benchmarkQueue,
  benchmarkSemantic,
  MAX_SEMANTIC_P95_MS,
  MIN_QUEUE_OPS_PER_SECOND,
  RUNTIME_RECEIPT_DIR,
} from '../bun-runtime-benchmark.mjs';

describe('Bun runtime benchmark', () => {
  test('keeps production gates and receipts in the owned folder', () => {
    expect(MIN_QUEUE_OPS_PER_SECOND).toBe(1_000);
    expect(MAX_SEMANTIC_P95_MS).toBe(1_000);
    expect(path.basename(RUNTIME_RECEIPT_DIR)).toBe('runtime-performance');
  });

  test('measures the durable queue path through close and reopen', async () => {
    const result = await benchmarkQueue({ itemCount: 400 });
    expect(result).toMatchObject({
      ok: true,
      items: 400,
      operations: 1_200,
      minimum_operations_per_second: 1_000,
      durability_verified_after_reopen: true,
      pragmas: { journal_mode: 'wal', synchronous: 1, foreign_keys: 1 },
      reopened_pragmas: { journal_mode: 'wal', synchronous: 1, foreign_keys: 1 },
      stats: { total: 400, by_status: { completed: 400 }, failed: 0 },
    });
    expect(result.operations_per_second).toBeGreaterThanOrEqual(MIN_QUEUE_OPS_PER_SECOND);
  });

  test('uses varied real-query calls and gates their wall-clock p95', async () => {
    const seen = [];
    const result = await benchmarkSemantic({
      queryMemory: async (query) => {
        seen.push(query);
        await Bun.sleep(seen.length);
        return {
          elapsed_ms: seen.length,
          hits: [{ id: seen.length }],
          candidates: 192,
          model: 'test-embedding',
          component_latency_ms: { embedding: 1, qdrant: 1 },
        };
      },
    });
    expect(result.ok).toBe(true);
    expect(result.runs).toBe(3);
    expect(result.threshold_ms).toBe(1_000);
    expect(result.hits_per_run).toEqual([1, 1, 1]);
    expect(new Set(seen).size).toBe(3);
    expect(result.p95_ms).toBeLessThanOrEqual(MAX_SEMANTIC_P95_MS);
  });
});
