import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assessCodexaToolReceipt,
  renderCodexaToolCommand,
  resolveCodexaToolInvocation,
} from "../src/codexa-tool-catalog.mjs";
import { runCodexaTool, verifyCobraMirror } from "../src/codexa-tool-runner.mjs";

const temporaryRoots = [];
afterEach(() => {
  while (temporaryRoots.length) rmSync(temporaryRoots.pop(), { recursive: true, force: true });
});

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeFetch(overrides = {}) {
  const defaults = {
    phase: { status: "AE_PHASE_FABRIC_ACTIVE", authenticated: true },
    staff: { status: "LIVE", roleCount: 50 },
    hermes: { status: "ok" },
    cobra: { status: "ok" },
    rail: { status: "VERIFIED" },
    mcp: { status: "ok" },
    tags: { models: [{ name: "qwen3-coder:30b" }, { name: "qwen3.8:27b-current" }] },
    ps: { models: [] },
    vulkanHealth: { status: "ok" },
    vulkanModels: { data: [{ id: "model.gguf", meta: { n_params: 7_615_616_512, n_ctx: 4_096, ftype: "Q4_K" } }] },
    ...overrides,
  };
  return async (url) => {
    if (url.includes(":8907")) return response(defaults.phase, defaults.phaseStatus || 200);
    if (url.includes(":8643")) return response(defaults.staff, defaults.staffStatus || 200);
    if (url.includes(":8642")) return response(defaults.hermes, defaults.hermesStatus || 200);
    if (url.includes(":9100")) return response(defaults.cobra, defaults.cobraStatus || 200);
    if (url.includes(":8097")) return response(defaults.rail, defaults.railStatus || 200);
    if (url.includes(":7430")) return response(defaults.mcp, defaults.mcpStatus || 200);
    if (url.endsWith("/api/tags")) return response(defaults.tags, defaults.tagsStatus || 200);
    if (url.endsWith("/api/ps")) return response(defaults.ps, defaults.psStatus || 200);
    if (url.endsWith("/v1/models")) return response(defaults.vulkanModels, defaults.vulkanModelsStatus || 200);
    if (url.includes(":11436/health")) return response(defaults.vulkanHealth, defaults.vulkanHealthStatus || 200);
    return response({ error: "unmapped" }, 404);
  };
}

describe("Codexa semantic tool contract", () => {
  test("maps an allowlisted semantic name to the fixed Bun runner", () => {
    const invocation = resolveCodexaToolInvocation({
      command: "model-inventory",
      bunExecutable: "C:/Bun/bun.exe",
      runnerPath: "C:/Orange/codexa-tool-runner.mjs",
    });
    expect(invocation.semanticCommand).toBe("model-inventory");
    expect(invocation.executable.toLowerCase()).toEndWith("bun.exe");
    expect(invocation.args.slice(-2)).toEqual(["--tool", "model-inventory"]);
    expect(renderCodexaToolCommand(invocation)).toContain("'--tool' 'model-inventory'");
  });

  test("escapes a single quote before rendering the fixed PowerShell invocation", () => {
    const invocation = resolveCodexaToolInvocation({
      command: "hostname",
      args: ["operator's-view"],
      bunExecutable: "C:/Bun/bun.exe",
      runnerPath: "C:/Orange/runner.mjs",
    });
    expect(renderCodexaToolCommand(invocation)).toContain("'operator''s-view'");
  });

  test("rejects a shell command that is not semantic and allowlisted", () => {
    expect(() => resolveCodexaToolInvocation({
      command: "Remove-Item",
      bunExecutable: "bun",
      runnerPath: "runner.mjs",
    })).toThrow("not allowlisted");
  });

  test("requires both rail process proof and semantic health", () => {
    const healthy = assessCodexaToolReceipt({
      status: "VERIFIED",
      exitCode: 0,
      stdout: `${JSON.stringify({ schema: "orange.codexa-tool-report.v1", tool: "system-check", ok: true })}\n`,
    }, "system-check");
    const unhealthy = assessCodexaToolReceipt({
      status: "VERIFIED",
      exitCode: 0,
      stdout: `${JSON.stringify({ schema: "orange.codexa-tool-report.v1", tool: "system-check", ok: false })}\n`,
    }, "system-check");
    expect(healthy.ok).toBe(true);
    expect(unhealthy.ok).toBe(false);
  });
});

describe("Codexa Bun probe runner", () => {
  test("reports Ollama and Vulkan inventory without loading models", async () => {
    const report = await runCodexaTool("model-inventory", { fetchImpl: fakeFetch() });
    expect(report.ok).toBe(true);
    expect(report.ollama.available.map((row) => row.name)).toContain("qwen3-coder:30b");
    expect(report.vulkan.live).toBe(true);
    expect(report.vulkan.models[0].parameters).toBe(7_615_616_512);
  });

  test("system check is green only when every required organ and a model backend are live", async () => {
    const verifiedMirror = () => ({ ok: true, status: "VERIFIED" });
    const green = await runCodexaTool("system-check", { fetchImpl: fakeFetch(), verifyMirror: verifiedMirror });
    const red = await runCodexaTool("system-check", {
      fetchImpl: fakeFetch({ phase: { status: "down", authenticated: false } }),
      verifyMirror: verifiedMirror,
    });
    expect(green.ok).toBe(true);
    expect(green.serviceChecks).toEqual({ phase: true, staff: true, hermes: true, rail: true, memoryMirror: true });
    expect(red.ok).toBe(false);
    expect(red.serviceChecks.phase).toBe(false);
  });

  test("verifies the mirrored Cobra corpus by freshness and SHA-256", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orange-cobra-mirror-"));
    temporaryRoots.push(root);
    const relativePath = "events/reality/now.jsonl";
    const target = path.join(root, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    const content = '{"event":"real"}\n';
    writeFileSync(target, content);
    writeFileSync(path.join(root, "mirror-manifest.json"), JSON.stringify({
      schema: "orange5.ae_cobra.codexa_mirror.v1",
      status: "VERIFIED",
      completedAt: new Date().toISOString(),
      totalBytes: Buffer.byteLength(content),
      files: [{ relativePath, sha256: createHash("sha256").update(content).digest("hex") }],
      changed: [{ transport: "ae-phase" }],
    }));
    expect(verifyCobraMirror(root).ok).toBe(true);
    writeFileSync(target, "tampered\n");
    expect(verifyCobraMirror(root).ok).toBe(false);
  });

  test("legacy TriLane name is an honest compatibility view over active role routing", async () => {
    const report = await runCodexaTool("trilane-doctor", { fetchImpl: fakeFetch() });
    expect(report.ok).toBe(true);
    expect(report.compatibilityAlias).toBe("trilane-doctor");
    expect(report.activeSystem).toBe("Orange least-action role router");
    expect(report.roles.navigator.live).toBe(true);
  });
});
