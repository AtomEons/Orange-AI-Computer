import { describe, expect, test } from 'bun:test';
import { runFailureRecurrenceBenchmark } from '../failure-recurrence-benchmark.mjs';

describe('Failure Memory recurrence benchmark', () => {
  test('closes repaired episodes, preserves new failures, and never punishes correct restraint', async () => {
    const result = await runFailureRecurrenceBenchmark({ writeReceipt: false });
    expect(result.status).toBe('RECURRENCE_MECHANISM_PROVEN');
    expect(Object.values(result.checks).every(Boolean)).toBe(true);
    expect(result.cases.connectivity_closed).toMatchObject({ unresolved_count: 0, resolved_count: 2 });
    expect(result.cases.context_reopened).toMatchObject({ unresolved_count: 1, classes: ['context_pressure'] });
    expect(result.cases.guarded_stop_closed).toMatchObject({ unresolved_count: 0, last_resolution_disposition: 'guarded_stop' });
    expect(result.claim_boundary.live_longitudinal_reduction_proven).toBe(false);
  });
});
