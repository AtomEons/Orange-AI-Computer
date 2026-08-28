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
    expect(packer).toContain("Sort-Object path");
    expect(packer).toContain("if (Test-ContainedPath $DestinationRoot $SourceRoot)");
    expect(packer).toContain("'node_modules'");
    expect(packer).toContain("'10-RECEIPTS'");
    expect(packer).toContain('Find-HighConfidenceCredential');
    expect(packer).toContain('deploy-downloads.mjs');
    expect(packer).toContain('archiveVerification');
    expect(packer).toContain('prove-orangefive-llm-deploy.mjs');
    expect(packer).toContain('extractedReleaseProof');
    expect(releaseProof).toContain('verifyPayloadLock');
    expect(releaseProof).toContain("status: 'PROVEN'");
    expect(releaseProof).toContain("status !== 'ROLLED_BACK'");
    expect(manifest.models.acquisitionCatalog).toBe('00-CHARTER/LLM-DEPLOY/model-acquisition-catalog.json');
  });

});
