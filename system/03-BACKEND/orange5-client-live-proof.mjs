#!/usr/bin/env bun
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLIENTS, SKILL_ROOTS, install } from "./install-orange5-clients.mjs";
import { StdioMcpClient } from "./mcp-stdio-client.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(root, "03-BACKEND", "orange5-brain-mcp-server.mjs");
const parity = install({ dryRun: true });
const client = new StdioMcpClient({ command: process.execPath, args: [serverPath], timeoutMs: 20_000 });

let initialized;
let tools;
let health;
try {
  initialized = await client.start();
  tools = await client.listTools();
  const result = await client.callTool("orange5_health", {});
  health = JSON.parse(result.content[0].text);
} finally {
  await client.close();
}

const expectedSkills = ["orange5", "orangebox-primer"];
const activeSkillFolders = Object.fromEntries(Object.entries(SKILL_ROOTS).map(([name, skillRoot]) => [
  name,
  fs.existsSync(skillRoot)
    ? fs.readdirSync(skillRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /orange|aefactory|aeskill|^ae-/i.test(entry.name))
      .map((entry) => entry.name).sort()
    : [],
]));
const skillRootsClean = Object.values(activeSkillFolders).every((folders) =>
  folders.length === expectedSkills.length && expectedSkills.every((name) => folders.includes(name))
);
const configsCurrent = parity.ok && parity.results.every((item) => item.status === "CURRENT");
const skillsCurrent = parity.skills.every((item) => item.status === "CURRENT");
const toolNames = tools.tools.map((tool) => tool.name);
const requiredTools = ["orange5_health", "orange5_order", "orange5_route", "orange5_chat", "orange5_receipts", "orange5_delegate", "orange5_execute", "orange5_browser"];
const ok = configsCurrent && skillsCurrent && skillRootsClean &&
  initialized.serverInfo?.name === "orangefive-brain" &&
  requiredTools.every((name) => toolNames.includes(name)) &&
  health.status === "OPERATIONAL" && health.gateway?.ready === true;

const proof = {
  schema: "orange5.client-live-proof.v1",
  status: ok ? "GREEN" : "NEEDS_ACTION",
  generatedAt: new Date().toISOString(),
  configs: Object.fromEntries(Object.entries(CLIENTS).map(([name, file]) => [name, { file, current: parity.results.find((item) => item.client === name)?.status === "CURRENT" }])),
  skills: { roots: activeSkillFolders, current: skillsCurrent && skillRootsClean },
  mcp: { server: initialized.serverInfo, toolCount: toolNames.length, requiredToolsPresent: requiredTools.every((name) => toolNames.includes(name)) },
  health: { status: health.status, operational: health.operational, gatewayReady: health.gateway?.ready, activeBrain: health.activeBrain },
};
proof.sha256 = crypto.createHash("sha256").update(JSON.stringify(proof)).digest("hex");

const outputDir = path.join(os.homedir(), "OrangeBox-Data", "orange5", "receipts");
fs.mkdirSync(outputDir, { recursive: true });
const outputPath = path.join(outputDir, "orangefive-client-live-proof-latest.json");
fs.writeFileSync(outputPath, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ...proof, receiptPath: outputPath }, null, 2));
if (!ok) process.exit(1);
