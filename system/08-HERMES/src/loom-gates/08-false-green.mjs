// LOOM gate 8 — false_green_guard
//
// Hermes pre-flight gate 8 of 8. The final chokepoint before an action
// from any LLM in the superstack lands. Scans the action's declared
// status field and the attached report's status field (if any) for
// "fake-green" language — phrases an actor reaches for when it wants
// to claim success without having proven it. Any match rejects.
//
// Doctrine (08-HERMES/PR-14-SPEC.md, project CLAUDE.md, Mom's Law):
//   - "Do not claim green without proof."
//     — .claude/rules/03-build-and-receipts.md
//   - "Every 'passed' claim has a receipt."
//     — .claude/rules/00-moms-law.md
//   - Hermes is the bounded-execution layer that replaces OpenClaw.
//     Every action by any LLM in the superstack goes through a lease
//     and every action goes through the 8-gate LOOM chain. Gate 8 is
//     the prose-level honesty gate: it does not know whether the work
//     actually succeeded, but it refuses outputs that lie about it.
//   - Frontier-Isolation context: the frontier model never reaches
//     Hermes directly — it's gated through the local gateway
//     (127.0.0.1:1337) and Hermes itself binds 127.0.0.1:7430. Gate 8
//     runs inside Hermes; by the time prose reaches here it has
//     already passed gates 1–7. This gate has the last word on what
//     "the report says success" actually means.
//
// What this gate does (single assertion):
//   - Concatenates action.status and (report.status if a report is
//     attached) into the inspection surface.
//   - Runs the FAKE_GREEN_PATTERN regex over that surface.
//   - On any hit: returns { pass: false, reasons } with the matched
//     terms and where they were found. The structured payload lets
//     the lease engine surface the exact lying phrase to the operator.
//
// What this gate does NOT do:
//   - It does NOT validate schema shape — that is gates 1 and 2.
//   - It does NOT check receipts — gate 3.
//   - It does NOT decide whether the action actually succeeded; gate
//     8 only inspects the claim language. A status of "fail: X" passes
//     this gate (no fake-green words) even though it announces failure
//     — failing actions are blocked elsewhere by the lease engine, not
//     here. The job here is to catch dishonest success claims, not
//     honest failure claims.
//   - It does NOT scan free-form report body / notes / reasoning. The
//     report schema separates `status` (terse verdict) from `notes`
//     (free prose). The verdict is the load-bearing field for the
//     downstream consumer; the notes can contain any phrasing as long
//     as the verdict itself isn't dressed up. Scanning notes here
//     would block legitimate uses like quoting another system's
//     output, or explicitly documenting "do not write 'looks_ok'" in
//     a doc. If a future doctrine requires also gating prose, add a
//     gate 8.5 — do not silently broaden this one.
//   - It is case-insensitive and tolerant of common separators
//     (snake_case, kebab-case, spaces) but NOT a full natural-language
//     classifier. False positives are accepted as the price of
//     determinism; false negatives are documented under "Honest gaps".
//
// Module shape:
//   - default export: async function falseGreenGuardGate(action, opts?) → { pass, reasons, matches?, surface? }
//   - named exports:  falseGreenGuardGate, scanFakeGreen, collectStatusSurface,
//                     GATE_ID, GATE_INDEX, FAKE_GREEN_PATTERN, FAKE_GREEN_TERMS,
//                     REASON_*
//
// Action shape this gate reads (informal — full schema lives at
// 09-SCHEMAS/orange.action.v1.schema.json when it lands):
//   {
//     "id":     "action_…",
//     "kind":   "…",
//     "status": "ok" | "fail: <reason>" | "<short verdict>",   // REQUIRED for landing
//     "report": {                                              // OPTIONAL; if present, its status is also scanned
//       "schema": "orange.report.v1",
//       "status": "ok" | "fail: <reason>" | "<short verdict>",
//       …
//     },
//     …
//   }
//
// Refusal reasons (stable tags — adapters may key off these):
//   - "action_invalid"        — action arg was not a usable object
//   - "status_missing"        — neither action.status nor report.status present
//   - "false_green_action"    — fake-green word found in action.status
//   - "false_green_report"    — fake-green word found in report.status
//
// Honest gaps (read me):
//   - The pattern is a deny-list, not a semantic check. A model that
//     hand-crafts a novel synonym ("verdantly nominal", "greenish")
//     will slip past. Doctrinally Mom's Law forbids those too; this
//     gate is the structural backstop, not the only line of defense.
//     The lease engine + receipts gate (3) are what actually prove
//     the work happened.
//   - We intentionally include `green_assumed` and `fake_green` as
//     literal terms even though they read like internal markers
//     rather than something an actor would emit. Actors that have
//     been gated by an earlier version of this guard sometimes echo
//     the marker text back into their own status when paraphrasing —
//     refusing those echoes preserves the gate's deterrent value.
//   - `probably` is the most aggressive term on the list. A truthful
//     status that says "probably ok" is a hedge, which is exactly the
//     thing this gate is meant to catch. If a use case emerges where
//     "probably" is the right verdict, the right move is to set the
//     status to "fail: insufficient evidence" and explain in
//     `report.notes` — do not weaken the pattern here.
//   - Word boundaries: the regex uses `\b` so `should_work` matches
//     but `groundwork` does not. The terms with embedded underscores
//     (`green_assumed`, `looks_ok`, `should_work`, `fake_green`) are
//     also matched when written with spaces or hyphens. See
//     FAKE_GREEN_TERMS for the canonical list and the building of the
//     pattern below.
//   - Pure logic, no I/O, no network. Synchronous core wrapped in an
//     async surface to keep parity with the rest of the LOOM chain.
//   - Requires Node 20+ (uses optional chaining, top-level
//     `String.prototype.normalize`, `Array.from` on iterators).

export const GATE_ID = "false_green_guard";
export const GATE_INDEX = 8;

// Canonical list of forbidden status terms. Mandated by the task
// brief; downstream callers may rely on exact membership of this
// array, so it is exported. Order matches the brief regex
// `green_assumed|looks_ok|probably|should_work|fake_green`.
export const FAKE_GREEN_TERMS = Object.freeze([
  "green_assumed",
  "looks_ok",
  "probably",
  "should_work",
  "fake_green",
]);

// Build a tolerant variant of each term: underscores in the canonical
// form may also appear as a hyphen or a single space in the wild.
// `green_assumed` → "green[_\\- ]assumed".
function termToRegexSource(term) {
  return term.replace(/_/g, "[_\\- ]");
}

// `\b...\b` ensures we match whole words. Case-insensitive ("i"). We
// do not add the `g` flag here because the gate only needs "any hit",
// not enumeration of every hit; collection happens via a separate
// scan in `scanFakeGreen` using a per-call cloned regex (regex `g`
// flag is stateful and unsafe to share).
const FAKE_GREEN_PATTERN_SOURCE = FAKE_GREEN_TERMS
  .map((t) => `\\b${termToRegexSource(t)}\\b`)
  .join("|");

/**
 * The compiled fake-green deny-list. Exported for tests and for
 * adapters that want to do an early prose scan before they even
 * submit to Hermes (e.g. surface the warning in the IDE).
 *
 * NOTE: callers that need to enumerate all matches in a string must
 * NOT reuse this exact instance with a global flag — clone with
 * `new RegExp(FAKE_GREEN_PATTERN.source, "gi")`. The exported regex
 * is non-global and safe to test against arbitrary strings.
 */
export const FAKE_GREEN_PATTERN = new RegExp(FAKE_GREEN_PATTERN_SOURCE, "i");

// Stable refusal-reason tags. Surface strings include context;
// downstream code should match on the tag, not the prose.
export const REASON_ACTION_INVALID    = "action_invalid";
export const REASON_STATUS_MISSING    = "status_missing";
export const REASON_FALSE_GREEN_ACTION = "false_green_action";
export const REASON_FALSE_GREEN_REPORT = "false_green_report";

/**
 * Pull the status strings off an action into a small inspection
 * surface. Returns `{ action: string|null, report: string|null }`.
 * Non-string values are coerced via String() — a numeric status code
 * has no fake-green risk but should still survive coercion without
 * throwing. Whitespace is trimmed but case is preserved (the regex
 * is case-insensitive).
 *
 * @param {object} action
 * @returns {{ action: string | null, report: string | null }}
 */
export function collectStatusSurface(action) {
  const out = { action: null, report: null };
  if (!action || typeof action !== "object" || Array.isArray(action)) return out;

  if (action.status !== undefined && action.status !== null) {
    const s = String(action.status).trim();
    if (s.length > 0) out.action = s;
  }

  const report = action.report;
  if (report && typeof report === "object" && !Array.isArray(report)) {
    if (report.status !== undefined && report.status !== null) {
      const r = String(report.status).trim();
      if (r.length > 0) out.report = r;
    }
  }

  return out;
}

/**
 * Scan a single status string for fake-green hits. Returns an array
 * of matched terms in the order they appear in the string. Empty
 * array means "clean". Always returns an array — never null — so
 * callers can `.length`-check without a guard.
 *
 * Uses a freshly built global regex per call so concurrent callers
 * never collide on `lastIndex`.
 *
 * @param {string} statusStr
 * @returns {string[]}
 */
export function scanFakeGreen(statusStr) {
  if (typeof statusStr !== "string" || statusStr.length === 0) return [];
  // Unicode-normalise so a stylised "looks_ok" can't sneak past
  // — defensive only; current actors do not emit such forms.
  const normalised = statusStr.normalize("NFKC");
  const rx = new RegExp(FAKE_GREEN_PATTERN_SOURCE, "gi");
  const hits = [];
  let m;
  while ((m = rx.exec(normalised)) !== null) {
    hits.push(m[0]);
    // Defensive against zero-width matches (cannot happen with the
    // current pattern, but keeps the loop from spinning if the
    // pattern is ever loosened).
    if (m.index === rx.lastIndex) rx.lastIndex++;
  }
  return hits;
}

/**
 * LOOM gate 8 entry point. Pure decision over the action object.
 * Never throws on a malformed action — returns structured
 * `{ pass: false, reasons }` instead. Matches and the inspected
 * surface are echoed back in the success and failure shapes so the
 * lease engine and downstream loggers can record exactly what this
 * gate saw.
 *
 * Contract details:
 *   - If action.status is missing AND no report.status is attached,
 *     the gate REJECTS with `status_missing`. The earlier gates
 *     require a status to land; gate 8 enforces that here too rather
 *     than silently passing an action that has nothing to inspect.
 *   - If only one of the two is present, the gate inspects that one
 *     and treats the other as clean. The report block is optional.
 *   - On a hit in action.status: tag `false_green_action`.
 *   - On a hit in report.status: tag `false_green_report`.
 *   - Hits in both surfaces yield two separate reasons.
 *
 * @param {object} action
 * @param {object} [opts]  reserved for future tuning; currently ignored
 * @returns {Promise<{
 *   pass: boolean,
 *   reasons: string[],
 *   matches?: { action: string[], report: string[] },
 *   surface?: { action: string | null, report: string | null },
 * }>}
 */
export async function falseGreenGuardGate(action, _opts = {}) {
  // 0. action sanity
  if (action === null || typeof action !== "object" || Array.isArray(action)) {
    return {
      pass: false,
      reasons: [`${REASON_ACTION_INVALID}: action must be an object`],
    };
  }

  // 1. collect inspection surface
  const surface = collectStatusSurface(action);

  // 2. require at least one status to inspect
  if (surface.action === null && surface.report === null) {
    return {
      pass: false,
      reasons: [
        `${REASON_STATUS_MISSING}: gate 8 requires action.status or action.report.status to inspect`,
      ],
      matches: { action: [], report: [] },
      surface,
    };
  }

  // 3. scan each surface
  const actionHits = surface.action !== null ? scanFakeGreen(surface.action) : [];
  const reportHits = surface.report !== null ? scanFakeGreen(surface.report) : [];

  const reasons = [];

  if (actionHits.length > 0) {
    const uniq = Array.from(new Set(actionHits));
    reasons.push(
      `${REASON_FALSE_GREEN_ACTION}: action.status contains fake-green term(s) ` +
      `${JSON.stringify(uniq)} — verdict ${JSON.stringify(surface.action)} ` +
      `must be rewritten as an honest result or "fail: <reason>"`,
    );
  }

  if (reportHits.length > 0) {
    const uniq = Array.from(new Set(reportHits));
    reasons.push(
      `${REASON_FALSE_GREEN_REPORT}: report.status contains fake-green term(s) ` +
      `${JSON.stringify(uniq)} — verdict ${JSON.stringify(surface.report)} ` +
      `must be rewritten as an honest result or "fail: <reason>"`,
    );
  }

  if (reasons.length > 0) {
    return {
      pass: false,
      reasons,
      matches: { action: actionHits, report: reportHits },
      surface,
    };
  }

  return {
    pass: true,
    reasons: [],
    matches: { action: [], report: [] },
    surface,
  };
}

export default falseGreenGuardGate;
