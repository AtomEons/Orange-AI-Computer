#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPlan,
  defaultDataRoot,
  deployPaths,
  hashObject,
  mergeCatalogAcquisition,
  readJson,
  sanitizeRoleList,
  sha256,
  writeJsonAtomic,
} from './deploy-core.mjs';
import { discoverDeployment } from './deploy-probes.mjs';
import { applyApprovedPlan, deploymentStatus, rollbackDeployment } from './deploy-runtime.mjs';

function parseArguments(argv) {
  const command = argv[0] || 'help';
  const options = { select: [], deselect: [] };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--no-optional') { options.deselectAll = true; continue; }
    if (token === '--help' || token === '-h') { options.help = true; continue; }
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    const value = argv[index + 1];
    if (value == null || value.startsWith('--')) throw new Error(`Missing value for ${token}`);
    index += 1;
    if (key === 'select' || key === 'deselect') options[key].push(...sanitizeRoleList(value));
    else options[key] = value;
  }
  return { command, options };
}

function roots(options) {
  const scriptPath = fileURLToPath(import.meta.url);
  const sourceRoot = path.resolve(options.sourceRoot || path.join(path.dirname(scriptPath), '..', '..'));
  const dataRoot = path.resolve(options.dataRoot || defaultDataRoot());
  return { sourceRoot, dataRoot, paths: deployPaths(dataRoot) };
}

function loadInputs(sourceRoot) {
  const manifestPath = path.join(sourceRoot, '00-CHARTER', 'LLM-DEPLOY', 'orangefive.deploy.json');
  if (!existsSync(manifestPath)) throw new Error(`Deploy manifest not found: ${manifestPath}`);
  const manifest = readJson(manifestPath);
  const catalogPath = path.resolve(sourceRoot, manifest.models.catalog);
  if (!existsSync(catalogPath)) throw new Error(`Model catalog not found: ${catalogPath}`);
  const baseCatalog = readJson(catalogPath);
  const acquisitionPath = manifest.models?.acquisitionCatalog
    ? path.resolve(sourceRoot, manifest.models.acquisitionCatalog)
    : null;
  if (!acquisitionPath) return { manifest, catalog: baseCatalog };
  if (!existsSync(acquisitionPath)) throw new Error(`Model acquisition catalog not found: ${acquisitionPath}`);
  const catalog = mergeCatalogAcquisition(baseCatalog, readJson(acquisitionPath), {
    sourceCatalogSha256: sha256(readFileSync(catalogPath)),
  });
  return { manifest, catalog };
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeStageReceipt(paths, kind, payload) {
  const createdAt = payload.generatedAt || new Date().toISOString();
  const contentSha256 = hashObject(payload);
  const stamp = createdAt.replace(/[:.]/g, '-');
  const receiptPath = path.join(paths.receipts, `${kind}-${stamp}-${contentSha256.slice(0, 12)}.json`);
  writeJsonAtomic(receiptPath, {
    schema: 'orange.deploy.stage-receipt.v1',
    kind,
    createdAt,
    contentSha256,
    payload,
  });
  return receiptPath;
}

function printHelp() {
  process.stdout.write(`OrangeFive deterministic LLM deploy engine

Commands:
  install [--topology MODE] [--profile PROFILE] [--storage PATH]
          [--select ROLE[,ROLE]] [--deselect ROLE[,ROLE]] [--no-optional]
  discover [--data-root PATH] [--timeout MS]
  plan [--topology MODE] [--profile PROFILE] [--storage PATH]
       [--select ROLE[,ROLE]] [--deselect ROLE[,ROLE]] [--no-optional]
  apply --approve PLAN_SHA256 [--approve-models MODEL_SET_SHA256]
  status
  rollback

All generated state, action ledgers, and receipts live outside the payload under
%USERPROFILE%\\OrangeBox-Data\\orange5\\deploy by default. Apply always runs and
records every dry-run preflight before its first mutating action.
`);
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command === 'help' || options.help) { printHelp(); return; }
  if (!['install', 'discover', 'plan', 'apply', 'status', 'rollback'].includes(command)) throw new Error(`Unknown command: ${command}`);
  if (options.fixture && process.env.ORANGE5_DEPLOY_TEST_MODE !== '1') {
    throw new Error('--fixture is available only when ORANGE5_DEPLOY_TEST_MODE=1; production discovery and readiness require live probes.');
  }
  const requested = roots(options);

  if (command === 'install') {
    const { manifest, catalog } = loadInputs(requested.sourceRoot);
    const discovery = await discoverDeployment({
      sourceRoot: requested.sourceRoot,
      dataRoot: requested.dataRoot,
      manifest,
      catalog,
      fixture: options.fixture,
      timeoutMs: Math.max(100, Math.min(10_000, Number(options.timeout || 900))),
    });
    const documentedDiscovery = { ...discovery, receiptPath: writeStageReceipt(requested.paths, 'discovery', discovery) };
    writeJsonAtomic(requested.paths.discovery, documentedDiscovery);
    const plan = buildPlan({
      discovery: documentedDiscovery,
      manifest,
      selections: {
        topology: options.topology,
        profile: options.profile,
        storage: options.storage,
        select: options.select,
        deselect: options.deselect,
        deselectAll: options.deselectAll,
      },
    });
    const documentedPlan = { ...plan, receiptPath: writeStageReceipt(requested.paths, 'plan', plan) };
    writeJsonAtomic(requested.paths.plan, documentedPlan);
    const freshDiscovery = await discoverDeployment({
      sourceRoot: plan.sourceRoot,
      dataRoot: plan.dataRoot,
      manifest,
      catalog,
      fixture: options.fixture,
      timeoutMs: Math.max(100, Math.min(10_000, Number(options.timeout || 900))),
    });
    const report = await applyApprovedPlan({
      plan: documentedPlan,
      approvalHash: plan.planSha256,
      modelApprovalHash: plan.modelSetSha256 || null,
      paths: deployPaths(plan.dataRoot),
      freshDiscovery,
    });
    const readinessDiscovery = await discoverDeployment({
      sourceRoot: plan.sourceRoot,
      dataRoot: plan.dataRoot,
      manifest,
      catalog,
      fixture: options.fixture,
      timeoutMs: Math.max(100, Math.min(10_000, Number(options.timeout || 900))),
    });
    const readiness = await deploymentStatus({
      plan: documentedPlan,
      paths: deployPaths(plan.dataRoot),
      freshDiscovery: readinessDiscovery,
    });
    print({
      schema: 'orange.deploy.install-result.v1',
      status: readiness.ready ? 'READY' : 'NEEDS_ACTION',
      authorization: 'install-command-invocation',
      discovery: documentedDiscovery,
      plan: documentedPlan,
      apply: report,
      readiness,
    });
    if (!readiness.ready) process.exitCode = 2;
    return;
  }

  if (command === 'discover') {
    const { manifest, catalog } = loadInputs(requested.sourceRoot);
    const discovery = await discoverDeployment({
      sourceRoot: requested.sourceRoot,
      dataRoot: requested.dataRoot,
      manifest,
      catalog,
      fixture: options.fixture,
      timeoutMs: Math.max(100, Math.min(10_000, Number(options.timeout || 900))),
    });
    const documented = { ...discovery, receiptPath: writeStageReceipt(requested.paths, 'discovery', discovery) };
    writeJsonAtomic(requested.paths.discovery, documented);
    print(documented);
    return;
  }

  if (!existsSync(requested.paths.discovery) && command === 'plan') {
    throw new Error(`Discovery is required first: bun scripts/llm-deploy/orange-deploy.mjs discover`);
  }

  if (command === 'plan') {
    const discovery = readJson(requested.paths.discovery);
    const { manifest } = loadInputs(discovery.sourceRoot);
    const plan = buildPlan({
      discovery,
      manifest,
      selections: {
        topology: options.topology,
        profile: options.profile,
        storage: options.storage,
        select: options.select,
        deselect: options.deselect,
        deselectAll: options.deselectAll,
      },
    });
    const documented = { ...plan, receiptPath: writeStageReceipt(requested.paths, 'plan', plan) };
    writeJsonAtomic(requested.paths.plan, documented);
    print(documented);
    return;
  }

  if (!existsSync(requested.paths.plan)) {
    if (command === 'status') {
      const receiptPath = path.join(requested.paths.receipts, 'readiness-not-planned.json');
      const report = {
        schema: 'orange.deploy.readiness.v1',
        status: 'NOT_PLANNED',
        ready: false,
        product: 'Orange',
        release: 'OrangeFive',
        blockers: [{ code: 'PLAN_NOT_FOUND', evidence: requested.paths.plan }],
        receiptPath,
      };
      writeJsonAtomic(receiptPath, report);
      print(report);
      process.exitCode = 2;
      return;
    }
    throw new Error(`No approved-plan candidate exists at ${requested.paths.plan}. Run discover and plan first.`);
  }
  const plan = readJson(requested.paths.plan);
  const planPaths = deployPaths(plan.dataRoot);
  const { manifest, catalog } = loadInputs(plan.sourceRoot);

  if (command === 'rollback') {
    print(await rollbackDeployment({ plan, paths: planPaths }));
    return;
  }

  const freshDiscovery = await discoverDeployment({
    sourceRoot: plan.sourceRoot,
    dataRoot: plan.dataRoot,
    manifest,
    catalog,
    fixture: options.fixture,
    timeoutMs: Math.max(100, Math.min(10_000, Number(options.timeout || 900))),
  });

  if (command === 'apply') {
    if (!options.approve) throw new Error(`Explicit approval is required: apply --approve ${plan.planSha256}`);
    if (plan.approval?.explicitModelSetApproval && !options.approveModels) {
      throw new Error(`Explicit model approval is required. Run exactly: ${plan.approvalCommand}`);
    }
    const report = await applyApprovedPlan({
      plan,
      approvalHash: options.approve,
      modelApprovalHash: options.approveModels,
      paths: planPaths,
      freshDiscovery,
    });
    const readinessDiscovery = await discoverDeployment({
      sourceRoot: plan.sourceRoot,
      dataRoot: plan.dataRoot,
      manifest,
      catalog,
      fixture: options.fixture,
      timeoutMs: Math.max(100, Math.min(10_000, Number(options.timeout || 900))),
    });
    const readiness = await deploymentStatus({ plan, paths: planPaths, freshDiscovery: readinessDiscovery });
    print({ ...report, readiness });
    if (!readiness.ready) process.exitCode = 2;
    return;
  }

  const report = await deploymentStatus({ plan, paths: planPaths, freshDiscovery });
  print(report);
  if (!report.ready) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ schema: 'orange.deploy.error.v1', status: 'BLOCKED', error: error.message }, null, 2)}\n`);
  process.exitCode = 1;
});
