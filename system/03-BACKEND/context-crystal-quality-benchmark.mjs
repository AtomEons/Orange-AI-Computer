#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { compileContextCrystal, verifyContextCrystal } from './context-crystal.mjs';
import { writeChainedJsonReceipt } from '../10-RECEIPTS/tools/json-receipt-chain.mjs';
import { ensureSpecialistReady } from '../06-ORANGELLM/server/specialist-lease.mjs';
import { DEFAULT_NAVIGATOR_MODEL, resolveNavigatorModel } from '../06-ORANGELLM/server/upstream.mjs';

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECEIPT_DIR = path.join(ROOT, '10-RECEIPTS', 'orange5-build');
const OLLAMA_URL = (process.env.ORANGE5_QUALITY_OLLAMA_URL || argumentValue('--endpoint') || 'http://10.0.0.4:11434').replace(/\/$/, '');
const REQUESTED_MODEL = process.env.ORANGE5_QUALITY_MODEL || argumentValue('--model') || process.env.ORANGE5_RUNTIME_NAVIGATOR_MODEL || '';
const MODEL = resolveNavigatorModel({
  configuredModel: REQUESTED_MODEL,
  fabricModel: process.env.ORANGE5_RUNTIME_NAVIGATOR_MODEL,
  transport: 'ollama',
});
const ROOTS = ['00-CHARTER', '01-DOCTRINE', '03-BACKEND', '06-ORANGELLM', '12-ATOMSMASHER'];
const ALLOWED = /\.(?:md|mjs|json)$/i;
const MAX_FILE_BYTES = 1_500_000;
const MAX_CORPUS_BYTES = 40_000_000;
const QUALITY_FLOOR = 0.75;
const configuredTimeout = Number(process.env.ORANGE5_QUALITY_TIMEOUT_MS || argumentValue('--timeout-ms') || 120_000);
const REQUEST_TIMEOUT_MS = Number.isSafeInteger(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 120_000;

function qualityStatus(results, total) {
  const passed = results.filter((item) => item.passed).length;
  const complete = total > 0 && results.length === total;
  return {
    passed,
    failed: Math.max(0, total - passed),
    complete,
    status: complete && passed === total
      ? 'ORANGE5_CONTEXT_CRYSTAL_QUALITY_GREEN'
      : 'ORANGE5_CONTEXT_CRYSTAL_QUALITY_NEEDS_WORK',
  };
}

const CASES = Object.freeze([
  {
    id: 'two_computer_topology',
    question: 'Explain the distinct OrangeFive responsibilities of the N150 and Codexa.',
    required: ['01-DOCTRINE/ORANGE5_PROOF_DIRECTED_INTELLIGENCE.md'],
    oracleSections: [{ sourceId: '01-DOCTRINE/ORANGE5_PROOF_DIRECTED_INTELLIGENCE.md', heading: '### 2.3 Frontier' }],
    concepts: [/n150/i, /deterministic.*control|control.*deterministic/i, /codexa/i, /heavy compute|model inference|specialist/i],
    forbidden: [/n150.*(?:runs|hosts).*heavy model/i],
    falsifierClaim: 'The N150 runs and hosts every heavy model.',
  },
  {
    id: 'compression_claim_boundary',
    question: 'What exactly does OrangeFive mean by its 200x compression target, and what does it not mean?',
    required: ['01-DOCTRINE/ORANGE5_PROOF_DIRECTED_INTELLIGENCE.md', '00-CHARTER/ORANGE5_INNOVATION_EXECUTION_PLAN.md'],
    oracleSections: [
      { sourceId: '01-DOCTRINE/ORANGE5_PROOF_DIRECTED_INTELLIGENCE.md', heading: '### 4.1 Compression Claims' },
      { sourceId: '00-CHARTER/ORANGE5_INNOVATION_EXECUTION_PLAN.md', heading: '## 5. Compression Standard' },
    ],
    concepts: [/200x/i, /operational|context|work/i, /not.*universal|does not mean/i, /source.*(?:hydrat|pointer|truth)|exact.*source/i],
    // Reject an affirmative universal-compression claim without flagging the
    // required boundary sentence "does not mean 200x universal...".
    forbidden: [/\b(?:means|guarantees|achieves)\s+200x universal lossless byte compression\b/i],
    falsifierClaim: 'OrangeFive guarantees 200x universal lossless byte compression.',
  },
  {
    id: 'anti_theater_execution_truth',
    question: 'How does OrangeFive distinguish model output from real execution and a valid green claim?',
    required: ['01-DOCTRINE/ORANGE5_PROOF_DIRECTED_INTELLIGENCE.md'],
    oracleSections: [{ sourceId: '01-DOCTRINE/ORANGE5_PROOF_DIRECTED_INTELLIGENCE.md', heading: '## 8. Anti-Theater Laws' }],
    concepts: [/model.*(?:not|never).*execution|cognitive report.*not.*executed/i, /receipt/i, /fresh probe|evidence|changed artifact/i, /fake green|green status/i],
    forbidden: [/model completion proves execution/i],
    falsifierClaim: 'Model completion proves execution and is enough for green status.',
  },
  {
    id: 'receipt_to_reflex_learning',
    question: 'Describe the Receipt-to-Reflex learning loop and the conditions for promotion and demotion.',
    required: ['01-DOCTRINE/ORANGE5_PROOF_DIRECTED_INTELLIGENCE.md', '00-CHARTER/ORANGE5_IDEA_LEDGER.md'],
    oracleSections: [
      { sourceId: '01-DOCTRINE/ORANGE5_PROOF_DIRECTED_INTELLIGENCE.md', heading: '## 5. Receipt-to-Reflex Compiler' },
      { sourceId: '00-CHARTER/ORANGE5_IDEA_LEDGER.md', heading: '## IDEA-005: Receipt-to-Reflex Compiler' },
    ],
    concepts: [/receipt.to.reflex/i, /held.out|counterexample|falsifier/i, /bounded|reversible/i, /demot|contradiction|source change/i],
    forbidden: [/model rewrites itself blindly/i],
    falsifierClaim: 'The model rewrites itself blindly after repeated answers.',
  },
  {
    id: 'capability_covenant',
    question: 'What is the Capability Covenant and what happens when a specialist answer is too weak?',
    required: ['00-CHARTER/ORANGE5_INNOVATION_EXECUTION_PLAN.md'],
    oracleSections: [{ sourceId: '00-CHARTER/ORANGE5_INNOVATION_EXECUTION_PLAN.md', heading: '### 4.1 Capability Covenant' }],
    concepts: [/capability covenant/i, /minimum intelligence class|general.*code_specialist.*architecture_judge.*visual_judge/i, /weaker|fallback|impersonate/i, /repair.*once|blocked/i],
    forbidden: [/silently.*accept.*weaker/i],
    falsifierClaim: 'The Capability Covenant silently accepts a weaker specialist.',
  },
]);

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function walk(relativeRoot, output) {
  const absoluteRoot = path.join(ROOT, relativeRoot);
  if (!fs.existsSync(absoluteRoot)) return;
  const stack = [absoluteRoot];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (['node_modules', '.git', 'dist', 'tests', 'fixtures', '__tests__'].includes(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(absolute);
      else if (entry.isFile() && ALLOWED.test(entry.name) && !/(?:benchmark|\.test|test-|proof-fixture)/i.test(entry.name)) output.push(absolute);
    }
  }
}

function loadCorpus() {
  const files = [];
  for (const root of ROOTS) walk(root, files);
  const sources = [];
  const sourceMap = new Map();
  let bytes = 0;
  for (const absolute of [...new Set(files)].sort()) {
    const stat = fs.statSync(absolute);
    if (stat.size <= 0 || stat.size > MAX_FILE_BYTES || bytes + stat.size > MAX_CORPUS_BYTES) continue;
    const content = fs.readFileSync(absolute, 'utf8');
    const id = path.relative(ROOT, absolute).replaceAll('\\', '/');
    bytes += Buffer.byteLength(content);
    const authority = id.startsWith('00-CHARTER/') || id.startsWith('01-DOCTRINE/') ? 0.5 : 0.05;
    sources.push({ id, pointer: `file://${absolute.replaceAll('\\', '/')}`, content, authority });
    sourceMap.set(id, content);
  }
  return { sources, sourceMap, bytes };
}

function extractMarkdownSection(content, heading) {
  const headings = [...String(content).matchAll(/^(#{1,6})\s+(.+?)\r?$/gm)];
  const targetIndex = headings.findIndex((match) => `${match[1]} ${match[2]}` === heading);
  if (targetIndex < 0) throw new Error(`oracle heading missing: ${heading}`);
  const target = headings[targetIndex];
  const level = target[1].length;
  const next = headings.slice(targetIndex + 1).find((match) => match[1].length <= level);
  const start = target.index;
  const end = next?.index ?? String(content).length;
  return { content: String(content).slice(start, end).trim(), start, end };
}

function buildOracleEvidence(testCase, sourceMap) {
  const sections = testCase.oracleSections.map(({ sourceId, heading }) => {
    const source = sourceMap.get(sourceId);
    if (typeof source !== 'string') throw new Error(`oracle source missing: ${sourceId}`);
    const section = extractMarkdownSection(source, heading);
    return {
      source_id: sourceId,
      heading,
      pointer: `${sourceId}#chars=${section.start}-${section.end}`,
      source_sha256: sha256(source),
      excerpt_sha256: sha256(section.content),
      ...section,
    };
  });
  const sourceIds = [...new Set(sections.map((section) => section.source_id))];
  const missingRequired = testCase.required.filter((id) => !sourceIds.includes(id));
  if (missingRequired.length) throw new Error(`oracle omits required source: ${missingRequired.join(', ')}`);
  const evidence = sections
    .map((section) => `SOURCE:${section.pointer}\n${section.content}`)
    .join('\n\n');
  return {
    evidence,
    source_ids: sourceIds,
    sections: sections.map(({ content, ...section }) => section),
  };
}

function evidencePrompt(question, evidence, allowedSources, requiredSources = []) {
  return [
    'You are an OrangeFive evidence reader. Answer only from EVIDENCE.',
    'Return strict JSON: {"answer":"...","source_ids":["..."]}.',
    'Be concise. Do not invent runtime state or claim execution.',
    `Allowed source ids: ${allowedSources.join(', ')}`,
    `Required direct source ids: ${requiredSources.join(', ')}`,
    'The source_ids array MUST contain 1 to 3 ids from that exact allowed list. Cite only the strongest direct evidence.',
    'At least one source_ids entry MUST be from the Required direct source ids list.',
    `QUESTION: ${question}`,
    'EVIDENCE:',
    evidence,
  ].join('\n');
}

function repairTruncatedJsonPacket(value, repair) {
  const raw = String(value || '').trim();
  const candidates = [raw];
  if (raw.includes('\\"')) candidates.push(raw.replaceAll('\\"', '"'));
  for (const candidate of candidates) {
    const encodedAnswer = /"answer"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/.exec(candidate)?.[1] || '';
    const sourceIds = [...candidate.matchAll(/"((?:\d{2}-[A-Z0-9-]+\/)[^"\r\n]+\.(?:md|mjs|json))"/gi)]
      .map((match) => match[1]);
    if (!encodedAnswer || sourceIds.length === 0) continue;
    let answer = encodedAnswer;
    try { answer = JSON.parse(`"${encodedAnswer}"`); } catch {}
    return { answer, source_ids: [...new Set(sourceIds)].slice(0, 3), repair };
  }
  return null;
}

function parseModelJson(text) {
  const raw = String(text || '').trim();
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch {}
  if (parsed && typeof parsed.answer === 'string' && parsed.answer.trim().startsWith('{')
    && (!Array.isArray(parsed.source_ids) || parsed.source_ids.length === 0)) {
    const nestedRaw = parsed.answer.trim();
    try {
      const nested = JSON.parse(nestedRaw);
      return { ...nested, repair: 'nested_json_unwrap' };
    } catch {
      const repaired = repairTruncatedJsonPacket(nestedRaw, 'truncated_nested_json_repair');
      if (repaired) return repaired;
    }
  }
  if (parsed) return parsed;
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch {}
  }
  const repaired = repairTruncatedJsonPacket(raw, 'truncated_json_repair');
  if (repaired) return repaired;
  return { answer: raw, source_ids: [] };
}

function contextWindowForPrompt(prompt) {
  const promptBytes = Buffer.byteLength(prompt);
  const estimatedPromptTokens = Math.ceil(promptBytes / 3);
  return Math.min(32_768, Math.max(8_192, Math.ceil((estimatedPromptTokens + 1_024) / 1_024) * 1_024));
}

async function askModel(prompt) {
  const started = performance.now();
  const promptBytes = Buffer.byteLength(prompt);
  const numContext = contextWindowForPrompt(prompt);
  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      prompt,
      stream: false,
      format: {
        type: 'object',
        properties: {
          answer: { type: 'string' },
          source_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 },
        },
        required: ['answer', 'source_ids'],
      },
      think: false,
      keep_alive: -1,
      options: { temperature: 0, num_predict: 256, num_ctx: numContext },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Ollama ${response.status}: ${await response.text()}`);
  const body = await response.json();
  const parsed = parseModelJson(body.response);
  return {
    answer: typeof parsed.answer === 'string' ? parsed.answer.trim() : '',
    source_ids: Array.isArray(parsed.source_ids) ? parsed.source_ids.map(String) : [],
    elapsed_ms: Number((performance.now() - started).toFixed(2)),
    eval_count: Number(body.eval_count || 0),
    prompt_eval_count: Number(body.prompt_eval_count || 0),
    repair: parsed.repair || null,
    prompt_sha256: sha256(prompt),
    prompt_bytes: promptBytes,
    num_ctx: numContext,
  };
}

function scoreAnswer(testCase, result, allowedSourceIds) {
  const text = typeof result?.answer === 'string' ? result.answer : '';
  const sourceIds = Array.isArray(result?.source_ids) ? result.source_ids.map(String) : [];
  const hits = testCase.concepts.map((pattern) => pattern.test(text));
  const forbiddenHits = testCase.forbidden.map((pattern) => pattern.test(text));
  const allowed = new Set(allowedSourceIds);
  const sourceIdsValid = sourceIds.length > 0
    && sourceIds.every((id) => allowed.has(id))
    && sourceIds.some((id) => testCase.required.includes(id));
  return {
    concept_hits: hits.filter(Boolean).length,
    concept_total: hits.length,
    coverage: Number((hits.filter(Boolean).length / hits.length).toFixed(4)),
    forbidden_hits: forbiddenHits.filter(Boolean).length,
    source_ids_valid: sourceIdsValid,
  };
}

function evaluateTurnPair(baselineScore, compressedScore) {
  const baselineQuality = baselineScore.coverage >= QUALITY_FLOOR
    && baselineScore.forbidden_hits === 0
    && baselineScore.source_ids_valid;
  const compressedQuality = compressedScore.coverage >= QUALITY_FLOOR
    && compressedScore.forbidden_hits === 0
    && compressedScore.source_ids_valid;
  const coverageDelta = Number((compressedScore.coverage - baselineScore.coverage).toFixed(4));
  const qualityParity = baselineQuality && compressedQuality && coverageDelta >= 0;
  return {
    baseline_quality: baselineQuality,
    compressed_quality: compressedQuality,
    coverage_delta: coverageDelta,
    quality_parity: qualityParity,
    passed: qualityParity,
  };
}

function runFalsifiers(testCase, crystal, sourceMap, compressed, allowedSourceIds) {
  const selectedId = crystal.selected[0]?.source_id;
  const tamperVerification = verifyContextCrystal(crystal, (id) => {
    const content = sourceMap.get(id);
    return id === selectedId ? `${content}\nFALSIFIER_TAMPER` : content;
  });
  const forgedCitation = scoreAnswer(testCase, {
    answer: compressed.answer,
    source_ids: ['falsifier://not-authoritative'],
  }, allowedSourceIds);
  const forbiddenClaim = scoreAnswer(testCase, {
    answer: testCase.falsifierClaim,
    source_ids: [testCase.required[0]],
  }, allowedSourceIds);
  const staleOracleMap = new Map(sourceMap);
  const oracleTarget = testCase.oracleSections[0];
  staleOracleMap.set(
    oracleTarget.sourceId,
    staleOracleMap.get(oracleTarget.sourceId).replace(oracleTarget.heading, `${oracleTarget.heading} changed`),
  );
  let staleOracleRejected = false;
  try { buildOracleEvidence(testCase, staleOracleMap); } catch { staleOracleRejected = true; }
  return {
    source_tamper_rejected: !tamperVerification.ok
      && tamperVerification.errors.some((error) => /source changed|chunk mismatch/.test(error)),
    forged_citation_rejected: forgedCitation.source_ids_valid === false,
    forbidden_claim_rejected: forbiddenClaim.forbidden_hits > 0,
    stale_oracle_section_rejected: staleOracleRejected,
  };
}

export async function runContextCrystalQualityBenchmark() {
  const benchmarkStartedAt = performance.now();
  await ensureSpecialistReady({ tier: 'quality_benchmark', baseUrl: OLLAMA_URL, model: MODEL, keepAlive: '30m' });
  const corpus = loadCorpus();
  const results = [];
  const selectedCase = process.env.ORANGE5_QUALITY_CASE || argumentValue('--case');
  const cases = selectedCase ? CASES.filter((item) => item.id === selectedCase) : CASES;
  if (!cases.length) throw new Error(`unknown ORANGE5_QUALITY_CASE: ${selectedCase}`);
  for (const testCase of cases) {
    for (const requiredId of testCase.required) {
      if (!corpus.sourceMap.has(requiredId)) throw new Error(`required source missing: ${requiredId}`);
    }
    const crystal = compileContextCrystal({
      task: testCase.question,
      sources: corpus.sources,
      budgetBytes: 4_500,
      requiredSourceIds: testCase.required,
    });
    const verification = verifyContextCrystal(crystal, (id) => corpus.sourceMap.get(id));
    const oracleEvidence = buildOracleEvidence(testCase, corpus.sourceMap);
    const baselineEvidence = oracleEvidence.evidence;
    const evidenceSourceIds = [...new Set(crystal.selected.map((item) => item.source_id))];
    let baseline;
    let baselineScore;
    let compressed;
    let compressedScore;
    let stage = 'baseline';
    try {
      baseline = await askModel(evidencePrompt(testCase.question, baselineEvidence, oracleEvidence.source_ids, testCase.required));
      baselineScore = scoreAnswer(testCase, baseline, oracleEvidence.source_ids);
      stage = 'compressed';
      compressed = await askModel(evidencePrompt(testCase.question, crystal.hot_context, evidenceSourceIds, testCase.required));
      compressedScore = scoreAnswer(testCase, compressed, evidenceSourceIds);
    } catch (error) {
      results.push({
        id: testCase.id,
        question: testCase.question,
        passed: false,
        required_sources: testCase.required,
        allowed_evidence_sources: evidenceSourceIds,
        verification,
        crystal: {
          crystal_id: crystal.crystal_id,
          selected: crystal.selected,
          proof: crystal.proof,
          metrics: crystal.metrics,
        },
        runtime_error: {
          stage,
          name: error?.name || 'Error',
          message: error?.message || String(error),
          timed_out: error?.name === 'TimeoutError',
          model: MODEL,
          endpoint: OLLAMA_URL,
        },
      });
      continue;
    }
    const comparison = evaluateTurnPair(baselineScore, compressedScore);
    const falsifiers = runFalsifiers(testCase, crystal, corpus.sourceMap, compressed, evidenceSourceIds);
    const falsifiersPassed = Object.values(falsifiers).every(Boolean);
    const oracle = {
      kind: 'held_out_deterministic_contract',
      concept_total: testCase.concepts.length,
      forbidden_total: testCase.forbidden.length,
      required_source_ids: testCase.required,
      evidence_bytes: Buffer.byteLength(baselineEvidence),
      evidence_sections: oracleEvidence.sections,
    };
    const passed = verification.ok
      && crystal.proof.complete
      && comparison.passed
      && falsifiersPassed;
    results.push({
      id: testCase.id,
      question: testCase.question,
      passed,
      required_sources: testCase.required,
      allowed_evidence_sources: evidenceSourceIds,
      verification,
      crystal: {
        crystal_id: crystal.crystal_id,
        selected: crystal.selected,
        proof: crystal.proof,
        metrics: crystal.metrics,
      },
      oracle,
      live_turn_pair: {
        id: sha256(`${testCase.id}:${MODEL}:${baseline.prompt_sha256}:${compressed.prompt_sha256}`).slice(0, 24),
        order: ['fixed_authoritative_sections', 'context_crystal'],
        same_model: true,
        same_generation_contract: true,
      },
      baseline: {
        ...baseline,
        ...baselineScore,
        evidence_bytes: Buffer.byteLength(baselineEvidence),
        evidence_sha256: sha256(baselineEvidence),
      },
      compressed: { ...compressed, ...compressedScore, evidence_bytes: Buffer.byteLength(crystal.hot_context) },
      comparison,
      falsifiers,
      quality_parity: comparison.quality_parity,
      oracle_to_crystal_ratio: Number((Buffer.byteLength(baselineEvidence) / Math.max(1, Buffer.byteLength(crystal.hot_context))).toFixed(3)),
    });
  }
  const summary = qualityStatus(results, cases.length);
  const receipt = {
    schema: 'orange5.context-crystal-quality-parity.v1',
    status: summary.status,
    generated_at: new Date().toISOString(),
    requested_model: REQUESTED_MODEL || null,
    model: MODEL,
    canonical_default_model: DEFAULT_NAVIGATOR_MODEL,
    retired_model_redirected: Boolean(REQUESTED_MODEL && REQUESTED_MODEL !== MODEL),
    endpoint: OLLAMA_URL,
    cases_passed: summary.passed,
    cases_failed: summary.failed,
    cases_executed: results.length,
    cases_total: cases.length,
    all_cases_executed: summary.complete,
    elapsed_ms: Number((performance.now() - benchmarkStartedAt).toFixed(2)),
    corpus: { sources: corpus.sources.length, bytes: corpus.bytes },
    methodology: {
      evaluation: 'matched live model turn pair scored against one predeclared held-out deterministic contract per case',
      deterministic_temperature: 0,
      prompt_sized_context_window: { minimum: 8_192, maximum: 32_768, bytes_per_token_safety_estimate: 3, reserve_tokens: 1_024 },
      maximum_generation_tokens: 256,
      request_timeout_ms: REQUEST_TIMEOUT_MS,
      maximum_model_wait_ms: cases.length * 2 * REQUEST_TIMEOUT_MS,
      per_case_runtime_errors_are_recorded_and_do_not_abort_remaining_cases: true,
      baseline: 'same model answers from fixed complete task-relevant sections verified against authoritative source hashes',
      compressed: 'Context Crystal compiled from the complete OrangeFive corpus',
      parity: 'both turns meet the quality floor and the crystal turn loses no contract coverage versus baseline',
      quality_floor: QUALITY_FLOOR,
      ratio_is_observation_not_gate: true,
      falsifiers_required: [
        'source_tamper_rejected',
        'forged_citation_rejected',
        'forbidden_claim_rejected',
        'stale_oracle_section_rejected',
      ],
      no_universal_compression_claim: true,
    },
    results,
  };
  const stamp = receipt.generated_at.replace(/[:.]/g, '-');
  const receiptPath = path.join(RECEIPT_DIR, `${stamp}-context-crystal-quality-parity.json`);
  const chained = writeChainedJsonReceipt(receiptPath, receipt);
  return { ...chained, receipt_path: receiptPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runContextCrystalQualityBenchmark();
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'ORANGE5_CONTEXT_CRYSTAL_QUALITY_GREEN') process.exitCode = 1;
}

export const __qualityInternals = Object.freeze({
  parseModelJson,
  repairTruncatedJsonPacket,
  scoreAnswer,
  evidencePrompt,
  evaluateTurnPair,
  runFalsifiers,
  contextWindowForPrompt,
  extractMarkdownSection,
  buildOracleEvidence,
  qualityStatus,
  requestedModel: REQUESTED_MODEL,
  resolvedModel: MODEL,
});
