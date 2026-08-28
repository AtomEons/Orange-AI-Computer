#!/usr/bin/env node
// Tests for 08-HERMES/src/pre-action/risk-matrix.mjs
//
// Doctrine: pure determinism. Same input -> same output. The required
// mappings from the workflow spec are pinned hard:
//   production_deploy = critical (blocking + human approval)
//   schema_migration  = high     (blocking)
//   destructive_write = critical (blocking + human approval)
//   file_create       = low      (no second opinion)
//   query_only        = low      (no second opinion)

import {
  evaluateRisk,
  evaluateRiskPositional,
  verdictForLevel,
  RISK_LADDER,
  SCHEMA,
  __internals,
} from "../src/pre-action/risk-matrix.mjs";

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  PASS ${msg}`); }
  else      { fail++; console.log(`  FAIL ${msg}`); }
}
function eq(a, b, msg) { assert(a === b, `${msg} (got=${JSON.stringify(a)} want=${JSON.stringify(b)})`); }

console.log("risk-matrix.test.mjs");

// ---------------------------------------------------------------------------
// Section 1: required mappings from the workflow spec

console.log("\n[1] required mappings");

{
  const r = evaluateRisk({ action_verb: "production_deploy" });
  eq(r.effective_risk, "critical", "production_deploy -> critical");
  eq(r.required_second_opinion, true, "production_deploy requires second opinion");
  eq(r.blocking, true, "production_deploy is blocking");
  eq(r.requires_human_approval, true, "production_deploy requires human approval");
}
{
  const r = evaluateRisk({ action_verb: "schema_migration" });
  eq(r.effective_risk, "high", "schema_migration -> high");
  eq(r.required_second_opinion, true, "schema_migration requires second opinion");
  eq(r.blocking, true, "schema_migration is blocking");
  eq(r.requires_human_approval, false, "schema_migration does NOT require human approval by itself");
}
{
  const r = evaluateRisk({ action_verb: "destructive_write" });
  eq(r.effective_risk, "critical", "destructive_write -> critical");
  eq(r.required_second_opinion, true, "destructive_write requires second opinion");
  eq(r.blocking, true, "destructive_write is blocking");
  eq(r.requires_human_approval, true, "destructive_write requires human approval");
}
{
  const r = evaluateRisk({ action_verb: "file_create" });
  eq(r.effective_risk, "low", "file_create -> low");
  eq(r.required_second_opinion, false, "file_create does NOT require second opinion");
  eq(r.blocking, false, "file_create is not blocking");
  eq(r.requires_human_approval, false, "file_create does NOT require human approval");
}
{
  const r = evaluateRisk({ action_verb: "query_only" });
  eq(r.effective_risk, "low", "query_only -> low");
  eq(r.required_second_opinion, false, "query_only does NOT require second opinion");
  eq(r.blocking, false, "query_only is not blocking");
}

// ---------------------------------------------------------------------------
// Section 2: determinism — same input gives same verdict, every time.

console.log("\n[2] determinism");

{
  const a = evaluateRisk({ action_verb: "production_deploy", target_project: "orange5", lease_risk_level: "low", evidence_hint: "unverified" });
  const b = evaluateRisk({ action_verb: "production_deploy", target_project: "orange5", lease_risk_level: "low", evidence_hint: "unverified" });
  eq(JSON.stringify(a), JSON.stringify(b), "identical inputs -> identical verdicts (JSON-stable)");
}
{
  const positional = evaluateRiskPositional("schema_migration", "orange5", "medium", "verified");
  const object = evaluateRisk({ action_verb: "schema_migration", target_project: "orange5", lease_risk_level: "medium", evidence_hint: "verified" });
  eq(JSON.stringify(positional), JSON.stringify(object), "positional API matches object API");
}

// ---------------------------------------------------------------------------
// Section 3: lease.risk_level raises the floor but never lowers it.

console.log("\n[3] lease_risk_level floor behavior");

{
  // file_create intrinsic=low; lease=high should raise to high.
  const r = evaluateRisk({ action_verb: "file_create", lease_risk_level: "high" });
  eq(r.effective_risk, "high", "lease=high raises file_create floor to high");
  eq(r.blocking, true, "raised file_create now blocking");
}
{
  // production_deploy intrinsic=critical; lease=low must NOT lower it.
  const r = evaluateRisk({ action_verb: "production_deploy", lease_risk_level: "low" });
  eq(r.effective_risk, "critical", "lease=low cannot lower production_deploy below critical");
}
{
  // schema_migration intrinsic=high; lease=critical raises to critical.
  const r = evaluateRisk({ action_verb: "schema_migration", lease_risk_level: "critical" });
  eq(r.effective_risk, "critical", "lease=critical raises schema_migration to critical");
  eq(r.requires_human_approval, true, "raised schema_migration now requires human approval");
}

// ---------------------------------------------------------------------------
// Section 4: production project bump

console.log("\n[4] production project bump");

{
  // file_create on a prod project bumps to medium.
  const r = evaluateRisk({ action_verb: "file_create", target_project: "skilski-live" });
  eq(r.effective_risk, "medium", "file_create on skilski-live bumps to medium");
  eq(r.advisory, true, "medium is advisory not blocking");
  eq(r.blocking, false, "medium is not blocking");
}
{
  // query_only is read-shaped; prod project must NOT bump it.
  const r = evaluateRisk({ action_verb: "query_only", target_project: "atomeons-prod" });
  eq(r.effective_risk, "low", "query_only on prod stays low (read-shaped)");
  eq(r.factors.project_bump, 0, "read-shaped verb gets no project bump");
}
{
  // Unknown project does nothing.
  const r = evaluateRisk({ action_verb: "file_edit", target_project: "some-random-dev-project" });
  eq(r.factors.project_bump, 0, "unknown project gets no bump");
}

// ---------------------------------------------------------------------------
// Section 5: evidence_hint delta

console.log("\n[5] evidence_hint delta");

{
  // schema_migration with verified evidence drops one rung to medium.
  const r = evaluateRisk({ action_verb: "schema_migration", evidence_hint: "verified" });
  eq(r.effective_risk, "medium", "schema_migration + verified evidence -> medium");
  eq(r.blocking, false, "medium evidence-mitigated is not blocking");
  eq(r.advisory, true, "medium is advisory");
}
{
  // file_create with missing evidence bumps to medium.
  const r = evaluateRisk({ action_verb: "file_create", evidence_hint: "missing" });
  eq(r.effective_risk, "medium", "file_create + missing evidence -> medium");
}
{
  // file_create with contradicted evidence bumps to high.
  const r = evaluateRisk({ action_verb: "file_create", evidence_hint: "contradicted" });
  eq(r.effective_risk, "high", "file_create + contradicted evidence -> high");
  eq(r.blocking, true, "contradicted evidence makes file_create blocking");
}
{
  // Critical can be reduced by verified_with_human_signoff (-2) to medium.
  const r = evaluateRisk({ action_verb: "production_deploy", evidence_hint: "verified_with_human_signoff" });
  eq(r.effective_risk, "medium", "production_deploy + verified_with_human_signoff -> medium");
}
{
  // Clamp: critical + contradicted stays critical (no overflow).
  const r = evaluateRisk({ action_verb: "destructive_write", evidence_hint: "contradicted" });
  eq(r.effective_risk, "critical", "critical + contradicted clamps at critical");
}
{
  // Clamp: low + verified stays low (no underflow).
  const r = evaluateRisk({ action_verb: "query_only", evidence_hint: "verified" });
  eq(r.effective_risk, "low", "low + verified clamps at low");
}

// ---------------------------------------------------------------------------
// Section 6: verdictForLevel sanity

console.log("\n[6] verdictForLevel");

{
  const v = verdictForLevel("low");
  eq(v.required_second_opinion, false, "low: no second opinion");
  eq(v.blocking, false, "low: not blocking");
  eq(v.advisory, false, "low: not advisory");
  eq(v.requires_human_approval, false, "low: no human approval");
}
{
  const v = verdictForLevel("medium");
  eq(v.required_second_opinion, true, "medium: second opinion required");
  eq(v.blocking, false, "medium: not blocking");
  eq(v.advisory, true, "medium: advisory");
  eq(v.requires_human_approval, false, "medium: no human approval");
}
{
  const v = verdictForLevel("high");
  eq(v.required_second_opinion, true, "high: second opinion required");
  eq(v.blocking, true, "high: blocking");
  eq(v.requires_human_approval, false, "high: no human approval (just second opinion)");
}
{
  const v = verdictForLevel("critical");
  eq(v.required_second_opinion, true, "critical: second opinion required");
  eq(v.blocking, true, "critical: blocking");
  eq(v.requires_human_approval, true, "critical: human approval required");
}

// ---------------------------------------------------------------------------
// Section 7: defensive edge cases

console.log("\n[7] defensive edges");

{
  // Empty input — unknown verb defaults to medium (advisory).
  const r = evaluateRisk({});
  eq(r.effective_risk, "medium", "empty input -> medium (unknown verbs are not auto-low)");
  eq(r.advisory, true, "empty input -> advisory");
}
{
  // Unknown verb defaults to medium.
  const r = evaluateRisk({ action_verb: "wiggle_the_thing" });
  eq(r.effective_risk, "medium", "unknown verb -> medium");
  eq(r.required_second_opinion, true, "unknown verb requires advisory second opinion");
}
{
  // Case-insensitive verb matching.
  const a = evaluateRisk({ action_verb: "PRODUCTION_DEPLOY" });
  const b = evaluateRisk({ action_verb: "production_deploy" });
  eq(a.effective_risk, b.effective_risk, "verb matching is case-insensitive");
}
{
  // Whitespace tolerance.
  const r = evaluateRisk({ action_verb: "  destructive_write  " });
  eq(r.effective_risk, "critical", "whitespace around verb is trimmed");
}
{
  // Null inputs do not throw.
  let threw = false;
  try { evaluateRisk({ action_verb: null, target_project: null, lease_risk_level: null, evidence_hint: null }); }
  catch (_) { threw = true; }
  eq(threw, false, "null inputs do not throw");
}

// ---------------------------------------------------------------------------
// Section 8: schema + ladder integrity

console.log("\n[8] schema + ladder");

eq(SCHEMA, "orange5.hermes.risk-matrix.v0", "schema id pinned");
eq(RISK_LADDER.length, 4, "risk ladder has 4 levels");
eq(RISK_LADDER[0], "low", "ladder[0]=low");
eq(RISK_LADDER[3], "critical", "ladder[3]=critical");
eq(__internals.rankOf("critical"), 3, "rankOf critical=3");
eq(__internals.rankOf("garbage"), 0, "rankOf unknown=0");
eq(__internals.intrinsicRiskOf("query_only"), "low", "intrinsicRiskOf query_only=low");
eq(__internals.intrinsicRiskOf("production_deploy"), "critical", "intrinsicRiskOf production_deploy=critical");

// ---------------------------------------------------------------------------
// Section 9: worked scenarios that mirror real Hermes leases

console.log("\n[9] worked scenarios");

{
  // OrangeLLM-light reading a file on dev orange5 with verified evidence.
  const r = evaluateRisk({
    action_verb: "read_file",
    target_project: "orange5",
    lease_risk_level: "low",
    evidence_hint: "verified",
  });
  eq(r.effective_risk, "low", "scenario: light read_file on dev -> low");
  eq(r.required_second_opinion, false, "scenario: light read_file -> no second opinion");
}
{
  // Heavy actor pushing a branch on dev with unverified evidence.
  const r = evaluateRisk({
    action_verb: "push_branch",
    target_project: "orange5",
    lease_risk_level: "medium",
    evidence_hint: "unverified",
  });
  eq(r.effective_risk, "high", "scenario: push_branch dev -> high");
  eq(r.blocking, true, "scenario: push_branch dev -> blocking");
  eq(r.requires_human_approval, false, "scenario: push_branch dev -> no human approval");
}
{
  // Production deploy with verified evidence + human signoff already in place.
  const r = evaluateRisk({
    action_verb: "production_deploy",
    target_project: "atomeons-prod",
    lease_risk_level: "high",
    evidence_hint: "verified_with_human_signoff",
  });
  // critical + prod_bump(+1) clamped to critical, then -2 -> high.
  eq(r.effective_risk, "high", "scenario: prod deploy with prior human signoff -> high");
  eq(r.blocking, true, "still blocking; second opinion still required");
  eq(r.requires_human_approval, false, "human signoff captured by evidence; no NEW approval required");
}
{
  // Destructive write attempted with contradicted evidence on a prod project.
  const r = evaluateRisk({
    action_verb: "destructive_write",
    target_project: "atomeons-payments",
    lease_risk_level: "high",
    evidence_hint: "contradicted",
  });
  eq(r.effective_risk, "critical", "scenario: destructive_write contradicted on prod -> critical");
  eq(r.requires_human_approval, true, "scenario: critical -> human approval required");
}

// ---------------------------------------------------------------------------
// Summary

console.log(`\n  ---\n  ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
