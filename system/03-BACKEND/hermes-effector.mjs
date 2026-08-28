import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const ROOT = path.resolve(process.env.ORANGE5_ROOT || "C:/AtomEons/Orange5");
const GATEWAY = (process.env.ORANGE5_ORANGEBRAIN_URL || "http://127.0.0.1:1337").replace(/\/+$/, "");
const HERMES = (process.env.ORANGE5_HERMES_URL || "http://127.0.0.1:7430").replace(/\/+$/, "");
const RECEIPTS = path.join(ROOT, "10-RECEIPTS", "orange5-build");
const ACTIONS = Object.freeze({
  "filesystem.list": { risk: "read_only", approval: false },
  "filesystem.read": { risk: "read_only", approval: false },
  "process.run": { risk: "high", approval: true },
});

export async function executeGovernedTool(input, deps = {}) {
  const fetchFn = deps.fetchFn || globalThis.fetch;
  const canonicalRoot = path.resolve(deps.projectRoot || ROOT);
  const root = resolveInside(canonicalRoot, input?.projectRoot || ".");
  const action = String(input?.action || "");
  const policy = ACTIONS[action];
  if (!policy) throw new Error(`unsupported governed action: ${action}`);
  const serverAllowsInlineApproval = deps.trustInlineApproval === true
    || process.env.ORANGE5_ALLOW_INLINE_OPERATOR_APPROVAL === "1";
  const operatorApproved = input?.operatorApproved === true && serverAllowsInlineApproval;
  if (policy.approval && !operatorApproved) {
    throw new Error(`${action} requires operatorApproved=true and server-side approval opt-in`);
  }
  const target = resolveInside(root, input?.path || ".");
  const orderId = input?.orderId || `orange-tool-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const actor = input?.actor || "orangefive-brain-mcp";
  const started = new Date().toISOString();
  let lease;
  let authorization;
  let execution;
  let revoked = false;
  let overridePath = null;
  let receiptPath = null;

  try {
    const minted = await jsonRequest(fetchFn, `${GATEWAY}/v1/hermes/lease`, {
      actor, allowed: [action], forbidden: [], targetProject: root,
      riskLevel: policy.risk, ttl_ms: 120_000, requires_approval: policy.approval,
      meta: { orderId, source: "orange5-brain-mcp" },
    });
    lease = minted?.data?.lease;
    if (!lease?.id) throw new Error(`Hermes lease mint failed: ${JSON.stringify(minted)}`);
    if (typeof deps.onLease === "function") {
      await deps.onLease({ lease, orderId, action, target, root });
    }

    if (policy.approval && operatorApproved) {
      const approvalsDir = path.resolve(deps.approvalsDir || path.join(ROOT, "08-HERMES", "approvals"));
      const sovereignPrincipal = deps.sovereignPrincipal
        || process.env.HERMES_SOVEREIGN_PRINCIPAL
        || "atom";
      overridePath = path.join(approvalsDir, `override-${lease.id}.json`);
      fs.mkdirSync(path.dirname(overridePath), { recursive: true });
      fs.writeFileSync(overridePath, `${JSON.stringify({
        signed_by: sovereignPrincipal, lease_id: lease.id, approved: true,
        approved_at: new Date().toISOString(), order_id: orderId,
        scope: root, action, single_use: true,
      }, null, 2)}\n`, "utf8");
      await jsonRequest(fetchFn, `${HERMES}/approvals/${encodeURIComponent(lease.id)}`, {
        approved: true, note: `single-use Orange MCP approval for ${orderId}`,
      });
    }

    const receiptDir = path.resolve(deps.receiptsDir || RECEIPTS);
    receiptPath = path.join(receiptDir, `${orderId}-governed-tool.json`);
    fs.mkdirSync(receiptDir, { recursive: true });
    fs.writeFileSync(receiptPath, `${JSON.stringify({
      schema: "orange5.receipt.v0", receipt_id: orderId, generated_at: started,
      actor, status: "pending", confidence: 1, hash_chain: 1, prior_receipt: null,
      lease_id: lease.id, action, target,
      note: "pre-action receipt required by Hermes receipt-spine gate",
    }, null, 2)}\n`, "utf8");
    const order = {
      schema: "orange.order.v1", orderId, action, intent: `execute ${action}`,
      scope: root, allowedActions: [action], forbiddenActions: [],
      targetProject: root, riskLevel: policy.risk, requiresReceipt: true,
    };
    const report = {
      schema: "orange.report.v1", orderId, status: "ready", confidence: 1,
      actionsTaken: [`prepared ${action}`], evidence: [], blockers: [],
      nextAction: `execute ${action}`, receiptPath,
    };
    const approved = await jsonRequest(fetchFn, `${GATEWAY}/v1/hermes/action`, {
      lease_id: lease.id, actor, action_verb: action, order, report,
      action: { kind: "orange_native_tool", verb: action, status: "ready", risk_level: policy.risk },
      receipt_path: receiptPath, operator_approved: operatorApproved,
    });
    authorization = approved?.data;
    if (!authorization?.pass) throw new Error(`Hermes authorization failed: ${JSON.stringify(approved)}`);

    execution = await runAction(action, target, input, deps);
    const receipt = {
      schema: "orange5.receipt.v0", receipt_type: "orange.governed-tool-receipt.v1",
      receipt_id: orderId, generated_at: new Date().toISOString(), orderId, status: "ok", confidence: 1,
      hash_chain: 1, prior_receipt: null, started_at: started, completed_at: new Date().toISOString(), actor,
      project_root: root, action, target, lease_id: lease.id,
      hermes_gates: (authorization.results || []).map((gate) => ({ id: gate.id, pass: gate.pass })),
      execution,
    };
    receipt.receipt_hash = hash(stable(receipt));
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    return {
      ok: true, schema: "orange.report.v1", orderId, status: "ok", confidence: 1,
      actionsTaken: [`Hermes authorized ${action}`, `executed ${action}`],
      evidence: [
        { type: "hermes_gate_chain", lease_id: lease.id, gates: receipt.hermes_gates },
        { type: "execution_result", ...execution },
        { type: "receipt", path: receiptPath, sha256: receipt.receipt_hash },
      ],
      blockers: [], nextAction: "review governed tool result", receiptPath,
    };
  } catch (error) {
    if (receiptPath) {
      const failed = {
        schema: "orange5.receipt.v0", receipt_type: "orange.governed-tool-receipt.v1",
        receipt_id: orderId, generated_at: new Date().toISOString(), actor,
        status: "failed", confidence: 1, hash_chain: 1, prior_receipt: null,
        action, target, lease_id: lease?.id || null,
        error: error?.message || String(error), execution: error?.result || null,
      };
      failed.receipt_hash = hash(stable(failed));
      try { fs.writeFileSync(receiptPath, `${JSON.stringify(failed, null, 2)}\n`, "utf8"); } catch { /* preserve original failure */ }
    }
    throw error;
  } finally {
    if (lease?.id) {
      try {
        await jsonRequest(fetchFn, `${GATEWAY}/v1/hermes/lease/${encodeURIComponent(lease.id)}/revoke`, {
          actor, reason: "single-use governed tool completed",
        });
        revoked = true;
      } catch { /* expiry is still fail-closed */ }
    }
    if (overridePath) {
      try { fs.rmSync(overridePath, { force: true }); } catch { /* stale override is worse than cleanup failure */ }
    }
    void revoked;
  }
}

async function runAction(action, target, input, deps) {
  if (action === "filesystem.list") {
    const entries = fs.readdirSync(target, { withFileTypes: true })
      .slice(0, Math.max(1, Math.min(Number(input.limit) || 200, 1000)))
      .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" }));
    return { action, entries, count: entries.length, result_hash: hash(stable(entries)) };
  }
  if (action === "filesystem.read") {
    const maxBytes = Math.max(1, Math.min(Number(input.maxBytes) || 262_144, 1_048_576));
    const data = fs.readFileSync(target);
    const clipped = data.subarray(0, maxBytes);
    return { action, content: clipped.toString("utf8"), bytes: clipped.length, truncated: data.length > maxBytes, result_hash: hash(clipped) };
  }
  const argv = Array.isArray(input.command) ? input.command.map(String) : [];
  if (argv.length === 0 || argv.length > 128) throw new Error("process.run requires a bounded command array");
  return runProcess(argv, target, input.timeoutMs, deps.spawnFn || spawn);
}

function runProcess(argv, cwd, timeoutMs = 120_000, spawnFn = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(argv[0], argv.slice(1), { cwd, windowsHide: true, shell: false, env: process.env });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    const cap = 1_048_576;
    const collect = (bucket) => (chunk) => { if (bytes < cap) bucket.push(Buffer.from(chunk).subarray(0, cap - bytes)); bytes += chunk.length; };
    child.stdout?.on("data", collect(stdout));
    child.stderr?.on("data", collect(stderr));
    const timer = setTimeout(() => child.kill(), Math.max(1_000, Math.min(Number(timeoutMs) || 120_000, 600_000)));
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      const result = { action: "process.run", command: argv, exit_code: code, signal, stdout: out, stderr: err, output_truncated: bytes > cap };
      result.result_hash = hash(stable(result));
      if (code !== 0) return reject(Object.assign(new Error(`process exited ${code}: ${err.slice(0, 500)}`), { result }));
      resolve(result);
    });
  });
}

function resolveInside(root, requested) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, String(requested || "."));
  const rel = path.relative(resolvedRoot, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`path escapes project root: ${requested}`);
  return resolved;
}

async function jsonRequest(fetchFn, url, body) {
  const response = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  if (!response.ok || parsed?.ok === false) throw new Error(`${url} returned ${response.status}: ${JSON.stringify(parsed)}`);
  return parsed;
}

function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function stable(value) {
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => JSON.parse(stable(item))));
  if (value && typeof value === "object") return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map((key) => [key, JSON.parse(stable(value[key]))])));
  return JSON.stringify(value);
}

export const _test = { resolveInside, ACTIONS };
