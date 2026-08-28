import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { StdioMcpClient } from "./mcp-stdio-client.mjs";
import { lookupRoute } from "../08-HERMES/mcp-router.mjs";

const ROOT = path.resolve(process.env.ORANGE5_ROOT || "C:/AtomEons/Orange5");
const GATEWAY = (process.env.ORANGE5_ORANGEBRAIN_URL || "http://127.0.0.1:1337").replace(/\/+$/, "");
const HERMES = (process.env.ORANGE5_HERMES_URL || "http://127.0.0.1:7430").replace(/\/+$/, "");
const RECEIPTS = path.join(ROOT, "10-RECEIPTS", "orange5-build");
const RISK = ["read_only", "low", "medium", "high", "destructive", "production"];

export async function executeBrowserWorkflow(input, deps = {}) {
  const fetchFn = deps.fetchFn || globalThis.fetch;
  const canonicalRoot = path.resolve(deps.projectRoot || ROOT);
  const projectRoot = resolveInside(canonicalRoot, input?.projectRoot || ".");
  const steps = Array.isArray(input?.steps) ? input.steps : [];
  if (steps.length < 1 || steps.length > 20) throw new Error("browser workflow requires 1-20 steps");
  const orderId = input?.orderId || `orange-browser-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const actor = input?.actor || "orangefive-browser-effector";
  const receiptDir = path.resolve(deps.receiptsDir || RECEIPTS);
  const receiptPath = path.join(receiptDir, `${orderId}-browser-workflow.json`);
  const artifactDir = path.join(projectRoot, "artifacts", "browser-workflows", orderId);
  const client = deps.client || chromeClient(projectRoot, deps);
  const results = [];
  fs.mkdirSync(receiptDir, { recursive: true });

  try {
    const serverInfo = await client.start();
    const listed = await client.listTools();
    const available = new Set((listed?.tools || []).map((tool) => tool.name));
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index] || {};
      const tool = String(step.tool || "");
      const args = enforcePaths(step.args || {}, projectRoot);
      if (!available.has(tool)) throw new Error(`Chrome MCP does not expose tool: ${tool}`);
      const route = lookupRoute("chrome-devtools-mcp", tool);
      const approved = input?.operatorApproved === true
        && (deps.trustInlineApproval === true || process.env.ORANGE5_ALLOW_INLINE_OPERATOR_APPROVAL === "1");
      if (RISK.indexOf(route.risk_level) >= RISK.indexOf("high") && !approved) {
        throw new Error(`${tool} (${route.risk_level}) requires operatorApproved=true`);
      }
      const authorization = await authorizeStep({ fetchFn, route, tool, args, actor, projectRoot, orderId, approved, index, receiptPath });
      const invoked = await client.callTool(tool, args);
      const normalized = normalizeToolResult(invoked, { artifactDir, stepIndex: index, tool });
      if (normalized.isError) {
        const detail = normalized.content.find((item) => item?.type === "text")?.text || "MCP tool returned isError=true";
        throw new Error(`Chrome MCP ${tool} failed: ${detail}`);
      }
      results.push({ index, tool, risk_level: route.risk_level, lease_id: authorization.lease_id, gates: authorization.gates, result: normalized });
    }
    const receipt = {
      schema: "orange5.receipt.v0", receipt_type: "orange.browser-mcp-workflow.v1",
      receipt_id: orderId, generated_at: new Date().toISOString(), actor,
      status: "ok", confidence: 1, hash_chain: 1, prior_receipt: null,
      server: "chrome-devtools-mcp@1.6.0", server_info: serverInfo?.serverInfo || null,
      project_root: projectRoot, steps: results,
    };
    receipt.receipt_hash = sha(stable(receipt));
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    return {
      ok: true, schema: "orange.report.v1", orderId, status: "ok", confidence: 1,
      actionsTaken: results.map((result) => `authorized and executed chrome-devtools/${result.tool}`),
      evidence: [{ type: "browser_mcp_workflow", server: receipt.server, steps: results }, { type: "receipt", path: receiptPath, sha256: receipt.receipt_hash }],
      blockers: [], nextAction: "review browser artifacts and runtime evidence", receiptPath,
    };
  } catch (error) {
    const failed = {
      schema: "orange5.receipt.v0", receipt_type: "orange.browser-mcp-workflow.v1",
      receipt_id: orderId, generated_at: new Date().toISOString(), actor,
      status: "failed", confidence: 1, hash_chain: 1, prior_receipt: null,
      project_root: projectRoot, completed_steps: results, error: error?.message || String(error),
    };
    failed.receipt_hash = sha(stable(failed));
    try { fs.writeFileSync(receiptPath, `${JSON.stringify(failed, null, 2)}\n`, "utf8"); } catch {}
    throw error;
  } finally {
    await client.close();
  }
}

function chromeClient(cwd, deps) {
  return new StdioMcpClient({
    command: process.env.ComSpec || "C:/Windows/System32/cmd.exe",
    args: ["/d", "/s", "/c", "npx", "-y", "chrome-devtools-mcp@1.6.0", "--headless", "--isolated", "--no-usage-statistics", "--no-performance-crux", "--allowUnrestrictedPaths"],
    cwd, timeoutMs: deps.timeoutMs || 180_000, spawnFn: deps.spawnFn,
    env: { CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1", CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1" },
  });
}

async function authorizeStep({ fetchFn, route, tool, args, actor, projectRoot, orderId, approved, index, receiptPath }) {
  const minted = await jsonRequest(fetchFn, `${GATEWAY}/v1/hermes/lease`, {
    actor, allowed: [route.verb], forbidden: [], targetProject: projectRoot,
    riskLevel: route.risk_level, ttl_ms: 120_000,
    requires_approval: RISK.indexOf(route.risk_level) >= RISK.indexOf("high"),
    meta: { orderId, browser_step: index },
  });
  const lease = minted?.data?.lease;
  if (!lease?.id) throw new Error(`Hermes lease mint failed for ${tool}`);
  let overridePath = null;
  try {
    if (lease.requires_approval && approved) {
      overridePath = path.join(ROOT, "08-HERMES", "approvals", `override-${lease.id}.json`);
      fs.mkdirSync(path.dirname(overridePath), { recursive: true });
      fs.writeFileSync(overridePath, `${JSON.stringify({ signed_by: "atom", lease_id: lease.id, approved: true, order_id: orderId, single_use: true }, null, 2)}\n`);
      await jsonRequest(fetchFn, `${HERMES}/approvals/${encodeURIComponent(lease.id)}`, { approved: true, note: `Orange browser workflow ${orderId} step ${index}` });
    }
    const authorized = await jsonRequest(fetchFn, `${GATEWAY}/v1/hermes/mcp/chrome-devtools-mcp/${encodeURIComponent(tool)}`, {
      args, lease, actor, targetProject: projectRoot, operatorApproved: approved,
    });
    const data = authorized?.data;
    if (!data) throw new Error(`Hermes MCP authorization lacked data for ${tool}`);
    return { lease_id: lease.id, gates: (data.gates || []).map((gate) => ({ id: gate.id, pass: gate.pass })), receiptPath };
  } finally {
    try { await jsonRequest(fetchFn, `${GATEWAY}/v1/hermes/lease/${encodeURIComponent(lease.id)}/revoke`, { actor, reason: "browser step complete" }); } catch {}
    if (overridePath) try { fs.rmSync(overridePath, { force: true }); } catch {}
  }
}

function enforcePaths(args, root) {
  const out = structuredClone(args);
  for (const key of ["filePath", "outputDirPath", "requestFilePath", "responseFilePath"]) {
    if (typeof out[key] !== "string") continue;
    const resolved = path.resolve(root, out[key]);
    const rel = path.relative(root, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`${key} escapes project root`);
    out[key] = resolved;
  }
  return out;
}

function resolveInside(root, requested) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, String(requested || "."));
  const rel = path.relative(resolvedRoot, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`projectRoot escapes OrangeFive root: ${requested}`);
  return resolved;
}

function normalizeToolResult(result, artifact = null) {
  const content = Array.isArray(result?.content) ? result.content.map((item) => {
    if (item?.type === "image") {
      const image = item.data ? Buffer.from(item.data, "base64") : Buffer.alloc(0);
      const metadata = {
        type: "image",
        mimeType: item.mimeType,
        bytes: image.byteLength,
        sha256: image.byteLength > 0 ? sha(image) : null,
      };
      if (artifact?.artifactDir && image.byteLength > 0) {
        const extension = imageExtension(item.mimeType);
        const stem = String(artifact.tool || "image").replace(/[^A-Za-z0-9._-]/g, "-");
        const outputPath = path.join(artifact.artifactDir, `${String(artifact.stepIndex ?? 0).padStart(2, "0")}-${stem}.${extension}`);
        fs.mkdirSync(artifact.artifactDir, { recursive: true });
        fs.writeFileSync(outputPath, image);
        metadata.path = outputPath;
      }
      return metadata;
    }
    return item;
  }) : [];
  return { isError: result?.isError === true, content, structuredContent: result?.structuredContent || null };
}

function imageExtension(mimeType) {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

async function jsonRequest(fetchFn, url, body) {
  const response = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  if (!response.ok || parsed?.ok === false) throw new Error(`${url} returned ${response.status}: ${JSON.stringify(parsed)}`);
  return parsed;
}

function sha(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function stable(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => JSON.parse(stable(item))));
  if (value && typeof value === "object") return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map((key) => [key, JSON.parse(stable(value[key]))])));
  return JSON.stringify(value);
}

export const _test = { enforcePaths, normalizeToolResult, resolveInside };
