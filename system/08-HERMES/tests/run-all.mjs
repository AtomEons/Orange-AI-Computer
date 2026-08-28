#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(here)
  .filter((name) => /\.(test|smoke)\.mjs$/.test(name))
  .sort();
const failures = [];

for (const name of files) {
  const file = path.join(here, name);
  const source = fs.readFileSync(file, "utf8");
  const command = source.includes('from "bun:test"') || source.includes("from 'bun:test'")
    ? ["bun", "test", file]
    : ["bun", file];
  console.log(`\n=== ${name} ===`);
  const run = Bun.spawnSync({
    cmd: command,
    cwd: path.resolve(here, "..", ".."),
    stdout: "inherit",
    stderr: "inherit",
  });
  if (run.exitCode !== 0) failures.push({ name, exitCode: run.exitCode });
}

console.log(`\nHERMES_FULL_SUITE files=${files.length} passed=${files.length - failures.length} failed=${failures.length}`);
if (failures.length) {
  console.error(JSON.stringify(failures));
  process.exit(1);
}
