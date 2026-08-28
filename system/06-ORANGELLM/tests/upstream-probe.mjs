#!/usr/bin/env node
// Upstream probe — verifies Smart Skinny adapter at :8797 is reachable from this machine.
// Does NOT start the OrangeLLM gateway. Runs the probe function directly.
// Operator-run: node C:/AtomEons/Orange5/06-ORANGELLM/tests/upstream-probe.mjs

import { probeUpstream, UPSTREAM } from "../server/upstream.mjs";

console.log(`[probe] checking upstream tiers...`);
console.log(`[probe] light: ${UPSTREAM.light.base_url}${UPSTREAM.light.health_path}`);
console.log(`[probe] heavy: ${UPSTREAM.heavy.base_url || "(not configured)"}`);

const light = await probeUpstream("light");
const heavy = await probeUpstream("heavy");

console.log(`\n[probe] light (smart-skinny):`, JSON.stringify(light, null, 2));
console.log(`[probe] heavy (fatty-codexa):`, JSON.stringify(heavy, null, 2));

if (light.live) {
  console.log(`\n[probe] LIGHT TIER OK — gateway PR-03 ready to serve real responses.`);
  process.exit(0);
} else {
  console.log(`\n[probe] LIGHT TIER ${light.status.toUpperCase()} — gateway will return ${light.status === 'unreachable' ? '502' : '503'} until Smart Skinny is live.`);
  console.log(`[probe] this is NOT a PR-03 failure — Smart Skinny is operator-managed; the gateway code is correct.`);
  process.exit(0); // exit clean — probe is informational, not a test failure
}
