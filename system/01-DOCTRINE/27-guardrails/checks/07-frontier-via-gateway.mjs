// 07 — G-06 — Frontier work routes only via the Frontier Gateway.
//
// Online check, with a static-grep supplement. The runtime state provides
// `state.frontierCalls` — an array of recent frontier-module invocations,
// each with shape:
//   { caller_file, called_module, gateway_token: string|null, ts }
// A call is valid iff:
//   - called_module path starts with one of the frontier roots, AND
//   - the call passed a non-empty `gateway_token` AND
//   - the caller is `13-TOOLMESH/frontier_gateway.js` itself OR has been
//     registered with the gateway (state.frontierGatewayAllowlist).
//
// Static prong: grep `02-APP`, `03-BACKEND`, `04-CONTROL-PLANE` for direct
// imports of frontier modules (paths under `11-MIRAGE/` or `13-TOOLMESH/
// frontier_*`) that bypass the gateway entry point.

import { resolve } from "node:path";
import {
  safe,
  result,
  ORANGE5_ROOT,
  walkGrep,
} from "../lib/check-util.mjs";

export const id = "G-06";
export const slug = "frontier-via-gateway";
export const severity = "block";

const PRODUCTION_ROOTS = ["02-APP", "03-BACKEND", "04-CONTROL-PLANE"];
const BAD_IMPORT_RX =
  /from\s+['"][^'"]*\/(?:11-MIRAGE|13-TOOLMESH\/frontier_(?!gateway\b))[^'"]*['"]/;

export const check = safe(async (state, opts) => {
  const calls = Array.isArray(state.frontierCalls) ? state.frontierCalls : [];
  const allowlist = new Set(state.frontierGatewayAllowlist || []);
  const offenders = [];

  for (const c of calls) {
    if (!c) continue;
    const gw = c.caller_file || "";
    if (gw.replace(/\\/g, "/").endsWith("/13-TOOLMESH/frontier_gateway.js"))
      continue;
    if (!c.gateway_token || typeof c.gateway_token !== "string") {
      offenders.push({ ...c, reason: "no_gateway_token" });
      continue;
    }
    if (allowlist.size > 0 && !allowlist.has(c.caller_file)) {
      offenders.push({ ...c, reason: "caller_not_in_allowlist" });
    }
  }

  // Static grep — direct imports of frontier modules from production roots.
  const staticHits = [];
  for (const r of PRODUCTION_ROOTS) {
    const root = resolve(opts.scanRoot || ORANGE5_ROOT, r);
    for await (const m of walkGrep(root, BAD_IMPORT_RX, {
      extensions: [".js", ".mjs", ".ts", ".tsx"],
    })) {
      staticHits.push({ file: m.file, line: m.line, text: m.text });
      if (staticHits.length >= 25) break;
    }
    if (staticHits.length >= 25) break;
  }

  if (offenders.length > 0 || staticHits.length > 0) {
    return result(false, {
      reason: "frontier_bypass",
      runtime_offenders: offenders,
      static_offenders: staticHits,
      call_count: calls.length,
      receipt_trigger: "G06_FRONTIER_BYPASS",
    });
  }

  return result(true, {
    call_count: calls.length,
    static_hits: 0,
  });
});

export default check;
