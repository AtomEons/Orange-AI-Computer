#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import path from "node:path";
import readline from "node:readline";
import { dispatchTool, executeOrder, healthSnapshot, readReceipts, ROOT } from "./orange5-headless-core.mjs";
import { sendLocalAEPhaseEnvelope, waitForAEPhaseEnvelope } from "./ae-phase-fabric.mjs";
import { executeGovernedTool } from "./hermes-effector.mjs";
import { executeBrowserWorkflow } from "./browser-mcp-effector.mjs";
import { McpTaskStore } from "./mcp-task-store.mjs";
import { dryRunRoute as planSuperstackLease, inventory as superstackInventory, loadManifest as loadSuperstackManifest, writeReceipt as writeSuperstackReceipt } from "../14-SUPERSTACK/captain-planet-governor.mjs";
import { appendPartyLineEvent, hydratePartyLine, readPartyLine } from "../04-CONTROL-PLANE/party-line/ledger.mjs";

export const SERVER = { name: "orangefive-brain", version: "1.3.0" };
export const CURRENT_PROTOCOL = "2026-07-28";
export const SUPPORTED_PROTOCOLS = [CURRENT_PROTOCOL, "2025-11-25", "2025-06-18"];
const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";
const TASK_EXTENSION = "io.modelcontextprotocol/tasks";
const TASKABLE_TOOLS = new Set(["orange5_order", "orange5_chat", "orange5_delegate", "orange5_execute", "orange5_browser", "orange5_model_lease", "ae_staff_order"]);
const TASK_STORE = new McpTaskStore();
const TASK_JOBS = new Map();
const WORKER_ID = `brain-mcp-${process.pid}`;
const SWARM_MCP_ORDERS = Object.freeze({
  orange5_swarmgate_plan: Object.freeze({
    action: "plan.swarm",
    intent: "Create a read-only Swarmgate schedule from supplied task metadata.",
  }),
  orange5_swarm_sentinel_inspect: Object.freeze({
    action: "inspect.swarm",
    intent: "Inspect supplied swarm reports with Swarm Sentinel.",
  }),
});
const AE_STAFF_MCP_TOOLS = new Set(["ae_staff_health", "ae_staff_list", "ae_staff_order"]);
const CURRENT_PROTOCOL_ONLY_TOOLS = new Set([...Object.keys(SWARM_MCP_ORDERS), ...AE_STAFF_MCP_TOOLS]);

const TOOLS = [
  tool("orange5_health", "Live OrangeFive gateway, brain, reflex, Codexa, and receipt health.", {}),
  tool("ae_staff_health", "Read live AE Staff reactor health through the authenticated AE Phase fabric.", {}),
  tool("ae_staff_list", "List the live AE Staff roster and role state through the authenticated AE Phase fabric.", {}),
  tool("ae_staff_order", "Dispatch one canonical orange.order.v1 to an explicit AE Staff crew and return validated orange.report.v1 results.", {
    order: {
      type: "object",
      additionalProperties: true,
      properties: {
        schema: { type: "string", const: "orange.order.v1" },
        orderId: { type: "string", minLength: 1 },
        action: { type: "string", minLength: 1 },
        intent: { type: "string" },
        targetProject: { type: "string" },
        requiresReceipt: { type: "boolean" }
      },
      required: ["schema", "orderId", "action"]
    },
    targetRoles: { type: "array", minItems: 1, maxItems: 50, uniqueItems: true, items: { type: "string", minLength: 1 } },
    correlationId: { type: "string" },
    commitments: { type: "array", items: { type: "string" } },
    sourceRefs: { type: "array", items: {} }
  }, ["order", "targetRoles"]),
  tool("orange5_order", "Execute a governed OrangeFive action through the canonical spine.", {
    order: { type: "object", description: "Order with action and payload." },
    learn: { type: "boolean", description: "Close the governed learning loop after successful execution." }
  }, ["order"]),
  tool("orange5_route", "Plan and route an OrangeFive order without executing or writing a receipt.", {
    order: { type: "object", description: "Order with action and payload." }
  }, ["order"]),
  tool("orange5_swarmgate_plan", "Plan read-only swarm execution waves through the canonical Hermes Swarmgate module and governed Orange order path.", {
    tasks: { type: "array", minItems: 1, items: { type: "object" } },
    liveMemoryBudgetGb: { type: "number", exclusiveMinimum: 0 },
    reservedSystemMemoryGb: { type: "number", minimum: 0 },
    maxImmediateWorkers: { type: "integer", minimum: 1 }
  }, ["tasks"]),
  tool("orange5_swarm_sentinel_inspect", "Inspect worker reports read-only through the canonical Hermes Swarm Sentinel module and governed Orange order path.", {
    plan: { type: "object", description: "A canonical orange5.swarmgate-plan.v1 plan." },
    workerReports: { type: "array", items: { type: "object" } },
    system: { type: "object", description: "Optional liveMemoryUsedGb and liveMemoryBudgetGb values." }
  }, ["plan", "workerReports"]),
  tool("orange5_chat", "Ask Orange through the least-action orange-auto model router.", {
    message: { type: "string" }, model: { type: "string", default: "orange-auto" }, maxTokens: { type: "integer", minimum: 1, maximum: 4096 }
  }, ["message"]),
  tool("orange5_receipts", "Read recent governed execution receipts.", {
    limit: { type: "integer", minimum: 1, maximum: 100, default: 10 }
  }),
  tool("orange5_party_line_read", "Read the shared disk-backed Orange operations room using a durable byte cursor.", {
    cursor: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
    detail: { type: "string", enum: ["quiet", "normal", "deep", "wire"], default: "normal" },
    projectId: { type: "string" }, actor: { type: "string" }, eventType: { type: "string" }, topic: { type: "string" }
  }),
  tool("orange5_party_line_post", "Publish one model, agent, tool, or operator event to the shared Orange operations room.", {
    summary: { type: "string", minLength: 1 }, body: { type: "string" }, projectId: { type: "string" }, topic: { type: "string" },
    eventType: { type: "string", enum: ["message", "order", "report", "decision", "tool", "receipt", "status", "blocker", "repair"] },
    actor: { type: "object" }, status: { type: "string" }, detail: { type: "object" }, sourceRefs: { type: "array", items: {} },
    tags: { type: "array", items: { type: "string" } }, correlationId: { type: "string" }, importance: { type: "number", minimum: 0, maximum: 1 }
  }, ["summary", "actor", "eventType"]),
  tool("orange5_party_line_hydrate", "Select a compact source-addressed Party Line workbench for the current question without replaying the transcript.", {
    query: { type: "string", minLength: 1 }, projectId: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 20, default: 8 }
  }, ["query"]),
  tool("orange5_superstack", "Read the live Captain Planet model library, running model, and 50 GiB lease ceiling.", {}),
  tool("orange5_model_lease", "Unload the current model and load exactly one Captain Planet specialist under the 50 GiB ceiling.", {
    role: { type: "string", description: "Captain Planet role name or exact model name." },
    operatorApproved: { type: "boolean", default: false }
  }, ["role"]),
  tool("orange5_delegate", "Compile a zero-resident-model Little Navigator and bounded Hermes agent lease; execute only when explicitly requested.", {
    order: { type: "object" }, execute: { type: "boolean", default: false }
  }, ["order"]),
  tool("orange5_execute", "Execute one real bounded filesystem or process action after Hermes authorization; returns hashed runtime evidence and a receipt.", {
    action: { type: "string", enum: ["filesystem.list", "filesystem.read", "process.run"] },
    projectRoot: { type: "string" }, path: { type: "string" }, command: { type: "array", items: { type: "string" } },
    operatorApproved: { type: "boolean", default: false }, timeoutMs: { type: "integer", minimum: 1000, maximum: 600000 },
    maxBytes: { type: "integer", minimum: 1, maximum: 1048576 }, limit: { type: "integer", minimum: 1, maximum: 1000 }
  }, ["action"]),
  tool("orange5_browser", "Run a stateful Chrome DevTools MCP workflow; every step is separately authorized by Hermes and the workflow emits one hashed receipt.", {
    projectRoot: { type: "string" }, operatorApproved: { type: "boolean", default: false },
    steps: { type: "array", minItems: 1, maxItems: 20, items: { type: "object", properties: { tool: { type: "string" }, args: { type: "object" } }, required: ["tool"] } }
  }, ["steps"])
];
const DEFAULT_AE_STAFF_CLIENT = createAeStaffMcpClient();

export async function handleMcp(message, { aeStaffClient = DEFAULT_AE_STAFF_CLIENT } = {}) {
  if (!message || message.jsonrpc !== "2.0") return null;
  // JSON-RPC notifications have no response channel. Never let an id-less
  // request invoke a tool, create a task, or mutate task state.
  if (!Object.prototype.hasOwnProperty.call(message, "id")) return null;
  if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") return null;
  const id = message.id;
  try {
    switch (message.method) {
      case "server/discover":
        return ok(id, {
          supportedVersions: [CURRENT_PROTOCOL],
          capabilities: modernCapabilities(),
          instructions: serverInstructions(),
          ttlMs: 300_000,
          cacheScope: "shared",
          _meta: { [SERVER_INFO_META_KEY]: SERVER },
        });
      case "initialize":
        {
        const protocolVersion = message.params?.protocolVersion || "2025-06-18";
        return ok(id, {
          protocolVersion,
          capabilities: protocolVersion >= "2026-07-28"
            ? modernCapabilities()
            : { tools: {}, resources: {}, prompts: {} },
          serverInfo: SERVER,
          instructions: serverInstructions()
        });
        }
      case "ping": return ok(id, {});
      case "tools/list": return ok(id, listResult(message, { tools: listedTools(message) }));
      case "tools/call": {
        const name = message.params?.name;
        const args = message.params?.arguments || {};
        if (!TOOLS.some((item) => item.name === name)) throw new Error(`unknown OrangeFive tool: ${name}`);
        if (TASKABLE_TOOLS.has(name) && hasTaskExtension(message.params)) {
          const task = TASK_STORE.create({ method: "tools/call", toolName: name, arguments: args });
          scheduleTask(task.taskId);
          return ok(id, task);
        }
        return ok(id, await executeToolCall(name, args, null, { aeStaffClient }));
      }
      case "tasks/get": {
        if (!hasTaskExtension(message.params)) return missingTaskCapability(id);
        const taskId = message.params?.taskId;
        const task = TASK_STORE.get(taskId);
        if (!task) return fail(id, -32602, "unknown taskId");
        if (TASK_STORE.shouldRecover(taskId)) scheduleTask(taskId);
        return ok(id, task);
      }
      case "tasks/update": {
        if (!hasTaskExtension(message.params)) return missingTaskCapability(id);
        if (!TASK_STORE.update(message.params?.taskId, message.params?.inputResponses || {})) return fail(id, -32602, "unknown taskId");
        return ok(id, { resultType: "complete" });
      }
      case "tasks/cancel": {
        if (!hasTaskExtension(message.params)) return missingTaskCapability(id);
        try {
          if (!TASK_STORE.cancel(message.params?.taskId)) return fail(id, -32602, "unknown taskId");
        } catch (error) {
          return fail(id, -32602, error?.message || String(error));
        }
        return ok(id, { resultType: "complete" });
      }
      case "resources/list": return ok(id, listResult(message, { resources: resources() }));
      case "resources/read": return ok(id, await readResource(message.params?.uri, aeStaffClient));
      case "prompts/list": return ok(id, listResult(message, { prompts: prompts() }));
      case "prompts/get": return ok(id, getPrompt(message.params?.name));
      default: return fail(id, -32601, `method not found: ${message.method}`);
    }
  } catch (error) {
    return fail(id, -32000, error?.message || String(error));
  }
}

function modernCapabilities() {
  return { tools: {}, resources: {}, prompts: {}, extensions: { [TASK_EXTENSION]: {} } };
}

function serverInstructions() {
  return "Use orange5_health first. Use orange5_route before mutating work. For staff control, use ae_staff_health and ae_staff_list before ae_staff_order; preserve orange.order.v1 and orange.report.v1. Receipts outrank claims. Atomic Orange is optional; this gateway is headless. Long work supports durable MCP Tasks for 2026-07-28 extension clients.";
}

function listResult(message, value) {
  if (requestProtocol(message) !== CURRENT_PROTOCOL) return value;
  return { ...value, ttlMs: 60_000, cacheScope: "shared", _meta: { [SERVER_INFO_META_KEY]: SERVER } };
}

function listedTools(message) {
  if (requestProtocol(message) === CURRENT_PROTOCOL) return TOOLS;
  return TOOLS.filter((item) => !CURRENT_PROTOCOL_ONLY_TOOLS.has(item.name));
}

export function requestProtocol(message) {
  return message?.params?._meta?.["io.modelcontextprotocol/protocolVersion"] || null;
}

async function executeToolCall(name, args, taskId = null, { aeStaffClient = DEFAULT_AE_STAFF_CLIENT } = {}) {
  const result = name === "ae_staff_health" ? await aeStaffClient.health()
    : name === "ae_staff_list" ? await aeStaffClient.list()
    : name === "ae_staff_order" ? await aeStaffClient.order(assertCanonicalAeStaffMcpArguments(args))
    : name === "orange5_superstack" ? await superstackStatus()
    : name === "orange5_model_lease" ? await executeModelLease(args)
    : name === "orange5_party_line_read" ? await readPartyLine({
        cursor: args.cursor,
        limit: args.limit,
        detail: args.detail,
        tail: args.cursor == null,
        filters: { projectId: args.projectId, actor: args.actor, eventType: args.eventType, topic: args.topic },
      })
    : name === "orange5_party_line_post" ? await appendPartyLineEvent(args)
    : name === "orange5_party_line_hydrate" ? await hydratePartyLine(args)
    : Object.prototype.hasOwnProperty.call(SWARM_MCP_ORDERS, name) ? await executeOrder(buildSwarmMcpOrder(name, args), { dryRun: false, learn: false })
    : name === "orange5_execute" ? await executeGovernedTool(args)
    : name === "orange5_browser" ? await executeBrowserWorkflow(args)
    : await dispatchTool(name, args);
  const callResult = {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    isError: result?.ok === false,
  };
  if (taskId) callResult._meta = { ["io.modelcontextprotocol/related-task"]: { taskId } };
  return callResult;
}

export function buildSwarmMcpOrder(name, args) {
  const spec = SWARM_MCP_ORDERS[name];
  if (!spec) throw new Error(`unknown swarm MCP tool: ${name}`);
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new TypeError(`${name} arguments must be an object`);
  if (name === "orange5_swarmgate_plan" && (!Array.isArray(args.tasks) || args.tasks.length === 0)) {
    throw new TypeError("orange5_swarmgate_plan requires at least one task");
  }
  if (name === "orange5_swarm_sentinel_inspect") {
    if (!args.plan || typeof args.plan !== "object" || Array.isArray(args.plan) || args.plan.schema !== "orange5.swarmgate-plan.v1") {
      throw new TypeError("orange5_swarm_sentinel_inspect requires a canonical orange5.swarmgate-plan.v1 plan");
    }
    if (!Array.isArray(args.workerReports)) throw new TypeError("orange5_swarm_sentinel_inspect requires workerReports");
  }
  return {
    action: spec.action,
    intent: spec.intent,
    scope: "OrangeFive swarm coordination",
    payload: args,
    allowedActions: [spec.action],
    forbiddenActions: ["destructive_write", "production_deploy", "scope_expansion"],
    targetProject: "OrangeFive",
    riskLevel: "read_only",
    requiresReceipt: true,
  };
}

export function createAeStaffMcpClient({
  sendEnvelope = sendLocalAEPhaseEnvelope,
  waitEnvelope = waitForAEPhaseEnvelope,
  readTimeoutMs = timeoutValue(process.env.ORANGE5_AE_STAFF_READ_TIMEOUT_MS, 10_000),
  dispatchTimeoutMs = timeoutValue(process.env.ORANGE5_AE_STAFF_TIMEOUT_MS, 240_000),
} = {}) {
  if (typeof sendEnvelope !== "function" || typeof waitEnvelope !== "function") {
    throw new TypeError("AE Staff Phase client requires send and wait implementations");
  }

  const query = async (operation) => {
    const requestId = `ae-staff-query-${randomUUID()}`;
    await sendEnvelope({
      id: requestId,
      kind: "ae_staff_query",
      correlationId: requestId,
      body: { operation },
    });
    const response = await waitEnvelope({
      kind: "ae_staff_query_report",
      correlationId: requestId,
    }, { timeoutMs: readTimeoutMs });
    if (!response?.body || typeof response.body !== "object" || Array.isArray(response.body)) {
      throw new Error(`AE Staff Phase ${operation} returned no response object`);
    }
    return response.body;
  };

  const health = async () => {
    const payload = await query("health");
    if (typeof payload.ok !== "boolean" || typeof payload.roleCount !== "number") {
      throw new Error("AE Staff health response is missing live status fields");
    }
    return payload;
  };
  const list = async () => {
    const payload = await query("list");
    if (payload.schema !== "orange.hermes-staff-reactor.v1" || !Array.isArray(payload.roles)) {
      throw new Error("AE Staff roster response does not match orange.hermes-staff-reactor.v1");
    }
    return payload;
  };
  const dispatch = async (args) => {
    const event = buildAeStaffOrderEvent(args);
    const requestId = `ae-staff-order-${randomUUID()}`;
    await sendEnvelope({
      id: requestId,
      kind: "ae_staff_order",
      correlationId: event.correlationId,
      body: { event },
    });
    const response = await waitEnvelope({
      kind: "ae_staff_report",
      correlationId: requestId,
    }, { timeoutMs: dispatchTimeoutMs });
    return validateAeStaffDispatch(response.body, event.order, event.targetRoles);
  };
  return { health, list, order: dispatch, dispatch };
}

export function buildAeStaffOrderEvent(args = {}) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new TypeError("ae_staff_order arguments must be an object");
  const order = normalizeAeStaffOrder(args.order);
  if (!Array.isArray(args.targetRoles) || args.targetRoles.length === 0) throw new TypeError("ae_staff_order requires at least one target role");
  if (args.targetRoles.some((roleId) => typeof roleId !== "string" || !roleId.trim())) {
    throw new TypeError("ae_staff_order target roles must be non-empty strings");
  }
  const targetRoles = args.targetRoles.map((roleId) => roleId.trim());
  if (new Set(targetRoles).size !== targetRoles.length) throw new TypeError("ae_staff_order target roles must be unique");
  if (targetRoles.length > 50) throw new TypeError("ae_staff_order cannot target more than 50 roles");
  const intent = typeof order.intent === "string" && order.intent.trim() ? order.intent.trim() : order.action.trim();
  return {
    id: order.orderId.trim(),
    type: "staff.order",
    topic: order.action.trim(),
    summary: intent,
    body: intent,
    projectId: String(order.targetProject || order.scope || "OrangeFive"),
    correlationId: String(args.correlationId || order.orderId),
    order,
    authority: order.authority || "orange-hermes-navigator",
    custody: order.custody || null,
    cancellation: order.cancellation || { supported: true, requested: false },
    handoffCapsule: order.handoffCapsule || null,
    commitments: Array.isArray(args.commitments) ? args.commitments.map(String) : (intent ? [intent] : []),
    sourceRefs: Array.isArray(args.sourceRefs) ? args.sourceRefs : (Array.isArray(order.evidence) ? order.evidence : []),
    targetRoles,
    requiresModel: order.requiresModel !== false,
  };
}

function assertCanonicalAeStaffMcpArguments(args) {
  if (!args?.order || args.order.schema !== "orange.order.v1") {
    throw new TypeError("ae_staff_order requires order.schema orange.order.v1");
  }
  for (const field of ["orderId", "action"]) {
    if (typeof args.order[field] !== "string" || !args.order[field].trim()) {
      throw new TypeError(`ae_staff_order requires non-empty order.${field}`);
    }
  }
  buildAeStaffOrderEvent(args);
  return args;
}

function normalizeAeStaffOrder(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("ae_staff_order requires an order object");
  if (typeof input.action !== "string" || !input.action.trim()) throw new TypeError("ae_staff_order requires non-empty order.action");
  if (input.schema && input.schema !== "orange.order.v1") throw new TypeError("ae_staff_order requires order.schema orange.order.v1");
  if (input.requiresReceipt === false) throw new TypeError("ae_staff_order refuses orders that disable receipts");
  if (input.schema === "orange.order.v1" && typeof input.orderId === "string" && input.orderId.trim()) return input;
  const action = input.action.trim();
  const targetProject = String(input.targetProject || input.scope || "OrangeFive");
  return {
    ...input,
    schema: "orange.order.v1",
    orderId: typeof input.orderId === "string" && input.orderId.trim() ? input.orderId.trim() : `ae-staff-${randomUUID()}`,
    action,
    intent: typeof input.intent === "string" && input.intent.trim() ? input.intent.trim() : action,
    scope: input.scope || targetProject,
    allowedActions: Array.isArray(input.allowedActions) && input.allowedActions.length ? input.allowedActions : [action],
    forbiddenActions: Array.isArray(input.forbiddenActions) ? input.forbiddenActions : ["destructive_write", "production_deploy", "scope_expansion"],
    targetProject,
    riskLevel: input.riskLevel || "medium",
    requiresReceipt: true,
    payload: input.payload && typeof input.payload === "object" && !Array.isArray(input.payload) ? input.payload : {},
  };
}

function validateAeStaffDispatch(payload, order, targetRoles) {
  if (payload?.event?.order?.schema !== "orange.order.v1"
    || payload.event.order.orderId !== order.orderId
    || payload.event.order.action !== order.action) {
    throw new Error("AE Staff dispatch did not preserve the canonical orange.order.v1");
  }
  if (!Array.isArray(payload.results)) throw new Error("AE Staff dispatch returned no role results");
  const byRole = new Map(payload.results.filter(Boolean).map((item) => [item.roleId, item]));
  const reports = [];
  const failures = [];
  for (const roleId of targetRoles) {
    const item = byRole.get(roleId);
    if (!item) throw new Error(`AE Staff dispatch omitted target role ${roleId}`);
    if (item.ok !== true) {
      failures.push({ roleId, status: "blocked", error: item.result?.error || "AE Staff role did not complete" });
      continue;
    }
    const report = validateAeStaffReport(item.result, order.orderId, roleId);
    reports.push(report);
    if (report.status !== "completed") {
      failures.push({ roleId, status: report.status, blockers: report.blockers, nextAction: report.nextAction });
    }
  }
  const ok = failures.length === 0 && reports.length === targetRoles.length;
  return {
    schema: "orange.ae-staff-mcp-dispatch.v1",
    ok,
    status: ok ? "completed" : "needs_attention",
    order,
    event: payload.event,
    observedCount: payload.observedCount,
    addressed: payload.addressed,
    candidates: payload.candidates,
    reports,
    failures,
    reactor: summarizeAeStaffSnapshot(payload.snapshot),
  };
}

function validateAeStaffReport(report, orderId, roleId) {
  if (!report || typeof report !== "object" || report.schema !== "orange.report.v1") {
    throw new Error(`AE Staff role ${roleId} did not return orange.report.v1`);
  }
  if (![orderId, `${orderId}:${roleId}`].includes(report.orderId)) {
    throw new Error(`AE Staff role ${roleId} returned a report for the wrong order`);
  }
  if (!["completed", "blocked", "needs_attention"].includes(report.status)) {
    throw new Error(`AE Staff role ${roleId} returned invalid report status ${report.status || "missing"}`);
  }
  if (!Number.isFinite(report.confidence) || report.confidence < 0 || report.confidence > 1) {
    throw new Error(`AE Staff role ${roleId} returned invalid report confidence`);
  }
  for (const field of ["actionsTaken", "evidence", "blockers"]) {
    if (!Array.isArray(report[field])) throw new Error(`AE Staff role ${roleId} report ${field} must be an array`);
  }
  if (report.status === "completed" && report.evidence.length === 0) {
    throw new Error(`AE Staff role ${roleId} claimed completion without evidence`);
  }
  if (typeof report.receiptPath !== "string" || !report.receiptPath.trim()) {
    throw new Error(`AE Staff role ${roleId} returned no receipt path`);
  }
  return report;
}

function summarizeAeStaffSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  return {
    schema: snapshot.schema,
    status: snapshot.status,
    roleCount: snapshot.roleCount,
    readyCount: snapshot.readyCount,
    runningCount: snapshot.runningCount,
    queuedCount: snapshot.queuedCount,
    inferenceLimit: snapshot.inferenceLimit,
    inferenceActive: snapshot.inferenceActive,
    toolLimit: snapshot.toolLimit,
    toolActive: snapshot.toolActive,
  };
}

function timeoutValue(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function superstackStatus() {
  const manifest = loadSuperstackManifest();
  const live = await superstackInventory(manifest);
  return {
    ok: true,
    schema: manifest.schema,
    name: manifest.name,
    policy: manifest.policy,
    running: live.running,
    installed: live.installed.map((item) => item.name || item.model).filter(Boolean),
    roles: manifest.roles,
  };
}

async function executeModelLease(args = {}) {
  if (args.operatorApproved !== true) {
    return { ok: false, status: 'OPERATOR_APPROVAL_REQUIRED', action: 'orange5_model_lease', role: args.role || null };
  }
  const manifest = loadSuperstackManifest();
  const plan = planSuperstackLease(manifest, args.role);
  if (!plan.decision.allowed) {
    const result = { ok: false, status: 'LEASE_DENIED', action: 'orange5_model_lease', plan };
    const receiptPath = writeSuperstackReceipt('mcp-model-lease', result, 'mcp-model-lease');
    return { ...result, receiptPath };
  }

  const child = Bun.spawn(plan.command, {
    cwd: ROOT,
    env: process.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const result = {
    ok: exitCode === 0,
    status: exitCode === 0 ? 'LEASE_EXECUTED' : 'LEASE_FAILED',
    action: 'orange5_model_lease',
    role: plan.role,
    model: plan.model,
    exitCode,
    output: stdout.slice(-32_768),
    error: stderr.slice(-32_768),
    plan,
  };
  const receiptPath = writeSuperstackReceipt('mcp-model-lease', result, 'mcp-model-lease');
  return { ...result, receiptPath };
}

function scheduleTask(taskId) {
  if (TASK_JOBS.has(taskId)) return;
  const execution = TASK_STORE.execution(taskId);
  if (!execution || execution.status !== "working" || !TASK_STORE.claim(taskId, WORKER_ID)) return;
  const heartbeat = setInterval(() => TASK_STORE.renew(taskId, WORKER_ID), 10_000);
  const job = executeToolCall(execution.toolName, execution.arguments, taskId)
    .then((result) => TASK_STORE.complete(taskId, result))
    .catch((error) => TASK_STORE.fail(taskId, error))
    .finally(() => {
      clearInterval(heartbeat);
      TASK_JOBS.delete(taskId);
    });
  TASK_JOBS.set(taskId, job);
}

function hasTaskExtension(params = {}) {
  return params?._meta?.["io.modelcontextprotocol/clientCapabilities"]?.extensions?.[TASK_EXTENSION] != null;
}

function missingTaskCapability(id) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32021,
      message: "Missing required client capability",
      data: { requiredCapabilities: { extensions: { [TASK_EXTENSION]: {} } } },
    },
  };
}

function tool(name, description, properties, required = []) {
  return { name, description, inputSchema: { type: "object", additionalProperties: false, properties, required } };
}
function ok(id, result) { return { jsonrpc: "2.0", id, result }; }
function fail(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }
function resources() {
  return [
    { uri: "orange5://health", name: "OrangeFive Live Health", mimeType: "application/json" },
    { uri: "orange5://ae-staff/health", name: "ae_staff_health", mimeType: "application/json" },
    { uri: "orange5://ae-staff/list", name: "ae_staff_list", mimeType: "application/json" },
    { uri: "orange5://receipts/latest", name: "OrangeFive Latest Receipts", mimeType: "application/json" },
    { uri: "orange5://manual", name: "OrangeFive Operator Manual", mimeType: "text/markdown" },
    { uri: "orange5://superstack", name: "Captain Planet Model Superset", mimeType: "application/json" },
    { uri: "orange5://party-line/latest", name: "Orange Party Line", mimeType: "application/json" }
  ];
}
async function readResource(uri, aeStaffClient = DEFAULT_AE_STAFF_CLIENT) {
  if (uri === "orange5://health") return contents(uri, JSON.stringify(await healthSnapshot(), null, 2), "application/json");
  if (uri === "orange5://ae-staff/health") return contents(uri, JSON.stringify(await aeStaffClient.health(), null, 2), "application/json");
  if (uri === "orange5://ae-staff/list") return contents(uri, JSON.stringify(await aeStaffClient.list(), null, 2), "application/json");
  if (uri === "orange5://receipts/latest") return contents(uri, JSON.stringify(readReceipts(10), null, 2), "application/json");
  if (uri === "orange5://manual") {
    const file = Bun.file(`${ROOT}/00-CHARTER/ORANGEFIVE_HOW_TO_USE.md`);
    return contents(uri, await file.text(), "text/markdown");
  }
  if (uri === "orange5://superstack") {
    return contents(uri, JSON.stringify(await superstackStatus(), null, 2), "application/json");
  }
  if (uri === "orange5://party-line/latest") {
    return contents(uri, JSON.stringify(await readPartyLine({ limit: 50, detail: 'normal', tail: true }), null, 2), "application/json");
  }
  throw new Error(`unknown resource: ${uri}`);
}
function contents(uri, text, mimeType) { return { contents: [{ uri, mimeType, text }] }; }
function prompts() {
  return [
    { name: "orange5-lead", description: "Lead a project through OrangeFive with evidence and least-action routing." },
    { name: "orange5-mirror", description: "Audit completion claims against live evidence and receipts." }
  ];
}
function getPrompt(name) {
  const text = name === "orange5-lead"
    ? "Operate through OrangeFive. Probe health, inspect the real project, route the least sufficient capability, execute end to end, and require receipts for completion. Never depend on Atomic Orange."
    : name === "orange5-mirror"
      ? "Audit the requested claim against live runtime evidence and OrangeFive receipts. Return exact contradictions, missing proof, blockers, and next action. Never infer green."
      : null;
  if (!text) throw new Error(`unknown prompt: ${name}`);
  return { description: name, messages: [{ role: "user", content: { type: "text", text } }] };
}

async function main() {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); }
    catch { process.stdout.write(`${JSON.stringify(fail(null, -32700, "parse error"))}\n`); continue; }
    const response = await handleMcp(message);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

if (import.meta.main) await main();
