import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compileDelegation } from "./navigator-kernel.mjs";
import { collectResearchEvidence } from "./research-capabilities.mjs";
import { getCurrentAwareness, shouldScoutIntent } from "./current-awareness.mjs";
import { discoverComputeFabric } from "./compute-fabric.mjs";
import { executeGovernedTool } from "./hermes-effector.mjs";
import { readProjectLock } from "./project-lock.mjs";
import { writeChainedJsonReceipt } from "../10-RECEIPTS/tools/json-receipt-chain.mjs";
import { inspectSwarm } from "../08-HERMES/product-integration/scripts/swarm-sentinel.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BRAIN_URL = (process.env.ORANGE5_ORANGEBRAIN_URL || "http://127.0.0.1:1337").replace(/\/$/, "");
export const CHAIN_FILE = path.join(ROOT, "10-RECEIPTS", "spine-chain.jsonl");

async function fetchJson(url, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { ok: response.ok, status: response.status, latencyMs: Date.now() - started, body };
  } catch (error) {
    return { ok: false, status: 0, latencyMs: Date.now() - started, error: error?.message || String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function tcp(host, port, timeoutMs = 1200) {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ready) => { socket.destroy(); resolve(ready); };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

export async function healthSnapshot({ discoverFabric = discoverComputeFabric, fetchBrain = fetchJson } = {}) {
  const [brain, fabric, legacyCommand, legacyModelAdapter] = await Promise.all([
    fetchBrain(`${BRAIN_URL}/healthz`, {}, 8_000),
    discoverFabric({ timeoutMs: 900, persist: false }),
    tcp("127.0.0.1", 8787),
    tcp("127.0.0.1", 8797)
  ]);
  const primary = brain.body && typeof brain.body === "object" ? brain.body.primary : null;
  const operational = Boolean(brain.ok && primary?.live);
  const project = readProjectLock();
  const fabricRail = fabric?.selections?.rail;
  return {
    schema: "orange.health.v1",
    product: "Orange",
    release: "OrangeFive",
    status: operational ? "OPERATIONAL" : "DEGRADED",
    operational,
    generatedAt: new Date().toISOString(),
    gateway: {
      url: BRAIN_URL,
      ready: brain.ok,
      latencyMs: brain.latencyMs,
      version: brain.body?.version ?? null
    },
    activeBrain: primary ? {
      tier: primary.tier ?? null,
      model: primary.model ?? null,
      host: primary.host ?? null,
      live: Boolean(primary.live)
    } : null,
    reflex: { ready: true, runtime: "bun-deterministic-router", modelResident: false },
    fabric,
    codexa: {
      host: fabricRail?.host || null,
      railPort: fabricRail?.url ? Number(new URL(fabricRail.url).port || 80) : null,
      reachable: Boolean(fabricRail),
      authorized: fabricRail?.authorized === true,
      executable: Boolean(fabricRail && fabricRail.authorized === true),
      nodeId: fabricRail?.nodeId || null,
    },
    activeProject: project?.active ? {
      name: project.project?.name || null,
      root: project.project?.root || null,
      goal: project.goal || null,
      lockSha256: project.sha256 || null,
    } : null,
    compatibility: {
      legacyCommandPort8787: legacyCommand,
      legacyModelAdapter8797: legacyModelAdapter,
      requiredForHeadless: false
    },
    receipts: { persisted: readReceipts(1).total, path: CHAIN_FILE },
    blockers: [
      ...(!operational ? ["OrangeBrain gateway did not prove a live primary model."] : []),
      ...(!fabricRail ? ["Codexa command rail is unavailable; Orange continues in local-only mode."] : []),
      ...(fabricRail && fabricRail.authorized !== true ? ["Codexa command rail is reachable but not authorized for execution."] : []),
      ...(fabric?.operatorDecisionRequired ? [fabric.decisionReason] : []),
    ]
  };
}

function normalizeOrder(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("order must be an object");
  }
  if (typeof input.action !== "string" || !input.action.trim()) {
    throw new TypeError("order.action must be a non-empty string");
  }
  return {
    action: input.action.trim(),
    payload: input.payload && typeof input.payload === "object" ? input.payload : {},
    ...input
  };
}

export async function executeOrder(input, { dryRun = false, learn = false, model = null, maxTokens = null } = {}) {
  const order = normalizeOrder(input);
  const args = [path.join(ROOT, "03-BACKEND", "spine-cli.mjs"), "--order", JSON.stringify(order)];
  if (dryRun) args.push("--dry-run");
  if (learn) args.push("--learn");
  const result = await spawnJson(process.execPath, args, {
    ...process.env,
    ORANGE5_ORANGEBRAIN_URL: BRAIN_URL,
    ORANGE5_MODEL: model || process.env.ORANGE5_MODEL || "orange-auto",
    ...(maxTokens ? { ORANGE5_MAX_TOKENS: String(maxTokens) } : {}),
  }, 200_000);
  return {
    schema: "orange.headless.order-result.v1",
    ok: result.code === 0,
    exitCode: result.code,
    order,
    result: result.json,
    stderr: result.stderr || undefined
  };
}

export async function chat(message, { model = "orange-auto", maxTokens = 512, execute = executeOrder } = {}) {
  if (typeof message !== "string" || !message.trim()) throw new TypeError("message must be non-empty text");
  const started = Date.now();
  const execution = await execute({
    action: "query.chat",
    intent: message.trim(),
    payload: { message: message.trim(), maxTokens },
    orderId: `chat-${randomUUID()}`,
    riskLevel: "low",
    requiresReceipt: true,
  }, { learn: true, model });
  const spine = execution.result || {};
  const report = spine.report || null;
  return {
    schema: "orange.headless.chat-result.v1",
    ok: execution.ok,
    status: spine.status || (execution.ok ? "completed" : "error"),
    latencyMs: Date.now() - started,
    model: report?.model ?? model,
    lane: report?.lane ?? null,
    host: report?.host ?? null,
    content: report?.output ?? null,
    receipt: spine.receipt ?? null,
    learning: spine.learning ?? null,
    memoryContext: report?.memory_context ?? null,
    report,
    error: execution.ok ? undefined : (execution.stderr || report || spine)
  };
}

export function readReceipts(limit = 10) {
  let rows = [];
  try {
    rows = fs.readFileSync(CHAIN_FILE, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch { /* Empty ledger is represented honestly. */ }
  const count = Math.max(1, Math.min(100, Number(limit) || 10));
  return { schema: "orange.receipts.v1", total: rows.length, receipts: rows.slice(-count).reverse() };
}

export async function executeDelegation(args = {}, deps = {}) {
  const run = deps.executeOrder || executeOrder;
  const hermes = deps.hermes || createHermesDelegationClient(deps.fetchFn || globalThis.fetch);
  const sourceOrder = args.order ?? args;
  const boundedOrder = args.maxAgents == null ? sourceOrder : { ...sourceOrder, maxAgents: args.maxAgents };
  const plan = compileDelegation(boundedOrder, args.flowState || {});
  if (!args.execute) return { ...plan, status: "PLANNED_NOT_EXECUTED", reports: [], synthesis: null };
  const agentModel = args.agentModel || "orange-navigator";
  const synthesisModel = args.synthesisModel || "orange-navigator";
  const actor = "orangefive-navigator";
  const targetProject = sourceOrder.targetProject || "OrangeFive";
  const riskLevel = sourceOrder.riskLevel || "medium";
  let parentEvidence = compactOrderEvidence(sourceOrder);
  let parentPacket = { ...compactParentOrder(sourceOrder), workObject: plan.workObject };
  const governance = {
    childOrdersMediated: true,
    synthesisMediated: false,
    parentExecutionMediated: false,
    parentExecution: null,
    receiptRequired: true,
    executionMode: plan.hermesLease.executionMode,
    agentModel,
    synthesisModel,
    hermesLeaseId: null,
    hermesAuthorizedActions: 0,
    hermesGateResults: [],
    hermesLeaseRevoked: false,
    swarmGate: plan.swarmGate || null,
    swarmSentinel: null,
    researchEvidence: null,
    currentAwareness: null,
    wave3Kernel: plan.workObject?.wave3Kernel || null,
  };

  const reports = [];
  let synthesis = null;
  let lease = null;
  let failure = null;
  let researchEvidence = null;
  if (["filesystem.read", "filesystem.list"].includes(sourceOrder.action)) {
    const governedTool = deps.executeGovernedTool || executeGovernedTool;
    try {
      const executed = await governedTool({
        action: sourceOrder.action,
        orderId: `${plan.orderId}:source-execution`,
        actor,
        path: sourceOrder.payload?.path || ".",
        maxBytes: sourceOrder.payload?.maxBytes,
        limit: sourceOrder.payload?.limit,
      }, {
        projectRoot: ROOT,
        fetchFn: deps.fetchFn || globalThis.fetch,
      });
      const result = executed.evidence?.find((item) => item.type === "execution_result") || {};
      const receipt = executed.evidence?.find((item) => item.type === "receipt") || {};
      const excerpt = String(result.content || result.entries?.map((item) => item.name).join(", ") || "")
        .replace(/\s+/g, " ").trim().slice(0, 140);
      // Keep the immutable provenance token short enough for exact model echo.
      // The signed source content remains in governedExecution.excerpt, so the
      // worker can reason over it without being asked to reproduce it as proof.
      const executionEvidence = `governed:${sourceOrder.action}:${String(result.result_hash || "").slice(0, 16)}`;
      parentEvidence = mergeEvidence(parentEvidence, [executionEvidence]);
      parentPacket = {
        ...compactParentOrder({ ...sourceOrder, evidence: parentEvidence }),
        governedExecution: {
          action: sourceOrder.action,
          resultHash: result.result_hash || null,
          receiptSha256: receipt.sha256 || null,
          excerpt,
        },
      };
      governance.parentExecutionMediated = true;
      governance.parentExecution = {
        status: executed.status,
        action: sourceOrder.action,
        resultHash: result.result_hash || null,
        receiptPath: executed.receiptPath || null,
        receiptSha256: receipt.sha256 || null,
      };
    } catch (error) {
      return {
        ...plan,
        status: "DELEGATION_ATTENTION",
        governance,
        reports,
        synthesis,
        blockers: [`governed parent execution failed: ${error?.message || String(error)}`],
      };
    }
  }
  const sourceIntent = sourceOrder.intent || sourceOrder.payload?.intent || sourceOrder.action;
  const hardResearch = plan.littleNavigator.department === "AE2_RESEARCH";
  const awarenessNeeded = hardResearch || shouldScoutIntent(sourceIntent);
  if (awarenessNeeded) {
    const collect = hardResearch
      ? (deps.researchCollector || ((input) => collectResearchEvidence(input, { fetchFn: deps.researchFetchFn || globalThis.fetch })))
      : (deps.currentAwarenessRunner || ((input) => getCurrentAwareness(input, { collectorDeps: { fetchFn: deps.researchFetchFn || globalThis.fetch } })));
    try {
      const collected = await collect({
        query: sourceIntent,
        delegationId: plan.delegationId,
      });
      researchEvidence = hardResearch ? collected : awarenessAsResearchEvidence(collected);
      governance.researchEvidence = {
        ok: researchEvidence.ok === true,
        status: researchEvidence.status,
        sourceCount: researchEvidence.sourceCount || 0,
        artifactPath: researchEvidence.artifactPath || null,
        sha256: researchEvidence.sha256 || null,
      };
      governance.currentAwareness = hardResearch ? null : {
        status: collected.status || null,
        sourceCount: collected.sourceCount || 0,
        cacheHit: collected.cacheHit === true,
        generatedAt: collected.generatedAt || null,
        sha256: collected.sha256 || null,
        opportunities: (collected.opportunities || []).slice(0, 3),
      };
    } catch (error) {
      governance.researchEvidence = { ok: false, status: "COLLECTOR_ERROR", sourceCount: 0, artifactPath: null, sha256: null };
      governance.currentAwareness = {
        status: hardResearch ? 'DIRECT_RESEARCH_ERROR' : 'SCOUT_ERROR',
        sourceCount: 0,
        cacheHit: false,
        errors: [error?.message || String(error)],
      };
    }
    if (hardResearch && (!researchEvidence?.ok || !researchEvidence?.sourceCount)) {
      const fallback = deps.currentAwarenessRunner
        || ((input) => getCurrentAwareness(input, { collectorDeps: { fetchFn: deps.researchFetchFn || globalThis.fetch } }));
      try {
        const awareness = await fallback({ query: sourceIntent, force: false });
        const recovered = awarenessAsResearchEvidence(awareness);
        governance.currentAwareness = {
          status: awareness.status || null,
          sourceCount: awareness.sourceCount || recovered.sourceCount || 0,
          cacheHit: awareness.cacheHit === true,
          generatedAt: awareness.generatedAt || null,
          sha256: awareness.sha256 || null,
          recoveryFor: 'AE2_RESEARCH',
        };
        if (recovered.ok && recovered.sourceCount > 0) {
          researchEvidence = recovered;
          governance.researchEvidence = {
            ok: true,
            status: recovered.status,
            sourceCount: recovered.sourceCount,
            artifactPath: recovered.artifactPath || null,
            sha256: recovered.sha256 || null,
            recoveredFromCurrentAwareness: true,
          };
        }
      } catch (error) {
        governance.currentAwareness = {
          status: 'SCOUT_ERROR',
          sourceCount: 0,
          cacheHit: false,
          recoveryFor: 'AE2_RESEARCH',
          errors: [error?.message || String(error)],
        };
      }
    }
    if (hardResearch && (!researchEvidence?.ok || !researchEvidence?.sourceCount)) {
      return {
        ...plan,
        status: "DELEGATION_ATTENTION",
        governance,
        reports,
        synthesis,
        blockers: ["research halted because no source evidence was collected"],
      };
    }
  }
  try {
    lease = await hermes.mint({
      actor,
      allowed: ["analyze.agent", "synthesize.delegation"],
      forbidden: plan.hermesLease.forbiddenActions,
      targetProject,
      riskLevel,
      ttl_ms: 600_000,
      requires_approval: false,
      meta: {
        delegationId: plan.delegationId,
        orderId: plan.orderId,
        wave3Kernel: plan.workObject?.wave3Kernel || null,
      },
    });
    governance.hermesLeaseId = lease.id;

    const workerWidth = Math.max(1, Number(plan.hermesLease.maxConcurrentAgents) || 1);
    const agentWaves = [];
    for (let index = 0; index < plan.littleNavigator.agents.length; index += workerWidth) {
      agentWaves.push(plan.littleNavigator.agents.slice(index, index + workerWidth));
    }
    const sentinelPlan = {
      executionWaves: agentWaves.map((wave, index) => ({
        index,
        workers: wave.map((agent) => ({ id: `${plan.orderId}:${agent}` })),
      })),
    };
    const sentinelReports = [];

    const executeAgent = async (agent) => {
      const startedAt = new Date().toISOString();
      const order = {
        action: "analyze.agent",
        intent: governance.parentExecutionMediated
          ? `${agent} evaluates the completed governed parent action: ${sourceOrder.intent || sourceOrder.action}. Use payload.parentOrder.governedExecution.excerpt as source content, preserve supplied evidence exactly, and return completed unless a concrete source-content gap remains.`
          : `${agent} independently evaluates: ${sourceOrder.intent || sourceOrder.action}`,
        targetProject,
        payload: {
          parentOrder: parentPacket,
          agent,
          delegationId: plan.delegationId,
          allowedTools: plan.littleNavigator.allowedTools,
          ...(researchEvidence?.ok ? { researchEvidence: compactResearchEvidence(researchEvidence) } : {}),
        },
        ...((parentEvidence.length || researchEvidence?.ok)
          ? { evidence: mergeEvidence(parentEvidence, researchEvidence?.evidenceRefs) }
          : {}),
        orderId: `${plan.orderId}:${agent}`,
        allowedActions: ["analyze.agent"],
        forbiddenActions: plan.hermesLease.forbiddenActions,
        riskLevel,
        wave3Kernel: plan.workObject?.wave3Kernel || null,
        requiresReceipt: true,
      };
      const authorization = await hermes.authorize({ lease, actor, order });
      governance.hermesAuthorizedActions++;
      governance.hermesGateResults.push(summarizeHermesAuthorization(order.orderId, authorization));
      const completed = await run(order, { learn: true, model: agentModel, maxTokens: 256 });
      const endedAt = new Date().toISOString();
      const report = completed?.result?.report || completed?.result || {};
      sentinelReports.push({
        workerId: order.orderId,
        status: completed?.result?.status || (completed?.ok ? 'completed' : 'failed'),
        evidence: Array.isArray(report.evidence) ? report.evidence : (completed?.result?.receipt ? [completed.result.receipt] : []),
        confidence: Number(report.confidence ?? 0),
        blockers: Array.isArray(report.blockers) ? report.blockers : [],
        nextAction: report.nextAction || null,
        startedAt,
        endedAt,
      });
      return completed;
    };

    for (const wave of agentWaves) {
      const waveResults = await Promise.all(wave.map(executeAgent));
      reports.push(...waveResults);
      governance.swarmSentinel = inspectSwarm({
        plan: sentinelPlan,
        workerReports: sentinelReports,
        memoryUsedGb: Number(args.memoryUsedGb || 0),
        memoryBudgetGb: Number(args.liveMemoryBudgetGb || sourceOrder.liveMemoryBudgetGb || 50),
      });
      if (governance.swarmSentinel.status === 'SWARM_HALTED') {
        throw new Error(`SwarmSentinel halted delegation: ${governance.swarmSentinel.findings.map((finding) => finding.code).join(', ')}`);
      }
    }

    const childComplete = reports.every((item) => item.ok && completedStatus(item.result?.status));
    if (childComplete) {
      const order = {
        action: "synthesize.delegation",
        intent: `Synthesize the completed, receipt-backed ${plan.littleNavigator.department} specialist findings for: ${sourceOrder.intent || sourceOrder.action}. The governed parent action and every child report completed; preserve supplied evidence exactly and return completed unless the supplied reports contain a concrete contradiction.`,
        targetProject,
        payload: {
          parentOrder: parentPacket,
          delegationId: plan.delegationId,
          department: plan.littleNavigator.department,
          childEvidence: reports.map((item, index) => compactChildEvidence(
            plan.littleNavigator.agents[index], item.result,
          )),
          ...(researchEvidence?.ok ? { researchEvidence: compactResearchEvidence(researchEvidence) } : {}),
        },
        ...((parentEvidence.length || researchEvidence?.ok)
          ? { evidence: mergeEvidence(parentEvidence, researchEvidence?.evidenceRefs) }
          : {}),
        orderId: `${plan.orderId}:synthesis`,
        allowedActions: ["synthesize.delegation"],
        forbiddenActions: plan.hermesLease.forbiddenActions,
        riskLevel,
        wave3Kernel: plan.workObject?.wave3Kernel || null,
        requiresReceipt: true,
        parentDelegationId: plan.delegationId,
      };
      const authorization = await hermes.authorize({ lease, actor, order });
      governance.hermesAuthorizedActions++;
      governance.hermesGateResults.push(summarizeHermesAuthorization(order.orderId, authorization));
      synthesis = await run(order, { learn: true, model: synthesisModel, maxTokens: 256 });
      governance.synthesisMediated = true;
    }
  } catch (error) {
    failure = error;
  } finally {
    if (lease?.id) {
      try {
        governance.hermesLeaseRevoked = await hermes.revoke(lease, actor);
      } catch (error) {
        governance.hermesRevokeError = error?.message || String(error);
      }
    }
  }
  const childComplete = reports.length === plan.littleNavigator.agents.length && reports.every((item) => item.ok && completedStatus(item.result?.status));
  const synthesisComplete = synthesis?.ok === true && completedStatus(synthesis.result?.status);
  const governedComplete = !failure && governance.hermesLeaseRevoked && governance.hermesAuthorizedActions === reports.length + (synthesis ? 1 : 0);
  return {
    ...plan,
    status: childComplete && synthesisComplete && governedComplete ? "DELEGATION_COMPLETE" : "DELEGATION_ATTENTION",
    governance,
    reports,
    synthesis,
    error: failure ? (failure?.message || String(failure)) : undefined,
  };
}

function createHermesDelegationClient(fetchFn) {
  const post = async (pathname, body) => {
    const response = await fetchFn(`${BRAIN_URL}${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    if (!response.ok || parsed?.ok === false) throw new Error(`Hermes ${pathname} returned ${response.status}: ${JSON.stringify(parsed)}`);
    return parsed?.data;
  };
  return {
    async mint(spec) {
      const data = await post("/v1/hermes/lease", spec);
      if (!data?.lease?.id) throw new Error("Hermes did not return a lease id");
      return data.lease;
    },
    async authorize({ lease, actor, order }) {
      const receiptPath = writeDelegationPreActionReceipt(order, actor, lease.id);
      const data = await post("/v1/hermes/action", {
        lease_id: lease.id,
        actor,
        action_verb: order.action,
        order: toHermesOrder(order),
        report: {
          schema: "orange.report.v1", orderId: order.orderId, status: "ready", confidence: 1,
          actionsTaken: [`prepared ${order.action}`], evidence: [], blockers: [],
          nextAction: `execute ${order.action} through canonical Orange spine`, receiptPath,
        },
        action: { kind: "cognitive_agent", verb: order.action, status: "ready", risk_level: order.riskLevel },
        receipt_path: receiptPath,
      });
      if (!data?.pass) throw new Error(`Hermes refused ${order.action}`);
      return data;
    },
    async revoke(lease, actor) {
      const data = await post(`/v1/hermes/lease/${encodeURIComponent(lease.id)}/revoke`, {
        actor, reason: "delegation completed or halted",
      });
      return data?.revoked === true;
    },
  };
}

export function toHermesOrder(order) {
  return {
    schema: "orange.order.v1",
    orderId: order.orderId,
    action: order.action,
    intent: order.intent,
    scope: order.targetProject,
    allowedActions: order.allowedActions,
    forbiddenActions: order.forbiddenActions,
    targetProject: order.targetProject,
    riskLevel: order.riskLevel,
    requiresReceipt: true,
    wave3Kernel: order.wave3Kernel || order.payload?.parentOrder?.workObject?.wave3Kernel || null,
    payload: order.payload && typeof order.payload === "object" ? order.payload : {},
    ...(Array.isArray(order.evidence) ? { evidence: order.evidence } : {}),
  };
}

function writeDelegationPreActionReceipt(order, actor, leaseId) {
  const safeId = order.orderId.replace(/[^A-Za-z0-9._-]/g, "_");
  const receiptDir = path.join(ROOT, "10-RECEIPTS", "orange5-build", "hermes-preaction");
  fs.mkdirSync(receiptDir, { recursive: true });
  const latestSequence = fs.readdirSync(receiptDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      const full = path.join(receiptDir, entry.name);
      try {
        const receipt = JSON.parse(fs.readFileSync(full, "utf8"));
        return receipt?.schema === "orange5.receipt.v0" && Number.isInteger(receipt.hash_chain)
          ? { sequence: receipt.hash_chain, mtime: fs.statSync(full).mtimeMs }
          : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)[0]?.sequence ?? 0;
  const receiptPath = path.join(receiptDir, `${safeId}-hermes-preaction.json`);
  writeChainedJsonReceipt(receiptPath, {
    schema: "orange5.receipt.v0",
    receipt_id: `${order.orderId}:hermes-preaction`,
    generated_at: new Date().toISOString(),
    actor,
    status: "pending",
    confidence: 1,
    hash_chain: latestSequence + 1,
    prior_receipt: null,
    lease_id: leaseId,
    action: order.action,
    wave3_kernel: order.wave3Kernel || order.payload?.parentOrder?.workObject?.wave3Kernel || null,
    note: "Pre-action receipt for Hermes LOOM authorization; execution evidence lands on the canonical spine.",
  });
  return receiptPath;
}

function summarizeHermesAuthorization(orderId, authorization) {
  return {
    orderId,
    pass: authorization?.pass === true,
    misfit: authorization?.misfit?.decision || null,
    gates: Array.isArray(authorization?.results)
      ? authorization.results.map((gate) => ({ id: gate.id, pass: gate.pass }))
      : [],
  };
}

function compactParentOrder(order = {}) {
  const payload = order.payload && typeof order.payload === 'object' ? order.payload : {};
  return {
    action: order.action,
    intent: order.intent || payload.intent || order.action,
    targetProject: order.targetProject || "OrangeFive",
    scope: order.scope || payload.scope || null,
    objective: order.objective || payload.objective || null,
    constraints: compactStrings(order.constraints || payload.constraints, 6, 180),
    evidence: compactOrderEvidence(order),
    riskLevel: order.riskLevel || "medium",
    allowedActions: Array.isArray(order.allowedActions) ? order.allowedActions.slice(0, 20) : [order.action],
    forbiddenActions: Array.isArray(order.forbiddenActions) ? order.forbiddenActions.slice(0, 20) : [],
  };
}

function compactStrings(values, maxItems, maxChars) {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .slice(0, maxItems)
    .map((value) => value.slice(0, maxChars));
}

function compactOrderEvidence(order = {}) {
  const payload = order.payload && typeof order.payload === 'object' ? order.payload : {};
  const values = Array.isArray(order.evidence)
    ? order.evidence
    : (Array.isArray(payload.evidence) ? payload.evidence : []);
  return compactStrings(values, 2, 96);
}

function mergeEvidence(primary = [], secondary = []) {
  return compactStrings([...(primary || []), ...(secondary || [])], 2, 96);
}

function compactChildEvidence(agent, result = {}) {
  const report = result?.report || {};
  const modelOutput = report.output && typeof report.output === 'object' ? report.output : {};
  return {
    agent,
    status: result?.status || null,
    summary: report.summary || modelOutput.nextAction || null,
    evidence: Array.isArray(modelOutput.evidence) ? modelOutput.evidence.slice(0, 3) : [],
    blockers: Array.isArray(modelOutput.blockers) ? modelOutput.blockers.slice(0, 3) : [],
    nextAction: modelOutput.nextAction || null,
    receipt: result?.receipt ? { receipt_id: result.receipt.receipt_id, hash: result.receipt.hash } : null,
  };
}

function compactResearchEvidence(evidence) {
  return {
    artifactPath: evidence.artifactPath,
    sha256: evidence.sha256,
    sourceCount: evidence.sourceCount,
    sources: evidence.sources.slice(0, 6).map((source) => ({
      provider: source.provider,
      title: source.title,
      url: source.url,
      summary: source.summary,
      updatedAt: source.updatedAt || null,
      license: source.license || null,
      lifecycle: source.lifecycle || 'BENCHMARK_REQUIRED',
    })),
  };
}

function awarenessAsResearchEvidence(awareness = {}) {
  const sources = (awareness.candidates || []).map((source) => ({
    provider: source.provider,
    title: source.title,
    url: source.url,
    summary: source.summary,
    updatedAt: source.updatedAt || null,
    license: source.license || null,
    lifecycle: source.lifecycle || 'BENCHMARK_REQUIRED',
  }));
  return {
    ok: sources.length > 0,
    status: awareness.status || (sources.length ? 'CURRENT_EVIDENCE_READY' : 'CURRENT_EVIDENCE_UNAVAILABLE'),
    sourceCount: sources.length,
    artifactPath: awareness.evidenceArtifactPath || null,
    sha256: awareness.sha256 || null,
    sources,
    evidenceRefs: sources.slice(0, 2).map((source) => `source:${source.provider}:${createHash('sha256').update(source.url).digest('hex').slice(0, 12)}:awareness:${String(awareness.sha256 || '').slice(0, 12)}`),
  };
}

function completedStatus(status) {
  return ["ok", "completed", "ready"].includes(status);
}

export async function dispatchTool(name, args = {}) {
  switch (name) {
    case "orange5_health": return await healthSnapshot();
    case "orange5_order": return await executeOrder(args.order ?? args, { dryRun: false, learn: args.learn !== false });
    case "orange5_route": return await executeOrder(args.order ?? args, { dryRun: true });
    case "orange5_chat": return await chat(args.message, { model: args.model, maxTokens: args.maxTokens });
    case "orange5_receipts": return readReceipts(args.limit);
    case "orange5_delegate": return await executeDelegation(args);
    default: throw new Error(`unknown OrangeFive tool: ${name}`);
  }
}

function spawnJson(command, args, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => { child.kill(); reject(new Error(`command timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      const text = Buffer.concat(stdout).toString("utf8").trim();
      let json = null;
      try { json = JSON.parse(text); } catch { json = { raw: text }; }
      resolve({ code: code ?? 1, json, stderr: Buffer.concat(stderr).toString("utf8").trim() });
    });
  });
}
