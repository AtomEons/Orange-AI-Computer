-- Knowledge Strata — index.db schema
-- Path: 04-CONTROL-PLANE/knowledge-strata/index.db
--
-- AtomEons canon: intake -> canon -> durable artifact -> integrity pass -> reuse.
--
-- This is the durable, queryable index of every emitted Strata artifact. The
-- source of truth is still the on-disk pair (md + json sidecar) under
-- 19-ARCHIVE/strata/<topic>/v<NN>/ — index.db is a derived projection rebuilt
-- by `node index.db.mjs --ingest`. The DB is NEVER the place new artifacts
-- are written; it is the place receipts cite from.
--
-- Required columns (per build order):
--   artifact_id     stable canon id (e.g. intake_sample_1afd99)
--   topic           archive topic (e.g. "pathwaves")
--   version         monotone per-topic version (1, 2, 3, ...)
--   prior_version   version - 1 when topic has a predecessor, else NULL
--   sha256          chain_sha256 = sha(prior_chain || canon_sha || markdown_sha);
--                   this is the receipt-grade hash. The component hashes are
--                   preserved in their own columns for cross-check.
--   emitted_at      ISO8601 UTC timestamp of archive emission
--   archive_path    absolute path to the durable JSON sidecar in 19-ARCHIVE
--
-- Additional fidelity columns retained from the archive INDEX:
--   department, title, summary, tags_json,
--   intake_sha256, canon_sha256, markdown_sha256,
--   md_path (durable markdown), canon_path (working canon row, may be NULL
--   if the working row was rotated away), force_break (1 if chain was
--   intentionally broken at emit time; surfaces a degradation flag in reuse).

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS artifacts (
  -- Composite primary key: same artifact id can re-emit at a higher version.
  artifact_id     TEXT    NOT NULL,
  -- version 0 = working/pre-archive row (canon dir only, not yet emitted).
  -- version >= 1 = archived (durable) row.
  version         INTEGER NOT NULL CHECK (version >= 0),
  topic           TEXT    NOT NULL,
  prior_version   INTEGER          CHECK (
                    prior_version IS NULL OR prior_version = version - 1
                  ),
  sha256          TEXT    NOT NULL CHECK (length(sha256) = 64),
  emitted_at      TEXT    NOT NULL,                              -- ISO8601
  archive_path    TEXT    NOT NULL,                              -- json sidecar
  md_path         TEXT    NOT NULL,                              -- durable markdown

  department      TEXT,
  title           TEXT,
  summary         TEXT,
  tags_json       TEXT    NOT NULL DEFAULT '[]',                 -- JSON array

  intake_sha256   TEXT,
  canon_sha256    TEXT,
  markdown_sha256 TEXT,

  canon_path      TEXT,                                          -- working canon row, nullable
  force_break     INTEGER NOT NULL DEFAULT 0 CHECK (force_break IN (0,1)),
  source          TEXT    NOT NULL DEFAULT 'archive'             -- 'archive' | 'working'
                          CHECK (source IN ('archive','working')),
  ingested_at     TEXT    NOT NULL,

  PRIMARY KEY (artifact_id, version)
);

-- One row per topic+version: enforces archive monotonicity.
CREATE UNIQUE INDEX IF NOT EXISTS ux_artifacts_topic_version
  ON artifacts (topic, version);

CREATE INDEX IF NOT EXISTS ix_artifacts_topic         ON artifacts (topic);
CREATE INDEX IF NOT EXISTS ix_artifacts_artifact_id   ON artifacts (artifact_id);
CREATE INDEX IF NOT EXISTS ix_artifacts_emitted_at    ON artifacts (emitted_at);
CREATE INDEX IF NOT EXISTS ix_artifacts_sha256        ON artifacts (sha256);
CREATE INDEX IF NOT EXISTS ix_artifacts_department    ON artifacts (department);

-- Ingest receipts: one row per ingest run. Every ingest is logged so the DB
-- itself carries a receipt trail (Mom's Law: no silent ops).
CREATE TABLE IF NOT EXISTS ingest_runs (
  run_id          TEXT PRIMARY KEY,
  started_at      TEXT NOT NULL,
  finished_at     TEXT NOT NULL,
  archive_index   TEXT NOT NULL,
  rows_seen       INTEGER NOT NULL,
  rows_inserted   INTEGER NOT NULL,
  rows_updated    INTEGER NOT NULL,
  rows_skipped    INTEGER NOT NULL,
  rows_failed     INTEGER NOT NULL,
  verify          INTEGER NOT NULL DEFAULT 0 CHECK (verify IN (0,1)),
  errors_json     TEXT    NOT NULL DEFAULT '[]'
);

-- Convenience view: latest version per topic.
CREATE VIEW IF NOT EXISTS v_latest_per_topic AS
  SELECT a.*
    FROM artifacts a
    JOIN (
      SELECT topic, MAX(version) AS v
        FROM artifacts
       GROUP BY topic
    ) t ON t.topic = a.topic AND t.v = a.version;

-- Convenience view: latest version per artifact_id (canon-id pinned reuse).
CREATE VIEW IF NOT EXISTS v_latest_per_artifact_id AS
  SELECT a.*
    FROM artifacts a
    JOIN (
      SELECT artifact_id, MAX(version) AS v
        FROM artifacts
       GROUP BY artifact_id
    ) t ON t.artifact_id = a.artifact_id AND t.v = a.version;
