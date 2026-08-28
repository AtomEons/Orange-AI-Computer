// G22 — Reality Flux daemon reachable (cobra loopback or shadow cache fallback).
//
// MEDIUM severity: a missing daemon doesn't stop the guardrail sweep but is
// reported so the cockpit can light up the right dot.

import { fluxHealthz } from "../lib/flux-client.mjs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ORANGE5_ROOT } from "../lib/paths.mjs";

export async function run() {
  const h = await fluxHealthz();
  if (h.ok) {
    return { pass: true, details: { source: h.source, cobra: h.cobra ?? null } };
  }
  const shadow = resolve(ORANGE5_ROOT, "06-ORANGELLM/memory/cache/state-brief.last.json");
  if (existsSync(shadow)) {
    return {
      pass: true,
      details: { reason: "cobra unreachable but shadow cache present (degraded)", shadow_path: shadow },
    };
  }
  return {
    pass: false,
    details: { reason: "cobra unreachable and no shadow cache", detail: h.detail },
  };
}
