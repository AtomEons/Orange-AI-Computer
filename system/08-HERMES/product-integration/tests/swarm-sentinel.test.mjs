import { describe, expect, test } from 'bun:test';
import { inspectSwarm } from '../scripts/swarm-sentinel.mjs';

const plan = { executionWaves: [{ workers: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }] };
const report = (workerId) => ({ workerId, status: 'PASS', evidence: [`hash-${workerId}`], confidence: 0.9, blockers: [], nextAction: 'return' });

describe('SwarmSentinel', () => {
  test('accepts complete independent evidence', () => {
    expect(inspectSwarm({ plan, workerReports: ['a', 'b', 'c'].map(report) }).status).toBe('SWARM_HEALTHY');
  });
  test('halts false green', () => {
    const bad = report('a'); bad.evidence = [];
    expect(inspectSwarm({ plan: { executionWaves: [{ workers: [{ id: 'a' }] }] }, workerReports: [bad] }).status).toBe('SWARM_HALTED');
  });
  test('halts failure amplification', () => {
    const reports = ['a', 'b', 'c'].map(report); reports[0].status = 'FAIL'; reports[1].status = 'BLOCKED';
    expect(inspectSwarm({ plan, workerReports: reports }).findings.some((item) => item.code === 'FAILURE_AMPLIFICATION')).toBe(true);
  });
  test('pauses admission at memory pressure', () => {
    const result = inspectSwarm({ plan, workerReports: ['a', 'b', 'c'].map(report), system: { liveMemoryUsedGb: 46, liveMemoryBudgetGb: 50 } });
    expect(result.admitNewWorkers).toBe(false);
  });
});
