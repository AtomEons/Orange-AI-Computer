import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import {
  activationCommand,
  cleanupPlan,
  dryRunRoute,
  leaseDecision,
  loadManifest,
} from './captain-planet-governor.mjs';

const manifest = loadManifest();

describe('Captain Planet creative lease registry', () => {
  test('enforces one specialist and a hard 50 GiB ceiling', () => {
    expect(manifest.policy.live_model_memory_ceiling_bytes).toBe(50 * 1024 ** 3);
    expect(manifest.policy.max_active_heavy_leases).toBe(1);
    expect(manifest.policy.execution).toBe('single_specialist_lease');
  });

  test('blocks candidates and unmeasured memory', () => {
    const candidate = manifest.roles.find((item) => item.role === 'video_modern_ltx25');
    expect(leaseDecision(manifest, candidate).allowed).toBe(false);
    expect(leaseDecision(manifest, candidate).reason).toBe('candidate_or_unavailable');
    const installed = manifest.roles.find((item) => item.role === 'image_draft_flux2_klein');
    const unmeasured = {
      ...installed,
      availability: { ...installed.availability, lease_eligible: true },
    };
    expect(leaseDecision(manifest, unmeasured).allowed).toBe(false);
    expect(leaseDecision(manifest, unmeasured).reason).toBe('unmeasured_peak_memory');
  });

  test('allows an installed route only with a measured peak receipt under the ceiling', () => {
    const installed = manifest.roles.find((item) => item.role === 'image_draft_flux2_klein');
    const measured = {
      ...installed,
      availability: { ...installed.availability, lease_eligible: true },
      memory_measurement: {
        state: 'measured',
        peak_process_tree_working_set_bytes: 24 * 1024 ** 3,
        receipt: 'receipts/fixture-lease.json',
      },
    };
    const decision = leaseDecision(manifest, measured);
    expect(decision.allowed).toBe(true);
    expect(decision.measured_peak_bytes).toBe(24 * 1024 ** 3);
  });

  test('installed routes carry bounded end-to-end technical artifact proof', () => {
    const installed = manifest.roles.filter((item) => item.availability.state.startsWith('installed_'));
    expect(installed.length).toBe(4);
    for (const role of installed) {
      const plan = dryRunRoute(manifest, role.role);
      expect(plan.findings).toEqual([]);
      expect(plan.proof.runtime_execution_proven).toBe(true);
      expect(plan.proof.artifact_technical_quality_proven).toBe(true);
      expect(plan.proof.end_to_end_artifact_technical_quality_proven).toBe(true);
      expect(plan.proof.proof_is_fresh).toBe(true);
      expect(plan.proof.perceptual_quality_proven).toBe(false);
      expect(plan.proof.studio_quality_proven).toBe(false);
      expect(plan.status).toBe('DRY_RUN_TECHNICAL_QUALITY_PROVEN_ACTIVATION_BLOCKED');
      expect(plan.decision.reason).toBe('unmeasured_peak_memory');
      expect(plan.activation_blockers).toEqual(['unmeasured_peak_memory']);
    }
  });

  test('every route renders a command and receipt contract', () => {
    for (const role of manifest.roles) {
      expect(activationCommand(role).join(' ')).toContain(role.role);
      expect(role.activation.receipt_contract).toBeTruthy();
    }
  });

  test('cleanup cannot select unowned Navigator or other Ollama models', () => {
    const remove = cleanupPlan(manifest, [
      { name: 'orange-navigator:hot-v1' },
      { name: 'qwen3-coder:30b' },
      { name: 'unrelated:latest' },
    ]);
    expect(remove).toEqual([]);
  });

  test('remote lease host independently enforces mutex, process overlap, and measured memory', () => {
    const worker = fs.readFileSync(new URL('./codexa-creative-lease.ps1', import.meta.url), 'utf8');
    expect(worker).toContain('$mutex.WaitOne(0)');
    expect(worker).toContain('Creative worker already active');
    expect(worker).toContain('Route lacks a measured peak-memory receipt');
    expect(worker).toContain('Measured route peak exceeds memory ceiling');
  });
});
