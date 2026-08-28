import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CURRENT_PROTOCOL, createAeStaffMcpClient, handleMcp } from "../orange5-brain-mcp-server.mjs";

const request = (id, method, params = {}) => ({ jsonrpc: "2.0", id, method, params });
const currentMeta = { "io.modelcontextprotocol/protocolVersion": CURRENT_PROTOCOL };
const tempRoot = mkdtempSync(join(tmpdir(), "orange5-ae-staff-mcp-"));
const keyFile = join(tempRoot, "ae-staff-client-key.txt");
writeFileSync(keyFile, "test-ae-staff-key\n", "utf8");

afterAll(() => {
  const resolvedRoot = resolve(tempRoot);
  if (!resolvedRoot.startsWith(resolve(tmpdir()))) throw new Error("refusing to remove a non-temporary test path");
  rmSync(resolvedRoot, { recursive: true, force: true });
});

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

  test("uses ORANGE5 AE Staff health and authenticated roster endpoints for tools and resources", async () => {
    const calls = [];
    const client = createAeStaffMcpClient({
      url: "http://127.0.0.1:28643/",
      keyFile,
      fetchFn: async (url, options) => {
        calls.push({ url, options });
        if (url.endsWith("/health")) {
          return Response.json({
            ok: true,
            schema: "orange.hermes-staff-reactor.v1",
            status: "LIVE",
            roleCount: 50,
            readyCount: 50,
            authenticated: true,
          });
        }
        return Response.json({
          schema: "orange.hermes-staff-reactor.v1",
          status: "LIVE",
          roleCount: 50,
          readyCount: 50,
          roles: [{ id: "integration-engineer", state: "ready" }],
        });
      },
    });

    const health = await handleMcp(request(4, "tools/call", { name: "ae_staff_health", arguments: {} }), { aeStaffClient: client });
    expect(JSON.parse(health.result.content[0].text).roleCount).toBe(50);

    const roster = await handleMcp(request(5, "resources/read", { uri: "orange5://ae-staff/list" }), { aeStaffClient: client });
    expect(JSON.parse(roster.result.contents[0].text).roles[0].id).toBe("integration-engineer");
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:28643/health",
      "http://127.0.0.1:28643/staff",
    ]);
    expect(calls[1].options.headers.authorization).toBe("Bearer test-ae-staff-key");
  });

  test("dispatches an unchanged orange.order.v1 and returns validated orange.report.v1 evidence", async () => {
    const calls = [];
    const client = createAeStaffMcpClient({
      url: "http://127.0.0.1:28643",
      keyFile,
      fetchFn: async (url, options) => {
        calls.push({ url, options });
        const event = JSON.parse(options.body);
        return Response.json({
          event,
          observedCount: 50,
          addressed: [{ roleId: "integration-engineer", relevance: 1 }],
          candidates: [],
          results: [{
            roleId: "integration-engineer",
            ok: true,
            result: {
              schema: "orange.report.v1",
              orderId: event.order.orderId,
              status: "completed",
              confidence: 1,
              actionsTaken: ["verified the MCP adapter contract"],
              evidence: [{ kind: "test", path: "03-BACKEND/tests/orange5-brain-mcp-ae-staff.test.mjs" }],
              blockers: [],
              nextAction: "return to Navigator",
              receiptPath: "C:\\receipts\\ae-staff-order.json",
              receiptSha256: "abc123",
            },
          }],
          snapshot: {
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
          },
        }, { status: 202 });
      },
    });
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
    const sentEvent = JSON.parse(calls[0].options.body);

    expect(response.result.isError).toBe(false);
    expect(calls[0].url).toBe("http://127.0.0.1:28643/events");
    expect(calls[0].options.headers.authorization).toBe("Bearer test-ae-staff-key");
    expect(sentEvent.order).toEqual(order);
    expect(sentEvent.targetRoles).toEqual(["integration-engineer"]);
    expect(sentEvent.requiresModel).toBe(true);
    expect(result.schema).toBe("orange.ae-staff-mcp-dispatch.v1");
    expect(result.order).toEqual(order);
    expect(result.reports[0].schema).toBe("orange.report.v1");
    expect(result.reports[0].evidence).toHaveLength(1);
    expect(result.reactor.roles).toBeUndefined();
  });

  test("canonicalizes action-form orders for the shared CLI client and preserves per-role report correlation", async () => {
    let sentEvent;
    const client = createAeStaffMcpClient({
      url: "http://127.0.0.1:28643",
      keyFile,
      fetchFn: async (_url, options) => {
        sentEvent = JSON.parse(options.body);
        return Response.json({
          event: sentEvent,
          results: [{
            roleId: "integration-engineer",
            ok: true,
            result: {
              schema: "orange.report.v1",
              orderId: `${sentEvent.order.orderId}:integration-engineer`,
              status: "completed",
              confidence: 1,
              actionsTaken: ["completed the shared client order"],
              evidence: ["shared-client-contract"],
              blockers: [],
              nextAction: "return to Navigator",
              receiptPath: "C:\\receipts\\shared-client.json",
            },
          }],
        });
      },
    });

    const result = await client.order({
      order: { action: "build.feature", intent: "Build through the shared AE Staff client" },
      targetRoles: ["integration-engineer"],
    });

    expect(sentEvent.order.schema).toBe("orange.order.v1");
    expect(sentEvent.order.orderId).toStartWith("ae-staff-");
    expect(sentEvent.order.allowedActions).toEqual(["build.feature"]);
    expect(sentEvent.order.requiresReceipt).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.reports[0].orderId).toBe(`${sentEvent.order.orderId}:integration-engineer`);
  });

  test("rejects non-canonical orders before contacting AE Staff", async () => {
    let fetchCalls = 0;
    const client = createAeStaffMcpClient({
      url: "http://127.0.0.1:28643",
      keyFile,
      fetchFn: async () => { fetchCalls += 1; return Response.json({}); },
    });
    const response = await handleMcp(request(7, "tools/call", {
      name: "ae_staff_order",
      arguments: {
        order: { schema: "orange.order.v0", orderId: "bad-order", action: "build.tool" },
        targetRoles: ["integration-engineer"],
      },
    }), { aeStaffClient: client });
    expect(response.error.message).toContain("order.schema orange.order.v1");
    expect(fetchCalls).toBe(0);
  });

  test("rejects a completed AE Staff report without evidence instead of surfacing false green", async () => {
    const client = createAeStaffMcpClient({
      url: "http://127.0.0.1:28643",
      keyFile,
      fetchFn: async (_url, options) => {
        const event = JSON.parse(options.body);
        return Response.json({
          event,
          results: [{
            roleId: "false-green-hunter",
            ok: true,
            result: {
              schema: "orange.report.v1",
              orderId: event.order.orderId,
              status: "completed",
              confidence: 1,
              actionsTaken: ["claimed completion"],
              evidence: [],
              blockers: [],
              nextAction: "none",
              receiptPath: "C:\\receipts\\unproven.json",
            },
          }],
        });
      },
    });
    const response = await handleMcp(request(8, "tools/call", {
      name: "ae_staff_order",
      arguments: {
        order: { schema: "orange.order.v1", orderId: "false-green-1", action: "inspect.claim", requiresReceipt: true },
        targetRoles: ["false-green-hunter"],
      },
    }), { aeStaffClient: client });
    expect(response.error.code).toBe(-32000);
    expect(response.error.message).toContain("claimed completion without evidence");
  });

  test("fails closed before authenticated calls when the staff key file is unavailable", async () => {
    let fetchCalls = 0;
    const client = createAeStaffMcpClient({
      url: "http://127.0.0.1:28643",
      apiKey: "",
      keyFile: join(tempRoot, "missing-key.txt"),
      fetchFn: async () => { fetchCalls += 1; return Response.json({}); },
    });
    const response = await handleMcp(request(9, "tools/call", { name: "ae_staff_list", arguments: {} }), { aeStaffClient: client });
    expect(response.error.message).toContain("client key is unavailable");
    expect(response.error.message).not.toContain("test-ae-staff-key");
    expect(fetchCalls).toBe(0);
  });
});
