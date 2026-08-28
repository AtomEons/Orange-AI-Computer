import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CURRENT_PROTOCOL, SERVER } from "../orange5-brain-mcp-server.mjs";
import { startBrainMcpHttp } from "../orange5-brain-mcp-http.mjs";

let server;
let base;

beforeAll(() => {
  server = startBrainMcpHttp({ port: 0, token: "test-token" });
  base = server.url.toString().replace(/\/$/, "");
});

afterAll(() => server?.stop(true));

describe("OrangeFive Brain MCP Streamable HTTP", () => {
  test("publishes a direct transport health endpoint", async () => {
    const response = await fetch(`${base}/health`);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.transport).toBe("streamable-http");
    expect(body.protocol).toBe(CURRENT_PROTOCOL);
    expect(body.authRequired).toBe(true);
  });

  test("discovers the modern stateless server with identity and cache hints", async () => {
    const message = modernRequest(1, "server/discover");
    const response = await post(message);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.result.supportedVersions).toEqual([CURRENT_PROTOCOL]);
    expect(body.result.ttlMs).toBeGreaterThan(0);
    expect(body.result._meta["io.modelcontextprotocol/serverInfo"]).toEqual(SERVER);
  });

  test("lists cacheable tools without a legacy initialize handshake", async () => {
    const response = await post(modernRequest(2, "tools/list"));
    const body = await response.json();
    const names = body.result.tools.map((tool) => tool.name);
    expect(body.result.tools.length).toBeGreaterThanOrEqual(15);
    expect(names).toEqual(expect.arrayContaining([
      "orange5_health",
      "orange5_execute",
      "orange5_browser",
      "orange5_swarmgate_plan",
      "orange5_swarm_sentinel_inspect",
    ]));
    expect(body.result.ttlMs).toBe(60_000);
    expect(body.result.cacheScope).toBe("shared");
  });

  test("calls the real OrangeFive health tool over HTTP", async () => {
    const response = await post(modernRequest(3, "tools/call", { name: "orange5_health", arguments: {} }), { name: "orange5_health" });
    const body = await response.json();
    const health = JSON.parse(body.result.content[0].text);
    expect(response.status).toBe(200);
    expect(health.schema).toBe("orange.health.v1");
    expect(health.release).toBe("OrangeFive");
  });

  test("rejects unauthenticated access, bad origins, and header-body drift", async () => {
    const message = modernRequest(4, "tools/list");
    const unauthenticated = await fetch(`${base}/mcp`, { method: "POST", headers: currentHeaders(message, { authorization: "" }), body: JSON.stringify(message) });
    expect(unauthenticated.status).toBe(401);

    const badOrigin = await fetch(`${base}/mcp`, { method: "POST", headers: currentHeaders(message, { origin: "https://attacker.example" }), body: JSON.stringify(message) });
    expect(badOrigin.status).toBe(403);

    const mismatchResponse = await fetch(`${base}/mcp`, { method: "POST", headers: currentHeaders(message, { "Mcp-Method": "resources/list" }), body: JSON.stringify(message) });
    const mismatch = await mismatchResponse.json();
    expect(mismatchResponse.status).toBe(400);
    expect(mismatch.error.code).toBe(-32020);
  });

  test("accepts a missing diagnostic Mcp-Name and rejects an incorrect one", async () => {
    const message = modernRequest(5, "tools/call", { name: "orange5_health", arguments: {} });
    const compatible = await fetch(`${base}/mcp`, { method: "POST", headers: currentHeaders(message), body: JSON.stringify(message) });
    expect(compatible.status).toBe(200);
    const incorrect = await fetch(`${base}/mcp`, { method: "POST", headers: currentHeaders(message, { "Mcp-Name": "orange5_route" }), body: JSON.stringify(message) });
    const body = await incorrect.json();
    expect(incorrect.status).toBe(400);
    expect(body.error.code).toBe(-32020);
  });

  test("retains the legacy initialize era on the same endpoint", async () => {
    const message = { jsonrpc: "2.0", id: 6, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy-test", version: "1" } } };
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-11-25",
        "Mcp-Method": "initialize",
      },
      body: JSON.stringify(message),
    });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.result.protocolVersion).toBe("2025-11-25");
    expect(body.result.serverInfo.name).toBe("orangefive-brain");
  });

  test("returns 202 for an accepted notification and 405 for GET /mcp", async () => {
    const notification = modernRequest(undefined, "notifications/cancelled", { requestId: 99, reason: "test" });
    delete notification.id;
    const accepted = await post(notification);
    expect(accepted.status).toBe(202);
    expect(await accepted.text()).toBe("");
    const get = await fetch(`${base}/mcp`, { headers: { Authorization: "Bearer test-token" } });
    expect(get.status).toBe(405);
  });

  test("acknowledges but never dispatches an id-less tool call", async () => {
    const notification = modernRequest(undefined, "tools/call", {
      name: "orange5_model_lease",
      arguments: { role: "not-a-real-role", operatorApproved: true },
    });
    delete notification.id;
    const accepted = await post(notification, { name: "orange5_model_lease" });
    expect(accepted.status).toBe(202);
    expect(await accepted.text()).toBe("");
  });
});

function modernRequest(id, method, params = {}) {
  return {
    jsonrpc: "2.0",
    ...(id === undefined ? {} : { id }),
    method,
    params: {
      ...params,
      _meta: {
        ...(params._meta || {}),
        "io.modelcontextprotocol/protocolVersion": CURRENT_PROTOCOL,
        "io.modelcontextprotocol/clientInfo": { name: "orangefive-http-test", version: "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": params._meta?.["io.modelcontextprotocol/clientCapabilities"] || {},
      },
    },
  };
}

function currentHeaders(message, overrides = {}) {
  return {
    Authorization: "Bearer test-token",
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "MCP-Protocol-Version": message.params._meta["io.modelcontextprotocol/protocolVersion"],
    "Mcp-Method": message.method,
    ...overrides,
  };
}

function post(message, options = {}) {
  const headers = currentHeaders(message);
  if (options.name) headers["Mcp-Name"] = options.name;
  return fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify(message) });
}
