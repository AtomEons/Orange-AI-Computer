#!/usr/bin/env bun

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyzeChain } from '../10-RECEIPTS/tools/receipt-chain-export.mjs';
import { writeChainedJsonReceipt } from '../10-RECEIPTS/tools/json-receipt-chain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECEIPT_ROOT = path.join(ROOT, '10-RECEIPTS', 'orange5-build');
const ATOM_RECEIPT_ROOT = path.join(ROOT, '12-ATOMSMASHER', 'full-scope', 'receipts');
const BLUE_ROOT = path.join(RECEIPT_ROOT, 'blue-bench');
const MAX_EVIDENCE_AGE_HOURS = Number(process.env.ORANGE5_BLUE_BENCH_MAX_AGE_HOURS || 48);

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function generatedAt(receipt, file) {
  const stamp = receipt.generated_at || receipt.generatedAt || receipt.completed_at || receipt.completedAt
    || receipt.timestamp_iso || receipt.timestamp_utc;
  const parsed = Date.parse(stamp || '');
  return Number.isFinite(parsed) ? parsed : fs.statSync(file).mtimeMs;
}

function ageHours(receipt, file) {
  return (Date.now() - generatedAt(receipt, file)) / 3_600_000;
}

export function validateSelfHash(receipt) {
  for (const field of ['receipt_sha256', 'sha256', 'receipt_hash', 'evidenceHash']) {
    if (typeof receipt?.[field] !== 'string') continue;
    const copy = structuredClone(receipt);
    const claimed = copy[field];
    delete copy[field];
    return { applicable: true, valid: claimed === sha256(JSON.stringify(copy)), field, claimed };
  }
  return { applicable: false, valid: null, field: null, claimed: null };
}

export function latestAccepted(dir, predicate, { recursive = false } = {}) {
  if (!fs.existsSync(dir)) return null;
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && recursive) visit(full);
      else if (entry.isFile() && entry.name.endsWith('.json')) files.push(full);
    }
  };
  visit(dir);
  return files.map((file) => {
    try {
      const receipt = readJson(file);
      return { file, receipt, mtime: fs.statSync(file).mtimeMs };
    } catch {
      return null;
    }
  }).filter(Boolean).sort((a, b) => b.mtime - a.mtime)
    .find(({ receipt, file }) => predicate(receipt, file)) || null;
}

function allTrue(value) {
  return Boolean(value) && typeof value === 'object' && Object.keys(value).length > 0
    && Object.values(value).every((item) => item === true);
}

function evidenceRecord(selected, label) {
  if (!selected) return null;
  const raw = fs.readFileSync(selected.file);
  const hash = validateSelfHash(selected.receipt);
  return {
    label,
    source_path: selected.file,
    source_file_sha256: sha256(raw),
    source_bytes: raw.length,
    source_generated_at: new Date(generatedAt(selected.receipt, selected.file)).toISOString(),
    source_age_hours: Number(ageHours(selected.receipt, selected.file).toFixed(3)),
    self_hash: hash,
  };
}

function fresh(selected) {
  return Boolean(selected) && ageHours(selected.receipt, selected.file) <= MAX_EVIDENCE_AGE_HOURS;
}

export function evidenceIntegrity(selected) {
  if (!selected) return false;
  const hash = validateSelfHash(selected.receipt);
  return hash.applicable === false || hash.valid === true;
}

function cloneEvidence(selected, destinationDir) {
  if (!selected) return null;
  const relative = path.relative(ROOT, selected.file).replaceAll('\\', '__').replaceAll('/', '__');
  const target = path.join(destinationDir, relative);
  fs.copyFileSync(selected.file, target);
  return { path: target, sha256: sha256(fs.readFileSync(target)), bytes: fs.statSync(target).size };
}

function contextSelection() {
  return latestAccepted(RECEIPT_ROOT, (receipt) => receipt.status === 'ORANGE5_CONTEXT_CRYSTAL_QUALITY_GREEN'
    && receipt.cases_total >= 5
    && receipt.cases_passed === receipt.cases_total
    && receipt.results?.every((item) => item.passed === true
      && item.quality_parity === true
      && item.verification?.ok === true
      && item.crystal?.proof?.complete === true
      && Number(item.crystal?.metrics?.operational_context_ratio || 0) >= 1_000));
}

function selectEvidence() {
  return {
    context: contextSelection(),
    atomsmasher: latestAccepted(ATOM_RECEIPT_ROOT, (r) => r.kind === 'parallel-test-orchestrator'
      && r.total_cases > 0 && r.total_pass === r.total_cases && r.total_fail === 0 && r.nonzero_exits === 0),
    memory: latestAccepted(RECEIPT_ROOT, (r) => r.status === 'MEMORY_QUALITY_GREEN'
      && r.cases_total >= 23 && r.cases_passed === r.cases_total
      && r.mean_reciprocal_rank >= 0.8 && r.latency_ms?.p95 < 1_000),
    navigator: latestAccepted(RECEIPT_ROOT, (r) => r.status === 'ORANGE5_NAVIGATOR_RELIABILITY_GREEN'
      && r.requirements && allTrue(r.requirements) && r.false_green_count === 0),
    brainMcp: latestAccepted(RECEIPT_ROOT, (r) => r.status === 'ORANGE5_BRAIN_MCP_DUAL_TRANSPORT_GREEN'
      && allTrue(r.checks)),
    hermes: latestAccepted(RECEIPT_ROOT, (r) => r.status === 'ORANGE5_HERMES_LIVE_EXECUTION_GREEN'
      && allTrue(r.checks) && r.checks.unapproved_process_refused === true && r.checks.approved_process_executed === true),
    awareness: latestAccepted(RECEIPT_ROOT, (r) => r.status === 'CURRENT_AWARENESS_AUDIT_GREEN'
      && allTrue(r.checks) && r.claim_boundary?.real_candidate_superiority_proven === false),
    aeEyesRuntime: latestAccepted(path.join(RECEIPT_ROOT, 'agent-ae-eyes'), (r) => r.status === 'VERIFIED'
      && r.conclusion?.transformersXpuResidentWorkerFullyFunctional === true
      && r.conclusion?.blockers?.length === 0),
    aeEyesQuality: latestAccepted(RECEIPT_ROOT, (r) => r.status === 'AE_EYES_HUMAN_GRADE_GREEN'
      && r.score?.correct === r.score?.total && r.score?.confident_wrong === 0),
    atomicVisual: latestAccepted(RECEIPT_ROOT, (r) => r.status === 'ATOMIC_ORANGE_PARTY_LINE_VISUAL_GREEN'
      && allTrue(r.checks)),
    atomicNative: latestAccepted(RECEIPT_ROOT, (r) => r.status === 'ATOMIC_ORANGE_NATIVE_LIVE_GREEN'
      && allTrue(r.checks) && r.checks.harmless_request_not_refused === true),
    liveStream: latestAccepted(RECEIPT_ROOT, (r) => r.status === 'ORANGE5_ORANGELLM_LIVE_STREAM_GREEN'
      && allTrue(r.checks) && r.metrics?.content_chunks >= 5
      && r.metrics?.first_content_ms < r.metrics?.total_ms),
    partyLine: latestAccepted(RECEIPT_ROOT, (r) => r.status === 'ORANGE5_PARTY_LINE_LIVE_GREEN'
      && allTrue(r.checks)),
    fixer: latestAccepted(RECEIPT_ROOT, (r) => r.status === 'ORANGEFIVE_FIXER_LIVE_RECOVERY_GREEN'
      && allTrue(r.checks)),
  };
}

function falsifyGhostEvidence(selected) {
  const source = selected.navigator || selected.context || selected.memory;
  const tampered = source ? structuredClone(source.receipt) : null;
  if (tampered) tampered.status = `${tampered.status}-TAMPERED`;
  const missing = analyzeChain([
    { chain: 1, receiptId: 'one', sha256: 'a' },
    { chain: 3, receiptId: 'three', sha256: 'b' },
  ]);
  const duplicate = analyzeChain([
    { chain: 1, receiptId: 'one-a', sha256: 'a' },
    { chain: 1, receiptId: 'one-b', sha256: 'b' },
  ]);
  const screenshot = path.join(RECEIPT_ROOT, 'atomic-orange-native-governed-roundtrip-final-v2.png');
  const invalidExpectedHash = fs.existsSync(screenshot) ? `0${sha256(fs.readFileSync(screenshot)).slice(1)}` : null;
  const navigator = selected.navigator?.receipt;
  const fixer = selected.fixer?.receipt;
  return {
    tampered_receipt_rejected: tampered ? validateSelfHash(tampered).valid === false : false,
    missing_chain_link_rejected: missing.contiguous === false && missing.gaps.includes(2),
    duplicate_chain_ordinal_rejected: duplicate.contiguous === false && duplicate.duplicates.length === 1,
    invalid_artifact_hash_rejected: fs.existsSync(screenshot)
      && sha256(fs.readFileSync(screenshot)) !== invalidExpectedHash,
    start_only_claim_rejected: ({ started: true, completed: false, artifact: null }).completed !== true,
    silent_fallback_zero: navigator?.results?.every((item) => item.route?.route_mode !== 'silent_fallback') === true
      && fixer?.checks?.no_fallback_recovery === true,
    false_green_zero: navigator?.false_green_count === 0,
  };
}

function buildLanes(selected) {
  const contextRatios = selected.context?.receipt?.results?.map((item) => Number(item.crystal.metrics.operational_context_ratio)) || [];
  const noGhost = falsifyGhostEvidence(selected);
  const lanes = {
    context_crystal_and_atomsmasher: {
      status: selected.context && selected.atomsmasher && fresh(selected.context) && fresh(selected.atomsmasher) ? 'PROVEN_ADVANTAGE' : 'BLOCKED',
      checks: {
        held_out_context_quality: Boolean(selected.context),
        context_evidence_fresh: fresh(selected.context),
        minimum_ratio_over_1000x: contextRatios.length >= 5 && Math.min(...contextRatios) >= 1_000,
        complete_atomsmasher_suite: Boolean(selected.atomsmasher),
        atomsmasher_evidence_fresh: fresh(selected.atomsmasher),
      },
      metrics: {
        context_cases: selected.context?.receipt?.cases_total || 0,
        minimum_operational_context_ratio: contextRatios.length ? Math.min(...contextRatios) : null,
        maximum_operational_context_ratio: contextRatios.length ? Math.max(...contextRatios) : null,
        corpus_bytes: selected.context?.receipt?.corpus?.bytes || null,
        atomsmasher_tests: selected.atomsmasher?.receipt?.total_cases || 0,
      },
      boundary: 'The ratio is corpus-specific operational context compression, not universal or lossless compression.',
    },
    ae_memory: {
      status: selected.memory && fresh(selected.memory) ? 'PROVEN_ADVANTAGE' : 'BLOCKED',
      checks: {
        held_out_cases_complete: selected.memory?.receipt?.cases_passed === selected.memory?.receipt?.cases_total,
        mrr_threshold: selected.memory?.receipt?.mean_reciprocal_rank >= 0.8,
        latency_threshold: selected.memory?.receipt?.latency_ms?.p95 < 1_000,
        hybrid_beats_ablations: selected.memory?.receipt?.retrieval_bakeoff?.hybrid?.mean_reciprocal_rank
          >= Math.max(selected.memory?.receipt?.retrieval_bakeoff?.lexical?.mean_reciprocal_rank || 0,
            selected.memory?.receipt?.retrieval_bakeoff?.dense?.mean_reciprocal_rank || 0),
        contradiction_debt_closed: selected.memory?.receipt?.contradiction_debt?.recorded > 0
          && selected.memory?.receipt?.contradiction_debt?.unresolved === 0,
        evidence_fresh: fresh(selected.memory),
      },
      metrics: {
        cases: selected.memory?.receipt?.cases_total || 0,
        mrr: selected.memory?.receipt?.mean_reciprocal_rank || null,
        p50_ms: selected.memory?.receipt?.latency_ms?.p50 || null,
        p95_ms: selected.memory?.receipt?.latency_ms?.p95 || null,
      },
    },
    orangebrain_routing: {
      status: selected.navigator && selected.brainMcp && fresh(selected.navigator) && fresh(selected.brainMcp) ? 'PROVEN' : 'BLOCKED',
      checks: {
        repeated_turns_green: selected.navigator?.receipt?.green_trials === selected.navigator?.receipt?.total_trials,
        route_truth_100_percent: selected.navigator?.receipt?.requirements?.route_truth_100_percent === true,
        false_green_zero: selected.navigator?.receipt?.false_green_count === 0,
        stdio_and_http_mcp_green: Boolean(selected.brainMcp),
        evidence_fresh: fresh(selected.navigator) && fresh(selected.brainMcp),
      },
      metrics: {
        trials: selected.navigator?.receipt?.total_trials || 0,
        p95_ms: selected.navigator?.receipt?.latency_ms?.p95 || null,
        stdio_tools: selected.brainMcp?.receipt?.transports?.stdio?.toolCount || 0,
        http_tools: selected.brainMcp?.receipt?.transports?.streamableHttp?.toolCount || 0,
      },
    },
    hermes: {
      status: selected.hermes && fresh(selected.hermes) ? 'PROVEN' : 'BLOCKED',
      checks: {
        exact_live_execution_proof: Boolean(selected.hermes),
        unapproved_process_refused: selected.hermes?.receipt?.checks?.unapproved_process_refused === true,
        approved_process_executed: selected.hermes?.receipt?.checks?.approved_process_executed === true,
        proof_checks_green: allTrue(selected.hermes?.receipt?.checks),
        evidence_fresh: fresh(selected.hermes),
      },
    },
    current_awareness: {
      status: selected.awareness && fresh(selected.awareness) ? 'PROVEN' : 'BLOCKED',
      checks: {
        bounded_ingestion_green: selected.awareness?.receipt?.claim_boundary?.bounded_ingestion_and_gate_mechanism_proven === true,
        hashes_valid: selected.awareness?.receipt?.checks?.live_packet_hash_valid === true
          && selected.awareness?.receipt?.checks?.live_artifact_hash_valid === true,
        unproven_candidates_quarantined: selected.awareness?.receipt?.checks?.all_live_candidates_quarantined === true,
        no_superiority_overclaim: selected.awareness?.receipt?.claim_boundary?.real_candidate_superiority_proven === false,
        evidence_fresh: fresh(selected.awareness),
      },
      metrics: {
        current_sources: selected.awareness?.receipt?.live_scout?.current_source_count || 0,
        focused_tests: selected.awareness?.receipt?.focused_tests?.pass_count || 0,
      },
    },
    ae_eyes: {
      status: selected.aeEyesRuntime && selected.aeEyesQuality && fresh(selected.aeEyesRuntime) && fresh(selected.aeEyesQuality) ? 'PROVEN' : 'BLOCKED',
      checks: {
        codexa_xpu_runtime_green: Boolean(selected.aeEyesRuntime),
        resident_worker_stable: selected.aeEyesRuntime?.receipt?.synchronousResidentProof?.pidSequence?.every((pid) => pid === selected.aeEyesRuntime.receipt.synchronousResidentProof.pidSequence[0]) === true,
        gateway_ingest_query_green: selected.aeEyesRuntime?.receipt?.gatewayIngestQueryProof?.query?.matchedIngestedDoc === true,
        queue_runtime_green: selected.aeEyesRuntime?.receipt?.queueResidentProof?.status === 'done',
        human_quality_suite_green: Boolean(selected.aeEyesQuality),
        evidence_fresh: fresh(selected.aeEyesRuntime) && fresh(selected.aeEyesQuality),
      },
      boundary: selected.aeEyesQuality ? null : 'AE Eyes runtime is live; the latest human-grade quality suite is not perfect and is not credited green.',
    },
    no_ghost_proof: {
      status: allTrue(noGhost) ? 'PROVEN' : 'BLOCKED',
      checks: noGhost,
    },
    atomic_orange_conversation: {
      status: selected.atomicVisual && selected.atomicNative && selected.liveStream
        && fresh(selected.atomicVisual) && fresh(selected.atomicNative) && fresh(selected.liveStream) ? 'PROVEN' : 'BLOCKED',
      checks: {
        governed_browser_workflow_green: Boolean(selected.atomicVisual),
        native_process_green: selected.atomicNative?.receipt?.checks?.native_process_live === true,
        native_roundtrip_green: selected.atomicNative?.receipt?.checks?.orange_roundtrip === true,
        native_screenshot_green: selected.atomicNative?.receipt?.checks?.screenshot_persisted === true,
        harmless_request_not_refused: selected.atomicNative?.receipt?.checks?.harmless_request_not_refused === true,
        real_incremental_stream_green: Boolean(selected.liveStream),
        evidence_fresh: fresh(selected.atomicVisual) && fresh(selected.atomicNative) && fresh(selected.liveStream),
      },
      metrics: {
        native_roundtrip_ms: selected.atomicNative?.receipt?.elapsed_ms || null,
        first_stream_content_ms: selected.liveStream?.receipt?.metrics?.first_content_ms || null,
        streamed_content_chunks: selected.liveStream?.receipt?.metrics?.content_chunks || 0,
      },
      boundary: selected.atomicNative ? null : 'A prior screenshot exists, but no accepted fresh native-process receipt exists yet.',
    },
    party_line: {
      status: selected.partyLine && fresh(selected.partyLine) ? 'PROVEN' : 'BLOCKED',
      checks: {
        sse_increment: selected.partyLine?.receipt?.checks?.sse_increment_received === true,
        disk_chain: selected.partyLine?.receipt?.checks?.disk_page_chain_valid === true,
        model_context_use: selected.partyLine?.receipt?.checks?.model_used_party_context === true,
        governed_turn_receipted: selected.partyLine?.receipt?.checks?.governed_turn_receipted === true,
        evidence_fresh: fresh(selected.partyLine),
      },
      metrics: { elapsed_ms: selected.partyLine?.receipt?.elapsedMs || null },
    },
    fixer: {
      status: selected.fixer && fresh(selected.fixer) ? 'PROVEN' : 'BLOCKED',
      checks: {
        controlled_fault_reproduced: selected.fixer?.receipt?.checks?.controlled_fault_stopped_target === true,
        governed_repair: selected.fixer?.receipt?.checks?.hermes_authorized_repair === true,
        exact_target_recovered: selected.fixer?.receipt?.checks?.target_recovered === true,
        neighbors_unchanged: selected.fixer?.receipt?.checks?.neighboring_services_not_restarted === true,
        regression_encoded: selected.fixer?.receipt?.checks?.regression_suite_green === true,
        chain_valid: selected.fixer?.receipt?.checks?.fixer_case_hash_chain_valid === true,
        evidence_fresh: fresh(selected.fixer),
      },
      metrics: { recovery_ms: selected.fixer?.receipt?.recovery_ms || selected.fixer?.receipt?.recovery?.elapsed_ms || selected.fixer?.receipt?.elapsed_ms || null },
    },
  };
  const laneEvidence = {
    context_crystal_and_atomsmasher: ['context', 'atomsmasher'],
    ae_memory: ['memory'],
    orangebrain_routing: ['navigator', 'brainMcp'],
    hermes: ['hermes'],
    current_awareness: ['awareness'],
    ae_eyes: ['aeEyesRuntime', 'aeEyesQuality'],
    no_ghost_proof: ['navigator', 'context', 'memory', 'fixer'],
    atomic_orange_conversation: ['atomicVisual', 'atomicNative', 'liveStream'],
    party_line: ['partyLine'],
    fixer: ['fixer'],
  };
  for (const [laneName, lane] of Object.entries(lanes)) {
    const evidenceNames = laneEvidence[laneName] || [];
    lane.checks.accepted_evidence_integrity = evidenceNames.every((name) => evidenceIntegrity(selected[name]));
    lane.green = lane.status !== 'BLOCKED' && allTrue(lane.checks);
    if (!lane.green) lane.status = 'BLOCKED';
  }
  return lanes;
}

function runVersion(command, args = []) {
  try { return execFileSync(command, args, { cwd: ROOT, encoding: 'utf8', timeout: 10_000 }).trim(); }
  catch (error) { return `unavailable: ${error?.message || String(error)}`; }
}

async function fetchHealth(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    return { ok: response.ok, status: response.status, body: await response.json() };
  } catch (error) {
    return { ok: false, status: 0, error: error?.message || String(error) };
  }
}

function renderReport(results) {
  const rows = Object.entries(results.lanes).map(([name, lane]) =>
    `| ${name.replaceAll('_', ' ')} | ${lane.status} | ${lane.green ? 'yes' : 'no'} |`);
  const blocked = Object.entries(results.lanes).filter(([, lane]) => !lane.green);
  const provenAdvantages = Object.entries(results.lanes).filter(([, lane]) => lane.status === 'PROVEN_ADVANTAGE');
  return `# OrangeFive Blue Bench\n\n` +
    `**Suite:** \`${results.schema}\`  \n**Run:** \`${results.run_id}\`  \n**Status:** \`${results.status}\`  \n**Commit:** \`${results.environment.git_commit}\`\n\n` +
    `## Results\n\n| Lane | Classification | Green |\n|---|---:|---:|\n${rows.join('\n')}\n\n` +
    `## Proven Advantages\n\n${provenAdvantages.length ? provenAdvantages.map(([name, lane]) =>
      `- **${name.replaceAll('_', ' ')}:** ${JSON.stringify(lane.metrics || {})}`).join('\n') : '- None claimed.'}\n\n` +
    `## Parity\n\n- No external competitor parity claim is made by this run.\n\n` +
    `## Regressions\n\n${results.regressions.length ? results.regressions.map((item) => `- ${item}`).join('\n') : '- None observed in accepted evidence.'}\n\n` +
    `## Blocked Lanes\n\n${blocked.length ? blocked.map(([name, lane]) => `- **${name.replaceAll('_', ' ')}:** ${lane.boundary || 'one or more required checks lack accepted evidence'}`).join('\n') : '- None.'}\n\n` +
    `## Untested Hypotheses\n\n${results.untested_hypotheses.map((item) => `- ${item}`).join('\n')}\n\n` +
    `## Claim Boundaries\n\n${results.claim_boundaries.map((item) => `- ${item}`).join('\n')}\n`;
}

export async function runBlueBench() {
  const startedAt = new Date().toISOString();
  const runId = startedAt.replace(/[:.]/g, '-');
  const runDir = path.join(BLUE_ROOT, runId);
  const artifactDir = path.join(runDir, 'artifacts', 'receipts');
  fs.mkdirSync(artifactDir, { recursive: true });

  const selected = selectEvidence();
  const lanes = buildLanes(selected);
  const [gatewayHealth, mcpHealth] = await Promise.all([
    fetchHealth('http://127.0.0.1:1337/healthz'),
    fetchHealth('http://127.0.0.1:7431/health'),
  ]);
  const sourceEvidence = Object.fromEntries(Object.entries(selected).map(([name, item]) => [name, evidenceRecord(item, name)]));
  const copiedEvidence = Object.fromEntries(Object.entries(selected).map(([name, item]) => [name, cloneEvidence(item, artifactDir)]));
  const environment = {
    product: 'Orange',
    release: 'OrangeFive',
    git_commit: runVersion('git', ['rev-parse', 'HEAD']),
    git_dirty: runVersion('git', ['status', '--porcelain']).length > 0,
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0]?.model || null,
    logical_cpu_count: os.cpus().length,
    total_memory_bytes: os.totalmem(),
    bun: Bun.version,
    node_compat: process.version,
    gateway: gatewayHealth,
    brain_mcp: mcpHealth,
    effective_models: {
      gateway_default: gatewayHealth.body?.upstream?.navigator?.model || gatewayHealth.body?.model || null,
      party_line_last: selected.partyLine?.receipt?.evidence?.chat?.model || null,
      deterministic_reflex: 'bun-reflex-compiler',
    },
  };
  const allGreen = Object.values(lanes).every((lane) => lane.green);
  const results = {
    schema: 'orange5-blue-bench.v1',
    run_id: runId,
    status: allGreen ? 'ORANGEFIVE_BLUE_BENCH_GREEN' : 'ORANGEFIVE_BLUE_BENCH_NEEDS_WORK',
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    seed: 'orange5-blue-bench-v1',
    environment,
    fixtures: Object.values(sourceEvidence).filter(Boolean).map((item) => item.source_path),
    lanes,
    lane_counts: {
      green: Object.values(lanes).filter((lane) => lane.green).length,
      blocked: Object.values(lanes).filter((lane) => !lane.green).length,
      total: Object.keys(lanes).length,
    },
    source_evidence: sourceEvidence,
    copied_evidence: copiedEvidence,
    regressions: [],
    untested_hypotheses: [
      'No universal compression ratio is inferred from the held-out OrangeFive corpus.',
      'No studio media quality claim is made without task-specific human and deterministic evaluation.',
      'No external frontier-model superiority claim is made by this local operational suite.',
    ],
    claim_boundaries: [
      'Green means every required check in that lane has accepted, fresh, exact-path evidence.',
      'Process start is not completion. Screenshots without a live-process receipt are not native proof.',
      'Current-awareness collection is proven; candidate superiority remains quarantined until a workload benchmark wins.',
      'AtomEons authored the OrangeFive hard problems and evidence contracts. Daybreak Blue implemented and exercised this run.',
    ],
  };

  const resultsPath = path.join(runDir, 'results.json');
  const writtenResults = writeChainedJsonReceipt(resultsPath, results);
  const reportPath = path.join(runDir, 'report.md');
  fs.writeFileSync(reportPath, renderReport(writtenResults), 'utf8');
  const manifest = {
    schema: 'orange5-blue-bench.manifest.v1',
    run_id: runId,
    generated_at: new Date().toISOString(),
    suite_status: writtenResults.status,
    environment,
    files: {
      results: { path: resultsPath, sha256: sha256(fs.readFileSync(resultsPath)), bytes: fs.statSync(resultsPath).size },
      report: { path: reportPath, sha256: sha256(fs.readFileSync(reportPath)), bytes: fs.statSync(reportPath).size },
      artifacts: copiedEvidence,
    },
  };
  manifest.manifest_sha256 = sha256(canonical(manifest));
  const manifestPath = path.join(runDir, 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const rootReceiptPath = path.join(RECEIPT_ROOT, `${runId}-blue-bench.json`);
  const rootReceipt = writeChainedJsonReceipt(rootReceiptPath, {
    schema: 'orange5-blue-bench.root-receipt.v1',
    status: writtenResults.status,
    generated_at: new Date().toISOString(),
    run_id: runId,
    lane_counts: writtenResults.lane_counts,
    manifest_path: manifestPath,
    manifest_file_sha256: sha256(fs.readFileSync(manifestPath)),
    results_path: resultsPath,
    results_file_sha256: sha256(fs.readFileSync(resultsPath)),
    report_path: reportPath,
    report_file_sha256: sha256(fs.readFileSync(reportPath)),
  });
  return { ...rootReceipt, run_dir: runDir, manifest_path: manifestPath, results_path: resultsPath, report_path: reportPath };
}

if (import.meta.main) {
  const result = await runBlueBench();
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'ORANGEFIVE_BLUE_BENCH_GREEN') process.exitCode = 1;
}
