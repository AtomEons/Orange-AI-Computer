#!/usr/bin/env node
// expand-corpus.mjs — Expand the 200-pair seed corpus to 1000 pairs.
//
// Strategy:
//   1. Read the seed corpus (200 pairs).
//   2. Read Orange5 doctrine documents from disk (Charter, Master Plan,
//      Month Plan, AE Cobra Spec, OrangeEye Spec, Naming Canon, receipts,
//      schemas, mission packets).
//   3. Chunk the doctrine into ~500-token windows.
//   4. For each chunk, generate ~4 instruction pairs via OrangeLLM Light
//      (Smart Skinny qwen3:0.6b at :8797) using a fixed prompt template.
//   5. Validate each generated pair (instruction != empty, output != empty,
//      no fake-green words, output references real Orange5 concepts).
//   6. Dedupe against seed + previously generated.
//   7. Stop at 1000 total pairs.
//   8. Emit corpus.jsonl + corpus-receipt.json with SHA-256.
//
// Operator runs this BEFORE uploading the corpus to Colab.
// Time: ~5-15 minutes on N150 with Smart Skinny live at :8797.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(process.env.ORANGE5_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
const SEED_PATH = path.join(ROOT, '16-TRAINING/corpus/orangellm-fatty-v0-seed-200.jsonl');
const OUT_PATH = path.join(ROOT, '16-TRAINING/corpus/orangellm-fatty-v0-corpus-1000.jsonl');
const RECEIPT_PATH = path.join(ROOT, '16-TRAINING/corpus/orangellm-fatty-v0-corpus-receipt.json');

// 2026-06-24: :8797 wrapper hangs on chat completions. Go direct to Ollama.
const OLLAMA_URL = process.env.ORANGE_LLM_LIGHT || 'http://127.0.0.1:11434/v1/chat/completions';
const OLLAMA_MODEL = process.env.ORANGE_LLM_LIGHT_MODEL || 'qwen3:0.6b';

const TARGET_TOTAL = 1000;
const PAIRS_PER_CHUNK = 4;

const DOCTRINE_FILES = [
  '00-CHARTER/ORANGE5_MASTER_PLAN.md',
  '00-CHARTER/ORANGE5_MONTH_PLAN_2026-06-23.md',
  '00-CHARTER/ORANGE5_NOT_GREEN_LEDGER.md',
  '00-CHARTER/NAMING_CANON.md',
  '00-CHARTER/CODEX_BRIEF_STEP_01_NATIVE_TRUTH.md',
  '00-CHARTER/CODEXA_PREFLIGHT_AE_COBRA.md',
  '00-CHARTER/COLAB_TRAINING_PATTERN.md',
  '06-ORANGELLM/memory/AE_COBRA_FOUNDATION_SPEC.md',
  '07-VISUAL/AE_ORANGEEYE_FOUNDATION_SPEC.md',
];

const FAKE_GREEN = /\b(green_assumed|looks_ok|probably|should_work|fake_green)\b/i;
const ORANGE5_CONCEPTS = /\b(orange5|orangellm|atomic[-\s]?orange|ae cobra|orangeeye|hermes|mirage|atomsmasher|toolmesh|codexa|n150|fatty|mom'?s law|frontier-?isolation|codeless|gateway)\b/i;

function readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function appendJsonl(p, rows) {
  fs.appendFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function chunkText(text, target = 2000) {
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 0);
  const chunks = [];
  let current = '';
  for (const p of paragraphs) {
    if ((current + '\n\n' + p).length > target && current) {
      chunks.push(current);
      current = p;
    } else {
      current = current ? current + '\n\n' + p : p;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function generatePairs(chunk, sourceFile) {
  const prompt = `/no_think
You are a training-corpus author for OrangeLLM, the project-manager brain of Orange5. Given the following excerpt from Orange5 doctrine, emit ${PAIRS_PER_CHUNK} instruction-tuning JSON pairs.

EXCERPT FROM ${sourceFile}:
---
${chunk}
---

Output STRICTLY as ${PAIRS_PER_CHUNK} JSON objects, one per line, each in this exact shape:
{"instruction": "...", "input": "", "output": "..."}

Rules:
- The instruction is a question or directive an operator might ask OrangeLLM.
- The output is a concise, factual answer grounded in the excerpt above.
- Reference real Orange5 concepts (laws, ports, files, model names) accurately.
- No filler. No hedging. No 'probably' or 'should work'.
- Each pair must reference something specific from the excerpt.

Output:`;

  const body = {
    model: OLLAMA_MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    max_tokens: 3000,
    stream: false,
  };

  try {
    const res = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || '';
    const pairs = [];
    for (const line of content.split('\n')) {
      const m = line.match(/\{.*\}/);
      if (!m) continue;
      try {
        const obj = JSON.parse(m[0]);
        if (obj.instruction && obj.output && typeof obj.instruction === 'string' && typeof obj.output === 'string') {
          if (FAKE_GREEN.test(obj.output)) continue;
          if (!ORANGE5_CONCEPTS.test(obj.instruction + ' ' + obj.output)) continue;
          pairs.push({ instruction: obj.instruction.trim(), input: '', output: obj.output.trim() });
        }
      } catch {}
    }
    return pairs;
  } catch (err) {
    console.error(`[ERR] Generation failed for ${sourceFile}: ${err.message}`);
    return [];
  }
}

async function main() {
  console.log(`[BOOT] OrangeLLM Light: ${OLLAMA_URL} (${OLLAMA_MODEL})`);

  // Pre-flight: verify Light upstream is reachable
  try {
    const probe = await fetch(OLLAMA_URL.replace('/v1/chat/completions', '/v1/models'));
    if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
    console.log(`[OK] Upstream reachable.`);
  } catch (err) {
    console.error(`[FATAL] Upstream unreachable at ${OLLAMA_URL}: ${err.message}`);
    console.error(`Start Smart Skinny first: 'ollama serve' + 'ollama run ${OLLAMA_MODEL}'.`);
    process.exit(1);
  }

  // Load seed
  const seed = readJsonl(SEED_PATH);
  console.log(`[SEED] Loaded ${seed.length} hand-authored pairs from ${SEED_PATH}`);

  // Reset out file
  fs.writeFileSync(OUT_PATH, '');
  appendJsonl(OUT_PATH, seed);
  console.log(`[WRITE] ${seed.length} seed pairs written to ${OUT_PATH}`);

  const seenInstructions = new Set(seed.map(p => p.instruction.toLowerCase()));
  let total = seed.length;

  // Iterate doctrine
  for (const rel of DOCTRINE_FILES) {
    if (total >= TARGET_TOTAL) break;
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
      console.log(`[SKIP] ${rel} not found`);
      continue;
    }
    const text = fs.readFileSync(abs, 'utf8');
    const chunks = chunkText(text);
    console.log(`[DOC] ${rel}: ${chunks.length} chunks`);
    for (const chunk of chunks) {
      if (total >= TARGET_TOTAL) break;
      const pairs = await generatePairs(chunk, rel);
      const fresh = pairs.filter(p => {
        const key = p.instruction.toLowerCase();
        if (seenInstructions.has(key)) return false;
        seenInstructions.add(key);
        return true;
      });
      if (fresh.length > 0) {
        appendJsonl(OUT_PATH, fresh);
        total += fresh.length;
        console.log(`[+] ${fresh.length} pairs (total ${total}/${TARGET_TOTAL})`);
      }
    }
  }

  // Write receipt
  const finalContent = fs.readFileSync(OUT_PATH, 'utf8');
  const receipt = {
    schema: 'orange5.corpus-receipt.v0',
    corpus_path: OUT_PATH,
    seed_path: SEED_PATH,
    seed_count: seed.length,
    final_count: total,
    target: TARGET_TOTAL,
    corpus_sha256: sha256(finalContent),
    generated_at: new Date().toISOString(),
    light_model: OLLAMA_MODEL,
    doctrine_files: DOCTRINE_FILES,
  };
  fs.writeFileSync(RECEIPT_PATH, JSON.stringify(receipt, null, 2));
  console.log(`[DONE] ${total} total pairs. SHA-256: ${receipt.corpus_sha256}`);
  console.log(`[RECEIPT] ${RECEIPT_PATH}`);
}

main().catch(err => {
  console.error(`[FATAL] ${err.stack || err.message}`);
  process.exit(1);
});
