import { describe, expect, test } from 'bun:test';
import { unavailableBrainResult } from '../spine-cli.mjs';

describe('spine CLI gateway failure semantics', () => {
  test('transport failure is needs_action and never claims execution', () => {
    const result = unavailableBrainResult(
      { action: 'build.feature', payload: { feature: 'x' } },
      'orangebrain_transport_error',
      { error: 'timeout' },
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe('needs_action');
    expect(result.output.executed).toBe(false);
    expect(result.evidence).toEqual({
      execution: 'not_performed',
      reason: 'orangebrain_transport_error',
      error: 'timeout',
    });
  });
});
