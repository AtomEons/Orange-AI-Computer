// db.mjs — SQLite-backed guardrail status store.
//
// One row per (run_id, guardrail_id). A run_id is one full sweep of all 27
// checks. The schema is intentionally narrow so reads from the cockpit and
// AECommand Center are O(1) on guardrail_id.
//
// We use better-sqlite3 (synchronous, embedded, no daemon). If the dependency
// is not installed we fall back to a JSONL append file at state/runs.jsonl —
// guardrails still ship, status still chains, just slower to query.

import { mkdirSync, existsSync, appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DB_PATH, STATE_DIR } from "./paths.mjs";

let _db = null;
let _backend = null; // 'sqlite' | 'jsonl'
let _Database = null;

function ensureDir(p) {
  mkdirSync(dirname(p), { recursive: true });
}

async function tryLoadSqlite() {
  if (_Database) return _Database;
  try {
    const mod = await import("#sqlite");
    _Database = mod.default || mod;
    return _Database;
  } catch {
    return null;
  }
}

export async function getDb() {
  if (_db) return { db: _db, backend: _backend };
  ensureDir(DB_PATH);
  const Database = await tryLoadSqlite();
  if (Database) {
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
    _db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        ok INTEGER NOT NULL,
        elapsed_ms INTEGER NOT NULL,
        host TEXT,
        node_version TEXT
      );
      CREATE TABLE IF NOT EXISTS guardrail_results (
        run_id TEXT NOT NULL,
        guardrail_id TEXT NOT NULL,
        severity TEXT NOT NULL,
        pass INTEGER NOT NULL,
        details TEXT,
        elapsed_ms INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        PRIMARY KEY (run_id, guardrail_id)
      );
      CREATE INDEX IF NOT EXISTS idx_results_guardrail
        ON guardrail_results(guardrail_id, ts DESC);
      CREATE INDEX IF NOT EXISTS idx_results_pass
        ON guardrail_results(pass, severity, ts DESC);
    `);
    _backend = "sqlite";
    return { db: _db, backend: _backend };
  }
  // JSONL fallback
  const jsonlPath = resolve(STATE_DIR, "runs.jsonl");
  ensureDir(jsonlPath);
  _db = { jsonlPath };
  _backend = "jsonl";
  return { db: _db, backend: _backend };
}

export async function recordRun({ run_id, started_at, finished_at, ok, elapsed_ms, results }) {
  const { db, backend } = await getDb();
  if (backend === "sqlite") {
    const insertRun = db.prepare(`
      INSERT OR REPLACE INTO runs (run_id, started_at, finished_at, ok, elapsed_ms, host, node_version)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertResult = db.prepare(`
      INSERT OR REPLACE INTO guardrail_results
        (run_id, guardrail_id, severity, pass, details, elapsed_ms, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = db.transaction(() => {
      insertRun.run(
        run_id,
        started_at,
        finished_at,
        ok ? 1 : 0,
        elapsed_ms,
        process.env.COMPUTERNAME || process.env.HOSTNAME || "",
        process.version
      );
      for (const r of results) {
        insertResult.run(
          run_id,
          r.guardrail_id,
          r.severity,
          r.pass ? 1 : 0,
          typeof r.details === "string" ? r.details : JSON.stringify(r.details ?? null),
          r.elapsed_ms ?? 0,
          finished_at
        );
      }
    });
    tx();
    return { backend };
  }
  // JSONL
  appendFileSync(
    db.jsonlPath,
    JSON.stringify({ run_id, started_at, finished_at, ok, elapsed_ms, results }) + "\n",
    "utf8"
  );
  return { backend };
}

export async function latestRun() {
  const { db, backend } = await getDb();
  if (backend === "sqlite") {
    const run = db.prepare(`SELECT * FROM runs ORDER BY started_at DESC LIMIT 1`).get();
    if (!run) return null;
    const results = db
      .prepare(`SELECT * FROM guardrail_results WHERE run_id = ? ORDER BY guardrail_id ASC`)
      .all(run.run_id);
    return { ...run, ok: !!run.ok, results: results.map((r) => ({ ...r, pass: !!r.pass })) };
  }
  // JSONL — read last line
  if (!existsSync(db.jsonlPath)) return null;
  const raw = readFileSync(db.jsonlPath, "utf8").trim().split("\n");
  if (raw.length === 0) return null;
  try {
    return JSON.parse(raw[raw.length - 1]);
  } catch {
    return null;
  }
}
