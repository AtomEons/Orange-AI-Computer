// AELang-High parser — human-readable AtomEons intent → AELang-High IR.
//
// AELang is a two-tier route language for the Orange5 control plane:
//
//   AELang-High  (this module)   — natural-language operator intent strings
//        ↓
//   AELang-Core  (core-emitter.mjs)  — typed, machine-parseable IR with
//        ↓                            { action_verb, target_lattice, lane_route,
//   Route Packet (route-packet.mjs)    risk_level, deadline }
//        ↓
//   FATCAT dial → department lane (AE0..AE14)
//
// This file lives at the FIRST hop. Its only job:
//   parseHigh(intent: string)  →  { ok, ir, errors, warnings, source }
//
// The IR is intentionally rich but UNCOMMITTED — no department lookup, no
// dispatch, no side effects. The Core emitter is the one that grounds verbs
// against the dispatch table and resolves "by Friday" into a wall-clock.
//
// Doctrine refs:
//   - AECode pipeline: 04-CONTROL-PLANE/aecode/compiler.mjs
//   - Mission schema:  09-SCHEMAS/mission.schema.json
//   - Departments:     AE0_FACTORY ... AE14_BENCH
//
// Real compiler code — tokenizer + AST + validator. No regex‑only "vibe parser".
// Mom's Law: every branch earns its place. No silent fallback. Errors name
// themselves with `code`, `message`, and a token `span` when possible.

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — Vocabulary tables.
//   The parser is intent-classified rather than syntax-strict: operators type
//   English. We hold the table here so callers (and Core emitter) can introspect
//   exactly what verbs/scopes/lanes we know about. Adding a verb is a 1-line
//   change in the table; no parser rewiring needed.
// ─────────────────────────────────────────────────────────────────────────────

/** Action verbs and the canonical action they map to in IR.action.verb. */
export const ACTION_VERBS = Object.freeze({
  // build / produce
  ship:       "ship",
  release:    "ship",
  launch:     "ship",
  publish:    "ship",
  deliver:    "ship",
  // construction
  build:      "build",
  author:     "build",
  scaffold:   "build",
  create:     "build",
  generate:   "build",
  // change-existing
  compress:   "compress",
  reduce:     "compress",
  shrink:     "compress",
  fix:        "fix",
  patch:      "fix",
  repair:     "fix",
  refactor:   "refactor",
  rework:     "refactor",
  // verification
  verify:     "verify",
  test:       "verify",
  audit:      "verify",
  validate:   "verify",
  // movement / lifecycle
  promote:    "promote",
  graduate:   "promote",
  deploy:     "deploy",
  rollout:    "deploy",
  rollback:   "rollback",
  revert:     "rollback",
  pause:      "pause",
  stop:       "pause",
  halt:       "pause",
  // information
  analyze:    "analyze",
  research:   "analyze",
  investigate:"analyze",
  inspect:    "analyze",
  review:     "analyze",
  // routing
  route:      "route",
  dispatch:   "route",
  // archive
  archive:    "archive",
  retire:     "archive",
});

/** State / status terminal tokens — "to LIVE", "to BETA", etc. */
export const STATE_TOKENS = Object.freeze({
  live:    "LIVE",
  prod:    "LIVE",
  production: "LIVE",
  beta:    "BETA",
  alpha:   "ALPHA",
  preview: "PREVIEW",
  staging: "STAGING",
  draft:   "DRAFT",
  held:    "HELD",
  archived:"ARCHIVED",
});

/** Risk hints — phrasing that signals risk level for downstream Core. */
export const RISK_HINTS = Object.freeze({
  // explicit
  "read only": "read_only",
  "readonly":  "read_only",
  "dry run":   "read_only",
  "low risk":  "low",
  "medium risk": "medium",
  "high risk": "high",
  "destructive": "destructive",
  "production": "production",
  // implicit verb-driven
  "rollback":  "high",
  "rollout":   "production",
  "deploy":    "production",
  "pause":     "low",
  "audit":     "read_only",
  "analyze":   "read_only",
  "research":  "read_only",
});

/** Lane hints — operator may name a department directly. */
export const LANE_HINTS = Object.freeze({
  "ae0": "AE0_FACTORY", "factory": "AE0_FACTORY",
  "ae1": "AE1_PRODUCT", "product": "AE1_PRODUCT",
  "ae2": "AE2_RESEARCH", // "research" omitted — collides with verb table.

  "ae3": "AE3_DESIGN", "design": "AE3_DESIGN",
  "ae4": "AE4_MARKETING", "marketing": "AE4_MARKETING",
  "ae5": "AE5_SALES", "sales": "AE5_SALES",
  "ae6": "AE6_CODE", "code": "AE6_CODE",
  "ae7": "AE7_REVIEW", // "review" intentionally omitted — collides with the verb table.

  "ae8": "AE8_LAUNCH", // "launch" omitted — collides with verb table.

  "ae9": "AE9_LEGAL", "legal": "AE9_LEGAL",
  "ae10": "AE10_OPS", "ops": "AE10_OPS",
  "ae11": "AE11_SECURITY", "security": "AE11_SECURITY",
  "ae12": "AE12_DATA", "data": "AE12_DATA",
  "ae13": "AE13_AUTOMATION", "automation": "AE13_AUTOMATION",
  "ae14": "AE14_BENCH", "bench": "AE14_BENCH",
});

/** Token kinds emitted by the lexer. */
export const TOKEN_KINDS = Object.freeze({
  VERB:     "VERB",
  TARGET:   "TARGET",     // identifier-like noun (Orange5, Cobra, AtomSmasher)
  VERSION:  "VERSION",    // v1, v2.3, v0.1.0
  NUMBER:   "NUMBER",
  STATE:    "STATE",      // LIVE/BETA/...
  RISK:     "RISK",
  LANE:     "LANE",
  PREP:     "PREP",       // with, to, of, for, into, on, at, in, by, from
  CONNECTOR:"CONNECTOR",  // and, then, &, ,
  QUANT:    "QUANT",      // all, every, each, the, a, an
  DEADLINE: "DEADLINE",   // by Friday / by 2026-09-01 / EOD / Q4
  PUNCT:    "PUNCT",
  WORD:     "WORD",       // generic fallback
});

const PREPOSITIONS = new Set([
  "with","to","of","for","into","on","at","in","by","from","under","via","using",
]);

const CONNECTORS = new Set([
  "and","then","plus","also","&",",",";",
]);

const QUANTIFIERS = new Set([
  "all","every","each","the","a","an","both","any","this","that","these","those",
]);

const STOPWORDS = new Set([
  "please","kindly","just","really","very","quite","actually",
]);

const RELATIVE_DAYS = new Set([
  "monday","tuesday","wednesday","thursday","friday","saturday","sunday",
  "today","tomorrow","tonight","yesterday","weekend","week","weekday",
  "morning","afternoon","evening","night",
]);

const DEADLINE_KEYWORDS = new Set([
  "eod","eow","eom","eoq","eoy","cob","asap","now",
  "q1","q2","q3","q4",
]);

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — Lexer.
//   tokenize(input) → Array<Token>
//
// Tokens preserve original casing and span info so error messages can quote
// back the exact substring the operator typed. We strip stopwords ("please")
// at this layer so the parser doesn't have to litter ignore-lists later.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} Token
 * @property {string} kind   - one of TOKEN_KINDS.*
 * @property {string} value  - canonical value (lowercase verbs, uppercased states, ...)
 * @property {string} raw    - exact substring from source
 * @property {[number, number]} span - [start, endExclusive]
 */

/**
 * Tokenize an AELang-High string.
 * @param {string} input
 * @returns {Token[]}
 */
export function tokenize(input) {
  if (typeof input !== "string") {
    throw new TypeError(`AELang-High tokenize: input must be string, got ${typeof input}`);
  }
  const out = [];
  const re = /[A-Za-zÆæ][\w\-./]*|\d{4}-\d{2}-\d{2}|v\d+(?:\.\d+){0,2}|\d+(?:\.\d+)?|[,;&]/g;
  let m;
  while ((m = re.exec(input)) !== null) {
    const raw = m[0];
    const start = m.index;
    const end = start + raw.length;
    const lower = raw.toLowerCase();
    if (STOPWORDS.has(lower)) continue;

    let tok = null;
    if (raw === "," || raw === ";" || raw === "&") {
      tok = { kind: TOKEN_KINDS.CONNECTOR, value: raw === "&" ? "and" : raw, raw, span: [start, end] };
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      tok = { kind: TOKEN_KINDS.DEADLINE, value: raw, raw, span: [start, end] };
    } else if (/^v\d+(?:\.\d+){0,2}$/i.test(raw)) {
      tok = { kind: TOKEN_KINDS.VERSION, value: raw.toLowerCase(), raw, span: [start, end] };
    } else if (/^\d+(?:\.\d+)?$/.test(raw)) {
      tok = { kind: TOKEN_KINDS.NUMBER, value: raw, raw, span: [start, end] };
    } else if (ACTION_VERBS[lower]) {
      tok = { kind: TOKEN_KINDS.VERB, value: ACTION_VERBS[lower], raw, span: [start, end] };
    } else if (STATE_TOKENS[lower]) {
      tok = { kind: TOKEN_KINDS.STATE, value: STATE_TOKENS[lower], raw, span: [start, end] };
    } else if (LANE_HINTS[lower]) {
      tok = { kind: TOKEN_KINDS.LANE, value: LANE_HINTS[lower], raw, span: [start, end] };
    } else if (PREPOSITIONS.has(lower)) {
      tok = { kind: TOKEN_KINDS.PREP, value: lower, raw, span: [start, end] };
    } else if (CONNECTORS.has(lower)) {
      tok = { kind: TOKEN_KINDS.CONNECTOR, value: lower, raw, span: [start, end] };
    } else if (QUANTIFIERS.has(lower)) {
      tok = { kind: TOKEN_KINDS.QUANT, value: lower, raw, span: [start, end] };
    } else if (RELATIVE_DAYS.has(lower) || DEADLINE_KEYWORDS.has(lower)) {
      tok = { kind: TOKEN_KINDS.DEADLINE, value: lower, raw, span: [start, end] };
    } else if (RISK_HINTS[lower]) {
      tok = { kind: TOKEN_KINDS.RISK, value: RISK_HINTS[lower], raw, span: [start, end] };
    } else if (/^[A-Za-zÆæ]/.test(raw)) {
      // identifier-shaped → TARGET if it looks like a proper noun OR has
      //   capital, digit, hyphen, dot, or slash content; else WORD.
      const looksLikeTarget =
        /[A-ZÆ]/.test(raw) ||                       // any capital
        /[-./]/.test(raw) ||                        // path-ish
        /\d/.test(raw);                             // module-3 etc
      tok = looksLikeTarget
        ? { kind: TOKEN_KINDS.TARGET, value: raw, raw, span: [start, end] }
        : { kind: TOKEN_KINDS.WORD, value: lower, raw, span: [start, end] };
    } else {
      tok = { kind: TOKEN_KINDS.PUNCT, value: raw, raw, span: [start, end] };
    }
    out.push(tok);
  }

  // Second pass: glue multi-word risk hints ("dry run", "read only", "high risk").
  return _gluePhrases(out, RISK_HINTS, TOKEN_KINDS.RISK);
}

function _gluePhrases(tokens, table, asKind) {
  const phrases = Object.keys(table).filter(k => k.includes(" "));
  if (phrases.length === 0) return tokens;
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    let matched = null;
    for (const ph of phrases) {
      const parts = ph.split(" ");
      if (i + parts.length > tokens.length) continue;
      const window = tokens.slice(i, i + parts.length);
      const joined = window.map(t => t.value.toLowerCase()).join(" ");
      if (joined === ph) { matched = { ph, parts, window }; break; }
    }
    if (matched) {
      const first = matched.window[0];
      const last = matched.window[matched.window.length - 1];
      out.push({
        kind: asKind,
        value: table[matched.ph],
        raw: matched.window.map(t => t.raw).join(" "),
        span: [first.span[0], last.span[1]],
      });
      i += matched.parts.length - 1;
    } else {
      out.push(tokens[i]);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — Parser.
//   parseHigh(input) → { ok, ir, errors, warnings, source }
//
// The grammar is operator-friendly, not strict. A High string is one or more
// CLAUSES separated by connectors (",", "and", "then"). Each clause has:
//
//   CLAUSE      := [QUANT] VERB SUBJECT [MODIFIERS]*
//   SUBJECT     := (TARGET | NUMBER TARGET | "the" TARGET)+
//   MODIFIERS   := "with" TARGET+                  → IR.collateral
//                | "to" STATE                       → IR.target_state
//                | "by" DEADLINE_EXPR               → IR.deadline
//                | "in" LANE                        → IR.lane
//                | "for" TARGET                     → IR.beneficiary
//                | "using" TARGET+                  → IR.tools
//                | VERSION                          → IR.version
//                | RISK                             → IR.risk_hint
//
// Two clauses joined by "then" are sequenced; by "and"/"," they're a parallel
// fan-out at the same step.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} HighIR
 * @property {string} schema        - constant "aelang.high.ir.v0"
 * @property {string} raw_intent    - the original input
 * @property {Clause[]} clauses     - one or more parsed clauses
 * @property {("sequence"|"parallel")} composition - how clauses combine
 *
 * @typedef {Object} Clause
 * @property {{verb: string, raw: string}} action
 * @property {Subject[]} subjects
 * @property {string|null} target_state
 * @property {string|null} version
 * @property {string|null} risk_hint
 * @property {DeadlineIR|null} deadline
 * @property {string|null} lane
 * @property {string[]} collateral
 * @property {string[]} tools
 * @property {string|null} beneficiary
 *
 * @typedef {Object} Subject
 * @property {string} name      - e.g. "Orange5", "AtomSmasher"
 * @property {number|null} count - "all 12 modules" → 12; null when not specified
 * @property {boolean} universal - true for "all", "every", "each"
 *
 * @typedef {Object} DeadlineIR
 * @property {string} kind      - "absolute" | "relative" | "keyword" | "quarter"
 * @property {string} value
 * @property {string} raw
 */

/**
 * Parse an AELang-High intent string into IR.
 * @param {string} input
 * @param {{ strict?: boolean }} [opts]
 * @returns {{ ok: boolean, ir: HighIR, errors: ParseError[], warnings: ParseError[], source: string }}
 */
export function parseHigh(input, opts = {}) {
  const errors = [];
  const warnings = [];

  if (typeof input !== "string") {
    errors.push({ code: "E_INPUT_TYPE", message: `input must be string, got ${typeof input}` });
    return { ok: false, ir: _emptyIR(""), errors, warnings, source: "" };
  }
  const source = input.trim();
  if (source === "") {
    errors.push({ code: "E_EMPTY", message: "AELang-High intent is empty" });
    return { ok: false, ir: _emptyIR(""), errors, warnings, source: "" };
  }

  let tokens;
  try { tokens = tokenize(source); }
  catch (e) {
    errors.push({ code: "E_TOKENIZE", message: e.message });
    return { ok: false, ir: _emptyIR(source), errors, warnings, source };
  }

  if (tokens.length === 0) {
    errors.push({ code: "E_NO_TOKENS", message: "no tokens after stripping stopwords" });
    return { ok: false, ir: _emptyIR(source), errors, warnings, source };
  }

  // Split into clause-token-groups on top-level connectors. Capture the
  // connector type so we can decide sequence vs parallel composition.
  const groups = [];
  let buf = [];
  const seenConnectors = new Set();
  for (const t of tokens) {
    if (t.kind === TOKEN_KINDS.CONNECTOR) {
      if (buf.length) groups.push(buf);
      buf = [];
      seenConnectors.add(t.value);
      continue;
    }
    buf.push(t);
  }
  if (buf.length) groups.push(buf);

  const composition = seenConnectors.has("then") ? "sequence" : "parallel";

  const clauses = [];
  for (const g of groups) {
    const clause = _parseClause(g, errors, warnings);
    if (clause) clauses.push(clause);
  }

  if (clauses.length === 0 && errors.length === 0) {
    errors.push({ code: "E_NO_CLAUSE", message: "could not extract any actionable clause" });
  }

  const ir = {
    schema: "aelang.high.ir.v0",
    raw_intent: source,
    clauses,
    composition,
  };

  const ok = errors.length === 0;
  if (opts.strict && !ok) {
    const first = errors[0];
    const err = new Error(`AELang-High parse failed: ${first.code} ${first.message}`);
    err.errors = errors;
    throw err;
  }
  return { ok, ir, errors, warnings, source };
}

function _emptyIR(source) {
  return { schema: "aelang.high.ir.v0", raw_intent: source, clauses: [], composition: "parallel" };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — Clause parser (the hot path).
// ─────────────────────────────────────────────────────────────────────────────

function _parseClause(tokens, errors, warnings) {
  if (tokens.length === 0) return null;

  // 1) Find the action verb. If absent, look for a verb-shaped target ("ship",
  //    "release") still wearing WORD because the operator hand-typed something
  //    quirky. If still nothing → error: every clause needs an action.
  const verbIdx = tokens.findIndex(t => t.kind === TOKEN_KINDS.VERB);
  if (verbIdx === -1) {
    errors.push({
      code: "E_NO_VERB",
      message: "clause has no recognizable action verb",
      raw: tokens.map(t => t.raw).join(" "),
    });
    return null;
  }
  const verbTok = tokens[verbIdx];

  // 2) Optional quantifier directly before verb is ignored ("please all build...")
  //    — quantifiers attach to subjects, not verbs.

  // 3) Walk forward consuming subjects + modifiers.
  const clause = {
    action: { verb: verbTok.value, raw: verbTok.raw },
    subjects: [],
    target_state: null,
    version: null,
    risk_hint: null,
    deadline: null,
    lane: null,
    collateral: [],
    tools: [],
    beneficiary: null,
  };

  // After-verb tokens are the subject + modifier zone.
  const afterVerb = tokens.slice(verbIdx + 1);
  // Pre-verb tokens may contain quantifiers like "all 12 modules" if the
  // operator front-loaded the subject ("all 12 AtomSmasher modules: compress").
  // We treat pre-verb identifiers as candidate subjects too.
  const preVerb = tokens.slice(0, verbIdx);

  // 3a) Pre-verb subjects (front-loaded).
  for (const sub of _scanSubjects(preVerb)) clause.subjects.push(sub);

  // 3b) After-verb walk.
  let i = 0;
  while (i < afterVerb.length) {
    const t = afterVerb[i];

    if (t.kind === TOKEN_KINDS.PREP) {
      const consumed = _handlePrep(t, afterVerb, i + 1, clause, errors, warnings);
      i = consumed;
      continue;
    }
    if (t.kind === TOKEN_KINDS.STATE) {
      // Bare state ("LIVE") with no preceding "to" — still attach.
      if (clause.target_state && clause.target_state !== t.value) {
        warnings.push({ code: "W_MULTI_STATE",
          message: `multiple target states; overwriting "${clause.target_state}" with "${t.value}"`,
          span: t.span });
      }
      clause.target_state = t.value;
      i++; continue;
    }
    if (t.kind === TOKEN_KINDS.VERSION) {
      clause.version = t.value;
      i++; continue;
    }
    if (t.kind === TOKEN_KINDS.LANE) {
      if (clause.lane && clause.lane !== t.value) {
        warnings.push({ code: "W_MULTI_LANE",
          message: `multiple lanes; keeping "${clause.lane}", ignoring "${t.value}"`,
          span: t.span });
      } else {
        clause.lane = t.value;
      }
      i++; continue;
    }
    if (t.kind === TOKEN_KINDS.RISK) {
      clause.risk_hint = t.value;
      i++; continue;
    }
    if (t.kind === TOKEN_KINDS.DEADLINE) {
      clause.deadline = _classifyDeadline(t);
      i++; continue;
    }
    if (t.kind === TOKEN_KINDS.QUANT || t.kind === TOKEN_KINDS.NUMBER
        || t.kind === TOKEN_KINDS.TARGET || t.kind === TOKEN_KINDS.WORD) {
      // Greedy subject consumption: pull contiguous QUANT/NUMBER/TARGET/WORD.
      // WORD is accepted because operators frequently use lowercase nouns
      // ("dashboard", "module", "it"). The validator and downstream Core
      // emitter are the layers that ground these against real artifacts.
      const { subject, next } = _consumeSubject(afterVerb, i);
      if (subject) {
        clause.subjects.push(subject);
        i = next;
        continue;
      }
      // Couldn't form a subject from here — warn and advance one token.
      warnings.push({ code: "W_FILLER_WORD",
        message: `ignored filler word "${t.raw}"`, span: t.span });
      i++; continue;
    }
    // PUNCT / unknown — skip but warn once.
    warnings.push({ code: "W_UNHANDLED_TOKEN",
      message: `unhandled token kind ${t.kind} "${t.raw}"`, span: t.span });
    i++;
  }

  // 4) Apply implicit risk if verb is risky and operator didn't override.
  if (!clause.risk_hint && RISK_HINTS[clause.action.verb]) {
    clause.risk_hint = RISK_HINTS[clause.action.verb];
  }

  // 5) Validation: every clause must have ≥1 subject — except `pause` (operator
  //    pause is universal) and `route` (which can be lane-only).
  if (clause.subjects.length === 0
      && clause.action.verb !== "pause"
      && clause.action.verb !== "route") {
    errors.push({
      code: "E_NO_SUBJECT",
      message: `verb "${clause.action.verb}" has no subject`,
      raw: tokens.map(t => t.raw).join(" "),
    });
    return null;
  }

  return clause;
}

function _scanSubjects(tokens) {
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.kind === TOKEN_KINDS.QUANT || t.kind === TOKEN_KINDS.NUMBER || t.kind === TOKEN_KINDS.TARGET) {
      const { subject, next } = _consumeSubject(tokens, i);
      if (subject) out.push(subject);
      i = next;
    } else {
      i++;
    }
  }
  return out;
}

function _consumeSubject(tokens, start) {
  let universal = false;
  let count = null;
  let nameParts = [];
  let i = start;

  // Optional QUANT prefix.
  if (i < tokens.length && tokens[i].kind === TOKEN_KINDS.QUANT) {
    const q = tokens[i].value;
    if (q === "all" || q === "every" || q === "each" || q === "both") universal = true;
    i++;
  }
  // Optional NUMBER.
  if (i < tokens.length && tokens[i].kind === TOKEN_KINDS.NUMBER) {
    count = parseInt(tokens[i].value, 10);
    if (!Number.isFinite(count)) count = null;
    i++;
  }
  // One or more TARGET/WORD tokens — but stop at boundary kinds (PREP,
  // CONNECTOR, VERB, STATE, RISK, LANE, DEADLINE, VERSION).
  // A WORD is accepted as a noun (head or continuation). Pronouns and
  // plural nouns are typical here ("it", "modules", "bundle").
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.kind === TOKEN_KINDS.TARGET || t.kind === TOKEN_KINDS.WORD) {
      nameParts.push(t.raw);
      i++;
      continue;
    }
    break;
  }

  if (nameParts.length === 0 && !universal && count === null) {
    return { subject: null, next: start + 1 };
  }
  const name = nameParts.length > 0 ? nameParts.join(" ") : (universal ? "*" : String(count));
  return {
    subject: { name, count, universal },
    next: i,
  };
}

function _handlePrep(prepTok, tokens, start, clause, errors, warnings) {
  const prep = prepTok.value;

  // Peek the immediate next token to decide the prep's payload.
  let i = start;
  const next = tokens[i];
  if (!next) {
    warnings.push({ code: "W_DANGLING_PREP",
      message: `dangling preposition "${prep}"`, span: prepTok.span });
    return i;
  }

  // by <DEADLINE>  — accepts: DEADLINE keyword/relative-day, ISO date (DEADLINE
  // kind from lexer), NUMBER (used by "by 2026"), modifier WORDs ("next",
  // "this", "end", "of"), and a TARGET only if it's a numeric / digit form.
  if (prep === "by") {
    const dlTokens = [];
    while (i < tokens.length) {
      const tt = tokens[i];
      const isModifierWord = tt.kind === TOKEN_KINDS.WORD
        && (tt.value === "next" || tt.value === "this" || tt.value === "end" || tt.value === "of");
      const isQuantThe = tt.kind === TOKEN_KINDS.QUANT && tt.value === "the"; // "by the EOD"
      if (tt.kind === TOKEN_KINDS.DEADLINE
          || tt.kind === TOKEN_KINDS.NUMBER
          || (tt.kind === TOKEN_KINDS.TARGET && /^\d/.test(tt.raw))
          || isModifierWord
          || isQuantThe) {
        dlTokens.push(tt);
        i++;
        continue;
      }
      break;
    }
    if (dlTokens.length > 0) {
      clause.deadline = _classifyDeadlinePhrase(dlTokens);
      return i;
    }
    warnings.push({ code: "W_BAD_DEADLINE",
      message: `"by ${next.raw}" did not resolve to a deadline`, span: next.span });
    return i;
  }

  // to <STATE> | to <TARGET>
  if (prep === "to") {
    if (next.kind === TOKEN_KINDS.STATE) {
      clause.target_state = next.value;
      return i + 1;
    }
    if (next.kind === TOKEN_KINDS.LANE) {
      clause.lane = next.value;
      return i + 1;
    }
    // "to LIVE" already handled; "to production" too. If it's a TARGET, treat as
    // destination collateral.
    if (next.kind === TOKEN_KINDS.TARGET || next.kind === TOKEN_KINDS.WORD) {
      clause.collateral.push(next.raw);
      return i + 1;
    }
    return i;
  }

  // with <TARGET>+ | with <STATE> (rare but allowed: "with LIVE flag")
  if (prep === "with") {
    let consumed = 0;
    while (i < tokens.length) {
      const tt = tokens[i];
      if (tt.kind === TOKEN_KINDS.TARGET || tt.kind === TOKEN_KINDS.STATE) {
        clause.collateral.push(tt.raw);
        i++; consumed++;
        // Allow trailing STATE: "with Æ Cobra LIVE" — Cobra is target, LIVE is state.
        if (tt.kind === TOKEN_KINDS.STATE) clause.target_state = tt.value;
      } else if (tt.kind === TOKEN_KINDS.WORD && consumed > 0) {
        // Continuation noun within phrase
        clause.collateral.push(tt.raw);
        i++;
      } else break;
    }
    if (consumed === 0) {
      warnings.push({ code: "W_EMPTY_WITH",
        message: `"with" had no collateral target`, span: prepTok.span });
    }
    return i;
  }

  // in <LANE> | in <TARGET>
  if (prep === "in" || prep === "on" || prep === "under" || prep === "at") {
    if (next.kind === TOKEN_KINDS.LANE) {
      clause.lane = next.value;
      return i + 1;
    }
    if (next.kind === TOKEN_KINDS.TARGET) {
      clause.collateral.push(next.raw);
      return i + 1;
    }
    return i;
  }

  // for <TARGET> — beneficiary
  if (prep === "for") {
    if (next.kind === TOKEN_KINDS.TARGET || next.kind === TOKEN_KINDS.WORD) {
      clause.beneficiary = next.raw;
      return i + 1;
    }
    return i;
  }

  // using/via <TARGET>+ — tools
  if (prep === "using" || prep === "via") {
    while (i < tokens.length) {
      const tt = tokens[i];
      if (tt.kind === TOKEN_KINDS.TARGET || tt.kind === TOKEN_KINDS.WORD) {
        clause.tools.push(tt.raw);
        i++;
      } else break;
    }
    return i;
  }

  // of/from/into — treat the next TARGET as collateral.
  if (next.kind === TOKEN_KINDS.TARGET) {
    clause.collateral.push(next.raw);
    return i + 1;
  }
  return i;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — Deadline classifier.
// ─────────────────────────────────────────────────────────────────────────────

function _classifyDeadline(tok) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(tok.value)) {
    return { kind: "absolute", value: tok.value, raw: tok.raw };
  }
  const v = tok.value.toLowerCase();
  if (RELATIVE_DAYS.has(v)) {
    return { kind: "relative", value: v, raw: tok.raw };
  }
  if (DEADLINE_KEYWORDS.has(v)) {
    if (/^q[1-4]$/.test(v)) return { kind: "quarter", value: v.toUpperCase(), raw: tok.raw };
    return { kind: "keyword", value: v.toUpperCase(), raw: tok.raw };
  }
  return { kind: "keyword", value: v, raw: tok.raw };
}

function _classifyDeadlinePhrase(tokens) {
  // Single-token shortcut.
  if (tokens.length === 1) return _classifyDeadline(tokens[0]);

  const raw = tokens.map(t => t.raw).join(" ");
  const joined = tokens.map(t => t.value).join(" ").toLowerCase();

  // ISO date.
  for (const t of tokens) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(t.value)) {
      return { kind: "absolute", value: t.value, raw };
    }
  }
  // "next Friday" / "this Monday".
  const modifier = tokens[0]?.value?.toLowerCase();
  if ((modifier === "next" || modifier === "this") && tokens[1]
      && RELATIVE_DAYS.has(tokens[1].value.toLowerCase())) {
    return { kind: "relative", value: `${modifier} ${tokens[1].value.toLowerCase()}`, raw };
  }
  // "end of week" → EOW etc.
  if (joined === "end of week") return { kind: "keyword", value: "EOW", raw };
  if (joined === "end of day")  return { kind: "keyword", value: "EOD", raw };
  if (joined === "end of month") return { kind: "keyword", value: "EOM", raw };
  if (joined === "end of quarter") return { kind: "keyword", value: "EOQ", raw };

  return { kind: "keyword", value: joined, raw };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — Validator.
//   Operates on IR. The structural rules:
//     - schema must be "aelang.high.ir.v0"
//     - clauses must be non-empty
//     - each clause needs an action verb known to ACTION_VERBS' values
//     - composition ∈ {sequence, parallel}
//     - deadline.kind ∈ known set when present
//     - count must be a positive integer when present
// ─────────────────────────────────────────────────────────────────────────────

const KNOWN_VERBS = new Set(Object.values(ACTION_VERBS));
const KNOWN_DEADLINE_KINDS = new Set(["absolute", "relative", "keyword", "quarter"]);

/**
 * Validate a parsed AELang-High IR.
 * @param {HighIR} ir
 * @returns {{ ok: boolean, errors: Array<{code:string, message:string, path:string}> }}
 */
export function validateHighIR(ir) {
  const errs = [];

  if (!ir || typeof ir !== "object" || Array.isArray(ir)) {
    return { ok: false, errors: [{ code: "E_ROOT_TYPE", message: "IR must be object", path: "$" }] };
  }
  if (ir.schema !== "aelang.high.ir.v0") {
    errs.push({ code: "E_SCHEMA", message: `bad schema "${ir.schema}"`, path: "$.schema" });
  }
  if (typeof ir.raw_intent !== "string") {
    errs.push({ code: "E_RAW_INTENT", message: "raw_intent must be string", path: "$.raw_intent" });
  }
  if (!Array.isArray(ir.clauses) || ir.clauses.length === 0) {
    errs.push({ code: "E_NO_CLAUSES", message: "clauses must be non-empty array", path: "$.clauses" });
  }
  if (ir.composition !== "sequence" && ir.composition !== "parallel") {
    errs.push({ code: "E_COMPOSITION", message: `bad composition "${ir.composition}"`, path: "$.composition" });
  }

  if (Array.isArray(ir.clauses)) {
    ir.clauses.forEach((c, idx) => {
      const p = `$.clauses[${idx}]`;
      if (!c || typeof c !== "object") {
        errs.push({ code: "E_CLAUSE_TYPE", message: "clause must be object", path: p });
        return;
      }
      if (!c.action || typeof c.action.verb !== "string") {
        errs.push({ code: "E_CLAUSE_ACTION", message: "clause.action.verb missing", path: `${p}.action` });
      } else if (!KNOWN_VERBS.has(c.action.verb)) {
        errs.push({ code: "E_UNKNOWN_VERB",
          message: `unknown verb "${c.action.verb}"`, path: `${p}.action.verb` });
      }
      if (!Array.isArray(c.subjects)) {
        errs.push({ code: "E_SUBJECTS_TYPE", message: "subjects must be array", path: `${p}.subjects` });
      } else {
        c.subjects.forEach((s, j) => {
          const sp = `${p}.subjects[${j}]`;
          if (!s || typeof s.name !== "string" || s.name.length === 0) {
            errs.push({ code: "E_SUBJECT_NAME", message: "subject.name required", path: sp });
          }
          if (s && s.count !== null && (!Number.isInteger(s.count) || s.count <= 0)) {
            errs.push({ code: "E_SUBJECT_COUNT",
              message: "subject.count must be positive int or null", path: `${sp}.count` });
          }
          if (s && typeof s.universal !== "boolean") {
            errs.push({ code: "E_SUBJECT_UNIVERSAL",
              message: "subject.universal must be boolean", path: `${sp}.universal` });
          }
        });
      }
      if (c.deadline && !KNOWN_DEADLINE_KINDS.has(c.deadline.kind)) {
        errs.push({ code: "E_DEADLINE_KIND",
          message: `bad deadline.kind "${c.deadline.kind}"`, path: `${p}.deadline.kind` });
      }
    });
  }

  return { ok: errs.length === 0, errors: errs };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 — CLI: node high-parser.mjs "ship Orange5 v1 with Æ Cobra LIVE by Friday"
// ─────────────────────────────────────────────────────────────────────────────

// CLI gate — fires when invoked directly with `node high-parser.mjs ...`.
// We normalise both sides because Node on Windows reports the script as a
// `file:///C:/...` URL while `process.argv[1]` is a native path; match by
// path tail rather than exact URL equality.
function _isDirectInvocation() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const norm = argv1.replace(/\\/g, "/");
  return import.meta.url.endsWith(norm) || import.meta.url === `file://${norm}`;
}
if (_isDirectInvocation()) {
  const input = process.argv.slice(2).join(" ");
  if (!input) {
    console.error('usage: node high-parser.mjs "<intent string>"');
    process.exit(2);
  }
  const r = parseHigh(input);
  const v = validateHighIR(r.ir);
  const out = {
    ok: r.ok && v.ok,
    parse_errors: r.errors,
    parse_warnings: r.warnings,
    validate_errors: v.errors,
    ir: r.ir,
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
}
