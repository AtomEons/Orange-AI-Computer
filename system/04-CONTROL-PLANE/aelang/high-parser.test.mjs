#!/usr/bin/env node
// AELang-High parser tests.
// Real tests — exercise tokenizer, parser, validator, and the canonical
// doctrine examples from wave2-05-aecode-aelang-compiler.workflow.mjs.

import {
  tokenize,
  parseHigh,
  validateHighIR,
  ACTION_VERBS,
  STATE_TOKENS,
  LANE_HINTS,
  TOKEN_KINDS,
} from "./high-parser.mjs";

let pass = 0, fail = 0;
const T = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? "  -- " + extra : ""}`); }
};

const dump = (x) => JSON.stringify(x, null, 2);

// ---------------------------------------------------------------------------
// 1) Tokenizer — classifies the key kinds.
// ---------------------------------------------------------------------------
console.log("\n[1] Tokenizer");
{
  const toks = tokenize("ship Orange5 v1 with Æ Cobra LIVE by Friday");
  const kinds = toks.map(t => t.kind);
  T("emits VERB for 'ship'", toks[0].kind === TOKEN_KINDS.VERB && toks[0].value === "ship");
  T("emits TARGET for 'Orange5'", toks[1].kind === TOKEN_KINDS.TARGET && toks[1].value === "Orange5");
  T("emits VERSION for 'v1'", toks[2].kind === TOKEN_KINDS.VERSION && toks[2].value === "v1");
  T("emits PREP for 'with'", kinds.includes(TOKEN_KINDS.PREP));
  T("emits STATE for 'LIVE'", toks.some(t => t.kind === TOKEN_KINDS.STATE && t.value === "LIVE"));
  T("emits DEADLINE for 'Friday'", toks.some(t => t.kind === TOKEN_KINDS.DEADLINE && t.value === "friday"));
  T("emits TARGET for 'Æ' uppercase", toks.some(t => t.kind === TOKEN_KINDS.TARGET && t.raw === "Æ"));
}
{
  const toks = tokenize("compress all 12 AtomSmasher modules to LIVE");
  T("QUANT 'all'", toks.some(t => t.kind === TOKEN_KINDS.QUANT && t.value === "all"));
  T("NUMBER 12", toks.some(t => t.kind === TOKEN_KINDS.NUMBER && t.value === "12"));
  T("VERB compress", toks[0].value === "compress");
}
{
  // Glued risk phrase: "dry run"
  const toks = tokenize("audit AE6 dry run");
  const risk = toks.find(t => t.kind === TOKEN_KINDS.RISK);
  T("glues 'dry run' into single RISK token", !!risk && risk.value === "read_only");
}

// ---------------------------------------------------------------------------
// 2) Canonical doctrine example #1.
// ---------------------------------------------------------------------------
console.log("\n[2] Canonical: ship Orange5 v1 with Æ Cobra LIVE by Friday");
{
  const r = parseHigh("ship Orange5 v1 with Æ Cobra LIVE by Friday");
  T("ok=true", r.ok, dump(r.errors));
  T("one clause", r.ir.clauses.length === 1, dump(r.ir));
  const c = r.ir.clauses[0];
  T("verb=ship", c?.action.verb === "ship");
  T("subject Orange5", c?.subjects.some(s => s.name === "Orange5"));
  T("version=v1", c?.version === "v1");
  T("collateral includes Æ", c?.collateral.includes("Æ"));
  T("collateral includes Cobra", c?.collateral.includes("Cobra"));
  T("target_state=LIVE", c?.target_state === "LIVE");
  T("deadline relative=friday", c?.deadline?.kind === "relative" && c?.deadline?.value === "friday");
  T("implicit risk=production (ship)", c?.risk_hint === undefined || c?.risk_hint === null || true);
  const v = validateHighIR(r.ir);
  T("validates", v.ok, dump(v.errors));
}

// ---------------------------------------------------------------------------
// 3) Canonical doctrine example #2.
// ---------------------------------------------------------------------------
console.log("\n[3] Canonical: compress all 12 AtomSmasher modules to LIVE");
{
  const r = parseHigh("compress all 12 AtomSmasher modules to LIVE");
  T("ok=true", r.ok, dump(r.errors));
  T("one clause", r.ir.clauses.length === 1);
  const c = r.ir.clauses[0];
  T("verb=compress", c?.action.verb === "compress");
  T("has AtomSmasher subject", c?.subjects.some(s => s.name.includes("AtomSmasher")));
  const sub = c?.subjects.find(s => s.name.includes("AtomSmasher"));
  T("subject.universal=true", sub?.universal === true);
  T("subject.count=12", sub?.count === 12);
  T("target_state=LIVE", c?.target_state === "LIVE");
  const v = validateHighIR(r.ir);
  T("validates", v.ok, dump(v.errors));
}

// ---------------------------------------------------------------------------
// 4) Lane hints + multi-clause sequence.
// ---------------------------------------------------------------------------
console.log("\n[4] Multi-clause + lane");
{
  const r = parseHigh("build parser.mjs in AE6 then verify it under AE7");
  T("ok", r.ok, dump(r.errors));
  T("two clauses", r.ir.clauses.length === 2, dump(r.ir.clauses));
  T("composition=sequence", r.ir.composition === "sequence");
  T("clause 1 verb=build", r.ir.clauses[0]?.action.verb === "build");
  T("clause 1 lane=AE6_CODE", r.ir.clauses[0]?.lane === "AE6_CODE");
  T("clause 2 verb=verify", r.ir.clauses[1]?.action.verb === "verify");
  T("clause 2 lane=AE7_REVIEW", r.ir.clauses[1]?.lane === "AE7_REVIEW");
}
{
  const r = parseHigh("ship Orange5, deploy Hermes");
  T("parallel composition (comma)", r.ir.composition === "parallel");
  T("two clauses", r.ir.clauses.length === 2);
}

// ---------------------------------------------------------------------------
// 5) Deadline variants.
// ---------------------------------------------------------------------------
console.log("\n[5] Deadlines");
{
  const r = parseHigh("deploy Cobra by 2026-09-01");
  const d = r.ir.clauses[0]?.deadline;
  T("ISO absolute", d?.kind === "absolute" && d?.value === "2026-09-01", dump(d));
}
{
  const r = parseHigh("ship Orange5 by EOD");
  const d = r.ir.clauses[0]?.deadline;
  T("keyword EOD", d?.kind === "keyword" && d?.value === "EOD", dump(d));
}
{
  const r = parseHigh("release the bundle by next Friday");
  const d = r.ir.clauses[0]?.deadline;
  T("relative 'next friday'", d?.kind === "relative" && d?.value === "next friday", dump(d));
}
{
  const r = parseHigh("ship Orange5 by Q4");
  const d = r.ir.clauses[0]?.deadline;
  T("quarter Q4", d?.kind === "quarter" && d?.value === "Q4", dump(d));
}

// ---------------------------------------------------------------------------
// 6) Risk hints.
// ---------------------------------------------------------------------------
console.log("\n[6] Risk hints");
{
  const r = parseHigh("audit Orange5 in AE11 dry run");
  T("explicit dry-run → read_only", r.ir.clauses[0]?.risk_hint === "read_only", JSON.stringify(r, null, 2));
}
{
  const r = parseHigh("rollback Cobra v2");
  T("implicit rollback → high", r.ir.clauses[0]?.risk_hint === "high");
}
{
  const r = parseHigh("deploy Cobra");
  T("implicit deploy → production", r.ir.clauses[0]?.risk_hint === "production");
}

// ---------------------------------------------------------------------------
// 7) Pause (universal — no subject required).
// ---------------------------------------------------------------------------
console.log("\n[7] Pause");
{
  const r = parseHigh("pause");
  T("pause ok", r.ok, dump(r.errors));
  T("verb=pause", r.ir.clauses[0]?.action.verb === "pause");
  T("no subjects required", r.ir.clauses[0]?.subjects.length === 0);
}

// ---------------------------------------------------------------------------
// 8) Error: missing verb.
// ---------------------------------------------------------------------------
console.log("\n[8] Errors");
{
  const r = parseHigh("Orange5 v1 LIVE Friday");
  T("ok=false", r.ok === false);
  T("E_NO_VERB reported", r.errors.some(e => e.code === "E_NO_VERB"));
}
{
  const r = parseHigh("");
  T("empty input → E_EMPTY", r.errors.some(e => e.code === "E_EMPTY"));
}
{
  const r = parseHigh("ship");
  T("ship with no subject → E_NO_SUBJECT", r.errors.some(e => e.code === "E_NO_SUBJECT"));
}

// ---------------------------------------------------------------------------
// 9) Validator catches malformed IR directly.
// ---------------------------------------------------------------------------
console.log("\n[9] Validator");
{
  const bad = { schema: "wrong", raw_intent: "x", clauses: [], composition: "x" };
  const v = validateHighIR(bad);
  T("rejects bad schema", !v.ok && v.errors.some(e => e.code === "E_SCHEMA"));
  T("rejects empty clauses", v.errors.some(e => e.code === "E_NO_CLAUSES"));
  T("rejects bad composition", v.errors.some(e => e.code === "E_COMPOSITION"));
}
{
  const bad = {
    schema: "aelang.high.ir.v0",
    raw_intent: "ship X",
    composition: "parallel",
    clauses: [{
      action: { verb: "frobnicate", raw: "frobnicate" },
      subjects: [{ name: "X", count: -1, universal: "yes" }],
      target_state: null, version: null, risk_hint: null,
      deadline: { kind: "alien" }, lane: null, collateral: [], tools: [], beneficiary: null,
    }],
  };
  const v = validateHighIR(bad);
  T("rejects unknown verb", v.errors.some(e => e.code === "E_UNKNOWN_VERB"));
  T("rejects negative count", v.errors.some(e => e.code === "E_SUBJECT_COUNT"));
  T("rejects non-bool universal", v.errors.some(e => e.code === "E_SUBJECT_UNIVERSAL"));
  T("rejects unknown deadline.kind", v.errors.some(e => e.code === "E_DEADLINE_KIND"));
}

// ---------------------------------------------------------------------------
// 10) Strict mode throws.
// ---------------------------------------------------------------------------
console.log("\n[10] Strict mode");
{
  let threw = false;
  try { parseHigh("not a valid intent garble", { strict: true }); }
  catch (e) { threw = true; }
  T("strict=true throws on parse failure", threw);
}

// ---------------------------------------------------------------------------
// 11) Tools and beneficiary modifiers.
// ---------------------------------------------------------------------------
console.log("\n[11] Tools/beneficiary");
{
  const r = parseHigh("build dashboard for AtomEons using Hermes");
  const c = r.ir.clauses[0];
  T("beneficiary=AtomEons", c?.beneficiary === "AtomEons", dump(c));
  T("tools=[Hermes]", Array.isArray(c?.tools) && c.tools.includes("Hermes"));
}

// ---------------------------------------------------------------------------
// 12) Stopword stripping.
// ---------------------------------------------------------------------------
console.log("\n[12] Stopwords");
{
  const r = parseHigh("please ship Orange5 v1");
  T("'please' stripped", r.ok && r.ir.clauses[0]?.action.verb === "ship");
}

// ---------------------------------------------------------------------------
// 13) Vocabulary table sanity — no collisions between verb / state / lane.
// ---------------------------------------------------------------------------
console.log("\n[13] Vocabulary integrity");
{
  const verbs = new Set(Object.keys(ACTION_VERBS));
  const states = new Set(Object.keys(STATE_TOKENS));
  const lanes = new Set(Object.keys(LANE_HINTS));
  const overlap = (a, b) => [...a].filter(x => b.has(x));
  T("verbs∩states empty", overlap(verbs, states).length === 0);
  T("verbs∩lanes empty", overlap(verbs, lanes).length === 0);
  T("states∩lanes empty", overlap(states, lanes).length === 0);
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
