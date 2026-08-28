#!/usr/bin/env node
// AELang-Core emitter tests.
// Real tests — exercise dispatch, lane resolution, risk escalation, deadline
// resolution (with fixed anchor for determinism), and validator catches.

import { parseHigh } from "./high-parser.mjs";
import {
  emitCore,
  validateCorePacket,
  CORE_SCHEMA,
  CORE_VERBS,
  RISK_LEVELS,
  DEPARTMENTS,
  VERB_DEFAULT_LANE,
} from "./core-emitter.mjs";

let pass = 0, fail = 0;
const T = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? "  -- " + extra : ""}`); }
};
const dump = (x) => JSON.stringify(x, null, 2);

// Fixed anchor used everywhere so "by Friday" → known wall-clock.
// 2026-06-24 is a WEDNESDAY (UTC).
const NOW = "2026-06-24T15:00:00.000Z";

// ---------------------------------------------------------------------------
// 1) Canonical doctrine: ship Orange5 v1 with Æ Cobra LIVE by Friday
// ---------------------------------------------------------------------------
console.log("\n[1] Canonical: ship Orange5 v1 with Æ Cobra LIVE by Friday");
{
  const high = parseHigh("ship Orange5 v1 with Æ Cobra LIVE by Friday");
  const r = emitCore(high.ir, { now: NOW });
  T("emit ok", r.ok, dump(r.errors));
  T("one packet", r.packets.length === 1);
  const p = r.packets[0];
  T("schema set", p.schema === CORE_SCHEMA);
  T("action_verb = ship", p.action_verb === "ship");
  T("primary = Orange5", p.target_lattice.primary === "Orange5");
  T("version = v1", p.target_lattice.version === "v1");
  T("target_state = LIVE", p.target_lattice.target_state === "LIVE");
  T("collateral contains Æ Cobra", p.target_lattice.collateral.some(c => /Cobra|Æ/.test(c)));
  T("risk = production (ship + LIVE)", p.risk_level === "production");
  T("lane department resolves", DEPARTMENTS.includes(p.lane_route.department));
  T("path goes through REVIEW before LAUNCH", p.lane_route.path.indexOf("AE7_REVIEW") <
                                              p.lane_route.path.indexOf("AE8_LAUNCH"));
  T("deadline.kind = relative", p.deadline?.kind === "relative");
  T("deadline resolves to a Friday", p.deadline?.resolved_iso?.startsWith("2026-06-26"),
    "got " + p.deadline?.resolved_iso);
  T("packet validates", validateCorePacket(p).ok);
}

// ---------------------------------------------------------------------------
// 2) Universal scope + set fan-out: compress all 12 AtomSmasher modules to LIVE
// ---------------------------------------------------------------------------
console.log("\n[2] compress all 12 AtomSmasher modules to LIVE");
{
  const high = parseHigh("compress all 12 AtomSmasher modules to LIVE");
  const r = emitCore(high.ir, { now: NOW });
  T("ok", r.ok, dump(r.errors));
  const p = r.packets[0];
  T("verb = compress", p.action_verb === "compress");
  T("scope = universal", p.target_lattice.scope === "universal");
  T("ordinal carries universal flag", p.target_lattice.ordinals[0]?.universal === true);
  T("ordinal carries count=12", p.target_lattice.ordinals[0]?.count === 12);
  T("fan_out = 12", p.lane_route.fan_out === 12, "got " + p.lane_route.fan_out);
  T("composition = parallel", p.lane_route.composition === "parallel");
  T("risk escalated to production (LIVE floor)", p.risk_level === "production");
}

// ---------------------------------------------------------------------------
// 3) Verb defaults + risk hints: research dashboard dry run in code lane
// ---------------------------------------------------------------------------
console.log("\n[3] research dashboard dry run in code");
{
  const high = parseHigh("research dashboard dry run in code");
  T("high parsed ok", high.ok, dump(high.errors));
  const r = emitCore(high.ir, { now: NOW });
  T("ok", r.ok, dump(r.errors));
  const p = r.packets[0];
  T("verb mapped research→analyze", p.action_verb === "analyze");
  T("risk = read_only", p.risk_level === "read_only");
  // explicit "in code" lane hint binds
  T("lane = AE6_CODE", p.lane_route.department === "AE6_CODE",
    "got " + p.lane_route.department);
  T("analyze path = [department] (no REVIEW gate)", p.lane_route.path.length === 1);
}

// ---------------------------------------------------------------------------
// 4) Sequence composition: build dashboard then ship dashboard to LIVE
// ---------------------------------------------------------------------------
console.log("\n[4] build dashboard then ship dashboard to LIVE");
{
  const high = parseHigh("build dashboard then ship dashboard to LIVE");
  const r = emitCore(high.ir, { now: NOW });
  T("ok", r.ok, dump(r.errors));
  T("two packets", r.packets.length === 2);
  T("composition = sequence", r.composition === "sequence");
  T("first packet = build", r.packets[0].action_verb === "build");
  T("second packet = ship", r.packets[1].action_verb === "ship");
  T("second packet risk = production", r.packets[1].risk_level === "production");
}

// ---------------------------------------------------------------------------
// 5) Known-artifact registry overrides defaults
// ---------------------------------------------------------------------------
console.log("\n[5] knownArtifacts steers the lane");
{
  const high = parseHigh("build Pathwaves v2");
  const r = emitCore(high.ir, {
    now: NOW,
    knownArtifacts: { "Pathwaves": "AE1_PRODUCT" },
  });
  T("ok", r.ok, dump(r.errors));
  const p = r.packets[0];
  T("lane resolved via registry", p.lane_route.department === "AE1_PRODUCT");
}

// ---------------------------------------------------------------------------
// 6) Deadline kinds — keyword, quarter, absolute
// ---------------------------------------------------------------------------
console.log("\n[6] deadline resolution variety");
{
  const r1 = emitCore(parseHigh("ship feature by EOW").ir, { now: NOW });
  T("EOW resolves", r1.packets[0].deadline?.resolved_iso?.length > 0);

  const r2 = emitCore(parseHigh("ship feature by Q3").ir, { now: NOW });
  T("Q3 kind", r2.packets[0].deadline?.kind === "quarter");
  T("Q3 resolves to Sep 30", r2.packets[0].deadline?.resolved_iso?.startsWith("2026-09-30"),
    "got " + r2.packets[0].deadline?.resolved_iso);

  const r3 = emitCore(parseHigh("ship feature by 2026-12-01").ir, { now: NOW });
  T("absolute date kind", r3.packets[0].deadline?.kind === "absolute");
  T("absolute resolves to 2026-12-01T23:59:59Z",
    r3.packets[0].deadline?.resolved_iso === "2026-12-01T23:59:59.000Z",
    "got " + r3.packets[0].deadline?.resolved_iso);
}

// ---------------------------------------------------------------------------
// 7) Deploy and rollback have special paths
// ---------------------------------------------------------------------------
console.log("\n[7] deploy / rollback paths");
{
  const dep = emitCore(parseHigh("deploy Orange5 to LIVE").ir, { now: NOW });
  const p = dep.packets[0];
  T("deploy path includes AE10_OPS", p.lane_route.path.includes("AE10_OPS"));
  T("deploy passes REVIEW first", p.lane_route.path.indexOf("AE7_REVIEW") <
                                  p.lane_route.path.indexOf("AE10_OPS"));
  T("deploy risk = production", p.risk_level === "production");

  const rb = emitCore(parseHigh("rollback Orange5").ir, { now: NOW });
  const q = rb.packets[0];
  T("rollback risk high+", RISK_LEVELS.indexOf(q.risk_level) >= RISK_LEVELS.indexOf("high"));
  T("rollback path begins with AE10_OPS", q.lane_route.path[0] === "AE10_OPS");
}

// ---------------------------------------------------------------------------
// 8) Deterministic packet IDs
// ---------------------------------------------------------------------------
console.log("\n[8] deterministic packet_id");
{
  const a = emitCore(parseHigh("build dashboard").ir, { now: NOW }).packets[0];
  const b = emitCore(parseHigh("build dashboard").ir, { now: NOW }).packets[0];
  T("same intent → same packet_id", a.packet_id === b.packet_id, a.packet_id + " vs " + b.packet_id);
  T("packet_id encodes verb", a.packet_id.startsWith("core-build-"));
}

// ---------------------------------------------------------------------------
// 9) Validator rejects malformed packets
// ---------------------------------------------------------------------------
console.log("\n[9] validateCorePacket catches drift");
{
  const good = emitCore(parseHigh("build dashboard").ir, { now: NOW }).packets[0];
  T("good packet validates", validateCorePacket(good).ok);

  const bad1 = { ...good, schema: "wrong.schema" };
  T("bad schema rejected", !validateCorePacket(bad1).ok);

  const bad2 = { ...good, action_verb: "yeet" };
  T("bad verb rejected", !validateCorePacket(bad2).ok);

  const bad3 = { ...good, risk_level: "spicy" };
  T("bad risk rejected", !validateCorePacket(bad3).ok);

  const bad4 = { ...good, lane_route: { ...good.lane_route, department: "AE99_GHOST" } };
  T("bad department rejected", !validateCorePacket(bad4).ok);

  const bad5 = { ...good, target_lattice: { ...good.target_lattice, scope: "weird" } };
  T("bad scope rejected", !validateCorePacket(bad5).ok);

  T("null packet rejected", !validateCorePacket(null).ok);
}

// ---------------------------------------------------------------------------
// 10) Refuses invalid HighIR
// ---------------------------------------------------------------------------
console.log("\n[10] invalid HighIR is rejected");
{
  const r = emitCore({ schema: "wrong", clauses: [], composition: "parallel", raw_intent: "" });
  T("not ok", !r.ok);
  T("no packets emitted", r.packets.length === 0);
  T("error reported", r.errors.length > 0);
}

// ---------------------------------------------------------------------------
// 11) Sanity: every verb default lane points to a real department
// ---------------------------------------------------------------------------
console.log("\n[11] structural integrity");
{
  for (const verb of CORE_VERBS) {
    T(`VERB_DEFAULT_LANE[${verb}] is real department`,
      DEPARTMENTS.includes(VERB_DEFAULT_LANE[verb]),
      "got " + VERB_DEFAULT_LANE[verb]);
  }
  T("RISK_LEVELS strictly ordered low→high",
    RISK_LEVELS.indexOf("read_only") < RISK_LEVELS.indexOf("low") &&
    RISK_LEVELS.indexOf("low") < RISK_LEVELS.indexOf("destructive"));
}

// ---------------------------------------------------------------------------
console.log(`\nResult: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
