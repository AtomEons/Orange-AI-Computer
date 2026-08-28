// AE OrangeLLM — ToolMesh capability consult (memory side)
// Path: 06-ORANGELLM/memory/toolmesh-consult.mjs
//
// Doctrine (operator-issued, Atom McCree):
//   - OrangeLLM, during planning, sometimes needs to answer the question
//     "what capabilities can I invoke for X?" BEFORE it asks the operator
//     for execution approval. That question is answered by consulting the
//     ToolMesh registry — the JSON-schema'd capability surface that holds
//     tool-cards across the 11 capability labs (image, video, audio,
//     design, coding, automation, analytics, public-agent, observability,
//     security, releaseops).
//
//   - Tool-cards are CAPABILITY INDICATORS, not permission-to-execute.
//     They surface what the mesh can do, at what cost class, latency class,
//     and risk class. Execution remains gated by Hermes leases + the
//     8-gate LOOM chain. Nothing in this file mints a lease, opens a
//     socket, runs an adapter, or touches a host resource — it is a read
//     window onto 13-TOOLMESH/registry.mjs surfaced as a memory consult.
//
//   - This module is the COMPANION to server/routes/toolmesh.mjs.
//     - toolmesh.mjs is the HTTP gateway surface (frontier / cockpit).
//     - this file is the IN-PROCESS surface that the memory-inject
//       middleware (server/middleware/memory-inject.mjs) calls to embed
//       a compact capability brief in the system role of an outgoing
//       chat completion, so the model knows what it can ask for without
//       a round trip.
//
//   - Mom's Law applies to the surface too: no fake-200s, no silent empty
//     payloads if the registry could not load, no inventing cards we did
//     not validate. Honest gaps over elegant fiction. If the mesh is down
//     we emit a tombstone — exactly the way memory-inject handles a Cobra
//     outage. Better candid "mesh unavailable" than amnesia.
//
//   - Determinism: every consult returns results sorted by
//     (-score, lab, card_id). Two identical queries against an unchanged
//     registry produce byte-identical output. The model relies on this
//     when it caches the prior turn's system message.
//
//   - Hot-reload: the underlying ToolMeshRegistry watches labs/ via
//     fs.watch and rebuilds its index when a card changes. This module
//     does not cache cards itself — it holds the registry handle and
//     re-reads its current view on every consult. That keeps the
//     fast-path simple: one Map iteration, no second tier of staleness.
//
// Exports:
//   consult(spec, opts?)
//     async (spec) -> { ok, registry, query, total_loaded,
//                       total_quarantined, count, results: [Hit, ...] }
//     The primary entry point. `spec` is plain text or a structured
//     ConsultSpec (see below). `opts.registry` may inject a registry
//     handle (tests, alternate labs root). `opts.now` is injectable for
//     deterministic stale-checks under tests.
//
//   renderConsultForSystemRole(consult, opts?)
//     (consult) -> string
//     Pure formatter. Turns a consult result into a compact, model-friendly
//     fenced block suitable for prepending as a system message. Stable
//     ordering. ~ 30 chars per hit when used at default (limit=12).
//
//   parseConsultIntent(text)
//     (text) -> ConsultSpec | null
//     Lightweight intent extractor. Looks for the consult tags the model
//     emits when it wants to widen the brief beyond the auto-inject
//     default. Tags:
//
//        <toolmesh-consult>X</toolmesh-consult>      free text query
//        <toolmesh-consult lab="coding">X</...>      lab pin
//        <toolmesh-consult capability="image.upscale">  exact cap
//        <toolmesh-consult capability="image.*">     cap prefix
//
//     Returns null if no tag is present. Multiple tags concatenate into
//     a single broader query (deduped fields).
//
//   __consultInternals
//     Test surface. Not for production callers.
//
// Wire (illustrative — actual wiring happens in memory-inject.mjs):
//
//   import { consult, renderConsultForSystemRole, parseConsultIntent }
//     from "../memory/toolmesh-consult.mjs";
//
//   // 1) auto-tap: every chat completion gets a small brief tied to the
//   //    user's last message
//   const brief = await consult({ query: userText, limit: 8 });
//   const block = renderConsultForSystemRole(brief);
//
//   // 2) deeper tap: model emits <toolmesh-consult> tags
//   const intent = parseConsultIntent(userText);
//   if (intent) {
//     const deep = await consult(intent);
//     systemMessages.push(renderConsultForSystemRole(deep, { kind: "deep" }));
//   }
//
// Honest gaps (called out for the reviewer):
//   - This is a memory-side consult, NOT an MCP tool. The 11 labs and their
//     cards are surfaced to the model as INFORMATION; the model still has
//     to ask Hermes for a lease to actually invoke anything.
//   - Ranking is a deterministic heuristic, not a learned model. It
//     prefers cap-prefix matches over free-text hits, free over byo-key
//     over metered, read-only over sandboxed over mutating over
//     external-side-effect, sub-second over seconds over minutes, fresher
//     last_verified_at over staler. Tunable, but stable.
//   - The registry's underlying search returns deprecated cards only when
//     includeDeprecated is set; we keep that default off here too. Stale
//     cards (last_verified_at older than `staleAfterMs`) are surfaced with
//     a `stale: true` flag but NOT excluded unless the caller asks.
//   - Node 20+. ESM. No npm deps.

import { ToolMeshRegistry, searchCards, LAB_IDS }
  from "../../13-TOOLMESH/registry.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// Constants — closed enums mirror the schema. Diverging here is a bug.
// ─────────────────────────────────────────────────────────────────────────────

const COST_CLASSES = Object.freeze(["free", "byo-key", "metered"]);
const LATENCY_CLASSES = Object.freeze(["sub-second", "seconds", "minutes"]);
const RISK_CLASSES = Object.freeze([
  "read-only",
  "sandboxed",
  "mutating",
  "external-side-effect",
]);

const COST_RANK = new Map(COST_CLASSES.map((v, i) => [v, i]));
const LATENCY_RANK = new Map(LATENCY_CLASSES.map((v, i) => [v, i]));
const RISK_RANK = new Map(RISK_CLASSES.map((v, i) => [v, i]));

// Defaults. Tuned for a system-role message that costs <~ 600 tokens at
// default limit and stays inside any reasonable context budget.
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 100;
const DEFAULT_STALE_AFTER_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const MAX_QUERY_LEN = 400;
const MAX_TAGS = 16;

// Render budget. Past this we truncate with an honest "and N more" line.
const MAX_RENDERED_HITS = 12;

// Consult-intent tag scanner. Mirrors the <recall> pattern memory-inject
// already uses; same grammar so the operator's eye does not have to switch.
const CONSULT_TAG_RX =
  /<toolmesh-consult\b([^>]*)>([\s\S]*?)<\/toolmesh-consult>/gi;
const CONSULT_ATTR_RX = /([a-z_]+)\s*=\s*"([^"]*)"/g;

const SCHEMA_VERSION = "0.1.0";

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export class ConsultSpecError extends Error {
  constructor(message, { field } = {}) {
    super(message);
    this.name = "ConsultSpecError";
    this.code = "TOOLMESH_CONSULT_BAD_SPEC";
    this.field = field;
  }
}

export class ToolMeshUnavailableError extends Error {
  constructor(cause) {
    super(`ToolMesh registry unavailable: ${cause?.message || cause || "unknown"}`);
    this.name = "ToolMeshUnavailableError";
    this.code = "TOOLMESH_UNAVAILABLE";
    this.cause = cause;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry handle — shared, lazy. Fs.watch in the registry keeps us current.
// ─────────────────────────────────────────────────────────────────────────────

let _registry = null;
let _registryLoading = null;
let _lastLoadError = null;

function _resetRegistryForTests() {
  // The registry holds fs watchers; close it cleanly when a test injects a
  // fresh one. Production never calls this.
  if (_registry && typeof _registry.close === "function") {
    try { _registry.close(); } catch { /* best effort */ }
  }
  _registry = null;
  _registryLoading = null;
  _lastLoadError = null;
}

async function _getRegistry(opts) {
  if (opts?.registry) return opts.registry;
  if (_registry) return _registry;
  if (_registryLoading) return _registryLoading;

  _registryLoading = (async () => {
    try {
      const reg = new ToolMeshRegistry({
        labsRoot: opts?.labsRoot,
        watch: opts?.watch !== false,
      });
      await reg.load();
      _registry = reg;
      _lastLoadError = null;
      return reg;
    } catch (err) {
      _lastLoadError = err;
      throw new ToolMeshUnavailableError(err);
    } finally {
      _registryLoading = null;
    }
  })();
  return _registryLoading;
}

// ─────────────────────────────────────────────────────────────────────────────
// Spec normalization
// ─────────────────────────────────────────────────────────────────────────────
//
// A ConsultSpec is the shape we pass to searchCards() with two extras:
//   - `limit` is capped at MAX_LIMIT.
//   - `staleAfterMs` flags rather than excludes; the registry's
//     includeStaleAfterMs would exclude, which is the wrong default here.
//
// Accepted shapes:
//   "free text"                       -> { query: "free text" }
//   { query, lab, capability, cost_class, latency_class, risk_class,
//     tags, vendor, limit, includeDeprecated, staleAfterMs }

function _normalizeSpec(spec) {
  if (spec == null) return { query: "" };

  if (typeof spec === "string") {
    const q = spec.trim();
    if (q.length > MAX_QUERY_LEN) {
      throw new ConsultSpecError(
        `query exceeds ${MAX_QUERY_LEN} chars (got ${q.length})`,
        { field: "query" },
      );
    }
    return { query: q };
  }

  if (typeof spec !== "object" || Array.isArray(spec)) {
    throw new ConsultSpecError("spec must be string or object", { field: "spec" });
  }

  const out = {};

  if (spec.query != null) {
    if (typeof spec.query !== "string") {
      throw new ConsultSpecError("query must be a string", { field: "query" });
    }
    if (spec.query.length > MAX_QUERY_LEN) {
      throw new ConsultSpecError(
        `query exceeds ${MAX_QUERY_LEN} chars (got ${spec.query.length})`,
        { field: "query" },
      );
    }
    out.query = spec.query.trim();
  }

  out.lab = _normalizeEnumField(spec.lab, LAB_IDS, "lab");
  out.cost_class = _normalizeEnumField(spec.cost_class, COST_CLASSES, "cost_class");
  out.latency_class = _normalizeEnumField(
    spec.latency_class,
    LATENCY_CLASSES,
    "latency_class",
  );
  out.risk_class = _normalizeEnumField(spec.risk_class, RISK_CLASSES, "risk_class");

  if (spec.capability != null) {
    if (typeof spec.capability !== "string") {
      throw new ConsultSpecError("capability must be a string", {
        field: "capability",
      });
    }
    out.capability = spec.capability;
  }

  if (spec.vendor != null) {
    if (typeof spec.vendor !== "string") {
      throw new ConsultSpecError("vendor must be a string", { field: "vendor" });
    }
    out.vendor = spec.vendor;
  }

  if (spec.tags != null) {
    if (!Array.isArray(spec.tags)) {
      throw new ConsultSpecError("tags must be an array", { field: "tags" });
    }
    if (spec.tags.length > MAX_TAGS) {
      throw new ConsultSpecError(`tags exceeds ${MAX_TAGS} entries`, {
        field: "tags",
      });
    }
    for (const t of spec.tags) {
      if (typeof t !== "string" || t.length === 0) {
        throw new ConsultSpecError("tags entries must be non-empty strings", {
          field: "tags",
        });
      }
    }
    out.tags = [...spec.tags];
  }

  if (spec.includeDeprecated != null) {
    out.includeDeprecated = !!spec.includeDeprecated;
  }

  if (spec.limit != null) {
    if (!Number.isInteger(spec.limit) || spec.limit < 1) {
      throw new ConsultSpecError("limit must be a positive integer", {
        field: "limit",
      });
    }
    out.limit = Math.min(spec.limit, MAX_LIMIT);
  } else {
    out.limit = DEFAULT_LIMIT;
  }

  if (spec.staleAfterMs != null) {
    if (!Number.isFinite(spec.staleAfterMs) || spec.staleAfterMs < 0) {
      throw new ConsultSpecError(
        "staleAfterMs must be a non-negative number",
        { field: "staleAfterMs" },
      );
    }
    out.staleAfterMs = spec.staleAfterMs;
  } else {
    out.staleAfterMs = DEFAULT_STALE_AFTER_MS;
  }

  return out;
}

function _normalizeEnumField(val, enumArr, field) {
  if (val == null) return undefined;
  if (Array.isArray(val)) {
    for (const v of val) {
      if (!enumArr.includes(v)) {
        throw new ConsultSpecError(
          `${field} contains unknown value "${v}"`,
          { field },
        );
      }
    }
    return [...val];
  }
  if (typeof val !== "string") {
    throw new ConsultSpecError(`${field} must be string or array`, { field });
  }
  if (!enumArr.includes(val)) {
    throw new ConsultSpecError(`${field} unknown value "${val}"`, { field });
  }
  return val;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring + ranking
// ─────────────────────────────────────────────────────────────────────────────
//
// Score is a sum of weighted signals; ties broken deterministically by
// (lab, card_id). Higher is better.
//
// Signals (weights chosen so that capability-prefix wins decisively over
// free-text-hit, and cost/latency/risk are tiebreakers when relevance is
// equal — never override relevance):
//
//   +500  exact capability match
//   +300  capability prefix match (cap ending in .*)
//   +100  query token appears in card.capability
//   + 50  query token appears in card.summary
//   + 20  query token appears in tag
//   + 10  query token appears in vendor
//   + 10  query token appears in card_id
//
//   Tiebreakers (additive, small):
//   + (2 - cost_rank)        cost: free=+2, byo-key=+1, metered=0
//   + (2 - latency_rank)     latency: sub-second=+2, seconds=+1, minutes=0
//   + (3 - risk_rank)        risk: read-only=+3 ... external-side-effect=0
//
//   Penalty:
//   - 25 if stale (last_verified_at older than staleAfterMs)
//
// The score is exposed back to callers so a downstream agent could
// re-rank without re-implementing the heuristic.

function _scoreCard(card, spec, now) {
  let score = 0;

  // Capability signals
  if (spec.capability) {
    if (spec.capability.endsWith(".*")) {
      const prefix = spec.capability.slice(0, -1);
      if (card.capability && card.capability.startsWith(prefix)) score += 300;
    } else if (card.capability === spec.capability) {
      score += 500;
    }
  }

  // Free-text query signals — token-based so multi-word queries don't
  // collapse to a single phrase match. We split on whitespace and "."
  // because dotted capability paths are how the mesh names things.
  const q = spec.query ? spec.query.toLowerCase() : "";
  if (q) {
    const tokens = q.split(/[\s.]+/).filter((t) => t.length >= 2);
    const cap = (card.capability || "").toLowerCase();
    const sum = (card.summary || "").toLowerCase();
    const tagSet = new Set((card.tags || []).map((t) => String(t).toLowerCase()));
    const vendor = (card.vendor || "").toLowerCase();
    const cardId = (card.card_id || "").toLowerCase();

    for (const tok of tokens) {
      if (cap.includes(tok)) score += 100;
      if (sum.includes(tok)) score += 50;
      if (tagSet.has(tok)) score += 20;
      if (vendor.includes(tok)) score += 10;
      if (cardId.includes(tok)) score += 10;
    }
  }

  // Cost / latency / risk tiebreakers — small, additive, never decisive.
  const costR = COST_RANK.get(card.cost_class);
  if (costR != null) score += (2 - costR);
  const latR = LATENCY_RANK.get(card.latency_class);
  if (latR != null) score += (2 - latR);
  const riskR = RISK_RANK.get(card.risk_class);
  if (riskR != null) score += (3 - riskR);

  // Staleness penalty
  let stale = false;
  if (spec.staleAfterMs && card.last_verified_at) {
    const t = Date.parse(card.last_verified_at);
    if (Number.isFinite(t) && now - t > spec.staleAfterMs) {
      stale = true;
      score -= 25;
    }
  }

  return { score, stale };
}

function _rankAndSlice(cards, spec, now) {
  const scored = [];
  for (const c of cards) {
    const { score, stale } = _scoreCard(c, spec, now);
    scored.push({ card: c, score, stale });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.card.lab !== b.card.lab) return a.card.lab < b.card.lab ? -1 : 1;
    if (a.card.card_id !== b.card.card_id) {
      return a.card.card_id < b.card.card_id ? -1 : 1;
    }
    return 0;
  });

  const out = [];
  for (const s of scored) {
    out.push(_shapeHit(s.card, s.score, s.stale));
    if (out.length >= spec.limit) break;
  }
  return out;
}

function _shapeHit(card, score, stale) {
  // We surface a tight subset of the card — enough for the model to
  // reason about whether to ask for it, but not the whole adapter
  // contract. The model can request the full card via a separate route
  // if it really needs internals.
  return {
    lab: card.lab,
    card_id: card.card_id,
    capability: card.capability,
    summary: card.summary || "",
    cost_class: card.cost_class,
    latency_class: card.latency_class,
    risk_class: card.risk_class,
    vendor: card.vendor || null,
    tags: card.tags ? [...card.tags] : [],
    deprecated: card.deprecated === true,
    last_verified_at: card.last_verified_at || null,
    score,
    stale,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Primary entry — consult(spec, opts?)
// ─────────────────────────────────────────────────────────────────────────────

export async function consult(spec, opts = {}) {
  const t0 = (opts.now ?? Date.now());
  const norm = _normalizeSpec(spec);

  let reg;
  try {
    reg = await _getRegistry(opts);
  } catch (err) {
    // Tombstone — honest. We do not throw; the caller will likely embed
    // this in a system message and the model needs to keep going.
    return {
      ok: false,
      schema: SCHEMA_VERSION,
      registry: {
        available: false,
        reason: err.message,
        total_loaded: 0,
        total_quarantined: 0,
      },
      query: norm,
      count: 0,
      results: [],
    };
  }

  // Pull the registry's current view. searchCards() applies the structural
  // filters (lab, capability, cost_class, etc.); we re-rank on top of the
  // filtered list. Free-text matching happens twice — once as a coarse
  // filter inside searchCards (via `query`), once as a scoring signal in
  // _scoreCard — that's intentional: searchCards is the AND-filter, our
  // ranker is the relevance signal.
  const cardsView = reg.list();
  const searchQuery = {
    lab: norm.lab,
    cost_class: norm.cost_class,
    latency_class: norm.latency_class,
    risk_class: norm.risk_class,
    capability: norm.capability,
    tags: norm.tags,
    vendor: norm.vendor,
    query: norm.query || undefined,
    includeDeprecated: norm.includeDeprecated === true,
  };
  const filtered = searchCards(cardsView, searchQuery);

  const results = _rankAndSlice(filtered, norm, t0);
  const stats = typeof reg.stats === "function" ? reg.stats() : null;

  return {
    ok: true,
    schema: SCHEMA_VERSION,
    registry: {
      available: true,
      total_loaded: stats?.loaded ?? cardsView.length,
      total_quarantined: stats?.quarantined ?? 0,
    },
    query: norm,
    count: results.length,
    results,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Render — produce a compact system-role block.
// ─────────────────────────────────────────────────────────────────────────────
//
// The output is deliberately small, fenced, and human-legible. The model
// gets:
//   - a header that names what this is
//   - registry health on one line
//   - the top N hits in a fixed columnar layout
//   - an honest "and N more" footer when we truncated
//   - a "no hits" line when count is 0 (still useful — tells the model
//     the mesh does not currently expose anything for that intent)
//
// Kind:
//   "auto" (default)    — the always-on tap, smaller header
//   "deep"              — emitted in response to <toolmesh-consult> tags
//   "tombstone"         — emitted when registry is unavailable

export function renderConsultForSystemRole(consultResult, opts = {}) {
  if (!consultResult || typeof consultResult !== "object") {
    return "[TOOLMESH:UNAVAILABLE] consult result missing\n[END:TOOLMESH]";
  }

  const kind = opts.kind === "deep" ? "deep" : "auto";

  if (consultResult.ok === false) {
    const reason = consultResult.registry?.reason || "unknown";
    return [
      `[TOOLMESH:UNAVAILABLE kind=${kind}]`,
      `mesh registry is not reachable right now (${_sanitize(reason)}).`,
      `treat this turn as if the 11 capability labs were dark; tell the operator if you need one.`,
      `[END:TOOLMESH]`,
    ].join("\n");
  }

  const { registry, query, count, results } = consultResult;
  const header = kind === "deep"
    ? `[TOOLMESH:DEEP loaded=${registry.total_loaded} quarantined=${registry.total_quarantined}]`
    : `[TOOLMESH:AUTO loaded=${registry.total_loaded} quarantined=${registry.total_quarantined}]`;

  const lines = [header];

  // Echo the normalized query so the model can see what it asked for
  // (helps when multiple consults are interleaved in one turn).
  const queryEcho = _renderQueryEcho(query);
  if (queryEcho) lines.push(`query: ${queryEcho}`);

  if (count === 0) {
    lines.push("hits: 0 — the mesh currently exposes no card matching this intent.");
    lines.push("[END:TOOLMESH]");
    return lines.join("\n");
  }

  const renderBudget = Math.min(results.length, MAX_RENDERED_HITS);
  lines.push(`hits: ${count}${count > renderBudget ? ` (showing ${renderBudget})` : ""}`);

  for (let i = 0; i < renderBudget; i++) {
    lines.push(_renderHit(results[i]));
  }

  if (count > renderBudget) {
    lines.push(`… and ${count - renderBudget} more — narrow the query to see them.`);
  }

  lines.push("[END:TOOLMESH]");
  return lines.join("\n");
}

function _renderHit(hit) {
  // Columnar: lab/card_id  capability  cost/latency/risk  summary
  const id = `${hit.lab}/${hit.card_id}`;
  const cap = hit.capability;
  const triad = `${hit.cost_class}|${hit.latency_class}|${hit.risk_class}`;
  const flags = [];
  if (hit.deprecated) flags.push("deprecated");
  if (hit.stale) flags.push("stale");
  const flagStr = flags.length ? ` [${flags.join(",")}]` : "";
  const summary = _truncate(_sanitize(hit.summary || ""), 100);
  return `- ${id}  cap=${cap}  ${triad}${flagStr}  — ${summary}`;
}

function _renderQueryEcho(q) {
  if (!q) return "";
  const parts = [];
  if (q.query) parts.push(`q="${_truncate(_sanitize(q.query), 60)}"`);
  if (q.lab) parts.push(`lab=${_renderEnum(q.lab)}`);
  if (q.capability) parts.push(`capability=${q.capability}`);
  if (q.cost_class) parts.push(`cost=${_renderEnum(q.cost_class)}`);
  if (q.latency_class) parts.push(`latency=${_renderEnum(q.latency_class)}`);
  if (q.risk_class) parts.push(`risk=${_renderEnum(q.risk_class)}`);
  if (q.vendor) parts.push(`vendor=${q.vendor}`);
  if (q.tags?.length) parts.push(`tags=${q.tags.join(",")}`);
  return parts.join(" ");
}

function _renderEnum(v) {
  return Array.isArray(v) ? v.join("|") : v;
}

function _truncate(s, max) {
  if (!s) return "";
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function _sanitize(s) {
  // Strip newlines and the closing fence so a malformed summary cannot
  // break out of the [TOOLMESH:...] block. Defense in depth.
  return String(s).replace(/[\r\n]+/g, " ").replace(/\[END:TOOLMESH\]/gi, "[END·TOOLMESH]");
}

// ─────────────────────────────────────────────────────────────────────────────
// Intent extractor — parseConsultIntent(text)
// ─────────────────────────────────────────────────────────────────────────────
//
// Scans free text for <toolmesh-consult> tags, mirroring the <recall>
// pattern used by memory-inject. Returns a single ConsultSpec or null.
// When multiple tags appear, we merge them: filters union, query
// concatenates (deduped tokens), limit takes the max.

export function parseConsultIntent(text) {
  if (typeof text !== "string" || text.length === 0) return null;

  const matches = [...text.matchAll(CONSULT_TAG_RX)];
  if (matches.length === 0) return null;

  const merged = {
    queryTokens: new Set(),
    labs: new Set(),
    capabilities: new Set(),
    costs: new Set(),
    latencies: new Set(),
    risks: new Set(),
    vendors: new Set(),
    tags: new Set(),
    limit: 0,
  };

  for (const m of matches) {
    const attrBlob = m[1] || "";
    const inner = (m[2] || "").trim();

    if (inner) {
      for (const tok of inner.split(/\s+/)) {
        if (tok.length >= 2) merged.queryTokens.add(tok.toLowerCase());
      }
    }

    for (const a of attrBlob.matchAll(CONSULT_ATTR_RX)) {
      const key = a[1].toLowerCase();
      const val = a[2];
      switch (key) {
        case "lab":
          if (LAB_IDS.includes(val)) merged.labs.add(val);
          break;
        case "capability":
          if (val.length > 0) merged.capabilities.add(val);
          break;
        case "cost":
        case "cost_class":
          if (COST_CLASSES.includes(val)) merged.costs.add(val);
          break;
        case "latency":
        case "latency_class":
          if (LATENCY_CLASSES.includes(val)) merged.latencies.add(val);
          break;
        case "risk":
        case "risk_class":
          if (RISK_CLASSES.includes(val)) merged.risks.add(val);
          break;
        case "vendor":
          if (val.length > 0) merged.vendors.add(val);
          break;
        case "tag":
        case "tags":
          for (const t of val.split(",")) {
            const trimmed = t.trim();
            if (trimmed.length > 0) merged.tags.add(trimmed);
          }
          break;
        case "limit": {
          const n = Number.parseInt(val, 10);
          if (Number.isInteger(n) && n > 0) {
            merged.limit = Math.max(merged.limit, n);
          }
          break;
        }
        default:
          // Unknown attribute — ignored on purpose. Mom's Law: don't
          // hallucinate behavior for tags we have not specified.
          break;
      }
    }
  }

  const spec = {};
  if (merged.queryTokens.size) spec.query = [...merged.queryTokens].join(" ");
  if (merged.labs.size === 1) spec.lab = [...merged.labs][0];
  else if (merged.labs.size > 1) spec.lab = [...merged.labs];
  if (merged.capabilities.size === 1) spec.capability = [...merged.capabilities][0];
  // capabilities don't union in searchCards — pick the most specific
  // (longest) when multiple are given.
  else if (merged.capabilities.size > 1) {
    spec.capability = [...merged.capabilities].sort((a, b) => b.length - a.length)[0];
  }
  if (merged.costs.size === 1) spec.cost_class = [...merged.costs][0];
  else if (merged.costs.size > 1) spec.cost_class = [...merged.costs];
  if (merged.latencies.size === 1) spec.latency_class = [...merged.latencies][0];
  else if (merged.latencies.size > 1) spec.latency_class = [...merged.latencies];
  if (merged.risks.size === 1) spec.risk_class = [...merged.risks][0];
  else if (merged.risks.size > 1) spec.risk_class = [...merged.risks];
  if (merged.vendors.size === 1) spec.vendor = [...merged.vendors][0];
  if (merged.tags.size) spec.tags = [...merged.tags];
  if (merged.limit > 0) spec.limit = Math.min(merged.limit, MAX_LIMIT);

  return spec;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test surface
// ─────────────────────────────────────────────────────────────────────────────

export const __consultInternals = Object.freeze({
  COST_CLASSES,
  LATENCY_CLASSES,
  RISK_CLASSES,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  DEFAULT_STALE_AFTER_MS,
  SCHEMA_VERSION,
  _normalizeSpec,
  _scoreCard,
  _rankAndSlice,
  _shapeHit,
  _renderHit,
  _renderQueryEcho,
  _resetRegistryForTests,
  CONSULT_TAG_RX,
});
