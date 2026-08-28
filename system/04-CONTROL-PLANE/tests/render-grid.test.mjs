#!/usr/bin/env node
// Orange5 — Compact Deploy Grid Renderer tests
// Path: 04-CONTROL-PLANE/tests/render-grid.test.mjs
//
// Deterministic. No I/O. No clock reads. The renderer is a pure function;
// the tests prove it. Mom's Law: every assertion is named in plain English
// and every failure prints what was expected vs what was got.

import {
  renderGrid,
  extractGridFields,
  GRID_MAX_LINES,
  GRID_DEFAULT_WIDTH,
  GRID_MIN_WIDTH,
} from "../session-start/render-grid.mjs";

let pass = 0, fail = 0;
function ok(cond, name, detail = "") {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else      { fail++; console.log(`  FAIL ${name}${detail ? " :: " + detail : ""}`); }
}
function eq(a, b, name) {
  ok(a === b, name, `expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
}

// ------------------------------------------------------------------ fixtures

function greenGrid() {
  return {
    schema: "orange5.session-start-grid.v1",
    session_id: "abc12345-def6-7890-1234-567890abcdef",
    generated_at: "2026-06-24T13:00:00.000Z",
    cache_hit: false,
    operator: {
      name: "Atom McCree",
      alias: "Ætom",
      email: "a.mccree@gmail.com",
      location: "Marco Island, FL",
    },
    health: { band: "GREEN", reds: [], yellows: [] },
    steps: {
      soul_genome: {
        ok: true,
        sovereign: { name: "Atom McCree", alias: "Ætom ÆoNs" },
      },
      continuity: {
        ok: true,
        date: "2026-06-23",
        stale: false,
        summary: { progress_count: 4, open_blockers_count: 1, tomorrow_first_action: "ship render-grid", hot_currents_count: 7 },
      },
      guardrails: {
        ok: true,
        violations_count: 0,
        stop: false,
        transport: "module",
      },
      hot_currents: {
        ok: true,
        count: 3,
        stale: false,
        currents: [
          { event_type: "deploy",  title: "orange5 promote 04→05" },
          { event_type: "receipt", title: "session-start receipt written" },
          { event_type: "deploy",  title: "orange5 promote 05→06" },
        ],
      },
      not_green_ledger: { ok: true, total_open: 2 },
    },
  };
}

function redGrid() {
  return {
    schema: "orange5.session-start-grid.v1",
    generated_at: "2026-06-24T13:00:00.000Z",
    cache_hit: false,
    operator: { alias: "Ætom", location: "Marco Island, FL" },
    health: { band: "RED", reds: ["guardrails:3_violations(stop)"], yellows: [] },
    steps: {
      soul_genome: { ok: true, sovereign: { alias: "Ætom ÆoNs" } },
      continuity:  { ok: true, date: "2026-06-20", stale: true,
                     summary: { open_blockers_count: 5 } },
      guardrails:  { ok: false, violations_count: 3, stop: true, transport: "gateway" },
      hot_currents:{ ok: true, count: 0, currents: [] },
      not_green_ledger: { ok: true, total_open: 9 },
    },
  };
}

function failGrid() {
  // Everything that can fail, fails. Renderer must not throw.
  return {
    generated_at: "2026-06-24T13:00:00.000Z",
    health: { band: "RED", reds: ["a","b","c"], yellows: ["d"] },
    steps: {
      soul_genome:      { ok: false, reason: "soul_genome_file_missing" },
      continuity:       { ok: false, reason: "no_continuity_packet_via_any_transport" },
      guardrails:       { ok: false, reason: "no_guardrails_run_via_any_transport" },
      hot_currents:     { ok: false, reason: "flux_adapter_unavailable" },
      not_green_ledger: { ok: false, reason: "ledger_file_missing" },
    },
  };
}

// ------------------------------------------------------------------ tests

console.log("render-grid");

// (1) Constants are the doctrine values.
eq(GRID_MAX_LINES, 12, "GRID_MAX_LINES is 12");
eq(GRID_DEFAULT_WIDTH, 80, "GRID_DEFAULT_WIDTH is 80");
eq(GRID_MIN_WIDTH, 48, "GRID_MIN_WIDTH is 48");

// (2) Output is exactly 12 lines for a healthy grid.
{
  const out = renderGrid(greenGrid());
  const lines = out.split("\n");
  eq(lines.length, 12, "green grid renders exactly 12 lines");
}

// (3) Output is exactly 12 lines for a red grid.
{
  const lines = renderGrid(redGrid()).split("\n");
  eq(lines.length, 12, "red grid renders exactly 12 lines");
}

// (4) Output is exactly 12 lines for a fully-failed grid (no throws).
{
  let lines;
  try { lines = renderGrid(failGrid()).split("\n"); }
  catch (e) { lines = null; }
  ok(lines && lines.length === 12, "fail grid renders exactly 12 lines without throwing",
     `got ${lines ? lines.length : "throw"}`);
}

// (5) Empty / undefined input does not throw and still gives 12 lines.
{
  const lines = renderGrid({}).split("\n");
  eq(lines.length, 12, "empty grid {} renders exactly 12 lines");
  const lines2 = renderGrid(undefined).split("\n");
  eq(lines2.length, 12, "undefined grid renders exactly 12 lines");
}

// (6) Determinism — same input → byte-identical output.
{
  const g = greenGrid();
  const a = renderGrid(g);
  const b = renderGrid(g);
  eq(a, b, "render is deterministic for identical input");
}

// (7) All 8 mandated field labels appear in the output, in order.
{
  const out = renderGrid(greenGrid());
  const order = ["time", "location", "operator", "sovereign",
                 "hot", "guardrails", "blockers", "continuity"];
  let idx = -1;
  let inOrder = true;
  for (const label of order) {
    const next = out.indexOf(`│ ${label}`, idx + 1);
    if (next <= idx) { inOrder = false; break; }
    idx = next;
  }
  ok(inOrder, "all 8 field rows appear in canonical order",
     `failed at order check on output:\n${out}`);
}

// (8) Honest guardrails count — when sweep returns 3 reds, the row says "3 red".
{
  const out = renderGrid(redGrid());
  ok(out.includes("3 red"), "guardrails row reports honest red count",
     `output missing '3 red':\n${out}`);
  ok(out.includes("STOP"), "guardrails row surfaces STOP flag",
     `output missing 'STOP':\n${out}`);
}

// (9) Stale continuity is surfaced.
{
  const out = renderGrid(redGrid());
  ok(out.includes("stale"), "continuity row surfaces stale flag",
     `output missing 'stale':\n${out}`);
}

// (10) Failed step renders FAIL:<reason> instead of fake green.
{
  const out = renderGrid(failGrid());
  ok(out.includes("FAIL:no_continuity_packet"), "continuity FAIL reason is surfaced",
     `output missing 'FAIL:no_continuity_packet':\n${out}`);
  ok(out.includes("FAIL:no_guardrails"), "guardrails FAIL reason is surfaced",
     `output missing 'FAIL:no_guardrails':\n${out}`);
  ok(out.includes("FAIL:flux_adapter"), "hot_currents FAIL reason is surfaced",
     `output missing 'FAIL:flux_adapter':\n${out}`);
  ok(out.includes("FAIL:soul_genome"), "soul_genome FAIL reason is surfaced",
     `output missing 'FAIL:soul_genome':\n${out}`);
}

// (11) Width clamp — small width is bumped to GRID_MIN_WIDTH.
{
  const out = renderGrid(greenGrid(), { width: 10 });
  const longest = out.split("\n").reduce((m, l) => Math.max(m, l.length), 0);
  ok(longest <= 200, "output respects clamped width upper bound",
     `longest line was ${longest}`);
  ok(longest >= GRID_MIN_WIDTH - 4, "output width is at least near GRID_MIN_WIDTH",
     `longest line was ${longest}`);
}

// (12) Width override — large width is honored without breaking line count.
{
  const out = renderGrid(greenGrid(), { width: 120 });
  const lines = out.split("\n");
  eq(lines.length, 12, "wide grid still renders exactly 12 lines");
}

// (13) ASCII mode uses only printable ASCII frame chars.
{
  const out = renderGrid(greenGrid(), { ascii: true });
  // The frame chars (+ - |) and label colon are ASCII; we check the box-drawing
  // unicode chars are absent.
  const hasUnicode = /[╭╰─│]/.test(out);
  ok(!hasUnicode, "ascii:true strips unicode box-drawing chars",
     `output still has box-drawing chars:\n${out}`);
}

// (14) cache_hit:true is surfaced in the time field.
{
  const g = greenGrid(); g.cache_hit = true;
  const out = renderGrid(g);
  ok(out.includes("(cached)"), "cache_hit:true is surfaced in the time row",
     `output missing '(cached)':\n${out}`);
}

// (15) Operator falls back through alias → name → email-local-part.
{
  const a = renderGrid({ ...greenGrid(), operator: { alias: "Ætom" } });
  ok(a.includes("Ætom"), "operator alias is rendered when present");
  const b = renderGrid({ ...greenGrid(), operator: { name: "Atom McCree" } });
  ok(b.includes("Atom McCree"), "operator name is rendered when alias is absent");
  const c = renderGrid({ ...greenGrid(), operator: { email: "x@y.com" } });
  ok(c.includes(" x"), "operator email local-part is rendered when name+alias absent",
     `output: ${c}`);
  const d = renderGrid({ ...greenGrid(), operator: undefined });
  ok(d.includes("operator   : —"), "operator renders em-dash when entirely absent",
     `output: ${d}`);
}

// (16) Sovereign label comes from soul_genome.sovereign, not operator.
{
  const g = greenGrid();
  g.operator = { alias: "Op" };
  g.steps.soul_genome = { ok: true, sovereign: { alias: "SovereignZed" } };
  const out = renderGrid(g);
  ok(out.includes("SovereignZed"), "sovereign row uses soul_genome sovereign",
     `output: ${out}`);
}

// (17) extractGridFields returns all 8 mandated keys.
{
  const fields = extractGridFields(greenGrid());
  const keys = Object.keys(fields).sort();
  const expected = [
    "blockers", "continuity_lookback", "guardrails_status",
    "hot_currents", "location", "operator", "sovereign", "time",
  ];
  eq(JSON.stringify(keys), JSON.stringify(expected),
     "extractGridFields returns exactly the 8 mandated keys");
}

// (18) Hot currents row reports count + top distinct event_types.
{
  const out = renderGrid(greenGrid());
  ok(/hot\s*:\s*3 in 24h/.test(out), "hot_currents reports count for green",
     `output: ${out}`);
  ok(out.includes("deploy"), "hot_currents surfaces top event_type tag",
     `output: ${out}`);
}

// (19) Blockers row sums ledger + continuity blockers.
{
  const out = renderGrid(greenGrid());
  ok(out.includes("ledger:2"), "blockers row surfaces ledger count",
     `output: ${out}`);
  ok(out.includes("continuity:1"), "blockers row surfaces continuity count",
     `output: ${out}`);
}

// (20) Continuity lookback computes age in days when generated_at + date present.
{
  // 2026-06-24 minus 2026-06-23 = 1 day.
  const out = renderGrid(greenGrid());
  ok(out.includes("2026-06-23") && out.includes("(1d ago)"),
     "continuity lookback shows date + age in days",
     `output: ${out}`);
}

// (21) Health band tag is surfaced in the health row.
{
  const out = renderGrid(redGrid());
  ok(out.includes("RED"), "RED health band is surfaced",
     `output: ${out}`);
}

// (22) No newlines smuggled into any row.
{
  // Construct a pathological grid with newlines in fields. The renderer
  // must collapse them so the 12-line invariant is preserved.
  const g = greenGrid();
  g.operator.alias = "Æt\nom\nMc";
  g.steps.soul_genome.sovereign.alias = "Sov\n\nZed";
  const out = renderGrid(g);
  const lines = out.split("\n");
  eq(lines.length, 12, "pathological newline-in-field input still 12 lines");
}

// ------------------------------------------------------------------ done

console.log(`\nrender-grid: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
process.exit(0);
