import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const GOVERNOR_SCHEMA = 'orange.model-lease.v2';
export const AUDIT_SCHEMA = 'orange.creative-route-dry-run.v1';
export const DEFAULT_MANIFEST = path.join(import.meta.dirname, 'captain-planet-stack.json');
const GIB = 1024 ** 3;
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..');

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function isInstalled(role) {
  return String(role.availability?.state || '').startsWith('installed_');
}

function isCandidate(role) {
  return String(role.availability?.state || '').startsWith('candidate_');
}

export function memoryMeasurement(role) {
  const peakBytes = Number(role.memory_measurement?.peak_process_tree_working_set_bytes);
  const receipt = role.memory_measurement?.receipt;
  const measured = role.memory_measurement?.state === 'measured'
    && Number.isFinite(peakBytes)
    && peakBytes > 0
    && typeof receipt === 'string'
    && receipt.trim().length > 0;
  return {
    state: role.memory_measurement?.state || 'unmeasured',
    measured,
    peak_process_tree_working_set_bytes: measured ? peakBytes : null,
    receipt: typeof receipt === 'string' && receipt.trim().length > 0 ? receipt : null,
  };
}

function validateRole(role, seen) {
  if (!role.role || seen.has(role.role)) throw new Error(`duplicate or missing role: ${role.role || 'unnamed'}`);
  seen.add(role.role);
  if (!role.model || !role.capability || !role.runtime) throw new Error(`incomplete role: ${role.role}`);
  if (!role.availability?.state || typeof role.availability?.lease_eligible !== 'boolean') {
    throw new Error(`availability truth missing: ${role.role}`);
  }
  if (!role.activation?.receipt_contract) throw new Error(`receipt contract missing: ${role.role}`);
  if (isCandidate(role) && role.availability.lease_eligible) {
    throw new Error(`candidate cannot be lease eligible: ${role.role}`);
  }
  if (isInstalled(role) && (!Array.isArray(role.required_artifacts) || role.required_artifacts.length === 0)) {
    throw new Error(`installed role lacks inventory evidence: ${role.role}`);
  }
  if (isInstalled(role) && !role.memory_measurement?.state) {
    throw new Error(`installed role lacks explicit memory measurement state: ${role.role}`);
  }
}

export function loadManifest(file = DEFAULT_MANIFEST) {
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (manifest.schema !== 'orange.model-superset.v1' || manifest.registry_version !== 2) {
    throw new Error('invalid Captain Planet creative registry schema/version');
  }
  const ceiling = Number(manifest.policy?.live_model_memory_ceiling_bytes || 0);
  if (!Number.isFinite(ceiling) || ceiling <= 0 || ceiling > 50 * GIB) {
    throw new Error('live model memory ceiling must be between 1 byte and 50 GiB');
  }
  if (manifest.policy?.max_active_heavy_leases !== 1 || manifest.policy?.execution !== 'single_specialist_lease') {
    throw new Error('Captain Planet must enforce exactly one active specialist lease');
  }
  const seen = new Set();
  for (const role of manifest.roles || []) validateRole(role, seen);
  if (seen.size === 0) throw new Error('creative registry has no routes');
  if (manifest.policy?.deny_unmeasured_memory) {
    const invalid = manifest.roles.find((role) => isInstalled(role)
      && role.availability.lease_eligible
      && !memoryMeasurement(role).measured);
    if (invalid) throw new Error(`unmeasured installed role cannot be lease eligible: ${invalid.role}`);
  }
  return manifest;
}

function normalizedModel(name = '') {
  return String(name).trim().replace(/:latest$/, '');
}

export function modelMatches(left, right) {
  return normalizedModel(left) === normalizedModel(right);
}

export function roleFor(manifest, requested) {
  const value = String(requested || '').trim();
  const row = manifest.roles.find((item) => item.role === value || modelMatches(item.model, value));
  if (!row) throw new Error(`unknown Captain Planet creative role/model: ${value}`);
  return row;
}

export function leaseDecision(manifest, role, running = []) {
  const ceiling = Number(manifest.policy.live_model_memory_ceiling_bytes);
  const requested = Number(role.estimated_live_bytes || 0);
  const measurement = memoryMeasurement(role);
  let reason = 'single_specialist_lease';
  let allowed = true;
  if (isCandidate(role)) {
    allowed = false;
    reason = 'candidate_or_unavailable';
  } else if (manifest.policy.deny_unmeasured_memory && !measurement.measured) {
    allowed = false;
    reason = 'unmeasured_peak_memory';
  } else if (!role.availability?.lease_eligible) {
    allowed = false;
    reason = 'route_not_lease_eligible';
  } else if (!Number.isFinite(requested) || requested <= 0) {
    allowed = false;
    reason = 'missing_memory_planning_bound';
  } else if (requested > ceiling) {
    allowed = false;
    reason = 'memory_planning_bound_exceeds_ceiling';
  } else if (measurement.peak_process_tree_working_set_bytes > ceiling) {
    allowed = false;
    reason = 'measured_peak_memory_ceiling_exceeded';
  }
  return {
    allowed,
    reason,
    requested_bytes: requested,
    measured_peak_bytes: measurement.peak_process_tree_working_set_bytes,
    memory_measurement_state: measurement.state,
    memory_measurement_receipt: measurement.receipt,
    ceiling_bytes: ceiling,
    max_active_heavy_leases: 1,
    unload: running.map((item) => item.name || item.model).filter(Boolean),
  };
}

export function activationCommand(role) {
  return [
    'powershell',
    '-ExecutionPolicy', 'Bypass',
    '-File', 'C:/AtomEons/Orange5/14-SUPERSTACK/invoke-captain-planet-route.ps1',
    '-Role', role.role,
  ];
}

function readProof(role) {
  if (!role.proof?.receipt) return { exists: false, path: null, body: null, error: null };
  const proofPath = path.resolve(REPOSITORY_ROOT, role.proof.receipt);
  try {
    return { exists: true, path: proofPath, body: JSON.parse(fs.readFileSync(proofPath, 'utf8')), error: null };
  } catch (error) {
    return { exists: fs.existsSync(proofPath), path: proofPath, body: null, error: error.message };
  }
}

function sourceScriptState(role) {
  if (!role.activation?.source_script) return { path: null, exists: false };
  const scriptPath = path.resolve(REPOSITORY_ROOT, role.activation.source_script);
  return { path: scriptPath, exists: fs.existsSync(scriptPath) };
}

export function dryRunRoute(manifest, requested) {
  const role = roleFor(manifest, requested);
  const decision = leaseDecision(manifest, role);
  const proof = readProof(role);
  const sourceScript = sourceScriptState(role);
  const candidate = isCandidate(role);
  const installed = isInstalled(role);
  const measurement = memoryMeasurement(role);
  const runtimeProof = Boolean(
    proof.body
    && proof.body.status === role.proof.expected_status
    && proof.body.runtime_execution_proven === true,
  );
  const proofAgeMs = Date.now() - Date.parse(proof.body?.generated_at || 'invalid');
  const maxProofAgeMs = Number(manifest.policy.technical_proof_max_age_hours || 24) * 60 * 60_000;
  const proofIsFresh = Number.isFinite(proofAgeMs) && proofAgeMs >= 0 && proofAgeMs <= maxProofAgeMs;
  const technicalQualityProof = Boolean(
    runtimeProof
    && proofIsFresh
    && proof.body.artifact_technical_quality_proven === true
    && proof.body.end_to_end_artifact_technical_quality_proven === true
    && proof.body.perceptual_quality_proven === false
    && proof.body.studio_quality_proven === false,
  );
  const command = activationCommand(role);
  const checks = {
    availability_state_is_explicit: installed || candidate,
    candidate_is_not_lease_eligible: !candidate || role.availability.lease_eligible === false,
    installed_has_observed_artifacts: !installed || role.required_artifacts.length > 0,
    installed_has_runtime_artifact_proof: !installed || runtimeProof,
    installed_has_bounded_technical_quality_proof: !installed || technicalQualityProof,
    installed_technical_quality_proof_is_fresh: !installed || proofIsFresh,
    installed_has_source_runner: !installed || sourceScript.exists,
    lease_planning_bound_is_known_and_within_ceiling: !installed || (
      decision.requested_bytes > 0 && decision.requested_bytes <= decision.ceiling_bytes
    ),
    lease_peak_memory_is_measured_and_within_ceiling: !installed || (
      measurement.measured
      && measurement.peak_process_tree_working_set_bytes <= decision.ceiling_bytes
    ),
    unmeasured_memory_is_not_lease_eligible: !installed || measurement.measured || role.availability.lease_eligible === false,
    command_is_renderable: command.length > 0,
    route_declares_receipt_contract: Boolean(role.activation?.receipt_contract),
  };
  const findings = [];
  if (installed && (
    !checks.installed_has_observed_artifacts
    || !checks.installed_has_runtime_artifact_proof
    || !checks.installed_has_bounded_technical_quality_proof
  )) {
    findings.push('candidate_or_scaffold_presented_as_installed');
  }
  if (installed && proof.exists && !runtimeProof) findings.push('scaffold_only_artifact_proof');
  if (role.availability.lease_eligible && !checks.lease_planning_bound_is_known_and_within_ceiling) {
    findings.push('wrong_memory_budget');
  }
  if (!checks.command_is_renderable || !checks.route_declares_receipt_contract || (installed && !sourceScript.exists)) {
    findings.push('lane_cannot_produce_command_or_receipt');
  }
  const activationBlockers = installed && !decision.allowed ? [decision.reason] : [];
  const status = findings.length > 0
    ? 'DRY_RUN_NEEDS_WORK'
    : candidate
      ? 'CANDIDATE_BLOCKED_NOT_INSTALLED'
      : activationBlockers.length > 0
        ? 'DRY_RUN_TECHNICAL_QUALITY_PROVEN_ACTIVATION_BLOCKED'
        : 'DRY_RUN_READY_TECHNICAL_QUALITY_PROVEN_PERCEPTUAL_UNASSESSED';
  return {
    schema: AUDIT_SCHEMA,
    status,
    role: role.role,
    capability: role.capability,
    model: role.model,
    declared_availability: role.availability,
    installed_claim: installed,
    candidate_claim: candidate,
    decision,
    memory_evidence: role.memory_evidence,
    memory_measurement: measurement,
    required_artifacts: role.required_artifacts,
    proof: {
      declared_state: role.proof?.state || null,
      receipt_path: proof.path,
      receipt_exists: proof.exists,
      receipt_status: proof.body?.status || null,
      runtime_execution_proven: proof.body?.runtime_execution_proven === true,
      artifact_technical_quality_proven: proof.body?.artifact_technical_quality_proven === true,
      end_to_end_artifact_technical_quality_proven: proof.body?.end_to_end_artifact_technical_quality_proven === true,
      perceptual_quality_proven: proof.body?.perceptual_quality_proven === true,
      studio_quality_proven: proof.body?.studio_quality_proven === true,
      proof_age_ms: Number.isFinite(proofAgeMs) ? proofAgeMs : null,
      proof_is_fresh: proofIsFresh,
      read_error: proof.error,
    },
    source_script: sourceScript,
    command,
    command_text: command.map((part) => /\s/.test(part) ? `"${part}"` : part).join(' '),
    receipt_contract: role.activation.receipt_contract,
    activation_blockers: activationBlockers,
    checks,
    findings,
  };
}

export function cleanupPlan(manifest, installed = []) {
  const managed = new Set((manifest.ollama?.managed_models || []).map(normalizedModel));
  const keep = new Set((manifest.ollama?.keep_models || []).map(normalizedModel));
  return installed
    .map((item) => item.name || item.model)
    .filter(Boolean)
    .filter((name) => managed.has(normalizedModel(name)) && !keep.has(normalizedModel(name)))
    .sort();
}

async function request(baseUrl, endpoint, options = {}, fetchImpl = fetch) {
  const response = await fetchImpl(`${baseUrl}${endpoint}`, options);
  if (!response.ok) throw new Error(`${endpoint} returned HTTP ${response.status}`);
  return response.status === 204 ? null : response.json().catch(() => null);
}

export async function inventory(manifest, fetchImpl = fetch) {
  const baseUrl = manifest.ollama.control_base_url.replace(/\/$/, '');
  const [tags, ps] = await Promise.all([
    request(baseUrl, '/api/tags', {}, fetchImpl),
    request(baseUrl, '/api/ps', {}, fetchImpl),
  ]);
  return {
    base_url: baseUrl,
    installed: Array.isArray(tags?.models) ? tags.models : [],
    running: Array.isArray(ps?.models) ? ps.models : [],
  };
}

function receiptPath(label) {
  const root = path.join(import.meta.dirname, 'receipts');
  fs.mkdirSync(root, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(root, `${stamp}-${label}.json`);
}

export function writeReceipt(command, payload, label = 'captain-planet') {
  const body = {
    schema: GOVERNOR_SCHEMA,
    command,
    created_at: new Date().toISOString(),
    host: os.hostname(),
    payload,
  };
  body.sha256 = hash(body);
  const file = receiptPath(label);
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  return file;
}

function catalog(manifest) {
  return {
    schema: 'orange.creative-model-catalog.v1',
    policy: manifest.policy,
    routes: manifest.roles.map((role) => ({
      role: role.role,
      capability: role.capability,
      model: role.model,
      state: role.availability.state,
      lease_eligible: role.availability.lease_eligible,
      estimated_live_bytes: role.estimated_live_bytes,
      quality_tier: role.quality_tier,
    })),
  };
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0] || 'catalog';
  const manifest = loadManifest(process.env.ORANGE5_SUPERSTACK_MANIFEST || DEFAULT_MANIFEST);
  let payload;
  let receiptLabel = 'captain-planet';
  if (command === 'catalog') {
    payload = catalog(manifest);
  } else if (command === 'plan' || command === 'lease') {
    const route = dryRunRoute(manifest, argv[1]);
    payload = { ...route, execution_performed: false };
    if (command === 'lease' && !route.decision.allowed) {
      payload.status = 'LEASE_DENIED';
    }
  } else if (command === 'dry-run') {
    const all = argv.includes('--all');
    const routes = all ? manifest.roles.map((role) => dryRunRoute(manifest, role.role)) : [dryRunRoute(manifest, argv[1])];
    const findings = routes.flatMap((route) => route.findings.map((finding) => ({ role: route.role, finding })));
    payload = {
      schema: AUDIT_SCHEMA,
      status: findings.length > 0
        ? 'CREATIVE_ROUTE_DRY_RUN_NEEDS_WORK'
        : routes.some((route) => route.activation_blockers.length > 0)
          ? 'CREATIVE_ROUTE_DRY_RUN_TRUTHFUL_WITH_DECLARED_ACTIVATION_BLOCKERS'
          : 'CREATIVE_ROUTE_DRY_RUN_GREEN_WITH_CANDIDATES_BLOCKED',
      execution_performed: false,
      route_count: routes.length,
      ready_count: routes.filter((route) => route.status === 'DRY_RUN_READY_TECHNICAL_QUALITY_PROVEN_PERCEPTUAL_UNASSESSED').length,
      activation_blocked_count: routes.filter((route) => route.status === 'DRY_RUN_TECHNICAL_QUALITY_PROVEN_ACTIVATION_BLOCKED').length,
      candidate_blocked_count: routes.filter((route) => route.status === 'CANDIDATE_BLOCKED_NOT_INSTALLED').length,
      findings,
      routes,
    };
    receiptLabel = 'creative-route-dry-run';
  } else if (command === 'status') {
    const state = await inventory(manifest);
    payload = {
      status: 'CAPTAIN_PLANET_REGISTRY_REACHABLE',
      ceiling_bytes: manifest.policy.live_model_memory_ceiling_bytes,
      max_active_heavy_leases: manifest.policy.max_active_heavy_leases,
      catalog: catalog(manifest).routes,
      ...state,
      cleanup_plan: cleanupPlan(manifest, state.installed),
    };
  } else if (command === 'cleanup') {
    const state = await inventory(manifest);
    payload = {
      dry_run: true,
      cleanup_scope: manifest.ollama.cleanup_scope,
      remove: cleanupPlan(manifest, state.installed),
      managed_models: manifest.ollama.managed_models,
      unowned_models_preserved: true,
    };
  } else {
    throw new Error('usage: captain-planet-governor.mjs catalog | status | plan <role> | lease <role> | dry-run <role>|--all | cleanup');
  }
  const file = writeReceipt(command, payload, receiptLabel);
  process.stdout.write(`${JSON.stringify({ ...payload, receipt_path: file }, null, 2)}\n`);
  if (payload.status?.endsWith('NEEDS_WORK')) process.exitCode = 1;
}

if (import.meta.main) main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ status: 'CAPTAIN_PLANET_FAILED', error: error.message }, null, 2)}\n`);
  process.exitCode = 1;
});
