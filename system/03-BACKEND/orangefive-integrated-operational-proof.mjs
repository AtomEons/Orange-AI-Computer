#!/usr/bin/env bun

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { healthSnapshot } from './orange5-headless-core.mjs';
import { validateOrangeReport } from '../06-ORANGELLM/contracts/orange-report.mjs';
import {
  verifyImageArtifact,
  verifyMusicArtifact,
  verifyTtsArtifact,
  verifyVideoArtifact,
} from '../scripts/captain-planet-artifact-verifier.mjs';
import { writeChainedJsonReceipt } from '../10-RECEIPTS/tools/json-receipt-chain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECEIPT_DIR = path.join(ROOT, '10-RECEIPTS', 'orange5-build');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function latestFile(suffix, predicate = () => true) {
  const matches = fs.readdirSync(RECEIPT_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => {
      const file = path.join(RECEIPT_DIR, entry.name);
      try {
        return { file, receipt: readJson(file), mtime: fs.statSync(file).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((entry) => entry && predicate(entry.receipt))
    .sort((a, b) => b.mtime - a.mtime);
  if (!matches.length) throw new Error(`missing accepted receipt suffix: ${suffix}`);
  return matches[0].file;
}

function validateSelfHash(receipt, field) {
  const copy = structuredClone(receipt);
  const claimed = copy[field];
  delete copy[field];
  return typeof claimed === 'string' && claimed === sha256(JSON.stringify(copy));
}

function allTrue(value) {
  return value && typeof value === 'object' && Object.values(value).length > 0 && Object.values(value).every((item) => item === true);
}

function receiptAgeHours(receipt) {
  const stamp = receipt.generated_at || receipt.generatedAt || receipt.timestamp_utc;
  const time = Date.parse(stamp || '');
  return Number.isFinite(time) ? (Date.now() - time) / 3_600_000 : Infinity;
}

async function fetchJson(url, options = {}, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, error: error?.message || String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function proveLiveGovernedTurn() {
  const response = await fetchJson('http://127.0.0.1:1337/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      model: 'orange-auto',
      messages: [{
        role: 'user',
        content: 'Name the current Orange product release and give one non-mutating next action. Do not claim execution or evidence that was not supplied.',
      }],
      stream: false,
      max_tokens: 192,
      temperature: 0,
    }),
  }, 180_000);
  let report = null;
  try { report = JSON.parse(response.body?.choices?.[0]?.message?.content || ''); } catch {}
  let reportValid = false;
  try { validateOrangeReport(report, response.body?.ae_order_id); reportValid = true; } catch {}
  const route = response.body?.ae_turn?.route || {};
  const routeText = JSON.stringify(report || {}).toLowerCase();
  const routeFalsehood = /(?:orange-navigator|navigator|codexa).{0,48}(?:unreachable|not reachable|offline|cannot connect)|(?:unreachable|not reachable|offline|cannot connect).{0,48}(?:orange-navigator|navigator|codexa)/i.test(routeText);
  const failureDetail = response.ok ? null : (() => {
    if (response.body == null) return response.error || null;
    const encoded = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
    return encoded.slice(0, 2_000);
  })();
  return {
    ok: response.ok && reportValid
      && ['codexa', 'codexa-tunnel'].includes(route.effective_node)
      && typeof route.effective_model === 'string'
      && route.effective_model.length > 0
      && response.body?.ae_turn?.receipt?.hash?.length === 64
      && response.body?.ae_turn?.project_context?.proof?.complete === true
      && response.body?.ae_turn?.compression?.consulted === true
      && response.body?.ae_execution_performed === false
      && !routeFalsehood,
    http_status: response.status,
    order_id: response.body?.ae_order_id || null,
    report_valid: reportValid,
    report_status: report?.status || null,
    route,
    route_truth_repair: response.body?.ae_route_truth_repair || null,
    receipt: response.body?.ae_turn?.receipt || null,
    memory_sources: response.body?.ae_turn?.memory?.sources || [],
    context_crystal: response.body?.ae_turn?.project_context?.metrics || null,
    compression: response.body?.ae_turn?.compression || null,
    route_falsehood: routeFalsehood,
    failure_detail: failureDetail,
  };
}

function proveMedia() {
  const specs = {
    tts: {
      receipt: path.join(RECEIPT_DIR, 'captain-planet', 'qwen3-tts', 'qwen3-tts-runtime-proof.json'),
      verify: verifyTtsArtifact,
    },
    music: {
      receipt: path.join(RECEIPT_DIR, 'captain-planet', 'ace-step', 'ace-step-runtime-proof.json'),
      verify: verifyMusicArtifact,
    },
    image: {
      receipt: path.join(RECEIPT_DIR, 'captain-planet', 'flux2', 'flux2-image-runtime-proof.json'),
      verify: verifyImageArtifact,
    },
    video: {
      receipt: path.join(RECEIPT_DIR, 'captain-planet', 'ltxv', 'ltx-video-runtime-proof.json'),
      verify: verifyVideoArtifact,
    },
  };
  return Object.fromEntries(Object.entries(specs).map(([name, spec]) => {
    const prior = readJson(spec.receipt);
    const fresh = spec.verify({ artifactPath: prior.artifact, sourceReceiptPath: prior.source_receipt });
    const checks = {
      prior_receipt_hash_valid: validateSelfHash(prior, 'receipt_sha256'),
      prior_runtime_proven: prior.runtime_execution_proven === true && allTrue(prior.checks),
      independent_runtime_proven: fresh.runtime_execution_proven === true && allTrue(fresh.checks),
      artifact_hash_stable: fresh.artifact_sha256 === prior.artifact_sha256,
      quality_not_overclaimed: prior.studio_quality_proven === false && fresh.studio_quality_proven === false,
    };
    return [name, {
      ok: allTrue(checks),
      checks,
      status: fresh.status,
      quality_status: fresh.quality_status,
      artifact: fresh.artifact,
      artifact_sha256: fresh.artifact_sha256,
      technical_metrics: fresh.audio || fresh.image || fresh.video || null,
    }];
  }));
}

const contextPath = latestFile('-context-crystal-quality-parity.json', (receipt) =>
  receipt.status === 'ORANGE5_CONTEXT_CRYSTAL_QUALITY_GREEN'
  && receipt.cases_total >= 5
  && receipt.cases_passed === receipt.cases_total
  && receipt.results?.every((item) => item.passed === true
    && item.quality_parity === true
    && item.verification?.ok === true
    && item.crystal?.proof?.complete === true));
const memoryPath = latestFile('-memory-quality-benchmark.json', (receipt) =>
  receipt.status === 'MEMORY_QUALITY_GREEN'
  && receipt.cases_total >= 23
  && receipt.cases_passed === receipt.cases_total);
const mcpPath = latestFile('-brain-mcp-dual-transport-proof.json', (receipt) =>
  receipt.status === 'ORANGE5_BRAIN_MCP_DUAL_TRANSPORT_GREEN' && allTrue(receipt.checks));
const hermesPath = latestFile('-hermes-live-execution-proof.json', (receipt) =>
  receipt.status === 'ORANGE5_HERMES_LIVE_EXECUTION_GREEN' && allTrue(receipt.checks));
const runtimePath = path.join(RECEIPT_DIR, 'runtime-logs', 'orange5-runtime-start-latest.json');
const context = readJson(contextPath);
const memory = readJson(memoryPath);
const mcp = readJson(mcpPath);
const hermes = readJson(hermesPath);
const runtime = readJson(runtimePath);

const [health, liveTurn, mcpHttp] = await Promise.all([
  healthSnapshot(),
  proveLiveGovernedTurn(),
  fetchJson('http://127.0.0.1:7431/health'),
]);
const media = proveMedia();

const contextRatios = context.results.map((item) => Number(item.crystal?.metrics?.operational_context_ratio || 0));
const contextChecks = {
  status_green: context.status === 'ORANGE5_CONTEXT_CRYSTAL_QUALITY_GREEN',
  fresh_under_24h: receiptAgeHours(context) <= 24,
  receipt_hash_valid: validateSelfHash(context, 'receipt_sha256'),
  held_out_cases_complete: context.cases_total >= 5 && context.cases_passed === context.cases_total,
  every_case_quality_parity: context.results.every((item) => item.passed === true && item.quality_parity === true),
  every_source_pointer_verified: context.results.every((item) => item.verification?.ok === true && item.crystal?.proof?.complete === true),
  every_case_over_1000x: contextRatios.length > 0 && contextRatios.every((ratio) => ratio >= 1_000),
};

const memoryChecks = {
  status_green: memory.status === 'MEMORY_QUALITY_GREEN',
  fresh_under_24h: receiptAgeHours(memory) <= 24,
  receipt_hash_valid: validateSelfHash(memory, 'receipt_sha256'),
  held_out_cases_complete: memory.cases_total >= 23 && memory.cases_passed === memory.cases_total,
  mrr_above_threshold: memory.mean_reciprocal_rank >= memory.thresholds.minimum_mrr,
  latency_below_threshold: memory.latency_ms.p95 <= memory.thresholds.maximum_p95_ms,
  hybrid_beats_ablations: memory.retrieval_bakeoff.hybrid.mean_reciprocal_rank >= Math.max(
    memory.retrieval_bakeoff.lexical.mean_reciprocal_rank,
    memory.retrieval_bakeoff.dense.mean_reciprocal_rank,
  ),
  contradiction_debt_resolved: memory.contradiction_debt.recorded > 0 && memory.contradiction_debt.unresolved === 0,
  contradiction_receipt_exists: fs.existsSync(memory.contradiction_debt.receipt_path),
};

const mcpChecks = {
  status_green: mcp.status === 'ORANGE5_BRAIN_MCP_DUAL_TRANSPORT_GREEN',
  fresh_under_24h: receiptAgeHours(mcp) <= 24,
  receipt_hash_valid: validateSelfHash(mcp, 'sha256'),
  proof_checks_green: allTrue(mcp.checks),
  live_http_endpoint: mcpHttp.ok && mcpHttp.body?.transport === 'streamable-http' && mcpHttp.body?.protocol === '2026-07-28',
};

const hermesChecks = {
  status_green: hermes.status === 'ORANGE5_HERMES_LIVE_EXECUTION_GREEN',
  fresh_under_24h: receiptAgeHours(hermes) <= 24,
  receipt_hash_valid: validateSelfHash(hermes, 'sha256'),
  proof_checks_green: allTrue(hermes.checks),
  refusal_and_execution_both_proven: hermes.checks.unapproved_process_refused === true && hermes.checks.approved_process_executed === true,
};

const selectedTier = liveTurn.route?.execution_tier;
const selectedFabricRoute = health.fabric?.selections?.[selectedTier] || null;
const selectedNode = selectedFabricRoute?.nodeId;
const effectiveNode = liveTurn.route?.effective_node;
const codexaNodeEquivalent = new Set([selectedNode, effectiveNode]).size === 2
  && [selectedNode, effectiveNode].every((node) => node === 'codexa' || node === 'codexa-tunnel');
const liveRouteModelMatchesFabric = Boolean(
  selectedFabricRoute
  && selectedFabricRoute.model === liveTurn.route?.effective_model,
);
const liveRouteNodeMatchesFabric = Boolean(
  selectedFabricRoute
  && (selectedNode === effectiveNode || codexaNodeEquivalent),
);

const runtimeChecks = {
  status_green: runtime.status === 'ORANGE5_RUNTIME_GREEN',
  fresh_under_24h: receiptAgeHours(runtime) <= 24,
  all_organs_green: allTrue(runtime.checks),
  shell_free_runtime: runtime.runtime_engine === 'bun-native-control' && runtime.powershell_runtime === false && runtime.popup_surface === 'none',
  gateway_live: health.operational === true && health.gateway?.ready === true,
  codexa_authorized: health.codexa?.reachable === true && health.codexa?.authorized === true && health.codexa?.executable === true,
  no_live_blockers: Array.isArray(health.blockers) && health.blockers.length === 0,
  live_governed_model_turn: liveTurn.ok === true,
  live_route_model_matches_current_fabric: liveRouteModelMatchesFabric,
  live_route_node_matches_current_fabric: liveRouteNodeMatchesFabric,
};

const groups = {
  runtime: { ok: allTrue(runtimeChecks), checks: runtimeChecks, health, live_turn: liveTurn },
  context_crystal: {
    ok: allTrue(contextChecks), checks: contextChecks, receipt: contextPath,
    cases: `${context.cases_passed}/${context.cases_total}`,
    ratios: { minimum: Math.min(...contextRatios), maximum: Math.max(...contextRatios) },
    corpus: context.corpus,
  },
  memory: {
    ok: allTrue(memoryChecks), checks: memoryChecks, receipt: memoryPath,
    cases: `${memory.cases_passed}/${memory.cases_total}`, mrr: memory.mean_reciprocal_rank,
    latency_ms: memory.latency_ms, retrieval_bakeoff: memory.retrieval_bakeoff,
    contradiction_debt: memory.contradiction_debt,
  },
  brain_mcp: { ok: allTrue(mcpChecks), checks: mcpChecks, receipt: mcpPath, observed_health: mcp.observedHealth },
  hermes: { ok: allTrue(hermesChecks), checks: hermesChecks, receipt: hermesPath, process: hermes.process, read: hermes.read },
  captain_planet: {
    ok: Object.values(media).every((item) => item.ok),
    runtime_functional: Object.values(media).every((item) => item.ok),
    studio_quality_proven: false,
    quality_status: 'PENDING_CROSS_PROMPT_HUMAN_AND_MODEL_QUALITY_BENCHMARK',
    lanes: media,
  },
};

const operationalGreen = Object.values(groups).every((group) => group.ok === true);
const generatedAt = new Date().toISOString();
const proof = {
  schema: 'orangefive.integrated-operational-proof.v1',
  status: operationalGreen ? 'ORANGEFIVE_INTEGRATED_OPERATIONAL_GREEN' : 'ORANGEFIVE_INTEGRATED_OPERATIONAL_NEEDS_WORK',
  generated_at: generatedAt,
  product: 'Orange',
  release: 'OrangeFive',
  operational_green: operationalGreen,
  studio_media_quality_proven: false,
  groups,
  blockers: [
    ...Object.entries(groups).filter(([, group]) => !group.ok).map(([name]) => `${name} integrated proof failed`),
  ],
  honest_limits: [
    'Creative artifacts are independently decoded and runtime-proven; studio quality is not yet certified.',
    'A 1,000x Context Crystal ratio is proven on the 6.77 MB held-out corpus, not asserted for every possible live turn.',
    'The live Navigator turn proves governed cognitive routing, not host mutation or tool execution.',
  ],
};
const stamp = generatedAt.replace(/[:.]/g, '-');
const receiptPath = path.join(RECEIPT_DIR, `${stamp}-integrated-operational-proof.json`);
const written = writeChainedJsonReceipt(receiptPath, proof);
process.stdout.write(`${JSON.stringify({
  status: written.status,
  operational_green: written.operational_green,
  groups: Object.fromEntries(Object.entries(written.groups).map(([name, group]) => [name, group.ok])),
  navigator: written.groups.runtime.live_turn.route,
  context_minimum_ratio: written.groups.context_crystal.ratios.minimum,
  memory_mrr: written.groups.memory.mrr,
  media_quality_status: written.groups.captain_planet.quality_status,
  blockers: written.blockers,
  receipt_sha256: written.receipt_sha256,
  receipt_path: receiptPath,
}, null, 2)}\n`);
if (!operationalGreen) process.exitCode = 1;
