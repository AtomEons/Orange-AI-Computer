-- ============================================================================
-- Graph Weaver — Migrations Journal
-- ============================================================================
-- Path:  06-ORANGELLM/memory/graph-weaver/migrations.sql
--
-- Apply in order. Each block is idempotent (IF NOT EXISTS / OR IGNORE) so
-- replaying the full file on a partially-migrated database is safe.
--
-- Runtime convention (better-sqlite3, Node 20+):
--   const current = db.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v ?? 0;
--   for each block where block.version > current: db.exec(block.sql); record version.
--
-- Receipts:
--   Each migration MUST update schema_version with its version, applied_at,
--   and a one-line note describing the intent. No silent schema drift.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- v1 — initial schema
-- ----------------------------------------------------------------------------
-- Author: Graph Weaver doctrine v1 (Orange5 / 06-ORANGELLM)
-- Date:   2026-06-24
-- Intent: Stand up nodes, edges, watermarks, ontology_candidates with the
--         10-node / 6-edge LOCKED ontology and 768-dim nomic-embed-text BLOBs.
-- See:    schema.sql (canonical full definition; this block mirrors it).
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL,
  note       TEXT
);

CREATE TABLE IF NOT EXISTS nodes (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  name            TEXT NOT NULL,
  attrs_json      TEXT NOT NULL DEFAULT '{}',
  embedding       BLOB,
  created_at      TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  observed_count  INTEGER NOT NULL DEFAULT 0,
  receipt_count   INTEGER NOT NULL DEFAULT 0,
  CHECK (length(id) = 64),
  CHECK (embedding IS NULL OR length(embedding) = 3072)
);
CREATE INDEX IF NOT EXISTS idx_nodes_type      ON nodes(type);
CREATE INDEX IF NOT EXISTS idx_nodes_name      ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_last_seen ON nodes(last_seen_at);

CREATE TABLE IF NOT EXISTS edges (
  id                TEXT PRIMARY KEY,
  source            TEXT NOT NULL,
  predicate         TEXT NOT NULL,
  target            TEXT NOT NULL,
  weight            REAL NOT NULL DEFAULT 1.0,
  created_at        TEXT NOT NULL,
  last_observed_at  TEXT NOT NULL,
  evidence_json     TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY (source) REFERENCES nodes(id) ON DELETE CASCADE,
  FOREIGN KEY (target) REFERENCES nodes(id) ON DELETE CASCADE,
  CHECK (length(id) = 64),
  CHECK (predicate IN ('PROVES','REQUIRES','BLOCKED_BY','SUPERSEDES','APPROVED_BY','OBSERVED_BY'))
);
CREATE INDEX IF NOT EXISTS idx_edges_source    ON edges(source);
CREATE INDEX IF NOT EXISTS idx_edges_target    ON edges(target);
CREATE INDEX IF NOT EXISTS idx_edges_predicate ON edges(predicate);
CREATE INDEX IF NOT EXISTS idx_edges_src_pred  ON edges(source, predicate);
CREATE INDEX IF NOT EXISTS idx_edges_tgt_pred  ON edges(target, predicate);

CREATE TABLE IF NOT EXISTS watermarks (
  lane                TEXT PRIMARY KEY,
  last_processed_ts   INTEGER NOT NULL DEFAULT 0,
  last_processed_hash TEXT NOT NULL DEFAULT '',
  updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ontology_candidates (
  proposed_type             TEXT PRIMARY KEY,
  occurrence_count          INTEGER NOT NULL DEFAULT 0,
  first_seen_at             TEXT NOT NULL,
  last_seen_at              TEXT NOT NULL,
  referencing_receipts_json TEXT NOT NULL DEFAULT '[]',
  promoted                  INTEGER NOT NULL DEFAULT 0,
  promoted_at               TEXT,
  promoted_by               TEXT,
  CHECK (promoted IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_ontology_candidates_promoted ON ontology_candidates(promoted);
CREATE INDEX IF NOT EXISTS idx_ontology_candidates_count    ON ontology_candidates(occurrence_count);

INSERT OR IGNORE INTO schema_version (version, applied_at, note)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        'v1: initial schema — nodes, edges, watermarks, ontology_candidates; 10-node/6-edge locked ontology; 768-dim nomic-embed-text blobs.');

-- ----------------------------------------------------------------------------
-- v2 — RESERVED
-- ----------------------------------------------------------------------------
-- When the first ontology promotion lands (operator runs
--   promote-ontology <name>
-- AND the system decides to live-extend), the new node type goes into the
-- edges CHECK constraint and/or a new nodes.type whitelist via a v2 block here.
-- Until then this section stays a marker — no drift.
--
-- Suggested template for the next bump:
--
-- BEGIN;
--   ALTER TABLE ... ;     -- migration body
--   INSERT INTO schema_version (version, applied_at, note)
--   VALUES (2, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'v2: <one-line intent>');
-- COMMIT;
