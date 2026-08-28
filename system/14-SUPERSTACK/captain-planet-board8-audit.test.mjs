import { describe, expect, test } from 'bun:test';
import { buildBoard8Audit } from './captain-planet-board8-audit.mjs';

const statusByRole = {
  image_draft_flux2_klein: 'CAPTAIN_PLANET_IMAGE_TECHNICAL_QUALITY_PROVEN_VISUAL_QUALITY_UNASSESSED',
  video_fallback_ltxv098: 'CAPTAIN_PLANET_VIDEO_TECHNICAL_QUALITY_PROVEN_VISUAL_QUALITY_UNASSESSED',
  speech_qwen3_tts: 'CAPTAIN_PLANET_TTS_TECHNICAL_QUALITY_PROVEN_LISTENING_UNASSESSED',
  music_ace_step15: 'CAPTAIN_PLANET_MUSIC_TECHNICAL_QUALITY_PROVEN_LISTENING_UNASSESSED',
};

function fixture() {
  const installed = Object.keys(statusByRole);
  return {
    source: { hunyuan_role: 'three_d_hunyuan21' },
    manifest: {
      roles: [
        ...installed.map((role) => ({ role, availability: { state: 'installed_runtime_proven_quality_unassessed' } })),
        { role: 'three_d_hunyuan21', availability: { state: 'candidate_not_observed' } },
      ],
    },
    inventory: { status: 'CAPTAIN_PLANET_LIVE_INSTALLED_ARTIFACT_INVENTORY_GREEN', all_valid: true },
    dryRun: {
      status: 'CREATIVE_ROUTE_DRY_RUN_TRUTHFUL_WITH_DECLARED_ACTIVATION_BLOCKERS',
      findings: [],
      activation_blocked_count: 4,
      candidate_blocked_count: 1,
      routes: installed.map((role) => ({ role, installed_claim: true, activation_blockers: ['unmeasured_peak_memory'] })),
    },
    topology: {
      checks: {
        at_most_one_ollama_model_is_currently_resident: false,
        three_d_registry_claim_is_candidate_only: true,
        three_d_exact_paths_are_absent: true,
        three_d_artifact_proof_is_absent: true,
      },
      remote: {
        creative_process_count: 0,
        lease_mutex_available: true,
        running_ollama_models: [{ name: 'navigator:a' }, { name: 'navigator:b' }],
      },
    },
    media: {
      status: 'CAPTAIN_PLANET_MEDIA_PROOF_PREPARED_PERCEPTUAL_REVIEW_PENDING',
      artifact_provenance_and_technical_receipts_valid: true,
      production_ready: false,
      studio_quality_proven: false,
      perceptual_quality_assessed: false,
      historical_generation_input_binding_complete: false,
      large_weight_content_hashes: { current_content_hashes_recomputed: false },
      hunyuan3d: { runtime_artifact_proven: false },
      lanes: installed.map((role) => ({ role })),
    },
    technical: Object.fromEntries(installed.map((role) => [role, {
      status: statusByRole[role],
      artifact_sha256: role,
      runtime_execution_proven: true,
      artifact_technical_quality_proven: true,
      perceptual_quality_proven: false,
      studio_quality_proven: false,
    }])),
    evidence: { fixture: true },
  };
}

describe('Captain Planet board 8 audit', () => {
  test('keeps technical green separate from activation and perception blockers', () => {
    const audit = buildBoard8Audit(fixture());
    expect(audit.status).toBe('CAPTAIN_PLANET_BOARD8_TECHNICAL_GREEN_WITH_EXPLICIT_ACTIVATION_AND_PERCEPTUAL_BLOCKERS');
    expect(audit.technical_findings).toEqual([]);
    expect(audit.blockers.find((item) => item.gate === 'current_codexa_model_residency').state).toBe('BLOCKED');
    expect(audit.blockers.find((item) => item.gate === 'perceptual_review').state).toBe('BLOCKED');
    expect(audit.conclusion).toContain('No perceptual, studio-quality, activation-ready, or 3D-runtime claim is green');
  });

  test('fails technical proof when a receipt claims studio quality', () => {
    const input = fixture();
    input.technical.image_draft_flux2_klein.studio_quality_proven = true;
    const audit = buildBoard8Audit(input);
    expect(audit.status).toBe('CAPTAIN_PLANET_BOARD8_TECHNICAL_PROOF_NEEDS_WORK');
    expect(audit.technical_findings).toContain('all_four_artifacts_independently_pass_technical_checks');
    expect(audit.technical_findings).toContain('no_technical_receipt_claims_studio_quality');
  });
});
