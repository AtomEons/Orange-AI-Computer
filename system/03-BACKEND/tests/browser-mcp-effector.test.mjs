import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _test } from "../browser-mcp-effector.mjs";

describe("browser MCP effector", () => {
  test("contains artifact paths inside the project", () => {
    const root = path.resolve("C:/AtomEons/Orange5");
    expect(_test.enforcePaths({ filePath: "10-RECEIPTS/proof.png" }, root).filePath.startsWith(root)).toBe(true);
    expect(() => _test.enforcePaths({ filePath: "../escape.png" }, root)).toThrow("escapes");
  });

  test("hashes image payload metadata instead of retaining base64", () => {
    const normalized = _test.normalizeToolResult({ content: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }] });
    expect(normalized.content[0].data).toBeUndefined();
    expect(normalized.content[0].sha256).toHaveLength(64);
  });

  test("persists inspectable image evidence when an artifact directory is supplied", () => {
    const root = mkdtempSync(path.join(tmpdir(), "orange5-browser-artifact-"));
    try {
      const normalized = _test.normalizeToolResult(
        { content: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }] },
        { artifactDir: root, stepIndex: 2, tool: "take_screenshot" },
      );
      const output = normalized.content[0].path;
      expect(output).toBe(path.join(root, "02-take_screenshot.png"));
      expect(existsSync(output)).toBe(true);
      expect(readFileSync(output, "utf8")).toBe("hello");
      expect(normalized.content[0].bytes).toBe(5);
      expect(normalized.content[0].data).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preserves MCP errors so workflows cannot report false green", () => {
    const normalized = _test.normalizeToolResult({ isError: true, content: [{ type: "text", text: "denied" }] });
    expect(normalized.isError).toBe(true);
  });
});
