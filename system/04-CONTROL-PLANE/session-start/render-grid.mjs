// Orange5 — Compact Deploy Grid Renderer
// Path:    04-CONTROL-PLANE/session-start/render-grid.mjs
// Runtime: Node >= 20 (Bun-compatible). Pure function. Zero deps. No I/O.
//
// What this is
// ------------
// The COMPACT one-screen ASCII renderer used by:
//   - the Atomic Orange first-launch hook (TypeScript imports renderGrid)
//   - the powershell N150 launcher (Node CLI prints to stdout)
//   - the gateway POST /v1/session/start preview field
//
// It is deliberately separate from `orchestrator.renderDeployGrid()`, which
// is the verbose multi-section debug renderer. THIS file is the
// 12-line-max, operator-glance, "is the lab green" surface.
//
// Doctrine
// --------
// - Pure: input → output. No fs, no network, no clock reads inside render.
// - Deterministic: same `grid` → same string, byte-for-byte. The renderer
//   never invokes a model. (Mom's Law: every grid line is REAL.)
// - Honest: nullable fields render as "—". Failed steps render their reason.
//   No fake green. If guardrails returned 3 reds, the line says "3 red".
// - 12-line max. We allocate the lines explicitly and refuse to exceed.
// - Width-bounded. Each line is hard-truncated to MAX_WIDTH (default 80) so
//   the grid fits a narrow terminal / first-launch modal without wrapping.
// - TypeScript-importable: this file exports `renderGrid(grid, opts?)` as a
//   plain ESM named export. The companion `render-grid.d.ts` declares types
//   for the Atomic Orange first-launch hook.
//
// Field map (the 8 mandated lines, in order)
// ------------------------------------------
//   1. time                  — grid.generated_at (ISO 8601)
//   2. location              — grid.operator.location or env hint
//   3. operator              — grid.operator.name / alias / email
//   4. sovereign             — grid.steps.soul_genome.sovereign.alias|name
//   5. hot_currents          — count + top event_type tags
//   6. guardrails_status     — band + count + stop flag
//   7. blockers              — not_green_ledger.total_open + continuity blockers
//   8. continuity_lookback   — continuity.date + stale flag + age (days)
//
// Plus a 2-line frame (top + bottom) and a 2-line header (schema + health)
// so the operator can confirm the grid is real and current. That's exactly
// 12 lines — no more, no fewer.
//
// Input shape (compatible with orchestrator.runRitual().grid)
// -----------------------------------------------------------
//   {
//     schema?: "orange5.session-start-grid.v1",
//     session_id?: string,
//     generated_at?: string (ISO),
//     cache_hit?: boolean,
//     operator?: { name?, alias?, email?, location? },
//     health?: { band: "GREEN"|"YELLOW"|"RED", reds: string[], yellows: string[] },
//     steps?: {
//       soul_genome?: { ok, sovereign?: { name?, alias? } },
//       continuity?: { ok, date?, stale?, summary?: { open_blockers_count? } },
//       guardrails?: { ok, violations_count?, stop?, transport? },
//       hot_currents?: { ok, count?, currents?: [{ event_type? }] },
//       not_green_ledger?: { ok, total_open? }
//     }
//   }
//
// Missing pieces are tolerated. The renderer never throws on a half-built
// grid — it surfaces "—" or the failure reason and keeps the 12-line shape.

// ---------------------------------------------------------------------------
// Constants

export const GRID_MAX_LINES = 12;
export const GRID_DEFAULT_WIDTH = 80;
export const GRID_MIN_WIDTH = 48;

// ---------------------------------------------------------------------------
// Tiny pure helpers

function truncate(str, max) {
  if (str == null) return "";
  const s = String(str);
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, max);
  return s.slice(0, max - 1) + "…";
}

function dash(v) {
  if (v == null) return "—";
  const s = String(v).trim();
  return s.length ? s : "—";
}

// ISO date-only diff in whole days. Pure: takes both dates as args.
// Returns null if either date is unparseable.
function daysBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  const ms = b - a;
  return Math.floor(ms / 86_400_000);
}

// Operator label. Prefers alias, falls back to name, then email-local-part.
function operatorLabel(op) {
  if (!op || typeof op !== "object") return "—";
  if (op.alias) return String(op.alias);
  if (op.name) return String(op.name);
  if (op.email) {
    const at = String(op.email).indexOf("@");
    return at > 0 ? String(op.email).slice(0, at) : String(op.email);
  }
  return "—";
}

// Sovereign label off the soul-genome step.
function sovereignLabel(sg) {
  const s = sg && sg.sovereign;
  if (!s) return "—";
  if (s.alias) return String(s.alias);
  if (s.name) return String(s.name);
  return "—";
}

// Pluck the top-N distinct event_type tags from hot currents, in order.
function topHotTags(currents, n) {
  if (!Array.isArray(currents)) return [];
  const seen = new Set();
  const out = [];
  for (const c of currents) {
    const t = c && (c.event_type || c.type);
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(String(t));
    if (out.length >= n) break;
  }
  return out;
}

// Compose a single grid row of the form  "│ label    : value"  (or "| ...")
// label is padded to a fixed column so columns align across all 8 rows.
function row(label, value, width, leftCh) {
  const LABEL_COL = 11; // "continuity " is 11 chars — the longest label
  const labelPart = (label + " ".repeat(LABEL_COL)).slice(0, LABEL_COL);
  const prefix = `${leftCh} ${labelPart}: `;
  // Available chars for value = width - prefix.length. Reserve no trailing
  // border char on purpose — the right side is open for a clean look at
  // narrow widths. We still hard-truncate so the line never wraps.
  const room = Math.max(1, width - prefix.length);
  return prefix + truncate(value, room);
}

// Band emoji-free tag. We intentionally avoid emoji — Mom's Law: every char
// is real and renders in every terminal.
function bandTag(band) {
  if (band === "GREEN") return "GREEN";
  if (band === "YELLOW") return "YELLOW";
  if (band === "RED") return "RED";
  return "—";
}

// ---------------------------------------------------------------------------
// Field renderers — each returns a single short value string for its row.
// All are pure: input → string. None reach for global clock or env.

function fieldTime(grid) {
  const t = grid && grid.generated_at;
  const ch = grid && grid.cache_hit ? " (cached)" : "";
  return dash(t) + ch;
}

function fieldLocation(grid) {
  const op = grid && grid.operator;
  if (op && op.location) return String(op.location);
  // No fallback to env inside the renderer — pure function. The caller
  // (orchestrator / hook) is responsible for stamping `operator.location`
  // before invoking renderGrid.
  return "—";
}

function fieldOperator(grid) {
  return operatorLabel(grid && grid.operator);
}

function fieldSovereign(grid) {
  const sg = grid && grid.steps && grid.steps.soul_genome;
  if (!sg) return "—";
  if (sg.ok === false) return `FAIL:${sg.reason || "soul_genome"}`;
  return sovereignLabel(sg);
}

function fieldHotCurrents(grid) {
  const hc = grid && grid.steps && grid.steps.hot_currents;
  if (!hc) return "—";
  if (hc.ok === false) return `FAIL:${hc.reason || "hot_currents"}`;
  const count = Number.isFinite(hc.count) ? hc.count : (Array.isArray(hc.currents) ? hc.currents.length : 0);
  const tags = topHotTags(hc.currents, 3);
  const tagStr = tags.length ? ` [${tags.join(", ")}]` : "";
  const stale = hc.stale ? " stale" : "";
  return `${count} in 24h${tagStr}${stale}`;
}

function fieldGuardrailsStatus(grid) {
  const g = grid && grid.steps && grid.steps.guardrails;
  const band = grid && grid.health && grid.health.band;
  if (!g) return "—";
  // The sweep itself failing is a different signal from the sweep finding reds.
  if (g.ok === false && g.violations_count == null) {
    return `FAIL:${g.reason || "sweep_unavailable"}`;
  }
  const v = Number.isFinite(g.violations_count) ? g.violations_count : 0;
  const stop = g.stop ? " STOP" : "";
  const via = g.transport ? ` via:${g.transport}` : "";
  // Honest band: if guardrails has reds, say so even when health is YELLOW.
  const tag = v === 0 ? "clean" : `${v} red`;
  const overall = band ? ` [${bandTag(band)}]` : "";
  return `${tag}${stop}${via}${overall}`;
}

function fieldBlockers(grid) {
  const steps = grid && grid.steps;
  const ng = steps && steps.not_green_ledger;
  const c = steps && steps.continuity;
  const ngFail = ng && ng.ok === false;
  const cFail = c && c.ok === false;
  const ngOpen = ng && Number.isFinite(ng.total_open) ? ng.total_open : 0;
  const cBlockers = c && c.summary && Number.isFinite(c.summary.open_blockers_count)
    ? c.summary.open_blockers_count : 0;
  if (ngFail && cFail) return "FAIL:both_sources";
  const parts = [];
  parts.push(`ledger:${ngFail ? "FAIL" : ngOpen}`);
  parts.push(`continuity:${cFail ? "FAIL" : cBlockers}`);
  return parts.join("  ");
}

function fieldContinuityLookback(grid) {
  const c = grid && grid.steps && grid.steps.continuity;
  if (!c) return "—";
  if (c.ok === false) return `FAIL:${c.reason || "continuity"}`;
  const date = c.date || "—";
  const stale = c.stale ? " stale" : "";
  // Age in days, computed from generated_at if we have both. Pure: no clock.
  let age = "";
  if (grid && grid.generated_at && c.date) {
    const d = daysBetween(c.date, grid.generated_at);
    if (d != null && d >= 0) age = ` (${d}d ago)`;
  }
  return `${date}${age}${stale}`;
}

// ---------------------------------------------------------------------------
// Public API — renderGrid(grid, opts?)
//
// opts:
//   width  — output width in chars; clamped to [GRID_MIN_WIDTH, 200]; default 80
//   ascii  — when true, use pure-ASCII frame chars (+ - |) instead of unicode
//            box-drawing. Default false. The TUI uses unicode; the CI log
//            stream sets ascii:true to stay byte-clean.

/**
 * Render an Orange5 SessionStartGrid into a compact 12-line ASCII string.
 * Pure function. Deterministic. No I/O. No model invocations.
 *
 * @param {object} grid  - the SessionStartGrid object (or partial)
 * @param {object} [opts]
 * @param {number} [opts.width=80]
 * @param {boolean} [opts.ascii=false]
 * @returns {string} the rendered grid, exactly GRID_MAX_LINES lines, "\n" joined.
 */
export function renderGrid(grid, opts) {
  const o = opts || {};
  const rawWidth = Number.isFinite(o.width) ? o.width : GRID_DEFAULT_WIDTH;
  const width = Math.min(200, Math.max(GRID_MIN_WIDTH, Math.floor(rawWidth)));
  const ascii = !!o.ascii;

  // Frame characters. The unicode set keeps the visual lab feel; the ascii
  // set keeps the line byte-clean for log pipelines.
  const topL    = ascii ? "+" : "╭";
  const botL    = ascii ? "+" : "╰";
  const leftCh  = ascii ? "|" : "│";
  const dashCh  = ascii ? "-" : "─";

  // Header lines. We pre-build the top frame string with a label baked in.
  const titleRaw = " Orange5 Deploy Grid ";
  const title = truncate(titleRaw, Math.max(2, width - 4));
  // Fill the remainder of the top line with dashes for the lab look.
  const headFill = dashCh.repeat(Math.max(0, width - 2 - title.length));
  const topLine = topL + title + headFill;

  // Build the two header rows (schema + health).
  const schema = (grid && grid.schema) || "orange5.session-start-grid.v1";
  const session = grid && grid.session_id ? ` ${truncate(grid.session_id, 8)}` : "";
  const schemaRow = row("schema", `${schema}${session}`, width, leftCh);

  const band = bandTag(grid && grid.health && grid.health.band);
  const reds = grid && grid.health && Array.isArray(grid.health.reds) ? grid.health.reds.length : 0;
  const yellows = grid && grid.health && Array.isArray(grid.health.yellows) ? grid.health.yellows.length : 0;
  const healthVal = `${band}  reds:${reds}  yellows:${yellows}`;
  const healthRow = row("health", healthVal, width, leftCh);

  // The 8 mandated field rows, in canonical order.
  const fieldRows = [
    row("time",        fieldTime(grid),               width, leftCh),
    row("location",    fieldLocation(grid),           width, leftCh),
    row("operator",    fieldOperator(grid),           width, leftCh),
    row("sovereign",   fieldSovereign(grid),          width, leftCh),
    row("hot",         fieldHotCurrents(grid),        width, leftCh),
    row("guardrails",  fieldGuardrailsStatus(grid),   width, leftCh),
    row("blockers",    fieldBlockers(grid),           width, leftCh),
    row("continuity",  fieldContinuityLookback(grid), width, leftCh),
  ];

  // Bottom frame.
  const botLine = botL + dashCh.repeat(Math.max(0, width - 1));

  // Assemble exactly GRID_MAX_LINES lines.
  // 1 top + 2 header + 8 fields + 1 bottom = 12.
  const lines = [topLine, schemaRow, healthRow, ...fieldRows, botLine];

  // Hard invariant: never exceed GRID_MAX_LINES. If a caller passes
  // pathological input that somehow inflates a row to multiple lines, we
  // collapse extras by stripping newlines from each row.
  for (let i = 0; i < lines.length; i++) {
    if (typeof lines[i] !== "string") lines[i] = String(lines[i] ?? "");
    if (lines[i].indexOf("\n") !== -1) {
      lines[i] = lines[i].replace(/\r?\n/g, " ");
    }
  }
  if (lines.length > GRID_MAX_LINES) {
    // Truncate by dropping field rows from the end first — frame and header
    // are load-bearing for "is this real?" judgement.
    lines.length = GRID_MAX_LINES;
  }

  return lines.join("\n");
}

// Default export so this works both as `import { renderGrid }` and
// `import renderGrid` from TypeScript.
export default renderGrid;

// Companion helper for tests / hosts that need to confirm shape without
// rendering. Returns the eight field values as an object — same field names
// the doctrine spec calls out, no I/O.
export function extractGridFields(grid) {
  return {
    time:                fieldTime(grid),
    location:            fieldLocation(grid),
    operator:            fieldOperator(grid),
    sovereign:           fieldSovereign(grid),
    hot_currents:        fieldHotCurrents(grid),
    guardrails_status:   fieldGuardrailsStatus(grid),
    blockers:            fieldBlockers(grid),
    continuity_lookback: fieldContinuityLookback(grid),
  };
}
