#!/usr/bin/env bun
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { downloadApprovedFile, remoteDownloadScript } from '../deploy-downloads.mjs';
import { writeJsonAtomic } from '../deploy-core.mjs';

const cleanup = [];
const servers = [];

afterEach(() => {
  while (servers.length) servers.pop().stop(true);
  while (cleanup.length) rmSync(cleanup.pop(), { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'orangefive-download-test-'));
  cleanup.push(root);
  const body = Buffer.from('orange-five-resumable-model-bytes', 'utf8');
  mkdirSync(path.join(root, 'models'), { recursive: true });
  return {
    root,
    body,
    destination: path.join(root, 'models', 'model.bin'),
    sha256: createHash('sha256').update(body).digest('hex'),
  };
}

function serve(body, ignoreRange = false) {
  const requests = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const range = request.headers.get('range');
      requests.push(range);
      const start = ignoreRange ? 0 : Number(range?.match(/^bytes=(\d+)-$/)?.[1] || 0);
      const responseBody = body.subarray(start);
      return new Response(responseBody, {
        status: start ? 206 : 200,
        headers: {
          'content-length': String(responseBody.length),
          ...(start ? { 'content-range': `bytes ${start}-${body.length - 1}/${body.length}` } : {}),
        },
      });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}/model.bin`, requests };
}

describe('OrangeFive resumable model downloads', () => {
  test('resumes an owned partial with a validated HTTP range and atomically promotes it', async () => {
    const fx = fixture();
    const source = serve(fx.body);
    const spec = { url: source.url, destination: fx.destination, bytes: fx.body.length, sha256: fx.sha256 };
    const partial = `${fx.destination}.part`;
    writeFileSync(partial, fx.body.subarray(0, 9));
    writeJsonAtomic(`${partial}.orangefive.json`, {
      schema: 'orange.deploy.download-part.v1',
      destination: fx.destination,
      source: source.url,
      bytes: fx.body.length,
      sha256: fx.sha256,
    });

    const result = await downloadApprovedFile(spec, { allowLoopbackHttp: true });
    expect(result.status).toBe('RESUMED_AND_VERIFIED');
    expect(source.requests).toEqual(['bytes=9-']);
    expect(readFileSync(fx.destination)).toEqual(fx.body);
    expect(existsSync(partial)).toBe(false);
    expect(existsSync(`${partial}.orangefive.json`)).toBe(false);
  });

  test('restarts an owned partial when a server ignores Range instead of appending corrupt bytes', async () => {
    const fx = fixture();
    const source = serve(fx.body, true);
    const spec = { url: source.url, destination: fx.destination, bytes: fx.body.length, sha256: fx.sha256 };
    const partial = `${fx.destination}.part`;
    writeFileSync(partial, fx.body.subarray(0, 7));
    writeJsonAtomic(`${partial}.orangefive.json`, {
      schema: 'orange.deploy.download-part.v1', destination: fx.destination, source: source.url, bytes: fx.body.length, sha256: fx.sha256,
    });

    const result = await downloadApprovedFile(spec, { allowLoopbackHttp: true });
    expect(result.status).toBe('RESTARTED_AND_VERIFIED');
    expect(source.requests).toEqual(['bytes=7-']);
    expect(readFileSync(fx.destination)).toEqual(fx.body);
  });

  test('refuses credential-bearing URLs and generates a compute-side range/checksum worker', async () => {
    const fx = fixture();
    await expect(downloadApprovedFile({
      url: 'https://models.example.invalid/model.bin?token=not-allowed',
      destination: fx.destination,
      bytes: fx.body.length,
      sha256: fx.sha256,
    }, { fetchFn: () => { throw new Error('must not fetch'); } })).rejects.toThrow('credential-like query parameter');

    const script = remoteDownloadScript({ role: 'fixture', acquisition: { revision: 'abc123' }, files: [{
      url: 'https://models.example.invalid/model.bin', destination: 'C:\\Models\\model.bin', bytes: fx.body.length, sha256: fx.sha256,
    }] });
    expect(script).toContain('RangeHeaderValue');
    expect(script).toContain('Get-FileHash');
    expect(script).toContain("Move-Item -LiteralPath $partial");
    expect(script).not.toContain('not-allowed');
  });
});
