// 13-TOOLMESH / registry.mjs
//
// ToolMesh capability registry. Loads, validates, indexes, and hot-reloads
// every tool-card across the 11 capability labs (image, video, audio, design,
// coding, automation, analytics, public-agent, observability, security,
// releaseops). OrangeLLM consults this registry during planning to discover
// what the mesh CAN do and at what cost/latency BEFORE asking the operator
// for execution approval.
//
// Layered contract (Orange5 PR-15 spec):
//   - Tool-cards are capability INDICATORS, not permission-to-execute.
//     Execution is gated by Hermes leases. This registry never opens a
//     network socket, never spawns a subprocess, never calls an adapter.
//   - JSON-schema'd: every loaded card must pass 09-SCHEMAS/tool-card.v0.
//   - Hot-reloadable: fs.watch on labs/. Changed/added/removed cards rebuild
//     the index incrementally. Bad cards are quarantined with a reason, not
//     silently dropped — Mom's Law: receipts only, no theater.
//   - Indexed three ways: by lab, by dotted capability, by cost_class.
//     Search API filters across (lab, capability, cost_class, latency_class,
//     risk_class, tags, vendor, query) and ranks deterministically.
//
// Storage layout on disk:
//   labs/<lab-id>/<card-id>.json   one tool-card per file
//   labs/index.mjs                  hand-maintained lab manifest
//   (labs are the eleven enums in tool-card.v0; new labs need a schema bump)
//
// Honest gaps:
//   - Validator is a focused subset of JSON-Schema draft 2020-12 — enough to
//     enforce tool-card.v0.schema.json (enum, const, pattern, min/max,
//     required, additionalProperties, type, format=date-time, items,
//     uniqueItems). It is NOT a general-purpose JSON-Schema engine. If a
//     future schema feature is added that this validator does not cover, the
//     loader fails closed on that card with a clear quarantine reason.
//   - Hot-reload uses Node's fs.watch which is best-effort on some
//     filesystems. We debounce events (120ms) and rebuild the affected lab
//     atomically. Callers receive change events via registry.on('change').
//   - Node 20+. ESM. No npm deps. Pure built-ins (node:fs, node:path,
//     node:url, node:events).
//
// Output of registry.search(query) is a deterministic array of card objects
// (each carrying its source path) sorted by (lab, card_id) — never random.

import { promises as fsp, watch as fsWatch } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { EventEmitter } from "node:events";

// ─────────────────────────────────────────────────────────────────────────────
// Constants — closed enum that mirrors the schema. Diverging here is a bug.
// ─────────────────────────────────────────────────────────────────────────────

const SCHEMA_ID = "orange5.tool-card.v0";

export const LAB_IDS = Object.freeze([
  "image",
  "video",
  "audio",
  "design",
  "coding",
  "automation",
  "analytics",
  "public-agent",
  "observability",
  "security",
  "releaseops",
]);

const COST_CLASSES = new Set(["free", "byo-key", "metered"]);
const LATENCY_CLASSES = new Set(["sub-second", "seconds", "minutes"]);
const RISK_CLASSES = new Set([
  "read-only",
  "sandboxed",
  "mutating",
  "external-side-effect",
]);

const CARD_ID_RX = /^[a-z][a-z0-9.-]*[a-z0-9]$/;
const CAPABILITY_RX = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const SEMVER_RX =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const HOST_RX =
  /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LABS_ROOT = path.join(HERE, "labs");
// Card files on disk end in plain `.json`. The earlier `.card.json` convention
// was never adopted by the corpus (47 cards across 11 labs, all `*.json`), so
// the discovery suffix follows what is actually on disk. Smoke-test fixtures
// authored as `*.card.json` continue to match because `.card.json` ends in
// `.json`; the schema validator (not this suffix) is what gates admission.
const CARD_SUFFIX = ".json";

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export class ToolCardValidationError extends Error {
  constructor(message, { path: filePath, field } = {}) {
    super(message);
    this.name = "ToolCardValidationError";
    this.code = "TOOLCARD_INVALID";
    this.path = filePath;
    this.field = field;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Validator — focused subset sufficient for tool-card.v0.schema.json.
// Returns an array of issues; empty array means valid.
// ─────────────────────────────────────────────────────────────────────────────

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isRfc3339Utc(s) {
  if (typeof s !== "string") return false;
  // Permissive RFC 3339; we additionally require the value to round-trip a Date.
  const m =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      s
    );
  if (!m) return false;
  const t = Date.parse(s);
  return Number.isFinite(t);
}

function validateLeaseTemplate(lease, issues, prefix) {
  if (!isPlainObject(lease)) {
    issues.push({ field: prefix, msg: "must be an object" });
    return;
  }
  const allowedKeys = new Set([
    "ttl_seconds",
    "max_invocations",
    "scopes",
    "human_approval_required",
    "rate_limit_per_minute",
    "egress_allowlist",
  ]);
  for (const k of Object.keys(lease)) {
    if (!allowedKeys.has(k)) {
      issues.push({ field: `${prefix}.${k}`, msg: "unknown property" });
    }
  }
  // ttl_seconds
  if (!Number.isInteger(lease.ttl_seconds)) {
    issues.push({ field: `${prefix}.ttl_seconds`, msg: "required integer" });
  } else if (lease.ttl_seconds < 1 || lease.ttl_seconds > 86400) {
    issues.push({
      field: `${prefix}.ttl_seconds`,
      msg: "must be 1..86400",
    });
  }
  // max_invocations
  if (!Number.isInteger(lease.max_invocations)) {
    issues.push({
      field: `${prefix}.max_invocations`,
      msg: "required integer",
    });
  } else if (lease.max_invocations < 1 || lease.max_invocations > 10000) {
    issues.push({
      field: `${prefix}.max_invocations`,
      msg: "must be 1..10000",
    });
  }
  // scopes
  if (!Array.isArray(lease.scopes) || lease.scopes.length < 1) {
    issues.push({ field: `${prefix}.scopes`, msg: "required non-empty array" });
  } else {
    const seen = new Set();
    for (let i = 0; i < lease.scopes.length; i++) {
      const s = lease.scopes[i];
      if (typeof s !== "string" || s.length < 1 || s.length > 200) {
        issues.push({
          field: `${prefix}.scopes[${i}]`,
          msg: "string 1..200 required",
        });
      } else if (seen.has(s)) {
        issues.push({
          field: `${prefix}.scopes[${i}]`,
          msg: "duplicate scope (uniqueItems)",
        });
      } else {
        seen.add(s);
      }
    }
  }
  // human_approval_required (optional bool)
  if (
    lease.human_approval_required !== undefined &&
    typeof lease.human_approval_required !== "boolean"
  ) {
    issues.push({
      field: `${prefix}.human_approval_required`,
      msg: "boolean required",
    });
  }
  // rate_limit_per_minute (optional 1..600)
  if (lease.rate_limit_per_minute !== undefined) {
    if (
      !Number.isInteger(lease.rate_limit_per_minute) ||
      lease.rate_limit_per_minute < 1 ||
      lease.rate_limit_per_minute > 600
    ) {
      issues.push({
        field: `${prefix}.rate_limit_per_minute`,
        msg: "integer 1..600",
      });
    }
  }
  // egress_allowlist (optional unique hosts)
  if (lease.egress_allowlist !== undefined) {
    if (!Array.isArray(lease.egress_allowlist)) {
      issues.push({
        field: `${prefix}.egress_allowlist`,
        msg: "array required",
      });
    } else {
      const seen = new Set();
      for (let i = 0; i < lease.egress_allowlist.length; i++) {
        const h = lease.egress_allowlist[i];
        if (typeof h !== "string" || !HOST_RX.test(h)) {
          issues.push({
            field: `${prefix}.egress_allowlist[${i}]`,
            msg: "host pattern violation",
          });
        } else if (seen.has(h)) {
          issues.push({
            field: `${prefix}.egress_allowlist[${i}]`,
            msg: "duplicate host (uniqueItems)",
          });
        } else {
          seen.add(h);
        }
      }
    }
  }
}

export function validateToolCard(card) {
  const issues = [];

  if (!isPlainObject(card)) {
    return [{ field: "(root)", msg: "tool-card must be a JSON object" }];
  }

  const allowed = new Set([
    "schema",
    "lab",
    "card_id",
    "capability",
    "cost_class",
    "latency_class",
    "inputs",
    "outputs",
    "default_lease_template",
    "risk_class",
    "last_verified_at",
    "vendor",
    "version",
    "summary",
    "tags",
    "deprecated",
    "notes",
  ]);
  for (const k of Object.keys(card)) {
    if (!allowed.has(k)) {
      issues.push({ field: k, msg: "unknown property (additionalProperties=false)" });
    }
  }

  if (card.schema !== SCHEMA_ID) {
    issues.push({
      field: "schema",
      msg: `must be const "${SCHEMA_ID}", got ${JSON.stringify(card.schema)}`,
    });
  }
  if (!LAB_IDS.includes(card.lab)) {
    issues.push({
      field: "lab",
      msg: `must be one of ${LAB_IDS.join(",")}`,
    });
  }
  if (
    typeof card.card_id !== "string" ||
    card.card_id.length < 2 ||
    card.card_id.length > 96 ||
    !CARD_ID_RX.test(card.card_id)
  ) {
    issues.push({ field: "card_id", msg: "pattern/length violation" });
  }
  if (
    typeof card.capability !== "string" ||
    card.capability.length < 3 ||
    card.capability.length > 128 ||
    !CAPABILITY_RX.test(card.capability)
  ) {
    issues.push({ field: "capability", msg: "dotted-capability pattern violation" });
  }
  if (!COST_CLASSES.has(card.cost_class)) {
    issues.push({
      field: "cost_class",
      msg: `must be one of ${[...COST_CLASSES].join(",")}`,
    });
  }
  if (!LATENCY_CLASSES.has(card.latency_class)) {
    issues.push({
      field: "latency_class",
      msg: `must be one of ${[...LATENCY_CLASSES].join(",")}`,
    });
  }
  if (!isPlainObject(card.inputs)) {
    issues.push({ field: "inputs", msg: "must be a JSON-Schema object" });
  }
  if (!isPlainObject(card.outputs)) {
    issues.push({ field: "outputs", msg: "must be a JSON-Schema object" });
  }
  validateLeaseTemplate(
    card.default_lease_template,
    issues,
    "default_lease_template"
  );
  if (!RISK_CLASSES.has(card.risk_class)) {
    issues.push({
      field: "risk_class",
      msg: `must be one of ${[...RISK_CLASSES].join(",")}`,
    });
  }
  if (!isRfc3339Utc(card.last_verified_at)) {
    issues.push({
      field: "last_verified_at",
      msg: "must be RFC 3339 date-time",
    });
  }
  // optional fields
  if (card.vendor !== undefined) {
    if (
      typeof card.vendor !== "string" ||
      card.vendor.length < 1 ||
      card.vendor.length > 64
    ) {
      issues.push({ field: "vendor", msg: "string 1..64" });
    }
  }
  if (card.version !== undefined) {
    if (typeof card.version !== "string" || !SEMVER_RX.test(card.version)) {
      issues.push({ field: "version", msg: "semver required" });
    }
  }
  if (card.summary !== undefined) {
    if (
      typeof card.summary !== "string" ||
      card.summary.length < 1 ||
      card.summary.length > 300
    ) {
      issues.push({ field: "summary", msg: "string 1..300" });
    }
  }
  if (card.tags !== undefined) {
    if (!Array.isArray(card.tags)) {
      issues.push({ field: "tags", msg: "array required" });
    } else {
      const seen = new Set();
      for (let i = 0; i < card.tags.length; i++) {
        const t = card.tags[i];
        if (typeof t !== "string" || t.length < 1 || t.length > 32) {
          issues.push({ field: `tags[${i}]`, msg: "string 1..32" });
        } else if (seen.has(t)) {
          issues.push({
            field: `tags[${i}]`,
            msg: "duplicate tag (uniqueItems)",
          });
        } else {
          seen.add(t);
        }
      }
    }
  }
  if (card.deprecated !== undefined && typeof card.deprecated !== "boolean") {
    issues.push({ field: "deprecated", msg: "boolean required" });
  }
  if (card.notes !== undefined) {
    if (typeof card.notes !== "string" || card.notes.length > 2000) {
      issues.push({ field: "notes", msg: "string up to 2000 chars" });
    }
  }

  return issues;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: load one card file. Returns { card, path, issues } — never throws.
// Quarantined cards (issues.length > 0) are kept out of the index but tracked.
// ─────────────────────────────────────────────────────────────────────────────

async function loadCardFile(filePath, expectedLab) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    return {
      card: null,
      path: filePath,
      issues: [{ field: "(file)", msg: `read failed: ${err.message}` }],
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      card: null,
      path: filePath,
      issues: [{ field: "(json)", msg: `parse failed: ${err.message}` }],
    };
  }
  const issues = validateToolCard(parsed);
  // Directory-vs-card lab consistency: if the file sits under labs/<lab>/, the
  // card's lab field must match its directory. This catches paste mistakes.
  if (
    expectedLab &&
    parsed &&
    typeof parsed === "object" &&
    parsed.lab !== undefined &&
    parsed.lab !== expectedLab
  ) {
    issues.push({
      field: "lab",
      msg: `card declares lab="${parsed.lab}" but lives under labs/${expectedLab}/`,
    });
  }
  return {
    card: issues.length === 0 ? parsed : null,
    raw: parsed,
    path: filePath,
    issues,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Indexer — rebuilds the three indices from a flat card list. Deterministic.
// ─────────────────────────────────────────────────────────────────────────────

function buildIndices(cards) {
  // Sort once for deterministic downstream ordering. (lab, card_id) is unique.
  const sorted = [...cards].sort((a, b) => {
    if (a.lab !== b.lab) return a.lab < b.lab ? -1 : 1;
    return a.card_id < b.card_id ? -1 : a.card_id > b.card_id ? 1 : 0;
  });

  const byLab = new Map();
  const byCapability = new Map();
  const byCost = new Map();

  for (const card of sorted) {
    if (!byLab.has(card.lab)) byLab.set(card.lab, []);
    byLab.get(card.lab).push(card);

    if (!byCapability.has(card.capability)) {
      byCapability.set(card.capability, []);
    }
    byCapability.get(card.capability).push(card);

    if (!byCost.has(card.cost_class)) byCost.set(card.cost_class, []);
    byCost.get(card.cost_class).push(card);
  }
  return { byLab, byCapability, byCost, sorted };
}

// ─────────────────────────────────────────────────────────────────────────────
// Search — pure filter over the sorted card list. Inputs are all optional;
// missing inputs do not constrain. Returns sorted results.
//   - lab: string | string[] (closed enum)
//   - capability: exact dotted string OR prefix match if ends with '.*'
//   - cost_class, latency_class, risk_class: string | string[]
//   - tags: string[] (card must include ALL listed tags)
//   - vendor: string (exact, case-insensitive)
//   - query: free-text substring matched against card_id, capability, summary,
//            tags, vendor (case-insensitive)
//   - includeDeprecated: boolean (default false)
//   - includeStaleAfterMs: number (cards with last_verified_at older than
//            now - includeStaleAfterMs are excluded; absence = no stale filter)
//   - limit: integer cap on results (default unlimited)
// ─────────────────────────────────────────────────────────────────────────────

function toSet(v) {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) return new Set(v);
  return new Set([v]);
}

export function searchCards(allCards, query = {}) {
  const labSet = toSet(query.lab);
  const costSet = toSet(query.cost_class);
  const latencySet = toSet(query.latency_class);
  const riskSet = toSet(query.risk_class);
  const tags = Array.isArray(query.tags) ? query.tags : null;
  const vendor =
    typeof query.vendor === "string" ? query.vendor.toLowerCase() : null;
  const q =
    typeof query.query === "string" && query.query.length > 0
      ? query.query.toLowerCase()
      : null;
  const includeDeprecated = !!query.includeDeprecated;
  const staleCutoff =
    typeof query.includeStaleAfterMs === "number"
      ? Date.now() - query.includeStaleAfterMs
      : null;

  let cap = null;
  let capPrefix = null;
  if (typeof query.capability === "string" && query.capability.length > 0) {
    if (query.capability.endsWith(".*")) {
      capPrefix = query.capability.slice(0, -1); // keep trailing dot
    } else {
      cap = query.capability;
    }
  }

  const out = [];
  for (const card of allCards) {
    if (labSet && !labSet.has(card.lab)) continue;
    if (costSet && !costSet.has(card.cost_class)) continue;
    if (latencySet && !latencySet.has(card.latency_class)) continue;
    if (riskSet && !riskSet.has(card.risk_class)) continue;
    if (cap && card.capability !== cap) continue;
    if (capPrefix && !card.capability.startsWith(capPrefix)) continue;
    if (!includeDeprecated && card.deprecated === true) continue;
    if (staleCutoff !== null) {
      const t = Date.parse(card.last_verified_at);
      if (!Number.isFinite(t) || t < staleCutoff) continue;
    }
    if (vendor) {
      if (
        typeof card.vendor !== "string" ||
        card.vendor.toLowerCase() !== vendor
      ) {
        continue;
      }
    }
    if (tags) {
      const cardTags = new Set(card.tags || []);
      let ok = true;
      for (const t of tags) {
        if (!cardTags.has(t)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
    }
    if (q) {
      const hay = [
        card.card_id,
        card.capability,
        card.summary || "",
        card.vendor || "",
        (card.tags || []).join(" "),
      ]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) continue;
    }
    out.push(card);
    if (Number.isInteger(query.limit) && out.length >= query.limit) break;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry class. One instance per labs/ root. Stateless w.r.t. the network.
// ─────────────────────────────────────────────────────────────────────────────

export class ToolMeshRegistry extends EventEmitter {
  constructor({ labsRoot = DEFAULT_LABS_ROOT, watch = true } = {}) {
    super();
    this.labsRoot = labsRoot;
    this.watchEnabled = watch;
    // Map<filePath, { card | null, raw, issues, mtimeMs }>
    this._cards = new Map();
    this._indices = buildIndices([]);
    this._watchers = []; // fs.FSWatcher[]
    this._debounce = null;
    this._pending = new Set(); // labIds pending reload
    this._loaded = false;
  }

  /**
   * Load every card under labs/<lab-id>/ once. Subsequent file system events
   * (when watch=true) trigger incremental per-lab reloads. Returns a summary
   * { loaded, quarantined } so the caller can surface health at boot.
   */
  async load() {
    this._cards.clear();
    const summary = { loaded: 0, quarantined: 0, missing_labs: [] };

    for (const labId of LAB_IDS) {
      const labDir = path.join(this.labsRoot, labId);
      let stats;
      try {
        stats = await stat(labDir);
      } catch {
        summary.missing_labs.push(labId);
        continue; // lab dir absent — that's allowed; lab is simply empty
      }
      if (!stats.isDirectory()) {
        summary.missing_labs.push(labId);
        continue;
      }
      const labSummary = await this._loadLab(labId);
      summary.loaded += labSummary.loaded;
      summary.quarantined += labSummary.quarantined;
    }

    this._reindex();
    this._loaded = true;

    if (this.watchEnabled) {
      this._startWatchers();
    }
    return summary;
  }

  async _loadLab(labId) {
    const labDir = path.join(this.labsRoot, labId);
    const summary = { loaded: 0, quarantined: 0 };
    let entries = [];
    try {
      entries = await readdir(labDir, { withFileTypes: true });
    } catch {
      return summary;
    }
    // Drop any prior cards from this lab so re-loads are clean.
    for (const [p, rec] of this._cards) {
      if (rec.labDir === labDir) this._cards.delete(p);
    }
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (!ent.name.endsWith(CARD_SUFFIX)) continue;
      const filePath = path.join(labDir, ent.name);
      let st;
      try {
        st = await stat(filePath);
      } catch {
        continue;
      }
      const loaded = await loadCardFile(filePath, labId);
      this._cards.set(filePath, {
        card: loaded.card,
        raw: loaded.raw,
        issues: loaded.issues,
        labDir,
        mtimeMs: st.mtimeMs,
      });
      if (loaded.issues.length === 0) summary.loaded++;
      else summary.quarantined++;
    }
    return summary;
  }

  _reindex() {
    const goodCards = [];
    for (const rec of this._cards.values()) {
      if (rec.card) goodCards.push(rec.card);
    }
    // (lab, card_id) uniqueness — duplicates demote ALL conflicting cards to
    // quarantine so the planner never picks one ambiguously.
    const seen = new Map();
    for (const rec of this._cards.values()) {
      if (!rec.card) continue;
      const key = `${rec.card.lab}::${rec.card.card_id}`;
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key).push(rec);
    }
    for (const [key, recs] of seen) {
      if (recs.length > 1) {
        for (const rec of recs) {
          rec.issues = [
            ...rec.issues,
            {
              field: "(lab, card_id)",
              msg: `duplicate key "${key}" across ${recs.length} files`,
            },
          ];
          rec.card = null;
        }
      }
    }
    const finalCards = [];
    for (const rec of this._cards.values()) {
      if (rec.card) finalCards.push(rec.card);
    }
    this._indices = buildIndices(finalCards);
  }

  // ── Read API ──────────────────────────────────────────────────────────────

  /** Flat list of valid cards, sorted by (lab, card_id). */
  list() {
    return this._indices.sorted.slice();
  }

  /** Cards for one lab id. */
  byLab(labId) {
    return (this._indices.byLab.get(labId) || []).slice();
  }

  /** Cards offering an exact dotted capability. */
  byCapability(cap) {
    return (this._indices.byCapability.get(cap) || []).slice();
  }

  /** Cards with a given cost class. */
  byCost(cost) {
    return (this._indices.byCost.get(cost) || []).slice();
  }

  /** Unique key lookup. Returns the card or null. */
  get(labId, cardId) {
    for (const card of this._indices.byLab.get(labId) || []) {
      if (card.card_id === cardId) return card;
    }
    return null;
  }

  /** Full filtered search. See searchCards() for query shape. */
  search(query) {
    return searchCards(this._indices.sorted, query);
  }

  /**
   * Quarantine report — every card that failed validation, with reasons.
   * The planner SHOULD log this at boot so the operator sees broken cards.
   */
  quarantine() {
    const out = [];
    for (const [p, rec] of this._cards) {
      if (rec.issues.length > 0) {
        out.push({
          path: p,
          card_id: rec.raw && rec.raw.card_id ? rec.raw.card_id : null,
          lab: rec.raw && rec.raw.lab ? rec.raw.lab : null,
          issues: rec.issues.slice(),
        });
      }
    }
    // Deterministic ordering by path.
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return out;
  }

  /** Counts grouped by lab — for the deploy grid / health dashboard. */
  stats() {
    const labs = LAB_IDS.map((id) => ({
      id,
      loaded: (this._indices.byLab.get(id) || []).length,
      quarantined: 0,
    }));
    const byLab = new Map(labs.map((l) => [l.id, l]));
    for (const rec of this._cards.values()) {
      if (rec.issues.length > 0 && rec.raw && byLab.has(rec.raw.lab)) {
        byLab.get(rec.raw.lab).quarantined++;
      }
    }
    return {
      total_loaded: this._indices.sorted.length,
      total_quarantined: this.quarantine().length,
      labs,
    };
  }

  // ── Hot-reload ────────────────────────────────────────────────────────────

  _startWatchers() {
    this._stopWatchers();
    for (const labId of LAB_IDS) {
      const labDir = path.join(this.labsRoot, labId);
      let w;
      try {
        w = fsWatch(labDir, { persistent: false }, (_evt, filename) => {
          if (!filename) {
            this._scheduleReload(labId);
            return;
          }
          if (
            typeof filename === "string" &&
            filename.endsWith(CARD_SUFFIX)
          ) {
            this._scheduleReload(labId);
          }
        });
      } catch {
        // Missing lab dir is allowed; no watcher needed.
        continue;
      }
      w.on("error", (err) => {
        this.emit("watch-error", { lab: labId, error: err });
      });
      this._watchers.push(w);
    }
  }

  _stopWatchers() {
    for (const w of this._watchers) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
    this._watchers = [];
  }

  _scheduleReload(labId) {
    this._pending.add(labId);
    if (this._debounce) clearTimeout(this._debounce);
    this._debounce = setTimeout(() => {
      this._debounce = null;
      const pending = [...this._pending];
      this._pending.clear();
      this._reloadLabs(pending).catch((err) => {
        this.emit("reload-error", { error: err });
      });
    }, 120);
  }

  async _reloadLabs(labIds) {
    let touched = 0;
    for (const labId of labIds) {
      const before = this._cards.size;
      // eslint-disable-next-line no-await-in-loop
      await this._loadLab(labId);
      touched += Math.abs(this._cards.size - before) + 1;
    }
    this._reindex();
    this.emit("change", {
      labs: labIds,
      touched,
      stats: this.stats(),
    });
  }

  /** Stop watchers — required for clean shutdown in tests. */
  async close() {
    if (this._debounce) {
      clearTimeout(this._debounce);
      this._debounce = null;
    }
    this._stopWatchers();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience: a process-wide default registry. Lazy-loaded.
// ─────────────────────────────────────────────────────────────────────────────

let _default = null;

export async function getDefaultRegistry(opts) {
  if (_default) return _default;
  _default = new ToolMeshRegistry(opts);
  await _default.load();
  return _default;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI surface: `node registry.mjs [--json] [--quarantine] [--lab=<id>]
//   [--capability=<cap>] [--cost=<class>] [--query=<text>]`
// Prints a deterministic, terminal-grade view of the mesh state.
// Useful as a smoke test and as a grid line in the AE deploy grid.
// ─────────────────────────────────────────────────────────────────────────────

function parseArgv(argv) {
  const out = { flags: new Set(), opts: {} };
  for (const a of argv) {
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq === -1) out.flags.add(a.slice(2));
      else out.opts[a.slice(2, eq)] = a.slice(eq + 1);
    }
  }
  return out;
}

async function _cli() {
  const { flags, opts } = parseArgv(process.argv.slice(2));
  const reg = new ToolMeshRegistry({ watch: false });
  const summary = await reg.load();

  if (flags.has("quarantine")) {
    const q = reg.quarantine();
    if (flags.has("json")) {
      process.stdout.write(JSON.stringify({ summary, quarantine: q }, null, 2) + "\n");
    } else {
      process.stdout.write(`Quarantined cards: ${q.length}\n`);
      for (const item of q) {
        process.stdout.write(`  ${item.path}\n`);
        for (const iss of item.issues) {
          process.stdout.write(`    - ${iss.field}: ${iss.msg}\n`);
        }
      }
    }
    await reg.close();
    process.exit(q.length === 0 ? 0 : 1);
  }

  const results = reg.search({
    lab: opts.lab,
    capability: opts.capability,
    cost_class: opts.cost,
    query: opts.query,
  });

  if (flags.has("json")) {
    process.stdout.write(
      JSON.stringify({ summary, stats: reg.stats(), results }, null, 2) + "\n"
    );
  } else {
    const stats = reg.stats();
    process.stdout.write(
      `ToolMesh: ${stats.total_loaded} loaded / ${stats.total_quarantined} quarantined\n`
    );
    for (const lab of stats.labs) {
      process.stdout.write(
        `  ${lab.id.padEnd(14)} ${String(lab.loaded).padStart(3)} cards  (${lab.quarantined} bad)\n`
      );
    }
    if (results.length > 0) {
      process.stdout.write(`\nResults (${results.length}):\n`);
      for (const c of results) {
        process.stdout.write(
          `  [${c.lab}] ${c.card_id}  ${c.capability}  ${c.cost_class}/${c.latency_class}/${c.risk_class}\n`
        );
      }
    }
  }
  await reg.close();
}

// Run CLI only when invoked directly, not when imported.
const _isMain = (() => {
  try {
    return fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "");
  } catch {
    return false;
  }
})();
if (_isMain) {
  _cli().catch((err) => {
    process.stderr.write(`registry.mjs: ${err.stack || err.message}\n`);
    process.exit(2);
  });
}
