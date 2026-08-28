#!/usr/bin/env bun

import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCurrentAwareness } from './current-awareness.mjs';
import { readProjectLock } from './project-lock.mjs';
import { validateOrangeReport } from '../06-ORANGELLM/contracts/orange-report.mjs';
import { writeChainedJsonReceipt } from '../10-RECEIPTS/tools/json-receipt-chain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECEIPT_DIR = path.join(ROOT, '10-RECEIPTS', 'orange5-build');
const GATEWAY = process.env.ORANGE5_ORANGEBRAIN_URL || 'http://127.0.0.1:1337';
const force = process.argv.includes('--force');
const budgetIndex = process.argv.indexOf('--budget-ms');
const budgetMs = Math.max(5_000, Math.min(60_000, Number(process.argv[budgetIndex + 1]) || 45_000));
const resumeIndex = process.argv.indexOf('--resume');
const resumePath = resumeIndex >= 0 ? process.argv[resumeIndex + 1] : null;
const project = readProjectLock();

function latestReceipt(suffix) {
  const glob = new Bun.Glob(`*${suffix}`);
  const files = [...glob.scanSync({ cwd: RECEIPT_DIR, onlyFiles: true })]
    .map((name) => ({ name, path: path.join(RECEIPT_DIR, name) }))
    .sort((a, b) => b.name.localeCompare(a.name));
  if (!files[0]) throw new Error(`missing required receipt: ${suffix}`);
  return files[0];
}

const SCOUTS = [
  {
    id: 'runtime-orchestration',
    query: 'current open source local first AI orchestration MCP agent runtime Windows Bun reliability observability tools beta releases',
  },
  {
    id: 'memory-compression-learning',
    query: 'current primary source AI agent memory retrieval context compression continual learning failure memory research open source implementations',
  },
  {
    id: 'models-and-creative',
    query: 'current open weight local AI models coding reasoning vision image video audio generation Intel XPU ComfyUI releases benchmarks',
  },
  {
    id: 'security-and-operator-reality',
    query: 'current local AI agent security provenance receipt observability self healing Windows service operator UX anti hallucination tools research',
  },
];

const REVIEWERS = [
  {
    id: 'systems-hole-falsifier',
    intent: 'Perform a cross-discipline deep review. Find the highest-impact missing or weak OrangeFive runtime capabilities. Every finding must start with [local] or its candidate id [c0]..[c3]. Do not invent numbers. Distinguish a proven hole from a hypothesis and return an exact test.',
  },
  {
    id: 'beta-adoption-curator',
    intent: 'Perform a cross-discipline deep review of current candidates for OrangeFive. Every finding must start with [local] or its candidate id [c0]..[c3]. Reject novelty theater and invented numbers. Define the incumbent-versus-candidate benchmark required before adoption.',
  },
  {
    id: 'resource-and-model-auditor',
    intent: 'Perform a cross-discipline deep review of the N150 plus Codexa topology and current model/tool candidates. Every finding must start with [local] or its candidate id [c0]..[c3]. Find waste and one-at-a-time lease improvements. Do not invent hardware facts or numbers.',
  },
  {
    id: 'reality-and-drift-auditor',
    intent: 'Perform a cross-discipline deep review of OrangeFive for agent theater, stale research, source drift, false green, silent service failure, and scope loss. Every finding must start with [local] or [c0]..[c3]. Do not invent numbers. Return deterministic probes.',
  },
];

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function compactCandidate(candidate, scoutId) {
  return {
    id: candidate.id || sha256(candidate.url || candidate.title).slice(0, 16),
    scout: scoutId,
    title: candidate.title || 'untitled',
    url: candidate.url || null,
    provider: candidate.provider || null,
    summary: candidate.summary || null,
    freshness: candidate.freshness || null,
    lifecycle: candidate.lifecycle || null,
    authorityTier: candidate.authorityTier || null,
    sourceQuality: candidate.sourceQuality ?? null,
    license: candidate.license || null,
    stars: candidate.stars || 0,
    promotionStatus: 'BENCHMARK_REQUIRED',
  };
}

async function runScout(spec) {
  const started = performance.now();
  try {
    const result = await getCurrentAwareness({
      query: spec.query,
      project,
      force,
      budgetMs,
      maxSources: 10,
    });
    return {
      id: spec.id,
      ok: result.status === 'CURRENT_EVIDENCE_READY' && result.sourceCount > 0,
      latency_ms: Math.round(performance.now() - started),
      status: result.status,
      source_count: result.sourceCount || 0,
      cache_hit: result.cacheHit === true,
      query_hash: result.queryHash,
      evidence_artifact: result.evidenceArtifactPath,
      registry: result.registryPath,
      sha256: result.sha256,
      errors: result.errors || [],
      candidates: (result.candidates || []).map((candidate) => compactCandidate(candidate, spec.id)),
      opportunities: result.opportunities || [],
      compressed_brief: result.brief || '',
    };
  } catch (error) {
    return {
      id: spec.id,
      ok: false,
      latency_ms: Math.round(performance.now() - started),
      status: 'SCOUT_FAILED',
      source_count: 0,
      errors: [error?.message || String(error)],
      candidates: [],
      opportunities: [],
      compressed_brief: '',
    };
  }
}

function evidenceLines(scouts, candidates, integrated) {
  const scoutDigest = sha256(JSON.stringify(scouts.map(({ id, status, source_count, sha256: digest }) => ({ id, status, source_count, digest }))));
  const candidateDigest = sha256(JSON.stringify(candidates));
  const sourceCount = scouts.reduce((sum, scout) => sum + scout.source_count, 0);
  return [
    `integrated=${integrated.operational_green ? 'GREEN' : 'RED'};sha=${String(integrated.receipt_sha256).slice(0, 16)}`,
    `scouts=${scouts.length};sources=${sourceCount};candidates=${candidates.length};sha=${sha256(scoutDigest + candidateDigest).slice(0, 16)}`,
  ];
}

function findingGrounded(finding, context) {
  const text = String(finding);
  const match = text.match(/^\[(local|c[0-3])\]\s*/i);
  if (!match) return false;
  const sourceText = match[1].toLowerCase() === 'local'
    ? JSON.stringify(context.local_runtime)
    : JSON.stringify(context.candidates[Number(match[1].slice(1))] || {});
  const percentages = [...text.matchAll(/\b\d+(?:\.\d+)?%/g)].map((item) => item[0]);
  return percentages.every((value) => sourceText.includes(value));
}

async function callReviewer(spec, evidence, context) {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 240_000);
  try {
    const response = await fetch(`${GATEWAY}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        model: 'orange-auto',
        messages: [{ role: 'user', content: JSON.stringify({ intent: spec.intent, evidence, context }) }],
        stream: false,
        max_tokens: 700,
        temperature: 0,
        ae_response_contract: 'orange.report.v1',
        ae_evidence_policy: 'preserve_exact',
      }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    let report = null;
    try { report = JSON.parse(body?.choices?.[0]?.message?.content || ''); } catch {}
    let reportValid = false;
    let validationError = null;
    try {
      validateOrangeReport(report, body?.ae_order_id);
      reportValid = true;
    } catch (error) {
      validationError = error?.message || String(error);
    }
    const receipt = body?.ae_turn?.receipt || {};
    const evidencePreserved = Array.isArray(report?.evidence)
      && report.evidence.length === evidence.length
      && report.evidence.every((item, index) => item === evidence[index]);
    const substantiveFindings = (Array.isArray(report?.findings) ? report.findings : [])
      .map((finding) => String(finding))
      .filter((finding) => finding.length >= 80 && !finding.startsWith('existing_project_lineage:'));
    const groundedFindings = substantiveFindings.filter((finding) => findingGrounded(finding, context));
    return {
      id: spec.id,
      ok: response.ok && reportValid && evidencePreserved && receipt.hash?.length === 64 && groundedFindings.length > 0,
      latency_ms: Math.round(performance.now() - started),
      http_status: response.status,
      order_id: body?.ae_order_id || null,
      gateway_error: body?.error || null,
      report_valid: reportValid,
      evidence_preserved: evidencePreserved,
      validation_error: validationError,
      route: body?.ae_turn?.route || null,
      receipt,
      report,
      substantive_findings: substantiveFindings,
      grounded_findings: groundedFindings,
      report_sha256: sha256(JSON.stringify(report || {})),
    };
  } catch (error) {
    return {
      id: spec.id,
      ok: false,
      latency_ms: Math.round(performance.now() - started),
      http_status: 0,
      report_valid: false,
      evidence_preserved: false,
      validation_error: error?.message || String(error),
      route: null,
      receipt: null,
      report: null,
      report_sha256: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

const scouts = await Promise.all(SCOUTS.map(runScout));
const candidateMap = new Map();
for (const candidate of scouts.flatMap((scout) => scout.candidates)) {
  const key = candidate.url || `${candidate.provider}:${candidate.title}`;
  if (!candidateMap.has(key)) candidateMap.set(key, candidate);
}
const candidates = [...candidateMap.values()]
  .sort((a, b) => (b.sourceQuality || 0) - (a.sourceQuality || 0) || (b.stars || 0) - (a.stars || 0));
const integratedReceipt = latestReceipt('-integrated-operational-proof.json');
const integrated = await Bun.file(integratedReceipt.path).json();
const evidence = evidenceLines(scouts, candidates, integrated);
const reviewContext = {
  local_runtime: {
    status: integrated.status,
    operational_green: integrated.operational_green,
    groups: Object.fromEntries(Object.entries(integrated.groups || {}).map(([name, group]) => [name, group.ok === true])),
    blockers: integrated.blockers || [],
    honest_limits: integrated.honest_limits || [],
    media_quality_status: integrated.groups?.captain_planet?.quality_status || null,
  },
  scouts: scouts.map(({ id, status, source_count }) => ({ id, status, source_count })),
  candidates: candidates.slice(0, 4).map(({ title, url, summary, sourceQuality, freshness, lifecycle }, index) => ({
    id: `c${index}`,
    title: String(title).slice(0, 96),
    url,
    summary: String(summary || '').slice(0, 140),
    sourceQuality,
    freshness,
    lifecycle,
  })),
};
let resumed = null;
try { if (resumePath) resumed = await Bun.file(resumePath).json(); } catch {}
const reviewers = [];
for (const reviewer of REVIEWERS) {
  const prior = resumed?.reviewers?.find((item) => item.id === reviewer.id
    && item.ok === true
    && item.evidence_preserved === true
    && item.route?.execution_tier === 'heavy'
    && Array.isArray(item.substantive_findings)
    && item.substantive_findings.length > 0
    && Array.isArray(item.grounded_findings)
    && item.grounded_findings.length > 0
    && Array.isArray(item.report?.evidence)
    && item.report.evidence.length === evidence.length
    && item.report.evidence.every((value, index) => value === evidence[index]));
  reviewers.push(prior || await callReviewer(reviewer, evidence, reviewContext));
}
const findings = reviewers.flatMap((reviewer) =>
  Array.isArray(reviewer.report?.findings)
    ? reviewer.report.findings.map((finding) => ({ reviewer: reviewer.id, finding }))
    : [],
);
const checks = {
  all_research_domains_returned: scouts.length === SCOUTS.length,
  every_research_domain_has_current_evidence: scouts.every((scout) => scout.ok),
  all_candidates_quarantined_pending_benchmark: candidates.every((candidate) => candidate.promotionStatus === 'BENCHMARK_REQUIRED'),
  all_reviewers_returned: reviewers.length === REVIEWERS.length,
  all_reviewer_reports_schema_valid: reviewers.every((reviewer) => reviewer.report_valid),
  all_reviewer_evidence_preserved: reviewers.every((reviewer) => reviewer.evidence_preserved),
  all_reviewer_calls_receipted: reviewers.every((reviewer) => reviewer.receipt?.hash?.length === 64),
  all_reviewers_used_heavy_lane: reviewers.every((reviewer) => reviewer.route?.execution_tier === 'heavy'),
  all_reviewers_produced_substantive_findings: reviewers.every((reviewer) => Array.isArray(reviewer.substantive_findings) && reviewer.substantive_findings.length > 0),
  all_reviewer_findings_source_grounded: reviewers.every((reviewer) => Array.isArray(reviewer.grounded_findings) && reviewer.grounded_findings.length > 0),
  perspectives_are_distinct: new Set(reviewers.map((reviewer) => reviewer.report_sha256).filter(Boolean)).size === reviewers.length,
};
const swarmOperational = Object.values(checks).every(Boolean);
const generatedAt = new Date().toISOString();
const packet = {
  schema: 'orangefive.system-hole-research-swarm.v1',
  status: swarmOperational ? 'ORANGEFIVE_SYSTEM_HOLE_SWARM_OPERATIONAL_WITH_FINDINGS' : 'ORANGEFIVE_SYSTEM_HOLE_SWARM_NEEDS_WORK',
  generated_at: generatedAt,
  product: 'Orange',
  release: 'OrangeFive',
  swarm_operational: swarmOperational,
  law: 'Discovery is not promotion. Every candidate remains quarantined until a local incumbent-versus-candidate benchmark and receipt prove benefit.',
  checks,
  scouts,
  reviewers,
  candidates,
  findings,
  open_findings: findings.length,
};
const receiptPath = path.join(RECEIPT_DIR, `${generatedAt.replace(/[:.]/g, '-')}-system-hole-research-swarm.json`);
const written = writeChainedJsonReceipt(receiptPath, packet);
console.log(JSON.stringify({
  status: written.status,
  swarm_operational: written.swarm_operational,
  checks: written.checks,
  scouts: written.scouts.map(({ id, ok, source_count, latency_ms }) => ({ id, ok, source_count, latency_ms })),
  reviewers: written.reviewers.map(({ id, ok, latency_ms, route, receipt }) => ({ id, ok, latency_ms, model: route?.effective_model || null, node: route?.effective_node || null, receipt: receipt?.hash || null })),
  candidates_quarantined: written.candidates.length,
  open_findings: written.open_findings,
  receipt_path: receiptPath,
  receipt_sha256: written.receipt_sha256,
}, null, 2));
if (!swarmOperational) process.exitCode = 1;
