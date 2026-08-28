import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const toolMeshRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const labsRoot = path.join(toolMeshRoot, "labs");

async function jsonFiles(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return jsonFiles(target);
    return entry.isFile() && entry.name.endsWith(".json") ? [target] : [];
  }));
  return nested.flat();
}

test("every ToolMesh card declares bounded network egress", async () => {
  const files = await jsonFiles(labsRoot);
  assert.ok(files.length > 0, "expected ToolMesh cards");

  const failures = [];
  for (const file of files) {
    const card = JSON.parse(await fs.readFile(file, "utf8"));
    if (!card.default_lease_template) continue;
    const scopes = card.default_lease_template.scopes ?? [];
    const egress = scopes.filter((scope) => scope.startsWith("net.egress:"));
    if (egress.length === 0 || egress.includes("net.egress:any")) {
      failures.push(path.relative(toolMeshRoot, file));
    }
  }

  assert.deepEqual(failures, []);
});
