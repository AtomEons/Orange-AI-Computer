// G02 — FOUNDER_SALARY_PER_INSTALL_CENTS must be env-bound, never hardcoded.
//
// Code may reference the constant name; what it MUST NOT do is bind a
// literal integer to it in source. Hits like
//    FOUNDER_SALARY_PER_INSTALL_CENTS = 100
// are violations. Hits like
//    const x = process.env.FOUNDER_SALARY_PER_INSTALL_CENTS
// or
//    os.environ["FOUNDER_SALARY_PER_INSTALL_CENTS"]
// are acceptable.

import { ORANGE5_ROOT } from "../lib/paths.mjs";
import { walk, readSafe } from "../lib/scan.mjs";

const HARDCODE = /FOUNDER_SALARY_PER_INSTALL_CENTS\s*[:=]\s*\d/;
const LITERAL_INT_PROP = /["']FOUNDER_SALARY_PER_INSTALL_CENTS["']\s*:\s*\d/;

export async function run() {
  const files = walk(ORANGE5_ROOT, {
    exts: [".mjs", ".js", ".ts", ".tsx", ".py", ".json"],
    maxFiles: 5000,
  });
  const violations = [];
  for (const f of files) {
    const body = readSafe(f);
    if (!body) continue;
    if (!body.includes("FOUNDER_SALARY_PER_INSTALL_CENTS")) continue;
    // Skip the registry/doctrine docs that just mention the name
    if (f.replaceAll("\\", "/").includes("/01-DOCTRINE/27-guardrails/")) continue;
    const executable = body
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("#"))
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    if (HARDCODE.test(executable) || LITERAL_INT_PROP.test(executable)) {
      violations.push(f);
    }
  }
  if (violations.length > 0) {
    return {
      pass: false,
      details: {
        reason: "FOUNDER_SALARY_PER_INSTALL_CENTS hardcoded to a literal",
        files: violations.slice(0, 5),
      },
    };
  }
  return { pass: true, details: { scanned_files: files.length, hardcoded_hits: 0 } };
}
