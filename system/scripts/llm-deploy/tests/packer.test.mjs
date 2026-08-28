#!/usr/bin/env bun
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const cleanup = [];
afterAll(() => { while (cleanup.length) rmSync(cleanup.pop(), { recursive: true, force: true }); });
const deployRoot = path.resolve(import.meta.dir, '..');
const productionSourceRoot = path.resolve(deployRoot, '..', '..');
const packerPath = path.join(deployRoot, 'pack-orangefive-llm-deploy.ps1');
const clonePackerPath = path.join(deployRoot, 'package-current-source-from-clean-clone.ps1');
const verifierPath = path.join(productionSourceRoot, 'scripts', 'verify-orangefive-source-package.ps1');

function write(root, relative, value = 'fixture\n') {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, value, 'utf8');
}

function copyProduction(root, relative) {
  write(root, relative, readFileSync(path.join(productionSourceRoot, relative), 'utf8'));
}

function writeCurrentSourceContracts(sourceRoot) {
  for (const name of [
    'source-package-manifest.json', 'discovery-plans.json', 'lifecycle-manifest.json',
    'rollback-manifest.json', 'model-acquisition-manifest.json', 'soul-genome.public.json',
  ]) copyProduction(sourceRoot, `00-CHARTER/LLM-DEPLOY/${name}`);
  write(sourceRoot, 'scripts/verify-orangefive-source-package.ps1', readFileSync(verifierPath, 'utf8'));
  write(sourceRoot, 'scripts/llm-deploy/package-current-source-from-clean-clone.ps1', readFileSync(clonePackerPath, 'utf8'));
  for (const relative of [
    'AGENTS.md', 'LICENSE', 'NOTICE', 'LICENSES/source-license-manifest.json',
    'ORANGE_UPSTREAM.md', 'package.json', 'src-tauri/src/main.rs', 'web-app/src/main.tsx',
  ]) write(sourceRoot, `ATOMICORANGE/${relative}`, relative.endsWith('.json') ? '{}\n' : `fixture ${relative}\n`);
}

function runPacker(script, sourceRoot, destinationRoot, { skipReleaseProof = true, requireCleanSource = false, expectedCommit = null } = {}) {
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-SourceRoot', sourceRoot, '-DestinationRoot', destinationRoot,
    ...(skipReleaseProof ? ['-SkipReleaseProof'] : []),
    ...(requireCleanSource ? ['-RequireCleanSource'] : []),
    ...(expectedCommit ? ['-ExpectedCommit', expectedCommit] : []),
  ], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  return { ...result, output: `${result.stdout || ''}\n${result.stderr || ''}`.trim() };
}

function git(root, ...args) {
  return spawnSync('git.exe', ['-C', root, ...args], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Orange Test', GIT_AUTHOR_EMAIL: 'orange@example.invalid', GIT_COMMITTER_NAME: 'Orange Test', GIT_COMMITTER_EMAIL: 'orange@example.invalid' },
  });
}

describe('OrangeFive deterministic source packer', () => {
  test('repeats byte-identically and blocks high-confidence credential material', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'orangefive-packer-test-'));
    cleanup.push(root);
    const sourceRoot = path.join(root, 'source');
    const outputRoot = path.join(root, 'output');
    const packer = packerPath;
    const manifest = {
      schema: 'orange.deploy.manifest.v1', product: 'Orange', release: 'OrangeFive',
      excluded: ['credentials', 'runtime state', 'model weights'],
    };
    write(sourceRoot, 'ORANGE_START.cmd');
    write(sourceRoot, '00-CHARTER/LLM-DEPLOY/INSTALL_ORANGE.md');
    write(sourceRoot, '00-CHARTER/LLM-DEPLOY/orangefive.deploy.json', JSON.stringify(manifest));
    write(sourceRoot, '00-CHARTER/LLM-DEPLOY/model-acquisition-catalog.json', '{}');
    writeCurrentSourceContracts(sourceRoot);
    for (const name of ['orange-deploy.mjs', 'deploy-core.mjs', 'deploy-probes.mjs', 'deploy-runtime.mjs', 'deploy-downloads.mjs', 'deploy-clients.mjs']) {
      write(sourceRoot, `scripts/llm-deploy/${name}`);
    }
    write(sourceRoot, 'scripts/llm-deploy/pack-orangefive-llm-deploy.ps1', readFileSync(packer, 'utf8'));
    write(sourceRoot, 'scripts/llm-deploy/prove-orangefive-llm-deploy.mjs');
    write(sourceRoot, '03-BACKEND/runtime.mjs', 'export const release = "OrangeFive";\n');
    write(sourceRoot, 'ATOMICORANGE/models/not-in-payload.safetensors', 'model bytes must stay out\n');
    write(sourceRoot, '05-FLOW/state/runtime.json', '{"must":"not-package"}\n');
    write(sourceRoot, '.env', 'SHOULD_NOT_PACKAGE=1\n');

    const first = runPacker(packer, sourceRoot, outputRoot);
    if (first.status !== 0) throw new Error(first.output);
    expect(first.status).toBe(0);
    const firstReport = JSON.parse(first.stdout);
    const second = runPacker(packer, sourceRoot, outputRoot);
    expect(second.status).toBe(0);
    const secondReport = JSON.parse(second.stdout);
    expect(secondReport.zipSha256).toBe(firstReport.zipSha256);
    expect(secondReport.credentialScan).toBe('passed');
    expect(secondReport.archiveVerification).toBe('passed');
    expect(secondReport.sourceSnapshotVerified).toBe(true);
    expect(path.basename(secondReport.zipPath)).toBe('Orange-AI-Computer-Wave-4A-Green.zip');
    expect(path.basename(secondReport.receiptPath)).toBe('Orange-AI-Computer-Wave-4A-Green.report.json');
    expect(path.basename(secondReport.inventoryPath)).toBe('Orange-AI-Computer-Wave-4A-Green.inventory.json');
    expect(path.basename(secondReport.sourceVerificationPath)).toBe('Orange-AI-Computer-Wave-4A-Green.verification.json');
    expect(secondReport.sourceTreeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(secondReport.inventorySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(secondReport.atomicOrange.fileCount).toBeGreaterThan(0);
    const inventory = JSON.parse(readFileSync(secondReport.inventoryPath, 'utf8'));
    expect(inventory.files.some((file) => file.path === 'ATOMICORANGE/web-app/src/main.tsx')).toBe(true);
    expect(inventory.files.some((file) => file.path.endsWith('.safetensors'))).toBe(false);
    const verification = JSON.parse(readFileSync(secondReport.sourceVerificationPath, 'utf8'));
    expect(verification.status).toBe('VERIFIED');
    expect(verification.contracts.modelAcquisition.weightsExcluded).toBe(true);

    const fakeToken = `ghp_${'A'.repeat(40)}`;
    write(sourceRoot, '03-BACKEND/leak.txt', `LEAK=${fakeToken}\n`);
    const blocked = runPacker(packer, sourceRoot, outputRoot);
    expect(blocked.status).not.toBe(0);
    expect(blocked.output).toContain('Credential scan blocked 03-BACKEND/leak.txt');
  }, 240_000);

  test('packages one exact commit from a clean detached clone and rejects a dirty source repository', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'orangefive-clean-clone-test-'));
    cleanup.push(root);
    const repositoryRoot = path.join(root, 'repository');
    const sourceRoot = path.join(repositoryRoot, 'system');
    const outputRoot = path.join(root, 'output');
    mkdirSync(repositoryRoot, { recursive: true });
    const manifest = {
      schema: 'orange.deploy.manifest.v1', product: 'Orange', release: 'OrangeFive',
      excluded: ['credentials', 'runtime state', 'model weights'],
    };
    write(sourceRoot, 'ORANGE_START.cmd');
    write(sourceRoot, '00-CHARTER/LLM-DEPLOY/INSTALL_ORANGE.md');
    write(sourceRoot, '00-CHARTER/LLM-DEPLOY/orangefive.deploy.json', JSON.stringify(manifest));
    write(sourceRoot, '00-CHARTER/LLM-DEPLOY/model-acquisition-catalog.json', '{}');
    writeCurrentSourceContracts(sourceRoot);
    for (const name of ['orange-deploy.mjs', 'deploy-core.mjs', 'deploy-probes.mjs', 'deploy-runtime.mjs', 'deploy-downloads.mjs', 'deploy-clients.mjs']) {
      write(sourceRoot, `scripts/llm-deploy/${name}`);
    }
    write(sourceRoot, 'scripts/llm-deploy/pack-orangefive-llm-deploy.ps1', readFileSync(packerPath, 'utf8'));
    write(sourceRoot, 'scripts/llm-deploy/prove-orangefive-llm-deploy.mjs');

    expect(git(repositoryRoot, 'init', '--quiet').status).toBe(0);
    expect(git(repositoryRoot, 'add', '--all').status).toBe(0);
    expect(git(repositoryRoot, 'commit', '--quiet', '-m', 'fixture source').status).toBe(0);
    const commit = git(repositoryRoot, 'rev-parse', 'HEAD').stdout.trim();
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', clonePackerPath,
      '-RepositoryRoot', repositoryRoot, '-DestinationRoot', outputRoot, '-SkipReleaseProof',
    ], { encoding: 'utf8', windowsHide: true, timeout: 240_000 });
    expect(`${result.stdout}\n${result.stderr}`).toBeTruthy();
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe('VERIFIED');
    expect(report.source.commit).toBe(commit);
    expect(report.deterministicRepeat.verified).toBe(true);
    expect(report.package.releaseProofStatus).toBe('SKIPPED_BY_EXPLICIT_SWITCH');
    expect(path.basename(report.package.zipPath)).toBe('Orange-AI-Computer-Wave-4A-Green.zip');
    expect(path.basename(report.receiptPath)).toBe('Orange-AI-Computer-Wave-4A-Green.clean-clone-report.json');

    write(repositoryRoot, 'dirty.txt', 'dirty\n');
    const blocked = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', clonePackerPath,
      '-RepositoryRoot', repositoryRoot, '-DestinationRoot', outputRoot, '-SkipReleaseProof',
    ], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    expect(blocked.status).not.toBe(0);
    expect(`${blocked.stdout}\n${blocked.stderr}`).toContain('requires a clean source repository');
  }, 300_000);

  test('proves an extracted package through apply, readiness, and rollback in a temporary root', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'orangefive-packer-proof-test-'));
    cleanup.push(root);
    const sourceRoot = path.join(root, 'source');
    const outputRoot = path.join(root, 'output');
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
    writeCurrentSourceContracts(sourceRoot);
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
    if (result.status !== 0) throw new Error(result.output);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.extractedReleaseProof).toBe('PROVEN');
    expect(path.basename(report.proofReceiptPath)).toBe('Orange-AI-Computer-Wave-4A-Green.release-proof.json');
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
