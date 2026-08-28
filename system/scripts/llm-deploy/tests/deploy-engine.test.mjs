#!/usr/bin/env bun
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildDiscovery,
  buildPlan,
  deployPaths,
  planHash,
  verifyDiscoveryHash,
  verifyModelSet,
  verifyPlan,
  writeJsonAtomic,
} from '../deploy-core.mjs';
import {
  applyApprovedPlan,
  deploymentStatus,
  readLedger,
  rollbackDeployment,
} from '../deploy-runtime.mjs';

const cleanup = [];

function temporaryRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'orangefive-deploy-test-'));
  cleanup.push(root);
  return root;
}

function write(root, relative, content = 'fixture\n') {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
  return target;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function writePayloadLock(sourceRoot) {
  const rows = [];
  const visit = (relativeRoot = '') => {
    for (const entry of readdirSync(path.join(sourceRoot, relativeRoot), { withFileTypes: true })) {
      const relative = path.join(relativeRoot, entry.name);
      if (entry.isDirectory()) visit(relative);
      else if (entry.isFile() && relative !== 'orangefive.payload.lock.json') {
        const bytes = readFileSync(path.join(sourceRoot, relative));
        rows.push({ path: relative.replaceAll('\\', '/'), bytes: bytes.length, sha256: sha256(bytes) });
      }
    }
  };
  visit();
  rows.sort((left, right) => left.path.localeCompare(right.path));
  write(sourceRoot, 'orangefive.payload.lock.json', `${JSON.stringify({
    schema: 'orangefive.payload-lock.v1',
    product: 'Orange',
    release: 'OrangeFive',
    hashAlgorithm: 'sha256',
    fileCount: rows.length,
    files: rows,
  }, null, 2)}\n`);
}

function fixture() {
  const root = temporaryRoot();
  const sourceRoot = path.join(root, 'payload');
  const dataRoot = path.join(root, 'state');
  const modelPath = path.join(root, 'models', 'visual.bin');
  mkdirSync(sourceRoot, { recursive: true });
  write(root, path.relative(root, modelPath), '1234');
  const manifest = {
    schema: 'orange.deploy.manifest.v1',
    product: 'Orange',
    release: 'OrangeFive',
    payload: { immutable: true },
    topologies: { preferred: 'control-plus-compute', supported: ['single-computer', 'control-plus-compute'] },
    approval: { requiredBeforeMutation: true, bindsPlanSha256: true },
    runtimes: [
      { id: 'bun', required: true, minimum: '1.2.0', windowsPackageId: 'Oven-sh.Bun' },
      { id: 'ollama', requiredForLocalModels: true, windowsPackageId: 'Ollama.Ollama' },
      { id: 'hermes-agent', requiredOnComputeNode: true, version: '0.20.5', tag: 'v2026.8.19', commit: 'fcbd1076a93841fa88855acce810e342a5b78101', overlay: '08-HERMES/product-integration' },
    ],
    hermes: {
      gatewayOwners: 1,
      dispatchers: 1,
      swarmgate: true,
      swarmSentinel: true,
      hardwareProfiles: {
        compact: { minimumRamGiB: 8, immediateWorkers: 2 },
        balanced: { minimumRamGiB: 24, immediateWorkers: 4 },
        codexa: { minimumRamGiB: 64, immediateWorkers: 6 },
      },
    },
    models: { catalog: '14-SUPERSTACK/captain-planet-stack.json' },
    downloads: { minimumFreeReserveGiB: 10 },
    configuration: {
      orangeFiveClientInstaller: '03-BACKEND/install-orange5-clients.mjs',
      brainMcpServer: '03-BACKEND/orange5-brain-mcp-server.mjs',
    },
  };
  const catalog = {
    schema: 'orange.model-superset.v1',
    roles: [
      {
        role: 'visual-ready',
        model: 'example/visual-ready',
        capability: 'image_generation',
        runtime: 'python_worker',
        estimated_live_bytes: 1024,
        availability: { lease_eligible: true, state: 'installed_runtime_proven' },
        required_artifacts: [{ path: modelPath, bytes: 4, sha256: sha256('1234') }],
        acquisition: {
          revision: 'immutable-revision-1',
          url: 'https://models.example.invalid/visual.bin',
          filename: 'visual.bin',
          bytes: 4,
          sha256: sha256('1234'),
        },
        license: 'fixture-license',
        redistribution: 'operator-download-permitted',
        provenanceStatus: 'verified-local-artifact',
        provenanceBlockers: [],
        provenanceEvidence: { receiptSha256: 'b'.repeat(64) },
        runtimeProvisioning: 'installer-proven',
        source: 'https://example.invalid/visual-ready',
      },
      {
        role: 'candidate-only',
        model: 'example/candidate',
        capability: 'video_generation',
        runtime: 'python_worker',
        availability: { lease_eligible: false, state: 'candidate_not_observed' },
        required_artifacts: [],
        source: 'https://example.invalid/candidate',
      },
    ],
  };

  write(sourceRoot, '00-CHARTER/LLM-DEPLOY/INSTALL_ORANGE.md');
  write(sourceRoot, '00-CHARTER/LLM-DEPLOY/orangefive.deploy.json', JSON.stringify(manifest));
  write(sourceRoot, manifest.models.catalog, JSON.stringify(catalog));
  write(sourceRoot, '08-HERMES/product-integration/upstream.lock.json');
  write(sourceRoot, '08-HERMES/product-integration/integration.manifest.json');
  write(sourceRoot, '08-HERMES/product-integration/scripts/install-hermes-product.ps1');
  write(sourceRoot, '08-HERMES/product-integration/scripts/materialize-config.ps1');
  write(sourceRoot, '08-HERMES/product-integration/scripts/start-owner.ps1');
  write(sourceRoot, '08-HERMES/product-integration/scripts/preflight.ps1');
  write(sourceRoot, '03-BACKEND/install-orange5-clients.mjs');
  write(sourceRoot, '03-BACKEND/orange5-brain-mcp-server.mjs');
  write(sourceRoot, '03-BACKEND/client-skills/orange5/SKILL.md');
  write(sourceRoot, '03-BACKEND/client-skills/orangebox-primer/SKILL.md');
  write(sourceRoot, 'scripts/llm-deploy/orange-deploy.mjs');
  write(sourceRoot, 'ORANGE_START.cmd');
  write(sourceRoot, 'docs/release-note.txt', 'full-lock-only fixture\n');
  writePayloadLock(sourceRoot);

  const observed = {
    control: {
      hostname: 'N150',
      platform: 'win32',
      arch: 'x64',
      ramBytes: 32 * (1024 ** 3),
      logicalCores: 8,
      userProfile: 'C:\\Users\\a',
      disk: { path: 'C:\\', totalBytes: 512 * (1024 ** 3), availableBytes: 256 * (1024 ** 3) },
    },
    compute: null,
    topologyEvidence: 'deterministic-test-fixture',
    components: {
      bun: { found: true, compatible: true, version: '1.3.14', executable: 'bun.exe', node: 'control' },
      ollama: { found: false, compatible: false, node: 'control' },
      'hermes-agent': { found: true, compatible: true, version: '0.20.5', executable: 'hermes.exe', node: 'control' },
    },
    models: {
      'visual-ready': {
        artifacts: [{ path: modelPath, exists: true, bytes: 4 }],
        checksums: [{ path: modelPath, exists: true, bytes: 4, sha256: sha256('1234') }],
        evidence: 'fixture-artifact-proof-with-sha256',
      },
      'candidate-only': { artifacts: [], evidence: 'fixture-candidate' },
    },
  };
  return { root, sourceRoot, dataRoot, modelPath, manifest, catalog, observed };
}

function discoveryFor(fx, overrides = {}) {
  return buildDiscovery({
    sourceRoot: fx.sourceRoot,
    dataRoot: fx.dataRoot,
    manifest: fx.manifest,
    catalog: fx.catalog,
    observed: { ...fx.observed, ...overrides },
    generatedAt: '2026-08-26T00:00:00.000Z',
  });
}

afterAll(() => {
  for (const root of cleanup) {
    if (root.startsWith(os.tmpdir()) && path.basename(root).startsWith('orangefive-deploy-test-')) rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

describe('OrangeFive deterministic deploy planning', () => {
  test('discovery and plan hashes exclude timestamps but bind payload and choices', () => {
    const fx = fixture();
    const first = discoveryFor(fx);
    const second = buildDiscovery({ ...fx, generatedAt: '2030-01-01T00:00:00.000Z' });
    expect(first.discoverySha256).toBe(second.discoverySha256);
    expect(verifyDiscoveryHash(first).ok).toBe(true);

    const firstPlan = buildPlan({ discovery: first, manifest: fx.manifest, generatedAt: '2026-08-26T01:00:00.000Z' });
    const secondPlan = buildPlan({ discovery: second, manifest: fx.manifest, generatedAt: '2030-01-01T01:00:00.000Z' });
    expect(firstPlan.planSha256).toBe(secondPlan.planSha256);
    expect(verifyPlan(firstPlan).ok).toBe(true);
    expect(verifyPlan(JSON.parse(JSON.stringify(firstPlan))).ok).toBe(true);
    expect(firstPlan.hermes.profile).toBe('balanced');
    expect(firstPlan.optionalModels.find((item) => item.role === 'visual-ready').selected).toBe(true);
    expect(firstPlan.optionalModels.find((item) => item.role === 'candidate-only').selected).toBe(false);
    expect(firstPlan.approval.explicitModelSetApproval).toBe(true);
    expect(firstPlan.approvalCommand).toContain(`--approve-models ${firstPlan.approval.modelSetSha256}`);
    expect(firstPlan.executable).toBe(true);
  }, 60_000);

  test('trusted two-node hardware selects Codexa posture and external compute state', () => {
    const fx = fixture();
    const discovery = discoveryFor(fx, {
      compute: {
        hostname: 'CODEXA',
        host: '10.0.0.4',
        online: true,
        trusted: true,
        ramBytes: 96 * (1024 ** 3),
        logicalCores: 24,
        userProfile: 'C:\\Users\\Atom',
        hardwareProbe: 'ssh-cim-live',
      },
    });
    const plan = buildPlan({ discovery, manifest: fx.manifest });
    expect(discovery.topology.mode).toBe('control-plus-compute');
    expect(plan.hermes.profile).toBe('codexa');
    expect(plan.storage.computeState).toBe('C:\\Users\\Atom\\OrangeBox-Data\\orange5');
    expect(plan.actions.some((item) => item.id === 'hermes.overlay.stage')).toBe(true);
    expect(plan.actions.find((item) => item.id === 'hermes.gateway.ensure').networkBinding).toBe('loopback-only');
  });

  test('operator can select N150 single-host without adopting Codexa inventory', () => {
    const fx = fixture();
    const controlComponents = structuredClone(fx.observed.components);
    controlComponents['hermes-agent'].executable = 'C:\\N150\\hermes.exe';
    const computeComponents = structuredClone(fx.observed.components);
    computeComponents['hermes-agent'].executable = 'C:\\Codexa\\hermes.exe';
    const discovery = discoveryFor(fx, {
      compute: {
        hostname: 'CODEXA', host: '10.0.0.4', online: true, trusted: true,
        ramBytes: 96 * (1024 ** 3), logicalCores: 24, userProfile: 'C:\\Users\\Atom', hardwareProbe: 'ssh-cim-live',
      },
      componentInventory: { control: controlComponents, compute: computeComponents },
      modelInventory: { control: fx.observed.models, compute: fx.observed.models },
    });
    const plan = buildPlan({ discovery, manifest: fx.manifest, selections: { topology: 'single-computer' } });
    expect(plan.topology.mode).toBe('single-computer');
    expect(plan.components['hermes-agent'].executable).toBe('C:\\N150\\hermes.exe');
    expect(plan.actions.find((item) => item.id === 'component.hermes-agent.adopt').target).toBe('control');
    expect(plan.storage.computeState).toBeNull();
  });

  test('a missing model becomes a resumable action only with pinned credential-free acquisition', () => {
    const fx = fixture();
    const body = 'approved-model-bytes';
    fx.catalog.roles[0].acquisition = {
      revision: 'immutable-revision-1',
      url: 'https://models.example.invalid/visual.bin?download=true',
      filename: 'visual.bin',
      bytes: Buffer.byteLength(body),
      sha256: 'a'.repeat(64),
    };
    fx.catalog.roles[0].required_artifacts[0] = { path: fx.modelPath, bytes: Buffer.byteLength(body), sha256: 'a'.repeat(64) };
    fx.catalog.roles[0].license = 'fixture-license';
    fx.catalog.roles[0].redistribution = 'operator-download-permitted';
    const observed = structuredClone(fx.observed);
    observed.models['visual-ready'].artifacts[0].exists = false;
    observed.models['visual-ready'].artifacts[0].bytes = null;
    observed.models['visual-ready'].checksums[0] = { path: fx.modelPath, exists: false, bytes: null, sha256: null };
    const discovery = discoveryFor(fx, observed);
    const plan = buildPlan({ discovery, manifest: fx.manifest });
    const action = plan.actions.find((item) => item.kind === 'model.download');
    expect(plan.executable).toBe(true);
    expect(action.method).toBe('native-fetch-http-range');
    expect(action.files[0].destination).toBe(path.join(fx.dataRoot, 'models', 'visual.bin'));
    expect(plan.downloads.find((item) => item.id === 'model:visual-ready').resumable).toBe(true);
  });

  test('missing default model blocks instead of inventing a download', () => {
    const fx = fixture();
    fx.catalog.roles[0].acquisition = null;
    const observed = structuredClone(fx.observed);
    observed.models['visual-ready'].artifacts[0].exists = false;
    observed.models['visual-ready'].artifacts[0].bytes = null;
    observed.models['visual-ready'].checksums[0] = { path: fx.modelPath, exists: false, bytes: null, sha256: null };
    const discovery = discoveryFor(fx, observed);
    const plan = buildPlan({ discovery, manifest: fx.manifest });
    expect(plan.executable).toBe(false);
    expect(plan.blockers.some((item) => item.code === 'MODEL_ACQUISITION_NOT_PINNED')).toBe(true);
    expect(plan.actions.some((item) => item.kind === 'model.download')).toBe(false);

    const deselected = buildPlan({ discovery, manifest: fx.manifest, selections: { deselect: ['visual-ready'] } });
    expect(deselected.executable).toBe(true);
  });

  test('explicitly blocks unverified provenance and adopt-only runtimes on a clean host', () => {
    const fx = fixture();
    fx.catalog.roles[0].provenanceStatus = 'blocked';
    fx.catalog.roles[0].provenanceBlockers = ['LICENSE_NOT_PROVEN'];
    const provenancePlan = buildPlan({ discovery: discoveryFor(fx), manifest: fx.manifest });
    expect(provenancePlan.blockers).toContainEqual(expect.objectContaining({ code: 'MODEL_PROVENANCE_UNVERIFIED' }));

    fx.catalog.roles[0].provenanceStatus = 'verified-local-artifact';
    fx.catalog.roles[0].provenanceBlockers = [];
    fx.catalog.roles[0].runtimeProvisioning = 'adopt-only';
    fx.catalog.roles[0].license = 'MIT';
    fx.catalog.roles[0].redistribution = 'upstream-download-only';
    fx.catalog.roles[0].acquisition = {
      revision: 'immutable-revision-1',
      url: 'https://models.example.invalid/visual.bin',
      filename: 'visual.bin',
      bytes: 4,
      sha256: sha256('1234'),
    };
    const observed = structuredClone(fx.observed);
    observed.models['visual-ready'].artifacts[0] = { path: fx.modelPath, exists: false, bytes: null };
    observed.models['visual-ready'].checksums[0] = { path: fx.modelPath, exists: false, bytes: null, sha256: null };
    const cleanPlan = buildPlan({ discovery: discoveryFor(fx, observed), manifest: fx.manifest });
    expect(cleanPlan.blockers).toContainEqual(expect.objectContaining({ code: 'MODEL_RUNTIME_ADOPT_ONLY' }));
    expect(cleanPlan.actions.some((action) => action.kind === 'model.download')).toBe(false);
  });

  test('blocks installed models unless provenance, license, and live checksums all pass', () => {
    const missingProvenance = fixture();
    missingProvenance.catalog.roles[0].provenanceStatus = null;
    let plan = buildPlan({ discovery: discoveryFor(missingProvenance), manifest: missingProvenance.manifest });
    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: 'MODEL_PROVENANCE_UNVERIFIED' }));
    expect(plan.actions.some((action) => action.kind === 'model.adopt')).toBe(false);

    const missingLicense = fixture();
    missingLicense.catalog.roles[0].license = null;
    plan = buildPlan({ discovery: discoveryFor(missingLicense), manifest: missingLicense.manifest });
    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: 'MODEL_LICENSE_UNRESOLVED' }));
    expect(plan.actions.some((action) => action.kind === 'model.adopt')).toBe(false);

    const checksumMismatch = fixture();
    checksumMismatch.observed.models['visual-ready'].checksums[0].sha256 = 'f'.repeat(64);
    plan = buildPlan({ discovery: discoveryFor(checksumMismatch), manifest: checksumMismatch.manifest });
    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: 'MODEL_CHECKSUM_MISMATCH' }));
    expect(plan.actions.some((action) => action.kind === 'model.adopt')).toBe(false);
  });
});

describe('OrangeFive approval, ledger, resume, readiness, and rollback', () => {
  test('wrong approval and payload tampering stop before action execution', async () => {
    const fx = fixture();
    const discovery = discoveryFor(fx);
    const plan = buildPlan({ discovery, manifest: fx.manifest });
    const paths = deployPaths(fx.dataRoot);
    const calls = [];
    const executor = async (action, phase) => { calls.push(`${phase}:${action.id}`); return { ok: true }; };

    await expect(applyApprovedPlan({ plan, approvalHash: '0'.repeat(64), paths, freshDiscovery: discovery, executor })).rejects.toThrow('Approval hash mismatch');
    expect(calls).toHaveLength(0);
    expect(existsSync(paths.ledger)).toBe(false);

    await expect(applyApprovedPlan({ plan, approvalHash: plan.planSha256, paths, freshDiscovery: discovery, executor })).rejects.toThrow('Explicit model approval hash mismatch');
    expect(calls).toHaveLength(0);
    expect(existsSync(paths.ledger)).toBe(false);

    writeFileSync(path.join(fx.sourceRoot, 'ORANGE_START.cmd'), 'tampered\n', 'utf8');
    await expect(applyApprovedPlan({ plan, approvalHash: plan.planSha256, modelApprovalHash: plan.approval.modelSetSha256, paths, freshDiscovery: discovery, executor })).rejects.toThrow('Payload changed');
    expect(calls).toHaveLength(0);
    expect(existsSync(paths.ledger)).toBe(false);
  }, 20_000);

  test('full package lock blocks a non-critical payload change before execution', async () => {
    const fx = fixture();
    const discovery = discoveryFor(fx);
    expect(discovery.payload.packageLock.verified).toBe(true);
    const plan = buildPlan({ discovery, manifest: fx.manifest });
    const paths = deployPaths(fx.dataRoot);
    const calls = [];
    writeFileSync(path.join(fx.sourceRoot, 'docs', 'release-note.txt'), 'tampered outside critical fingerprint\n', 'utf8');

    await expect(applyApprovedPlan({
      plan,
      approvalHash: plan.planSha256,
      modelApprovalHash: plan.approval.modelSetSha256,
      paths,
      freshDiscovery: discovery,
      executor: async (action, phase) => { calls.push(`${phase}:${action.id}`); return { ok: true }; },
    })).rejects.toThrow('Payload changed after planning');
    expect(calls).toHaveLength(0);
    expect(existsSync(paths.ledger)).toBe(false);
  }, 20_000);

  test('recomputes the selected model set independently for apply, status, and rollback', async () => {
    const fx = fixture();
    const discovery = discoveryFor(fx);
    const plan = buildPlan({ discovery, manifest: fx.manifest });
    const paths = deployPaths(fx.dataRoot);
    const tampered = structuredClone(plan);
    tampered.approval.modelSetSha256 = 'f'.repeat(64);
    tampered.planSha256 = planHash(tampered);
    const calls = [];
    const executor = async (action, phase) => { calls.push(`${phase}:${action.id}`); return { ok: true }; };

    expect(verifyPlan(tampered).ok).toBe(true);
    expect(verifyModelSet(tampered)).toMatchObject({ ok: false, expected: 'f'.repeat(64) });
    await expect(applyApprovedPlan({
      plan: tampered,
      approvalHash: tampered.planSha256,
      modelApprovalHash: tampered.approval.modelSetSha256,
      paths,
      freshDiscovery: discovery,
      executor,
    })).rejects.toThrow('Stored model set hash is invalid');
    expect(calls).toHaveLength(0);
    expect(existsSync(paths.ledger)).toBe(false);

    const status = await deploymentStatus({ plan: tampered, paths, freshDiscovery: discovery, executor, writeReceipt: false });
    expect(status.blockers.some((item) => item.code === 'MODEL_SET_HASH_INVALID')).toBe(true);
    await expect(rollbackDeployment({ plan: tampered, paths, executor })).rejects.toThrow('invalid model set');
  }, 20_000);

  test('all dry-runs finish before mutation and completed actions are adopted on resume', async () => {
    const fx = fixture();
    const discovery = discoveryFor(fx);
    const plan = buildPlan({ discovery, manifest: fx.manifest });
    const paths = deployPaths(fx.dataRoot);
    writeJsonAtomic(paths.plan, plan);
    const calls = [];
    const executor = async (action, phase) => {
      calls.push(`${phase}:${action.id}`);
      return { ok: true, actionId: action.id, phase };
    };

    const first = await applyApprovedPlan({ plan, approvalHash: plan.planSha256, modelApprovalHash: plan.approval.modelSetSha256, paths, freshDiscovery: discovery, executor, env: { ...process.env, ORANGE5_DEPLOY_TEST_MODE: '1' } });
    expect(first.status).toBe('APPLIED');
    expect(existsSync(first.receiptPath)).toBe(true);
    const firstApplyIndex = calls.findIndex((item) => item.startsWith('apply:'));
    expect(firstApplyIndex).toBe(plan.actions.length);
    expect(calls.slice(0, firstApplyIndex).every((item) => item.startsWith('dry-run:'))).toBe(true);

    calls.length = 0;
    await applyApprovedPlan({ plan, approvalHash: plan.planSha256, modelApprovalHash: plan.approval.modelSetSha256, paths, freshDiscovery: discovery, executor, env: { ...process.env, ORANGE5_DEPLOY_TEST_MODE: '1' } });
    expect(calls.filter((item) => item.startsWith('apply:'))).toHaveLength(0);
    expect(calls.filter((item) => item.startsWith('verify:'))).toHaveLength(plan.actions.length);

    const ledger = readLedger(paths.ledger);
    const firstStarted = ledger.findIndex((item) => item.event === 'action.started');
    const firstRunPreflight = ledger.slice(0, firstStarted).filter((item) => item.event === 'dry-run.completed');
    expect(firstRunPreflight).toHaveLength(plan.actions.length);
    expect(ledger.some((item) => item.event === 'action.adopted')).toBe(true);

    const status = await deploymentStatus({ plan, paths, freshDiscovery: discovery, executor, env: { ...process.env, ORANGE5_DEPLOY_TEST_MODE: '1' } });
    expect(status.status).toBe('READY');
    expect(existsSync(status.receiptPath)).toBe(true);

    const retained = path.join(paths.components, 'retained-model.bin');
    mkdirSync(paths.components, { recursive: true });
    writeFileSync(retained, 'preserve', 'utf8');
    const rollback = await rollbackDeployment({ plan, paths, executor, env: { ...process.env, ORANGE5_DEPLOY_TEST_MODE: '1' } });
    expect(rollback.status).toBe('ROLLED_BACK_DATA_PRESERVED');
    expect(existsSync(rollback.receiptPath)).toBe(true);
    expect(readFileSync(retained, 'utf8')).toBe('preserve');

    const rolledBack = await deploymentStatus({ plan, paths, freshDiscovery: discovery, executor, env: { ...process.env, ORANGE5_DEPLOY_TEST_MODE: '1' } });
    expect(rolledBack.status).toBe('ROLLED_BACK');
    expect(rolledBack.ready).toBe(false);
  }, 20_000);

  test('a failed dry-run records evidence and executes no apply action', async () => {
    const fx = fixture();
    const discovery = discoveryFor(fx);
    const plan = buildPlan({ discovery, manifest: fx.manifest });
    const paths = deployPaths(fx.dataRoot);
    const calls = [];
    const stopAt = plan.actions[2].id;
    const executor = async (action, phase) => {
      calls.push(`${phase}:${action.id}`);
      if (phase === 'dry-run' && action.id === stopAt) throw new Error('fixture preflight blocker');
      return { ok: true };
    };
    await expect(applyApprovedPlan({ plan, approvalHash: plan.planSha256, modelApprovalHash: plan.approval.modelSetSha256, paths, freshDiscovery: discovery, executor })).rejects.toThrow('fixture preflight blocker');
    expect(calls.some((item) => item.startsWith('apply:'))).toBe(false);
    const ledger = readLedger(paths.ledger);
    expect(ledger.at(-1).event).toBe('dry-run.failed');
    expect(ledger.at(-1).error).toContain('fixture preflight blocker');

    calls.length = 0;
    const resumed = await applyApprovedPlan({
      plan,
      approvalHash: plan.planSha256,
      modelApprovalHash: plan.approval.modelSetSha256,
      paths,
      freshDiscovery: discovery,
      executor: async (action, phase) => { calls.push(`${phase}:${action.id}`); return { ok: true }; },
    });
    expect(resumed.status).toBe('APPLIED');
    expect(readLedger(paths.ledger).some((item) => item.event === 'plan.resume.requested')).toBe(true);
    expect(calls.some((item) => item.startsWith('apply:'))).toBe(true);
  }, 20_000);
});
