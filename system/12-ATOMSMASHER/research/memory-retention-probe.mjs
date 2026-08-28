// Secondary probe: identify what's held in long-lived state.
// READ-ONLY against production sources — does not modify any engine.

import { Store } from '../full-scope/storage.mjs';
import { demo } from '../full-scope/engines.mjs';

function gc() {
  if (typeof Bun !== 'undefined' && typeof Bun.gc === 'function') {
    try { Bun.gc(true); } catch {}
  }
}

const store = new Store(':memory:');
const result = demo(store);

gc();
const mem = process.memoryUsage();

// Probe Store internals (no source modification — just read what's reachable).
const stmtCount = store._stmts ? store._stmts.size : 0;
let stmtKeysTotalBytes = 0;
if (store._stmts) {
  for (const k of store._stmts.keys()) stmtKeysTotalBytes += Buffer.byteLength(k, 'utf8');
}

// Sqlite row counts (cheap)
const rowCounts = {};
for (const t of [
  'meta', 'features', 'receipts', 'sources', 'chunks', 'coverage_receipts',
  'orders', 'heat_items', 'atoms', 'equations', 'caches', 'cartridges',
  'routes', 'saved_work', 'debt', 'runtime_profiles', 'agent_leases',
]) {
  try {
    rowCounts[t] = store.one(`SELECT COUNT(*) c FROM ${t}`).c;
  } catch { rowCounts[t] = 'err'; }
}

// Sample 5 receipts to measure typical payload size
const sample = store.all('SELECT id, action, status, summary, payload_json, created_at FROM receipts ORDER BY id LIMIT 5');
const sampleSizes = sample.map(r => ({
  id_bytes: Buffer.byteLength(String(r.id || '')),
  action_bytes: Buffer.byteLength(String(r.action || '')),
  summary_bytes: Buffer.byteLength(String(r.summary || '')),
  payload_bytes: Buffer.byteLength(String(r.payload_json || '')),
  created_at_bytes: Buffer.byteLength(String(r.created_at || '')),
  total: Buffer.byteLength(String(r.id || ''))
    + Buffer.byteLength(String(r.action || ''))
    + Buffer.byteLength(String(r.status || ''))
    + Buffer.byteLength(String(r.summary || ''))
    + Buffer.byteLength(String(r.payload_json || ''))
    + Buffer.byteLength(String(r.created_at || '')),
}));

// Average payload size across ALL receipts
const allPayloadStats = store.one(`
  SELECT
    COUNT(*) AS n,
    SUM(LENGTH(COALESCE(action, ''))) AS action_b,
    SUM(LENGTH(COALESCE(status, ''))) AS status_b,
    SUM(LENGTH(COALESCE(summary, ''))) AS summary_b,
    SUM(LENGTH(COALESCE(payload_json, ''))) AS payload_b,
    SUM(LENGTH(COALESCE(created_at, ''))) AS ts_b,
    AVG(LENGTH(COALESCE(payload_json, ''))) AS avg_payload_b,
    MAX(LENGTH(COALESCE(payload_json, ''))) AS max_payload_b
  FROM receipts
`);

// Top 5 largest payloads (and what action they belong to)
const topPayloads = store.all(`
  SELECT action, LENGTH(payload_json) AS sz, SUBSTR(summary, 1, 80) AS s
  FROM receipts ORDER BY LENGTH(payload_json) DESC LIMIT 5
`);

// Distribution of payload sizes by action
const byAction = store.all(`
  SELECT action, COUNT(*) AS n,
         AVG(LENGTH(payload_json)) AS avg_b,
         SUM(LENGTH(payload_json)) AS total_b
  FROM receipts GROUP BY action
  ORDER BY total_b DESC LIMIT 15
`);

console.log(JSON.stringify({
  memory_after_demo: {
    heapTotal_MB: +(mem.heapTotal / 1024 / 1024).toFixed(2),
    external_MB: +(mem.external / 1024 / 1024).toFixed(2),
    rss_MB: +(mem.rss / 1024 / 1024).toFixed(2),
  },
  store_internals: {
    _stmts_cached_count: stmtCount,
    _stmts_keys_total_bytes: stmtKeysTotalBytes,
    _stmts_keys_total_KB: +(stmtKeysTotalBytes / 1024).toFixed(2),
  },
  sqlite_row_counts: rowCounts,
  receipt_size_sample_first_5: sampleSizes,
  receipt_size_aggregate: allPayloadStats,
  receipt_size_aggregate_MB: {
    total_payload_MB: +(allPayloadStats.payload_b / 1024 / 1024).toFixed(2),
    avg_payload_bytes: Math.round(allPayloadStats.avg_payload_b || 0),
    max_payload_bytes: allPayloadStats.max_payload_b,
  },
  top_5_largest_payloads: topPayloads,
  per_action_payload_top_15: byAction,
}, null, 2));

store.close();
