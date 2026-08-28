#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { writeChainedJsonReceipt } from '../10-RECEIPTS/tools/json-receipt-chain.mjs';
import {
  verifyImageArtifact,
  verifyMusicArtifact,
  verifyTtsArtifact,
  verifyVideoArtifact,
} from './captain-planet-artifact-verifier.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const RECEIPT_ROOT = path.join(ROOT, '10-RECEIPTS', 'orange5-build', 'captain-planet');
const DEFAULT_MANIFEST = path.join(ROOT, '14-SUPERSTACK', 'captain-planet-stack.json');
const DEFAULT_INVENTORY = path.join(RECEIPT_ROOT, 'installed-lane-inventory.json');
const DEFAULT_OUTPUT = path.join(RECEIPT_ROOT, 'captain-planet-artifact-quality-proof.json');
const MAX_INVENTORY_AGE_MS = 60 * 60_000;

const sha256File = (filePath) => createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
const installed = (role) => String(role.availability?.state || '').startsWith('installed_');

const lanes = {
  image_draft_flux2_klein: {
    type: 'image',
    verifier: verifyImageArtifact,
    output: 'flux2/flux2-artifact-quality-proof.json',
    expectedStatus: 'CAPTAIN_PLANET_IMAGE_TECHNICAL_QUALITY_PROVEN_VISUAL_QUALITY_UNASSESSED',
  },
  video_fallback_ltxv098: {
    type: 'video',
    verifier: verifyVideoArtifact,
    output: 'ltxv/ltx-video-artifact-quality-proof.json',
    expectedStatus: 'CAPTAIN_PLANET_VIDEO_TECHNICAL_QUALITY_PROVEN_VISUAL_QUALITY_UNASSESSED',
  },
  speech_qwen3_tts: {
    type: 'tts',
    verifier: verifyTtsArtifact,
    output: 'qwen3-tts/qwen3-tts-artifact-quality-proof.json',
    expectedStatus: 'CAPTAIN_PLANET_TTS_TECHNICAL_QUALITY_PROVEN_LISTENING_UNASSESSED',
  },
  music_ace_step15: {
    type: 'music',
    verifier: verifyMusicArtifact,
    output: 'ace-step/ace-step-artifact-quality-proof.json',
    expectedStatus: 'CAPTAIN_PLANET_MUSIC_TECHNICAL_QUALITY_PROVEN_LISTENING_UNASSESSED',
  },
};

function assertWithinReceiptRoot(filePath) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(RECEIPT_ROOT, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`proof path escapes Captain Planet receipt root: ${resolved}`);
  }
  return resolved;
}

function sourceModelMatches(role, source) {
  if (role.role === 'music_ace_step15') {
    return role.model.startsWith(source.model_id)
      && role.model.toLowerCase().includes('turbo')
      && String(source.dit_model || '').toLowerCase().endsWith('turbo');
  }
  return (source.model ?? source.model_id) === role.model;
}

function pinnedRevision(role, source) {
  const revision = role.role === 'image_draft_flux2_klein'
    ? source.model_revisions?.[source.model]
    : source.model_revision;
  return typeof revision === 'string' && /^[a-f0-9]{40,64}$/i.test(revision);
}

function inputRecorded(type, source) {
  if (type === 'tts') return typeof source.text === 'string' && source.text.length > 0;
  return typeof source.prompt === 'string' && source.prompt.length > 0;
}

function findSourceProof(role) {
  const currentPath = assertWithinReceiptRoot(path.resolve(ROOT, role.proof.receipt));
  const current = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
  const sourceReceiptPath = assertWithinReceiptRoot(current.source_receipt);
  const artifactPath = assertWithinReceiptRoot(current.artifact);
  return {
    currentPath,
    current,
    sourceReceiptPath,
    artifactPath,
    source: JSON.parse(fs.readFileSync(sourceReceiptPath, 'utf8')),
  };
}

function inventoryForRole(inventory, role) {
  const entries = inventory.entries.filter((entry) => entry.role === role);
  return {
    entries,
    all_valid: entries.length > 0 && entries.every((entry) => entry.valid),
    generated_artifact_hash_verified: entries.some((entry) => entry.evidence_kind === 'generated_proof_artifact' && entry.hash_valid),
  };
}

export function createQualityProofs(manifest, inventory, inventoryPath) {
  const inventoryAgeMs = Date.now() - Date.parse(inventory.worker_reported_at || inventory.generated_at || 'invalid');
  const inventoryFresh = Number.isFinite(inventoryAgeMs) && inventoryAgeMs >= 0 && inventoryAgeMs <= MAX_INVENTORY_AGE_MS;
  const inventoryFileSha256 = sha256File(inventoryPath);
  const laneReceipts = [];

  for (const role of manifest.roles.filter(installed)) {
    const lane = lanes[role.role];
    if (!lane) throw new Error(`installed role has no quality verifier: ${role.role}`);
    const proof = findSourceProof(role);
    const verified = lane.verifier({ artifactPath: proof.artifactPath, sourceReceiptPath: proof.sourceReceiptPath });
    const live = inventoryForRole(inventory, role.role);
    const sourceScriptPath = path.resolve(ROOT, role.activation.source_script);
    const endToEndChecks = {
      registry_declares_installed: installed(role),
      receipt_contract_matches_registry: proof.source.schema === role.activation.receipt_contract,
      source_model_matches_registry: sourceModelMatches(role, proof.source),
      source_revision_is_pinned: pinnedRevision(role, proof.source),
      source_device_is_installed_xpu: /xpu|intel\(r\) arc/i.test(String(proof.source.device || '')),
      source_generation_time_is_positive: Number(proof.source.generation_seconds) > 0,
      source_runner_exists: fs.existsSync(sourceScriptPath),
      live_inventory_is_fresh: inventoryFresh,
      live_installed_components_are_valid: live.all_valid,
      live_generated_artifact_hash_matches: live.generated_artifact_hash_verified,
      independent_runtime_chain_is_valid: verified.runtime_execution_proven === true,
      deterministic_technical_quality_checks_pass: verified.artifact_technical_quality_proven === true,
      verifier_status_matches_lane: verified.status === lane.expectedStatus,
    };
    const endToEndProven = Object.values(endToEndChecks).every(Boolean);
    const receipt = {
      ...verified,
      status: endToEndProven ? lane.expectedStatus : `CAPTAIN_PLANET_${lane.type.toUpperCase()}_END_TO_END_ARTIFACT_PROOF_NEEDS_WORK`,
      registry_role: role.role,
      registry_model: role.model,
      end_to_end_artifact_technical_quality_proven: endToEndProven,
      end_to_end_checks: endToEndChecks,
      live_inventory_receipt: inventoryPath,
      live_inventory_receipt_file_sha256: inventoryFileSha256,
      live_inventory_evidence: live,
      source_runner: sourceScriptPath,
      source_runner_sha256: sha256File(sourceScriptPath),
      source_runner_hash_linked_to_generation_receipt:
        String(proof.source.runner_sha256 || '').toLowerCase() === sha256File(sourceScriptPath),
      generation_input_recorded: inputRecorded(lane.type, proof.source),
      generation_input_traceability_note: inputRecorded(lane.type, proof.source)
        ? 'Generation input is present in the source receipt.'
        : 'Legacy source receipt omits the fixed generation input; this does not promote perceptual quality.',
    };
    const outputPath = path.join(RECEIPT_ROOT, lane.output);
    const written = writeChainedJsonReceipt(outputPath, receipt);
    laneReceipts.push({
      role: role.role,
      type: lane.type,
      status: written.status,
      end_to_end_artifact_technical_quality_proven: written.end_to_end_artifact_technical_quality_proven,
      perceptual_quality_proven: false,
      studio_quality_proven: false,
      receipt: outputPath,
      receipt_file_sha256: sha256File(outputPath),
      artifact: written.artifact,
      artifact_sha256: written.artifact_sha256,
    });
  }
  return { inventoryFresh, inventoryAgeMs, inventoryFileSha256, laneReceipts };
}

async function main() {
  const { values } = parseArgs({ options: {
    manifest: { type: 'string', default: DEFAULT_MANIFEST },
    inventory: { type: 'string', default: DEFAULT_INVENTORY },
    output: { type: 'string', default: DEFAULT_OUTPUT },
  } });
  const manifestPath = path.resolve(values.manifest);
  const inventoryPath = assertWithinReceiptRoot(values.inventory);
  const outputPath = assertWithinReceiptRoot(values.output);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
  const result = createQualityProofs(manifest, inventory, inventoryPath);
  const allProven = result.laneReceipts.length > 0
    && result.laneReceipts.every((lane) => lane.end_to_end_artifact_technical_quality_proven);
  const receipt = {
    schema: 'orange5.captain-planet.installed-artifact-quality-proof.v1',
    status: allProven
      ? 'CAPTAIN_PLANET_INSTALLED_ARTIFACT_TECHNICAL_QUALITY_PROVEN_PERCEPTUAL_QUALITY_UNASSESSED'
      : 'CAPTAIN_PLANET_INSTALLED_ARTIFACT_QUALITY_PROOF_NEEDS_WORK',
    generated_at: new Date().toISOString(),
    manifest: manifestPath,
    manifest_sha256: sha256File(manifestPath),
    live_inventory_receipt: inventoryPath,
    live_inventory_receipt_file_sha256: result.inventoryFileSha256,
    live_inventory_age_ms: result.inventoryAgeMs,
    live_inventory_fresh: result.inventoryFresh,
    installed_lane_count: result.laneReceipts.length,
    all_installed_lanes_end_to_end_artifact_technical_quality_proven: allProven,
    perceptual_quality_proven: false,
    studio_quality_proven: false,
    lanes: result.laneReceipts,
    proof_boundary: {
      proven: [
        'Fresh installed-component inventory on Codexa by exact or minimum byte size.',
        'Fresh SHA-256 identity of each generated proof artifact on Codexa.',
        'Source receipt to local artifact hash and byte continuity.',
        'Independent media decode and lane-specific deterministic technical quality checks.',
      ],
      not_proven: [
        'Prompt adherence, aesthetics, intelligibility, musical coherence, or temporal coherence.',
        'Long-form continuity, broad benchmark superiority, production readiness, or studio quality.',
        'Fresh content hashes for very large installed model weights.',
        'Legacy source receipts do not bind the exact generation-runner file hash; future runner receipts do.',
      ],
    },
  };
  const written = writeChainedJsonReceipt(outputPath, receipt);
  process.stdout.write(`${JSON.stringify({
    status: written.status,
    all_proven: written.all_installed_lanes_end_to_end_artifact_technical_quality_proven,
    lanes: written.lanes,
    receipt_path: outputPath,
    receipt_file_sha256: sha256File(outputPath),
  }, null, 2)}\n`);
  if (!allProven) process.exitCode = 1;
}

if (import.meta.main) main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ status: 'CAPTAIN_PLANET_ARTIFACT_QUALITY_PROOF_FAILED', error: error.message }, null, 2)}\n`);
  process.exitCode = 1;
});
