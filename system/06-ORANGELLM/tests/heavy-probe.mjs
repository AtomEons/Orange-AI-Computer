#!/usr/bin/env node
// Heavy-tier probe — checks Codexa Ollama reachability via two paths.
// Operator-run: node C:/AtomEons/Orange5/06-ORANGELLM/tests/heavy-probe.mjs

import { probeUpstream, UPSTREAM } from "../server/upstream.mjs";

console.log(`[heavy-probe] checking Codexa heavy tier`);
console.log(`[heavy-probe] primary path:  ${UPSTREAM.heavy.base_url}${UPSTREAM.heavy.tags_path}`);
console.log(`[heavy-probe] fallback path: ${UPSTREAM.heavy.fallback.base_url}${UPSTREAM.heavy.fallback.health_path}`);
console.log(`[heavy-probe] target model:  ${UPSTREAM.heavy.model}`);

const probe = await probeUpstream("heavy");
console.log(`\n[heavy-probe] result:`, JSON.stringify(probe, null, 2));

if (probe.live) {
  console.log(`\n[heavy-probe] LIVE via ${probe.preferred_route}`);
  process.exit(0);
} else {
  console.log(`\n[heavy-probe] NOT REACHABLE`);
  console.log(`[heavy-probe] gateway will return 502 heavy_unreachable until at least one path is live.`);
  console.log(`[heavy-probe] PR-04 spec is still GREEN — this probe is informational.`);
  process.exit(0);
}
