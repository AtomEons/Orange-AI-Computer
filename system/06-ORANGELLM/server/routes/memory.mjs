// AE OrangeLLM — Mirage memory routes
// Path: 06-ORANGELLM/server/routes/memory.mjs
//
// Doctrine:
//   - Mirage = data + memory plane.
//   - mirage/memory/* are internal stores (Æ Cobra Flux ledgers, Graph Weaver
//     SQLite, receipts). Read-write per Sovereign.
//   - StateBrief = compressed memory slice OrangeLLM consumes when it asks
//     "what did we decide about X" or "what happened on Tuesday".
//   - Reality always overrides Thought on conflict. Receipts override
//     recollection. The StateBrief shape must surface conflicts honestly
//     rather than silently picking a winner.
//   - AE Cobra daemon at 127.0.0.1:7419 is the live source. On unreachable,
//     fall back to the N150 shadow snapshot under OrangeBox-Data.
//
// Exports:
//   registerMemoryRoutes(server, opts)
//     - server : node:http Server instance
//     - opts   : {
//         cobraUrl?:     string    // default http://127.0.0.1:7419
//         cobraTimeoutMs?: number  // default 1500
//         cacheDir?:     string    // default %USERPROFILE%/OrangeBox-Data/orange5/memory-shadow
//         defaults?:     { lanes, time_range_ms, max_records,
//                          include_conflicts } // applied by /recall
//         log?:          (line) => void
//       }
//
// Routes registered:
//   POST /v1/memory/state-brief
//   POST /v1/memory/recall
//   GET  /v1/memory/healthz
//
// Boundary note: these paths must also be added to the gateway allow-list at
// 06-ORANGELLM/server/routes/memory-boundary.mjs (and pulled into the main
// boundary.mjs ALLOWED list) before they are reachable from outside.

import { URL } from "node:url";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readShadowCache } from "../../memory/cache/shadow-reader.mjs";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const COBRA_DEFAULT_URL = "http://127.0.0.1:7419";
const COBRA_DEFAULT_TIMEOUT_MS = 1500;

// Operator-defined defaults for /recall — Option C hybrid auto-inject shape.
const RECALL_DEFAULTS = Object.freeze({
  time_range_ms: 72 * 60 * 60 * 1000, // 72h window
  lanes: ["reality", "thought", "receipt"],
  max_records: 24,
  include_conflicts: true,
});

// State-brief defaults if caller omits fields entirely.
const STATE_BRIEF_DEFAULTS = Object.freeze({
  time_range_ms: 24 * 60 * 60 * 1000,
  lanes: ["reality", "thought", "receipt"],
  max_records: 32,
  include_conflicts: true,
});

const MAX_BODY_BYTES = 256 * 1024; // 256 KiB caps memory request bodies

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function resolveDefaultCacheDir() {
  return path.resolve(
    process.env.ORANGE5_CACHE_DIR
      || path.join(process.env.USERPROFILE || os.homedir(), "OrangeBox-Data", "orange5", "memory-shadow"),
  );
}

function resolveDefaultEventsDir() {
  return path.resolve(
    process.env.ORANGE5_COBRA_FLUX_ROOT
      || path.join(process.env.USERPROFILE || os.homedir(), "OrangeBox-Data", "orange5", "ae-cobra-flux", "events"),
  );
}

function jsonResponse(res, body, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function errorResponse(res, message, status = 400, code = "invalid_request_error") {
  jsonResponse(
    res,
    { error: { message, type: code, code: status } },
    status,
  );
}

async function readJsonBody(req, capBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", chunk => {
      total += chunk.length;
      if (total > capBytes) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const buf = Buffer.concat(chunks);
      if (!buf.length) return resolve({});
      try { resolve(JSON.parse(buf.toString("utf8"))); }
      catch { reject(new Error("invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

function nowIso() { return new Date().toISOString(); }

function clampInt(value, min, max, fallback) {
  const n = Number.isFinite(value) ? Math.floor(value) : fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function sanitizeLanes(lanes, fallback) {
  if (!Array.isArray(lanes) || lanes.length === 0) return fallback.slice();
  const allowed = new Set(["reality", "thought", "receipt", "conflict"]);
  const out = [];
  for (const lane of lanes) {
    if (typeof lane !== "string") continue;
    const norm = lane.toLowerCase().trim();
    if (allowed.has(norm) && !out.includes(norm)) out.push(norm);
  }
  return out.length ? out : fallback.slice();
}

function normalizeStateBriefBody(body, defaults) {
  const src = body && typeof body === "object" ? body : {};
  return {
    query: typeof src.query === "string" ? src.query.slice(0, 4096) : "",
    time_range_ms: clampInt(
      src.time_range_ms,
      60 * 1000,             // floor: 1 minute
      30 * 24 * 60 * 60 * 1000, // ceil: 30 days
      defaults.time_range_ms,
    ),
    lanes: sanitizeLanes(src.lanes, defaults.lanes),
    max_records: clampInt(src.max_records, 1, 256, defaults.max_records),
    include_conflicts:
      typeof src.include_conflicts === "boolean"
        ? src.include_conflicts
        : defaults.include_conflicts,
  };
}

// ---------------------------------------------------------------------------
// Æ Cobra client (with timeout via AbortController)
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url, init = {}, timeoutMs = COBRA_DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function probeCobra(cobraUrl, timeoutMs) {
  const url = `${cobraUrl.replace(/\/+$/, "")}/healthz`;
  const started = Date.now();
  try {
    const res = await fetchWithTimeout(url, { method: "GET" }, timeoutMs);
    return {
      live: res.ok,
      status: res.status,
      url,
      latency_ms: Date.now() - started,
    };
  } catch (err) {
    return {
      live: false,
      status: null,
      url,
      error: String(err && err.message ? err.message : err),
      latency_ms: Date.now() - started,
    };
  }
}

async function callCobraStateBrief(cobraUrl, payload, timeoutMs) {
  const url = `${cobraUrl.replace(/\/+$/, "")}/state-brief`;
  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    timeoutMs,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`Æ Cobra returned ${res.status}: ${text.slice(0, 256)}`);
    err.status = res.status;
    err.cobra_response_text = text.slice(0, 1024);
    throw err;
  }
  const data = await res.json();
  return data;
}

// ---------------------------------------------------------------------------
// N150 shadow cache (file-backed fallback)
// ---------------------------------------------------------------------------
//
// Layout:
//   <cacheDir>/
//     latest.json                  -- last successful state-brief snapshot
//     by-lane/<lane>.jsonl         -- append-only event log per lane
//     shadow-meta.json             -- bookkeeping (last_updated, source)
//
// The cache is intentionally simple: a degraded answer is still an answer.
// When Cobra returns, we refresh latest.json.

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function writeShadowSnapshot(cacheDir, snapshot) {
  try {
    await ensureDir(cacheDir);
    const tmp = path.join(cacheDir, `latest.json.tmp.${process.pid}`);
    const final = path.join(cacheDir, "latest.json");
    await fs.writeFile(tmp, JSON.stringify(snapshot, null, 2), "utf8");
    await fs.rename(tmp, final);
    const meta = {
      last_updated: nowIso(),
      source: "cobra",
      records: Array.isArray(snapshot.records) ? snapshot.records.length : null,
    };
    await fs.writeFile(
      path.join(cacheDir, "shadow-meta.json"),
      JSON.stringify(meta, null, 2),
      "utf8",
    );
  } catch (err) {
    // Cache write failures must never block the live path. Log and move on.
    // eslint-disable-next-line no-console
    console.warn(`[memory] shadow cache write failed: ${err.message}`);
  }
}

async function readShadowSnapshot(cacheDir) {
  const file = path.join(cacheDir, "latest.json");
  try {
    const buf = await fs.readFile(file, "utf8");
    return JSON.parse(buf);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

async function shadowHealth(cacheDir) {
  const metaFile = path.join(cacheDir, "shadow-meta.json");
  const latestFile = path.join(cacheDir, "latest.json");
  try {
    const [metaRaw, latestStat] = await Promise.all([
      fs.readFile(metaFile, "utf8").catch(() => null),
      fs.stat(latestFile).catch(() => null),
    ]);
    if (!latestStat) {
      return { live: false, reason: "no snapshot on disk", path: cacheDir };
    }
    const meta = metaRaw ? JSON.parse(metaRaw) : {};
    return {
      live: true,
      path: cacheDir,
      last_updated: meta.last_updated || latestStat.mtime.toISOString(),
      records: meta.records ?? null,
      bytes: latestStat.size,
      age_ms: Date.now() - latestStat.mtimeMs,
    };
  } catch (err) {
    return { live: false, reason: err.message, path: cacheDir };
  }
}

// Filter a cached snapshot down to the requested query shape. This is best
// effort: the shadow is stale by definition; we don't pretend otherwise.
function filterShadowSnapshot(snapshot, normalized) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const records = Array.isArray(snapshot.records) ? snapshot.records : [];
  const cutoff = Date.now() - normalized.time_range_ms;
  const laneSet = new Set(normalized.lanes);

  const filtered = records.filter(r => {
    if (!r || typeof r !== "object") return false;
    if (r.lane && !laneSet.has(String(r.lane).toLowerCase())) return false;
    if (typeof r.ts === "number" && r.ts < cutoff) return false;
    if (typeof r.ts === "string") {
      const t = Date.parse(r.ts);
      if (Number.isFinite(t) && t < cutoff) return false;
    }
    return true;
  });

  const conflicts = normalized.include_conflicts && Array.isArray(snapshot.conflicts)
    ? snapshot.conflicts
    : [];

  return {
    query: normalized.query,
    generated_at: nowIso(),
    source: "n150_shadow_cache",
    degraded: true,
    snapshot_last_updated: snapshot.generated_at || snapshot.last_updated || null,
    lanes: normalized.lanes,
    time_range_ms: normalized.time_range_ms,
    records: filtered.slice(0, normalized.max_records),
    conflicts,
    notes: [
      "Æ Cobra unreachable; serving from N150 shadow cache.",
      "Reality > Thought on conflict still applies; conflicts list reflects last sync.",
    ],
  };
}

// ---------------------------------------------------------------------------
// Handlers (pure-ish; take config, return body)
// ---------------------------------------------------------------------------

async function handleStateBriefLegacy(rawBody, cfg) {
  const normalized = normalizeStateBriefBody(rawBody, STATE_BRIEF_DEFAULTS);

  // Try Æ Cobra first.
  try {
    const data = await callCobraStateBrief(
      cfg.cobraUrl,
      normalized,
      cfg.cobraTimeoutMs,
    );
    // Refresh shadow cache opportunistically.
    if (data && typeof data === "object") {
      writeShadowSnapshot(cfg.cacheDir, data).catch(() => {});
    }
    return {
      status: 200,
      body: {
        ...data,
        source: data.source || "ae_cobra",
        degraded: false,
        served_by: "ae_cobra",
        generated_at: data.generated_at || nowIso(),
        echo_request: normalized,
      },
    };
  } catch (err) {
    cfg.log(`[memory] Æ Cobra unreachable: ${err.message} — falling back to shadow cache`);
  }

  // Fallback: N150 shadow cache.
  let snapshot = null;
  try {
    snapshot = await readShadowSnapshot(cfg.cacheDir);
  } catch (err) {
    cfg.log(`[memory] shadow cache read failed: ${err.message}`);
  }

  if (!snapshot) {
    return {
      status: 503,
      body: {
        error: {
          message:
            "memory plane unreachable: Æ Cobra down and no N150 shadow snapshot on disk",
          type: "memory_unavailable",
          code: 503,
        },
        served_by: "none",
        cobra_url: cfg.cobraUrl,
        cache_dir: cfg.cacheDir,
        echo_request: normalized,
      },
    };
  }

  const filtered = filterShadowSnapshot(snapshot, normalized);
  return {
    status: 200,
    body: {
      ...filtered,
      served_by: "n150_shadow_cache",
      cobra_url: cfg.cobraUrl,
      echo_request: normalized,
    },
  };
}

async function handleStateBrief(rawBody, cfg) {
  const normalized = normalizeStateBriefBody(rawBody, STATE_BRIEF_DEFAULTS);
  try {
    const data = await callCobraStateBrief(cfg.cobraUrl, normalized, cfg.cobraTimeoutMs);
    return {
      status: 200,
      body: {
        ...data,
        source: data.source || "ae_cobra",
        degraded: false,
        served_by: "ae_cobra",
        generated_at: data.generated_at || nowIso(),
        echo_request: normalized,
      },
    };
  } catch (error) {
    cfg.log(`[memory] AE Cobra unreachable: ${error.message}; reading canonical disk ledger`);
  }

  let disk;
  try {
    const now = Date.now();
    const requestedLanes = [...new Set(normalized.lanes.map((lane) => ({ receipt: "reality", conflict: "reality" }[lane] || lane)))];
    disk = await readShadowCache({
      lanes: requestedLanes,
      startMs: now - normalized.time_range_ms,
      endMs: now,
      maxRecords: Math.max(normalized.max_records * 4, 64),
      sourceDir: cfg.eventsDir,
    });
  } catch (error) {
    cfg.log(`[memory] canonical disk read failed: ${error.message}`);
  }

  if (!disk || disk.records.length === 0) {
    return {
      status: 503,
      body: {
        error: {
          message: "memory plane unreachable: AE Cobra down and no canonical ledger records are readable",
          type: "memory_unavailable",
          code: 503,
        },
        served_by: "none",
        cobra_url: cfg.cobraUrl,
        events_dir: cfg.eventsDir,
        echo_request: normalized,
      },
    };
  }

  const queryTerms = normalized.query.toLowerCase().match(/[a-z0-9][a-z0-9._-]+/g) || [];
  const rank = (record) => {
    const text = [record.summary, record.kind, record.origin, ...(record.entities || []), ...(record.files || [])]
      .filter(Boolean).join(" ").toLowerCase();
    return queryTerms.reduce((score, term) => score + (text.includes(term) ? 1 : 0), 0);
  };
  const select = (lane) => (disk.by_lane[lane] || [])
    .map((record) => ({ record, score: rank(record) }))
    .filter((item) => queryTerms.length === 0 || item.score > 0)
    .sort((a, b) => b.score - a.score || Number(b.record.ts || 0) - Number(a.record.ts || 0))
    .slice(0, normalized.max_records)
    .map((item) => item.record);
  const reality = select("reality");
  const thought = select("thought");
  return {
    status: 200,
    body: {
      schema: "orange5.state-brief.disk-fallback.v1",
      query: normalized.query,
      reality,
      thought,
      conflicts: [],
      recommended_next_action: thought[0]?.next_action || reality[0]?.next_action || null,
      confidence: queryTerms.length === 0 ? 0.7 : Math.min(0.8, (reality.length + thought.length) / Math.max(1, normalized.max_records)),
      retrieval: {
        method: "canonical_disk_ranked_token_overlap_v1",
        source: disk.source,
        source_dir: disk.source_dir,
        freshness: disk.freshness,
      },
      degraded: true,
      served_by: "canonical_disk_fallback",
      cobra_url: cfg.cobraUrl,
      generated_at: nowIso(),
      echo_request: normalized,
    },
  };
}

async function handleRecall(rawBody, cfg) {
  const src = rawBody && typeof rawBody === "object" ? rawBody : {};
  if (typeof src.query !== "string" || !src.query.trim()) {
    return {
      status: 400,
      body: {
        error: {
          message: "recall requires non-empty {query}",
          type: "invalid_request_error",
          code: 400,
        },
      },
    };
  }
  // Apply operator-defined defaults, but let caller override one-offs if they
  // really want to.
  const merged = {
    query: src.query,
    time_range_ms: src.time_range_ms ?? cfg.recallDefaults.time_range_ms,
    lanes: src.lanes ?? cfg.recallDefaults.lanes,
    max_records: src.max_records ?? cfg.recallDefaults.max_records,
    include_conflicts:
      src.include_conflicts ?? cfg.recallDefaults.include_conflicts,
  };
  return handleStateBrief(merged, cfg);
}

async function handleMemoryHealthLegacy(cfg) {
  const [cobra, shadow] = await Promise.all([
    probeCobra(cfg.cobraUrl, cfg.cobraTimeoutMs),
    shadowHealth(cfg.cacheDir),
  ]);

  let serving;
  if (cobra.live) serving = "ae_cobra";
  else if (shadow.live) serving = "n150_shadow_cache";
  else serving = "none";

  const status = serving === "none" ? "down" : (cobra.live ? "ok" : "degraded");

  return {
    status,
    service: "orangellm-memory",
    serving,
    cobra,
    shadow_cache: shadow,
    law: "Reality > Thought on conflict. Receipts > recollection. Shadow is degraded fallback.",
    generated_at: nowIso(),
  };
}

async function handleMemoryHealth(cfg) {
  const [cobra, disk] = await Promise.all([
    probeCobra(cfg.cobraUrl, cfg.cobraTimeoutMs),
    readShadowCache({ lanes: ["reality", "thought"], maxRecords: 1, sourceDir: cfg.eventsDir })
      .then((result) => ({ live: result.records.length > 0, source: result.source, path: result.source_dir, freshness: result.freshness }))
      .catch((error) => ({ live: false, path: cfg.eventsDir, reason: error.message })),
  ]);
  const serving = cobra.live ? "ae_cobra" : (disk.live ? "canonical_disk_fallback" : "none");
  return {
    status: serving === "none" ? "down" : (cobra.live ? "ok" : "degraded"),
    service: "orangellm-memory",
    serving,
    cobra,
    canonical_disk: disk,
    law: "Reality > Thought on conflict. Receipts > recollection. Canonical disk is the degraded daemon fallback.",
    generated_at: nowIso(),
  };
}

// ---------------------------------------------------------------------------
// Public: registerMemoryRoutes(server, opts)
// ---------------------------------------------------------------------------

export function createMemoryRouteConfig(opts = {}) {
  return {
    cobraUrl: (opts.cobraUrl || COBRA_DEFAULT_URL).replace(/\/+$/, ""),
    cobraTimeoutMs: Number.isFinite(opts.cobraTimeoutMs)
      ? opts.cobraTimeoutMs
      : COBRA_DEFAULT_TIMEOUT_MS,
    cacheDir: opts.cacheDir || resolveDefaultCacheDir(),
    eventsDir: opts.eventsDir || resolveDefaultEventsDir(),
    recallDefaults: { ...RECALL_DEFAULTS, ...(opts.defaults || {}) },
    log: typeof opts.log === "function" ? opts.log : (line) => {
      // eslint-disable-next-line no-console
      console.log(line);
    },
  };
}

export function registerMemoryRoutes(server, opts = {}) {
  if (!server || typeof server.on !== "function") {
    throw new TypeError("registerMemoryRoutes: server must be a node:http Server");
  }

  const cfg = createMemoryRouteConfig(opts);

  // Ensure cache dir exists at registration time; non-fatal if it fails.
  ensureDir(cfg.cacheDir).catch(err => {
    cfg.log(`[memory] cache dir setup failed: ${err.message}`);
  });

  const ROUTES = [
    { method: "POST", path: "/v1/memory/state-brief" },
    { method: "POST", path: "/v1/memory/recall" },
    { method: "GET",  path: "/v1/memory/healthz" },
  ];

  // Attach a request listener that ONLY claims memory paths. We use
  // `prependListener` so we run before the gateway's main handler, and we
  // do not respond unless the path matches.
  server.prependListener("request", async (req, res) => {
    if (res.writableEnded) return; // someone else already answered

    let url;
    try {
      url = new URL(req.url, "http://127.0.0.1");
    } catch {
      return; // let the main handler deal with malformed URLs
    }
    const method = (req.method || "GET").toUpperCase();
    const pathName = url.pathname;

    if (!pathName.startsWith("/v1/memory/")) return;

    const match = ROUTES.find(r => r.method === method && r.path === pathName);
    if (!match) {
      // Memory namespace but wrong method/path → answer 404 here so we don't
      // leak to the main router (which would also 404 but less informatively).
      return errorResponse(
        res,
        `memory route not found: ${method} ${pathName}`,
        404,
        "memory_route_not_found",
      );
    }

    try {
      if (method === "GET" && pathName === "/v1/memory/healthz") {
        const body = await handleMemoryHealth(cfg);
        return jsonResponse(res, body);
      }

      if (method === "POST" && pathName === "/v1/memory/state-brief") {
        const raw = await readJsonBody(req);
        const { status, body } = await handleStateBrief(raw, cfg);
        return jsonResponse(res, body, status);
      }

      if (method === "POST" && pathName === "/v1/memory/recall") {
        const raw = await readJsonBody(req);
        const { status, body } = await handleRecall(raw, cfg);
        return jsonResponse(res, body, status);
      }

      // Unreachable: ROUTES gated above
      return errorResponse(res, "unreachable", 500);
    } catch (err) {
      cfg.log(`[memory] handler error on ${method} ${pathName}: ${err.message}`);
      return errorResponse(
        res,
        err.message || "memory internal error",
        500,
        "memory_internal_error",
      );
    }
  });

  return {
    cfg,
    routes: ROUTES,
  };
}

// Re-export handlers for direct wiring (if the main index.mjs prefers central
// dispatch over prependListener).
export const __memoryHandlers = {
  handleStateBrief,
  handleRecall,
  handleMemoryHealth,
  readJsonBody,
};
