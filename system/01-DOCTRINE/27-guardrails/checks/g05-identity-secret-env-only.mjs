// G05 — ATOMEONS_IDENTITY_SECRET is env-only, never hardcoded.
//
// A literal string assignment in source is a CRITICAL violation. We allow
// references via process.env / os.environ / Deno.env / Bun.env.

import { ORANGE5_ROOT } from "../lib/paths.mjs";
import { walk, readSafe } from "../lib/scan.mjs";

const HARDCODE_STR = /ATOMEONS_IDENTITY_SECRET\s*[:=]\s*["'][^"']{4,}["']/;
const HARDCODE_OBJ = /["']ATOMEONS_IDENTITY_SECRET["']\s*:\s*["'][^"']{4,}["']/;

export async function run() {
  const files = walk(ORANGE5_ROOT, {
    exts: [".mjs", ".js", ".ts", ".tsx", ".py", ".json", ".env"],
    maxFiles: 6000,
  });
  const offenders = [];
  for (const f of files) {
    const fp = f.replaceAll("\\", "/");
    if (fp.includes("/red-team/scenarios/") || fp.includes("/chaos/forbidden-paths/") || fp.includes("/tests/")) continue;
    const body = readSafe(f);
    if (!body) continue;
    if (!body.includes("ATOMEONS_IDENTITY_SECRET")) continue;
    // Allow .env.example/.env.template stubs that have placeholder values
    const isExample = /\/\.env(\.example|\.template|\.sample)\b/.test(
      f.replaceAll("\\", "/")
    );
    if (isExample) continue;
    // Allow the doctrine docs that just name the constant
    if (fp.includes("/01-DOCTRINE/27-guardrails/")) continue;
    const executable = body
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("#"))
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    if (HARDCODE_STR.test(executable) || HARDCODE_OBJ.test(executable)) {
      offenders.push(f);
    }
  }
  if (offenders.length > 0) {
    return {
      pass: false,
      details: {
        reason: "ATOMEONS_IDENTITY_SECRET assigned to a literal string in source",
        files: offenders.slice(0, 5),
      },
    };
  }
  return { pass: true, details: { scanned_files: files.length } };
}
