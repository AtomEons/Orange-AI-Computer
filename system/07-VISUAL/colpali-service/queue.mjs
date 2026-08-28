// OrangeEye Phase-2 — persistent SQLite-backed ingest queue.
//
// Backs the colpali-service so that multi-file ingest (image, PDF, video frame
// batches) cannot OOM Codexa by stampeding the Python worker. A single drain
// loop pops one queued row at a time, runs the existing per-file ingest path,
// and writes status transitions back to SQLite. State survives Bun restarts:
// any row left in `running` at boot is reset to `queued` so the worker can
// re-attempt it (idempotent — caller's job to use stable paths).
//
// Storage:
//   07-VISUAL/queue.db  (sibling of colpali-service/)
//
// Schema:
//   queue(
//     id            INTEGER PRIMARY KEY AUTOINCREMENT,
//     path          TEXT    NOT NULL,        -- absolute path to source file
//     status        TEXT    NOT NULL,        -- queued | running | done | error
//     enqueued_at   INTEGER NOT NULL,        -- epoch ms
//     started_at    INTEGER,                 -- epoch ms, NULL until run
//     finished_at   INTEGER,                 -- epoch ms, NULL until done/error
//     error_msg     TEXT,                    -- NULL unless status=error
//     result_json   TEXT,                    -- ingest result JSON when done
//     attempts      INTEGER NOT NULL DEFAULT 0
//   )
//   index on (status, id)  — drain query needs this hot.
//
// Public surface (used by server.mjs Phase-2 endpoints):
//   const q = openQueue({ dbPath, runner, onTransition });
//   q.enqueue(path)                  -> { id, status }
//   q.enqueueBatch(paths)            -> { ids: number[], status }
//   q.get(id)                        -> row | null
//   q.list({ status?, limit?, offset? }) -> rows[]
//   q.counts()                       -> { queued, running, done, error, total }
//   q.cancel(id)                     -> bool  (only queued rows can cancel)
//   q.purgeFinished({ olderThanMs? }) -> count deleted
//   q.start()                        -> begins drain loop (idempotent)
//   q.stop()                         -> stops drain loop, waits for in-flight
//   q.close()                        -> close db handle
//
// The `runner` callback is `async (row) -> object`. It receives the full row
// and must resolve with a JSON-serializable result (stored in result_json) or
// throw (error_msg = err.message). The runner is responsible for reading the
// file at row.path and dispatching to the appropriate ingest path (image / PDF
// page-split / video-frame batch). The queue itself is path-agnostic.
//
// Concurrency: exactly 1 in-flight task. This is intentional — Codexa runs the
// Python worker on shared CPU+NPU and a second concurrent ColQwen2.5 forward
// pass will OOM on the typical 16 GB box. If you ever want N>1, add a worker
// pool here; do NOT loosen by spawning Python in parallel from the HTTP layer.

import { Database } from "bun:sqlite";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, statSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = join(HERE, "..", "queue.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  path          TEXT    NOT NULL,
  status        TEXT    NOT NULL CHECK (status IN ('queued','running','done','error','cancelled')),
  enqueued_at   INTEGER NOT NULL,
  started_at    INTEGER,
  finished_at   INTEGER,
  error_msg     TEXT,
  result_json   TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_queue_status_id ON queue(status, id);
CREATE INDEX IF NOT EXISTS idx_queue_enqueued ON queue(enqueued_at);
`;

const VALID_STATUS = new Set(["queued", "running", "done", "error", "cancelled"]);

/**
 * Open the queue. Creates the db file + parent dir if missing, applies schema,
 * and resets any `running` rows left by a prior crash back to `queued`.
 *
 * @param {object} opts
 * @param {string} [opts.dbPath]        - override default queue.db location
 * @param {(row: object) => Promise<object>} opts.runner - per-row worker
 * @param {(row: object, event: string) => void} [opts.onTransition] - hook for logs
 * @param {number} [opts.idleSleepMs]   - sleep between empty-queue polls (default 250)
 * @param {number} [opts.maxAttempts]   - retry cap per row (default 1, i.e. no retry)
 */
export function openQueue({
  dbPath = DEFAULT_DB_PATH,
  runner,
  onTransition,
  idleSleepMs = 250,
  maxAttempts = 1,
} = {}) {
  if (typeof runner !== "function") {
    throw new Error("openQueue: runner callback required");
  }
  const absDb = resolvePath(dbPath);
  const parent = dirname(absDb);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });

  const db = new Database(absDb);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);

  // Crash recovery: any row marked `running` at open time belonged to a worker
  // that did not finish. Reset to queued — caller's ingest path must be idempotent
  // on the same source path (the existing image_sha256 acts as the dedup key
  // downstream in Qdrant).
  const resetRunning = db.run(
    `UPDATE queue SET status='queued', started_at=NULL WHERE status='running'`
  );
  if (resetRunning.changes > 0) {
    log(`recovered ${resetRunning.changes} running -> queued`);
  }

  // Prepared statements — hot path.
  const sInsert = db.prepare(
    `INSERT INTO queue (path, status, enqueued_at) VALUES (?, 'queued', ?)`
  );
  const sNext = db.prepare(
    `SELECT * FROM queue WHERE status='queued' ORDER BY id ASC LIMIT 1`
  );
  const sClaim = db.prepare(
    `UPDATE queue
       SET status='running', started_at=?, attempts=attempts+1
       WHERE id=? AND status='queued'`
  );
  const sFinishOk = db.prepare(
    `UPDATE queue
       SET status='done', finished_at=?, result_json=?
       WHERE id=?`
  );
  const sFinishErr = db.prepare(
    `UPDATE queue
       SET status='error', finished_at=?, error_msg=?
       WHERE id=?`
  );
  const sRetry = db.prepare(
    `UPDATE queue
       SET status='queued', started_at=NULL, error_msg=?
       WHERE id=?`
  );
  const sGet = db.prepare(`SELECT * FROM queue WHERE id = ?`);
  const sCancel = db.prepare(
    `UPDATE queue SET status='cancelled', finished_at=? WHERE id=? AND status='queued'`
  );
  const sCounts = db.prepare(
    `SELECT status, COUNT(*) AS n FROM queue GROUP BY status`
  );
  const sPurge = db.prepare(
    `DELETE FROM queue WHERE status IN ('done','error','cancelled') AND finished_at < ?`
  );

  let running = false;
  let stopping = false;
  let drainPromise = null;
  let inFlight = null; // { id, abort?: AbortController }

  function log(msg) {
    // Tagged so it lines up with server.mjs's [colpali] logs.
    console.log(`[colpali:queue] ${msg}`);
  }

  function transition(row, event) {
    if (typeof onTransition === "function") {
      try { onTransition(row, event); } catch (e) {
        log(`onTransition threw (ignored): ${e.message}`);
      }
    }
  }

  function enqueue(path) {
    if (typeof path !== "string" || path.length === 0) {
      throw new Error("enqueue: path required");
    }
    // Stat the file early so callers get a clear 400 if the path is bogus —
    // but DO NOT block enqueue on file readability; queue is durable and a
    // file may appear before drain.
    if (existsSync(path)) {
      try { statSync(path); } catch { /* tolerate races */ }
    }
    const now = Date.now();
    const info = sInsert.run(path, now);
    const id = Number(info.lastInsertRowid);
    transition({ id, path, status: "queued", enqueued_at: now }, "enqueued");
    return { id, status: "queued" };
  }

  function enqueueBatch(paths) {
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new Error("enqueueBatch: non-empty array required");
    }
    const ids = [];
    const tx = db.transaction((items) => {
      const now = Date.now();
      for (const p of items) {
        if (typeof p !== "string" || p.length === 0) {
          throw new Error("enqueueBatch: every path must be a non-empty string");
        }
        const info = sInsert.run(p, now);
        ids.push(Number(info.lastInsertRowid));
      }
    });
    tx(paths);
    return { ids, status: "queued" };
  }

  function get(id) {
    const row = sGet.get(Number(id));
    return row || null;
  }

  function list({ status, limit = 100, offset = 0 } = {}) {
    if (status && !VALID_STATUS.has(status)) {
      throw new Error(`list: invalid status ${status}`);
    }
    const lim = Math.min(Math.max(1, Number(limit) | 0), 1000);
    const off = Math.max(0, Number(offset) | 0);
    if (status) {
      return db
        .prepare(`SELECT * FROM queue WHERE status=? ORDER BY id DESC LIMIT ? OFFSET ?`)
        .all(status, lim, off);
    }
    return db
      .prepare(`SELECT * FROM queue ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(lim, off);
  }

  function counts() {
    const rows = sCounts.all();
    const out = { queued: 0, running: 0, done: 0, error: 0, cancelled: 0, total: 0 };
    for (const r of rows) {
      out[r.status] = r.n;
      out.total += r.n;
    }
    return out;
  }

  function cancel(id) {
    const info = sCancel.run(Date.now(), Number(id));
    return info.changes > 0;
  }

  function purgeFinished({ olderThanMs = 0 } = {}) {
    const cutoff = Date.now() - Math.max(0, Number(olderThanMs) | 0);
    const info = sPurge.run(cutoff);
    return info.changes;
  }

  async function runOne(row) {
    inFlight = { id: row.id };
    transition(row, "running");
    let result;
    try {
      result = await runner(row);
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      // Retry policy: row.attempts already includes the just-finished try
      // (sClaim incremented it). If we still have budget, requeue; otherwise
      // park as error. Default maxAttempts=1 means errors stick (no retry).
      if (row.attempts < maxAttempts) {
        sRetry.run(msg, row.id);
        transition({ ...row, error_msg: msg }, "retry");
        inFlight = null;
        return;
      }
      sFinishErr.run(Date.now(), msg, row.id);
      transition({ ...row, error_msg: msg }, "error");
      inFlight = null;
      return;
    }
    let serialized;
    try {
      serialized = JSON.stringify(result ?? null);
    } catch (e) {
      sFinishErr.run(Date.now(), `result not serializable: ${e.message}`, row.id);
      transition({ ...row, error_msg: e.message }, "error");
      inFlight = null;
      return;
    }
    sFinishOk.run(Date.now(), serialized, row.id);
    transition({ ...row, result_json: serialized }, "done");
    inFlight = null;
  }

  async function drainLoop() {
    log("drain loop started");
    while (!stopping) {
      const row = sNext.get();
      if (!row) {
        await sleep(idleSleepMs);
        continue;
      }
      const claim = sClaim.run(Date.now(), row.id);
      if (claim.changes === 0) {
        // Another opener (shouldn't happen in single-process) grabbed it. Loop.
        continue;
      }
      // Re-read so attempts/started_at are current for the runner.
      const fresh = sGet.get(row.id);
      try {
        await runOne(fresh);
      } catch (e) {
        // runOne handles its own errors; this catch only fires on a bug.
        log(`runOne unexpected throw: ${e.message}`);
      }
    }
    log("drain loop exited");
  }

  function start() {
    if (running) return;
    running = true;
    stopping = false;
    drainPromise = drainLoop().catch((e) => {
      log(`drain loop crashed: ${e.message}`);
      running = false;
    });
  }

  async function stop() {
    if (!running) return;
    stopping = true;
    // Wait for the loop to notice and the in-flight task (if any) to land.
    if (drainPromise) {
      await drainPromise;
      drainPromise = null;
    }
    running = false;
    log("stopped");
  }

  function close() {
    if (running) {
      log("close called while running — forcing stop flag");
      stopping = true;
    }
    try { db.close(); } catch (e) { log(`db close error: ${e.message}`); }
  }

  return {
    enqueue,
    enqueueBatch,
    get,
    list,
    counts,
    cancel,
    purgeFinished,
    start,
    stop,
    close,
    // Introspection — not part of the contracted surface, useful in tests.
    _db: db,
    get isRunning() { return running; },
    get inFlightId() { return inFlight?.id ?? null; },
    get dbPath() { return absDb; },
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Allow `bun run queue.mjs` to act as a one-shot inspector: prints counts and
// the next 20 rows. Useful when debugging without standing up the HTTP server.
if (import.meta.main) {
  const q = openQueue({
    runner: async () => { throw new Error("inspect-only mode"); },
  });
  console.log("db:", q.dbPath);
  console.log("counts:", q.counts());
  const rows = q.list({ limit: 20 });
  for (const r of rows) {
    console.log(
      `#${r.id} [${r.status}] ${r.path} ` +
      `enq=${r.enqueued_at} start=${r.started_at ?? "-"} ` +
      `fin=${r.finished_at ?? "-"} attempts=${r.attempts}` +
      (r.error_msg ? ` err=${r.error_msg.slice(0, 80)}` : "")
    );
  }
  q.close();
}
