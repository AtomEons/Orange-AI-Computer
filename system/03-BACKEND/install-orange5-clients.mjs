#!/usr/bin/env bun
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = process.env.USERPROFILE || os.homedir();
const SERVER_PATH = path.join(ROOT, "03-BACKEND", "orange5-brain-mcp-server.mjs");
const BUN_PATH = process.execPath;
const SKILL_SOURCE = path.join(ROOT, "03-BACKEND", "client-skills");
const ACTIVE_SKILLS = ["orange5", "orangebox-primer"];
const STALE_SKILLS = [
  "orange-codexa-lease", "orange-feature-truth", "orange-health-report",
  "orange-mcp-health", "orange-order-report", "orange-project-report",
  "orange-release-watch", "orange-research-assurance", "orange-skill-audit",
];
const ENTRY = {
  command: BUN_PATH,
  args: [SERVER_PATH],
  env: {
    ORANGE5_ROOT: ROOT,
    ORANGE5_ORANGEBRAIN_URL: "http://127.0.0.1:1337"
  }
};

export const CLIENTS = {
  codex: path.join(HOME, ".codex", "config.toml"),
  claudeDesktop: path.join(HOME, "AppData", "Roaming", "Claude", "claude_desktop_config.json"),
  antigravity: path.join(HOME, "AppData", "Roaming", "Antigravity", "mcp_config.json"),
  gemini: path.join(HOME, ".gemini", "config", "mcp_config.json")
};

export const SKILL_ROOTS = {
  shared: path.join(HOME, ".agents", "skills"),
  codex: path.join(HOME, ".codex", "skills"),
  claude: path.join(HOME, ".claude", "skills"),
};

export function updateMcpJson(source = "{}") {
  const parsed = source.trim() ? JSON.parse(source) : {};
  parsed.mcpServers ||= {};
  for (const stale of ["Orange4 Brain MCP", "orange4", "orangebox-delta"]) delete parsed.mcpServers[stale];
  parsed.mcpServers.OrangeFive = { ...ENTRY };
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export function updateCodexToml(source = "") {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const output = [];
  let skipping = false;
  for (const line of lines) {
    const header = line.trim().match(/^\[([^\]]+)\]$/)?.[1]?.toLowerCase();
    if (header) {
      skipping = /^(mcp_servers\.(orange5|orange4|orangebox-delta))(\.|$)/.test(header);
      if (skipping) continue;
    }
    if (!skipping) output.push(line);
  }
  while (output.length && !output.at(-1).trim()) output.pop();
  const q = (value) => `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  output.push(
    "",
    "[mcp_servers.orange5]",
    `command = ${q(BUN_PATH)}`,
    `args = [${q(SERVER_PATH)}]`,
    "startup_timeout_sec = 20",
    "tool_timeout_sec = 240",
    "",
    "[mcp_servers.orange5.env]",
    `ORANGE5_ROOT = ${q(ROOT)}`,
    `ORANGE5_ORANGEBRAIN_URL = ${q("http://127.0.0.1:1337")}`,
    ""
  );
  return output.join("\n");
}

export function install({ dryRun = false } = {}) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const results = [];
  for (const [client, file] of Object.entries(CLIENTS)) {
    const exists = fs.existsSync(file);
    const before = exists ? fs.readFileSync(file, "utf8") : "";
    let after;
    try { after = client === "codex" ? updateCodexToml(before) : updateMcpJson(before); }
    catch (error) {
      results.push({ client, file, status: "INVALID_EXISTING_CONFIG", error: error.message });
      continue;
    }
    const changed = before !== after;
    if (!dryRun && changed) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (exists) fs.copyFileSync(file, `${file}.orange5-backup-${timestamp}`);
      const temp = `${file}.orange5-${process.pid}.tmp`;
      fs.writeFileSync(temp, after, "utf8");
      if (client !== "codex") JSON.parse(fs.readFileSync(temp, "utf8"));
      fs.renameSync(temp, file);
    }
    results.push({ client, file, status: changed ? (dryRun ? "WOULD_UPDATE" : "UPDATED") : "CURRENT", changed });
  }
  const skillResults = syncSkills({ dryRun, timestamp });
  const ok = results.every((item) => !item.status.startsWith("INVALID"));
  const receipt = {
    schema: "orange.client-install.v1",
    status: ok ? "ORANGEFIVE_CLIENTS_CONFIGURED" : "ORANGEFIVE_CLIENT_CONFIG_ATTENTION",
    ok,
    generatedAt: new Date().toISOString(),
    server: { runtime: BUN_PATH, entrypoint: SERVER_PATH },
    results,
    skills: skillResults,
  };
  receipt.sha256 = crypto.createHash("sha256").update(JSON.stringify({ clients: receipt.results, skills: receipt.skills })).digest("hex");
  if (!dryRun) {
    const receiptDir = path.join(HOME, "OrangeBox-Data", "orange5", "receipts");
    fs.mkdirSync(receiptDir, { recursive: true });
    const receiptPath = path.join(receiptDir, `${timestamp}-orangefive-client-install.json`);
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    receipt.receiptPath = receiptPath;
  }
  return receipt;
}

export function syncSkills({
  dryRun = false,
  timestamp = new Date().toISOString().replace(/[:.]/g, "-"),
  roots = SKILL_ROOTS,
  sourceRoot = SKILL_SOURCE,
  archiveRoot = path.join(HOME, "OrangeBox-Data", "orange5", "skill-archive", timestamp),
} = {}) {
  const results = [];
  for (const [client, root] of Object.entries(roots)) {
    for (const name of STALE_SKILLS) {
      const stalePath = path.join(root, name);
      if (!fs.existsSync(stalePath)) continue;
      const archivePath = path.join(archiveRoot, client, name);
      if (!dryRun) {
        fs.mkdirSync(path.dirname(archivePath), { recursive: true });
        fs.renameSync(stalePath, archivePath);
      }
      results.push({ client, skill: name, status: dryRun ? "WOULD_ARCHIVE_STALE" : "ARCHIVED_STALE", path: stalePath, archivePath });
    }
    for (const name of ACTIVE_SKILLS) {
      const source = path.join(sourceRoot, name, "SKILL.md");
      const target = path.join(root, name, "SKILL.md");
      const desired = fs.readFileSync(source, "utf8");
      const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
      const changed = current !== desired;
      if (!dryRun && changed) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, desired, "utf8");
      }
      results.push({ client, skill: name, status: changed ? (dryRun ? "WOULD_SYNC" : "SYNCED") : "CURRENT", path: target });
    }
  }
  return results;
}

if (import.meta.main) {
  const result = install({ dryRun: process.argv.includes("--dry-run") });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
