#!/usr/bin/env bun
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const expectedProfiles = ['builder', 'misfit', 'navigator', 'researcher', 'reviewer', 'visual'];
const expectedTools = ['orange5_delegate', 'orange5_health', 'orange5_order', 'orange5_receipts', 'orange5_route'];
const profileTools = {
  navigator: expectedTools,
  builder: ['orange5_health', 'orange5_order', 'orange5_receipts', 'orange5_route'],
  researcher: ['orange5_delegate', 'orange5_health', 'orange5_receipts'],
  reviewer: ['orange5_health', 'orange5_receipts'],
  visual: ['orange5_health', 'orange5_receipts'],
  misfit: ['orange5_health', 'orange5_receipts'],
};
const delegationPosture = {
  navigator: { max_concurrent_children: 6, max_spawn_depth: 2, orchestrator_enabled: true },
  researcher: { max_concurrent_children: 6, max_spawn_depth: 2, orchestrator_enabled: true },
  builder: { max_concurrent_children: 6, max_spawn_depth: 1, orchestrator_enabled: false },
  reviewer: { max_concurrent_children: 6, max_spawn_depth: 1, orchestrator_enabled: false },
  visual: { max_concurrent_children: 6, max_spawn_depth: 1, orchestrator_enabled: false },
  misfit: { max_concurrent_children: 6, max_spawn_depth: 1, orchestrator_enabled: false },
};
const failures = [];
const passes = [];

function check(condition, name, detail = '') {
  (condition ? passes : failures).push({ name, detail });
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path)); else out.push(path);
  }
  return out;
}

const files = walk(root).filter((path) => !path.includes('node_modules'));
for (const file of files.filter((path) => path.endsWith('.json'))) {
  try { JSON.parse(readFileSync(file, 'utf8')); passes.push({ name: 'json-parse', detail: relative(root, file) }); }
  catch (error) { failures.push({ name: 'json-parse', detail: `${relative(root, file)}: ${error.message}` }); }
}

const yamlFiles = files.filter((path) => path.endsWith('.yaml') || path.endsWith('.yml'));
const yamlDocs = new Map();
for (const file of yamlFiles) {
  try {
    const parsed = Bun.YAML.parse(readFileSync(file, 'utf8'));
    yamlDocs.set(file, parsed);
    passes.push({ name: 'yaml-parse', detail: relative(root, file) });
  } catch (error) { failures.push({ name: 'yaml-parse', detail: `${relative(root, file)}: ${error.message}` }); }
}

const lock = JSON.parse(readFileSync(join(root, 'upstream.lock.json'), 'utf8'));
check(lock.packageVersion === '0.20.5', 'pinned-package-version', lock.packageVersion);
check(lock.tag === 'v2026.8.19', 'pinned-tag', lock.tag);
check(lock.tagObjectSha === 'b05e680e63d39d5a8e3ec0f5842a41d1c4209c03', 'pinned-tag-object', lock.tagObjectSha);
check(lock.commit === 'fcbd1076a93841fa88855acce810e342a5b78101', 'pinned-commit', lock.commit);

const profileRoot = join(root, 'config', 'profiles');
const profiles = readdirSync(profileRoot, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => x.name).sort();
check(JSON.stringify(profiles) === JSON.stringify(expectedProfiles), 'exact-profile-roster', profiles.join(','));

const ownerPath = join(root, 'config', 'gateway-owner', 'config.yaml');
const owner = yamlDocs.get(ownerPath);
check(owner?.gateway?.multiplex_profiles === true, 'owner-multiplex-enabled');
check(owner?.kanban?.dispatch_in_gateway === true, 'owner-dispatch-enabled');
check(owner?.kanban?.auto_decompose === false, 'orange-controls-decomposition');
check(owner?.kanban?.orchestrator_profile === 'navigator', 'navigator-orchestrator');
check(owner?.kanban?.max_in_progress === 8, 'eight-durable-kanban-workers');
check(owner?.kanban?.max_in_progress_per_profile === 2, 'two-durable-tasks-per-profile');
check(owner?.gateway?.api_server?.host === '127.0.0.1', 'api-loopback-bind');
check(owner?.gateway?.api_server?.max_concurrent_runs === 8, 'eight-concurrent-api-runs');
check(owner?.delegation?.max_concurrent_children === 6, 'six-wide-delegated-swarm');
check(owner?.delegation?.max_spawn_depth === 2, 'two-level-delegation-depth');
check(owner?.delegation?.orchestrator_enabled === true, 'nested-orchestrator-enabled');
const ownerTools = [...(owner?.mcp_servers?.orange5?.tools?.include || [])].sort();
check(JSON.stringify(ownerTools) === JSON.stringify(expectedTools), 'minimal-orange-mcp-tools', ownerTools.join(','));
check(owner?.mcp_servers?.orange5?.supports_parallel_tool_calls === false, 'serialized-orange-mutations');

for (const profile of profiles) {
  const configPath = join(profileRoot, profile, 'config.yaml');
  const config = yamlDocs.get(configPath);
  check(config?.gateway?.multiplex_profiles === false, `${profile}-no-gateway-owner`);
  check(config?.platforms?.api_server?.enabled === false, `${profile}-shared-api-listener-only`);
  check(config?.kanban?.dispatch_in_gateway === false, `${profile}-no-dispatcher`);
  check(config?.model?.base_url === '__ORANGE_MODEL_URL__', `${profile}-distributed-model-gateway-template`);
  check(JSON.stringify(config?.delegation) === JSON.stringify(delegationPosture[profile]), `${profile}-adaptive-delegation-posture`);
  const tools = [...(config?.mcp_servers?.orange5?.tools?.include || [])].sort();
  check(JSON.stringify(tools) === JSON.stringify([...profileTools[profile]].sort()), `${profile}-minimal-mcp`, tools.join(','));
  check(readFileSync(join(profileRoot, profile, 'SOUL.md'), 'utf8').length > 120, `${profile}-soul-present`);
}

const policyScanFiles = files.filter((file) => file !== join(root, 'scripts', 'static-check.mjs'));
const text = policyScanFiles.map((file) => {
  try { return readFileSync(file, 'utf8'); } catch { return ''; }
}).join('\n');
check(!/(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|KGAT_[A-Za-z0-9]{20,})/.test(text), 'no-secret-material');
check(!/nousresearch\/hermes-agent\/main|hermes-agent@latest|:latest/i.test(text), 'no-floating-upstream-ref');
check(!/0\.16\.0|0\.18\.2|v2026\.7\.7\.2/.test(text), 'no-stale-hermes-pin');

const installerText = readFileSync(join(root, 'scripts', 'install-hermes-product.ps1'), 'utf8');
const materializerText = readFileSync(join(root, 'scripts', 'materialize-config.ps1'), 'utf8');
const startText = readFileSync(join(root, 'scripts', 'start-owner.ps1'), 'utf8');
const preflightText = readFileSync(join(root, 'scripts', 'preflight.ps1'), 'utf8');
const leaseProofText = readFileSync(join(root, 'scripts', 'agent-lease-proof.ps1'), 'utf8');
const deployProfilesText = readFileSync(join(root, 'scripts', 'deploy-codexa-profiles.ps1'), 'utf8');
const delegationProofText = readFileSync(join(root, 'scripts', 'bounded-live-delegation-proof.ps1'), 'utf8');
check(installerText.includes('tagObjectSha') && installerText.includes('Pinned tag object moved'), 'annotated-tag-object-enforced');
check(installerText.includes('ExistingHermesExe') && installerText.includes('adopted-executable'), 'existing-hermes-overlay-adoption');
check(installerText.includes('ReparsePoint') && materializerText.includes('ReparsePoint') && startText.includes('ReparsePoint'), 'reparse-point-defense');
check(startText.includes("@('gateway', 'run', '--external-supervisor')"), 'foreground-supervisor-command');
check(preflightText.includes('profile-filtered-mcp-surfaces') && preflightText.includes('/v1/toolsets'), 'per-profile-live-tool-proof');
check(preflightText.includes('navigator-agent-inference') && preflightText.includes('filtered-profile-surface-not-ready;inference-not-sent'), 'agent-inference-gated-by-filtered-surface');
check(preflightText.includes('cross-profile-auth-rejection') && preflightText.includes('owner-and-peer-keys-rejected'), 'cross-profile-auth-proof');
check(preflightText.includes('secret-file-acls') && materializerText.includes('SetAccessRuleProtection'), 'secret-acl-apply-and-proof');
check(!preflightText.includes("$processOwner -eq 'unknown' -or"), 'process-owner-fails-closed');
check(leaseProofText.includes("execute = $false") && leaseProofText.includes("mutatedProject = $false"), 'agent-lease-proof-is-non-executing');
check(leaseProofText.includes('destructive_write') && leaseProofText.includes('egress_unbounded'), 'agent-lease-proof-pins-forbidden-actions');
check(materializerText.includes("[string]$HermesAgentModel = 'orange-navigator:ornith-1.5-9b-q4km'"), 'materializer-defaults-to-promoted-q4km');
check(deployProfilesText.includes("[string]$HermesAgentModel = 'orange-navigator:ornith-1.5-9b-q4km'"), 'codexa-deployer-defaults-to-promoted-q4km');
check(!materializerText.includes('q4km-candidate') && !deployProfilesText.includes('q4km-candidate'), 'candidate-suffix-default-absent');
check(delegationProofText.includes("[string]$AgentModel = 'orange-navigator:ornith-1.5-9b-q4km'") && delegationProofText.includes("[string]$SynthesisModel = 'orange-navigator:ornith-1.5-9b-q4km'"), 'delegation-proof-defaults-to-promoted-q4km');
check(!materializerText.includes('ornith-1.5-9b-q8') && !deployProfilesText.includes('ornith-1.5-9b-q8') && !delegationProofText.includes('ornith-1.5-9b-q8'), 'retired-q8-default-absent');
check(deployProfilesText.includes('runtime agent model is not the requested model'), 'deployer-verifies-materialized-model');

const psParser = Bun.spawnSync(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'tests', 'powershell-syntax.ps1'), '-Root', root], { stdout: 'pipe', stderr: 'pipe' });
check(psParser.exitCode === 0, 'powershell-syntax', new TextDecoder().decode(psParser.stdout).trim() || new TextDecoder().decode(psParser.stderr).trim());

console.log(JSON.stringify({ schema: 'orange5.hermes-static-check.v1', status: failures.length ? 'FAIL' : 'PASS', passed: passes.length, failed: failures.length, failures }, null, 2));
if (failures.length) process.exit(1);
