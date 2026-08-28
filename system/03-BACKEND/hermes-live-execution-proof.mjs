#!/usr/bin/env bun
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeGovernedTool } from "./hermes-effector.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const receiptDir = path.join(root, "10-RECEIPTS", "orange5-build");
const approvalDir = path.join(root, "08-HERMES", "approvals");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const approvalsBefore = overrideFiles();
let refusal = null;
try {
  await executeGovernedTool({ action: "process.run", projectRoot: root, command: [process.execPath, "--version"] });
} catch (error) {
  refusal = error?.message || String(error);
}

const readOrderId = `hermes-live-read-${stamp}`;
const readReport = await executeGovernedTool({
  action: "filesystem.read",
  projectRoot: root,
  path: "00-CHARTER/ORANGE5_MASTER_PLAN.md",
  maxBytes: 65_536,
  orderId: readOrderId,
});

const processOrderId = `hermes-live-process-${stamp}`;
const processReport = await executeGovernedTool({
  action: "process.run",
  projectRoot: root,
  path: ".",
  command: [process.execPath, "--version"],
  operatorApproved: true,
  timeoutMs: 30_000,
  orderId: processOrderId,
}, {
  projectRoot: root,
  trustInlineApproval: true,
});

const readReceipt = verifyReceipt(readReport.receiptPath);
const processReceipt = verifyReceipt(processReport.receiptPath);
const approvalsAfter = overrideFiles();
const readExecution = readReport.evidence.find((item) => item.type === "execution_result");
const processExecution = processReport.evidence.find((item) => item.type === "execution_result");
const readGates = readReport.evidence.find((item) => item.type === "hermes_gate_chain")?.gates || [];
const processGates = processReport.evidence.find((item) => item.type === "hermes_gate_chain")?.gates || [];
const checks = {
  unapproved_process_refused: refusal?.includes("requires operatorApproved=true") === true,
  live_file_read: readReport.ok === true && readExecution?.action === "filesystem.read" && readExecution?.bytes > 0,
  source_truth_read: readExecution?.content?.includes("Orange5") === true || readExecution?.content?.includes("OrangeFive") === true,
  read_eight_gates: readGates.length === 8 && readGates.every((gate) => gate.pass === true),
  approved_process_executed: processReport.ok === true && processExecution?.action === "process.run" && processExecution?.exit_code === 0,
  process_is_bun: /^\d+\.\d+\.\d+/.test(String(processExecution?.stdout || "").trim()),
  process_eight_gates: processGates.length === 8 && processGates.every((gate) => gate.pass === true),
  read_receipt_hash_valid: readReceipt.hashValid,
  process_receipt_hash_valid: processReceipt.hashValid,
  single_use_override_removed: approvalsAfter.length === approvalsBefore.length && approvalsBefore.every((name) => approvalsAfter.includes(name)),
};
const green = Object.values(checks).every(Boolean);
const proof = {
  schema: "orange5.hermes-live-execution-proof.v1",
  status: green ? "ORANGE5_HERMES_LIVE_EXECUTION_GREEN" : "ORANGE5_HERMES_LIVE_EXECUTION_NEEDS_WORK",
  generatedAt: new Date().toISOString(),
  gateway: process.env.ORANGE5_ORANGEBRAIN_URL || "http://127.0.0.1:1337",
  hermes: process.env.ORANGE5_HERMES_URL || "http://127.0.0.1:7430",
  checks,
  refusal,
  read: summarize(readReport, readExecution, readGates),
  process: summarize(processReport, processExecution, processGates),
};
proof.sha256 = sha(JSON.stringify(proof));
const receiptPath = path.join(receiptDir, `${stamp}-hermes-live-execution-proof.json`);
fs.mkdirSync(receiptDir, { recursive: true });
fs.writeFileSync(receiptPath, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ...proof, receiptPath }, null, 2));
if (!green) process.exit(1);

function summarize(report, execution, gates) {
  return {
    orderId: report.orderId,
    status: report.status,
    action: execution?.action,
    exitCode: execution?.exit_code ?? null,
    bytes: execution?.bytes ?? null,
    resultHash: execution?.result_hash,
    gates: gates.map((gate) => gate.id),
    receiptPath: report.receiptPath,
    receiptSha256: report.evidence.find((item) => item.type === "receipt")?.sha256,
  };
}

function verifyReceipt(file) {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const claimed = parsed.receipt_hash;
  delete parsed.receipt_hash;
  return { hashValid: claimed === sha(stable(parsed)), claimed };
}

function overrideFiles() {
  if (!fs.existsSync(approvalDir)) return [];
  return fs.readdirSync(approvalDir).filter((name) => /^override-.*\.json$/i.test(name)).sort();
}

function sha(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function stable(value) {
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => JSON.parse(stable(item))));
  if (value && typeof value === "object") return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map((key) => [key, JSON.parse(stable(value[key]))])));
  return JSON.stringify(value);
}
