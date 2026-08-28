#!/usr/bin/env bun
// Orange5 Spine CLI — submit an order, get a governed report + receipt.
// This is what a model/skill calls from the shell to DRIVE Orange5.
//
// Usage:
//   bun 03-BACKEND/spine-cli.mjs --order '{"action":"build.feature","payload":{"text":"..."}}'
//   bun 03-BACKEND/spine-cli.mjs --order-file order.json
//   echo '{"action":"read.status"}' | bun 03-BACKEND/spine-cli.mjs
//   bun 03-BACKEND/spine-cli.mjs --order '{...}' --dry-run      # plan only, writes nothing
//   bun 03-BACKEND/spine-cli.mjs --order '{...}' --seed abc     # deterministic replay
//   bun 03-BACKEND/spine-cli.mjs --order '{...}' --learn        # close the AE-Cobra loop
//   bun 03-BACKEND/spine-cli.mjs --health                       # phase/pillar snapshot
//
// Execution always targets the canonical OpenAI-compatible gateway. The
// environment may override its address, but a missing variable never disables
// real execution or silently selects a stub.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOrder } from './orange5-spine.mjs';
import { closeLoop } from './learning-loop.mjs';
import { canonicalFluxRoot } from '../06-ORANGELLM/memory/ae-cobra/paths.mjs';
import { classifyModelExecution, executeOperationalAction } from './operational-executor.mjs';
import { buildMemoryContext, buildModelMemoryBrief, memoryContextEvidence } from './memory-context.mjs';
import { resolveOrangeBrainUrl } from './brain-endpoint.mjs';
import { runGatewayAdversarialPass } from './adversarial-pass.mjs';
import { beginOperationalContinuum, settleOperationalContinuum } from './operational-continuum.mjs';
import { beginSolarWave, routeSolarWave, settleSolarWave } from './solar-wave.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHAIN_FILE = path.join(ROOT, '10-RECEIPTS', 'spine-chain.jsonl');
const FLUX_ROOT = canonicalFluxRoot();

export function deterministicAdversarialAttestation(order, execution) {
  const source = execution?.evidence?.source;
  const eligible = (order?.action === 'synthesize.delegation' && source === 'receipt_backed_deterministic_synthesis')
    || (order?.action === 'analyze.agent' && [
      'governed_execution_reflex',
      'governed_research_evidence_reflex',
    ].includes(source));
  if (!eligible
    || execution?.evidence?.execution !== 'cognitive_report_completed') return null;
  return {
    completed: true,
    preExecution: true,
    refuted: false,
    status: 'not_applicable_deterministic',
    reason: 'validated governed evidence processing introduced no model-generated claim',
    blockers: [],
    model: null,
    lane: 'reflex',
    host: 'n150',
  };
}

function argVal(flag) { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined; }
function hasFlag(flag) { return process.argv.includes(flag); }

const APPROVAL_RISK_LEVELS = new Set(['high', 'destructive', 'irreversible', 'production']);

function orderActionList(order, field, fallback) {
  if (!(field in order)) return [...fallback];
  if (!Array.isArray(order[field]) || !order[field].every((item) => typeof item === 'string' && item.length > 0)) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  return [...order[field]];
}

export function compileCliGovernance(order, leaseId = 'spine-cli') {
  if (!order || typeof order !== 'object' || typeof order.action !== 'string' || order.action.length === 0) {
    throw new Error('order.action must be a non-empty string');
  }

  const allowed = orderActionList(order, 'allowedActions', [order.action]);
  const forbidden = orderActionList(order, 'forbiddenActions', []);
  const forbiddenSet = new Set(forbidden);
  const conflicts = allowed.filter((action) => forbiddenSet.has(action));
  if (conflicts.length > 0) {
    throw new Error(`lease conflict: action(s) present in both allowedActions and forbiddenActions: ${[...new Set(conflicts)].join(', ')}`);
  }

  const riskLevel = typeof order.riskLevel === 'string' && order.riskLevel.length > 0
    ? order.riskLevel
    : 'low';
  const requiresApproval = order.requiresApproval === true
    || order.requiresHumanApproval === true
    || APPROVAL_RISK_LEVELS.has(riskLevel.toLowerCase());

  return {
    lease: {
      id: leaseId,
      allowed,
      forbidden,
      targetProject: order.targetProject ?? null,
      riskLevel,
      requires_approval: requiresApproval,
    },
    hasHumanApproval: order.operatorApproved === true,
  };
}

function loadChain() {
  try {
    return fs.readFileSync(CHAIN_FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
function persistChain(chain) {
  fs.mkdirSync(path.dirname(CHAIN_FILE), { recursive: true });
  fs.writeFileSync(CHAIN_FILE, chain.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

// Gateway failures are execution gaps, not proof that the requested action
// itself failed. Preserve that distinction for every transport failure path.
export function unavailableBrainResult(order, reason = 'orangebrain_unavailable', detail = {}) {
  return {
    ok: false,
    status: 'needs_action',
    summary: `No executor completed ${order.action}; OrangeBrain is unavailable`,
    output: { stub: false, executed: false, echoed: order.payload ?? null },
    evidence: { execution: 'not_performed', reason, ...detail },
  };
}
// ASYNC pre-fetch against the real OpenAI-compatible gateway (Phase 2). The CLL
// awaits this BEFORE runOrder, then injects a sync executor returning the result.
async function fetchBrain(order, preflight = {}) {
  const url = resolveOrangeBrainUrl();
  const memoryContext = buildMemoryContext(preflight);
  // A successful child receipt is stronger evidence than a historical
  // transport failure. Synthesis still consults Cobra project truth, but does
  // not inherit resolved timeout text as a current blocker.
  const memoryBrief = buildModelMemoryBrief(memoryContext, {
    includeMistake: !['analyze.agent', 'synthesize.delegation'].includes(order.action),
  });
  const currentMediation = {
    schema: 'orange.current-mediation.v1',
    memory: preflight.mediation?.memory ? {
      consulted: preflight.mediation.memory.consulted === true,
      ok: preflight.mediation.memory.ok === true,
      source: preflight.mediation.memory.source || null,
      matches: preflight.mediation.memory.matches || 0,
      projectRecords: preflight.mediation.memory.project_records || 0,
    } : null,
    compression: preflight.mediation?.compression ? {
      consulted: preflight.mediation.compression.consulted === true,
      ok: preflight.mediation.compression.ok === true,
      lossless: preflight.mediation.compression.lossless === true,
      ratio: preflight.mediation.compression.ratio || null,
      savingsBytes: preflight.mediation.compression.savings_bytes || 0,
      leastActionTier: preflight.mediation.compression.least_action_tier || null,
    } : null,
  };
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(180_000),
      body: JSON.stringify({
        model: process.env.ORANGE5_MODEL || 'orange-navigator',
        ae_response_contract: 'orange.report.v1',
        ae_order_id: order.orderId ?? order.id ?? null,
        messages: [
          ...(memoryContext.mistakeCount || memoryContext.epistemicPrior || memoryContext.project?.records?.length
            ? [{ role: 'system', content: `ORANGE MEMORY BRIEF\n${JSON.stringify(memoryBrief)}` }]
            : []),
          { role: 'system', content: `CURRENT ORDER MEDIATION EVIDENCE\n${JSON.stringify(currentMediation)}` },
          { role: 'user', content: JSON.stringify(order) },
        ],
        response_format: { type: 'json_object' },
        reasoning_effort: 'none',
        max_tokens: Math.max(64, Math.min(512, Number(process.env.ORANGE5_MAX_TOKENS) || 192)),
        temperature: 0,
      }),
    });
    if (!res.ok) return unavailableBrainResult(order, 'orangebrain_http_error', { httpStatus: res.status });
    const j = await res.json();
    const content = j.choices?.[0]?.message?.content ?? j;
    let output = content;
    if (typeof content === 'string') {
      try { output = JSON.parse(content); } catch { /* Preserve non-JSON model output honestly. */ }
    }
    return classifyModelExecution(order, {
      ok: true,
      summary: /^(query|ask|explain|analyze|plan|synthesize)\./.test(String(order.action || ''))
        ? `OrangeBrain produced a cognitive report for ${order.action}`
        : `OrangeBrain produced guidance for ${order.action}; execution is not yet proven`,
      output,
      lane: j.ae_lane ?? 'navigator',
      model: j.model ?? null,
      host: j.ae_host ?? null,
      evidence: {
        gateway: url,
        lane: j.ae_lane ?? 'navigator',
        model: j.model ?? null,
        host: j.ae_host ?? null,
        modelAuthority: {
          executionPerformed: j.ae_execution_performed === true,
          evidenceAuthority: j.ae_evidence_authority ?? null,
          evidencePolicy: j.ae_evidence_policy ?? null,
          evidenceFidelity: j.ae_evidence_fidelity ?? null,
          suppliedEvidenceCount: j.ae_supplied_evidence_count ?? 0,
          suppliedEvidenceSha256: j.ae_supplied_evidence_sha256 ?? null,
          modelEvidenceSha256: j.ae_model_evidence_sha256 ?? null,
          receiptAuthority: j.ae_receipt_authority ?? null,
        },
        memoryContext: memoryContextEvidence(memoryContext),
      },
    });
  } catch (e) {
    return unavailableBrainResult(order, 'orangebrain_transport_error', { error: e?.message || String(e) });
  }
}

async function main() {
  if (hasFlag('--health')) {
    const brainUrl = resolveOrangeBrainUrl();
    let brain;
    try {
      const response = await fetch(`${brainUrl}/healthz`, {
        signal: AbortSignal.timeout(20_000),
      });
      const detail = await response.json().catch(() => null);
      brain = {
        status: response.ok && detail?.primary?.live ? 'live' : 'degraded',
        live: Boolean(response.ok && detail?.primary?.live),
        url: brainUrl,
        source: process.env.ORANGE5_ORANGEBRAIN_URL?.trim() ? 'environment' : 'canonical_default',
        version: detail?.version ?? null,
        primary: detail?.primary ?? null,
      };
    } catch (error) {
      brain = { status: 'unreachable', live: false, url: brainUrl, error: error?.message ?? String(error) };
    }
    console.log(JSON.stringify({
      ok: brain.live,
      orange5: 'spine-cli',
      phase: brain.live ? 'OrangeBrain live' : 'OrangeBrain attention required',
      orangebrain: brain,
      receipts_persisted: loadChain().length,
      flux_root: FLUX_ROOT,
    }, null, 2));
    return;
  }

  // Read order from a file, an argument, or stdin. --order-file is the safest
  // cross-shell form on Windows because PowerShell 5 can strip embedded quotes
  // while forwarding a JSON argument to native executables.
  const orderFile = argVal('--order-file');
  let orderRaw;
  if (orderFile) {
    try {
      orderRaw = fs.readFileSync(path.resolve(orderFile), 'utf8').trim();
    } catch (error) {
      console.error(`spine-cli: cannot read order file ${orderFile}: ${error.message}`);
      process.exit(2);
    }
  }
  if (!orderRaw) orderRaw = argVal('--order');
  if (!orderRaw && !process.stdin.isTTY) orderRaw = fs.readFileSync(0, 'utf8').trim();
  if (!orderRaw) { console.error('spine-cli: provide --order-file order.json, --order JSON, or pipe JSON on stdin. Try --health.'); process.exit(2); }

  let order;
  try { order = JSON.parse(orderRaw); } catch (e) { console.error('spine-cli: order is not valid JSON: ' + e.message); process.exit(2); }

  let governance;
  try {
    governance = compileCliGovernance(order);
  } catch (error) {
    console.error(`spine-cli: ${error.message}`);
    process.exit(2);
  }

  const dryRun = hasFlag('--dry-run');
  const seed = argVal('--seed');
  const chain = dryRun ? [] : loadChain();
  let continuum = null;
  let solarWave = null;
  if (!dryRun) {
    try {
      solarWave = beginSolarWave(order);
      continuum = await beginOperationalContinuum(order, {
        projectRoot: process.env.ORANGE5_PROJECT_ROOT || process.cwd(),
        workspaceRoots: [process.env.ORANGE5_PROJECT_ROOT || process.cwd()],
      });
    } catch (error) {
      continuum = { error: error?.message || String(error) };
    }
  }

  // Phase 2: if the gateway is live, do the async call FIRST, then inject a sync executor.
  let pre = null;
  let adversarialEvidence = null;
  if (!dryRun) {
    const preflight = runOrder(order, {
      dryRun: true,
      seed,
      receiptChain: chain,
      fluxRoot: FLUX_ROOT,
      lease: { ...governance.lease, id: 'spine-cli-preflight' },
      hasHumanApproval: governance.hasHumanApproval,
    });
    pre = await executeOperationalAction(order);
    if (!pre) pre = await fetchBrain(order, preflight);
    if (preflight.topology?.adversarialRequired === true) {
      adversarialEvidence = deterministicAdversarialAttestation(order, pre)
        || await runGatewayAdversarialPass({
          url: resolveOrangeBrainUrl(), order, primaryResult: pre,
        });
      pre = { ...pre, evidence: { ...(pre?.evidence || {}), adversarial: adversarialEvidence } };
    }
  }
  const executor = (o) => (pre ? pre : unavailableBrainResult(o));

  const result = runOrder(order, {
    dryRun, seed, receiptChain: chain, fluxRoot: FLUX_ROOT, executor,
    lease: governance.lease,
    hasHumanApproval: governance.hasHumanApproval,
    // v2 — epistemic enforcement is opt-in; the score is recorded either way.
    epistemicMode: hasFlag('--advisory') ? 'advisory' : (hasFlag('--strict') ? 'strict' : undefined),
    // MoE attribution. Two fields; they turn the chain into the gate's training set.
    expertId: argVal('--expert') ?? process.env.ORANGE5_EXPERT_ID ?? null,
    campaignId: argVal('--campaign') ?? null,
    parentReceipt: argVal('--parent') != null ? Number(argVal('--parent')) : null,
    adversarialEvidence,
  });
  if (!dryRun && solarWave) {
    try { routeSolarWave(solarWave, result.plan?.route || result.route || { lane: result.lane }); }
    catch (error) { solarWave.error = error?.message || String(error); }
  }

  let lesson = null;
  let learning = null;
  if (!dryRun && result.receipt) {
    persistChain(chain);
    if (hasFlag('--learn')) {
      const lc = closeLoop(result, {
        fluxRoot: FLUX_ROOT,
        cobraUrl: process.env.AE_COBRA_BASE || 'http://127.0.0.1:7419',
        requireCobra: true,
      });
      lesson = lc.lesson;
      const learned = await lc.ingestDone;
      learning = {
        requested: true,
        ingested: learned?.accepted === true || Boolean(learned?.hash),
        transport: learned?.transport || (learned?.hash ? 'flux-direct-fallback' : null),
        memoryId: learned?.id || learned?.hash?.slice(0, 12) || null,
        error: learned?.ok === false ? learned.note || 'learning ingest failed' : null,
      };
    }
  }

  let continuumResult = null;
  if (!dryRun) {
    if (continuum?.run) continuumResult = await settleOperationalContinuum(continuum, result);
    else continuumResult = { ok: false, error: continuum?.error || 'operational continuum did not start' };
    if (solarWave && !solarWave.error) {
      try { solarWave.terminal = settleSolarWave(solarWave, result); }
      catch (error) { solarWave.error = error?.message || String(error); }
    }
  }

  const out = {
    status: result.status, lane: result.lane,
    plan: dryRun ? result.plan : undefined,
    report: result.report, receipt: result.receipt ? { receipt_id: result.receipt.receipt_id, hash: result.receipt.hash, seq: result.receipt.seq } : null,
    mistakes_surfaced: result.mistakes?.length ?? 0,
    mediation: result.mediation ?? result.plan?.mediation ?? null,
    lesson: lesson?.warning ?? null,
    learning,
    // v2 surface — what shape of thought was demanded, and how sound the claim was
    topology: result.topology?.topology,
    adversarial_required: result.topology?.adversarialRequired || undefined,
    epistemic_score: result.receipt?.epistemic_score,
    epistemic_enforcement: hasFlag('--advisory') ? 'advisory_explicit' : 'topology_default',
    epistemic_blocks: result.epistemic?.blocks?.length ? result.epistemic.blocks.map(b => b.check) : undefined,
    prior_verdict: result.prior?.verdict !== 'NO_PRIOR' ? result.prior?.verdict : undefined,
    notes: result.notes?.length ? result.notes : undefined,
    build_run: continuumResult,
    solar_wave: solarWave ? {
      waveId: solarWave.waveId,
      terminal: solarWave.terminal?.state || null,
      residual: solarWave.terminal?.residual || null,
      conservation: solarWave.terminal?.conservation?.state || null,
      error: solarWave.error || null,
    } : null,
  };
  console.log(JSON.stringify(out, null, 2));
  if (!['ok', 'completed', 'ready', 'planned'].includes(result.status)) process.exit(1);
}

if (import.meta.main) {
  main().catch((e) => { console.error('spine-cli fatal: ' + (e?.stack || e)); process.exit(2); });
}
