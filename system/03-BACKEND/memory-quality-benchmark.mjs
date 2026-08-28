import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { querySemanticMemory } from '../06-ORANGELLM/memory/ae-cobra/semantic-index.mjs';
import { writeChainedJsonReceipt } from '../10-RECEIPTS/tools/json-receipt-chain.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const RECEIPT_ROOT = path.join(ROOT, '10-RECEIPTS', 'orange5-build');

const CASES = Object.freeze([
  {
    id: 'episodic_refuter_failure',
    category: 'failure',
    query: 'Why did analyze.system halt during adversarial verification?',
    expected: /markerless refuter report lacks an explicit verification action/i,
  },
  {
    id: 'codexa_rail_auth',
    category: 'topology',
    query: 'What proof exists for Codexa command rail authentication?',
    expected: /authenticated codexa command rail|authenticated command verified/i,
  },
  {
    id: 'fake_green_policy',
    category: 'governance',
    query: 'How does OrangeFive prevent fake green completion claims?',
    expected: /no fake.?green|false_green_guard|promotion requires receipt|receipt.*fake.?green|cannot thereby attest execution|never convert needs_action|model guidance cannot claim.*mutation completed/i,
  },
  {
    id: 'runtime_authority',
    category: 'topology',
    query: 'Which host runs the Navigator and which host owns deterministic control?',
    expected: /navigator.*codexa|codexa.*navigator|bun navigator kernel/i,
  },
  {
    id: 'failure_learning',
    category: 'learning',
    query: 'How is failed work stored and recalled before another action?',
    expected: /lesson: read the failed gate|avoid repeated failure|failed gate|recall-before-action|checks prior related mistakes|prior issue\(s\) recorded|seeded_failure|pre_action_recall|mistakes_surfaced/i,
  },
  {
    id: 'operational_definition', category: 'governance',
    query: 'What makes an OrangeFive feature operational rather than a scaffold?',
    source: /ORANGE5_OPERATIONAL_LAW\.md/i,
    expected: /real local entrypoint|fresh proof receipt|operator can use it without reading a concept/i,
  },
  {
    id: 'operational_status_vocabulary', category: 'governance',
    query: 'Which final feature statuses are allowed in OrangeFive?',
    source: /ORANGE5_OPERATIONAL_LAW\.md/i,
    expected: /OPERATIONAL|DEGRADED_OPERATIONAL|PACKAGED_UPGRADE|RESEARCH_ARCHIVE/i,
  },
  {
    id: 'service_visibility_law', category: 'operations',
    query: 'Should required Orange services open visible PowerShell windows?',
    source: /ORANGE5_OPERATIONAL_LAW\.md/i,
    expected: /hidden\/invisible|Visible PowerShell popup loops are a defect/i,
  },
  {
    id: 'n150_model_residency', category: 'topology',
    query: 'Must an answer model remain resident on the N150?',
    source: /ORANGE5_RUNTIME_AUTHORITY\.md/i,
    expected: /No answer model is required to remain resident|zero model RAM/i,
  },
  {
    id: 'navigator_transport', category: 'routing',
    query: 'What is the preferred Navigator transport and fallback when its tunnel fails?',
    source: /ORANGE5_RUNTIME_AUTHORITY\.md/i,
    expected: /llama\.cpp Vulkan|127\.0\.0\.1:11436|direct_ollama/i,
  },
  {
    id: 'installed_weights_authority', category: 'routing',
    query: 'Does an installed model weight prove that OrangeFive used that model?',
    source: /ORANGE5_RUNTIME_AUTHORITY\.md/i,
    expected: /Installed weights are inventory, not active lanes|route and receipt must prove model use/i,
  },
  {
    id: 'governed_crossing', category: 'execution',
    query: 'What is the governed Orange order crossing from order to receipt?',
    source: /ORANGE5_RUNTIME_AUTHORITY\.md/i,
    expected: /orange\.order\.v1|LOOM procedural gate|AE Memory recall|orange\.report\.v1|hash-chained receipt/i,
  },
  {
    id: 'model_not_execution_proof', category: 'execution',
    query: 'Can a model completion prove that files were edited or an action executed?',
    source: /ORANGE5_RUNTIME_AUTHORITY\.md|ORANGEFIVE_CURRENT_OPERATIONAL_TRUTH\.md/i,
    expected: /model completion is never execution proof|ae_execution_performed=false|distinguishes model guidance from executed work/i,
  },
  {
    id: 'evidence_hierarchy', category: 'governance',
    query: 'What evidence outranks chat claims in OrangeFive?',
    source: /ORANGE5_RUNTIME_AUTHORITY\.md/i,
    expected: /Current live semantic probe|Current hash-chained receipt|Chat claims/i,
  },
  {
    id: 'headless_operation', category: 'interfaces',
    query: 'Can OrangeFive operate without Atomic Orange and how do coding clients connect?',
    source: /ORANGEFIVE_HOW_TO_USE\.md/i,
    expected: /Atomic Orange is optional for headless operation|canonical Bun MCP server/i,
  },
  {
    id: 'navigator_hierarchy', category: 'agents',
    query: 'What is the OrangeFive Navigator and Hermes agent hierarchy?',
    source: /ORANGEFIVE_HOW_TO_USE\.md/i,
    expected: /Navigator Kernel.*specialist model.*Little Navigator.*bounded Hermes lease/i,
  },
  {
    id: 'little_navigator_bounds', category: 'agents',
    query: 'Are Little Navigators permanent autonomous models with unrestricted tools?',
    source: /ORANGEFIVE_HOW_TO_USE\.md/i,
    expected: /compiled domain packets, not resident models|declared agent and tool subset|expire after 30 minutes/i,
  },
  {
    id: 'loom_halt_behavior', category: 'governance',
    query: 'What should an operator do after a LOOM halt?',
    source: /ORANGEFIVE_HOW_TO_USE\.md/i,
    expected: /Read the blocker; do not retry blindly/i,
  },
  {
    id: 'hermes_exact_role', category: 'agents',
    query: 'Does Hermes itself perform all work or does it authorize an effector?',
    source: /ORANGEFIVE_HOW_TO_USE\.md/i,
    expected: /Hermes mints a bounded lease|MCP adapter, coding host, or command executor performs the action/i,
  },
  {
    id: 'current_visual_truth', category: 'vision', mode: 'conflict',
    query: 'Is AE Eyes human grade visual recognition fully operational and green?',
    source: /aeyes-human-grade-live-proof\.json/i,
    expected: /AE_EYES_HUMAN_GRADE_NEEDS_WORK|15.*16|94%/i,
  },
  {
    id: 'durable_resume_truth', category: 'durability',
    query: 'Does the cross-organ mission resume without duplicate effects?',
    source: /durable-cross-organ-proof\.json/i,
    expected: /DURABLE_RESUME_GREEN|no_second_spine_effect|resumed_trace_visible/i,
  },
  {
    id: 'unknown_quantum_deploy', category: 'abstention', mode: 'absence',
    query: 'Which receipt proves OrangeFive deployed a production quantum teleportation cluster?',
    absentTerms: ['quantum', 'teleportation'],
  },
  {
    id: 'unknown_kubernetes_regions', category: 'abstention', mode: 'absence',
    query: 'What are the five live Kubernetes regions running OrangeFive production?',
    absentTerms: ['kubernetes', 'regions'],
  },
]);

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function percentile(values, quantile) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function searchableHit(hit) {
  const payload = hit?.payload || {};
  return [payload.summary, payload.section, payload.source_file, payload.next_action]
    .filter(Boolean)
    .join('\n');
}

function matchesExpected(testCase, hit) {
  const text = searchableHit(hit);
  const source = hit?.payload?.source_file || '';
  return (!testCase.expected || testCase.expected.test(text)) && (!testCase.source || testCase.source.test(source));
}

function evaluateResponse(testCase, response) {
  const rank = testCase.mode === 'absence' ? 0 : response.hits.findIndex((hit) => matchesExpected(testCase, hit)) + 1;
  const maxLexicalCoverage = Math.max(0, ...response.hits.map((hit) => Number(hit.lexical_coverage || 0)));
  const unsupportedTermsPresent = testCase.mode === 'absence' && response.hits.some((hit) => {
    const text = searchableHit(hit).toLowerCase();
    return testCase.absentTerms.every((term) => text.includes(term));
  });
  const passed = testCase.mode === 'absence'
    ? !unsupportedTermsPresent
    : testCase.mode === 'conflict'
      ? rank > 0 && rank <= 3 && response.conflicts?.some((conflict) => testCase.source.test(conflict.preferred_fresh_source || ''))
      : rank > 0 && rank <= 3;
  return {
    passed,
    expected_rank: rank || null,
    reciprocal_rank: testCase.mode === 'absence' ? (passed ? 1 : 0) : (rank ? 1 / rank : 0),
    elapsed_ms: response.elapsed_ms,
    candidates: response.candidates,
    max_lexical_coverage: Number(maxLexicalCoverage.toFixed(4)),
    unsupported_terms_present: unsupportedTermsPresent,
    contradictions: response.conflicts || [],
    top: response.hits.slice(0, 3).map((hit) => ({
      summary: hit.payload?.summary || '',
      source: hit.payload?.source_file || `ae-cobra:${hit.payload?.lane || 'unknown'}`,
      section: hit.payload?.section || null,
      hash: hit.payload?.hash || null,
      score: hit.score,
      semantic_score: hit.semantic_score,
      lexical_coverage: hit.lexical_coverage,
    })),
  };
}

export function writeMemoryQualityReceipts(receipt, contradictions, { receiptRoot = RECEIPT_ROOT } = {}) {
  fs.mkdirSync(receiptRoot, { recursive: true });
  const stamp = receipt.generated_at.replace(/[:.]/g, '-');
  const debtReceipt = {
    schema: 'orange5.memory-contradiction-debt.receipt.v1',
    status: contradictions.length ? 'CONTRADICTIONS_RECORDED_WITH_RESOLUTION' : 'NO_CONTRADICTIONS_OBSERVED',
    generated_at: receipt.generated_at,
    debts: contradictions,
  };
  const debtReceiptPath = path.join(receiptRoot, `${stamp}-memory-contradiction-debt.json`);
  const chainedDebt = writeChainedJsonReceipt(debtReceiptPath, debtReceipt);
  const receiptPath = path.join(receiptRoot, `${stamp}-memory-quality-benchmark.json`);
  const chainedReceipt = writeChainedJsonReceipt(receiptPath, {
    ...receipt,
    contradiction_debt: {
      ...receipt.contradiction_debt,
      receipt_path: debtReceiptPath,
      receipt_sha256: chainedDebt.receipt_sha256,
    },
  });
  return { ...chainedReceipt, receipt_path: receiptPath };
}

export async function runMemoryQualityBenchmark() {
  const results = [];
  for (const testCase of CASES) {
    const modeResults = {};
    for (const mode of ['lexical', 'dense', 'hybrid']) {
      const response = await querySemanticMemory(testCase.query, { limit: 8, mode });
      modeResults[mode] = evaluateResponse(testCase, response);
    }
    const hybrid = modeResults.hybrid;
    results.push({
      id: testCase.id,
      category: testCase.category,
      mode: testCase.mode || 'retrieval',
      query: testCase.query,
      ...hybrid,
      retrieval_bakeoff: modeResults,
    });
  }

  const passed = results.filter((item) => item.passed).length;
  const meanReciprocalRank = results.reduce((sum, item) => sum + item.reciprocal_rank, 0) / results.length;
  const latencies = results.map((item) => item.elapsed_ms);
  const categories = Object.fromEntries([...new Set(results.map((item) => item.category))].map((category) => {
    const rows = results.filter((item) => item.category === category);
    return [category, { passed: rows.filter((item) => item.passed).length, total: rows.length }];
  }));
  const modeScores = Object.fromEntries(['lexical', 'dense', 'hybrid'].map((mode) => {
    const rows = results.map((item) => item.retrieval_bakeoff[mode]);
    return [mode, {
      passed: rows.filter((item) => item.passed).length,
      total: rows.length,
      mean_reciprocal_rank: Number((rows.reduce((sum, item) => sum + item.reciprocal_rank, 0) / rows.length).toFixed(4)),
      latency_p95_ms: percentile(rows.map((item) => item.elapsed_ms), 0.95),
    }];
  }));
  const bestAblationMrr = Math.max(modeScores.lexical.mean_reciprocal_rank, modeScores.dense.mean_reciprocal_rank);
  const contradictions = results.flatMap((item) => item.contradictions.map((conflict) => ({
    debt_id: `memory_conflict_${sha256(`${item.id}|${JSON.stringify(conflict)}`).slice(0, 16)}`,
    debt_type: 'memory_contradiction',
    case_id: item.id,
    query: item.query,
    severity: 0.8,
    resolved_by: conflict.rule,
    conflict,
  })));
  const status = passed === results.length && meanReciprocalRank >= 0.8 && percentile(latencies, 0.95) <= 1_000
    && modeScores.hybrid.mean_reciprocal_rank >= bestAblationMrr - 0.05
    ? 'MEMORY_QUALITY_GREEN'
    : 'MEMORY_QUALITY_NEEDS_WORK';
  const receipt = {
    schema: 'orange5.memory-quality-benchmark.receipt.v1',
    status,
    cases_passed: passed,
    cases_total: results.length,
    mean_reciprocal_rank: Number(meanReciprocalRank.toFixed(4)),
    latency_ms: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      max: Math.max(...latencies),
    },
    thresholds: { top_k: 3, minimum_mrr: 0.8, maximum_p95_ms: 1_000 },
    categories,
    retrieval_bakeoff: modeScores,
    contradiction_debt: {
      recorded: contradictions.length,
      unresolved: 0,
      resolution_law: 'fresh receipts and live probes outrank older prose',
    },
    results,
    generated_at: new Date().toISOString(),
  };
  return writeMemoryQualityReceipts(receipt, contradictions);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runMemoryQualityBenchmark();
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'MEMORY_QUALITY_GREEN') process.exitCode = 1;
}

export const __memoryQualityInternals = Object.freeze({ percentile, searchableHit, matchesExpected, evaluateResponse });
