#!/usr/bin/env node
import { describeImage, inspectUrl, screenshot, SPEC } from "../src/visual-client.mjs";

let pass = 0, fail = 0;
const assert = (c, m) => c ? (pass++, console.log(`  PASS ${m}`)) : (fail++, console.log(`  FAIL ${m}`));

assert(SPEC.primary === "GLM-4.6V (z.ai)", "primary VLM named");
assert(SPEC.secondary.includes("Playwright MCP"), "Playwright MCP listed");
assert(SPEC.addendum.includes("MiniEyes"), "MiniEyes is addendum");

const r1 = await describeImage("test.png");
assert(r1.kind === "image" && r1.meta.tool === "stub", "describeImage returns scaffold stub");

const r2 = await inspectUrl("http://example.com");
assert(r2.kind === "url" && r2.text.includes("not yet wired"), "inspectUrl scaffold contract");

const r3 = await screenshot("window:cockpit");
assert(r3.kind === "screenshot", "screenshot scaffold contract");

console.log(`\n[visual-tests] ${pass} passed / ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
