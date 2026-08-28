#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { writeChainedJsonReceipt } from '../10-RECEIPTS/tools/json-receipt-chain.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const RECEIPT_ROOT = path.join(import.meta.dirname, 'receipts');
const DEFAULT_SOURCE = path.join(import.meta.dirname, 'captain-planet-board8-proof-source.json');
const EXPECTED_TECHNICAL_STATUS = {
  image_draft_flux2_klein: 'CAPTAIN_PLANET_IMAGE_TECHNICAL_QUALITY_PROVEN_VISUAL_QUALITY_UNASSESSED',
  video_fallback_ltxv098: 'CAPTAIN_PLANET_VIDEO_TECHNICAL_QUALITY_PROVEN_VISUAL_QUALITY_UNASSESSED',
  speech_qwen3_tts: 'CAPTAIN_PLANET_TTS_TECHNICAL_QUALITY_PROVEN_LISTENING_UNASSESSED',
  music_ace_step15: 'CAPTAIN_PLANET_MUSIC_TECHNICAL_QUALITY_PROVEN_LISTENING_UNASSESSED',
};

const sha256File = (filePath) => createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

function resolveUnderRoot(relativePath) {
  if (path.isAbsolute(relativePath)) throw new Error(`board 8 source path must be relative: ${relativePath}`);
  const resolved = path.resolve(ROOT, relativePath);
  if (resolved !== ROOT && !resolved.startsWith(`${ROOT}${path.sep}`)) {
    throw new Error(`board 8 source path escapes OrangeFive: ${relativePath}`);
  }
  return resolved;
}

function readEvidence(relativePath) {
  const filePath = resolveUnderRoot(relativePath);
  return {
    relative_path: relativePath,
    absolute_path: filePath,
    file_sha256: sha256File(filePath),
    body: JSON.parse(fs.readFileSync(filePath, 'utf8')),
  };
}

function technicalProofIsGreen(role, receipt) {
  return receipt.status === EXPECTED_TECHNICAL_STATUS[role]
    && receipt.runtime_execution_proven === true
    && receipt.artifact_technical_quality_proven === true
    && receipt.perceptual_quality_proven === false
    && receipt.studio_quality_proven === false;
}

export function buildBoard8Audit({ source, manifest, inventory, dryRun, topology, media, technical, evidence }) {
  const installed = manifest.roles.filter((role) => String(role.availability?.state || '').startsWith('installed_'));
  const candidates = manifest.roles.filter((role) => String(role.availability?.state || '').startsWith('candidate_'));
  const technicalRoles = Object.keys(EXPECTED_TECHNICAL_STATUS);
  const technicalByRole = Object.fromEntries(technicalRoles.map((role) => [role, {
    status: technical[role]?.status || null,
    artifact_sha256: technical[role]?.artifact_sha256 || null,
    technical_green: technicalProofIsGreen(role, technical[role] || {}),
    perceptual_quality_proven: technical[role]?.perceptual_quality_proven === true,
    studio_quality_proven: technical[role]?.studio_quality_proven === true,
  }]));
  const installedActivationBlocks = dryRun.routes.filter(
    (route) => route.installed_claim && route.activation_blockers?.includes('unmeasured_peak_memory'),
  );
  const checks = {
    four_installed_media_lanes_declared: installed.length === 4,
    installed_live_inventory_is_green:
      inventory.status === 'CAPTAIN_PLANET_LIVE_INSTALLED_ARTIFACT_INVENTORY_GREEN'
      && inventory.all_valid === true,
    all_four_artifacts_independently_pass_technical_checks:
      technicalRoles.every((role) => technicalByRole[role].technical_green),
    no_technical_receipt_claims_perceptual_quality:
      technicalRoles.every((role) => !technicalByRole[role].perceptual_quality_proven),
    no_technical_receipt_claims_studio_quality:
      technicalRoles.every((role) => !technicalByRole[role].studio_quality_proven),
    artifact_provenance_chain_is_valid: media.artifact_provenance_and_technical_receipts_valid === true,
    production_readiness_is_not_claimed: media.production_ready === false && media.studio_quality_proven === false,
    perceptual_review_is_explicitly_pending:
      media.status === 'CAPTAIN_PLANET_MEDIA_PROOF_PREPARED_PERCEPTUAL_REVIEW_PENDING'
      && media.perceptual_quality_assessed === false,
    dry_run_has_no_integrity_findings:
      dryRun.status === 'CREATIVE_ROUTE_DRY_RUN_TRUTHFUL_WITH_DECLARED_ACTIVATION_BLOCKERS'
      && dryRun.findings.length === 0,
    all_installed_activations_are_blocked_on_unmeasured_peak_memory:
      installedActivationBlocks.length === installed.length
      && dryRun.activation_blocked_count === installed.length,
    all_candidates_remain_blocked: dryRun.candidate_blocked_count === candidates.length,
    no_creative_worker_is_currently_active: topology.remote.creative_process_count === 0,
    production_lease_mutex_is_currently_available: topology.remote.lease_mutex_available === true,
    hunyuan3d_is_not_installed_or_artifact_proven:
      topology.checks.three_d_registry_claim_is_candidate_only === true
      && topology.checks.three_d_exact_paths_are_absent === true
      && topology.checks.three_d_artifact_proof_is_absent === true,
  };
  const technicalFindings = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([check]) => check);
  const blockers = [
    {
      gate: 'lease_activation',
      state: 'BLOCKED',
      roles: installedActivationBlocks.map((route) => route.role),
      reason: 'Peak process-tree working-set memory has not been measured and receipted under the 50 GiB lease ceiling.',
    },
    {
      gate: 'current_codexa_model_residency',
      state: topology.checks.at_most_one_ollama_model_is_currently_resident ? 'GREEN' : 'BLOCKED',
      running_ollama_models: topology.remote.running_ollama_models.map((model) => model.name),
      reason: topology.checks.at_most_one_ollama_model_is_currently_resident
        ? 'At most one Ollama model was resident at probe time.'
        : 'Multiple parent-owned Navigator models were resident at probe time; Captain Planet did not unload them.',
    },
    {
      gate: 'perceptual_review',
      state: media.perceptual_quality_assessed ? 'COMPLETE' : 'BLOCKED',
      roles: media.lanes.map((lane) => lane.role),
      reason: 'Prompt adherence, visual coherence, intelligibility, musical coherence, and listening quality require bounded human review.',
    },
    {
      gate: 'three_d_runtime',
      state: media.hunyuan3d.runtime_artifact_proven ? 'GREEN' : 'BLOCKED',
      roles: [source.hunyuan_role || 'three_d_hunyuan21'],
      reason: 'Hunyuan3D source, environment, weights, lease telemetry, and runtime artifact are not installed or proven.',
    },
    {
      gate: 'historical_generation_binding',
      state: media.historical_generation_input_binding_complete ? 'GREEN' : 'BLOCKED',
      roles: ['speech_qwen3_tts'],
      reason: 'The legacy TTS generation receipt did not cryptographically bind the current runner constants.',
    },
    {
      gate: 'current_large_weight_content_hashes',
      state: media.large_weight_content_hashes.current_content_hashes_recomputed ? 'GREEN' : 'HELD',
      reason: 'Large model weights were size-checked but intentionally not rehashed during the bounded no-load audit.',
    },
  ];
  return {
    schema: 'orange5.captain-planet.board8-audit.v1',
    status: technicalFindings.length === 0
      ? 'CAPTAIN_PLANET_BOARD8_TECHNICAL_GREEN_WITH_EXPLICIT_ACTIVATION_AND_PERCEPTUAL_BLOCKERS'
      : 'CAPTAIN_PLANET_BOARD8_TECHNICAL_PROOF_NEEDS_WORK',
    generated_at: new Date().toISOString(),
    scope: 'CAPTAIN_PLANET_IMAGE_VIDEO_AUDIO_3D_AND_SINGLE_SPECIALIST_LEASE_TRUTH',
    model_generation_executed: false,
    model_installed: false,
    large_weight_hashes_recomputed: false,
    installed_media_lane_count: installed.length,
    candidate_lane_count: candidates.length,
    technical_by_role: technicalByRole,
    checks,
    technical_findings: technicalFindings,
    blockers,
    evidence,
    conclusion: technicalFindings.length === 0
      ? 'Installed image, video, speech, and music artifacts are technically valid. No perceptual, studio-quality, activation-ready, or 3D-runtime claim is green.'
      : 'One or more bounded technical or provenance checks failed; no green claim is authorized.',
  };
}

export function loadBoard8Inputs(sourcePath = DEFAULT_SOURCE) {
  const sourceEvidence = readEvidence(path.relative(ROOT, path.resolve(sourcePath)));
  const source = sourceEvidence.body;
  if (source.schema !== 'orange5.captain-planet.board8-proof-source.v1') {
    throw new Error('invalid Captain Planet board 8 proof source schema');
  }
  const manifest = readEvidence(source.manifest);
  const inventory = readEvidence(source.live_inventory);
  const dryRun = readEvidence(source.route_dry_run);
  const topology = readEvidence(source.topology);
  const media = readEvidence(source.media_review_state);
  const technicalEvidence = Object.fromEntries(Object.entries(source.technical_proofs).map(
    ([role, relativePath]) => [role, readEvidence(relativePath)],
  ));
  return {
    source,
    manifest: manifest.body,
    inventory: inventory.body,
    dryRun: dryRun.body.payload || dryRun.body,
    topology: topology.body,
    media: media.body,
    technical: Object.fromEntries(Object.entries(technicalEvidence).map(([role, item]) => [role, item.body])),
    evidence: {
      source: { path: sourceEvidence.relative_path, sha256: sourceEvidence.file_sha256 },
      manifest: { path: manifest.relative_path, sha256: manifest.file_sha256 },
      live_inventory: { path: inventory.relative_path, sha256: inventory.file_sha256 },
      route_dry_run: { path: dryRun.relative_path, sha256: dryRun.file_sha256 },
      topology: { path: topology.relative_path, sha256: topology.file_sha256 },
      media_review_state: { path: media.relative_path, sha256: media.file_sha256 },
      technical_proofs: Object.fromEntries(Object.entries(technicalEvidence).map(
        ([role, item]) => [role, { path: item.relative_path, sha256: item.file_sha256 }],
      )),
    },
  };
}

async function main() {
  const { values } = parseArgs({ options: {
    source: { type: 'string', default: DEFAULT_SOURCE },
    output: { type: 'string' },
    'no-write': { type: 'boolean', default: false },
  } });
  const audit = buildBoard8Audit(loadBoard8Inputs(path.resolve(values.source)));
  if (values['no-write']) {
    process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
  } else {
    const stamp = audit.generated_at.replace(/[:.]/g, '-');
    const output = path.resolve(values.output || path.join(RECEIPT_ROOT, `${stamp}-board8-audit.json`));
    const relative = path.relative(RECEIPT_ROOT, output);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('board 8 audit receipt must remain under 14-SUPERSTACK/receipts');
    const written = writeChainedJsonReceipt(output, audit);
    process.stdout.write(`${JSON.stringify({
      status: written.status,
      technical_findings: written.technical_findings,
      blockers: written.blockers,
      receipt_path: output,
      receipt_sha256: written.receipt_sha256,
    }, null, 2)}\n`);
  }
  if (audit.technical_findings.length > 0) process.exitCode = 1;
}

if (import.meta.main) main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ status: 'CAPTAIN_PLANET_BOARD8_AUDIT_FAILED', error: error.message }, null, 2)}\n`);
  process.exitCode = 1;
});
