import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sendLocalAEPhaseEnvelope } from "../ae-phase-fabric.mjs";
import { CURRENT_PROTOCOL, createAeStaffMcpClient, handleMcp } from "../orange5-brain-mcp-server.mjs";

const request = (id, method, params = {}) => ({ jsonrpc: "2.0", id, method, params });
const currentMeta = { "io.modelcontextprotocol/protocolVersion": CURRENT_PROTOCOL };
const roleIds = Array.from({ length: 50 }, (_, index) => `staff-role-${String(index + 1).padStart(2, "0")}`);
const tempRoot = mkdtempSync(join(tmpdir(), "orange5-ae-staff-mcp-"));

afterAll(() => {
  const resolvedRoot = resolve(tempRoot);
  if (!resolvedRoot.startsWith(resolve(tmpdir()))) throw new Error("refusing to remove a non-temporary test path");
  rmSync(resolvedRoot, { recursive: true, force: true });
});

function phaseResponse(sent, body, kind = sent.kind === "ae_staff_order" ? "ae_staff_report" : "ae_staff_query_report") {
  return {
    id: `response-${sent.id}`,
    kind,
    correlationId: sent.id,
    body,
  };
}

function phaseHarness(respond) {
  const sent = [];
  const waits = [];
  return {
    sent,
    waits,
    sendEnvelope: async (envelope) => {
      sent.push(envelope);
      return { ok: true, id: envelope.id, kind: envelope.kind, correlationId: envelope.correlationId };
    },
    waitEnvelope: async (criteria, options) => {
      waits.push({ criteria, options });
      return respond(sent[sent.length - 1], criteria, options);
    },
  };
}

function liveSnapshot(operation, includeRoles = false) {
  return {
    ok: true,
    operation,
    schema: "orange.hermes-staff-reactor.v1",
    status: "LIVE",
    roleCount: 50,
    readyCount: 50,
    runningCount: 0,
    queuedCount: 0,
    inferenceLimit: 8,
    inferenceActive: 0,
    toolLimit: 32,
    toolActive: 0,
    ...(includeRoles ? { roles: roleIds.map((id) => ({ id, state: "ready" })) } : {}),
  };
}

function completedReport(orderId, roleId, overrides = {}) {
  return {
    schema: "orange.report.v1",
    orderId,
    status: "completed",
    confidence: 1,
    actionsTaken: ["verified the canonical AE Phase dispatch"],
    evidence: [{ kind: "test", roleId }],
    blockers: [],
    nextAction: "return to Navigator",
    receiptPath: `C:\\receipts\\${roleId}.json`,
    receiptSha256: "abc123",
    ...overrides,
  };
}

describe("OrangeFive Brain MCP AE Staff control", () => {
  test("advertises current AE Staff tools and read resources without changing the legacy tool surface", async () => {
    const current = await handleMcp(request(1, "tools/list", { _meta: currentMeta }));
    const currentNames = current.result.tools.map((item) => item.name);
    expect(currentNames).toContain("ae_staff_health");
    expect(currentNames).toContain("ae_staff_list");
    expect(currentNames).toContain("ae_staff_order");

    const legacy = await handleMcp(request(2, "tools/list"));
    const legacyNames = legacy.result.tools.map((item) => item.name);
    expect(legacyNames).not.toContain("ae_staff_health");
    expect(legacyNames).not.toContain("ae_staff_list");
    expect(legacyNames).not.toContain("ae_staff_order");
    expect(legacyNames).toContain("orange5_health");
    expect(legacyNames).toContain("orange5_order");

    const listed = await handleMcp(request(3, "resources/list"));
    expect(listed.result.resources.map((item) => item.uri)).toEqual(expect.arrayContaining([
      "orange5://ae-staff/health",
      "orange5://ae-staff/list",
    ]));
  });

  test("returns AE Phase health and roster without reaching the five-second MCP ceiling", async () => {
    const harness = phaseHarness((sent) => phaseResponse(
      sent,
      liveSnapshot(sent.body.operation, sent.body.operation === "list"),
    ));
    const client = createAeStaffMcpClient({ sendEnvelope: harness.sendEnvelope, waitEnvelope: harness.waitEnvelope });

    const health = await handleMcp(request(4, "tools/call", { name: "ae_staff_health", arguments: {} }), { aeStaffClient: client });
    expect(JSON.parse(health.result.content[0].text).roleCount).toBe(50);

    const roster = await handleMcp(request(5, "resources/read", { uri: "orange5://ae-staff/list" }), { aeStaffClient: client });
    expect(JSON.parse(roster.result.contents[0].text).roles).toHaveLength(50);
    expect(harness.sent.map((item) => item.body.operation)).toEqual(["health", "list"]);
    expect(harness.sent.every((item) => item.kind === "ae_staff_query" && item.correlationId === item.id)).toBe(true);
    expect(harness.waits.every((item) => item.options.timeoutMs === 4_000)).toBe(true);
    expect(harness.waits.every((item, index) => item.criteria.correlationId === harness.sent[index].id)).toBe(true);
  });

  test("dispatches one unchanged orange.order.v1 and returns correlated orange.report.v1 evidence", async () => {
    const harness = phaseHarness((sent) => {
      const event = sent.body.event;
      return phaseResponse(sent, {
        event,
        observedCount: 50,
        addressed: [{ roleId: "integration-engineer", relevance: 1 }],
        candidates: [],
        results: [{
          roleId: "integration-engineer",
          ok: true,
          result: completedReport(event.order.orderId, "integration-engineer"),
        }],
        snapshot: liveSnapshot("dispatch"),
      });
    });
    const client = createAeStaffMcpClient({ sendEnvelope: harness.sendEnvelope, waitEnvelope: harness.waitEnvelope });
    const order = {
      schema: "orange.order.v1",
      orderId: "ae-staff-mcp-order-1",
      action: "inspect.integration",
      intent: "Verify the AE Staff MCP control path",
      scope: "OrangeFive",
      targetProject: "OrangeFive",
      allowedActions: ["filesystem.read"],
      forbiddenActions: ["destructive_write"],
      riskLevel: "read_only",
      requiresReceipt: true,
      payload: { focused: true },
    };

    const response = await handleMcp(request(6, "tools/call", {
      name: "ae_staff_order",
      arguments: { order, targetRoles: ["integration-engineer"], sourceRefs: ["orange5://ae-staff/list"] },
    }), { aeStaffClient: client });
    const result = JSON.parse(response.result.content[0].text);
    const sentEnvelope = harness.sent[0];
    const sentEvent = sentEnvelope.body.event;

    expect(response.result.isError).toBe(false);
    expect(sentEnvelope.kind).toBe("ae_staff_order");
    expect(sentEnvelope.correlationId).toBe(order.orderId);
    expect(harness.waits[0].criteria).toEqual({ kind: "ae_staff_report", correlationId: sentEnvelope.id });
    expect(sentEvent.id).toBe(order.orderId);
    expect(sentEvent.topic).toBe(order.action);
    expect(sentEvent.order).toEqual(order);
    expect(sentEvent.targetRoles).toEqual(["integration-engineer"]);
    expect(result.schema).toBe("orange.ae-staff-mcp-dispatch.v1");
    expect(result.order).toEqual(order);
    expect(result.reports[0].schema).toBe("orange.report.v1");
    expect(result.reports[0].evidence).toHaveLength(1);
    expect(result.reactor.roles).toBeUndefined();
  });

  test("canonicalizes action-form orders for the shared client and preserves per-role report correlation", async () => {
    const harness = phaseHarness((sent) => {
      const event = sent.body.event;
      return phaseResponse(sent, {
        event,
        results: [{
          roleId: "integration-engineer",
          ok: true,
          result: completedReport(`${event.order.orderId}:integration-engineer`, "integration-engineer"),
        }],
      });
    });
    const client = createAeStaffMcpClient({ sendEnvelope: harness.sendEnvelope, waitEnvelope: harness.waitEnvelope });

    const result = await client.order({
      order: { action: "build.feature", intent: "Build through the shared AE Staff client" },
      targetRoles: ["integration-engineer"],
    });
    const sentEvent = harness.sent[0].body.event;

    expect(sentEvent.order.schema).toBe("orange.order.v1");
    expect(sentEvent.order.orderId).toStartWith("ae-staff-");
    expect(sentEvent.order.allowedActions).toEqual(["build.feature"]);
    expect(sentEvent.order.requiresReceipt).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.reports[0].orderId).toBe(`${sentEvent.order.orderId}:integration-engineer`);
  });

  test("stores one shared canonical order in an all-50 dispatch payload", async () => {
    const harness = phaseHarness((sent) => {
      const event = sent.body.event;
      return phaseResponse(sent, {
        event,
        observedCount: 50,
        addressed: roleIds.map((roleId) => ({ roleId, relevance: 1 })),
        results: roleIds.map((roleId) => ({
          roleId,
          ok: true,
          result: completedReport(`${event.order.orderId}:${roleId}`, roleId),
        })),
        snapshot: liveSnapshot("dispatch"),
      });
    });
    const client = createAeStaffMcpClient({ sendEnvelope: harness.sendEnvelope, waitEnvelope: harness.waitEnvelope });
    const order = {
      schema: "orange.order.v1",
      orderId: "ae-staff-all-50",
      action: "inspect.all",
      intent: "Inspect one shared order across the full roster",
      requiresReceipt: true,
      payload: { shared: true },
    };

    const result = await client.order({ order, targetRoles: roleIds });
    const event = harness.sent[0].body.event;
    const serialized = JSON.stringify(harness.sent[0].body);

    expect(result.reports).toHaveLength(50);
    expect(event.targetRoles).toEqual(roleIds);
    expect(event.order).toBe(order);
    expect(event.roleOrders).toBeUndefined();
    expect(serialized.match(/"order":/g)).toHaveLength(1);
  });

  test("rejects non-canonical MCP orders before contacting AE Staff", async () => {
    let sendCalls = 0;
    const client = createAeStaffMcpClient({
      sendEnvelope: async () => { sendCalls += 1; },
      waitEnvelope: async () => { throw new Error("wait should not run"); },
    });
    const response = await handleMcp(request(7, "tools/call", {
      name: "ae_staff_order",
      arguments: {
        order: { schema: "orange.order.v0", orderId: "bad-order", action: "build.tool" },
        targetRoles: ["integration-engineer"],
      },
    }), { aeStaffClient: client });

    expect(response.error.message).toContain("order.schema orange.order.v1");
    expect(sendCalls).toBe(0);
  });

  test("rejects mismatched AE Phase envelopes and dispatch actions", async () => {
    const healthHarness = phaseHarness((sent) => ({
      ...phaseResponse(sent, liveSnapshot("health")),
      correlationId: "wrong-request",
    }));
    const healthClient = createAeStaffMcpClient({ sendEnvelope: healthHarness.sendEnvelope, waitEnvelope: healthHarness.waitEnvelope });
    await expect(healthClient.health()).rejects.toThrow("response correlation mismatch");

    const operationHarness = phaseHarness((sent) => phaseResponse(sent, liveSnapshot("list")));
    const operationClient = createAeStaffMcpClient({ sendEnvelope: operationHarness.sendEnvelope, waitEnvelope: operationHarness.waitEnvelope });
    await expect(operationClient.health()).rejects.toThrow("query correlation mismatch");

    const orderHarness = phaseHarness((sent) => {
      const event = { ...sent.body.event, topic: "different.action" };
      return phaseResponse(sent, {
        event,
        results: [{
          roleId: "integration-engineer",
          ok: true,
          result: completedReport(event.order.orderId, "integration-engineer"),
        }],
      });
    });
    const orderClient = createAeStaffMcpClient({ sendEnvelope: orderHarness.sendEnvelope, waitEnvelope: orderHarness.waitEnvelope });
    await expect(orderClient.order({
      order: { schema: "orange.order.v1", orderId: "action-correlation", action: "inspect.action", requiresReceipt: true },
      targetRoles: ["integration-engineer"],
    })).rejects.toThrow("action correlation");
  });

  test("rejects health, roster, and report false green", async () => {
    const healthHarness = phaseHarness((sent) => phaseResponse(sent, { ...liveSnapshot("health"), status: "OFFLINE" }));
    const healthClient = createAeStaffMcpClient({ sendEnvelope: healthHarness.sendEnvelope, waitEnvelope: healthHarness.waitEnvelope });
    await expect(healthClient.health()).rejects.toThrow("claimed green");

    const rosterHarness = phaseHarness((sent) => phaseResponse(sent, {
      ...liveSnapshot("list", true),
      roles: roleIds.slice(0, 49).map((id) => ({ id, state: "ready" })),
    }));
    const rosterClient = createAeStaffMcpClient({ sendEnvelope: rosterHarness.sendEnvelope, waitEnvelope: rosterHarness.waitEnvelope });
    await expect(rosterClient.list()).rejects.toThrow("claimed green");

    const reportHarness = phaseHarness((sent) => {
      const event = sent.body.event;
      return phaseResponse(sent, {
        event,
        results: [{
          roleId: "false-green-hunter",
          ok: true,
          result: completedReport(event.order.orderId, "false-green-hunter", { evidence: [] }),
        }],
      });
    });
    const reportClient = createAeStaffMcpClient({ sendEnvelope: reportHarness.sendEnvelope, waitEnvelope: reportHarness.waitEnvelope });
    const response = await handleMcp(request(8, "tools/call", {
      name: "ae_staff_order",
      arguments: {
        order: { schema: "orange.order.v1", orderId: "false-green-1", action: "inspect.claim", requiresReceipt: true },
        targetRoles: ["false-green-hunter"],
      },
    }), { aeStaffClient: reportClient });

    expect(response.error.code).toBe(-32000);
    expect(response.error.message).toContain("claimed completion without actions and evidence");
  });

  test("fails closed before waiting when the AE Phase key file is unavailable", async () => {
    let waitCalls = 0;
    const missingKeyFile = join(tempRoot, "missing-ae-phase-key.txt");
    const client = createAeStaffMcpClient({
      sendEnvelope: (envelope) => sendLocalAEPhaseEnvelope(envelope, { keyFile: missingKeyFile }),
      waitEnvelope: async () => { waitCalls += 1; throw new Error("wait should not run"); },
    });

    const response = await handleMcp(request(9, "tools/call", { name: "ae_staff_list", arguments: {} }), { aeStaffClient: client });

    expect(response.error.message).toContain("AE Phase key is missing");
    expect(response.error.message).not.toContain("test-ae-staff-key");
    expect(waitCalls).toBe(0);
  });
});
