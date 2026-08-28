#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..', '..');
export const EXPECTED = Object.freeze({
  adapterSha256: '852d3386d995a19b06485dcfb5afd161caa6c4301cfb1d7b94e295ea132c7fd7',
  baseFamily: 'qwen2.5-32b-instruct',
  modelClass: 'Qwen2ForCausalLM',
  peftType: 'LORA',
  minimumBytes: 500_000_000,
});

function sha256(path) {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  return hash.digest('hex');
}

function normalizeBase(value = '') {
  return value.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '');
}

export function inspectAdapter({
  adapterDir = join(HERE, 'adapter'),
  expected = EXPECTED,
  runtimeModels = [],
  candidateModel = 'orangebrain-trained:v0',
} = {}) {
  const configPath = join(adapterDir, 'adapter_config.json');
  const modelPath = join(adapterDir, 'adapter_model.safetensors');
  const trainerCandidates = [
    join(adapterDir, 'trainer_state.json'),
    ...readdirSync(adapterDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^checkpoint-\d+$/.test(entry.name))
      .sort((a, b) => Number(b.name.slice(11)) - Number(a.name.slice(11)))
      .map((entry) => join(adapterDir, entry.name, 'trainer_state.json')),
  ];
  const trainerPath = trainerCandidates.find(existsSync);
  const checks = [];
  const check = (id, ok, evidence) => checks.push({ id, ok: Boolean(ok), evidence });

  check('adapter_config_exists', existsSync(configPath), configPath);
  check('adapter_weights_exist', existsSync(modelPath), modelPath);
  if (!existsSync(configPath) || !existsSync(modelPath)) {
    return { checks, provenanceValid: false, runtimeReady: false, verdict: 'ADAPTER_INVALID' };
  }

  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const bytes = statSync(modelPath).size;
  const digest = sha256(modelPath);
  const actualBase = normalizeBase(config.base_model_name_or_path);
  check('adapter_hash_exact', digest === expected.adapterSha256.toLowerCase(), digest);
  check('adapter_size_plausible', bytes >= expected.minimumBytes, bytes);
  check('base_family_exact', actualBase.includes(expected.baseFamily), config.base_model_name_or_path);
  check('model_architecture_exact', config.auto_mapping?.base_model_class === expected.modelClass, config.auto_mapping?.base_model_class);
  check('peft_type_exact', config.peft_type === expected.peftType, config.peft_type);
  check('lora_rank_present', Number.isInteger(config.r) && config.r > 0, config.r);
  check('target_modules_present', Array.isArray(config.target_modules) && config.target_modules.length >= 4, config.target_modules);

  let trainer = null;
  if (trainerPath) {
    trainer = JSON.parse(readFileSync(trainerPath, 'utf8'));
    check('training_completed', Number(trainer.global_step) > 0 && Number(trainer.epoch) > 0, {
      global_step: trainer.global_step,
      epoch: trainer.epoch,
    });
  } else {
    check('training_completed', false, 'trainer_state.json missing from adapter and checkpoints');
  }

  const provenanceValid = checks.every((item) => item.ok);
  const runtimeReady = runtimeModels.some((name) => name.toLowerCase() === candidateModel.toLowerCase());
  return {
    schema: 'orange5.orangebrain.adapter-preflight.v1',
    generated_at: new Date().toISOString(),
    adapterDir,
    candidateModel,
    adapter: {
      sha256: digest,
      bytes,
      base: config.base_model_name_or_path,
      architecture: config.auto_mapping?.base_model_class,
      peftType: config.peft_type,
      rank: config.r,
      alpha: config.lora_alpha,
      targetModules: config.target_modules,
      trainingSteps: trainer?.global_step ?? null,
      trainingEpochs: trainer?.epoch ?? null,
    },
    checks,
    provenanceValid,
    runtimeReady,
    verdict: !provenanceValid
      ? 'ADAPTER_INVALID'
      : runtimeReady
        ? 'ADAPTER_VERIFIED_RUNTIME_CANDIDATE_PRESENT'
        : 'ADAPTER_VERIFIED_NOT_RUNTIME_READY',
  };
}

async function listRuntimeModels(baseUrl) {
  if (!baseUrl) return [];
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`Ollama model inventory failed: HTTP ${response.status}`);
  const payload = await response.json();
  return (payload.models ?? []).map((item) => item.name);
}

async function main() {
  const args = process.argv.slice(2);
  const value = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const adapterDir = resolve(value('--adapter-dir') ?? join(HERE, 'adapter'));
  const candidateModel = value('--candidate-model') ?? 'orangebrain-trained:v0';
  const ollamaUrl = value('--ollama-url') ?? process.env.ORANGE5_CODEXA_OLLAMA_URL;
  let runtimeModels = [];
  let runtimeProbeError = null;
  if (ollamaUrl) {
    try { runtimeModels = await listRuntimeModels(ollamaUrl); }
    catch (error) { runtimeProbeError = error?.message ?? String(error); }
  }
  const result = inspectAdapter({ adapterDir, runtimeModels, candidateModel });
  result.runtimeProbe = { ollamaUrl: ollamaUrl ?? null, models: runtimeModels, error: runtimeProbeError };

  const out = value('--out');
  if (out) {
    const outPath = resolve(out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
    result.receiptPath = outPath;
  }
  console.log(JSON.stringify(result, null, 2));
  if (!result.provenanceValid || runtimeProbeError) process.exitCode = 1;
}

if (import.meta.main) await main();
