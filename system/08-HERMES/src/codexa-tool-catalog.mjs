import { resolve } from "node:path";

export const CODEXA_SEMANTIC_TOOLS = Object.freeze([
  "hostname",
  "ops-readiness",
  "system-check",
  "health-report",
  "project-report",
  "reality-watch",
  "model-inventory",
  "trilane-doctor",
  "ipi-doctor",
  "memory-doctor",
  "mcp-doctor",
]);

const ALLOWED = new Set(CODEXA_SEMANTIC_TOOLS);

export function resolveCodexaToolInvocation({ command, args = [], bunExecutable, runnerPath }) {
  const semanticCommand = String(command || "").trim();
  if (!ALLOWED.has(semanticCommand)) {
    throw new Error(`AE Phase tool command is not allowlisted: ${semanticCommand || "(empty)"}`);
  }
  if (!Array.isArray(args)) throw new TypeError("AE Phase tool args must be an array");
  if (args.length > 32) throw new RangeError("AE Phase tool args exceed 32 items");
  const normalizedArgs = args.map((value) => {
    const item = String(value ?? "");
    if (item.length > 512) throw new RangeError("AE Phase tool arg exceeds 512 characters");
    return item;
  });
  return {
    semanticCommand,
    executable: resolve(String(bunExecutable || process.execPath)),
    args: [resolve(String(runnerPath)), "--tool", semanticCommand, ...normalizedArgs],
  };
}

function quotePowerShellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function renderCodexaToolCommand(invocation) {
  if (!invocation?.executable || !Array.isArray(invocation?.args)) {
    throw new TypeError("Codexa tool invocation is malformed");
  }
  return `& ${[invocation.executable, ...invocation.args].map(quotePowerShellLiteral).join(" ")}`;
}

export function parseLastJsonLine(value) {
  const lines = String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch {}
  }
  return null;
}

export function assessCodexaToolReceipt(payload, expectedTool) {
  const semantic = parseLastJsonLine(payload?.stdout);
  const processVerified = payload?.status === "VERIFIED" && Number(payload?.exitCode) === 0;
  const semanticVerified = semantic?.schema === "orange.codexa-tool-report.v1"
    && semantic?.tool === expectedTool
    && semantic?.ok === true;
  return {
    ok: processVerified && semanticVerified,
    processVerified,
    semanticVerified,
    semantic,
  };
}
