// AtomSmasher Full-Scope — storage layer
// Faithful Bun port of `atomsmasher_full_scope_v1_0/atomsmasher/storage.py`.
// Uses Orange5 sqlite-shim (bun:sqlite, Bun-only per operator law).

import Database from '../../bin/sqlite-shim.mjs';
import crypto from 'node:crypto';
import { SCHEMA_VERSION } from './version.mjs';
import { FEATURE_NAMES } from './feature_data.mjs';
import { sha256Text, nowIso, slugify } from './utils.mjs';

// PRAGMAs are applied imperatively in init() based on path (memory vs file).
// Keeping them out of SCHEMA prevents the file-tuned pragmas (synchronous=NORMAL,
// WAL) from clobbering the memory-tuned pragmas (synchronous=OFF, journal=MEMORY).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS features(
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    engine TEXT NOT NULL,
    heat_default TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS receipts(
    id TEXT PRIMARY KEY,
    feature_id TEXT,
    action TEXT NOT NULL,
    status TEXT NOT NULL,
    summary TEXT,
    payload_json TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sources(
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    source_type TEXT NOT NULL,
    text TEXT NOT NULL,
    text_hash TEXT NOT NULL,
    raw_bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks(
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    heading TEXT,
    text TEXT NOT NULL,
    text_hash TEXT NOT NULL,
    token_estimate INTEGER NOT NULL,
    heat TEXT NOT NULL DEFAULT 'COOL'
);
CREATE TABLE IF NOT EXISTS coverage_receipts(
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    raw_stored_pct REAL,
    chunked_pct REAL,
    indexed_pct REAL,
    mapped_pct REAL,
    table_scanned INTEGER,
    equation_scanned INTEGER,
    atomized_count INTEGER,
    hot_count INTEGER,
    sleeping_recoverable INTEGER,
    payload_json TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders(
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    authority TEXT NOT NULL,
    scope TEXT NOT NULL,
    heat TEXT NOT NULL DEFAULT 'HOT_ALWAYS',
    priority REAL NOT NULL DEFAULT 1.0,
    active INTEGER NOT NULL DEFAULT 1,
    superseded_by TEXT,
    source_id TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS heat_items(
    id TEXT PRIMARY KEY,
    item_type TEXT NOT NULL,
    item_id TEXT NOT NULL,
    heat TEXT NOT NULL,
    reason TEXT NOT NULL,
    risk_if_demoted REAL DEFAULT 0.0,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS atoms(
    id TEXT PRIMARY KEY,
    atom_type TEXT NOT NULL,
    content TEXT NOT NULL,
    authority TEXT NOT NULL,
    scope TEXT NOT NULL,
    source_type TEXT NOT NULL,
    confidence REAL NOT NULL,
    future_force REAL NOT NULL,
    risk_if_lost REAL NOT NULL,
    heat TEXT NOT NULL,
    evidence_json TEXT,
    air TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS equations(
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    equation_type TEXT NOT NULL,
    formula TEXT NOT NULL,
    parameters_json TEXT NOT NULL,
    residuals_json TEXT NOT NULL,
    max_error REAL NOT NULL,
    mean_error REAL NOT NULL,
    source_pointer TEXT,
    reconstruction_hash TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS caches(
    id TEXT PRIMARY KEY,
    cache_type TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    value_json TEXT NOT NULL,
    authority TEXT NOT NULL,
    heat TEXT NOT NULL,
    hits INTEGER NOT NULL DEFAULT 0,
    stale INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cartridges(
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    domain TEXT NOT NULL,
    atom_ids_json TEXT NOT NULL,
    air TEXT NOT NULL,
    heat TEXT NOT NULL,
    hit_rate REAL DEFAULT 0.0,
    saved_work_total REAL DEFAULT 0.0,
    staleness_score REAL DEFAULT 0.0,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS routes(
    id TEXT PRIMARY KEY,
    query TEXT NOT NULL,
    selected_path TEXT NOT NULL,
    energy_score REAL NOT NULL,
    workset_json TEXT NOT NULL,
    warrants_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS saved_work(
    id TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    old_path_estimate TEXT NOT NULL,
    new_path TEXT NOT NULL,
    tokens_not_injected INTEGER NOT NULL,
    model_calls_avoided INTEGER NOT NULL,
    commitments_preserved INTEGER NOT NULL,
    payload_json TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS debt(
    id TEXT PRIMARY KEY,
    debt_type TEXT NOT NULL,
    object_type TEXT NOT NULL,
    object_id TEXT NOT NULL,
    severity REAL NOT NULL,
    description TEXT NOT NULL,
    resolved INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runtime_profiles(
    id TEXT PRIMARY KEY,
    runtime TEXT NOT NULL,
    model TEXT NOT NULL,
    profile_json TEXT NOT NULL,
    score REAL NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_leases(
    id TEXT PRIMARY KEY,
    agent_name TEXT NOT NULL,
    mission TEXT NOT NULL,
    token_budget INTEGER NOT NULL,
    time_budget_s INTEGER NOT NULL,
    stop_conditions_json TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(id UNINDEXED, source_id UNINDEXED, text);
CREATE INDEX IF NOT EXISTS idx_receipts_action ON receipts(action);
CREATE INDEX IF NOT EXISTS idx_receipts_status ON receipts(status);
CREATE INDEX IF NOT EXISTS idx_receipts_feature_id ON receipts(feature_id);
-- NOTE: no idx_receipts_created_at — the only ORDER BY created_at consumer is
-- exportCompressedAuditLog which does a full-table read; a covering index would
-- force per-row seeks and slow that scan ~30%. Plain table scan wins here.
`;

export class Store {
  // Allowed receipt status values (Part A schema gate, 2026-06-27).
  // Live corpus uses only 'ok' and 'error'; 'warn' and 'pending' added per the
  // storage-API hardening contract for future ops-grade workflows.
  static ALLOWED_STATUSES = new Set(['ok', 'error', 'warn', 'pending']);

  // Hidden-payload defense caps (E3 fix, 2026-06-28).
  // Exp E3 (research/compression/experiments/E3-adversarial-emoji-fuzz/) found
  // the schema gate accepted 8/12 hidden-payload attacks where invisible
  // variation selectors / tag chars / ZWJ-joined sequences smuggled multi-KB
  // of attacker-controlled bytes into a field that visibly rendered as 1 glyph.
  //
  // Defense: for every receipt text field, check BOTH the codepoint count
  // ([...str].length — variation selectors EACH count, which is the load-bearing
  // property that catches the VS-bomb attack) AND the UTF-8 byte length.
  // Either exceeding caps -> reject with a single, deterministic error message.
  //
  // Defaults are conservative against the live corpus:
  //   - action: keyed identifier, short by design (<=64cp / <=256B)
  //   - summary: human prose, short receipts in this engine (<=512cp / <=4096B)
  //   - payload_json: structured JSON, may carry small reports (<=16384B)
  //
  // Override via constructor: new Store(':memory:', { schemaCaps: { ... } }).
  static DEFAULT_SCHEMA_CAPS = Object.freeze({
    ACTION_MAX_CP: 64,
    ACTION_MAX_BYTES: 256,
    SUMMARY_MAX_CP: 512,
    SUMMARY_MAX_BYTES: 4096,
    PAYLOAD_MAX_BYTES: 16384,
  });

  constructor(path = ':memory:', opts = {}) {
    this.path = String(path);
    this.conn = new Database(this.path);
    // SUPERIORITY OPT: cache prepared statements by SQL text to skip prepare() in
    // hot paths (execute/one/all/insertReceipt). Without this, every call to
    // execute() re-prepares, which on Windows + Bun adds ~25µs per call.
    this._stmts = new Map();
    // E3 fix: merge operator-supplied schema caps over the safe defaults.
    // Only known keys are honored — unknown keys are ignored to keep the cap
    // surface deterministic across versions.
    const userCaps = (opts && typeof opts === 'object' && opts.schemaCaps && typeof opts.schemaCaps === 'object')
      ? opts.schemaCaps : {};
    this._caps = Object.freeze({
      ACTION_MAX_CP:    Number.isFinite(userCaps.ACTION_MAX_CP)    ? (userCaps.ACTION_MAX_CP    | 0) : Store.DEFAULT_SCHEMA_CAPS.ACTION_MAX_CP,
      ACTION_MAX_BYTES: Number.isFinite(userCaps.ACTION_MAX_BYTES) ? (userCaps.ACTION_MAX_BYTES | 0) : Store.DEFAULT_SCHEMA_CAPS.ACTION_MAX_BYTES,
      SUMMARY_MAX_CP:   Number.isFinite(userCaps.SUMMARY_MAX_CP)   ? (userCaps.SUMMARY_MAX_CP   | 0) : Store.DEFAULT_SCHEMA_CAPS.SUMMARY_MAX_CP,
      SUMMARY_MAX_BYTES:Number.isFinite(userCaps.SUMMARY_MAX_BYTES)? (userCaps.SUMMARY_MAX_BYTES| 0) : Store.DEFAULT_SCHEMA_CAPS.SUMMARY_MAX_BYTES,
      PAYLOAD_MAX_BYTES:Number.isFinite(userCaps.PAYLOAD_MAX_BYTES)? (userCaps.PAYLOAD_MAX_BYTES| 0) : Store.DEFAULT_SCHEMA_CAPS.PAYLOAD_MAX_BYTES,
    });
    this.init();
  }

  // Cached prepare — reuses statement for identical SQL across the connection.
  _prep(sql) {
    let s = this._stmts.get(sql);
    if (!s) { s = this.conn.prepare(sql); this._stmts.set(sql, s); }
    return s;
  }

  init() {
    // SUPERIORITY OPT: PRAGMA tuning before schema creation so cache/mmap are set
    // up before any index DDL runs. Memory dbs get the in-RAM profile; disk dbs
    // get WAL + relaxed sync + 64MB cache + 256MB mmap.
    //
    // AUDIT-07 FIX (2026-06-27): `PRAGMA busy_timeout = 5000` added for file DBs.
    // Without it, two Bun processes writing the same file dropped ~46.8% of
    // receipts as silent SQLITE_BUSY (data loss in the audit ledger). With a
    // 5s busy_timeout, SQLite serializes contended writers transparently and
    // measured loss drops to 0 under the same 2-proc / 500-insert stress.
    if (this.path === ':memory:') {
      try { this.conn.exec("PRAGMA journal_mode=MEMORY; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-64000;"); } catch { /* noop */ }
    } else {
      // AUDIT-08 FIX (2026-06-27): Retry PRAGMA setup on SQLITE_BUSY/LOCKED.
      // When two processes open a fresh file DB simultaneously, the
      // `journal_mode = WAL` PRAGMA can return SQLITE_BUSY while the other
      // process is creating the -wal / -shm files. Without this retry, worker A
      // crashes inside the Store ctor and the concurrency test flakes ~4%.
      // bun:sqlite is synchronous, so we use Bun.sleepSync (not setTimeout).
      let initAttempts = 0;
      const MAX_INIT_ATTEMPTS = 10;
      while (true) {
        try {
          this.conn.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-64000; PRAGMA mmap_size=268435456;");
          break;
        } catch (e) {
          initAttempts++;
          const msg = String(e?.message ?? e);
          if (initAttempts >= MAX_INIT_ATTEMPTS || !/BUSY|LOCKED/i.test(msg)) {
            // Either we've exhausted retries or it's not a contention error.
            // Match prior behavior: swallow non-fatal init pragma failures so
            // the connection still gets a working schema.
            break;
          }
          // Exponential backoff with jitter: 2^attempt * 5ms + random(0..5ms).
          const sleepMs = (1 << initAttempts) * 5 + (Date.now() % 5);
          if (typeof Bun !== 'undefined' && typeof Bun.sleepSync === 'function') {
            Bun.sleepSync(sleepMs);
          } else {
            try {
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);
            } catch { /* SharedArrayBuffer unavailable — fall through */ }
          }
        }
      }
    }
    this.conn.exec(SCHEMA);
    // AUDIT-07 FIX (2026-06-27): `init()`-time idempotence. If the meta row
    // already exists at the right schema_version, skip the two writes (and the
    // 620-row registerFeatures sweep). This eliminates the second source of
    // SQLITE_BUSY: a reader's `new Store()` no longer issues writes when the
    // db is already initialized. registerFeatures is also gated, so reopening
    // an initialized DB is now effectively read-only inside init().
    const existing = this._prep("SELECT value FROM meta WHERE key='schema_version'").get();
    if (existing && String(existing.value) === String(SCHEMA_VERSION)) {
      // Already initialized at this schema version — skip the meta writes and
      // skip registerFeatures (CREATE TABLE IF NOT EXISTS above is idempotent
      // and DDL-only; no row writes needed on reopen).
      this._insertReceiptStmt = this._prep(
        'INSERT INTO receipts(id,feature_id,action,status,summary,payload_json,created_at) VALUES(?,?,?,?,?,?,?)'
      );
      return;
    }
    this._prep("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version',?)").run(String(SCHEMA_VERSION));
    this._prep("INSERT OR REPLACE INTO meta(key,value) VALUES('system_law',?)").run('Only smart work is done.');
    // Pre-prepare the receipts insert — used on every insertReceipt() call.
    this._insertReceiptStmt = this._prep(
      'INSERT INTO receipts(id,feature_id,action,status,summary,payload_json,created_at) VALUES(?,?,?,?,?,?,?)'
    );
    this.registerFeatures();
  }

  registerFeatures() {
    const insert = this.conn.prepare(`
      INSERT OR IGNORE INTO features(id,name,category,engine,heat_default,created_at)
      VALUES(?,?,?,?,?,?)
    `);
    // SUPERIORITY OPT: wrap 620 inserts in a single transaction.
    // bun:sqlite auto-commits per statement by default — without this wrap, init
    // takes ~15s on Windows. With this wrap, it drops to <1s.
    const ts = nowIso();
    try {
      const tx = this.conn.transaction((names) => {
        for (let i = 0; i < names.length; i++) {
          const idx = i + 1;
          const name = names[i];
          const fid = `feat_${String(idx).padStart(4, '0')}_${slugify(name).slice(0, 40)}`;
          const [category, engine, heat] = classifyFeature(name);
          insert.run(fid, name, category, engine, heat, ts);
        }
      });
      tx(FEATURE_NAMES);
    } finally {
      // This statement is intentionally outside the shared cache because it is
      // initialization-only. Release its native handle immediately so a fresh
      // file database can be closed or moved on Windows without an EBUSY leak.
      try { insert.finalize?.(); } catch { /* already finalized */ }
    }
  }

  // Convenience methods mirroring the Python Store.
  // SUPERIORITY OPT: route through _prep() for prepared-statement caching.
  execute(sql, params = []) {
    return this._prep(sql).run(...params);
  }

  one(sql, params = []) {
    return this._prep(sql).get(...params) ?? null;
  }

  all(sql, params = []) {
    return this._prep(sql).all(...params);
  }

  close() {
    // Prepared statements hold native SQLite handles on Windows. Clearing the
    // JavaScript Map does not deterministically release those handles, which
    // can leave the database (and its parent directory) locked after close.
    // Finalize every cached statement before closing the connection.
    if (this._stmts) {
      for (const statement of this._stmts.values()) {
        try { statement.finalize?.(); } catch { /* already finalized */ }
      }
      this._stmts.clear();
    }
    try { this.conn.close(true); } catch { /* noop */ }
  }

  /**
   * Insert a receipt row.
   *
   * Determinism contract (PERFECT_SYNTHESIS Law 1):
   * Receipt IDs are SEQUENCE-deterministic, not CONTENT-deterministic.
   * Two runs with the same ATOMSMASHER_DETERMINISM_SEED that execute the same
   * call sequence (same insertReceipt calls in same order) produce identical IDs.
   * The same receipt CONTENT at a different position yields a different ID.
   * Do NOT use receipt IDs as content-addressable hashes.
   *
   * @param {string} action — non-empty, no whitespace
   * @param {string} status — one of {ok, error, warn, pending}
   * @param {string} summary — must be a string (can be empty)
   * @param {object|string|null} payload — null, object, or JSON-parseable string
   * @param {string|null} featureId — optional feature foreign key
   * @returns {string} receipt id (`rcpt_<16hex>`)
   */
  insertReceipt(action, status = 'ok', summary = '', payload = null, featureId = null) {
    // Schema validation gate (Part A — added 2026-06-27):
    // FAIL-FAST O(1) checks BEFORE touching SQLite. No partial inserts.
    // Set established from live corpus scan (demo() produces only 'ok'|'error'),
    // expanded to {ok, error, warn, pending} per storage-api hardening contract.
    if (typeof action !== 'string' || action.length === 0) {
      throw new Error('Receipt schema violation: action must be a non-empty string');
    }
    if (/\s/.test(action)) {
      throw new Error('Receipt schema violation: action must not contain whitespace');
    }
    if (!Store.ALLOWED_STATUSES.has(status)) {
      throw new Error(`Receipt schema violation: status must be one of {ok,error,warn,pending}, got ${JSON.stringify(status)}`);
    }
    if (typeof summary !== 'string') {
      throw new Error('Receipt schema violation: summary must be a string');
    }
    // E3 hidden-payload defense (added 2026-06-28).
    // Cap action + summary on BOTH codepoint count and UTF-8 byte length.
    // The codepoint check is what catches the variation-selector bomb attack:
    // a 100KB payload of VS chars renders as 1 visible glyph but has 100K
    // codepoints, so [...str].length flags it instantly.
    const caps = this._caps;
    const actionCp = [...action].length;
    if (actionCp > caps.ACTION_MAX_CP) {
      throw new Error(`Receipt schema violation: action exceeds cap (codepoints=${actionCp}, max=${caps.ACTION_MAX_CP})`);
    }
    const actionBytes = Buffer.byteLength(action, 'utf8');
    if (actionBytes > caps.ACTION_MAX_BYTES) {
      throw new Error(`Receipt schema violation: action exceeds cap (utf8_bytes=${actionBytes}, max=${caps.ACTION_MAX_BYTES})`);
    }
    const summaryCp = [...summary].length;
    if (summaryCp > caps.SUMMARY_MAX_CP) {
      throw new Error(`Receipt schema violation: summary exceeds cap (codepoints=${summaryCp}, max=${caps.SUMMARY_MAX_CP})`);
    }
    const summaryBytes = Buffer.byteLength(summary, 'utf8');
    if (summaryBytes > caps.SUMMARY_MAX_BYTES) {
      throw new Error(`Receipt schema violation: summary exceeds cap (utf8_bytes=${summaryBytes}, max=${caps.SUMMARY_MAX_BYTES})`);
    }
    // payload: null/undefined/object/JSON-parseable-string accepted. Reject
    // non-string primitives and reject malformed JSON strings up front so the
    // INSERT never sees a half-shaped row.
    if (payload !== null && payload !== undefined) {
      const t = typeof payload;
      if (t === 'string') {
        try { JSON.parse(payload); }
        catch { throw new Error('Receipt schema violation: payload string is not JSON-parseable'); }
      } else if (t !== 'object') {
        throw new Error(`Receipt schema violation: payload must be null, an object, or a JSON-parseable string (got ${t})`);
      }
    }
    // E3 hidden-payload defense (payload byte cap).
    // We must cap the SERIALIZED payload — not the in-memory object — because
    // sqlite stores the JSON string. Compute the same string we'll INSERT.
    // This means we serialize once and reuse below; the earlier code path
    // re-serialized at INSERT time.
    const payloadJson = (payload === null || payload === undefined)
      ? '{}'
      : (typeof payload === 'string' ? payload : JSON.stringify(payload || {}));
    const payloadBytes = Buffer.byteLength(payloadJson, 'utf8');
    if (payloadBytes > caps.PAYLOAD_MAX_BYTES) {
      throw new Error(`Receipt schema violation: payload_json exceeds cap (utf8_bytes=${payloadBytes}, max=${caps.PAYLOAD_MAX_BYTES})`);
    }

    // Determinism Unlock (PERFECT_SYNTHESIS Law 1): use seed-derived ID when
    // ATOMSMASHER_DETERMINISM_SEED is set so receipts are byte-exact replay-able.
    const detSeed = process.env.ATOMSMASHER_DETERMINISM_SEED;
    let rid;
    if (detSeed) {
      this._detReceiptCounter = (this._detReceiptCounter || 0) + 1;
      rid = 'rcpt_' + sha256Text(`${action}|${detSeed}|${this._detReceiptCounter}|${summary}`).slice(0, 16);
    } else {
      const tsNs = String(process.hrtime.bigint());
      const rnd = crypto.randomUUID().replace(/-/g, '');
      rid = 'rcpt_' + sha256Text(`${action}|${tsNs}|${summary}|${rnd}`).slice(0, 16);
    }
    // Payload serialization: pre-validated above. `payloadJson` was already
    // computed (and byte-capped) during E3 schema gate; reuse it verbatim so
    // we don't double-serialize. JSON-string passthrough is preserved.
    // SUPERIORITY OPT: pre-prepared statement reused across every receipt insert.
    this._insertReceiptStmt.run(rid, featureId, action, status, summary, payloadJson, nowIso());
    return rid;
  }

  // ---------------------------------------------------------------------------
  // Part B — additive query methods (added 2026-06-27).
  // Read-only views over the receipts table for ops dashboards / observability.
  // ---------------------------------------------------------------------------

  /**
   * Receipts filtered by exact action match, ordered newest first.
   * @param {string} action — exact action label, e.g. 'mesh.compress'
   * @param {object} opts — { limit, offset }
   * @returns {Array<object>} receipts rows
   */
  getReceiptsByAction(action, { limit = 100, offset = 0 } = {}) {
    if (typeof action !== 'string' || action.length === 0) {
      throw new Error('getReceiptsByAction: action must be a non-empty string');
    }
    const lim = Math.max(0, Math.min(10000, Number(limit) | 0));
    const off = Math.max(0, Number(offset) | 0);
    return this.all(
      'SELECT id,feature_id,action,status,summary,payload_json,created_at FROM receipts WHERE action=? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
      [action, lim, off]
    );
  }

  /**
   * Receipts whose created_at falls in [fromIso, toIso] inclusive, oldest first.
   * Bounds are passed verbatim to SQLite — pass ISO-8601 timestamps that sort lexically.
   * @param {string} fromIso — lower bound (inclusive)
   * @param {string} toIso — upper bound (inclusive)
   * @param {object} opts — { limit }
   * @returns {Array<object>} receipts rows
   */
  getReceiptsByTimeRange(fromIso, toIso, { limit = 100 } = {}) {
    if (typeof fromIso !== 'string' || typeof toIso !== 'string') {
      throw new Error('getReceiptsByTimeRange: fromIso and toIso must be strings');
    }
    const lim = Math.max(0, Math.min(10000, Number(limit) | 0));
    return this.all(
      'SELECT id,feature_id,action,status,summary,payload_json,created_at FROM receipts WHERE created_at>=? AND created_at<=? ORDER BY created_at ASC, id ASC LIMIT ?',
      [fromIso, toIso, lim]
    );
  }

  /**
   * Receipts whose summary contains a substring (LIKE %substring%).
   * @param {string} substring — needle (escaped for LIKE metacharacters)
   * @param {object} opts — { limit }
   * @returns {Array<object>} receipts rows
   */
  searchReceiptsBySummary(substring, { limit = 100 } = {}) {
    if (typeof substring !== 'string') {
      throw new Error('searchReceiptsBySummary: substring must be a string');
    }
    const lim = Math.max(0, Math.min(10000, Number(limit) | 0));
    // Escape LIKE wildcards in the user input so '%' / '_' / '\' are literal.
    const escaped = substring.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    return this.all(
      "SELECT id,feature_id,action,status,summary,payload_json,created_at FROM receipts WHERE summary LIKE ? ESCAPE '\\' ORDER BY created_at DESC, id DESC LIMIT ?",
      [`%${escaped}%`, lim]
    );
  }

  /**
   * Aggregate counts for ops dashboards.
   *
   * AUDIT-07 FIX (2026-06-27): atomic snapshot. Without an enclosing
   * transaction, the three counts could see different WAL snapshots under live
   * writes (observed: `total=192, sum_by_status=193`). They are now read inside
   * a single `BEGIN DEFERRED ... COMMIT` so all three aggregates resolve
   * against the same point-in-time view.
   *
   * @returns {{total:number, by_action:Object<string,number>, by_status:Object<string,number>}}
   */
  getReceiptStats() {
    let totalRow, byActionRows, byStatusRows;
    // bun:sqlite exposes db.transaction(fn) — a callable wrapper that runs the
    // function inside an implicit BEGIN/COMMIT (DEFERRED by default), which is
    // what we want: a read-only snapshot under WAL with no extra locking.
    const tx = this.conn.transaction(() => {
      totalRow = this.one('SELECT COUNT(*) c FROM receipts');
      byActionRows = this.all('SELECT action, COUNT(*) c FROM receipts GROUP BY action');
      byStatusRows = this.all('SELECT status, COUNT(*) c FROM receipts GROUP BY status');
    });
    tx();
    const by_action = {};
    for (const r of byActionRows) by_action[r.action] = r.c;
    const by_status = {};
    for (const r of byStatusRows) by_status[r.status] = r.c;
    return { total: totalRow?.c ?? 0, by_action, by_status };
  }

  // Production audit-log export: lossless, hydratable, honestly measured.
  // Earlier Method 19 decomposition was excellent as a research measurement, but
  // the production export dropped receipt ids and normalized payload_json while
  // still advertising byte-exact losslessness. The live path now emits the
  // canonical receipt JSONL under Brotli and proves it can hydrate back to the
  // exact bytes before returning.
  exportCompressedAuditLog(opts = {}) {
    const zlib = require('node:zlib');
    const brotli11 = b => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
    const varintU = n => { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return b; };

    const maxReceipts = Math.max(1, Number(opts.maxReceipts ?? 50000) | 0);
    const maxOriginalBytes = Math.max(1024, Number(opts.maxOriginalBytes ?? (64 * 1024 * 1024)) | 0);
    const batchSize = Math.max(1, Math.min(5000, Number(opts.batchSize ?? 1000) | 0));

    const readSnapshot = this.conn.transaction(() => {
      const chunks = [];
      let originalBytes = 0;
      let nReceipts = 0;
      let lastCreatedAt = '';
      let lastId = '';

      while (true) {
        const rows = this.all(
          `SELECT id,feature_id,action,status,summary,payload_json,created_at
           FROM receipts
           WHERE created_at > ? OR (created_at = ? AND id > ?)
           ORDER BY created_at, id
           LIMIT ?`,
          [lastCreatedAt, lastCreatedAt, lastId, batchSize]
        );
        if (rows.length === 0) break;
        for (const r of rows) {
          if (nReceipts >= maxReceipts) {
            throw new Error(`exportCompressedAuditLog: receipt cap exceeded (maxReceipts=${maxReceipts})`);
          }
          const line = JSON.stringify(r) + '\n';
          const lineBytes = Buffer.byteLength(line, 'utf8');
          if (originalBytes + lineBytes > maxOriginalBytes) {
            throw new Error(`exportCompressedAuditLog: original byte cap exceeded (maxOriginalBytes=${maxOriginalBytes})`);
          }
          chunks.push(line);
          originalBytes += lineBytes;
          nReceipts++;
          lastCreatedAt = r.created_at;
          lastId = r.id;
        }
      }
      return { chunks, originalBytes, nReceipts };
    });
    const { chunks, originalBytes, nReceipts } = readSnapshot();

    if (nReceipts === 0) {
      const emptySha256 = sha256Text('');
      const protectedFields = ['id', 'feature_id', 'action', 'status', 'summary', 'payload_json', 'created_at'];
      return {
        encoded: Buffer.alloc(0), encodedBytes: 0, originalBytes: 0, ratio: 1, components: {}, n_receipts: 0,
        originalSha256: emptySha256,
        hydration_proof: {
          lossless: true, sha256_match: true, original_sha256: emptySha256,
          hydrated_sha256: emptySha256, n_receipts: 0, hydrated_receipts: 0,
          protected_fields: protectedFields, ratio_basis: 'encoded_bytes',
        },
      };
    }

    const originalJsonl = chunks.join('');
    const originalSha256 = sha256Text(originalJsonl);
    const sourceJsonlBr = brotli11(Buffer.from(originalJsonl, 'utf8'));
    const components = {
      sourceJsonlBrotli: sourceJsonlBr.length,
    };
    const headerPayload = {
      schema: 'atomsmasher.audit-log.export.v1',
      codec: 'brotli11-jsonl',
      originalBytes,
      originalSha256,
      n_receipts: nReceipts,
      fields: ['id', 'feature_id', 'action', 'status', 'summary', 'payload_json', 'created_at'],
      snapshot: 'sqlite-transaction',
      components,
    };
    const header = Buffer.from(JSON.stringify(headerPayload), 'utf8');
    const encoded = Buffer.concat([
      Buffer.from(varintU(header.length)), header,
      sourceJsonlBr,
    ]);
    const hydrated = Store.hydrateCompressedAuditLog(encoded);
    const hydrationProof = {
      lossless: hydrated.originalSha256 === originalSha256,
      sha256_match: hydrated.originalSha256 === originalSha256,
      original_sha256: originalSha256,
      hydrated_sha256: hydrated.originalSha256,
      n_receipts: nReceipts,
      hydrated_receipts: hydrated.n_receipts,
      protected_fields: headerPayload.fields,
      ratio_basis: 'encoded_bytes',
    };
    if (!hydrationProof.lossless || hydrated.n_receipts !== nReceipts || hydrated.originalBytes !== originalBytes) {
      throw new Error('exportCompressedAuditLog: hydration proof failed');
    }
    return {
      encoded,
      encodedBytes: encoded.length,
      originalBytes,
      ratio: Number((originalBytes / Math.max(1, encoded.length)).toFixed(3)),
      components: { ...components, header: header.length },
      n_receipts: nReceipts,
      originalSha256,
      hydration_proof: hydrationProof,
    };
  }

  static hydrateCompressedAuditLog(encoded) {
    const zlib = require('node:zlib');
    const buf = Buffer.from(encoded || []);
    if (buf.length === 0) {
      return {
        schema: 'atomsmasher.audit-log.export.v1', codec: 'identity-empty',
        fields: ['id', 'feature_id', 'action', 'status', 'summary', 'payload_json', 'created_at'],
        jsonl: '', receipts: [], originalBytes: 0, originalSha256: sha256Text(''), n_receipts: 0,
      };
    }
    let pos = 0;
    let shift = 0;
    let headerLen = 0;
    while (pos < buf.length) {
      const byte = buf[pos++];
      headerLen |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
      if (shift > 35) throw new Error('hydrateCompressedAuditLog: header varint too long');
    }
    if (headerLen <= 0 || pos + headerLen > buf.length) {
      throw new Error('hydrateCompressedAuditLog: invalid header length');
    }
    const header = JSON.parse(buf.subarray(pos, pos + headerLen).toString('utf8'));
    pos += headerLen;
    if (header.schema !== 'atomsmasher.audit-log.export.v1') {
      throw new Error(`hydrateCompressedAuditLog: unsupported schema ${JSON.stringify(header.schema)}`);
    }
    const expectedFields = ['id', 'feature_id', 'action', 'status', 'summary', 'payload_json', 'created_at'];
    if (JSON.stringify(header.fields) !== JSON.stringify(expectedFields)) {
      throw new Error('hydrateCompressedAuditLog: protected receipt fields mismatch');
    }
    const sourceLen = Number(header.components?.sourceJsonlBrotli ?? 0);
    if (!Number.isInteger(sourceLen) || sourceLen < 0 || pos + sourceLen !== buf.length) {
      throw new Error('hydrateCompressedAuditLog: invalid sourceJsonlBrotli component length');
    }
    const jsonl = zlib.brotliDecompressSync(buf.subarray(pos, pos + sourceLen)).toString('utf8');
    const receipts = jsonl.length === 0 ? [] : jsonl.trimEnd().split('\n').map(line => JSON.parse(line));
    const originalBytes = Buffer.byteLength(jsonl, 'utf8');
    const originalSha256 = sha256Text(jsonl);
    if (originalBytes !== header.originalBytes || originalSha256 !== header.originalSha256 || receipts.length !== header.n_receipts) {
      throw new Error('hydrateCompressedAuditLog: integrity mismatch');
    }
    return {
      schema: header.schema,
      codec: header.codec,
      fields: header.fields,
      jsonl,
      receipts,
      originalBytes,
      originalSha256,
      n_receipts: receipts.length,
    };
  }
}

// classify_feature(name) — port of storage.py:classify_feature.
// Returns [category, engine, heat_default].
export function classifyFeature(name) {
  const n = String(name).toLowerCase();
  const has = (...ks) => ks.some(k => n.includes(k));

  if (has('order', 'hot', 'heat', 'mission', 'supersession', 'showhot', 'showorders', 'whyhot', 'sleeping', 'lostmaingoal')) {
    return ['heat_order_mission', 'heat', (n.includes('order') || n.includes('hot_always')) ? 'HOT_ALWAYS' : 'WARM'];
  }
  if (has('source', 'document', 'chunk', 'coverage', 'ingest', 'retriev', 'rag', 'citation', 'table', 'pdf', 'figure', 'upload', 'findability')) {
    return ['source_retrieval', 'source', 'COOL'];
  }
  if (has('atom', 'commitment', 'air', 'codec', 'rendering', 'authority', 'scope', 'claim')) {
    return ['commitment_codec', 'codec', 'WARM'];
  }
  if (has('equation', 'numeric', 'column', 'residual', 'linear', 'seasonal', 'data', 'unit', 'ratio', 'polynomial', 'distribution', 'matrix')) {
    return ['equation_memory', 'equation', 'WARM'];
  }
  if (has('cache', 'cartridge', 'prefix', 'kv', 'runtime', 'prefill', 'llm', 'vllm', 'sglang', 'llama', 'turboquant', 'tensor', 'lmcache')) {
    return ['cache_runtime', 'cache', 'WARM'];
  }
  if (has('speculat', 'draft', 'vocabulary', 'token')) {
    return ['speculative_inference', 'runtime', 'WARM'];
  }
  if (has('route', 'work', 'warrant', 'least', 'sparse', 'compiler', 'trace', 'friction', 'value', 'usefulbit', 'expansion')) {
    return ['work_routing', 'routing', 'HOT_NOW'];
  }
  if (has('debt', 'verifier', 'proof', 'probe', 'benchmark', 'recall', 'audit', 'receipt', 'integrity', 'memoryisolated')) {
    return ['proof_debt_eval', 'proof', 'WARM'];
  }
  if (has('agent', 'tool', 'skill', 'lease')) {
    return ['agent_tool_governance', 'agent', 'COOL'];
  }
  if (has('code', 'repo', 'symbol', 'aecode', 'patch', 'api', 'build')) {
    return ['code_aecode', 'code', 'WARM'];
  }
  if (has('human', 'attention', 'option', 'dashboard', 'ux', 'answer')) {
    return ['human_attention', 'attention', 'WARM'];
  }
  if (has('gaia', 'energy', 'carbon', 'green', 'telemetry', 'joule', 'metabolism', 'modebudget', 'cooling', 'network')) {
    return ['energy_ecology', 'energy', 'WARM'];
  }
  if (has('awareness', 'invention', 'evolve', 'thought', 'causal', 'unknown', 'optimizer', 'self')) {
    return ['awareness_invention', 'awareness', 'COOL'];
  }
  if (has('mode', 'evidencelevel', 'evidenceladder')) {
    return ['mode_evidence', 'mode', 'WARM'];
  }
  if (has('cube', 'memory', 'temporal', 'valid', 'scope', 'lifecycle')) {
    return ['memory_lifecycle', 'memory', 'WARM'];
  }
  if (has('promptinjection', 'secret', 'security', 'quarantine', 'immune', 'leak', 'trust', 'fence')) {
    return ['security', 'security', 'WARM'];
  }
  return ['core', 'core', 'WARM'];
}
