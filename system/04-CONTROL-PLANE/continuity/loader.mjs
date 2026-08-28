#!/usr/bin/env node
// Orange5 — Continuity Packet Loader
// Path:    04-CONTROL-PLANE/continuity/loader.mjs
// Runtime: Node >= 20 (Bun-compatible — uses node: imports only)
// Mounts:  GET /v1/continuity/latest  on the OrangeLLM gateway (127.0.0.1:1337)
//
// What this does
// --------------
// Session-boot loader for the operator's most recent Continuity Packet.
// Pulls from THREE sources in priority order, with hard-named fallback so
// the operator always knows where the bytes came from:
//
//   1. Reality Flux (Cobra ledger, origin=continuity) via 11-MIRAGE/adapters/flux
//      — PRIMARY. The companion generator.mjs writes packets here at 23:50 ET.
//      Reality lane is authoritative; Thought lane never appears here.
//
//   2. Local packet files on disk. Two naming conventions are tolerated
//      because the codebase has both, and neither will be retired without
//      a migration receipt:
//        a. 01-DOCTRINE/27-guardrails/state/continuity/YYYY-MM-DD.json
//           (written by 01-DOCTRINE/27-guardrails/lib/continuity-packet.mjs)
//        b. 01-DOCTRINE/continuity/continuity_YYYY-MM-DD.json
//           (expected by guardrail G-18 / check 19)
//      Walks back up to 7 days to find the most recent.
//
//   3. Last-known-good cache at <continuity-dir>/.latest.cache.json,
//      written by this loader after every successful pull. SECONDARY-fallback
//      only — explicitly marked stale=true in the response.
//
// If all three fail, returns ok:false with a named reason. Never throws on
// the request path. Mom's Law: no fake-green. The response always tells the
// operator exactly which source the bytes came from and whether they are stale.
//
// Doctrine alignment (binding)
// ----------------------------
// - Receipts override recollection. Reality Flux is the receipted source.
// - Loopback only. The flux adapter is the only network hop; it already
//   enforces 127.0.0.1:7419 → Codexa rail → shadow-cache discipline.
// - Frontier-only-via-gateway. This loader is mounted by the OrangeLLM
//   gateway (06-ORANGELLM/server). It never exposes a port of its own.
// - Mom's Law: every return value carries `source` and (where relevant)
//   `stale`. The operator can audit boot context in one glance.
// - No fake-green commits: if the cache is what we returned, the response
//   says so out loud.
//
// HTTP contract
// -------------
//   GET /v1/continuity/latest
//   200 OK { ok:true, source, stale, date, packet, sha256, fetched_at }
//   200 OK { ok:false, reason, searched, fetched_at }    (no packet anywhere)
//   500 only for unhandled exceptions in the handler — not used by this path.
//
// Programmatic API
// ----------------
//   import { loadLatest, latestHandler } from './loader.mjs';
//   const r = await loadLatest();                        // boot-time pull
//   const r = await loadLatest({ adapter: customFluxAdapter, fsRoot, today });
//   await latestHandler(req, res);                       // gateway mount
//
// CLI
// ---
//   node loader.mjs                       # pull + print JSON
//   node loader.mjs --no-flux             # skip Reality Flux, files+cache only
//   node loader.mjs --no-files            # skip local files
//   node loader.mjs --no-cache            # skip cache fallback
//   node loader.mjs --max-lookback 14     # widen file lookback (default 7)
//   node loader.mjs --pretty              # pretty-print
//
// Exit codes: 0 pulled a packet, 2 nothing found (warn), 1 hard error.

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Constants

const ORANGE5_ROOT =
  process.env.ORANGE5_ROOT || resolve(__dirname, "..", "..");

const GUARDRAILS_CONTINUITY_DIR =
  process.env.ORANGE5_CONTINUITY_DIR ||
  resolve(ORANGE5_ROOT, "01-DOCTRINE", "27-guardrails", "state", "continuity");

const DOCTRINE_CONTINUITY_DIR =
  process.env.ORANGE5_DOCTRINE_CONTINUITY_DIR ||
  resolve(ORANGE5_ROOT, "01-DOCTRINE", "continuity");

const FLUX_ADAPTER_PATH =
  process.env.ORANGE5_FLUX_ADAPTER ||
  resolve(ORANGE5_ROOT, "11-MIRAGE", "adapters", "flux.mjs");

// Loader's own cache (last-known-good). Lives next to the loader so it
// roundtrips with the control plane and never collides with guardrail state.
const CACHE_PATH = process.env.ORANGE5_CONTINUITY_CACHE_PATH || resolve(__dirname, ".latest.cache.json");

const DEFAULT_MAX_LOOKBACK_DAYS = 7;
const FLUX_QUERY = process.env.ORANGE5_CONTINUITY_FLUX_QUERY ||
  "event_type:continuity_packet origin:continuity";
const FLUX_TIME_RANGE_MS = parseInt(
  process.env.ORANGE5_CONTINUITY_FLUX_RANGE_MS || String(86_400_000 * 14),
  10,
);
const FLUX_MAX_RECORDS = parseInt(
  process.env.ORANGE5_CONTINUITY_FLUX_MAX_RECORDS || "8",
  10,
);

const SCHEMA = "orange5.continuity-packet.v1";

// ---------------------------------------------------------------------------
// Pure helpers — exported for unit tests

export function todayIso(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function dayShift(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * Validate a parsed packet enough to know it's a real continuity packet
 * regardless of which generator wrote it. We accept either field set the
 * codebase actually emits today, but normalize on the way out.
 *
 * Returns { ok, normalized? , reason? }.
 */
export function validateAndNormalize(raw) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "packet_not_an_object" };
  }
  const date = raw.date || raw.day || null;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, reason: "packet_missing_or_bad_date" };
  }

  // Field aliases observed in this codebase.
  const progress =
    raw.progress ?? raw.today_progress ?? raw.progress_summary ?? [];
  const open_blockers = raw.open_blockers ?? raw.blockers ?? [];
  const tomorrow_first_action =
    raw.tomorrow_first_action ?? raw.tomorrows_first_action ?? null;

  if (!Array.isArray(progress)) {
    return { ok: false, reason: "progress_not_array" };
  }
  if (!Array.isArray(open_blockers)) {
    return { ok: false, reason: "open_blockers_not_array" };
  }

  const normalized = {
    schema: raw.schema || raw.schema_version || SCHEMA,
    date,
    progress,
    open_blockers,
    tomorrow_first_action,
    hot_currents: Array.isArray(raw.hot_currents) ? raw.hot_currents : [],
    fresh_receipts: Array.isArray(raw.fresh_receipts)
      ? raw.fresh_receipts
      : [],
    notes: raw.notes ?? null,
    guardrails_summary: raw.guardrails_summary ?? null,
    written_at: raw.written_at ?? null,
    raw, // preserve original for downstream — never silently drop fields
  };
  return { ok: true, normalized };
}

function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}

function safeStringify(obj) {
  // Stable-ish JSON for hashing — sort top-level keys. Inner objects keep
  // their order because packet authors care about field order in some cases.
  if (obj == null) return "null";
  if (typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return JSON.stringify(obj);
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ":" + JSON.stringify(obj[k]));
  return "{" + parts.join(",") + "}";
}

// ---------------------------------------------------------------------------
// Reality Flux source

async function defaultFluxAdapterLoader() {
  // Lazy + URL-safe import. pathToFileURL handles Windows drive letters
  // (file:///C:/...) and POSIX paths uniformly.
  try {
    const url = pathToFileURL(FLUX_ADAPTER_PATH);
    const mod = await import(url.href);
    return mod.fluxAdapter || mod.default || null;
  } catch (e) {
    return { __err: String(e?.message || e) };
  }
}

/**
 * Find a continuity packet payload inside a StateBrief or flux read response.
 * The shape varies (legitimately) by adapter version; we look in the obvious
 * places and return the FIRST candidate that validates as a continuity packet,
 * preferring the most recent by date.
 */
export function extractPacketCandidates(fluxData) {
  if (fluxData == null) return [];
  const candidates = [];

  const pushIfPacket = (obj) => {
    if (!obj || typeof obj !== "object") return;
    // Either the obj itself is the packet, or a `body` / `payload` inside it.
    const tryShapes = [obj, obj.body, obj.payload, obj.packet, obj.data];
    for (const s of tryShapes) {
      if (!s || typeof s !== "object") continue;
      const v = validateAndNormalize(s);
      if (v.ok) {
        candidates.push(v.normalized);
        return;
      }
    }
  };

  // Common StateBrief shapes.
  if (Array.isArray(fluxData.events)) fluxData.events.forEach(pushIfPacket);
  if (Array.isArray(fluxData.records)) fluxData.records.forEach(pushIfPacket);
  if (Array.isArray(fluxData.items)) fluxData.items.forEach(pushIfPacket);
  if (Array.isArray(fluxData.results)) fluxData.results.forEach(pushIfPacket);
  if (Array.isArray(fluxData.entries)) fluxData.entries.forEach(pushIfPacket);
  // Top-level packet (some adapters return one straight up).
  pushIfPacket(fluxData);

  // Sort newest first by date string. Lexicographic works because ISO date.
  candidates.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return candidates;
}

async function tryFluxSource({ adapter } = {}) {
  const a = adapter || (await defaultFluxAdapterLoader());
  if (!a || typeof a.read !== "function") {
    return {
      ok: false,
      reason: "flux_adapter_unavailable",
      detail: a && a.__err ? a.__err : "no_read_method",
    };
  }
  let res;
  try {
    res = await a.read({
      query: FLUX_QUERY,
      time_range_ms: FLUX_TIME_RANGE_MS,
      max_records: FLUX_MAX_RECORDS,
      include_conflicts: false,
    });
  } catch (e) {
    return { ok: false, reason: "flux_read_threw", detail: String(e?.message || e) };
  }
  if (!res || res.ok === false) {
    return {
      ok: false,
      reason: "flux_read_not_ok",
      detail: res?.reason || res?.detail || "unknown",
    };
  }
  const cands = extractPacketCandidates(res.data);
  if (cands.length === 0) {
    return {
      ok: false,
      reason: "flux_returned_no_continuity_packet",
      flux_source: res.source || null,
      stale_flux: !!res.stale,
    };
  }
  const packet = cands[0];
  return {
    ok: true,
    source: "reality_flux" + (res.source ? `:${res.source}` : ""),
    stale: !!res.stale,
    packet,
  };
}

// ---------------------------------------------------------------------------
// Local-files source

function readJsonSafe(p) {
  try {
    const txt = readFileSync(p, "utf8");
    return { ok: true, raw: JSON.parse(txt), bytes: txt };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
}

/**
 * Walk both known continuity directories, both naming conventions, looking
 * back up to maxLookbackDays. Returns the most recent VALID packet.
 *
 * Naming conventions tolerated:
 *   - {dir}/YYYY-MM-DD.json
 *   - {dir}/continuity_YYYY-MM-DD.json
 */
export function findLatestLocalPacket({
  today = todayIso(),
  maxLookbackDays = DEFAULT_MAX_LOOKBACK_DAYS,
  dirs = [GUARDRAILS_CONTINUITY_DIR, DOCTRINE_CONTINUITY_DIR],
} = {}) {
  const searched = [];
  for (let i = 0; i <= maxLookbackDays; i++) {
    const iso = dayShift(today, -i);
    for (const dir of dirs) {
      const candidates = [
        resolve(dir, `${iso}.json`),
        resolve(dir, `continuity_${iso}.json`),
      ];
      for (const p of candidates) {
        searched.push(p);
        if (!existsSync(p)) continue;
        const j = readJsonSafe(p);
        if (!j.ok) {
          // Surface malformed file as a hard signal — we don't skip silently.
          return {
            ok: false,
            reason: "local_packet_malformed_json",
            path: p,
            detail: j.reason,
            searched,
          };
        }
        const v = validateAndNormalize(j.raw);
        if (!v.ok) {
          return {
            ok: false,
            reason: "local_packet_failed_validation",
            path: p,
            detail: v.reason,
            searched,
          };
        }
        return {
          ok: true,
          source: `local_file:${p}`,
          stale: false,
          packet: v.normalized,
          path: p,
          days_back: i,
        };
      }
    }
  }
  return {
    ok: false,
    reason: "no_local_continuity_packet_in_lookback_window",
    today,
    max_lookback_days: maxLookbackDays,
    searched,
  };
}

// ---------------------------------------------------------------------------
// Last-known-good cache

function writeCache(payload) {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(payload, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

function readCache() {
  if (!existsSync(CACHE_PATH)) return null;
  try {
    const txt = readFileSync(CACHE_PATH, "utf8");
    const obj = JSON.parse(txt);
    const v = validateAndNormalize(obj?.packet);
    if (!v.ok) return null;
    let mtime = null;
    try { mtime = statSync(CACHE_PATH).mtimeMs; } catch { /* ignore */ }
    return {
      packet: v.normalized,
      cached_at: obj.cached_at || mtime || null,
      original_source: obj.source || null,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API — loadLatest

/**
 * Pull the most recent continuity packet using the documented priority:
 * Reality Flux → local files → last-known-good cache.
 *
 * Options
 * -------
 *   adapter           : injectable flux adapter (test seam). Falls back to
 *                       the canonical 11-MIRAGE/adapters/flux.mjs.
 *   today             : ISO date override (test seam).
 *   maxLookbackDays   : default 7.
 *   fsDirs            : override the local-file search dirs.
 *   skipFlux/Files/Cache: per-source opt-out flags.
 *
 * Return shape
 * ------------
 *   { ok, source, stale, date, packet, sha256, fetched_at, attempts }
 *   On total failure: { ok:false, reason, attempts, fetched_at }.
 *   Never throws on the request path.
 */
export async function loadLatest(opts = {}) {
  const attempts = [];
  const fetched_at = Date.now();

  const skipFlux = !!opts.skipFlux;
  const skipFiles = !!opts.skipFiles;
  const skipCache = !!opts.skipCache;

  // 1. Reality Flux
  if (!skipFlux) {
    const r = await tryFluxSource({ adapter: opts.adapter });
    attempts.push({ source: "reality_flux", ok: r.ok, reason: r.reason });
    if (r.ok) {
      const body = JSON.stringify(r.packet);
      const hash = sha256(safeStringify(r.packet));
      const out = {
        ok: true,
        source: r.source,
        stale: r.stale,
        date: r.packet.date,
        packet: r.packet,
        sha256: hash,
        fetched_at,
        attempts,
      };
      // Update cache only when bytes came from the live Reality Flux path
      // and were NOT stale; we never overwrite good cache with stale bytes.
      if (!r.stale) {
        writeCache({
          schema: SCHEMA,
          source: r.source,
          cached_at: fetched_at,
          sha256: hash,
          packet: r.packet,
        });
      }
      return out;
    }
  } else {
    attempts.push({ source: "reality_flux", skipped: true });
  }

  // 2. Local files
  if (!skipFiles) {
    const r = findLatestLocalPacket({
      today: opts.today || todayIso(),
      maxLookbackDays: Number.isFinite(opts.maxLookbackDays)
        ? opts.maxLookbackDays
        : DEFAULT_MAX_LOOKBACK_DAYS,
      dirs: Array.isArray(opts.fsDirs) ? opts.fsDirs : undefined,
    });
    attempts.push({ source: "local_files", ok: r.ok, reason: r.reason, path: r.path });
    if (r.ok) {
      const hash = sha256(safeStringify(r.packet));
      writeCache({
        schema: SCHEMA,
        source: r.source,
        cached_at: fetched_at,
        sha256: hash,
        packet: r.packet,
      });
      return {
        ok: true,
        source: r.source,
        stale: false,
        date: r.packet.date,
        packet: r.packet,
        sha256: hash,
        fetched_at,
        attempts,
      };
    }
  } else {
    attempts.push({ source: "local_files", skipped: true });
  }

  // 3. Last-known-good cache
  if (!skipCache) {
    const c = readCache();
    attempts.push({ source: "cache", ok: !!c });
    if (c) {
      const hash = sha256(safeStringify(c.packet));
      return {
        ok: true,
        source: "cache:last_known_good",
        stale: true,
        date: c.packet.date,
        packet: c.packet,
        sha256: hash,
        cached_at: c.cached_at,
        original_source: c.original_source,
        fetched_at,
        attempts,
      };
    }
  } else {
    attempts.push({ source: "cache", skipped: true });
  }

  return {
    ok: false,
    reason: "no_continuity_packet_found_anywhere",
    attempts,
    fetched_at,
  };
}

// ---------------------------------------------------------------------------
// Gateway handler — wire into 06-ORANGELLM/server/routes/*

/**
 * Node http handler for GET /v1/continuity/latest. Mount from the gateway
 * router. Returns 200 + JSON in all normal cases (including "no packet
 * found"); only unhandled exceptions become 5xx.
 */
export async function latestHandler(req, res) {
  try {
    if (req.method && req.method.toUpperCase() !== "GET") {
      res.writeHead(405, {
        "Content-Type": "application/json",
        "Allow": "GET",
      });
      res.end(JSON.stringify({
        ok: false,
        reason: "method_not_allowed",
        allow: "GET",
      }));
      return;
    }
    const out = await loadLatest({});
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out));
  } catch (e) {
    // Defense in depth — loadLatest should not throw, but if it does we
    // refuse to silently swallow it. Mom's Law.
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: false,
      reason: "loader_threw",
      detail: String(e?.message || e),
    }));
  }
}

/**
 * Tiny dispatcher for gateway routers that prefer an object surface.
 * The gateway's index.mjs can do:
 *   if (method === 'GET' && path === '/v1/continuity/latest') return latestHandler(req, res);
 * or import { routes } and iterate.
 */
export const routes = Object.freeze({
  "GET /v1/continuity/latest": latestHandler,
});

// ---------------------------------------------------------------------------
// CLI

function parseArgs(argv) {
  const args = { pretty: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-flux") args.skipFlux = true;
    else if (a === "--no-files") args.skipFiles = true;
    else if (a === "--no-cache") args.skipCache = true;
    else if (a === "--pretty") args.pretty = true;
    else if (a === "--max-lookback") {
      args.maxLookbackDays = parseInt(argv[++i], 10);
    } else if (a === "--today") {
      args.today = argv[++i];
    } else if (a === "--help" || a === "-h") {
      args.help = true;
    }
  }
  return args;
}

function helpText() {
  return [
    "Orange5 Continuity Packet Loader",
    "",
    "Usage:",
    "  node loader.mjs [--no-flux] [--no-files] [--no-cache]",
    "                  [--max-lookback N] [--today YYYY-MM-DD] [--pretty]",
    "",
    "Exit codes: 0 ok, 2 nothing found, 1 hard error.",
  ].join("\n");
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(helpText() + "\n");
    process.exit(0);
  }
  loadLatest(args).then(
    (out) => {
      const txt = args.pretty
        ? JSON.stringify(out, null, 2)
        : JSON.stringify(out);
      process.stdout.write(txt + "\n");
      process.exit(out.ok ? 0 : 2);
    },
    (err) => {
      process.stderr.write(
        JSON.stringify({
          ok: false,
          reason: "cli_unhandled",
          detail: String(err?.message || err),
        }) + "\n",
      );
      process.exit(1);
    },
  );
}

export default loadLatest;
