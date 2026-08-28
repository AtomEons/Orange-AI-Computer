import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildTtsInputAddendum, evaluateMediaProof } from './captain-planet-media-evaluation.mjs';

const roots = [];

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orange5-captain-planet-media-'));
  roots.push(root);
  const artifactRelative = 'receipts/speech.wav';
  const sourceRelative = 'receipts/source.json';
  const technicalRelative = 'receipts/technical.json';
  const runnerRelative = 'scripts/runner.py';
  const registryRelative = 'registry.json';
  const artifactPath = path.join(root, artifactRelative);
  const sourcePath = path.join(root, sourceRelative);
  const technicalPath = path.join(root, technicalRelative);
  const runnerPath = path.join(root, runnerRelative);
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.mkdirSync(path.dirname(runnerPath), { recursive: true });
  fs.writeFileSync(artifactPath, 'bounded speech artifact');
  fs.writeFileSync(runnerPath, 'PROOF_TEXT = "bounded proof"\n');
  const artifactSha256 = hash(fs.readFileSync(artifactPath));
  writeJson(sourcePath, {
    schema: 'orange.captain_planet.tts_artifact.v1',
    artifact_sha256: artifactSha256,
    artifact_bytes: fs.statSync(artifactPath).size,
  });
  writeJson(technicalPath, {
    status: 'CAPTAIN_PLANET_TTS_TECHNICAL_QUALITY_PROVEN_LISTENING_UNASSESSED',
    artifact_sha256: artifactSha256,
    source_receipt: sourcePath,
    artifact_technical_quality_proven: true,
    perceptual_quality_proven: false,
    studio_quality_proven: false,
  });
  writeJson(path.join(root, registryRelative), {
    roles: [{
      role: 'three_d_hunyuan21',
      availability: { state: 'candidate_not_observed', lease_eligible: false },
      required_artifacts: [],
      proof: { receipt: null },
    }],
  });
  const sourceReceiptSha256 = hash(fs.readFileSync(sourcePath));
  const source = {
    schema: 'orange5.captain-planet.media-proof-source.v1',
    scope: 'TEST',
    registry: registryRelative,
    hunyuan_role: 'three_d_hunyuan21',
    execution_hold: { state: 'HELD' },
    lanes: [{
      role: 'speech_qwen3_tts',
      medium: 'speech',
      artifact: artifactRelative,
      source_receipt: sourceRelative,
      technical_receipt: technicalRelative,
      expected_technical_status: 'CAPTAIN_PLANET_TTS_TECHNICAL_QUALITY_PROVEN_LISTENING_UNASSESSED',
      generation_input: {
        kind: 'recovered_current_runner_constants',
        historical_source_receipt_sha256: sourceReceiptSha256,
        source_runner: runnerRelative,
        source_runner_sha256: hash(fs.readFileSync(runnerPath)),
        values: {
          text: 'bounded proof',
          language: 'English',
          speaker: 'fixture',
          instruction: 'plain',
          max_new_tokens: 32,
        },
      },
      criteria: ['exact_text_intelligible', 'audio_artifact_absence'],
    }],
  };
  const review = {
    schema: 'orange5.captain-planet.media-perceptual-review.v1',
    reviewer: { id: null, kind: 'human', reviewed_at: null, playback_context: null },
    lanes: {
      speech_qwen3_tts: {
        artifact_sha256: artifactSha256,
        review_completed: false,
        reference_input_read: false,
        full_artifact_reviewed: false,
        criteria: {
          exact_text_intelligible: { result: 'not_reviewed', note: '' },
          audio_artifact_absence: { result: 'not_reviewed', note: '' },
        },
      },
    },
  };
  return { root, artifactPath, source, review };
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

describe('Captain Planet media provenance and perceptual evaluation', () => {
  test('prepares a bounded review without claiming perception, studio quality, weights, or Hunyuan', () => {
    const { root, source, review } = fixture();
    const proof = evaluateMediaProof({
      root,
      source,
      review,
      generatedAt: '2026-08-27T00:00:00.000Z',
      reviewSha256: 'fixture-review',
    });
    expect(proof.status).toBe('CAPTAIN_PLANET_MEDIA_PROOF_PREPARED_PERCEPTUAL_REVIEW_PENDING');
    expect(proof.perceptual_quality_assessed).toBe(false);
    expect(proof.studio_quality_proven).toBe(false);
    expect(proof.large_weight_content_hashes.current_content_hashes_recomputed).toBe(false);
    expect(proof.hunyuan3d.runtime_artifact_proven).toBe(false);
    expect(proof.historical_generation_input_binding_complete).toBe(false);
  });

  test('records a complete human acceptance using explicit observations only', () => {
    const { root, source, review } = fixture();
    review.reviewer = {
      id: 'fixture-reviewer',
      kind: 'human',
      reviewed_at: '2026-08-27T00:01:00.000Z',
      playback_context: 'Headphones at normal listening level',
    };
    review.lanes.speech_qwen3_tts = {
      ...review.lanes.speech_qwen3_tts,
      review_completed: true,
      reference_input_read: true,
      full_artifact_reviewed: true,
      criteria: {
        exact_text_intelligible: { result: 'pass', note: 'Every expected word was intelligible.' },
        audio_artifact_absence: { result: 'pass', note: 'No click, dropout, or metallic breakup was heard.' },
      },
    };
    const proof = evaluateMediaProof({ root, source, review });
    expect(proof.status).toBe('CAPTAIN_PLANET_MEDIA_PERCEPTUAL_REVIEW_COMPLETE_ACCEPTED');
    expect(proof.perceptual_quality_assessed).toBe(true);
    expect(proof.perceptual_quality_accepted).toBe(true);
    expect(proof.model_judgment_used).toBe(false);
  });

  test('preserves explicit perceptual findings instead of averaging them away', () => {
    const { root, source, review } = fixture();
    review.reviewer = {
      id: 'fixture-reviewer',
      kind: 'human',
      reviewed_at: '2026-08-27T00:01:00.000Z',
      playback_context: 'Headphones at normal listening level',
    };
    review.lanes.speech_qwen3_tts = {
      ...review.lanes.speech_qwen3_tts,
      review_completed: true,
      reference_input_read: true,
      full_artifact_reviewed: true,
      criteria: {
        exact_text_intelligible: { result: 'pass', note: 'Every expected word was intelligible.' },
        audio_artifact_absence: { result: 'fail', note: 'A metallic breakup was audible near the end.' },
      },
    };
    const proof = evaluateMediaProof({ root, source, review });
    expect(proof.status).toBe('CAPTAIN_PLANET_MEDIA_PERCEPTUAL_REVIEW_COMPLETE_WITH_FINDINGS');
    expect(proof.perceptual_quality_assessed).toBe(true);
    expect(proof.perceptual_quality_accepted).toBe(false);
    expect(proof.lanes[0].perceptual_review.failed_criteria).toEqual(['audio_artifact_absence']);
  });

  test('rejects artifact substitution before perceptual results can be accepted', () => {
    const { root, artifactPath, source, review } = fixture();
    fs.appendFileSync(artifactPath, 'tamper');
    expect(() => evaluateMediaProof({ root, source, review })).toThrow('provenance or technical receipt check failed');
  });

  test('documents TTS input while retaining the historical runner-binding limitation', () => {
    const { root, source, review } = fixture();
    const proof = evaluateMediaProof({ root, source, review });
    const addendum = buildTtsInputAddendum(proof);
    expect(addendum.review_packet_input_complete).toBe(true);
    expect(addendum.generation_input.text).toBe('bounded proof');
    expect(addendum.historical_generation_input_cryptographically_bound).toBe(false);
    expect(addendum.perceptual_quality_proven).toBe(false);
  });

  test('rejects completed reviews without human observations and context', () => {
    const { root, source, review } = fixture();
    review.lanes.speech_qwen3_tts.review_completed = true;
    expect(() => evaluateMediaProof({ root, source, review })).toThrow('qualified human reviewer metadata');
  });
});
