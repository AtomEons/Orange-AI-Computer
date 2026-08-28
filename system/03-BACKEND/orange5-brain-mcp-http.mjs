#!/usr/bin/env bun
import { CURRENT_PROTOCOL, SERVER, SUPPORTED_PROTOCOLS, handleMcp } from "./orange5-brain-mcp-server.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7431;
const MAX_BODY_BYTES = 1024 * 1024;
const NAME_METHODS = new Set(["tools/call", "resources/read", "prompts/get"]);

export function startBrainMcpHttp(options = {}) {
  const hostname = options.hostname || process.env.ORANGE5_MCP_HTTP_HOST || DEFAULT_HOST;
  if (!isLoopbackHost(hostname)) throw new Error(`OrangeFive MCP HTTP refuses non-loopback bind: ${hostname}`);
  const port = Number(options.port ?? process.env.ORANGE5_MCP_HTTP_PORT ?? DEFAULT_PORT);
  const token = options.token ?? process.env.ORANGE5_MCP_TOKEN ?? "";
  return Bun.serve({
    hostname,
    port,
    idleTimeout: 255,
    fetch: (request, server) => {
      if (request.method === "POST") server.timeout(request, 255);
      return handleMcpHttp(request, { token });
    },
  });
}

export async function handleMcpHttp(request, options = {}) {
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
    return jsonResponse({ ok: true, schema: "orange.mcp-http-health.v1", server: SERVER, protocol: CURRENT_PROTOCOL, endpoint: "/mcp", transport: "streamable-http", authRequired: Boolean(options.token) });
  }
  if (url.pathname !== "/mcp") return jsonError(null, -32601, "MCP endpoint not found", 404);
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });

  const origin = request.headers.get("origin");
  if (origin && !isAllowedOrigin(origin)) return jsonError(null, -32000, "Forbidden Origin", 403);
  if (options.token && request.headers.get("authorization") !== `Bearer ${options.token}`) {
    return jsonError(null, -32000, "Unauthorized", 401, { "WWW-Authenticate": "Bearer" });
  }
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("application/json")) return jsonError(null, -32600, "Content-Type must be application/json", 415);
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) return jsonError(null, -32600, "MCP request body exceeds 1 MiB", 413);

  let message;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return jsonError(null, -32600, "MCP request body exceeds 1 MiB", 413);
    message = JSON.parse(text);
  } catch {
    return jsonError(null, -32700, "Parse error", 400);
  }
  if (!message || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return jsonError(message?.id ?? null, -32600, "Invalid JSON-RPC request", 400);
  }

  const validation = validateTransportMetadata(request.headers, message);
  if (!validation.ok) return jsonError(message.id ?? null, validation.code, validation.message, validation.status, validation.headers);

  const isNotification = !Object.prototype.hasOwnProperty.call(message, "id");
  if (isNotification) {
    // Notifications are acknowledgement-only at this transport boundary.
    // In particular, an id-less tools/call must never reach the tool handler.
    return new Response(null, { status: 202 });
  }
  const response = await handleMcp(message);
  if (!response) return jsonError(message.id ?? null, -32603, "MCP handler returned no response", 500);
  const status = response.error?.code === -32601 ? 404 : 200;
  return jsonResponse(response, status);
}

export function validateTransportMetadata(headers, message) {
  const protocolHeader = headers.get("mcp-protocol-version");
  const bodyProtocol = message.params?._meta?.["io.modelcontextprotocol/protocolVersion"]
    || (message.method === "initialize" ? message.params?.protocolVersion : null);
  // MCP clients negotiate the protocol in the initialize body. The
  // MCP-Protocol-Version header is required only on subsequent HTTP requests;
  // demanding it during initialize rejects standards-compliant SDK clients.
  const negotiatedProtocol = protocolHeader || bodyProtocol;
  if (message.method === "initialize" && !bodyProtocol) {
    return mismatch("initialize request is missing params.protocolVersion");
  }
  if (protocolHeader && bodyProtocol && protocolHeader !== bodyProtocol) {
    return mismatch(`MCP-Protocol-Version header '${protocolHeader}' does not match body value '${bodyProtocol}'`);
  }
  if (negotiatedProtocol && !SUPPORTED_PROTOCOLS.includes(negotiatedProtocol)) {
    return { ok: false, code: -32022, status: 400, message: `Unsupported protocol version: ${negotiatedProtocol}`, headers: { "MCP-Supported-Versions": SUPPORTED_PROTOCOLS.join(", ") } };
  }
  const accept = (headers.get("accept") || "").toLowerCase();
  if (negotiatedProtocol === CURRENT_PROTOCOL && (!accept.includes("application/json") || !accept.includes("text/event-stream"))) {
    return mismatch("Accept header must include application/json and text/event-stream");
  }
  // Mcp-Method and Mcp-Name are Orange diagnostic extensions, not MCP
  // transport requirements. Validate them when supplied, but never require a
  // third-party client to know Orange-private headers.
  const methodHeader = headers.get("mcp-method");
  if (methodHeader && methodHeader !== message.method) return mismatch(`Mcp-Method header '${methodHeader}' does not match body method '${message.method}'`);
  if (NAME_METHODS.has(message.method)) {
    const bodyName = message.params?.name ?? message.params?.uri;
    const rawHeader = headers.get("mcp-name");
    const headerName = decodeHeaderValue(rawHeader);
    if (rawHeader && headerName !== bodyName) return mismatch(`Mcp-Name header does not match body value '${bodyName || "<missing>"}'`);
  }
  return { ok: true };
}

function mismatch(message) {
  return { ok: false, code: -32020, status: 400, message: `Header mismatch: ${message}` };
}

function decodeHeaderValue(value) {
  if (!value) return null;
  const match = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/.exec(value);
  if (!match) return value;
  try { return Buffer.from(match[1], "base64").toString("utf8"); }
  catch { return null; }
}

function isAllowedOrigin(origin) {
  try {
    const parsed = new URL(origin);
    return ["http:", "https:"].includes(parsed.protocol) && isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

function isLoopbackHost(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

function jsonError(id, code, message, status, headers = {}) {
  return jsonResponse({ jsonrpc: "2.0", id, error: { code, message } }, status, headers);
}

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
}

if (import.meta.main) {
  const server = startBrainMcpHttp();
  process.stdout.write(`${JSON.stringify({ ok: true, server: SERVER, protocol: CURRENT_PROTOCOL, url: server.url.toString(), endpoint: new URL("/mcp", server.url).toString() })}\n`);
}
