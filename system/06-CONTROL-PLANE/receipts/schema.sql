-- Orange5 receipts SQLite schema
-- Path:       06-CONTROL-PLANE/receipts/schema.sql
-- Bound DB:   06-CONTROL-PLANE/receipts/orange5.db
-- Doctrine:   Markdown receipts at 10-RECEIPTS/orange5-build/ remain the
--             operator-audit ground truth. This SQLite store is a parallel
--             machine-query index. SHA-256 column MUST match the file's
--             on-disk sha256 across both stores. Markdown == truth.
--
-- WAL is enabled at runtime via PRAGMA in db.mjs (cannot be set in plain
-- schema files because PRAGMA journal_mode is connection-scoped).
--
-- Receipts are idempotent on receipt_id (front-matter primary key). The
-- ingest pipeline does INSERT ... ON CONFLICT(receipt_id) DO UPDATE so a
-- re-edited markdown file flows cleanly into the row. hash_chain is kept
-- as TEXT because the on-disk values include literal '#021' style strings.

CREATE TABLE IF NOT EXISTS receipts (
    receipt_id     TEXT PRIMARY KEY NOT NULL,
    generated_at   TEXT,                          -- ISO-8601 string as authored
    schema         TEXT,                          -- e.g. orange5.receipt.v0
    status         TEXT,
    confidence     REAL,                          -- 0.0..1.0 (NULL when authored as HIGH/MEDIUM/LOW prose)
    confidence_raw TEXT,                          -- original token preserved (HIGH, 0.86, etc.)
    prior_receipt  TEXT,
    hash_chain     TEXT,
    actor          TEXT,
    sovereign      TEXT,
    markdown_path  TEXT NOT NULL,                 -- absolute path under 10-RECEIPTS/orange5-build/
    sha256         TEXT NOT NULL,                 -- hex sha256 of the markdown bytes on disk
    body_json      TEXT NOT NULL,                 -- full parse: { frontmatter, sections, raw_first_n_chars }
    file_mtime_ms  INTEGER NOT NULL,              -- watcher dedup key
    ingested_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_receipts_generated_at ON receipts(generated_at);
CREATE INDEX IF NOT EXISTS idx_receipts_status       ON receipts(status);
CREATE INDEX IF NOT EXISTS idx_receipts_hash_chain   ON receipts(hash_chain);
CREATE INDEX IF NOT EXISTS idx_receipts_sha256       ON receipts(sha256);

-- updated_at is bumped on every UPSERT path; trigger covers external UPDATEs.
CREATE TRIGGER IF NOT EXISTS receipts_touch_updated_at
AFTER UPDATE ON receipts
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE receipts
       SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE rowid = NEW.rowid;
END;

-- Ingest audit log (append-only). Lets the operator see watcher activity
-- without polluting the receipts table.
CREATE TABLE IF NOT EXISTS ingest_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    event       TEXT NOT NULL,         -- BACKFILL_START | BACKFILL_DONE | UPSERT | SKIP_UNCHANGED | PARSE_ERROR | WATCH_ERROR
    receipt_id  TEXT,                  -- nullable when event is whole-run scoped
    markdown_path TEXT,
    detail      TEXT
);

CREATE INDEX IF NOT EXISTS idx_ingest_log_occurred_at ON ingest_log(occurred_at);
CREATE INDEX IF NOT EXISTS idx_ingest_log_event       ON ingest_log(event);
