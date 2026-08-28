#!/usr/bin/env bun
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const cleanup = [];
afterAll(() => { while (cleanup.length) rmSync(cleanup.pop(), { recursive: true, force: true }); });

function write(root, relative, value = 'fixture\n') {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, value, 'utf8');
}

function runPacker(script, sourceRoot, destinationRoot, { skipReleaseProof = true } = {}) {
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-SourceRoot', sourceRoot, '-DestinationRoot', destinationRoot,
    ...(skipReleaseProof ? ['-SkipReleaseProof'] : []),
  ], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  return { ...result, output: `${result.stdout || ''}\n${result.stderr || ''}`.trim() };
}

describe('OrangeFive deterministic source packer', () => {
  test('repeats byte-identically and blocks high-confidence credential material', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'orangefive-packer-test-'));
    cleanup.push(root);
    const sourceRoot = path.join(root, 'source');
    const outputRoot = path.join(root, 'output');
    const packer = path.resolve(import.meta.dir, '..', 'pack-orangefive-llm-deploy.ps1');
    const manifest = {
      schema: 'orange.deploy.manifest.v1', product: 'Orange', release: 'OrangeFive',
      excluded: ['credentials', 'runtime state', 'model weights'],
    };
    write(sourceRoot, 'ORANGE_START.cmd');
    write(sourceRoot, '00-CHARTER/LLM-DEPLOY/INSTALL_ORANGE.md');
    write(sourceRoot, '00-CHARTER/LLM-DEPLOY/orangefive.deploy.json', JSON.stringify(manifest));
    write(sourceRoot, '00-CHARTER/LLM-DEPLOY/model-acquisition-catalog.json', '{}');
    for (const name of ['orange-deploy.mjs', 'deploy-core.mjs', 'deploy-probes.mjs', 'deploy-runtime.mjs', 'deploy-downloads.mjs', 'deploy-clients.mjs']) {
      write(sourceRoot, `scripts/llm-deploy/${name}`);
    }
    write(sourceRoot, 'scripts/llm-deploy/pack-orangefive-llm-deploy.ps1', readFileSync(packer, 'utf8'));
    write(sourceRoot, 'scripts/llm-deploy/prove-orangefive-llm-deploy.mjs');
    write(sourceRoot, '03-BACKEND/runtime.mjs', 'export const release = "OrangeFive";\n');
    write(sourceRoot, '05-FLOW/state/runtime.json', '{"must":"not-package"}\n');
    write(sourceRoot, '.env', 'SHOULD_NOT_PACKAGE=1\n');

    const first = runPacker(packer, sourceRoot, outputRoot);
    expect(first.status).toBe(0);
    const firstReport = JSON.parse(first.stdout);
    const second = runPacker(packer, sourceRoot, outputRoot);
    expect(second.status).toBe(0);
    const secondReport = JSON.parse(second.stdout);
    expect(secondReport.zipSha256).toBe(firstReport.zipSha256);
    expect(secondReport.credentialScan).toBe('passed');
    expect(secondReport.archiveVerification).toBe('passed');
    expect(secondReport.sourceSnapshotVerified).toBe(true);

    const fakeToken = `ghp_${'A'.repeat(40)}`;
    write(sourceRoot, '03-BACKEND/leak.txt', `LEAK=${fakeToken}\n`);
    const blocked = runPacker(packer, sourceRoot, outputRoot);
    expect(blocked.status).not.toBe(0);
    expect(blocked.output).toContain('Credential scan blocked 03-BACKEND/leak.txt');
  }, 240_000);

  test('proves an extracted package through apply, readiness, and rollback in a temporary root', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'orangefive-packer-proof-test-'));
    cleanup.push(root);
    const sourceRoot = path.join(root, 'source');
    const outputRoot = path.join(root, 'output');
    const deployRoot = path.resolve(import.meta.dir, '..');
    const packer = path.join(deployRoot, 'pack-orangefive-llm-deploy.ps1');
    const catalog = { schema: 'orange.model-superset.v1', roles: [] };
    const catalogText = `${JSON.stringify(catalog, null, 2)}\n`;
    const catalogSha256 = createHash('sha256').update(catalogText).digest('hex');
    const manifest = {
      schema: 'orange.deploy.manifest.v1', product: 'Orange', release: 'OrangeFive',
      payload: { immutable: true },
      topologies: { preferred: 'single-computer', supported: ['single-computer', 'control-plus-compute'] },
      runtimes: [
        { id: 'bun', required: true, minimum: '1.2.0', windowsPackageId: 'Oven-sh.Bun' },
        { id: 'ollama', requiredForLocalModels: true, windowsPackageId: 'Ollama.Ollama' },
        { id: 'hermes-agent', requiredOnComputeNode: true, version: '0.20.5', overlay: '08-HERMES/product-integration' },
      ],
      hermes: {
        gatewayOwners: 1, dispatchers: 1, swarmgate: true, swarmSentinel: true, profiles: ['builder'],
        hardwareProfiles: { compact: { minimumRamGiB: 8, immediateWorkers: 2, durableTasks: 2 } },
      },
      models: {
        catalog: '14-SUPERSTACK/captain-planet-stack.json',
        acquisitionCatalog: '00-CHARTER/LLM-DEPLOY/model-acquisition-catalog.json',
      },
      downloads: { minimumFreeReserveGiB: 1 },
      configuration: {
        orangeFiveClientInstaller: '03-BACKEND/install-orange5-clients.mjs',
        brainMcpServer: '03-BACKEND/orange5-brain-mcp-server.mjs',
      },
      excluded: ['credentials', 'runtime state', 'model weights'],
    };
    const acquisition = {
      schema: 'orange.deploy.model-acquisition-catalog.v1',
      sourceCatalogSha256: catalogSha256,
      roles: [],
    };

    write(sourceRoot, 'ORANGE_START.cmd');
    write(sourceRoot, '00-CHARTER/LLM-DEPLOY/INSTALL_ORANGE.md');
    write(sourceRoot, '00-CHARTER/LLM-DEPLOY/orangefive.deploy.json', `${JSON.stringify(manifest, null, 2)}\n`);
    write(sourceRoot, '00-CHARTER/LLM-DEPLOY/model-acquisition-catalog.json', `${JSON.stringify(acquisition, null, 2)}\n`);
    write(sourceRoot, '14-SUPERSTACK/captain-planet-stack.json', catalogText);
    for (const relative of [
      '08-HERMES/product-integration/upstream.lock.json',
      '08-HERMES/product-integration/integration.manifest.json',
      '08-HERMES/product-integration/scripts/install-hermes-product.ps1',
      '08-HERMES/product-integration/scripts/materialize-config.ps1',
      '08-HERMES/product-integration/scripts/start-owner.ps1',
      '08-HERMES/product-integration/scripts/preflight.ps1',
      '03-BACKEND/install-orange5-clients.mjs',
      '03-BACKEND/orange5-brain-mcp-server.mjs',
      '03-BACKEND/client-skills/orange5/SKILL.md',
      '03-BACKEND/client-skills/orangebox-primer/SKILL.md',
    ]) write(sourceRoot, relative);
    for (const name of [
      'orange-deploy.mjs', 'deploy-core.mjs', 'deploy-probes.mjs', 'deploy-runtime.mjs',
      'deploy-downloads.mjs', 'deploy-clients.mjs', 'prove-orangefive-llm-deploy.mjs',
    ]) write(sourceRoot, `scripts/llm-deploy/${name}`, readFileSync(path.join(deployRoot, name), 'utf8'));
    write(sourceRoot, 'scripts/llm-deploy/pack-orangefive-llm-deploy.ps1', readFileSync(packer, 'utf8'));

    const result = runPacker(packer, sourceRoot, outputRoot, { skipReleaseProof: false });
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.extractedReleaseProof).toBe('PROVEN');
    expect(report.sourceSnapshotVerified).toBe(true);
    expect(existsSync(report.proofReceiptPath)).toBe(true);
    const proof = JSON.parse(readFileSync(report.proofReceiptPath, 'utf8'));
    expect(proof.status).toBe('PROVEN');
    expect(proof.extractedPayload.lockVerified).toBe(true);
    expect(proof.readiness.status).toBe('READY');
    expect(proof.rollback.status).toBe('ROLLED_BACK_DATA_PRESERVED');
    expect(proof.postRollback).toMatchObject({ status: 'ROLLED_BACK', ready: false });
    expect(proof.hashEnforcement).toEqual({
      wrongPlanApprovalRejectedBeforeMutation: true,
      invalidModelSetRejectedBeforeMutation: true,
    });
    expect(proof.cleanInstall).toMatchObject({
      stateAbsentBeforeApply: true,
      stateCreatedOutsidePayload: true,
      allDryRunsCompletedBeforeMutation: true,
    });
    expect(proof.preservation.preservedAfterRollback).toBe(true);
    expect(proof.payloadUnchangedAfterRollback).toBe(true);
    expect(proof.safeTemporaryRoot.removed).toBe(true);
    expect(proof.externalMutation).toBe(false);
  }, 180_000);
});
