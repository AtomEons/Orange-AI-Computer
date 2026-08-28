import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectAdapter } from './promotion-preflight.mjs';

const dirs = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

function fixture({ base = 'unsloth/qwen2.5-32b-instruct-bnb-4bit', peft = 'LORA' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'orangebrain-preflight-'));
  dirs.push(root);
  const adapterDir = join(root, 'adapter');
  mkdirSync(adapterDir);
  const weights = Buffer.from('deterministic-test-adapter');
  writeFileSync(join(adapterDir, 'adapter_model.safetensors'), weights);
  writeFileSync(join(adapterDir, 'adapter_config.json'), JSON.stringify({
    base_model_name_or_path: base,
    auto_mapping: { base_model_class: 'Qwen2ForCausalLM' },
    peft_type: peft,
    r: 16,
    lora_alpha: 32,
    target_modules: ['q_proj', 'k_proj', 'v_proj', 'o_proj'],
  }));
  writeFileSync(join(adapterDir, 'trainer_state.json'), JSON.stringify({ global_step: 375, epoch: 3 }));
  return {
    adapterDir,
    expected: {
      adapterSha256: createHash('sha256').update(weights).digest('hex'),
      baseFamily: 'qwen2.5-32b-instruct', modelClass: 'Qwen2ForCausalLM', peftType: 'LORA', minimumBytes: 1,
    },
  };
}

describe('OrangeBrain adapter promotion preflight', () => {
  test('proves exact adapter provenance but does not invent runtime readiness', () => {
    const args = fixture();
    const result = inspectAdapter(args);
    expect(result.provenanceValid).toBe(true);
    expect(result.runtimeReady).toBe(false);
    expect(result.verdict).toBe('ADAPTER_VERIFIED_NOT_RUNTIME_READY');
  });

  test('requires the exact base family', () => {
    const args = fixture({ base: 'Qwen/Qwen3-30B-A3B-Instruct' });
    const result = inspectAdapter(args);
    expect(result.provenanceValid).toBe(false);
    expect(result.checks.find((item) => item.id === 'base_family_exact').ok).toBe(false);
  });

  test('marks a candidate present only when runtime inventory proves its name', () => {
    const args = fixture();
    const result = inspectAdapter({ ...args, runtimeModels: ['orangebrain-trained:v0'] });
    expect(result.provenanceValid).toBe(true);
    expect(result.runtimeReady).toBe(true);
    expect(result.verdict).toBe('ADAPTER_VERIFIED_RUNTIME_CANDIDATE_PRESENT');
  });

  test('accepts the latest completed checkpoint as training proof', () => {
    const args = fixture();
    rmSync(join(args.adapterDir, 'trainer_state.json'));
    mkdirSync(join(args.adapterDir, 'checkpoint-375'));
    writeFileSync(join(args.adapterDir, 'checkpoint-375', 'trainer_state.json'), JSON.stringify({ global_step: 375, epoch: 3 }));
    expect(inspectAdapter(args).provenanceValid).toBe(true);
  });
});
