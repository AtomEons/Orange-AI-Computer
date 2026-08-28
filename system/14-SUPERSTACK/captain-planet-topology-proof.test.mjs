import { describe, expect, test } from 'bun:test';
import { buildProbePayload, evaluateTopology } from './captain-planet-topology-proof.mjs';

function fixture() {
  const manifest = {
    policy: {
      lease_mutex: 'Global\\OrangeFiveCaptainPlanetCreativeLease',
      creative_process_markers: ['creative-proof.py'],
    },
    hosts: { worker: 'CODEXA', worker_user: 'Atom' },
    ollama: { worker_base_url: 'http://127.0.0.1:11434' },
    roles: [{
      role: 'three_d_hunyuan21',
      availability: { state: 'candidate_not_observed', lease_eligible: false },
      installation_probe_paths: ['C:/bounded/Hunyuan3D-2.1'],
      required_artifacts: [],
      proof: { receipt: null },
    }],
  };
  const remote = {
    host: 'CODEXA',
    lease_mutex_available: true,
    creative_process_count: 0,
    creative_processes: [],
    running_ollama_model_count: 1,
    running_ollama_models: [{ name: 'orange-navigator:test' }],
    ollama_probe_error: null,
    three_d_exact_path_probe: [{ path: 'C:/bounded/Hunyuan3D-2.1', exists: false }],
    model_loaded_by_probe: false,
    files_written_by_probe: false,
  };
  return { manifest, remote };
}

describe('Captain Planet board 8 topology proof', () => {
  test('builds a bounded payload from declared policy and 3D paths', () => {
    const { manifest } = fixture();
    expect(buildProbePayload(manifest)).toEqual({
      mutex: manifest.policy.lease_mutex,
      markers: manifest.policy.creative_process_markers,
      three_d_role: 'three_d_hunyuan21',
      three_d_paths: ['C:/bounded/Hunyuan3D-2.1'],
      ollama_base_url: manifest.ollama.worker_base_url,
    });
  });

  test('accepts one resident Navigator while proving no creative worker or 3D install', () => {
    const { manifest, remote } = fixture();
    const proof = evaluateTopology(manifest, remote);
    expect(proof.status).toBe('CAPTAIN_PLANET_BOARD8_LIVE_TOPOLOGY_GREEN_3D_NOT_INSTALLED');
    expect(proof.checks.at_most_one_ollama_model_is_currently_resident).toBe(true);
    expect(proof.checks.three_d_exact_paths_are_absent).toBe(true);
    expect(proof.model_generation_executed).toBe(false);
  });

  test('reports overlapping residency and an observed 3D path', () => {
    const { manifest, remote } = fixture();
    remote.running_ollama_model_count = 2;
    remote.three_d_exact_path_probe[0].exists = true;
    const proof = evaluateTopology(manifest, remote);
    expect(proof.status).toBe('CAPTAIN_PLANET_BOARD8_LIVE_TOPOLOGY_NEEDS_WORK');
    expect(proof.findings).toEqual([
      'at_most_one_ollama_model_is_currently_resident',
      'three_d_exact_paths_are_absent',
    ]);
  });
});
