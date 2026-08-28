import crypto from "node:crypto";
import { aelangHighToCore } from "../04-CONTROL-PLANE/aecode/compiler.mjs";
import { pickLane } from "../06-ORANGELLM/router-least-action.mjs";
import { summarizePressure } from "../06-ORANGELLM/flow-pressure.mjs";
import { planSwarm } from "../08-HERMES/product-integration/scripts/swarmgate.mjs";
import { compileProblem, WORK_OBJECT_SCHEMA } from "./problem-compiler.mjs";

const DOMAIN = Object.freeze({
  AE2_RESEARCH: profile(["researcher", "source-verifier", "synthesizer"], ["read", "web-research", "receipts"]),
  AE3_DESIGN: profile(["design-architect", "interaction-reviewer", "mirror"], ["read", "ae-eyes", "receipts"]),
  AE6_CODE: profile(["implementer", "test-engineer", "code-reviewer"], ["read", "filesystem", "shell", "git", "receipts"]),
  AE7_REVIEW: profile(["mirror", "strongarm", "checkmate"], ["read", "tests", "receipts"]),
  AE10_OPS: profile(["operator", "watcher", "rollback-reviewer"], ["read", "shell", "health", "receipts"]),
  AE11_SECURITY: profile(["security-auditor", "misfit", "checkmate"], ["read", "secret-scan", "danger-scan", "receipts"]),
  AE12_DATA: profile(["data-engineer", "quality-auditor", "analyst"], ["read", "sqlite", "receipts"]),
  AE14_BENCH: profile(["test-engineer", "benchmark-runner", "mirror"], ["read", "tests", "bench", "receipts"])
});
const DEFAULT_PROFILE = profile(["domain-worker", "mirror"], ["read", "receipts"]);

function profile(agents, tools) { return Object.freeze({ agents: Object.freeze(agents), tools: Object.freeze(tools) }); }

export function compileDelegation(order, flowState = {}) {
  if (!order || typeof order !== "object" || typeof order.action !== "string" || !order.action.trim()) {
    throw new TypeError("delegation requires order.action");
  }
  const [verbRaw, ...objectParts] = order.action.replace(/\./g, " ").split(/\s+/).filter(Boolean);
  const verb = normalizeVerb(verbRaw, order);
  const core = aelangHighToCore(`${verb} ${objectParts.join(" ") || "work"}`);
  const domain = DOMAIN[core.department] || DEFAULT_PROFILE;
  const routeOrder = {
    schema: "orange.order.v1",
    orderId: order.orderId || `delegate-${crypto.randomUUID()}`,
    intent: String(order.intent || order.payload?.intent || order.action),
    scope: typeof order.scope === "string"
      ? order.scope
      : (typeof order.payload?.scope === "string" ? order.payload.scope : "orange5.delegation"),
    allowedActions: Array.isArray(order.allowedActions) ? order.allowedActions : [order.action],
    forbiddenActions: Array.isArray(order.forbiddenActions) ? order.forbiddenActions : [],
    riskLevel: order.riskLevel || "medium"
  };
  const route = pickLane(routeOrder, flowState);
  const workObject = order.work?.schema === WORK_OBJECT_SCHEMA
    ? order.work
    : compileProblem({ ...order, intent: routeOrder.intent }, {
        project: order.targetProject || order.projectId || "orange5",
        authority: "operator",
        owner: "navigator",
      });
  const agents = domain.agents.slice(0, Math.max(1, Math.min(3, Number(order.maxAgents) || 3)));
  const allowedTools = domain.tools.filter((tool) => !routeOrder.forbiddenActions.some((denied) => denied.includes(tool)));
  const pressure = summarizePressure(flowState, { cap: Math.max(1, Number(order.maxAgents) || 3) });
  const pressureWidth = Math.max(1, Math.floor((Number(order.maxAgents) || 3) * (1 - pressure.governor.backpressure)));
  const declaredTasks = Array.isArray(order.tasks) && order.tasks.length
    ? order.tasks
    : agents.map((agent, index) => ({
        id: `${routeOrder.orderId}:${agent}`,
        action: routeOrder.action,
        intent: `${agent} contribution to ${order.intent || routeOrder.action}`,
        profile: agent,
        dependsOn: index === 0 ? [] : (order.parallelReview === false ? [`${routeOrder.orderId}:${agents[index - 1]}`] : []),
        reads: Array.isArray(order.reads) ? order.reads : [],
        writes: index === 0 && Array.isArray(order.writes) ? order.writes : [],
        irreversible: Boolean(order.irreversible),
        modelKey: route.model || "orange-auto",
        modelResidentGb: Number(order.modelResidentGb || 10),
        contextGb: Number(order.contextGb || 1),
      }));
  const swarmPlan = planSwarm({
    tasks: declaredTasks,
    maxImmediateWorkers: pressureWidth,
    liveMemoryBudgetGb: Number(order.liveMemoryBudgetGb || flowState?.liveMemoryBudgetGb || 50),
    reservedSystemMemoryGb: Number(order.reservedSystemMemoryGb || flowState?.reservedSystemMemoryGb || 12),
  });
  const issuedAt = new Date();
  const plan = {
    schema: "orange.navigator-delegation.v1",
    delegationId: `nav-${crypto.randomUUID()}`,
    orderId: routeOrder.orderId,
    topNavigator: { runtime: "bun-navigator-kernel", modelResident: false },
    route: { lane: route.lane, model: route.model, decisionId: route.decision_id },
    workObject: {
      schema: workObject.schema,
      workId: workObject.workId,
      objective: workObject.objective,
      compilationHash: workObject.compilationHash,
      wave3Kernel: workObject.wave3Kernel,
    },
    flow: pressure,
    swarmGate: swarmPlan,
    littleNavigator: {
      id: `${core.department.toLowerCase()}-navigator`,
      department: core.department,
      agents,
      allowedTools
    },
    hermesLease: {
      leaseId: `hermes-${crypto.randomUUID()}`,
      allowedActions: routeOrder.allowedActions,
      forbiddenActions: routeOrder.forbiddenActions,
      allowedAgents: agents,
      allowedTools,
      maxConcurrentAgents: swarmPlan.maxParallelWorkers,
      executionMode: swarmPlan.maxParallelWorkers > 1 ? "bounded-parallel-waves" : "serial-receipt-safe",
      executionWaves: swarmPlan.executionWaves,
      wave3Kernel: workObject.wave3Kernel,
      requiresReceipt: order.requiresReceipt !== false,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + 30 * 60_000).toISOString()
    }
  };
  plan.planHash = crypto.createHash("sha256").update(JSON.stringify(plan)).digest("hex");
  return plan;
}

function normalizeVerb(verb, order) {
  const hay = `${verb || ""} ${order.intent || ""} ${order.payload?.intent || ""}`.toLowerCase();
  // The structured action outranks incidental words in the description. A
  // build order that promises tests is still a code mission, not a benchmark.
  if (/^(build|code|patch|implement|refactor|fix)$/.test(String(verb || "").toLowerCase())) return "build";
  if (/security|secret|threat|vulnerab|audit/.test(hay)) return "audit";
  if (/test|bench|verify/.test(hay)) return "test";
  if (/research|source|paper/.test(hay)) return "research";
  if (/deploy|ops|runtime|health|service/.test(hay)) return "ops";
  if (/design|visual|ux/.test(hay)) return "design";
  if (/data|sqlite|metric/.test(hay)) return "data";
  if (/review|judge/.test(hay)) return "review";
  if (/build|code|patch|implement|refactor|fix/.test(hay)) return "build";
  return "factory";
}
