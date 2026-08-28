// G06 — Frontier work routed only via the frontier gateway.
//
// Outside the gateway module itself, code MUST NOT directly fetch frontier
// model endpoints (api.openai.com, generativelanguage.googleapis.com,
// api.anthropic.com — Claude has its own lane through the gateway too).
// Gateway is at 06-ORANGELLM/server/boundary.mjs.

import { resolve } from "node:path";
import { ORANGE5_ROOT } from "../lib/paths.mjs";
import { walk, readSafe } from "../lib/scan.mjs";

const FRONTIER_HOSTS = [
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "api.x.ai",
  "api.mistral.ai",
];

const GATEWAY_GLOB = resolve(ORANGE5_ROOT, "06-ORANGELLM").replaceAll("\\", "/");

export async function run() {
  const files = walk(ORANGE5_ROOT, {
    exts: [".mjs", ".js", ".ts", ".tsx", ".py"],
    maxFiles: 6000,
  });
  const offenders = [];
  for (const f of files) {
    const fp = f.replaceAll("\\", "/");
    // Gateway module is allowed to talk to frontier hosts
    if (fp.startsWith(GATEWAY_GLOB)) continue;
    // Doctrine docs and this checker itself may reference the hosts
    if (fp.includes("/01-DOCTRINE/27-guardrails/")) continue;
    // Schema fixtures declare allowed egress strings; they do not perform IO.
    if (
      fp.includes("/tests/")
      || fp.includes("/__tests__/")
      || fp.includes("/fixtures/")
      || /\.(test|spec)\.[^/]+$/.test(fp)
      || /\/fixtures\.[^/]+$/.test(fp)
    ) continue;
    const body = readSafe(f);
    if (!body) continue;
    const hits = FRONTIER_HOSTS.filter((h) => body.includes(h));
    if (hits.length > 0) offenders.push({ file: f, hosts: hits });
  }
  if (offenders.length > 0) {
    return {
      pass: false,
      details: {
        reason: "frontier host referenced outside gateway",
        gateway: GATEWAY_GLOB,
        offenders: offenders.slice(0, 5),
      },
    };
  }
  return { pass: true, details: { scanned_files: files.length } };
}
