// AE OrangeLLM — Mirage memory auto-inject middleware
// Path: 06-ORANGELLM/server/middleware/memory-inject.mjs
//
// Doctrine (Option C hybrid):
//   1. Every POST /v1/chat/completions through the OrangeLLM gateway gets a
//      "recent context" StateBrief injected as the FIRST system message.
//      query='', max_records=8 — small, fast, always-on tap on the memory plane.
//
//   2. Any <recall>{query}</recall> tag found in user message text triggers a
//      deeper StateBrief (operator defaults: 24 records / 72h window via the
//      /recall route). Each deep-recall result is also prepended as a separate
//      [MEMORY:RECALLED]…[END:RECALLED] system message so the model can tell
//      them apart.
//
//   3. Mirage law travels with the injection:
//        - Reality > Thought on conflict
//        - Receipts > recollection
//        - Æ Cobra Flux is the source; N150 shadow cache is the degraded
//          fallback (the StateBrief route handles that fall-through itself, so
//          this middleware just trusts whatever the route returns and forwards
//          the `degraded`/`served_by` fields downstream via a response header).
//
//   4. The middleware NEVER swallows the request on memory failure. If Cobra
//      and the N150 shadow are both down, we inject a tombstone system message
//      that says so honestly and let the completion proceed. Better a candid
//      "memory plane down" note than silent amnesia.
//
//   5. Mom's Law: every request gets the best memory slice we can give it at
//      that moment. No "this one's small, skip it." No theater.
//
// Exports:
//   memoryInjectMiddleware(opts)
//     - Express/Hono-style middleware. Signature: async (req, res, next).
//     - opts: {
//         memoryStateBriefUrl?:  string   // default http://127.0.0.1:1337/v1/memory/state-brief
//         memoryRecallUrl?:      string   // default http://127.0.0.1:1337/v1/memory/recall
//         recentMaxRecords?:     number   // default 8     (the auto-tap)
//         deepMaxRecords?:       number   // default 24    (the <recall> tap)
//         recentTimeoutMs?:      number   // default 1500
//         deepTimeoutMs?:        number   // default 2500
//         path?:                 string   // default /v1/chat/completions
//         method?:               string   // default POST
//         log?:                  (line) => void
//         injectHeader?:         string   // default X-Memory-Injected-Bytes
//         degradedHeader?:       string   // default X-Memory-Source
//         maxRecallTags?:        number   // default 4 (deeper-recall fan-out cap)
//         enabled?:              boolean  // default true (false = passthrough)
//       }
//
//   buildMemorySystemMessage(stateBrief, kind)
//     - Pure formatter, exported for the unit test surface.
//
//   __memoryInjectInternals
//     - Test surface: scanRecallTags, fetchStateBrief, runInjection.
//
// Wire from the gateway:
//   import { memoryInjectMiddleware } from "./middleware/memory-inject.mjs";
//   const mwMemory = memoryInjectMiddleware({ log: console.log });
//   // For the raw node:http server in index.mjs, see runInjection below — it
//   // takes a parsed body and returns the mutated body + byte count, which is
//   // the adapter shape index.mjs needs without forcing an Express dep.

import { URL } from "node:url";
import { compressWorkset } from "../../../12-ATOMSMASHER/sparse-worksets/compressor.mjs";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_STATE_BRIEF_URL = "http://127.0.0.1:1337/v1/memory/state-brief";
const DEFAULT_RECALL_URL      = "http://127.0.0.1:1337/v1/memory/recall";
const DEFAULT_RECENT_MAX      = 4;
const DEFAULT_DEEP_MAX        = 12;
const DEFAULT_RECENT_TIMEOUT  = 1500;
const DEFAULT_DEEP_TIMEOUT    = 2500;
const DEFAULT_RECENT_BYTES    = 1800;
const DEFAULT_DEEP_BYTES      = 3600;
const DEFAULT_PATH            = "/v1/chat/completions";
const DEFAULT_METHOD          = "POST";
const DEFAULT_INJECT_HEADER   = "X-Memory-Injected-Bytes";
const DEFAULT_SOURCE_HEADER   = "X-Memory-Source";
const DEFAULT_MAX_RECALL_TAGS = 4;

// <recall>…</recall> tag scanner. The body is intentionally non-greedy and
// case-insensitive. Anchored to a single line by default; the /s flag lets
// the query span newlines because Sovereign sometimes pastes multi-line
// queries between the tags.
const RECALL_TAG_RE = /<recall>([\s\S]*?)<\/recall>/gi;

// Hard cap on the recall query length to keep StateBrief payloads sane. The
// /v1/memory/state-brief route also clamps to 4096; we mirror it here so the
// truncation is visible at the middleware boundary.
const RECALL_QUERY_MAX_CHARS = 4096;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function defaultLog(line) {
  // eslint-disable-next-line no-console
  console.log(line);
}

function byteLength(s) {
  if (typeof s !== "string") return 0;
  return Buffer.byteLength(s, "utf8");
}

function clampString(s, max) {
  if (typeof s !== "string") return "";
  if (s.length <= max) return s;
  return s.slice(0, max);
}

function latestUserQuery(messages) {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const text = typeof message.content === "string"
      ? message.content
      : (Array.isArray(message.content)
        ? message.content.map((part) => part?.text || "").join(" ")
        : "");
    RECALL_TAG_RE.lastIndex = 0;
    return clampString(text.replace(RECALL_TAG_RE, " ").replace(/\s+/g, " ").trim(), 512);
  }
  return "";
}

function memoryRecordLine(record) {
  const pointer = record?.source_pointer?.hash || record?.receipt_id || record?.id || "unknown";
  const lane = record?.lane === "reality" ? "R" : (record?.lane === "thought" ? "T" : "M");
  const summary = clampString(String(record?.summary || record?.content || "record"), 240);
  const next = record?.next_action ? ` | next=${clampString(String(record.next_action), 120)}` : "";
  const risk = record?.risk ? ` risk=${record.risk}` : "";
  const confidence = Number.isFinite(record?.confidence) ? ` c=${Number(record.confidence).toFixed(2)}` : "";
  return `${lane}:${record?.kind || "memory"}${risk}${confidence} | ${summary}${next} | src=${pointer}`;
}

function buildMemoryHotFrame(stateBrief, { query = "", maxRecords = DEFAULT_RECENT_MAX, byteBudget = DEFAULT_RECENT_BYTES } = {}) {
  const records = [
    ...(Array.isArray(stateBrief?.reality) ? stateBrief.reality : []),
    ...(Array.isArray(stateBrief?.thought) ? stateBrief.thought : []),
    ...(Array.isArray(stateBrief?.records) ? stateBrief.records : []),
  ]
    .filter((record) => record && typeof record === "object")
    .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0))
    .slice(-Math.max(0, maxRecords));
  const task = query || "recent OrangeFive runtime state";
  const context = records.map((record, index) => {
    const content = memoryRecordLine(record);
    return {
      id: String(record.id || record?.source_pointer?.hash || `memory_${index}`),
      content,
      tag: record.lane || "memory",
      size: byteLength(content),
      score_hint: query ? 0 : Math.min(0.4, ((index + 1) / Math.max(1, records.length)) * 0.4),
    };
  });
  let workset;
  try {
    workset = compressWorkset({ task, context }, { keepThreshold: query ? 0.01 : 0, budget: byteBudget });
  } catch (error) {
    workset = {
      workset_id: "unavailable",
      working_set: [],
      dropped: context.map((item) => ({ id: item.id, reason: `compressor_error:${error.message}`, score: 0 })),
      warnings: [error.message],
      stats: {
        input_items: context.length,
        kept_items: 0,
        dropped_items: context.length,
        input_bytes: context.reduce((sum, item) => sum + item.size, 0),
        kept_bytes: 0,
      },
    };
  }
  const header = [
    "AIR:MEMORY.v1",
    `src=${stateBrief?.served_by || stateBrief?.source || "unknown"}`,
    `ws=${workset.workset_id}`,
    `kept=${workset.stats.kept_items}/${workset.stats.input_items}`,
    `q=${JSON.stringify(clampString(query, 120))}`,
  ].join(" ");
  const conflicts = (Array.isArray(stateBrief?.conflicts) ? stateBrief.conflicts : []).slice(0, 2)
    .map((conflict) => `X:reality_wins | ${clampString(conflict.reality_summary || "conflict", 160)} | src=${conflict.reality_id || "unknown"}`);
  const text = [header, ...workset.working_set.map((item) => item.content), ...conflicts].join("\n");
  const rawBytes = byteLength(JSON.stringify(stateBrief || {}));
  const hotBytes = byteLength(text);
  return {
    text,
    worksetId: workset.workset_id,
    rawBytes,
    hotBytes,
    savedBytes: Math.max(0, rawBytes - hotBytes),
    inputItems: workset.stats.input_items,
    keptItems: workset.stats.kept_items,
    droppedItems: workset.stats.dropped_items,
    warnings: workset.warnings || [],
  };
}

// fetch() + AbortController timeout, matching the routes/memory.mjs pattern.
async function fetchWithTimeout(url, init = {}, timeoutMs = DEFAULT_RECENT_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Recall-tag scanning
// ---------------------------------------------------------------------------

/**
 * Walk an OpenAI-style messages array and return every <recall>…</recall>
 * query found in user-role messages, in order, deduplicated, capped at
 * `max` entries. Assistant/system/tool messages are ignored — only the
 * Sovereign's prompts can trigger a deep recall.
 *
 * Supports both string content and the array-of-parts content shape that
 * OpenAI clients increasingly use (e.g. {type:"text", text:"…"}).
 */
function scanRecallTags(messages, max = DEFAULT_MAX_RECALL_TAGS) {
  if (!Array.isArray(messages)) return [];
  const seen = new Set();
  const out = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    if (msg.role !== "user") continue;

    const texts = [];
    if (typeof msg.content === "string") {
      texts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part && typeof part === "object" && typeof part.text === "string") {
          texts.push(part.text);
        }
      }
    }

    for (const text of texts) {
      RECALL_TAG_RE.lastIndex = 0;
      let m;
      while ((m = RECALL_TAG_RE.exec(text)) !== null) {
        const query = clampString((m[1] || "").trim(), RECALL_QUERY_MAX_CHARS);
        if (!query) continue;
        const key = query.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(query);
        if (out.length >= max) return out;
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// StateBrief fetch
// ---------------------------------------------------------------------------

/**
 * POST {query, max_records} to a memory endpoint. Returns:
 *   { ok: true,  data, latency_ms, source }       on success
 *   { ok: false, error, latency_ms }              on any failure
 *
 * "Source" mirrors the served_by field from the route ("ae_cobra" /
 * "n150_shadow_cache" / "none") so the middleware can surface degradation
 * via response header without inventing its own taxonomy.
 */
async function fetchStateBrief(url, payload, timeoutMs, log) {
  const started = Date.now();
  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      timeoutMs,
    );
    const latency_ms = Date.now() - started;

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      log(`[memory-inject] StateBrief ${url} -> ${res.status} ${text.slice(0, 200)}`);
      return {
        ok: false,
        latency_ms,
        error: `state-brief ${res.status}`,
        body_excerpt: text.slice(0, 512),
      };
    }
    const data = await res.json();
    return {
      ok: true,
      latency_ms,
      data,
      source: (data && data.served_by) || (data && data.source) || "unknown",
      degraded: !!(data && data.degraded),
    };
  } catch (err) {
    const latency_ms = Date.now() - started;
    log(`[memory-inject] StateBrief ${url} threw: ${err.message}`);
    return {
      ok: false,
      latency_ms,
      error: String(err && err.message ? err.message : err),
    };
  }
}

// ---------------------------------------------------------------------------
// System-message formatting
// ---------------------------------------------------------------------------

const MEMORY_PREAMBLE =
  "(this is verified history from Æ Cobra Flux. " +
  "Reality cites > Thought cites. Receipts > recollection.)";

/**
 * Render a memory blob as a [MEMORY:RECALLED]…[END:RECALLED] system message.
 * `kind` is "auto-recent" or "deep-recall:<query>" so the model can tell
 * which lobe the slice came from. We serialize the entire StateBrief JSON so
 * the model gets records, conflicts, lanes, time_range, served_by, and the
 * Sovereign's law all in one shot.
 */
function buildMemorySystemMessage(stateBrief, kind = "auto-recent", queryLabel = "", options = {}) {
  const frame = buildMemoryHotFrame(stateBrief, {
    query: queryLabel,
    maxRecords: options.maxRecords ?? (kind === "auto-recent" ? DEFAULT_RECENT_MAX : DEFAULT_DEEP_MAX),
    byteBudget: options.byteBudget ?? (kind === "auto-recent" ? DEFAULT_RECENT_BYTES : DEFAULT_DEEP_BYTES),
  });

  const header = queryLabel
    ? `[MEMORY:RECALLED kind=${kind} query="${clampString(queryLabel, 256)}"]`
    : `[MEMORY:RECALLED kind=${kind}]`;

  return {
    role: "system",
    content: `${header} ${MEMORY_PREAMBLE}\n${frame.text}\n[END:RECALLED]`,
    _aeCompression: frame,
  };
}

/**
 * Tombstone for the both-planes-down case. We still inject something so the
 * model never silently loses the memory contract — Mom's Law says honest
 * failure beats hidden failure.
 */
function buildTombstoneSystemMessage(kind, reason) {
  const blob = {
    served_by: "none",
    degraded: true,
    notes: [
      "memory plane unreachable",
      reason || "Æ Cobra down and N150 shadow cache absent",
      "no recall data injected for this turn",
    ],
  };
  return {
    role: "system",
    content:
      `[MEMORY:RECALLED kind=${kind} status=unavailable] ${MEMORY_PREAMBLE} ` +
      `${JSON.stringify(blob)} [END:RECALLED]`,
  };
}

// ---------------------------------------------------------------------------
// Core injection (framework-agnostic)
// ---------------------------------------------------------------------------

/**
 * Run the full injection pass against a parsed chat-completions body.
 *
 * Returns: {
 *   body:           mutated body (same reference; messages array replaced),
 *   injectedBytes:  total utf-8 bytes of all memory system messages added,
 *   sources:        ["ae_cobra"|"n150_shadow_cache"|"none"|"error", …],
 *   recallTags:     [{query, ok, source}],
 *   notes:          [string]  // operator-visible explanations
 * }
 *
 * On any internal error this still returns a sensible shape — it never
 * throws into the caller's request path.
 */
async function runInjection(body, cfg) {
  const notes = [];
  const sources = [];
  const recallTags = [];
  const compression = [];
  let injectedBytes = 0;

  if (!body || typeof body !== "object" || !Array.isArray(body.messages)) {
    // Nothing to do; the downstream chat handler will return its own 400.
    notes.push("body has no messages array; skipping memory injection");
    return { body, injectedBytes: 0, sources, recallTags, notes, compression };
  }

  const original = body.messages;
  const prepend = [];
  const ambientQuery = latestUserQuery(original);

  // 1) Auto-recent StateBrief (always-on tap).
  const recentResult = await fetchStateBrief(
    cfg.memoryStateBriefUrl,
    { query: ambientQuery, max_records: cfg.recentMaxRecords },
    cfg.recentTimeoutMs,
    cfg.log,
  );
  if (recentResult.ok) {
    const sys = buildMemorySystemMessage(recentResult.data, "auto-recent", ambientQuery, {
      maxRecords: cfg.recentMaxRecords,
      byteBudget: cfg.recentMaxBytes,
    });
    compression.push(sys._aeCompression);
    delete sys._aeCompression;
    prepend.push(sys);
    injectedBytes += byteLength(sys.content);
    sources.push(recentResult.source || "unknown");
    if (recentResult.degraded) notes.push("auto-recent served degraded (shadow cache)");
  } else {
    const sys = buildTombstoneSystemMessage("auto-recent", recentResult.error);
    prepend.push(sys);
    injectedBytes += byteLength(sys.content);
    sources.push("error");
    notes.push(`auto-recent failed: ${recentResult.error}`);
  }

  // 2) <recall>…</recall> deeper queries (mid-turn taps).
  const queries = scanRecallTags(original, cfg.maxRecallTags);
  for (const query of queries) {
    const deep = await fetchStateBrief(
      cfg.memoryRecallUrl,
      { query, max_records: cfg.deepMaxRecords },
      cfg.deepTimeoutMs,
      cfg.log,
    );
    if (deep.ok) {
      const sys = buildMemorySystemMessage(deep.data, "deep-recall", query, {
        maxRecords: cfg.deepMaxRecords,
        byteBudget: cfg.deepMaxBytes,
      });
      compression.push(sys._aeCompression);
      delete sys._aeCompression;
      prepend.push(sys);
      injectedBytes += byteLength(sys.content);
      sources.push(deep.source || "unknown");
      recallTags.push({ query, ok: true, source: deep.source || "unknown" });
      if (deep.degraded) notes.push(`deep-recall "${query}" served degraded (shadow cache)`);
    } else {
      const sys = buildTombstoneSystemMessage("deep-recall", deep.error);
      // Stamp the query into the kind so the model can correlate.
      sys.content = sys.content.replace(
        "[MEMORY:RECALLED kind=deep-recall status=unavailable]",
        `[MEMORY:RECALLED kind=deep-recall query="${clampString(query, 256)}" status=unavailable]`,
      );
      prepend.push(sys);
      injectedBytes += byteLength(sys.content);
      sources.push("error");
      recallTags.push({ query, ok: false, error: deep.error });
      notes.push(`deep-recall "${query}" failed: ${deep.error}`);
    }
  }

  // 3) Final ordering: [memory system messages] + [original messages].
  // Order within prepend is: auto-recent first, then recall tags in scan order.
  body.messages = [...prepend, ...original];

  return {
    body,
    injectedBytes,
    sources,
    recallTags,
    notes,
    compression,
  };
}

// ---------------------------------------------------------------------------
// Express/Hono-style middleware
// ---------------------------------------------------------------------------

/**
 * Express/Hono-style middleware factory.
 *
 * Express signature  : async (req, res, next) => { … next() }
 * Hono signature     : async (c, next)        => { … await next() }
 *
 * We detect which we're in by looking at the arity / shape of the first
 * argument. The decision tree:
 *   - 3 args + req.body is object  -> Express
 *   - 2 args + ctx.req.json exists -> Hono
 *   - 2 args + ctx.req.raw         -> Hono (Bun runtime)
 *
 * On Express path, we mutate req.body.messages in place and set the byte
 * header on res. Downstream then sees the enriched messages array.
 *
 * On Hono path, we read the JSON body, mutate, and stash both the mutated
 * body and the byte count on the context so the next handler can pick them
 * up. We also set the header via c.header().
 */
export function memoryInjectMiddleware(opts = {}) {
  const cfg = Object.freeze({
    memoryStateBriefUrl: opts.memoryStateBriefUrl || DEFAULT_STATE_BRIEF_URL,
    memoryRecallUrl:     opts.memoryRecallUrl     || DEFAULT_RECALL_URL,
    recentMaxRecords:    Number.isFinite(opts.recentMaxRecords) ? opts.recentMaxRecords : DEFAULT_RECENT_MAX,
    deepMaxRecords:      Number.isFinite(opts.deepMaxRecords)   ? opts.deepMaxRecords   : DEFAULT_DEEP_MAX,
    recentMaxBytes:      Number.isFinite(opts.recentMaxBytes)   ? opts.recentMaxBytes   : DEFAULT_RECENT_BYTES,
    deepMaxBytes:        Number.isFinite(opts.deepMaxBytes)     ? opts.deepMaxBytes     : DEFAULT_DEEP_BYTES,
    recentTimeoutMs:     Number.isFinite(opts.recentTimeoutMs)  ? opts.recentTimeoutMs  : DEFAULT_RECENT_TIMEOUT,
    deepTimeoutMs:       Number.isFinite(opts.deepTimeoutMs)    ? opts.deepTimeoutMs    : DEFAULT_DEEP_TIMEOUT,
    path:                opts.path   || DEFAULT_PATH,
    method:              (opts.method || DEFAULT_METHOD).toUpperCase(),
    injectHeader:        opts.injectHeader   || DEFAULT_INJECT_HEADER,
    degradedHeader:      opts.degradedHeader || DEFAULT_SOURCE_HEADER,
    maxRecallTags:       Number.isFinite(opts.maxRecallTags)    ? opts.maxRecallTags    : DEFAULT_MAX_RECALL_TAGS,
    enabled:             opts.enabled !== false,
    log:                 typeof opts.log === "function" ? opts.log : defaultLog,
  });

  return async function memoryInject(reqOrCtx, resOrNext, maybeNext) {
    // ---- Hono path (2 args, ctx + next) ------------------------------------
    if (typeof resOrNext === "function" && typeof maybeNext !== "function") {
      const c = reqOrCtx;
      const next = resOrNext;

      if (!cfg.enabled) return next();

      const reqMethod = (c.req && c.req.method ? c.req.method : DEFAULT_METHOD).toUpperCase();
      const reqPath   = c.req && c.req.path
        ? c.req.path
        : (c.req && c.req.url ? new URL(c.req.url, "http://127.0.0.1").pathname : "");
      if (reqMethod !== cfg.method || reqPath !== cfg.path) return next();

      let parsed;
      try {
        parsed = await c.req.json();
      } catch (err) {
        cfg.log(`[memory-inject] hono body parse failed: ${err.message} — passthrough`);
        return next();
      }

      const result = await runInjection(parsed, cfg);

      // Stash for the downstream handler. The chat-completions handler MUST
      // pick this up; we don't have a way to rewrite c.req.json() itself in
      // Hono < 4, so the convention is to read from c.get("body").
      if (typeof c.set === "function") {
        c.set("body", result.body);
        c.set("memoryInjected", {
          bytes: result.injectedBytes,
          sources: result.sources,
          recallTags: result.recallTags,
          notes: result.notes,
          compression: result.compression,
        });
      }
      if (typeof c.header === "function") {
        c.header(cfg.injectHeader, String(result.injectedBytes));
        c.header(cfg.degradedHeader, result.sources.join(","));
      }
      return next();
    }

    // ---- Express path (3 args: req, res, next) -----------------------------
    const req  = reqOrCtx;
    const res  = resOrNext;
    const next = maybeNext;

    if (!cfg.enabled) return next();

    const reqMethod = (req.method || DEFAULT_METHOD).toUpperCase();
    const reqPath = (() => {
      // Express gives req.path; the raw node:http req gives req.url. Cover both.
      if (typeof req.path === "string" && req.path.length) return req.path;
      try { return new URL(req.url, "http://127.0.0.1").pathname; }
      catch { return req.url || ""; }
    })();
    if (reqMethod !== cfg.method || reqPath !== cfg.path) return next();

    // We expect req.body to already be a parsed JSON object (Express's
    // express.json() middleware, or our index.mjs readBody helper, will have
    // run before us). If it isn't, we passthrough rather than blocking.
    if (!req.body || typeof req.body !== "object") {
      cfg.log("[memory-inject] req.body missing or non-object — passthrough");
      return next();
    }

    let result;
    try {
      result = await runInjection(req.body, cfg);
    } catch (err) {
      // runInjection is meant to be non-throwing; this catch is purely
      // defensive. We do not block the chat completion on memory plane drama.
      cfg.log(`[memory-inject] runInjection threw: ${err.message} — passthrough`);
      return next();
    }

    req.body = result.body;

    // Header surface: bytes injected + which planes served. Use setHeader if
    // available (node:http), otherwise res.set (Express). Both no-op if the
    // response is already half-written, which would be a caller bug.
    try {
      if (typeof res.setHeader === "function") {
        res.setHeader(cfg.injectHeader, String(result.injectedBytes));
        if (result.sources.length) {
          res.setHeader(cfg.degradedHeader, result.sources.join(","));
        }
      } else if (typeof res.set === "function") {
        res.set(cfg.injectHeader, String(result.injectedBytes));
        if (result.sources.length) {
          res.set(cfg.degradedHeader, result.sources.join(","));
        }
      }
    } catch (err) {
      cfg.log(`[memory-inject] header set failed: ${err.message}`);
    }

    // Stash injection metadata for observability / tests / downstream logs.
    req._aeMemoryInjected = {
      bytes: result.injectedBytes,
      sources: result.sources,
      recallTags: result.recallTags,
      notes: result.notes,
      compression: result.compression,
    };

    return next();
  };
}

// ---------------------------------------------------------------------------
// Exports for direct wiring + tests
// ---------------------------------------------------------------------------

export { buildMemorySystemMessage };

export const __memoryInjectInternals = Object.freeze({
  scanRecallTags,
  latestUserQuery,
  buildMemoryHotFrame,
  fetchStateBrief,
  runInjection,
  buildTombstoneSystemMessage,
  MEMORY_PREAMBLE,
  RECALL_TAG_RE,
});
