// 27 — G-26 — Held-area isolation.
//
// Static check. Grep the production directories (02-APP, 03-BACKEND,
// 04-CONTROL-PLANE) for import paths that reach into `18-HELD/`. Held
// is bonded experimental; production code MUST NOT depend on it.

import { resolve } from "node:path";
import {
  safe,
  result,
  ORANGE5_ROOT,
  walkGrep,
} from "../lib/check-util.mjs";

export const id = "G-26";
export const slug = "held-area-isolation";
export const severity = "block";

const PRODUCTION_ROOTS = ["02-APP", "03-BACKEND", "04-CONTROL-PLANE"];

// Match: `from "...18-HELD/..."` , `require("...18-HELD/...")`,
// `from "../18-HELD/..."` , `from "../../18-HELD/..."` etc.
const HELD_IMPORT_RX =
  /(from\s+['"][^'"]*(?:^|\/|\.\.\/)18-HELD\/[^'"]*['"]|require\(\s*['"][^'"]*(?:^|\/|\.\.\/)18-HELD\/[^'"]*['"]\s*\))/;

export const check = safe(async (state, opts) => {
  const root = opts.scanRoot || ORANGE5_ROOT;
  const offenders = [];
  for (const r of PRODUCTION_ROOTS) {
    const rootDir = resolve(root, r);
    for await (const m of walkGrep(rootDir, HELD_IMPORT_RX, {
      extensions: [".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"],
    })) {
      offenders.push({
        production_root: r,
        file: m.file,
        line: m.line,
        text: m.text,
      });
      if (offenders.length >= 25) break;
    }
    if (offenders.length >= 25) break;
  }
  if (offenders.length > 0) {
    return result(false, {
      reason: "production_imports_from_held",
      offenders,
      production_roots: PRODUCTION_ROOTS,
      receipt_trigger: "G26_HELD_LEAK",
    });
  }
  return result(true, {
    production_roots: PRODUCTION_ROOTS,
    offenders: 0,
  });
});

export default check;
