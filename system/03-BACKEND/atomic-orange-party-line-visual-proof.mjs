import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { executeBrowserWorkflow } from "./browser-mcp-effector.mjs";
import { writeChainedJsonReceipt } from "../10-RECEIPTS/tools/json-receipt-chain.mjs";

const ROOT = path.resolve(import.meta.dir, "..");
const APP_ROOT = path.join(ROOT, "02-ATOMIC-ORANGE-V1");
const RECEIPT_DIR = path.join(ROOT, "10-RECEIPTS", "orange5-build");
const APP_URL = process.env.ORANGE5_ATOMIC_ORANGE_URL || "http://127.0.0.1:4176/";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const orderId = `atomic-orange-party-line-${stamp}`;
const started = performance.now();

const workflow = await executeBrowserWorkflow({
  orderId,
  actor: "orangefive-visual-proof",
  operatorApproved: true,
  projectRoot: APP_ROOT,
  steps: [
    { tool: "navigate_page", args: { url: APP_URL } },
    { tool: "take_snapshot", args: {} },
    { tool: "click", args: { uid: "1_22" } },
    { tool: "take_snapshot", args: {} },
    { tool: "take_screenshot", args: { fullPage: true, format: "png" } },
    { tool: "list_console_messages", args: {} },
  ],
});

const steps = workflow.evidence?.find((item) => item.type === "browser_mcp_workflow")?.steps || [];
const openSnapshot = steps[3]?.result?.content?.find((item) => item.type === "text")?.text || "";
const consoleText = steps[5]?.result?.content?.find((item) => item.type === "text")?.text || "";
const image = steps[4]?.result?.content?.find((item) => item.type === "image") || null;
const eventMatch = openSnapshot.match(/StaticText \"(\d+)\"\s*\n\s+uid=.*StaticText \" EVENTS/);
const actorMatch = openSnapshot.match(/EVENTS \/ \"\s*\n\s+uid=.*StaticText \"(\d+)\"\s*\n\s+uid=.*StaticText \" ACTORS/);
const eventCount = Number(eventMatch?.[1] || 0);
const actorCount = Number(actorMatch?.[1] || 0);
const orangeFetchFailure = /(?:blocked by CORS|Failed to fetch)[^\n]*(?:127\.0\.0\.1:1337|\/v1\/party-line)/i.test(consoleText)
  || /127\.0\.0\.1:1337[^\n]*blocked by CORS/i.test(consoleText);

const checks = {
  governed_browser_workflow: workflow.ok === true,
  party_line_dialog_open: openSnapshot.includes('dialog "ORANGE PARTY LINE"'),
  chromatic_signal_field_present: openSnapshot.includes('region "Live Party Line signal field"'),
  disk_events_visible: eventCount > 0,
  multiple_actors_visible: actorCount > 1,
  party_line_fetch_clean: !openSnapshot.includes("Failed to fetch") && orangeFetchFailure === false,
  screenshot_persisted: Boolean(image?.path) && fs.existsSync(image.path) && Number(image.bytes) > 10_000,
  screenshot_hash_present: /^[a-f0-9]{64}$/.test(String(image?.sha256 || "")),
};
const green = Object.values(checks).every(Boolean);
const proof = {
  schema: "orange5.atomic-orange-party-line-visual-proof.v1",
  status: green ? "ATOMIC_ORANGE_PARTY_LINE_VISUAL_GREEN" : "ATOMIC_ORANGE_PARTY_LINE_VISUAL_NEEDS_WORK",
  generatedAt: new Date().toISOString(),
  elapsedMs: Number((performance.now() - started).toFixed(2)),
  appUrl: APP_URL,
  checks,
  evidence: {
    eventCount,
    actorCount,
    screenshot: image,
    browserWorkflowReceipt: workflow.receiptPath,
    browserWorkflowSha256: workflow.evidence?.find((item) => item.type === "receipt")?.sha256 || null,
    relevantConsoleErrors: consoleText.split(/\r?\n/).filter((line) => /(?:127\.0\.0\.1:1337|\/v1\/party-line).*(?:error|failed|cors)/i.test(line)),
  },
};
proof.sha256 = crypto.createHash("sha256").update(JSON.stringify(proof)).digest("hex");
const receiptPath = path.join(RECEIPT_DIR, `${stamp}-atomic-orange-party-line-visual-proof.json`);
writeChainedJsonReceipt(receiptPath, proof);

console.log(JSON.stringify({ ...proof, receiptPath }, null, 2));
if (!green) process.exitCode = 1;
