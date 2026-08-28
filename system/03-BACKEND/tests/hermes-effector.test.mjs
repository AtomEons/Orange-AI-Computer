import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeGovernedTool, _test } from "../hermes-effector.mjs";

function fakeFetch() {
  return async (url) => {
    if (url.endsWith("/v1/hermes/lease")) return response({ ok: true, data: { lease: { id: "lease-test", actor: "orangefive-brain-mcp" } } });
    if (url.endsWith("/v1/hermes/action")) return response({ ok: true, data: { pass: true, results: Array.from({ length: 8 }, (_, i) => ({ id: `gate-${i + 1}`, pass: true })) } });
    if (url.includes("/approvals/")) return response({ ok: true, data: { approval: { approved: true } } });
    if (url.includes("/revoke")) return response({ ok: true, data: { revoked: true } });
    return response({ ok: false }, 404);
  };
}
function response(value, status = 200) { return { ok: status < 400, status, text: async () => JSON.stringify(value) }; }

describe("Hermes governed effector", () => {
  test("refuses path escape before authorization", async () => {
    expect(() => _test.resolveInside("C:/AtomEons/Orange5", "../secret")).toThrow("escapes");
  });

  test("requires explicit approval for process execution", async () => {
    await expect(executeGovernedTool({ action: "process.run", command: ["bun", "--version"], operatorApproved: true }, { fetchFn: fakeFetch() })).rejects.toThrow("server-side approval opt-in");
  });

  test("caller cannot widen the canonical project root", async () => {
    await expect(executeGovernedTool({ action: "filesystem.read", projectRoot: "C:/", path: "Users/a/.ssh/id_rsa" }, { fetchFn: fakeFetch() })).rejects.toThrow("escapes");
  });

  test("authorizes then performs a real bounded file read", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orange-effector-"));
    fs.writeFileSync(path.join(root, "proof.txt"), "real-side-effect-proof", "utf8");
    try {
      const report = await executeGovernedTool({ action: "filesystem.read", path: "proof.txt", orderId: `test-${Date.now()}` }, { fetchFn: fakeFetch(), projectRoot: root, receiptsDir: root });
      expect(report.status).toBe("ok");
      expect(report.evidence.find((row) => row.type === "execution_result")?.content).toBe("real-side-effect-proof");
      expect(report.evidence.find((row) => row.type === "hermes_gate_chain")?.gates).toHaveLength(8);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test("writes a sovereign-signed override and lease-bound pre-action receipt", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orange-effector-process-"));
    let observed = null;
    const fetchFn = async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      if (url.endsWith("/v1/hermes/lease")) return response({ ok: true, data: { lease: { id: "lease-live-contract", actor: "orange-fixer", allowed: ["process.run"] } } });
      if (url.endsWith("/v1/hermes/action")) {
        const receipt = JSON.parse(fs.readFileSync(body.receipt_path, "utf8"));
        const override = JSON.parse(fs.readFileSync(path.join(root, "approvals", "override-lease-live-contract.json"), "utf8"));
        observed = { receipt, override };
        return response({ ok: true, data: { pass: true, results: Array.from({ length: 8 }, (_, i) => ({ id: `gate-${i + 1}`, pass: true })) } });
      }
      if (url.includes("/approvals/")) return response({ ok: true, data: { approval: { approved: true } } });
      if (url.includes("/revoke")) return response({ ok: true, data: { revoked: true } });
      return response({ ok: false }, 404);
    };
    try {
      const report = await executeGovernedTool({
        action: "process.run",
        command: [process.execPath, "-e", "console.log('governed')"],
        operatorApproved: true,
        orderId: "process-contract-test",
        actor: "orange-fixer",
      }, {
        fetchFn,
        projectRoot: root,
        receiptsDir: root,
        approvalsDir: path.join(root, "approvals"),
        trustInlineApproval: true,
        sovereignPrincipal: "atom",
      });
      expect(report.status).toBe("ok");
      expect(observed.receipt).toMatchObject({ status: "pending", lease_id: "lease-live-contract", action: "process.run" });
      expect(observed.override).toMatchObject({ signed_by: "atom", lease_id: "lease-live-contract", approved: true });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
