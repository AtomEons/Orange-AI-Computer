#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dir, '..');
const executionProfilePolicy = ['builder', 'human-operator', 'misfit', 'navigator', 'researcher', 'reviewer', 'visual'];
const staffRosterPath = join(root, 'config', 'staff-roster.json');
let staffRoster = null;
let staffRosterError = '';
try {
  staffRoster = JSON.parse(readFileSync(staffRosterPath, 'utf8'));
} catch (error) {
  staffRosterError = error.message;
}
const logicalRoles = Array.isArray(staffRoster?.roles) ? staffRoster.roles : [];
const mappedProfiles = [...new Set(logicalRoles.map((role) => role?.archetype).filter(Boolean))].sort();
const expectedProfiles = mappedProfiles.length ? mappedProfiles : executionProfilePolicy;
const expectedTools = ['orange5_delegate', 'orange5_health', 'orange5_order', 'orange5_receipts', 'orange5_route'];
const profileTools = {
  navigator: expectedTools,
  builder: ['orange5_health', 'orange5_order', 'orange5_receipts', 'orange5_route'],
  researcher: ['orange5_delegate', 'orange5_health', 'orange5_receipts'],
  reviewer: ['orange5_health', 'orange5_receipts'],
  visual: ['orange5_health', 'orange5_receipts'],
  misfit: ['orange5_health', 'orange5_receipts'],
  'human-operator': ['orange5_health', 'orange5_order', 'orange5_receipts', 'orange5_route'],
};
const delegationPosture = {
  navigator: { max_concurrent_children: 6, max_spawn_depth: 2, orchestrator_enabled: true },
  researcher: { max_concurrent_children: 6, max_spawn_depth: 2, orchestrator_enabled: true },
  builder: { max_concurrent_children: 6, max_spawn_depth: 1, orchestrator_enabled: false },
  reviewer: { max_concurrent_children: 6, max_spawn_depth: 1, orchestrator_enabled: false },
  visual: { max_concurrent_children: 6, max_spawn_depth: 1, orchestrator_enabled: false },
  misfit: { max_concurrent_children: 6, max_spawn_depth: 1, orchestrator_enabled: false },
  'human-operator': { max_concurrent_children: 1, max_spawn_depth: 1, orchestrator_enabled: false },
};
const failures = [];
const passes = [];

function check(condition, name, detail = '') {
  (condition ? passes : failures).push({ name, detail });
}

function nonEmptyText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function nonEmptyTextList(value) {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmptyText);
}

function hasConcreteRoleContract(role) {
  return nonEmptyText(role?.id)
    && nonEmptyText(role?.title)
    && nonEmptyText(role?.purpose)
    && nonEmptyTextList(role?.concreteOutputs)
    && nonEmptyTextList(role?.completionContract);
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

check(existsSync(staffRosterPath) && !staffRosterError, 'ae-staff-wave4-roster-readable', staffRosterError || relative(root, staffRosterPath));
const organization = staffRoster?.organization || {};
check(
  organization.productName === 'AE Staff'
    && nonEmptyText(organization.workTitle)
    && organization.workTitle.startsWith('Wave 4:')
    && organization.roleCount === 50
    && organization.logicalActionRoleCount === 50,
  'ae-staff-wave4-organization-contract',
  `${organization.productName || ''};${organization.workTitle || ''};roles=${organization.roleCount};logical=${organization.logicalActionRoleCount}`,
);
const roleIds = logicalRoles.map((role) => role?.id);
const duplicateIds = roleIds.filter((id, index) => roleIds.indexOf(id) !== index);
const invalidIds = roleIds.filter((id) => !nonEmptyText(id) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id));
check(logicalRoles.length === 50, 'ae-staff-wave4-exact-50-logical-roles', `roles=${logicalRoles.length}`);
check(roleIds.length === 50 && new Set(roleIds).size === 50 && invalidIds.length === 0, 'ae-staff-wave4-50-unique-role-ids', `unique=${new Set(roleIds).size};invalid=${invalidIds.join(',')};duplicates=${[...new Set(duplicateIds)].join(',')}`);
const declaredProfiles = [...(organization.executionProfiles || [])].sort();
check(
  organization.executionProfileCount === 7
    && JSON.stringify(declaredProfiles) === JSON.stringify(executionProfilePolicy)
    && JSON.stringify(mappedProfiles) === JSON.stringify(executionProfilePolicy),
  'ae-staff-wave4-seven-execution-profile-mapping',
  `declared=${declaredProfiles.join(',')};mapped=${mappedProfiles.join(',')}`,
);
const navigators = logicalRoles.filter((role) => role?.archetype === 'navigator');
check(
  navigators.length === 1
    && nonEmptyText(organization.navigatorId)
    && navigators[0]?.id === organization.navigatorId
    && /navigator/i.test(navigators[0]?.title || ''),
  'ae-staff-wave4-single-navigator',
  `count=${navigators.length};declared=${organization.navigatorId || ''};actual=${navigators[0]?.id || ''}`,
);
const incompleteRoles = logicalRoles.filter((role) => !hasConcreteRoleContract(role)).map((role) => role?.id || 'unknown');
check(incompleteRoles.length === 0 && logicalRoles.length === 50, 'ae-staff-wave4-role-output-and-completion-contracts', incompleteRoles.join(','));
const managerialOnlyRoles = logicalRoles.filter((role) => role?.managerialOnly === true || ['managerial-only', 'management-only'].includes(String(role?.roleMode || '').toLowerCase()));
const reportingFailures = logicalRoles.filter((role) => role?.id === organization.navigatorId
  ? role?.reportsTo !== 'operator'
  : role?.reportsTo !== organization.navigatorId);
check(
  organization.structure === 'flat'
    && managerialOnlyRoles.length === 0
    && incompleteRoles.length === 0
    && reportingFailures.length === 0,
  'ae-staff-wave4-no-managerial-only-roles',
  `structure=${organization.structure || ''};managerialOnly=${managerialOnlyRoles.map((role) => role.id).join(',')};reporting=${reportingFailures.map((role) => role.id).join(',')}`,
);
const unmappedPermissionRoles = logicalRoles.filter((role) => !profileTools[role?.archetype] || !delegationPosture[role?.archetype]);
check(unmappedPermissionRoles.length === 0 && logicalRoles.length === 50, 'ae-staff-wave4-profile-permission-mapping', unmappedPermissionRoles.map((role) => role?.id || 'unknown').join(','));

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
const ownerAllowlist = [...(owner?.gateway?.multiplex_profile_allowlist || [])].sort();
check(JSON.stringify(ownerAllowlist) === JSON.stringify(expectedProfiles), 'ae-staff-wave4-owner-seven-profile-allowlist', ownerAllowlist.join(','));
const ownerTools = [...(owner?.mcp_servers?.orange5?.tools?.include || [])].sort();
check(JSON.stringify(ownerTools) === JSON.stringify(expectedTools), 'minimal-orange-mcp-tools', ownerTools.join(','));
check(owner?.mcp_servers?.orange5?.supports_parallel_tool_calls === false, 'serialized-orange-mutations');

const workerOwnershipFailures = [];
for (const profile of profiles) {
  const configPath = join(profileRoot, profile, 'config.yaml');
  const config = yamlDocs.get(configPath);
  if (config?.gateway?.multiplex_profiles !== false || config?.kanban?.dispatch_in_gateway !== false) workerOwnershipFailures.push(profile);
  check(config?.gateway?.multiplex_profiles === false, `${profile}-no-gateway-owner`);
  check(config?.platforms?.api_server?.enabled === false, `${profile}-shared-api-listener-only`);
  check(config?.kanban?.dispatch_in_gateway === false, `${profile}-no-dispatcher`);
  check(config?.model?.base_url === '__ORANGE_MODEL_URL__', `${profile}-distributed-model-gateway-template`);
  check(JSON.stringify(config?.delegation) === JSON.stringify(delegationPosture[profile]), `${profile}-adaptive-delegation-posture`);
  const tools = [...(config?.mcp_servers?.orange5?.tools?.include || [])].sort();
  check(JSON.stringify(tools) === JSON.stringify([...profileTools[profile]].sort()), `${profile}-minimal-mcp`, tools.join(','));
  check(readFileSync(join(profileRoot, profile, 'SOUL.md'), 'utf8').length > 120, `${profile}-soul-present`);
  const profileDefinition = JSON.parse(readFileSync(join(profileRoot, profile, 'profile.json'), 'utf8'));
  check(nonEmptyText(profileDefinition.permissionClass), `${profile}-permission-class-present`, profileDefinition.permissionClass || '');
}
check(workerOwnershipFailures.length === 0 && profiles.length === 7, 'ae-staff-wave4-no-worker-owns-gateway-or-dispatcher', workerOwnershipFailures.join(','));

if (staffRoster && logicalRoles.length === 50) {
  try {
    const reactorPath = resolve(root, '..', 'src', 'staff-reactor.mjs');
    const { StaffReactor } = await import(pathToFileURL(reactorPath).href);
    const reactorState = new StaffReactor({ roster: staffRoster, inferenceLimit: 8 }).start();
    check(
      reactorState.status === 'LIVE'
        && reactorState.roleCount === 50
        && reactorState.readyCount === 50
        && reactorState.inferenceLimit < reactorState.roleCount,
      'ae-staff-wave4-50-live-logical-actors',
      `status=${reactorState.status};roles=${reactorState.roleCount};ready=${reactorState.readyCount};inferenceLimit=${reactorState.inferenceLimit}`,
    );
  } catch (error) {
    check(false, 'ae-staff-wave4-50-live-logical-actors', error.message);
  }
} else {
  check(false, 'ae-staff-wave4-50-live-logical-actors', 'staff-roster-invalid');
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
const loadedSurfacesText = readFileSync(join(root, 'scripts', 'probe-loaded-surfaces.ps1'), 'utf8');
check(installerText.includes('tagObjectSha') && installerText.includes('Pinned tag object moved'), 'annotated-tag-object-enforced');
check(installerText.includes('ExistingHermesExe') && installerText.includes('adopted-executable'), 'existing-hermes-overlay-adoption');
check(installerText.includes('ReparsePoint') && materializerText.includes('ReparsePoint') && startText.includes('ReparsePoint'), 'reparse-point-defense');
check(startText.includes("@('gateway', 'run', '--external-supervisor')"), 'foreground-supervisor-command');
check(preflightText.includes('profile-filtered-mcp-surfaces') && preflightText.includes('/v1/toolsets'), 'per-profile-live-tool-proof');
check(preflightText.includes('navigator-agent-inference') && preflightText.includes('filtered-profile-surface-not-ready;inference-not-sent'), 'agent-inference-gated-by-filtered-surface');
check(preflightText.includes('cross-profile-auth-rejection') && preflightText.includes('owner-and-peer-keys-rejected'), 'cross-profile-auth-proof');
check(preflightText.includes('ae-staff-wave4-roster-contract') && preflightText.includes('ae-staff-wave4-live-actors'), 'ae-staff-wave4-preflight-runtime-proof-wired');
check((preflightText.match(/\/v1\/chat\/completions/g) || []).length === 1 && preflightText.includes('$NavigatorProfile'), 'ae-staff-wave4-single-navigator-profile-inference');
check(loadedSurfacesText.includes('staff-roster.json') && loadedSurfacesText.includes('ae-staff-wave4'), 'ae-staff-wave4-loaded-surfaces-proof-wired');
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
