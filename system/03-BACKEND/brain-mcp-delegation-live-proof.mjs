#!/usr/bin/env bun
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeChainedJsonReceipt } from "../10-RECEIPTS/tools/json-receipt-chain.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const endpoint = (process.env.ORANGE5_BRAIN_MCP_HTTP_URL || "http://127.0.0.1:7431/mcp").replace(/\/$/, "");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const orderId = `brain-mcp-live-${stamp}`;
const order = {
  schema: "orange.order.v1",
  orderId,
  action: "filesystem.read",
  intent: "Read the OrangeFive master plan title using governed evidence.",
  scope: "00-CHARTER/ORANGE5_MASTER_PLAN.md",
  maxAgents: 1,
  allowedActions: ["filesystem.read"],
  forbiddenActions: ["destructive_write", "production_deploy", "scope_expansion", "egress_unbounded"],
  targetProject: "orange5",
  riskLevel: "read_only",
  requiresReceipt: true,
  payload: { path: "00-CHARTER/ORANGE5_MASTER_PLAN.md", maxBytes: 4096 },
};
const request = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: {
    name: "orange5_delegate",
    arguments: { order, execute: true },
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "orangefive-live-proof", version: "1.0.0" },
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  },
};

const started = performance.now();
const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": "tools/call",
    "mcp-name": "orange5_delegate",
  },
  body: JSON.stringify(request),
  signal: AbortSignal.timeout(180_000),
});
const envelope = await response.json();
const result = JSON.parse(envelope?.result?.content?.[0]?.text || "null");
const executionReports = [
  ...(result?.reports || []).map((item) => item?.result?.report),
  result?.synthesis?.result?.report,
].filter(Boolean);
const checks = {
  http_ok: response.ok,
  delegation_complete: result?.status === "DELEGATION_COMPLETE",
  parent_execution_mediated: result?.governance?.parentExecutionMediated === true,
  parent_execution_ok: result?.governance?.parentExecution?.status === "ok",
  parent_receipt_exists: fs.existsSync(result?.governance?.parentExecution?.receiptPath || ""),
  one_child_complete: result?.reports?.length === 1 && result.reports[0]?.ok === true && result.reports[0]?.result?.status === "completed",
  synthesis_complete: result?.synthesis?.ok === true && result.synthesis?.result?.status === "completed",
  hermes_authorized_all: result?.governance?.hermesAuthorizedActions === 2,
  hermes_lease_revoked: result?.governance?.hermesLeaseRevoked === true,
  approved_least_action_path_used: executionReports.length === 2 && executionReports.every((report) => (
    report?.model === "orange-navigator:ornith-1.5-9b-q4km"
    || (report?.model == null && report?.lane === "reflex")
  )),
};
const green = Object.values(checks).every(Boolean);
const proof = {
  schema: "orange5.brain-mcp-delegation-live-proof.v1",
  status: green ? "ORANGE5_BRAIN_MCP_DELEGATION_GREEN" : "ORANGE5_BRAIN_MCP_DELEGATION_NEEDS_WORK",
  generatedAt: new Date().toISOString(),
  endpoint,
  elapsedMs: Math.round((performance.now() - started) * 100) / 100,
  checks,
  delegation: {
    id: result?.delegationId || null,
    orderId: result?.orderId || orderId,
    department: result?.littleNavigator?.department || null,
    parentExecution: result?.governance?.parentExecution || null,
    agentModel: result?.governance?.agentModel || null,
    childReceipts: (result?.reports || []).map((item) => item?.result?.receipt || null),
    childReports: (result?.reports || []).map((item) => ({
      ok: item?.ok === true,
      status: item?.result?.status || null,
      lane: item?.result?.report?.lane || null,
      model: item?.result?.report?.model || null,
      output: item?.result?.report?.output || null,
      modelAuthority: item?.result?.report?.evidence?.modelAuthority || null,
    })),
    synthesisReceipt: result?.synthesis?.result?.receipt || null,
    synthesisReport: result?.synthesis ? {
      ok: result.synthesis?.ok === true,
      status: result.synthesis?.result?.status || null,
      lane: result.synthesis?.result?.report?.lane || null,
      model: result.synthesis?.result?.report?.model || null,
      output: result.synthesis?.result?.report?.output || null,
      modelAuthority: result.synthesis?.result?.report?.evidence?.modelAuthority || null,
    } : null,
  },
  error: envelope?.error || result?.error || result?.blockers || null,
};
proof.sha256 = crypto.createHash("sha256").update(JSON.stringify(proof)).digest("hex");
const receiptDir = path.join(root, "10-RECEIPTS", "orange5-build");
const receiptPath = path.join(receiptDir, `${stamp}-brain-mcp-delegation-live-proof.json`);
fs.mkdirSync(receiptDir, { recursive: true });
writeChainedJsonReceipt(receiptPath, proof);
console.log(JSON.stringify({ ...proof, receiptPath }, null, 2));
if (!green) process.exitCode = 1;
