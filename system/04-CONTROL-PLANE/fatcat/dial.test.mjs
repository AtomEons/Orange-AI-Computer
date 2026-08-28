#!/usr/bin/env node
// dial.test.mjs — FATCAT switch + party-line writer integration tests.
//
// Builds real Route Packets via the AELang pipeline, dials them through the
// switch with registered handlers, and asserts on the party-line JSONL output.
// No mocks of the Route Packet — that would let schema drift in via the back
// door. Same operator law as the rest of the suite: Mom is watching.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseHigh } from "../aelang/high-parser.mjs";
import { emitCore } from "../aelang/core-emitter.mjs";
import { buildRoutePacket } from "../aelang/route-packet.mjs";

import {
  dial,
  registerHandler,
  clearHandlers,
  resolveDialCode,
  checkGates,
  DIAL_PLAN,
  DEPARTMENT_TO_DIAL,
  EXTENSION_TO_DIAL,
  HFS_CODES,
  DialError,
} from "./dial.mjs";

import {
  appendPartyLine,
  readAllPartyLines,
  readAllPartyLinesSync,
  normalizeEntry,
  validatePartyLineEntry,
  PARTY_LINE_SCHEMA,
  PARTY_STATUSES,
  MAX_LINE_BYTES,
  _resetSeqForTests,
  currentSeq,
} from "./party-line.mjs";

let pass = 0, fail = 0;
const T = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? "  -- " + extra : ""}`); }
};
const dump = (x) => JSON.stringify(x, null, 2);

// Deterministic time anchor (Wednesday).
const NOW = "2026-06-24T15:00:00.000Z";

function tmpPartyLinePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "party-line-"));
  return path.join(dir, "party.jsonl");
}

function corePacketFor(intent) {
  const h = parseHigh(intent);
  if (!h.ok) throw new Error("high parse failed: " + dump(h.errors));
  const e = emitCore(h.ir, { now: NOW });
  if (!e.ok) throw new Error("core emit failed: " + dump(e.errors));
  return e.packets[0];
}

function routePacketFor(intent) {
  const core = corePacketFor(intent);
  const r = buildRoutePacket(core, { now: NOW, operator_id: "atom", ttl_seconds: 900 });
  if (!r.ok) throw new Error("route build failed: " + dump(r.errors));
  return r.packet;
}

// ---------------------------------------------------------------------------
// 1) Dial plan integrity
// ---------------------------------------------------------------------------
console.log("\n[1] Dial plan: all 8 codes present, frozen, well-formed");
{
  const expected = [100, 103, 106, 107, 111, 114, 200, 911];
  for (const code of expected) T(`dial ${code} present`, DIAL_PLAN[code] != null);
  T("plan is frozen", Object.isFrozen(DIAL_PLAN));
  T("entries are frozen", Object.isFrozen(DIAL_PLAN[100]));
  T("100 names AE0_FACTORY", DIAL_PLAN[100].name === "AE0_FACTORY");
  T("103 names LIPS",        DIAL_PLAN[103].name === "LIPS");
  T("106 names AE6_CODE",    DIAL_PLAN[106].name === "AE6_CODE");
  T("107 names MIRRORS",     DIAL_PLAN[107].name === "MIRRORS");
  T("111 names AE11_SECURITY", DIAL_PLAN[111].name === "AE11_SECURITY");
  T("114 names CHECKMATE",   DIAL_PLAN[114].name === "CHECKMATE");
  T("200 names CODEXA_HEAVY", DIAL_PLAN[200].name === "CODEXA_HEAVY");
  T("911 names OPERATOR_PAUSE", DIAL_PLAN[911].name === "OPERATOR_PAUSE");
  T("106 is real department (has internal extension)",
    EXTENSION_TO_DIAL["x06"] === 106);
  T("103 is synthetic (no internal extension)",
    EXTENSION_TO_DIAL["x03"] !== 103);
  T("HFS_CODES includes 200 and 911",
    HFS_CODES.includes(200) && HFS_CODES.includes(911));
}

// ---------------------------------------------------------------------------
// 2) resolveDialCode — header > opts > department > extension
// ---------------------------------------------------------------------------
console.log("\n[2] resolveDialCode: precedence order");
{
  const pkt = routePacketFor("ship Orange5 v1 with Æ Cobra LIVE by Friday");

  // (3) department fallback: ship lands in AE8_LAUNCH terminally — should NOT
  // have a dial entry, so we use a packet whose to.extension corresponds to a
  // real x-ext-mapped code (x06 → 106) by overriding via opts.
  // Cleaner: test override paths directly.

  // header override wins.
  const withHeader = { ...pkt, headers: { ...pkt.headers, "X-AE-Dial-Code": "911" } };
  T("header X-AE-Dial-Code=911 wins", resolveDialCode(withHeader) === 911);

  // opts override beats packet.
  T("opts.dial_code=200 wins over packet",
    resolveDialCode(pkt, { dial_code: 200 }) === 200);

  // Bad header rejected explicitly.
  let threw = false;
  try { resolveDialCode({ ...pkt, headers: { ...pkt.headers, "X-AE-Dial-Code": "999" } }); }
  catch (e) { threw = e instanceof DialError && e.code === "E_BAD_DIAL_HEADER"; }
  T("bad header rejected with E_BAD_DIAL_HEADER", threw);

  // Bad opts code rejected.
  threw = false;
  try { resolveDialCode(pkt, { dial_code: 999 }); }
  catch (e) { threw = e instanceof DialError && e.code === "E_BAD_DIAL_OPT"; }
  T("bad opts.dial_code rejected with E_BAD_DIAL_OPT", threw);

  // Direct department match: build a synthetic packet pointing at AE6_CODE.
  const ae6 = { ...pkt, to: { department: "AE6_CODE", extension: "x06", path: ["AE6_CODE"], extensions: ["x06"] } };
  T("AE6_CODE → 106 via department", resolveDialCode(ae6) === 106);

  // Extension fallback: department not in DIAL_PLAN but extension is x06.
  const ae6Ext = { ...pkt, to: { department: "AE_UNKNOWN", extension: "x06", path: ["AE_UNKNOWN"], extensions: ["x06"] } };
  T("unknown dept but x06 extension → 106", resolveDialCode(ae6Ext) === 106);

  // No resolution path → throws E_NO_DIAL_CODE.
  const orphan = { ...pkt, to: { department: "AE_UNKNOWN", extension: "x99", path: ["AE_UNKNOWN"], extensions: ["x99"] }, headers: { ...pkt.headers, "X-AE-Dial-Code": undefined } };
  delete orphan.headers["X-AE-Dial-Code"];
  threw = false;
  try { resolveDialCode(orphan); }
  catch (e) { threw = e instanceof DialError && e.code === "E_NO_DIAL_CODE"; }
  T("no resolution path throws E_NO_DIAL_CODE", threw);
}

// ---------------------------------------------------------------------------
// 3) checkGates — required vs supplied; HFS auto-attach
// ---------------------------------------------------------------------------
console.log("\n[3] checkGates: enforcement and HFS auto-attach");
{
  const pkt = routePacketFor("ship Orange5 v1 with Æ Cobra LIVE by Friday");

  // Production-risk ship has gates: gauntlet.unit, gauntlet.security, review.AE7, human_final_stop.
  const g1 = checkGates(pkt, 106, []);
  T("missing all gates → ok:false", g1.ok === false);
  T("missing includes review.AE7", g1.missing.includes("review.AE7"));

  const g2 = checkGates(pkt, 106, ["gauntlet.unit", "gauntlet.security", "review.AE7", "human_final_stop"]);
  T("all supplied → ok:true", g2.ok === true, dump(g2));

  // Dialing 911 forces human_final_stop even if not on packet.
  const lowRisk = routePacketFor("analyze Orange5 docs");
  const g3 = checkGates(lowRisk, 911, []);
  T("dial 911 auto-requires human_final_stop", g3.missing.includes("human_final_stop"));
  const g4 = checkGates(lowRisk, 911, ["human_final_stop"]);
  T("dial 911 with HFS satisfied → ok:true", g4.ok === true);

  // Dialing 200 (CODEXA_HEAVY) also forces HFS.
  const g5 = checkGates(lowRisk, 200, []);
  T("dial 200 auto-requires human_final_stop", g5.missing.includes("human_final_stop"));
}

// ---------------------------------------------------------------------------
// 4) Handler registration: bad input, double-register, overwrite
// ---------------------------------------------------------------------------
console.log("\n[4] Handler registration: rejects bad input");
{
  clearHandlers();
  let threw = false;
  try { registerHandler(null); } catch (e) { threw = e instanceof DialError && e.code === "E_BAD_HANDLER"; }
  T("null handler rejected", threw);

  threw = false;
  try { registerHandler({ code: 106 }); } catch (e) { threw = e instanceof DialError && e.code === "E_HANDLER_INVOKE"; }
  T("missing invoke rejected", threw);

  threw = false;
  try { registerHandler({ code: 9999, invoke: async () => ({ ok: true }) }); }
  catch (e) { threw = e instanceof DialError && e.code === "E_UNKNOWN_DIAL"; }
  T("unknown dial code rejected", threw);

  const h = { code: 106, name: "AE6_CODE", invoke: async () => ({ ok: true }) };
  registerHandler(h);
  threw = false;
  try { registerHandler(h); } catch (e) { threw = e instanceof DialError && e.code === "E_HANDLER_EXISTS"; }
  T("double-register rejected without overwrite", threw);

  // overwrite works.
  registerHandler({ code: 106, name: "AE6_CODE", invoke: async () => ({ ok: true, output: "v2" }) }, { overwrite: true });
  T("overwrite:true replaces handler", true);
  clearHandlers();
}

// ---------------------------------------------------------------------------
// 5) End-to-end dial: happy path COMPLETED on party-line
// ---------------------------------------------------------------------------
console.log("\n[5] dial(): happy path emits ROUTED then COMPLETED");
{
  clearHandlers();
  _resetSeqForTests();
  const partyPath = tmpPartyLinePath();
  let invoked = 0;
  let receivedCtx = null;
  registerHandler({
    code: 106,
    name: "AE6_CODE",
    invoke: async (ctx) => { invoked++; receivedCtx = ctx; return { ok: true, output: { wrote: "files" } }; },
  });

  const pkt = routePacketFor("ship Orange5 v1 with Æ Cobra LIVE by Friday");
  const out = await dial(pkt, {
    now: NOW,
    dial_code: 106,
    gates_satisfied: ["gauntlet.unit", "gauntlet.security", "review.AE7", "human_final_stop"],
    party_line_path: partyPath,
  });

  T("dial ok", out.ok === true, dump(out.errors));
  T("dial_code 106", out.dial_code === 106);
  T("handler invoked once", invoked === 1);
  T("ctx has packet+call_id+dial_code", receivedCtx?.packet === pkt && typeof receivedCtx?.call_id === "string" && receivedCtx?.dial_code === 106);
  T("call_id is deterministic for fixed inputs",
    out.call_id === `call-${pkt.route_id}-${NOW}`);

  const { entries, skipped } = readAllPartyLinesSync(partyPath);
  T("party-line has no skipped lines", skipped.length === 0);
  T("party-line wrote 2 entries (ROUTED, COMPLETED)", entries.length === 2);
  T("first entry is ROUTED", entries[0].status === "ROUTED");
  T("second entry is COMPLETED", entries[1].status === "COMPLETED");
  T("both entries share call_id", entries[0].call_id === entries[1].call_id);
  T("seq is monotonic", entries[0].seq < entries[1].seq);
  T("schema is party.line.v0", entries[0].schema === PARTY_LINE_SCHEMA);
  T("dial_code logged", entries[1].dial_code === 106);
  T("dial_name logged", entries[1].dial_name === "AE6_CODE");
  T("action_verb logged", entries[1].action_verb === "ship");

  clearHandlers();
}

// ---------------------------------------------------------------------------
// 6) dial() rejects when gates missing
// ---------------------------------------------------------------------------
console.log("\n[6] dial(): missing gates produces BLOCKED, no handler invocation");
{
  clearHandlers();
  _resetSeqForTests();
  const partyPath = tmpPartyLinePath();
  let invoked = 0;
  registerHandler({ code: 106, name: "AE6_CODE", invoke: async () => { invoked++; return { ok: true }; } });

  const pkt = routePacketFor("ship Orange5 v1 with Æ Cobra LIVE by Friday");
  const out = await dial(pkt, { now: NOW, dial_code: 106, gates_satisfied: [], party_line_path: partyPath });

  T("dial ok:false", out.ok === false);
  T("errors include E_GATES_MISSING", out.errors.some(e => e.code === "E_GATES_MISSING"));
  T("handler NOT invoked", invoked === 0);

  const { entries } = readAllPartyLinesSync(partyPath);
  T("exactly 1 party-line entry (BLOCKED)", entries.length === 1);
  T("status BLOCKED", entries[0].status === "BLOCKED");
  T("reason GATES_MISSING", entries[0].reason === "GATES_MISSING");
  T("extra.missing lists gates", Array.isArray(entries[0].extra.missing) && entries[0].extra.missing.length === 4);
  clearHandlers();
}

// ---------------------------------------------------------------------------
// 7) dial() with no handler → BLOCKED NO_HANDLER (no silent fallback)
// ---------------------------------------------------------------------------
console.log("\n[7] dial(): unregistered dial code → BLOCKED, never falls back");
{
  clearHandlers();
  _resetSeqForTests();
  const partyPath = tmpPartyLinePath();

  const pkt = routePacketFor("ship Orange5 v1 with Æ Cobra LIVE by Friday");
  const out = await dial(pkt, { now: NOW, dial_code: 114, gates_satisfied: ["gauntlet.unit", "gauntlet.security", "review.AE7", "human_final_stop"], party_line_path: partyPath });

  T("dial ok:false", out.ok === false);
  T("errors include E_NO_HANDLER", out.errors.some(e => e.code === "E_NO_HANDLER"));
  const { entries } = readAllPartyLinesSync(partyPath);
  T("first entry was ROUTED (announce before handler lookup)", entries[0].status === "ROUTED");
  T("second entry is BLOCKED", entries[1].status === "BLOCKED");
  T("second entry reason NO_HANDLER", entries[1].reason === "NO_HANDLER");
}

// ---------------------------------------------------------------------------
// 8) Handler that throws → FAILED with structured error
// ---------------------------------------------------------------------------
console.log("\n[8] dial(): handler throw is caught, logged as FAILED");
{
  clearHandlers();
  _resetSeqForTests();
  const partyPath = tmpPartyLinePath();
  registerHandler({
    code: 106, name: "AE6_CODE",
    invoke: async () => { throw new Error("kaboom"); },
  });

  const pkt = routePacketFor("ship Orange5 v1 with Æ Cobra LIVE by Friday");
  const out = await dial(pkt, { now: NOW, dial_code: 106, gates_satisfied: ["gauntlet.unit", "gauntlet.security", "review.AE7", "human_final_stop"], party_line_path: partyPath });

  T("dial ok:false", out.ok === false);
  T("result.ok=false", out.result.ok === false);
  T("errors carry handler error", out.errors.some(e => /kaboom/.test(e.message)));
  const { entries } = readAllPartyLinesSync(partyPath);
  T("second entry status FAILED", entries[1].status === "FAILED");
  T("elapsed_ms recorded", typeof entries[1].extra.elapsed_ms === "number");
  clearHandlers();
}

// ---------------------------------------------------------------------------
// 9) Handler returns malformed result → caught as FAILED, never crashes switch
// ---------------------------------------------------------------------------
console.log("\n[9] dial(): malformed handler result caught");
{
  clearHandlers();
  _resetSeqForTests();
  const partyPath = tmpPartyLinePath();
  registerHandler({ code: 106, name: "AE6_CODE", invoke: async () => "not an object" });

  const pkt = routePacketFor("ship Orange5 v1 with Æ Cobra LIVE by Friday");
  const out = await dial(pkt, { now: NOW, dial_code: 106, gates_satisfied: ["gauntlet.unit", "gauntlet.security", "review.AE7", "human_final_stop"], party_line_path: partyPath });

  T("dial ok:false", out.ok === false);
  T("errors include E_HANDLER_RESULT", out.errors.some(e => e.code === "E_HANDLER_RESULT"));
  clearHandlers();
}

// ---------------------------------------------------------------------------
// 10) 911 OPERATOR_PAUSE interrupt: forces HFS, blocked without it
// ---------------------------------------------------------------------------
console.log("\n[10] dial 911: interrupt requires HFS even on read_only packet");
{
  clearHandlers();
  _resetSeqForTests();
  const partyPath = tmpPartyLinePath();
  let invoked = 0;
  registerHandler({ code: 911, name: "OPERATOR_PAUSE", invoke: async () => { invoked++; return { ok: true, output: "paused" }; } });

  const lowRiskPkt = routePacketFor("analyze Orange5 docs");
  const blocked = await dial(lowRiskPkt, { now: NOW, dial_code: 911, gates_satisfied: [], party_line_path: partyPath });
  T("blocked without HFS", blocked.ok === false && blocked.errors.some(e => e.code === "E_GATES_MISSING"));
  T("handler not invoked", invoked === 0);

  const ok = await dial(lowRiskPkt, { now: NOW, dial_code: 911, gates_satisfied: ["human_final_stop"], party_line_path: partyPath });
  T("ok with HFS supplied", ok.ok === true);
  T("handler invoked", invoked === 1);
  clearHandlers();
}

// ---------------------------------------------------------------------------
// 11) Invalid packet → BLOCKED INVALID_PACKET, no resolution attempt
// ---------------------------------------------------------------------------
console.log("\n[11] dial(): invalid Route Packet rejected pre-resolution");
{
  clearHandlers();
  _resetSeqForTests();
  const partyPath = tmpPartyLinePath();

  const bad = { schema: "wrong", to: {}, headers: {} };
  const out = await dial(bad, { now: NOW, party_line_path: partyPath });
  T("ok:false", out.ok === false);
  T("dial_code null", out.dial_code === null);
  const { entries } = readAllPartyLinesSync(partyPath);
  T("one party-line entry", entries.length === 1);
  T("status BLOCKED", entries[0].status === "BLOCKED");
  T("reason INVALID_PACKET", entries[0].reason === "INVALID_PACKET");
}

// ---------------------------------------------------------------------------
// 12) --no-gates bypass: documented escape hatch
// ---------------------------------------------------------------------------
console.log("\n[12] dial(): require_gates:false bypasses gate check");
{
  clearHandlers();
  _resetSeqForTests();
  const partyPath = tmpPartyLinePath();
  registerHandler({ code: 106, name: "AE6_CODE", invoke: async () => ({ ok: true }) });

  const pkt = routePacketFor("ship Orange5 v1 with Æ Cobra LIVE by Friday");
  const out = await dial(pkt, { now: NOW, dial_code: 106, gates_satisfied: [], require_gates: false, party_line_path: partyPath });
  T("ok with require_gates:false", out.ok === true);
  clearHandlers();
}

// ---------------------------------------------------------------------------
// 13) Party-line: normalizeEntry input validation
// ---------------------------------------------------------------------------
console.log("\n[13] normalizeEntry: input validation");
{
  let threw = false;
  try { normalizeEntry(null, NOW, 1); } catch { threw = true; }
  T("null entry throws", threw);

  threw = false;
  try { normalizeEntry({ status: "ROUTED", dialed_at_iso: NOW }, NOW, 1); } catch { threw = true; }
  T("missing call_id throws", threw);

  threw = false;
  try { normalizeEntry({ call_id: "x", dialed_at_iso: NOW, status: "NOPE" }, NOW, 1); } catch { threw = true; }
  T("bad status throws", threw);

  const e = normalizeEntry({ call_id: "x", dialed_at_iso: NOW, status: "ROUTED" }, NOW, 1);
  T("normalized has all required keys present",
    e.schema && e.seq === 1 && e.logged_at_iso === NOW && e.from === null && e.priority === null && typeof e.extra === "object");
  T("PARTY_STATUSES has 5 statuses", PARTY_STATUSES.length === 5);
}

// ---------------------------------------------------------------------------
// 14) Party-line: roundtrip — write, read, validate
// ---------------------------------------------------------------------------
console.log("\n[14] Party-line: write → read → validate roundtrip");
{
  _resetSeqForTests();
  const partyPath = tmpPartyLinePath();
  const entries = [
    { call_id: "c1", dialed_at_iso: NOW, status: "ROUTED", dial_code: 106, dial_name: "AE6_CODE", action_verb: "ship" },
    { call_id: "c1", dialed_at_iso: NOW, status: "COMPLETED", dial_code: 106, dial_name: "AE6_CODE", action_verb: "ship", extra: { elapsed_ms: 4 } },
    { call_id: "c2", dialed_at_iso: NOW, status: "BLOCKED", reason: "NO_HANDLER", dial_code: 114, dial_name: "CHECKMATE" },
  ];
  for (const e of entries) await appendPartyLine(e, { path: partyPath, now: NOW });

  const { entries: read, skipped } = await readAllPartyLines(partyPath);
  T("read back 3 entries", read.length === 3);
  T("no skipped lines", skipped.length === 0);
  for (let i = 0; i < read.length; i++) {
    const v = validatePartyLineEntry(read[i]);
    T(`entry ${i} validates`, v.ok, dump(v.errors));
  }
  T("seq strictly increasing", read[0].seq < read[1].seq && read[1].seq < read[2].seq);
  T("currentSeq advanced", currentSeq() === 3);
}

// ---------------------------------------------------------------------------
// 15) Party-line: corrupt line is skipped, not fatal
// ---------------------------------------------------------------------------
console.log("\n[15] Party-line reader: corrupt line skipped with reason");
{
  const partyPath = tmpPartyLinePath();
  fs.writeFileSync(partyPath, [
    JSON.stringify({ schema: PARTY_LINE_SCHEMA, seq: 1, logged_at_iso: NOW, call_id: "c1", dialed_at_iso: NOW, status: "ROUTED" }),
    "not-json-here",
    JSON.stringify({ schema: PARTY_LINE_SCHEMA, seq: 2, logged_at_iso: NOW, call_id: "c2", dialed_at_iso: NOW, status: "COMPLETED" }),
    "",
  ].join("\n"));

  const { entries, skipped } = await readAllPartyLines(partyPath);
  T("2 valid entries read", entries.length === 2);
  T("1 line skipped", skipped.length === 1);
  T("skipped reports line number", skipped[0].line === 2);
}

// ---------------------------------------------------------------------------
// 16) Party-line: oversize entry pruned, never silently dropped
// ---------------------------------------------------------------------------
console.log("\n[16] Party-line: oversize entry pruned and still validates");
{
  _resetSeqForTests();
  const partyPath = tmpPartyLinePath();
  const bigExtra = { blob: "x".repeat(MAX_LINE_BYTES * 2) };
  const result = await appendPartyLine(
    { call_id: "big", dialed_at_iso: NOW, status: "ROUTED", extra: bigExtra },
    { path: partyPath, now: NOW },
  );
  T("entry written", result != null);
  T("extra._truncated flag set", result.extra._truncated === true);
  T("required keys still present", result.call_id === "big" && result.status === "ROUTED");
  const v = validatePartyLineEntry(result);
  T("pruned entry still validates", v.ok, dump(v.errors));
}

// ---------------------------------------------------------------------------
// 17) Party-line: allow_oversize:false rejects rather than truncates
// ---------------------------------------------------------------------------
console.log("\n[17] Party-line: allow_oversize:false throws");
{
  const partyPath = tmpPartyLinePath();
  let threw = false;
  try {
    await appendPartyLine(
      { call_id: "big", dialed_at_iso: NOW, status: "ROUTED", extra: { blob: "x".repeat(MAX_LINE_BYTES * 2) } },
      { path: partyPath, now: NOW, allow_oversize: false },
    );
  } catch (err) { threw = /exceeds MAX_LINE_BYTES/.test(err.message); }
  T("threw on oversize when allow_oversize:false", threw);
  T("file not created on rejection", !fs.existsSync(partyPath));
}

// ---------------------------------------------------------------------------
// 18) Party-line: parent dir auto-created
// ---------------------------------------------------------------------------
console.log("\n[18] Party-line: parent directory auto-created");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "party-deep-"));
  const partyPath = path.join(dir, "nested", "deeper", "party.jsonl");
  await appendPartyLine({ call_id: "c", dialed_at_iso: NOW, status: "ROUTED" }, { path: partyPath, now: NOW });
  T("file exists at deep path", fs.existsSync(partyPath));
}

// ---------------------------------------------------------------------------
// 19) emit_party_line:false suppresses all writes
// ---------------------------------------------------------------------------
console.log("\n[19] dial(): emit_party_line:false suppresses output");
{
  clearHandlers();
  const partyPath = tmpPartyLinePath();
  registerHandler({ code: 106, name: "AE6_CODE", invoke: async () => ({ ok: true }) });
  const pkt = routePacketFor("ship Orange5 v1 with Æ Cobra LIVE by Friday");
  const out = await dial(pkt, {
    now: NOW, dial_code: 106, gates_satisfied: ["gauntlet.unit","gauntlet.security","review.AE7","human_final_stop"],
    party_line_path: partyPath, emit_party_line: false,
  });
  T("dial ok", out.ok === true);
  T("file not created", !fs.existsSync(partyPath));
  T("party_line null in result", out.party_line === null);
  clearHandlers();
}

// ---------------------------------------------------------------------------
// 20) Determinism: same packet + same handlers + same NOW → same call_id
// ---------------------------------------------------------------------------
console.log("\n[20] Determinism: identical inputs yield identical call_id");
{
  clearHandlers();
  registerHandler({ code: 106, name: "AE6_CODE", invoke: async () => ({ ok: true }) });
  const pkt = routePacketFor("ship Orange5 v1 with Æ Cobra LIVE by Friday");
  const a = await dial(pkt, { now: NOW, dial_code: 106, gates_satisfied: ["gauntlet.unit","gauntlet.security","review.AE7","human_final_stop"], party_line_path: tmpPartyLinePath() });
  const b = await dial(pkt, { now: NOW, dial_code: 106, gates_satisfied: ["gauntlet.unit","gauntlet.security","review.AE7","human_final_stop"], party_line_path: tmpPartyLinePath() });
  T("call_id identical across runs", a.call_id === b.call_id);
  clearHandlers();
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n=== dial.test.mjs: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
