import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleBuildRuns, isBuildRunRouteAllowed } from './build-runs.mjs';

describe('build run gateway routes', () => {
  test('creates, reads, updates, and lists durable runs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orange-build-run-route-'));
    const options = { filePath: path.join(dir, 'events.jsonl') };
    const create = await handleBuildRuns('POST', new URL('http://orange/v1/build-runs'), {
      threadId: 'thread-route', goal: 'Prove the route', mode: 'verify',
    }, options);
    expect(create.status).toBe(201);
    const runId = create.body.run.runId;
    const update = await handleBuildRuns('PATCH', new URL(`http://orange/v1/build-runs/${runId}`), {
      stage: 'settle', status: 'completed', receipts: [{ id: 'rcpt-route' }],
    }, options);
    expect(update.body.run.status).toBe('completed');
    const read = await handleBuildRuns('GET', new URL(`http://orange/v1/build-runs/${runId}`), null, options);
    expect(read.body.receipts).toEqual([{ id: 'rcpt-route' }]);
    const list = await handleBuildRuns('GET', new URL('http://orange/v1/build-runs?thread=thread-route'), null, options);
    expect(list.body.chain.ok).toBe(true);
    expect(list.body.runs).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('boundary allows only the declared methods', () => {
    expect(isBuildRunRouteAllowed('GET', '/v1/build-runs')).toBe(true);
    expect(isBuildRunRouteAllowed('POST', '/v1/build-runs')).toBe(true);
    expect(isBuildRunRouteAllowed('PATCH', '/v1/build-runs/run-1')).toBe(true);
    expect(isBuildRunRouteAllowed('DELETE', '/v1/build-runs/run-1')).toBe(false);
  });
});
