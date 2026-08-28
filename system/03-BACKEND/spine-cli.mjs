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
//   bun 03-BACKEND/spine-cli.mjs staff list                     # all 50 AE Staff roles
//   bun 03-BACKEND/spine-cli.mjs staff crew --order-file order.json
//   bun 03-BACKEND/spine-cli.mjs staff health
//   bun 03-BACKEND/spine-cli.mjs staff order --order-file order.json
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

const STAFF_SUBCOMMANDS = new Map([
  ['list', 'list'], ['roster', 'list'],
  ['crew', 'crew'], ['compile', 'crew'],
  ['health', 'health'], ['status', 'health'],
  ['order', 'order'], ['submit', 'order'],
]);
const STAFF_FLAGS = new Map([
  ['--staff', 'list'], ['--staff-list', 'list'], ['--staff-roster', 'list'],
  ['--staff-crew', 'crew'], ['--compile-crew', 'crew'],
  ['--staff-health', 'health'], ['--staff-status', 'health'],
  ['--staff-order', 'order'], ['--submit-staff-order', 'order'],
]);

export function resolveStaffCliCommand(args = process.argv.slice(2)) {
  if (args[0] === 'staff') {
    const command = STAFF_SUBCOMMANDS.get(String(args[1] || '').toLowerCase());
    if (!command) throw new Error('staff command must be one of: list, crew, health, order');
    return command;
  }
  const matches = [...STAFF_FLAGS].filter(([flag]) => args.includes(flag));
  if (matches.length > 1) throw new Error('provide exactly one AE Staff command');
  return matches[0]?.[1] ?? null;
}

function assertStaffOrder(order) {
  if (!order || typeof order !== 'object' || Array.isArray(order)) throw new Error('staff order must be a JSON object');
  if (typeof order.action !== 'string' || !order.action.trim()) throw new Error('staff order.action must be a non-empty string');
  return order;
}

function explicitStaffRoles(...sources) {
  const roles = [];
  for (const source of sources.filter(Boolean)) {
    for (const field of ['staffRoles', 'targetRoles']) {
      if (field in source && (!Array.isArray(source[field]) || !source[field].every((role) => typeof role === 'string' && role.trim()))) {
        throw new Error(`${field} must be an array of non-empty role ids`);
      }
      roles.push(...(source[field] || []).map((role) => role.trim()));
    }
  }
  return [...new Set(roles)];
}

export async function listAeStaff({ loadRoster, staffClient, createClient } = {}) {
  if (loadRoster) {
    const roster = loadRoster();
    return {
      schema: 'orange.ae-staff-list.v1',
      ok: roster.roles.length === 50,
      transport: 'local-doctrine',
      product: roster.organization?.productName || 'AE Staff',
      roleCount: roster.roles.length,
      organization: roster.organization,
      roles: roster.roles,
    };
  }
  let client = staffClient;
  if (!client) {
    const factory = createClient || (await import('./orange5-brain-mcp-server.mjs')).createAeStaffMcpClient;
    client = factory();
  }
  const roster = await client.list();
  return {
    schema: 'orange.ae-staff-list.v1',
    ok: roster.roles.length === 50,
    transport: 'ae-phase',
    product: 'AE Staff - Powered by Hermes',
    roleCount: roster.roles.length,
    organization: null,
    roles: roster.roles,
  };
}

export async function compileAeStaffCrew(order, { compileCrew } = {}) {
  const normalized = assertStaffOrder(order);
  const compile = compileCrew || (await import('../08-HERMES/src/staff-router.mjs')).compileStaffCrew;
  return compile(normalized);
}

export async function getAeStaffHealth({ timeoutMs, staffClient, createClient } = {}) {
  const started = Date.now();
  try {
    let client = staffClient;
    if (!client) {
      const factory = createClient || (await import('./orange5-brain-mcp-server.mjs')).createAeStaffMcpClient;
      client = factory({
        readTimeoutMs: Number(timeoutMs || process.env.ORANGE5_AE_STAFF_HEALTH_TIMEOUT_MS || 5_000),
      });
    }
    const service = await client.health();
    const ok = Boolean(service?.ok === true && service?.roleCount === 50);
    return {
      schema: 'orange.ae-staff-health-report.v1',
      ok,
      status: service?.status || 'DEGRADED',
      transport: 'ae-phase',
      endpoint: 'ae-phase://codexa/ae-staff',
      httpStatus: null,
      latencyMs: Date.now() - started,
      roleCount: service?.roleCount ?? null,
      readyCount: service?.readyCount ?? null,
      runningCount: service?.runningCount ?? null,
      queuedCount: service?.queuedCount ?? null,
      authenticated: service?.transport?.primary === 'ae-phase',
      service,
      error: ok ? null : (service?.error || 'AE Staff health did not prove 50 live roles'),
    };
  } catch (error) {
    const message = error?.message || String(error);
    const httpStatus = Number(/HTTP (\d{3})/.exec(message)?.[1] || 0);
    return {
      schema: 'orange.ae-staff-health-report.v1',
      ok: false,
      status: /timeout|unreachable/i.test(message) ? 'UNREACHABLE' : 'DEGRADED',
      transport: 'ae-phase',
      endpoint: 'ae-phase://codexa/ae-staff',
      httpStatus,
      latencyMs: Date.now() - started,
      roleCount: null,
      readyCount: null,
      runningCount: null,
      queuedCount: null,
      authenticated: false,
      service: null,
      error: message,
    };
  }
}

export async function submitExplicitStaffOrder(input, { staffClient, createClient } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('staff order must be a JSON object');
  const envelope = Object.prototype.hasOwnProperty.call(input, 'order') ? input : { order: input };
  const order = assertStaffOrder(envelope.order);
  const targetRoles = explicitStaffRoles(envelope, order);
  if (targetRoles.length === 0) throw new Error('staff order requires explicit staffRoles or targetRoles');
  if (targetRoles.length > 50) throw new Error('staff order may target at most 50 roles');
  let client = staffClient;
  if (!client) {
    const factory = createClient || (await import('./orange5-brain-mcp-server.mjs')).createAeStaffMcpClient;
    client = factory();
  }
  const args = { order, targetRoles };
  for (const field of ['correlationId', 'commitments', 'sourceRefs']) {
    const value = envelope[field] ?? order[field];
    if (value !== undefined) args[field] = value;
  }
  const result = await client.order(args);
  return {
    schema: 'orange.ae-staff-order-result.v1',
    ok: result?.ok === true,
    path: 'ae_staff_order',
    targetRoles,
    result,
  };
}

function staffOrderFromCli(command, args = process.argv.slice(2)) {
  const valueAfter = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const orderFile = valueAfter('--order-file');
  let orderRaw;
  if (orderFile) {
    try {
      orderRaw = fs.readFileSync(path.resolve(orderFile), 'utf8').trim();
    } catch (error) {
      throw new Error(`cannot read order file ${orderFile}: ${error.message}`);
    }
  }
  if (!orderRaw) orderRaw = valueAfter('--order');
  if (!orderRaw && args[0] === 'staff' && ['crew', 'order'].includes(command)) {
    const candidate = args[2];
    if (candidate && !candidate.startsWith('--')) orderRaw = candidate;
  }
  if (!orderRaw) {
    const flag = [...STAFF_FLAGS].find(([candidateFlag, mapped]) => mapped === command && args.includes(candidateFlag))?.[0];
    const index = flag ? args.indexOf(flag) : -1;
    const candidate = index >= 0 ? args[index + 1] : undefined;
    if (candidate && !candidate.startsWith('--')) orderRaw = candidate;
  }
  if (!orderRaw && !process.stdin.isTTY) orderRaw = fs.readFileSync(0, 'utf8').trim();
  if (!orderRaw) throw new Error(`staff ${command} requires --order-file, --order JSON, positional JSON, or piped JSON`);
  try { return JSON.parse(orderRaw); }
  catch (error) { throw new Error(`staff order is not valid JSON: ${error.message}`); }
}

async function runStaffCliCommand(command) {
  if (command === 'list') return await listAeStaff();
  if (command === 'health') return await getAeStaffHealth();
  const order = staffOrderFromCli(command);
  if (command === 'crew') return await compileAeStaffCrew(order);
  return await submitExplicitStaffOrder(order);
}

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
  let staffCommand;
  try {
    staffCommand = resolveStaffCliCommand();
  } catch (error) {
    console.log(JSON.stringify({
      schema: 'orange.ae-staff-cli-error.v1',
      ok: false,
      command: process.argv.slice(2, 4).join(' '),
      error: error?.message || String(error),
    }, null, 2));
    process.exitCode = 2;
    return;
  }
  if (staffCommand) {
    try {
      const output = await runStaffCliCommand(staffCommand);
      console.log(JSON.stringify(output, null, 2));
      if (output?.ok === false) process.exitCode = 1;
    } catch (error) {
      console.log(JSON.stringify({
        schema: 'orange.ae-staff-cli-error.v1',
        ok: false,
        command: staffCommand,
        error: error?.message || String(error),
      }, null, 2));
      process.exitCode = 2;
    }
    return;
  }

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
