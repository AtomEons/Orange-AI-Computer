#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { writeChainedJsonReceipt } from '../10-RECEIPTS/tools/json-receipt-chain.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DEFAULT_SOURCE = path.join(import.meta.dirname, 'captain-planet-media-proof-source.json');
const DEFAULT_REVIEW = path.join(import.meta.dirname, 'captain-planet-media-review.json');
const DEFAULT_OUTPUT = path.join(ROOT, '10-RECEIPTS', 'orange5-build', 'captain-planet', 'captain-planet-media-evaluation-proof.json');
const DEFAULT_TTS_ADDENDUM = path.join(ROOT, '10-RECEIPTS', 'orange5-build', 'captain-planet', 'qwen3-tts', 'qwen3-tts-source-input-addendum.json');
const REVIEW_SCHEMA = 'orange5.captain-planet.media-perceptual-review.v1';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolveUnderRoot(root, relativePath) {
  if (path.isAbsolute(relativePath)) throw new Error(`proof source path must be relative: ${relativePath}`);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`proof source path escapes root: ${relativePath}`);
  }
  return resolved;
}

function allTrue(checks) {
  return Object.values(checks).every(Boolean);
}

function inputFromSource({ lane, source, sourcePath, root }) {
  const contract = lane.generation_input;
  if (contract.kind === 'source_receipt_fields') {
    const values = Object.fromEntries(contract.fields.map((field) => [field, source[field]]));
    const complete = Object.values(values).every((value) => value !== null && value !== undefined && value !== '');
    return {
      kind: contract.kind,
      values,
      documented_for_review: complete,
      historical_generation_input_cryptographically_bound: complete,
      evidence: path.resolve(sourcePath),
    };
  }
  if (contract.kind !== 'recovered_current_runner_constants') {
    throw new Error(`unsupported generation input contract for ${lane.role}: ${contract.kind}`);
  }
  const runnerPath = resolveUnderRoot(root, contract.source_runner);
  const sourceReceiptSha256 = sha256File(sourcePath);
  const runnerSha256 = sha256File(runnerPath);
  const valuesComplete = Object.values(contract.values || {}).every(
    (value) => value !== null && value !== undefined && value !== '',
  );
  const checks = {
    historical_source_receipt_hash_matches: sourceReceiptSha256 === contract.historical_source_receipt_sha256,
    current_runner_hash_matches: runnerSha256 === contract.source_runner_sha256,
    recovered_values_are_complete: valuesComplete,
  };
  if (!allTrue(checks)) throw new Error(`recovered generation input evidence failed for ${lane.role}`);
  return {
    kind: contract.kind,
    values: contract.values,
    documented_for_review: true,
    historical_generation_input_cryptographically_bound: false,
    evidence: {
      historical_source_receipt: path.resolve(sourcePath),
      historical_source_receipt_sha256: sourceReceiptSha256,
      current_runner: runnerPath,
      current_runner_sha256: runnerSha256,
      checks,
    },
    limitation: 'The current fixed runner constants recover the missing review input, but the legacy generation receipt did not bind that runner hash.',
  };
}

function validatePendingReview(lane, reviewLane) {
  if (reviewLane.review_completed !== false) return;
  for (const criterion of lane.criteria) {
    const observation = reviewLane.criteria?.[criterion];
    if (!observation || observation.result !== 'not_reviewed' || observation.note !== '') {
      throw new Error(`pending review must remain unscored for ${lane.role}.${criterion}`);
    }
  }
}

function validateCompletedReview(lane, reviewLane, reviewer) {
  const reviewerReady = reviewer?.kind === 'human'
    && typeof reviewer.id === 'string' && reviewer.id.trim().length > 0
    && Number.isFinite(Date.parse(reviewer.reviewed_at || ''))
    && typeof reviewer.playback_context === 'string' && reviewer.playback_context.trim().length > 0;
  if (!reviewerReady) throw new Error(`completed review lacks qualified human reviewer metadata for ${lane.role}`);
  if (reviewLane.reference_input_read !== true || reviewLane.full_artifact_reviewed !== true) {
    throw new Error(`completed review did not confirm full artifact and reference input for ${lane.role}`);
  }
  const observations = {};
  for (const criterion of lane.criteria) {
    const observation = reviewLane.criteria?.[criterion];
    if (!observation || !['pass', 'fail'].includes(observation.result)) {
      throw new Error(`completed review lacks pass/fail result for ${lane.role}.${criterion}`);
    }
    if (typeof observation.note !== 'string' || observation.note.trim().length === 0) {
      throw new Error(`completed review lacks observation note for ${lane.role}.${criterion}`);
    }
    observations[criterion] = { result: observation.result, note: observation.note.trim() };
  }
  return observations;
}

function inspectLane({ lane, review, root }) {
  const artifactPath = resolveUnderRoot(root, lane.artifact);
  const sourcePath = resolveUnderRoot(root, lane.source_receipt);
  const technicalPath = resolveUnderRoot(root, lane.technical_receipt);
  const source = readJson(sourcePath);
  const technical = readJson(technicalPath);
  const artifactSha256 = sha256File(artifactPath);
  const sourceSha256 = sha256File(sourcePath);
  const technicalSha256 = sha256File(technicalPath);
  const technicalSourcePath = path.resolve(String(technical.source_receipt || ''));
  const checks = {
    artifact_hash_matches_source_receipt: artifactSha256 === String(source.artifact_sha256 || '').toLowerCase(),
    artifact_hash_matches_technical_receipt: artifactSha256 === String(technical.artifact_sha256 || '').toLowerCase(),
    artifact_size_matches_source_receipt: fs.statSync(artifactPath).size === Number(source.artifact_bytes),
    technical_receipt_binds_source_receipt: technicalSourcePath === sourcePath,
    technical_status_matches_lane: technical.status === lane.expected_technical_status,
    technical_quality_is_proven: technical.artifact_technical_quality_proven === true,
    technical_receipt_does_not_claim_perceptual_quality: technical.perceptual_quality_proven === false,
    technical_receipt_does_not_claim_studio_quality: technical.studio_quality_proven === false,
  };
  if (!allTrue(checks)) throw new Error(`provenance or technical receipt check failed for ${lane.role}`);

  const generationInput = inputFromSource({ lane, source, sourcePath, root });
  const reviewLane = review.lanes?.[lane.role];
  if (!reviewLane) throw new Error(`review input lacks lane: ${lane.role}`);
  if (String(reviewLane.artifact_sha256 || '').toLowerCase() !== artifactSha256) {
    throw new Error(`review artifact hash does not match current artifact for ${lane.role}`);
  }
  validatePendingReview(lane, reviewLane);
  const observations = reviewLane.review_completed
    ? validateCompletedReview(lane, reviewLane, review.reviewer)
    : Object.fromEntries(lane.criteria.map((criterion) => [criterion, { result: 'not_reviewed', note: '' }]));
  const reviewComplete = reviewLane.review_completed === true;
  const failedCriteria = Object.entries(observations)
    .filter(([, observation]) => observation.result === 'fail')
    .map(([criterion]) => criterion);

  return {
    role: lane.role,
    medium: lane.medium,
    artifact: artifactPath,
    artifact_bytes: fs.statSync(artifactPath).size,
    artifact_sha256: artifactSha256,
    source_receipt: sourcePath,
    source_receipt_sha256: sourceSha256,
    technical_receipt: technicalPath,
    technical_receipt_sha256: technicalSha256,
    provenance_checks: checks,
    generation_input: generationInput,
    declared_model_weight_hash_count: Object.keys(source.model_hashes || {}).length,
    current_large_weight_content_hashes_recomputed: false,
    perceptual_review: {
      status: !reviewComplete ? 'PENDING' : failedCriteria.length === 0 ? 'ACCEPTED' : 'COMPLETE_WITH_FINDINGS',
      complete: reviewComplete,
      accepted: reviewComplete && failedCriteria.length === 0,
      failed_criteria: failedCriteria,
      observations,
    },
  };
}

export function evaluateMediaProof({ root = ROOT, source, review, generatedAt = new Date().toISOString(), reviewSha256 = null }) {
  if (source.schema !== 'orange5.captain-planet.media-proof-source.v1') {
    throw new Error('invalid Captain Planet media proof source schema');
  }
  if (review.schema !== REVIEW_SCHEMA) throw new Error('invalid Captain Planet perceptual review schema');
  if (!Array.isArray(source.lanes) || source.lanes.length === 0) throw new Error('media proof source has no lanes');
  const roles = source.lanes.map((lane) => lane.role);
  if (new Set(roles).size !== roles.length) throw new Error('media proof source contains duplicate roles');

  const lanes = source.lanes.map((lane) => inspectLane({ lane, review, root }));
  const completeCount = lanes.filter((lane) => lane.perceptual_review.complete).length;
  const acceptedCount = lanes.filter((lane) => lane.perceptual_review.accepted).length;
  const reviewComplete = completeCount === lanes.length;
  const reviewAccepted = reviewComplete && acceptedCount === lanes.length;
  const registryPath = resolveUnderRoot(root, source.registry);
  const registry = readJson(registryPath);
  const hunyuan = registry.roles?.find((role) => role.role === source.hunyuan_role);
  if (!hunyuan) throw new Error(`registry lacks Hunyuan role: ${source.hunyuan_role}`);
  const hunyuanChecks = {
    state_is_candidate_not_observed: hunyuan.availability?.state === 'candidate_not_observed',
    lease_is_blocked: hunyuan.availability?.lease_eligible === false,
    required_artifacts_are_absent: Array.isArray(hunyuan.required_artifacts) && hunyuan.required_artifacts.length === 0,
    artifact_receipt_is_absent: hunyuan.proof?.receipt === null,
  };
  if (!allTrue(hunyuanChecks)) throw new Error('Hunyuan unproven boundary changed; review source before continuing');

  const status = completeCount === 0
    ? 'CAPTAIN_PLANET_MEDIA_PROOF_PREPARED_PERCEPTUAL_REVIEW_PENDING'
    : !reviewComplete
      ? 'CAPTAIN_PLANET_MEDIA_PERCEPTUAL_REVIEW_PARTIAL'
      : reviewAccepted
        ? 'CAPTAIN_PLANET_MEDIA_PERCEPTUAL_REVIEW_COMPLETE_ACCEPTED'
        : 'CAPTAIN_PLANET_MEDIA_PERCEPTUAL_REVIEW_COMPLETE_WITH_FINDINGS';
  return {
    schema: 'orange5.captain-planet.media-provenance-perceptual-proof.v1',
    status,
    generated_at: generatedAt,
    scope: source.scope,
    deterministic_harness: true,
    model_judgment_used: false,
    model_generation_executed: false,
    studio_quality_proven: false,
    production_ready: false,
    artifact_provenance_and_technical_receipts_valid: true,
    generation_inputs_documented_for_review: lanes.every((lane) => lane.generation_input.documented_for_review),
    historical_generation_input_binding_complete: lanes.every(
      (lane) => lane.generation_input.historical_generation_input_cryptographically_bound,
    ),
    perceptual_quality_assessed: reviewComplete,
    perceptual_quality_accepted: reviewAccepted,
    review_input_sha256: reviewSha256,
    reviewer: completeCount > 0 ? review.reviewer : null,
    lane_count: lanes.length,
    completed_review_count: completeCount,
    accepted_review_count: acceptedCount,
    lanes,
    large_weight_content_hashes: {
      current_content_hashes_recomputed: false,
      state: 'HELD_NOT_PROVEN_CURRENT',
      declared_generation_receipt_hash_count: lanes.reduce(
        (sum, lane) => sum + lane.declared_model_weight_hash_count,
        0,
      ),
      limitation: 'Legacy generation receipts may declare weight hashes, but this bounded N150 proof does not rehash current Codexa model files.',
    },
    hunyuan3d: {
      runtime_artifact_proven: false,
      state: hunyuan.availability.state,
      checks: hunyuanChecks,
    },
    execution_hold: source.execution_hold,
    next_gate: 'A human reviewer records one bounded full-artifact review per lane; model generation and large-weight rehash remain held.',
  };
}

export function buildTtsInputAddendum(proof) {
  const tts = proof.lanes.find((lane) => lane.role === 'speech_qwen3_tts');
  if (!tts || tts.generation_input.kind !== 'recovered_current_runner_constants') {
    throw new Error('proof lacks recovered Qwen3-TTS generation input');
  }
  return {
    schema: 'orange5.captain-planet.tts-source-input-addendum.v1',
    status: 'CAPTAIN_PLANET_TTS_SOURCE_INPUT_DOCUMENTED_WITH_HISTORICAL_BINDING_GAP',
    generated_at: proof.generated_at,
    artifact: tts.artifact,
    artifact_sha256: tts.artifact_sha256,
    historical_source_receipt: tts.source_receipt,
    historical_source_receipt_sha256: tts.source_receipt_sha256,
    generation_input: tts.generation_input.values,
    review_packet_input_complete: true,
    historical_generation_input_cryptographically_bound: false,
    evidence: tts.generation_input.evidence,
    limitation: tts.generation_input.limitation,
    model_generation_executed: false,
    perceptual_quality_proven: false,
    studio_quality_proven: false,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      source: { type: 'string', default: DEFAULT_SOURCE },
      review: { type: 'string', default: DEFAULT_REVIEW },
      output: { type: 'string', default: DEFAULT_OUTPUT },
      'tts-addendum': { type: 'string', default: DEFAULT_TTS_ADDENDUM },
      'no-write': { type: 'boolean', default: false },
    },
  });
  const sourcePath = path.resolve(values.source);
  const reviewPath = path.resolve(values.review);
  const proof = evaluateMediaProof({
    source: readJson(sourcePath),
    review: readJson(reviewPath),
    reviewSha256: sha256File(reviewPath),
  });
  const addendum = buildTtsInputAddendum(proof);
  if (values['no-write']) {
    process.stdout.write(`${JSON.stringify({ proof, tts_addendum: addendum }, null, 2)}\n`);
    return;
  }
  const writtenAddendum = writeChainedJsonReceipt(path.resolve(values['tts-addendum']), addendum);
  const writtenProof = writeChainedJsonReceipt(path.resolve(values.output), {
    ...proof,
    tts_source_input_addendum: path.resolve(values['tts-addendum']),
    tts_source_input_addendum_sha256: sha256File(path.resolve(values['tts-addendum'])),
  });
  process.stdout.write(`${JSON.stringify({
    status: writtenProof.status,
    perceptual_quality_assessed: writtenProof.perceptual_quality_assessed,
    historical_generation_input_binding_complete: writtenProof.historical_generation_input_binding_complete,
    large_weight_content_hashes: writtenProof.large_weight_content_hashes.state,
    hunyuan3d_runtime_artifact_proven: writtenProof.hunyuan3d.runtime_artifact_proven,
    tts_addendum_status: writtenAddendum.status,
    proof_path: path.resolve(values.output),
    tts_addendum_path: path.resolve(values['tts-addendum']),
  }, null, 2)}\n`);
}

if (import.meta.main) main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ status: 'CAPTAIN_PLANET_MEDIA_PROOF_FAILED', error: error.message }, null, 2)}\n`);
  process.exitCode = 1;
});
