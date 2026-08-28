#!/usr/bin/env node
// 08-HERMES / tests / mcp-tool-policy.test.mjs
//
// Hermetic tests for policy/mcp-tool-policy.mjs. Pure determinism, no
// network, no fs, no clock-dependence.
//
// Run:  node 08-HERMES/tests/mcp-tool-policy.test.mjs

import {
  classifyToolCall,
  parseToolName,
  buildAllowList,
  listAllPolicies,
  compareRisk,
  RISK_LADDER,
  POLICY_META,
} from "../policy/mcp-tool-policy.mjs";

let pass = 0, fail = 0;
const results = [];

function assert(cond, msg) {
  if (cond) { pass += 1; results.push(["PASS", msg]); }
  else      { fail += 1; results.push(["FAIL", msg]); }
}
function eq(a, b, msg) {
  assert(JSON.stringify(a) === JSON.stringify(b), `${msg} (got=${JSON.stringify(a)} want=${JSON.stringify(b)})`);
}

console.log("mcp-tool-policy.test.mjs");

// ── [1] ladder and meta ─────────────────────────────────────────────────────
console.log("\n[1] ladder + meta");
assert(RISK_LADDER[0] === "read_only", "ladder begins read_only");
assert(RISK_LADDER[RISK_LADDER.length - 1] === "production", "ladder ends production");
assert(compareRisk("low", "high") < 0, "low < high");
assert(compareRisk("high", "low") > 0, "high > low");
assert(compareRisk("medium", "medium") === 0, "medium == medium");
assert(compareRisk("UNKNOWN", "low") > 0, "unknown sorts highest");
assert(POLICY_META.id === "hermes.policy.mcp-tool.v1", "policy meta id");

// ── [2] parseToolName shapes ────────────────────────────────────────────────
console.log("\n[2] parseToolName");
{
  const p = parseToolName("mcp__chrome-devtools__take_screenshot");
  eq(p, { server: "chrome-devtools", tool: "take_screenshot", source: "mcp_namespace" }, "mcp__server__tool");
}
{
  const p = parseToolName("cd.navigate_page");
  eq(p, { server: "chrome-devtools", tool: "navigate_page", source: "verb_prefix" }, "verb prefix cd.");
}
{
  const p = parseToolName("desktop.left_click");
  eq(p, { server: "computer-use", tool: "left_click", source: "verb_prefix" }, "verb prefix desktop.");
}
{
  const p = parseToolName("github:create_pull_request");
  eq(p, { server: "github", tool: "create_pull_request", source: "delim" }, "server:tool delim");
}
{
  const p = parseToolName("write_file"); // bare exact in filesystem-atomeons
  assert(p && p.server === "filesystem-atomeons" && p.tool === "write_file", "bare write_file");
}
assert(parseToolName("") === null, "empty -> null");
assert(parseToolName(null) === null, "null -> null");

// UUID alias resolution
{
  const p = parseToolName("mcp__5c7fbfed-1cd8-4816-94da-af57316a6405__execute_sql");
  assert(p && p.server === "supabase" && p.tool === "execute_sql", "uuid alias -> supabase");
}

// ── [3] classifyToolCall — exact tool matches ───────────────────────────────
console.log("\n[3] classifyToolCall exact");
{
  const v = classifyToolCall("cd.take_screenshot");
  eq(v.risk_level, "read_only", "cd.take_screenshot read_only");
  eq(v.default_allowed, true, "cd.take_screenshot default_allowed");
  eq(v.requires_approval, false, "cd.take_screenshot no approval");
  eq(v.match, "exact", "cd.take_screenshot exact");
  eq(v.verb, "cd.take_screenshot", "cd.take_screenshot verb echoed");
}
{
  const v = classifyToolCall("cd.evaluate_script");
  eq(v.risk_level, "high", "cd.evaluate_script high");
  eq(v.default_allowed, false, "cd.evaluate_script not default_allowed");
  eq(v.requires_approval, true, "cd.evaluate_script requires_approval");
}
{
  const v = classifyToolCall("cd.close_page");
  eq(v.risk_level, "destructive", "cd.close_page destructive");
  eq(v.requires_approval, true, "cd.close_page requires_approval");
}
{
  const v = classifyToolCall("desktop.left_click");
  eq(v.risk_level, "medium", "desktop.left_click medium");
  eq(v.default_allowed, false, "desktop.left_click not default_allowed");
  eq(v.requires_approval, true, "desktop.left_click requires approval");
}
{
  const v = classifyToolCall("desktop.screenshot");
  eq(v.risk_level, "low", "desktop.screenshot low");
  eq(v.default_allowed, true, "desktop.screenshot default_allowed");
}
{
  const v = classifyToolCall("desktop.computer_batch");
  eq(v.risk_level, "high", "desktop.computer_batch high");
  eq(v.requires_approval, true, "desktop.computer_batch requires_approval");
}

// ── [4] classifyToolCall — patterns ─────────────────────────────────────────
console.log("\n[4] classifyToolCall pattern");
{
  const v = classifyToolCall("mcp__github__list_issues");
  eq(v.risk_level, "read_only", "github list_issues read_only");
  eq(v.match, "pattern", "github list_issues pattern match");
}
{
  const v = classifyToolCall("mcp__github__create_pull_request");
  eq(v.risk_level, "high", "github create_pull_request high");
  eq(v.requires_approval, true, "github create_pr requires_approval");
}
{
  const v = classifyToolCall("mcp__github__merge_pull_request");
  eq(v.risk_level, "destructive", "github merge_pull_request destructive");
}
{
  const v = classifyToolCall("mcp__github__delete_file");
  eq(v.risk_level, "destructive", "github delete_file destructive");
}
{
  const v = classifyToolCall("mcp__5c7fbfed-1cd8-4816-94da-af57316a6405__execute_sql");
  eq(v.risk_level, "high", "supabase execute_sql high");
}
{
  const v = classifyToolCall("mcp__5c7fbfed-1cd8-4816-94da-af57316a6405__apply_migration");
  eq(v.risk_level, "destructive", "supabase apply_migration destructive");
}
{
  const v = classifyToolCall("mcp__5c7fbfed-1cd8-4816-94da-af57316a6405__deploy_edge_function");
  eq(v.risk_level, "production", "supabase deploy_edge_function production");
  eq(v.requires_approval, true, "supabase deploy_edge requires_approval");
}
{
  const v = classifyToolCall("mcp__5c846130-b4d7-4f54-aa2e-caf8b67581fa__deploy_to_vercel");
  eq(v.risk_level, "production", "vercel deploy production");
}

// ── [5] unknown -> fail-closed ──────────────────────────────────────────────
console.log("\n[5] fail-closed");
{
  const v = classifyToolCall("mcp__nonexistent-server__doomsday_button");
  eq(v.risk_level, "destructive", "unknown server -> destructive");
  eq(v.default_allowed, false, "unknown -> not default_allowed");
  eq(v.requires_approval, true, "unknown -> requires_approval");
  eq(v.match, "default", "unknown -> match=default");
}
{
  // unknown tool on a KNOWN server with no pattern fallback — chrome-devtools
  // does not have a catch-all pattern, so an unknown tool falls closed.
  const v = classifyToolCall("cd.totally_made_up_verb");
  eq(v.risk_level, "destructive", "unknown cd. verb -> destructive");
  eq(v.match, "default", "unknown cd. -> match=default");
}
{
  // unknown tool on computer-use HAS a catch-all → "high"
  const v = classifyToolCall("desktop.never_heard_of_this");
  eq(v.risk_level, "high", "unknown desktop. verb -> high (catch-all pattern)");
  eq(v.match, "pattern", "unknown desktop. -> pattern catch-all");
}
{
  const v = classifyToolCall("");
  eq(v.match, "default", "empty -> fail-closed");
}
{
  const v = classifyToolCall(null);
  eq(v.match, "default", "null -> fail-closed");
}

// ── [6] object-shaped input ─────────────────────────────────────────────────
console.log("\n[6] object input");
{
  const v = classifyToolCall({ server: "chrome-devtools", tool: "click" });
  eq(v.risk_level, "medium", "object {server,tool} click");
  eq(v.verb, "cd.click", "object input synthesizes verb");
}

// ── [7] buildAllowList ──────────────────────────────────────────────────────
console.log("\n[7] buildAllowList");
{
  const out = buildAllowList([
    "cd.take_screenshot",
    "cd.navigate_page",
    "cd.click",
  ]);
  eq(out.allowed, ["cd.click", "cd.navigate_page", "cd.take_screenshot"], "allowed sorted+deduped");
  eq(out.riskLevel, "medium", "max risk = medium");
  eq(out.requires_approval, false, "no approval needed at medium");
  eq(out.unknown, [], "no unknowns");
}
{
  const out = buildAllowList([
    "cd.take_screenshot",
    "cd.evaluate_script",
  ]);
  eq(out.riskLevel, "high", "high lifts the lease");
  eq(out.requires_approval, true, "high requires_approval");
}
{
  const out = buildAllowList([
    "cd.take_screenshot",
    "mcp__nonexistent__doomsday",
  ]);
  eq(out.unknown, ["mcp__nonexistent__doomsday"], "unknown surfaced");
  eq(out.riskLevel, "destructive", "unknown lifts lease to destructive");
  eq(out.requires_approval, true, "unknown requires_approval");
}
{
  // dedupe across name shapes that resolve to the same verb
  const out = buildAllowList([
    "cd.click",
    "mcp__chrome-devtools__click",
  ]);
  eq(out.allowed, ["cd.click"], "dedupe across shapes (verbPrefix wins)");
}
try {
  buildAllowList("not-an-array");
  assert(false, "buildAllowList throws on non-array");
} catch (e) {
  assert(e instanceof TypeError, "buildAllowList throws TypeError on non-array");
}

// ── [8] listAllPolicies ─────────────────────────────────────────────────────
console.log("\n[8] listAllPolicies");
{
  const all = listAllPolicies();
  assert(all.length > 0, "listAllPolicies non-empty");
  const cdScreenshot = all.find((p) => p.server === "chrome-devtools" && p.tool === "take_screenshot");
  assert(cdScreenshot && cdScreenshot.risk_level === "read_only", "lists cd.take_screenshot");
  // every entry has the four required fields
  const malformed = all.find((p) => !p.server || !p.tool || !p.risk_level || !RISK_LADDER.includes(p.risk_level));
  assert(!malformed, `no malformed entries (sample bad=${JSON.stringify(malformed)})`);
}

// ── [9] determinism ─────────────────────────────────────────────────────────
console.log("\n[9] determinism");
{
  const a = classifyToolCall("cd.evaluate_script");
  const b = classifyToolCall("cd.evaluate_script");
  eq(a, b, "same input -> same verdict");
}

// ── summary ─────────────────────────────────────────────────────────────────
console.log("");
for (const [s, m] of results) console.log(`  ${s} ${m}`);
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
