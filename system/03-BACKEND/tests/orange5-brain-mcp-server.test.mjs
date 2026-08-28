import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import path from "node:path";
import { handleMcp, SERVER } from "../orange5-brain-mcp-server.mjs";

const request = (id, method, params = {}) => ({ jsonrpc: "2.0", id, method, params });
const taskMeta = {
  "io.modelcontextprotocol/clientCapabilities": {
    extensions: { "io.modelcontextprotocol/tasks": {} }
  }
};

describe("OrangeFive Brain MCP", () => {
  test("initializes as the canonical OrangeFive server", async () => {
    const response = await handleMcp(request(1, "initialize", { protocolVersion: "2025-06-18" }));
    expect(response.result.serverInfo).toEqual(SERVER);
    expect(response.result.capabilities.tools).toBeDefined();
    expect(response.result.instructions).toContain("Atomic Orange is optional");
  });

  test("advertises the current Tasks extension only to current protocol clients", async () => {
    const current = await handleMcp(request(101, "initialize", { protocolVersion: "2026-07-28" }));
    const legacy = await handleMcp(request(102, "initialize", { protocolVersion: "2025-11-25" }));
    expect(current.result.capabilities.extensions["io.modelcontextprotocol/tasks"]).toEqual({});
    expect(legacy.result.capabilities.extensions).toBeUndefined();
  });

  test("publishes the independent headless tool set", async () => {
    const response = await handleMcp(request(2, "tools/list"));
    expect(response.result.tools.map((tool) => tool.name)).toEqual([
      "orange5_health",
      "orange5_order",
      "orange5_route",
      "orange5_chat",
      "orange5_receipts",
      "orange5_party_line_read",
      "orange5_party_line_post",
      "orange5_party_line_hydrate",
      "orange5_superstack",
      "orange5_model_lease",
      "orange5_delegate",
      "orange5_execute",
      "orange5_browser"
    ]);
  });

  test("returns live health through a real tool call", async () => {
    const response = await handleMcp(request(3, "tools/call", { name: "orange5_health", arguments: {} }));
    const body = JSON.parse(response.result.content[0].text);
    expect(body.schema).toBe("orange.health.v1");
    expect(body.product).toBe("Orange");
    expect(body.release).toBe("OrangeFive");
    expect(typeof body.gateway.ready).toBe("boolean");
  });

  test("publishes live superstack truth and refuses an unapproved model swap", async () => {
    const status = await handleMcp(request(31, "tools/call", { name: "orange5_superstack", arguments: {} }));
    const body = JSON.parse(status.result.content[0].text);
    expect(body.schema).toBe("orange.model-superset.v1");
    expect(body.policy.live_model_memory_ceiling_bytes).toBe(50 * 1024 ** 3);
    const refused = await handleMcp(request(32, "tools/call", { name: "orange5_model_lease", arguments: { role: "conductor_code_vision" } }));
    expect(JSON.parse(refused.result.content[0].text).status).toBe("OPERATOR_APPROVAL_REQUIRED");
  });

  test("rejects unknown methods and tools honestly", async () => {
    const method = await handleMcp(request(4, "fake/method"));
    expect(method.error.code).toBe(-32601);
    const tool = await handleMcp(request(5, "tools/call", { name: "fake_tool", arguments: {} }));
    expect(tool.error.message).toContain("unknown OrangeFive tool");
  });

  test("lists governed resources and prompts", async () => {
    const resourceResponse = await handleMcp(request(6, "resources/list"));
    expect(resourceResponse.result.resources.some((item) => item.uri === "orange5://health")).toBe(true);
    expect(resourceResponse.result.resources.some((item) => item.uri === "orange5://party-line/latest")).toBe(true);
    const promptResponse = await handleMcp(request(7, "prompts/list"));
    expect(promptResponse.result.prompts.map((item) => item.name)).toContain("orange5-lead");
  });

  test("awaits asynchronous resource reads before returning JSON-RPC", async () => {
    const response = await handleMcp(request(71, "resources/read", { uri: "orange5://manual" }));
    expect(Array.isArray(response.result.contents)).toBe(true);
    expect(response.result.contents[0].mimeType).toBe("text/markdown");
    expect(response.result.contents[0].text).toContain("OrangeFive");
  });

  test("never executes an id-less tools/call notification", async () => {
    const response = await handleMcp({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "orange5_model_lease", arguments: { role: "not-a-real-role", operatorApproved: true } },
    });
    expect(response).toBeNull();
  });

  test("runs a durable task roundtrip without exposing unsafe task listing", async () => {
    const created = await handleMcp(request(103, "tools/call", {
      name: "orange5_delegate",
      arguments: {
        execute: false,
        order: {
          action: "query.chat",
          intent: "prove durable MCP task execution",
          targetProject: "OrangeFive",
          allowedActions: ["query.chat"],
          forbiddenActions: ["filesystem.delete"],
          riskLevel: "read_only",
          requiresReceipt: true
        }
      },
      _meta: taskMeta
    }));
    expect(created.result.resultType).toBe("task");
    expect(created.result.taskId).toStartWith("task_");

    let polled;
    await waitFor(async () => {
      polled = await handleMcp(request(104, "tasks/get", { taskId: created.result.taskId, _meta: taskMeta }));
      return polled.result?.status === "completed";
    }, 5_000);
    expect(polled.result.resultType).toBe("complete");
    expect(polled.result.result._meta["io.modelcontextprotocol/related-task"].taskId).toBe(created.result.taskId);
    expect(JSON.parse(polled.result.result.content[0].text).status).toBe("PLANNED_NOT_EXECUTED");

    const unsafeList = await handleMcp(request(105, "tasks/list", { _meta: taskMeta }));
    expect(unsafeList.error.code).toBe(-32601);
  });

  test("rejects task access without per-request extension capability", async () => {
    const response = await handleMcp(request(106, "tasks/get", { taskId: "task_not_visible" }));
    expect(response.error.code).toBe(-32021);
  });

  test("completes a real stdio initialize and tools handshake", async () => {
    const serverPath = path.resolve(import.meta.dir, "../orange5-brain-mcp-server.mjs");
    const child = spawn(process.execPath, [serverPath], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const responses = [];
    let buffered = "";
    child.stdout.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() || "";
      for (const line of lines.filter(Boolean)) responses.push(JSON.parse(line));
    });
    child.stdin.write(`${JSON.stringify(request(11, "initialize", { protocolVersion: "2025-06-18" }))}\n`);
    child.stdin.write(`${JSON.stringify(request(12, "tools/list"))}\n`);
    await waitFor(() => responses.length >= 2, 5_000);
    child.stdin.end();
    expect(responses.find((item) => item.id === 11)?.result?.serverInfo?.name).toBe("orangefive-brain");
    expect(responses.find((item) => item.id === 12)?.result?.tools?.length).toBe(13);
  });
});

async function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error("stdio MCP handshake timed out");
    await Bun.sleep(20);
  }
}
