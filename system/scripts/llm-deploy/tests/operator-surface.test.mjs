#!/usr/bin/env bun
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const deployRoot = path.resolve(import.meta.dir, '..');
const sourceRoot = path.resolve(deployRoot, '..', '..');
const launcher = readFileSync(path.join(sourceRoot, 'ORANGE_START.cmd'), 'utf8');
const packer = readFileSync(path.join(deployRoot, 'pack-orangefive-llm-deploy.ps1'), 'utf8');
const releaseProof = readFileSync(path.join(deployRoot, 'prove-orangefive-llm-deploy.mjs'), 'utf8');
const cli = readFileSync(path.join(deployRoot, 'orange-deploy.mjs'), 'utf8');
const installGuide = readFileSync(path.join(sourceRoot, '00-CHARTER', 'LLM-DEPLOY', 'INSTALL_ORANGE.md'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(sourceRoot, '00-CHARTER', 'LLM-DEPLOY', 'orangefive.deploy.json'), 'utf8'));
const sourcePackageManifest = JSON.parse(readFileSync(path.join(sourceRoot, '00-CHARTER', 'LLM-DEPLOY', 'source-package-manifest.json'), 'utf8'));
const sourceVerifier = readFileSync(path.join(sourceRoot, 'scripts', 'verify-orangefive-source-package.ps1'), 'utf8');
const currentSourceWorkflow = readFileSync(path.resolve(sourceRoot, '..', '.github', 'workflows', 'orange-ai-computer-current-source.yml'), 'utf8');

describe('OrangeFive deploy operator surface', () => {
  test('launcher plans by default and never manufactures approval', () => {
    expect(launcher).toContain('orange-deploy.mjs discover');
    expect(launcher).toContain('orange-deploy.mjs plan');
    expect(launcher).toContain('apply --approve ^<plan-sha256^>');
    expect(launcher).not.toContain('apply --approve %');
    expect(launcher).toContain('--version 1.2.0');
  });

  test('CLI exposes the five governed commands and requires apply approval', () => {
    for (const command of ['discover', 'plan', 'apply', 'status', 'rollback']) expect(cli).toContain(`'${command}'`);
    expect(cli).toContain('if (!options.approve)');
    expect(cli).toContain('approvalHash: options.approve');
    expect(cli).toContain('modelApprovalHash: options.approveModels');
    expect(cli).toContain("options.fixture && process.env.ORANGE5_DEPLOY_TEST_MODE !== '1'");
    expect(installGuide).toContain('--approve-models <model-set-sha256>');
    expect(manifest.agentEntrypoint.command).toBe('bun scripts/llm-deploy/orange-deploy.mjs');
  });

  test('packer is reproducible and emits an embedded payload lock outside source', () => {
    expect(packer).toContain("schema = 'orangefive.payload-lock.v1'");
    expect(packer).toContain("$fixedTime = [DateTimeOffset]::new(2000, 1, 1");
    expect(packer).toContain('Sort-RecordsOrdinal');
    expect(packer).toContain("if (Test-ContainedPath $DestinationRoot $SourceRoot)");
    expect(packer).toContain("'node_modules'");
    expect(packer).toContain("'10-RECEIPTS'");
    expect(packer).toContain('Find-HighConfidenceCredential');
    expect(sourcePackageManifest.requiredPaths).toContain('scripts/llm-deploy/deploy-downloads.mjs');
    expect(packer).toContain('archiveVerification');
    expect(packer).toContain('prove-orangefive-llm-deploy.mjs');
    expect(packer).toContain('extractedReleaseProof');
    expect(packer).toContain('Get-GitSourceProvenance');
    expect(packer).toContain('orangefive.current-source-inventory.v1');
    expect(packer).not.toContain("'02-ATOMIC-ORANGE-V1', 'ATOMICORANGE'");
    expect(releaseProof).toContain('verifyPayloadLock');
    expect(releaseProof).toContain("status: 'PROVEN'");
    expect(releaseProof).toContain("status !== 'ROLLED_BACK'");
    expect(manifest.models.acquisitionCatalog).toBe('00-CHARTER/LLM-DEPLOY/model-acquisition-catalog.json');
    expect(sourcePackageManifest.releaseName).toBe('Orange-AI-Computer-Wave-4A-Green');
    expect(sourcePackageManifest.tagName).toBe('Orange-AI-Computer-Wave-4A-Green');
    expect(sourcePackageManifest.archive.name).toBe('Orange-AI-Computer-Wave-4A-Green.zip');
    expect(sourcePackageManifest.requiredPaths).toContain('ATOMICORANGE/src-tauri/src/main.rs');
    expect(sourcePackageManifest.requiredPaths).toContain('scripts/verify-orangefive-source-package.ps1');
    expect(manifest.package.outputs.every((name) => name.startsWith('Orange-AI-Computer-Wave-4A-Green'))).toBe(true);
    expect(sourceVerifier).toContain("status = 'VERIFIED'");
    expect(sourceVerifier).toContain('weightsExcluded = $true');
  });

  test('Windows current-source CI covers packaging, repaired Brain MCP, and Atomic Orange without publishing', () => {
    expect(currentSourceWorkflow).toContain('package-and-verify:');
    expect(currentSourceWorkflow).toContain('brain-mcp-ae-staff:');
    expect(currentSourceWorkflow).toContain('atomic-orange-contract:');
    expect(currentSourceWorkflow).toContain('orange5-brain-mcp-ae-staff.test.mjs');
    expect(currentSourceWorkflow).toContain('corepack yarn install --immutable');
    expect(currentSourceWorkflow).toContain('corepack yarn test:contracts');
    expect(currentSourceWorkflow).toContain('cargo check --locked');
    expect(currentSourceWorkflow).not.toContain('actions/upload-artifact');
    expect(currentSourceWorkflow).not.toContain('gh release');
    expect(currentSourceWorkflow).not.toContain('npm publish');
  });

});
