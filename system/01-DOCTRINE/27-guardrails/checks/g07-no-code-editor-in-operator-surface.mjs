// G07 — No code editor in the operator surface.
//
// The 02-APP shell must not embed Monaco, CodeMirror, or Ace. Operators
// don't write code in the lanes; that's the AECommand Center / IDE territory.

import { resolve } from "node:path";
import { ORANGE5_ROOT } from "../lib/paths.mjs";
import { existsSync, readFileSync } from "node:fs";
import { walk, readSafe } from "../lib/scan.mjs";

const APP_ROOT = resolve(ORANGE5_ROOT, "02-APP");
const FORBIDDEN_IMPORTS = [
  /from\s+["']monaco-editor/,
  /from\s+["']@monaco-editor\//,
  /from\s+["']codemirror/,
  /from\s+["']@codemirror\//,
  /from\s+["']ace-builds/,
  /from\s+["']react-ace/,
];

export async function run() {
  if (!existsSync(APP_ROOT)) {
    return { pass: true, details: { note: "02-APP not present in this checkout" } };
  }
  const pkgPath = resolve(APP_ROOT, "package.json");
  const offenders = [];
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      for (const name of Object.keys(deps)) {
        if (/^(monaco-editor|@monaco-editor\/|codemirror|@codemirror\/|ace-builds|react-ace)/.test(name)) {
          offenders.push({ kind: "dependency", name });
        }
      }
    } catch {
      // ignore parse error — handled by other rails
    }
  }
  const tsFiles = walk(resolve(APP_ROOT, "src"), {
    exts: [".ts", ".tsx", ".js", ".jsx", ".mjs"],
    maxFiles: 2000,
  });
  for (const f of tsFiles) {
    const body = readSafe(f);
    if (!body) continue;
    if (FORBIDDEN_IMPORTS.some((re) => re.test(body))) {
      offenders.push({ kind: "import", file: f });
    }
  }
  if (offenders.length > 0) {
    return {
      pass: false,
      details: {
        reason: "code editor library embedded in operator surface",
        offenders: offenders.slice(0, 5),
      },
    };
  }
  return { pass: true, details: { app_root: APP_ROOT } };
}
