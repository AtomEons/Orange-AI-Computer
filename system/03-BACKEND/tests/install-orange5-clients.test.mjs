import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { syncSkills, updateCodexToml, updateMcpJson } from "../install-orange5-clients.mjs";

const temps = [];
afterEach(() => { while (temps.length) rmSync(temps.pop(), { recursive: true, force: true }); });

describe("OrangeFive client configuration", () => {
  test("replaces stale Orange4 JSON MCP entries and preserves unrelated servers", () => {
    const source = JSON.stringify({ mcpServers: { github: { command: "docker" }, "Orange4 Brain MCP": { command: "node" } } });
    const result = JSON.parse(updateMcpJson(source));
    expect(result.mcpServers.github.command).toBe("docker");
    expect(result.mcpServers["Orange4 Brain MCP"]).toBeUndefined();
    expect(result.mcpServers.OrangeFive.command).toContain("bun");
    expect(result.mcpServers.OrangeFive.args[0]).toContain("orange5-brain-mcp-server.mjs");
  });

  test("writes one current Codex MCP block and removes stale blocks", () => {
    const source = '[mcp_servers.orange4]\ncommand = "node"\n\n[projects.test]\ntrust_level = "trusted"\n';
    const result = updateCodexToml(source);
    expect(result).not.toContain("mcp_servers.orange4]");
    expect(result).toContain("[projects.test]");
    expect(result.match(/\[mcp_servers\.orange5\]/g)?.length).toBe(1);
    expect(result).toContain("ORANGE5_ORANGEBRAIN_URL");
  });

  test("configuration updates are idempotent", () => {
    const json = updateMcpJson(updateMcpJson("{}"));
    expect(updateMcpJson(json)).toBe(json);
    const toml = updateCodexToml(updateCodexToml(""));
    expect(updateCodexToml(toml)).toBe(toml);
  });

  test("archives stale skills and installs only canonical Orange skills", () => {
    const base = mkdtempSync(path.join(tmpdir(), "orange5-client-skills-"));
    temps.push(base);
    const roots = { shared: path.join(base, "shared"), codex: path.join(base, "codex"), claude: path.join(base, "claude") };
    const stale = path.join(roots.codex, "orange-order-report");
    mkdirSync(stale, { recursive: true });
    writeFileSync(path.join(stale, "SKILL.md"), "obsolete Atomic-Orange- route", "utf8");
    const result = syncSkills({ roots, archiveRoot: path.join(base, "archive") });
    expect(result.some((row) => row.skill === "orange-order-report" && row.status === "ARCHIVED_STALE")).toBe(true);
    expect(readFileSync(path.join(base, "archive", "codex", "orange-order-report", "SKILL.md"), "utf8")).toContain("obsolete");
    for (const root of Object.values(roots)) {
      expect(readFileSync(path.join(root, "orange5", "SKILL.md"), "utf8")).toContain("AtomSmasher");
      expect(readFileSync(path.join(root, "orangebox-primer", "SKILL.md"), "utf8")).toContain("mandatory path");
    }
  });

  test("canonical skills describe the actual governed crossing", () => {
    const skillRoot = path.resolve(import.meta.dir, "../client-skills");
    const operator = readFileSync(path.join(skillRoot, "orange5", "SKILL.md"), "utf8");
    const primer = readFileSync(path.join(skillRoot, "orangebox-primer", "SKILL.md"), "utf8");
    for (const required of ["LOOM", "least-action routing", "topology selection", "Cobra recall", "lossless AtomSmasher", "adversarial review", "epistemic preflight", "bounded Hermes lease", "hash-chained receipt"]) {
      expect(operator).toContain(required);
    }
    expect(operator).toContain("ORANGE5_RUNTIME_AUTHORITY.md");
    expect(primer).toContain("order -> LOOM -> least-action route -> topology -> Cobra recall -> lossless AtomSmasher");
    expect(primer).toContain("requires no resident answer model");
  });
});
