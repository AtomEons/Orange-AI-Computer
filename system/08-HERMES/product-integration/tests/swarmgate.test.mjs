import { describe, expect, test } from 'bun:test';
import { planSwarm } from '../scripts/swarmgate.mjs';

describe('Swarmgate', () => {
  test('fans six independent workers into one evidence wave', () => {
    const tasks = Array.from({ length: 6 }, (_, index) => ({ id: `r-${index}`, action: 'research current primary sources', reads: [`topic-${index}`], model: { key: 'navigator', residentGb: 10, contextGb: 1 } }));
    const plan = planSwarm({ tasks });
    expect(plan.mode).toBe('swarm');
    expect(plan.maxParallelWorkers).toBe(6);
    expect(plan.peakEstimatedMemoryGb).toBe(16);
  });
  test('serializes shared writes and dependencies', () => {
    const plan = planSwarm({ tasks: [
      { id: 'a', action: 'build code', writes: ['src/a.ts'] },
      { id: 'b', action: 'review code', reads: ['src/a.ts'] },
      { id: 'c', action: 'test code', dependsOn: ['a'] }
    ] });
    expect(plan.waveCount).toBe(2);
    expect(plan.rejectedParallelPairs[0].reason).toBe('read-write-collision');
  });
  test('counts shared model residency once', () => {
    const tasks = Array.from({ length: 4 }, (_, index) => ({ id: `${index}`, model: { key: 'shared', residentGb: 30, contextGb: 2 } }));
    expect(planSwarm({ tasks }).peakEstimatedMemoryGb).toBe(38);
  });
  test('rejects a task beyond admitted memory', () => {
    expect(() => planSwarm({ tasks: [{ id: 'huge', model: { key: 'huge', residentGb: 48, contextGb: 4 } }] })).toThrow();
  });
});
