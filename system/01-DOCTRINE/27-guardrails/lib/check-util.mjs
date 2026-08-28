// check-util.mjs — shared helpers for the 27 guardrail check modules.
//
// Every check exports a `check(state, opts)` function that returns
//   { pass: boolean, details: object }
//
// Conventions:
//   - `state` is an optional snapshot passed by the runtime (gate registry,
//     write-lock table, idempotency store, etc). Checks tolerate missing
//     state by reporting `pass:false` with a `reason:"no_state"` field
//     rather than throwing — Mom's Law: the witness keeps watching even
//     when the runtime is partial.
//   - `opts` is an optional override bag. Useful keys:
//       opts.root             — override ORANGE5_ROOT
//       opts.severity         — "warn" | "block" (informational; the
//                               enforcer decides; checks just report)
//       opts.skipFs           — true to skip filesystem reads (unit tests)
//   - No check throws. A thrown error inside the user code is caught and
//     reported as `pass:false, details.error`.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { existsSync, statSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ORANGE5_ROOT,
  GUARDRAILS_ROOT,
  STATE_DIR,
  SOUL_GENOME_PATH,
  CONTINUITY_DIR,
  RECEIPTS_DIR,
  APP_ROUTER,
  APP_LANES_DIR,
  FRONTIER_BOUNDARY_DOC,
  FLUX_ADAPTER,
  COBRA_BASE,
} from "./paths.mjs";

export {
  ORANGE5_ROOT,
  GUARDRAILS_ROOT,
  STATE_DIR,
  SOUL_GENOME_PATH,
  CONTINUITY_DIR,
  RECEIPTS_DIR,
  APP_ROUTER,
  APP_LANES_DIR,
  FRONTIER_BOUNDARY_DOC,
  FLUX_ADAPTER,
  COBRA_BASE,
};

// Build a result object. Never throws.
export function result(pass, details = {}) {
  return { pass: Boolean(pass), details: details || {} };
}

// Wrap a check body so an internal exception becomes a failing verdict
// instead of crashing the runtime. The enforcer must keep running even
// when one check has a bug — that's the point of the witness.
export function safe(checkBody) {
  return async function safeCheck(state = {}, opts = {}) {
    try {
      const out = await checkBody(state || {}, opts || {});
      if (out && typeof out === "object" && "pass" in out) return out;
      return result(false, { error: "check_returned_invalid_shape", out });
    } catch (e) {
      return result(false, {
        error: String(e && e.message ? e.message : e),
        stack: e && e.stack ? String(e.stack).split("\n").slice(0, 6) : null,
      });
    }
  };
}

// Filesystem helpers — synchronous and forgiving.
export function fileExists(p) {
  if (!p) return false;
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

export function readTextSafe(p, max = 2_000_000) {
  if (!fileExists(p)) return null;
  try {
    const s = statSync(p);
    if (s.size > max) return null;
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

export function sha256OfFile(p) {
  if (!fileExists(p)) return null;
  try {
    const h = createHash("sha256");
    h.update(readFileSync(p));
    return h.digest("hex");
  } catch {
    return null;
  }
}

export function sha256OfString(s) {
  return createHash("sha256").update(String(s)).digest("hex");
}

// Recursive grep — yields { file, line, text } for every match.
// Used by static scans (G-01, G-05, G-07, G-26). Bounded to keep the
// witness cheap; refuses to walk into node_modules / .git / 18-HELD.
// Tightened default ceiling (2026-06-24): 5000 was too generous for the
// runtime's 5s/check budget on a ~8K-file Orange5 tree. 1500 keeps each
// static-scan check well inside budget while still catching real offenders
// (production directories are far smaller than the full tree). Callers
// that need to walk more can override via opts.maxFiles.
export async function* walkGrep(
  root,
  pattern,
  { extensions = null, skipDirs = DEFAULT_SKIP, maxFiles = 1500 } = {}
) {
  let visited = 0;
  const rx = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  async function* walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = resolve(dir, e.name);
      if (e.isDirectory()) {
        if (skipDirs.has(e.name)) continue;
        yield* walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      if (extensions && !extensions.some((x) => e.name.endsWith(x))) continue;
      if (++visited > maxFiles) return;
      let text;
      try {
        text = await fs.readFile(full, "utf8");
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (rx.test(lines[i])) {
          yield { file: full, line: i + 1, text: lines[i].slice(0, 400) };
        }
      }
    }
  }
  if (!fileExists(root)) return;
  yield* walk(root);
}

export const DEFAULT_SKIP = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  ".turbo",
  ".cache",
  "18-HELD", // held area is bonded — static scans do not enter
  "19-ARCHIVE", // archive is read-only history
]);

// Env helper — boolean "is this var both present and non-empty".
export function envSet(name) {
  const v = process.env[name];
  return typeof v === "string" && v.length > 0;
}

// Numeric env helper — returns parsed integer or null.
export function envInt(name) {
  const v = process.env[name];
  if (typeof v !== "string") return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}
