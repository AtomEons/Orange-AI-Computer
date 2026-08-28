#!/usr/bin/env node
// route-packet tests — wrap Core packets in ORANGEBOX Route Packets and exercise
// FATCAT envelope construction, header flattening, authority/gate resolution,
// extension mapping, ttl/deadline interplay, and validator catches.

import { parseHigh } from "./high-parser.mjs";
import { emitCore } from "./core-emitter.mjs";
import {
  buildRoutePacket,
  buildRoutePacketsFromEmit,
  validateRoutePacket,
  ROUTE_SCHEMA,
  DEPARTMENT_EXTENSIONS,
  PRIORITY_BY_RISK,
  GATES_BY_RISK,
  TRUNKING_BY_COMPOSITION,
  ORIGIN_LANES,
} from "./route-packet.mjs";

let pass = 0, fail = 0;
const T = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? "  -- " + extra : ""}`); }
};
const dump = (x) => JSON.stringify(x, null, 2);

// Fixed anchors so all wall-clock derivations are deterministic.
// 2026-06-24 is a WEDNESDAY (UTC).
const NOW = "2026-06-24T15:00:00.000Z";

function corePacketFor(intent, opts = {}) {
  const h = parseHigh(intent);
  if (!h.ok) throw new Error("high parse failed: " + dump(h.errors));
  const e = emitCore(h.ir, { now: NOW, ...opts });
  if (!e.ok) throw new Error("core emit failed: " + dump(e.errors));
  return { emit: e, core: e.packets[0] };
}

// ---------------------------------------------------------------------------
// 1) Canonical FATCAT envelope: ship Orange5 v1 with Æ Cobra LIVE by Friday
// ---------------------------------------------------------------------------
console.log("\n[1] FATCAT envelope: ship Orange5 v1 with Æ Cobra LIVE by Friday");
{
  const { core } = corePacketFor("ship Orange5 v1 with Æ Cobra LIVE by Friday");
  const r = buildRoutePacket(core, { now: NOW, operator_id: "atom", ttl_seconds: 900 });
  T("build ok", r.ok, dump(r.errors));
  const p = r.packet;
  T("schema set", p.schema === ROUTE_SCHEMA);
  T("route_id starts with rp-", p.route_id.startsWith("rp-"));
  T("wraps core packet_id", p.core_packet_id === core.packet_id);
  T("from.lane = operator", p.from.lane === "operator");
  T("from.operator_id = atom", p.from.operator_id === "atom");
  T("authority.risk_level = production", p.authority.risk_level === "production");
  T("authority.priority = 5", p.authority.priority === 5);
  T("authority requires Human Final Stop",
    p.authority.requires_human_final_stop === true);
  T("required_gates include review.AE7",
    p.authority.required_gates.includes("review.AE7"));
  T("required_gates include human_final_stop",
    p.authority.required_gates.includes("human_final_stop"));
  // Terminal extension is the LAST in path (Core convention for ship).
  T("to.department = last(path)",
    p.to.department === core.lane_route.path[core.lane_route.path.length - 1]);
  T("to.extension matches DEPARTMENT_EXTENSIONS",
    p.to.extension === DEPARTMENT_EXTENSIONS[p.to.department]);
  T("to.extensions length matches to.path",
    p.to.extensions.length === p.to.path.length);
  T("class_of_service.trunking matches composition",
    p.class_of_service.trunking === TRUNKING_BY_COMPOSITION[p.class_of_service.composition]);
  T("timing.dialed_at_iso = NOW", p.timing.dialed_at_iso === NOW);
  T("timing.ttl_seconds = 900", p.timing.ttl_seconds === 900);
  T("timing.expires_at_iso = NOW + 900s",
    p.timing.expires_at_iso === "2026-06-24T15:15:00.000Z");
  T("timing.deadline preserved",
    p.timing.deadline?.resolved_iso?.startsWith("2026-06-26"));
  T("headers contain X-AE-Route-Schema",
    p.headers["X-AE-Route-Schema"] === ROUTE_SCHEMA);
  T("headers contain action verb",
    p.headers["X-AE-Action-Verb"] === "ship");
  T("headers contain extension",
    p.headers["X-AE-To-Extension"] === p.to.extension);
  T("headers contain deadline ISO",
    typeof p.headers["X-AE-Timing-Deadline"] === "string");
  T("headers join path with > ",
    p.headers["X-AE-To-Path"] === p.to.path.join(">"));
  T("dispatch_meta.action_verb = ship",
    p.dispatch_meta.action_verb === "ship");
  T("dispatch_meta.correlation_id defaults to core packet_id",
    p.dispatch_meta.correlation_id === core.packet_id);
  T("core packet preserved verbatim", p.core === core);
  T("validateRoutePacket ok", validateRoutePacket(p).ok);
}

// ---------------------------------------------------------------------------
// 2) Extension numbering: AE6_CODE → x06, AE14_BENCH → x14, AE0_FACTORY → x00
// ---------------------------------------------------------------------------
console.log("\n[2] Extension numbering");
{
  T("AE0_FACTORY → x00", DEPARTMENT_EXTENSIONS["AE0_FACTORY"] === "x00");
  T("AE6_CODE → x06",    DEPARTMENT_EXTENSIONS["AE6_CODE"]    === "x06");
  T("AE7_REVIEW → x07",  DEPARTMENT_EXTENSIONS["AE7_REVIEW"]  === "x07");
  T("AE8_LAUNCH → x08",  DEPARTMENT_EXTENSIONS["AE8_LAUNCH"]  === "x08");
  T("AE14_BENCH → x14",  DEPARTMENT_EXTENSIONS["AE14_BENCH"]  === "x14");
}

// ---------------------------------------------------------------------------
// 3) Authority + gates table: verify produces read_only with no gates
// ---------------------------------------------------------------------------
console.log("\n[3] verify dashboard — read_only, no gates");
{
  const { core } = corePacketFor("verify dashboard");
  const r = buildRoutePacket(core, { now: NOW });
  T("ok", r.ok, dump(r.errors));
  T("risk_level = read_only", r.packet.authority.risk_level === "read_only");
  T("priority = 1", r.packet.authority.priority === 1);
  T("no required gates", r.packet.authority.required_gates.length === 0);
  T("no HFS required", r.packet.authority.requires_human_final_stop === false);
}

// ---------------------------------------------------------------------------
// 4) Universal scope: fan_out preserved, trunking = broadcast
// ---------------------------------------------------------------------------
console.log("\n[4] compress all 12 AtomSmasher modules to LIVE");
{
  const { core } = corePacketFor("compress all 12 AtomSmasher modules to LIVE");
  const r = buildRoutePacket(core, { now: NOW });
  T("ok", r.ok, dump(r.errors));
  T("composition = parallel", r.packet.class_of_service.composition === "parallel");
  T("trunking = broadcast_trunk",
    r.packet.class_of_service.trunking === "broadcast_trunk");
  T("fan_out = 12", r.packet.class_of_service.fan_out === 12);
  T("artifacts.scope = universal", r.packet.artifacts.scope === "universal");
  T("artifacts.ordinals[0].count = 12",
    r.packet.artifacts.ordinals[0].count === 12);
  T("artifacts.ordinals[0].universal = true",
    r.packet.artifacts.ordinals[0].universal === true);
  T("X-AE-Class-FanOut = 12",
    r.packet.headers["X-AE-Class-FanOut"] === "12");
}

// ---------------------------------------------------------------------------
// 5) Destructive risk: full gate stack including rollback.staged
// ---------------------------------------------------------------------------
console.log("\n[5] Destructive risk hint → full gate stack");
{
  // Synthesize a Core packet by editing risk_level. We do NOT need a parser path;
  // the route layer is downstream and reads what Core gives it.
  const { core } = corePacketFor("rollback module");
  // Force destructive to exercise GATES_BY_RISK['destructive']
  const destructive = { ...core, risk_level: "destructive" };
  const r = buildRoutePacket(destructive, { now: NOW });
  T("ok", r.ok, dump(r.errors));
  T("priority = 6", r.packet.authority.priority === 6);
  T("gates include rollback.staged",
    r.packet.authority.required_gates.includes("rollback.staged"));
  T("gates include human_final_stop",
    r.packet.authority.required_gates.includes("human_final_stop"));
  T("requires_human_final_stop = true",
    r.packet.authority.requires_human_final_stop === true);
}

// ---------------------------------------------------------------------------
// 6) Refuse to wrap invalid Core packet
// ---------------------------------------------------------------------------
console.log("\n[6] Refuse to wrap invalid Core packet");
{
  const bad = { schema: "not.a.real.schema", action_verb: "ship" };
  const r = buildRoutePacket(bad, { now: NOW });
  T("ok = false", r.ok === false);
  T("packet = null", r.packet === null);
  T("errors flagged schema",
    r.errors.some(e => /schema/i.test(e.message) || e.code === "E_SCHEMA"));
}

// ---------------------------------------------------------------------------
// 7) buildRoutePacketsFromEmit: multi-clause intent
// ---------------------------------------------------------------------------
console.log("\n[7] Multi-clause: build Orange5 then ship Orange5 v1 to LIVE");
{
  const high = parseHigh("build Orange5 then ship Orange5 v1 to LIVE");
  T("high ok", high.ok, dump(high.errors));
  const emit = emitCore(high.ir, { now: NOW });
  T("emit ok", emit.ok, dump(emit.errors));
  const rr = buildRoutePacketsFromEmit(emit, { now: NOW, operator_id: "atom" });
  T("rr ok", rr.ok, dump(rr.errors));
  T("2 route packets", rr.packets.length === 2);
  T("each validates",
    rr.packets.every(p => validateRoutePacket(p).ok));
  T("first verb = build", rr.packets[0].core.action_verb === "build");
  T("second verb = ship", rr.packets[1].core.action_verb === "ship");
  T("second authority is production",
    rr.packets[1].authority.risk_level === "production");
}

// ---------------------------------------------------------------------------
// 8) Refuse to wrap a non-ok emit result
// ---------------------------------------------------------------------------
console.log("\n[8] Refuse a non-ok emit result");
{
  const fake = { ok: false, packets: [], errors: [], warnings: [], composition: "parallel" };
  const rr = buildRoutePacketsFromEmit(fake, { now: NOW });
  T("ok = false", rr.ok === false);
  T("zero packets", rr.packets.length === 0);
  T("error code E_EMIT_NOT_OK",
    rr.errors.some(e => e.code === "E_EMIT_NOT_OK"));
}

// ---------------------------------------------------------------------------
// 9) Unknown from lane coerced to operator (with warning)
// ---------------------------------------------------------------------------
console.log("\n[9] Unknown from lane coerced to operator");
{
  const { core } = corePacketFor("verify dashboard");
  const r = buildRoutePacket(core, { now: NOW, from: "martian" });
  T("ok", r.ok);
  T("from coerced to operator", r.packet.from.lane === "operator");
  T("warning emitted",
    r.warnings.some(w => w.code === "W_UNKNOWN_FROM"));
}

// ---------------------------------------------------------------------------
// 10) TTL past deadline → warning
// ---------------------------------------------------------------------------
console.log("\n[10] TTL past deadline warning");
{
  const { core } = corePacketFor("ship Orange5 v1 to LIVE by EOD");
  // Default ttl 900s = 15 min; "by EOD" resolves to anchor + 10h → much later.
  // The warning condition is "ttl expires AFTER deadline" — invert by making
  // ttl_seconds enormous.
  const r = buildRoutePacket(core, { now: NOW, ttl_seconds: 60 * 60 * 24 * 30 });
  T("ok", r.ok);
  T("warning W_TTL_PAST_DEADLINE",
    r.warnings.some(w => w.code === "W_TTL_PAST_DEADLINE"),
    dump(r.warnings));
}

// ---------------------------------------------------------------------------
// 11) Validator catches header mutation
// ---------------------------------------------------------------------------
console.log("\n[11] Validator catches header tampering");
{
  const { core } = corePacketFor("verify dashboard");
  const r = buildRoutePacket(core, { now: NOW });
  T("ok", r.ok);
  // Tamper: drop required header.
  delete r.packet.headers["X-AE-Route-Schema"];
  const v = validateRoutePacket(r.packet);
  T("validate ok = false", v.ok === false);
  T("error code E_HEADER_MISSING",
    v.errors.some(e => e.code === "E_HEADER_MISSING"));
}

// ---------------------------------------------------------------------------
// 12) Validator catches extension/department mismatch
// ---------------------------------------------------------------------------
console.log("\n[12] Validator catches extension drift");
{
  const { core } = corePacketFor("verify dashboard");
  const r = buildRoutePacket(core, { now: NOW });
  r.packet.to.extension = "x99";
  const v = validateRoutePacket(r.packet);
  T("validate ok = false", v.ok === false);
  T("error code E_TO_EXT",
    v.errors.some(e => e.code === "E_TO_EXT"));
}

// ---------------------------------------------------------------------------
// 13) Constants sanity
// ---------------------------------------------------------------------------
console.log("\n[13] Constant tables sanity");
{
  T("PRIORITY_BY_RISK strictly increasing along RISK_LEVELS order",
    PRIORITY_BY_RISK.read_only < PRIORITY_BY_RISK.low &&
    PRIORITY_BY_RISK.low < PRIORITY_BY_RISK.medium &&
    PRIORITY_BY_RISK.medium < PRIORITY_BY_RISK.high &&
    PRIORITY_BY_RISK.high < PRIORITY_BY_RISK.production &&
    PRIORITY_BY_RISK.production < PRIORITY_BY_RISK.destructive);
  T("GATES_BY_RISK.production includes human_final_stop",
    GATES_BY_RISK.production.includes("human_final_stop"));
  T("GATES_BY_RISK.read_only is empty",
    GATES_BY_RISK.read_only.length === 0);
  T("ORIGIN_LANES includes operator and scheduler",
    ORIGIN_LANES.includes("operator") && ORIGIN_LANES.includes("scheduler"));
  T("TRUNKING_BY_COMPOSITION covers all three",
    typeof TRUNKING_BY_COMPOSITION.solo === "string" &&
    typeof TRUNKING_BY_COMPOSITION.sequence === "string" &&
    typeof TRUNKING_BY_COMPOSITION.parallel === "string");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
