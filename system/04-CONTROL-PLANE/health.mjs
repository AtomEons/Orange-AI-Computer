// health.mjs — Orange5 Control Plane, in-process health snapshot.
// Path:    04-CONTROL-PLANE/health.mjs
// Runtime: Bun (imports #sqlite via Orange5 root package.json imports map).
//          Mom's Law: Bun-only, no Node fallback.
//
// What this is
// ------------
// A machine-readable backend metrics GETTER. It returns a plain JSON object
// describing control-plane health at the instant of the call. There is NO
// dashboard, NO UI, NO operator-facing scrub interface (Master Plan §14).
// Atomic Orange (the frontend pillar) consumes this JSON later; this module
// only produces it.
//
// Shape (stable):
//   {
//     schema: "orange5.control-plane.health.v1",
//     generated_at: ISO-8601,
//     uptime_ms: <ms since process start>,      // process.uptime()*1000, floored
//     receipts: {
//       total:     <int>,                        // rows in the chain table
//       last_hash: <hex|null>,                   // chain head (tamper-evident tip)
//       integrity: { ok, mode, broken_links, tampered }  // compact roll-up
//     },
//     adapters: {
//       registered: <int>,
//       ready:      <int>,
//       by_status:  { READY, PLANNED, MISSING, DISABLED, ... },
//       list:       [{ id, name, lane, status }]
//     },
//     warm_lanes: [ <lane> ... ]                 // distinct lanes of READY adapters
//   }
//
// Every field degrades gracefully: a missing DB, a missing chain table, or a
// registry that will not load each yield a null/empty value plus a note, never
// a thrown error. A health getter that throws is not a health getter.

import { verifyChain } from "./receipt-integrity.mjs";

export const HEALTH_SCHEMA = "orange5.control-plane.health.v1";

// Frozen at module load: the earliest observable start for this process.
const PROCESS_START_MS = Date.now() - Math.floor((globalThis.process?.uptime?.() ?? 0) * 1000);

function uptimeMs() {
  const up = globalThis.process?.uptime?.();
  if (typeof up === "number" && Number.isFinite(up)) return Math.floor(up * 1000);
  return Math.max(0, Date.now() - PROCESS_START_MS);
}

/**
 * Summarize the adapter registry into counts + a compact list.
 * @param {Array<{id,name,lane,status}>} listed  output of registry.list()
 */
function summarizeAdapters(listed) {
  const by_status = {};
  const warm = new Set();
  let ready = 0;
  for (const a of listed) {
    const status = a?.status ?? "UNKNOWN";
    by_status[status] = (by_status[status] || 0) + 1;
    if (status === "READY") {
      ready++;
      if (a?.lane) warm.add(a.lane);
    }
  }
  return {
    adapters: {
      registered: listed.length,
      ready,
      by_status,
      list: listed.map((a) => ({
        id: a?.id ?? null,
        name: a?.name ?? null,
        lane: a?.lane ?? null,
        status: a?.status ?? null,
      })),
    },
    warm_lanes: Array.from(warm).sort(),
  };
}

/**
 * Load the default adapter registry lazily. Kept in a try so a registry-side
 * import/init fault degrades to "0 adapters" rather than sinking the snapshot.
 * Returns { listed, note }.
 */
async function loadRegistry() {
  try {
    const mod = await import("./src/registry.mjs");
    if (typeof mod.createDefaultRegistry === "function") {
      // createDefaultRegistry() is idempotent-ish (re-registers same ids into a
      // Map); calling it guarantees the four defaults are present, then list().
      mod.createDefaultRegistry();
      return { listed: mod.list(), note: null };
    }
    if (typeof mod.list === "function") return { listed: mod.list(), note: "registry_not_initialized" };
    return { listed: [], note: "registry_shape_unexpected" };
  } catch (err) {
    return { listed: [], note: `registry_unavailable: ${err.message}` };
  }
}

/**
 * Produce the health snapshot.
 *
 * @param {object} [opts]
 * @param {any}    [opts.db]        open #sqlite handle. If omitted, receipts
 *                                  metrics are null (no DB coupling forced).
 * @param {string} [opts.table]     chain table name (default 'receipts').
 * @param {Array}  [opts.adapters]  pre-listed adapters (inject to avoid the
 *                                  dynamic registry import in tests). If given,
 *                                  the registry is NOT loaded.
 * @returns {Promise<object>} health JSON
 */
export async function snapshot({ db = null, table = "receipts", adapters = null } = {}) {
  const notes = [];

  // ---- receipts + integrity -------------------------------------------------
  let receipts = { total: null, last_hash: null, integrity: null };
  if (db && typeof db.prepare === "function") {
    try {
      const chain = verifyChain({ db, table });
      receipts = {
        total: chain.total,
        last_hash: chain.head_hash,
        integrity: {
          ok: chain.ok,
          mode: chain.mode,
          broken_links: chain.broken_links.length,
          tampered: chain.tampered.length,
        },
      };
    } catch (err) {
      notes.push(`receipts_unavailable: ${err.message}`);
    }
  } else {
    notes.push("no_db_handle");
  }

  // ---- adapters -------------------------------------------------------------
  let listed = adapters;
  if (listed == null) {
    const reg = await loadRegistry();
    listed = reg.listed;
    if (reg.note) notes.push(reg.note);
  }
  const { adapters: adapterBlock, warm_lanes } = summarizeAdapters(listed);

  const out = {
    schema: HEALTH_SCHEMA,
    generated_at: new Date().toISOString(),
    uptime_ms: uptimeMs(),
    receipts,
    adapters: adapterBlock,
    warm_lanes,
  };
  if (notes.length) out.notes = notes;
  return out;
}

export default { snapshot, HEALTH_SCHEMA };
