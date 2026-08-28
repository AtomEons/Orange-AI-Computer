#!/usr/bin/env bun
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CURRENT_PROTOCOL, SERVER } from "./orange5-brain-mcp-server.mjs";
import { startBrainMcpHttp } from "./orange5-brain-mcp-http.mjs";
import { StdioMcpClient } from "./mcp-stdio-client.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(root, "03-BACKEND", "orange5-brain-mcp-server.mjs");
const token = crypto.randomBytes(32).toString("hex");
const httpServer = startBrainMcpHttp({ port: 0, token });
const base = httpServer.url.toString().replace(/\/$/, "");
const stdio = new StdioMcpClient({ command: process.execPath, args: [serverPath], timeoutMs: 20_000 });

let stdioInfo;
let stdioTools;
let stdioHealth;
let discover;
let httpTools;
let httpHealth;
let originStatus;
try {
  stdioInfo = await stdio.start();
  stdioTools = await stdio.listTools();
  stdioHealth = parseTool(await stdio.callTool("orange5_health", {}));

  discover = await post(1, "server/discover");
  httpTools = await post(2, "tools/list");
  httpHealth = await post(3, "tools/call", { name: "orange5_health", arguments: {} }, "orange5_health");
  const rejected = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: headers("tools/list", null, { Origin: "https://invalid.example" }),
    body: JSON.stringify(message(4, "tools/list")),
  });
  originStatus = rejected.status;
} finally {
  await stdio.close();
  httpServer.stop(true);
}

const httpHealthBody = parseTool(httpHealth.result);
const legacyToolNames = new Set(stdioTools.tools.map((tool) => tool.name));
const currentToolNames = new Set((httpTools.result?.tools || []).map((tool) => tool.name));
const coreTools = [
  'orange5_health', 'orange5_order', 'orange5_route', 'orange5_chat',
  'orange5_receipts', 'orange5_party_line_read', 'orange5_party_line_post',
  'orange5_party_line_hydrate', 'orange5_superstack', 'orange5_model_lease',
  'orange5_delegate', 'orange5_execute', 'orange5_browser',
];
const currentExtensionTools = ['orange5_swarmgate_plan', 'orange5_swarm_sentinel_inspect'];
const checks = {
  stdio_server_identity: stdioInfo.serverInfo?.name === SERVER.name,
  stdio_tools_present: coreTools.every((name) => legacyToolNames.has(name)),
  stdio_live_health: stdioHealth.schema === "orange.health.v1" && stdioHealth.release === "OrangeFive",
  http_discovery_current: discover.result?.supportedVersions?.includes(CURRENT_PROTOCOL) === true,
  http_server_identity: discover.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.name === SERVER.name,
  http_tools_cacheable: [...coreTools, ...currentExtensionTools].every((name) => currentToolNames.has(name))
    && currentToolNames.size >= legacyToolNames.size
    && httpTools.result?.ttlMs === 60_000
    && httpTools.result?.cacheScope === 'shared',
  http_live_health: httpHealthBody.schema === "orange.health.v1" && httpHealthBody.release === "OrangeFive",
  http_origin_guard: originStatus === 403,
  transport_parity: stdioHealth.schema === httpHealthBody.schema
    && stdioHealth.release === httpHealthBody.release
    && stdioHealth.gateway?.ready === httpHealthBody.gateway?.ready
    && stdioHealth.codexa?.host === httpHealthBody.codexa?.host,
};
const green = Object.values(checks).every(Boolean);
const proof = {
  schema: "orange5.brain-mcp-dual-transport-proof.v1",
  status: green ? "ORANGE5_BRAIN_MCP_DUAL_TRANSPORT_GREEN" : "ORANGE5_BRAIN_MCP_DUAL_TRANSPORT_NEEDS_WORK",
  generatedAt: new Date().toISOString(),
  server: SERVER,
  protocol: CURRENT_PROTOCOL,
  transports: {
    stdio: { protocol: '2025-06-18', toolCount: stdioTools.tools.length },
    streamableHttp: {
      protocol: CURRENT_PROTOCOL,
      endpoint: "/mcp",
      loopbackOnly: true,
      authenticatedDuringProof: true,
      toolCount: httpTools.result?.tools?.length ?? 0,
      ttlMs: httpTools.result?.ttlMs ?? null,
      cacheScope: httpTools.result?.cacheScope ?? null,
    },
  },
  checks,
  observedHealth: {
    stdioStatus: stdioHealth.status,
    httpStatus: httpHealthBody.status,
    statusDriftObserved: stdioHealth.status !== httpHealthBody.status,
    gatewayReady: httpHealthBody.gateway?.ready,
    codexa: httpHealthBody.codexa || null,
  },
};
proof.sha256 = crypto.createHash("sha256").update(JSON.stringify(proof)).digest("hex");

const stamp = proof.generatedAt.replace(/[:.]/g, "-");
const repoDir = path.join(root, "10-RECEIPTS", "orange5-build");
const userDir = path.join(os.homedir(), "OrangeBox-Data", "orange5", "receipts");
fs.mkdirSync(repoDir, { recursive: true });
fs.mkdirSync(userDir, { recursive: true });
const receiptPath = path.join(repoDir, `${stamp}-brain-mcp-dual-transport-proof.json`);
const latestPath = path.join(userDir, "orangefive-brain-mcp-dual-transport-proof-latest.json");
const encoded = `${JSON.stringify(proof, null, 2)}\n`;
fs.writeFileSync(receiptPath, encoded, "utf8");
fs.writeFileSync(latestPath, encoded, "utf8");
console.log(JSON.stringify({ ...proof, receiptPath, latestPath }, null, 2));
if (!green) process.exit(1);

function message(id, method, params = {}) {
  return { jsonrpc: "2.0", id, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": CURRENT_PROTOCOL, "io.modelcontextprotocol/clientInfo": { name: "orangefive-proof", version: "1.0.0" }, "io.modelcontextprotocol/clientCapabilities": {} } } };
}

function headers(method, name = null, extra = {}) {
  return { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json", "MCP-Protocol-Version": CURRENT_PROTOCOL, "Mcp-Method": method, ...(name ? { "Mcp-Name": name } : {}), ...extra };
}

async function post(id, method, params = {}, name = null) {
  const response = await fetch(`${base}/mcp`, { method: "POST", headers: headers(method, name), body: JSON.stringify(message(id, method, params)) });
  const body = await response.json();
  if (!response.ok) throw new Error(`MCP HTTP ${method} failed: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

function parseTool(result) {
  return JSON.parse(result.content[0].text);
}
