import { describe, expect, test } from 'bun:test';
import { runMemoryLearningHeldoutBenchmark } from '../memory-learning-heldout-benchmark.mjs';

describe('board 5 memory and learning held-out benchmark', () => {
  test('passes every fixed adversarial case without writing a repository receipt', async () => {
    const result = await runMemoryLearningHeldoutBenchmark({ writeReceipt: false });
    expect(result.status).toBe('MEMORY_LEARNING_HELDOUT_GREEN');
    expect(result.cases_passed).toBe(result.cases_total);
    expect(result.cases_total).toBe(8);
    expect(result.persistence.fresh_process.pid_isolated).toBe(true);
  });
});
