-- ============================================================================
-- Graph Weaver — SQLite Schema (v1)
-- ============================================================================
-- Path:    06-ORANGELLM/memory/graph-weaver/schema.sql
-- Target:  06-ORANGELLM/memory/graph.db
-- Driver:  better-sqlite3 (Node 20+, synchronous)
-- Doctrine:
--   10-node 6-edge LOCKED ontology.
--   Nodes types:  Sovereign, Project, Mission, Lane, Model, Tool,
--                 Service, Host, Receipt, Doctrine
--   Edge preds:   PROVES, REQUIRES, BLOCKED_BY, SUPERSEDES,
--                 APPROVED_BY, OBSERVED_BY
--   Embeddings:   nomic-embed-text (768 float32) packed as BLOB.
--   ID hashing:   sha256(normalized_name + '\x1f' + type) for nodes,
--                 sha256(source + '\x1f' + predicate + '\x1f' + target) for edges.
-- ============================================================================

PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA temp_store   = MEMORY;

-- ----------------------------------------------------------------------------
-- nodes
-- ----------------------------------------------------------------------------
-- One row per distinct (normalized_name, type) pair.
-- attrs_json  : free-form per-type attributes (operator metadata, badges, etc).
-- embedding   : 768 * 4 = 3072 bytes when present; nullable until embed pass runs.
-- observed_count : how many flux records have surfaced this entity.
-- receipt_count  : how many of those observations were Receipt-typed nodes
--                  citing or cited by this node (drives ontology promotion).
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

CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_last_seen ON nodes(last_seen_at);

-- ----------------------------------------------------------------------------
-- edges
-- ----------------------------------------------------------------------------
-- Directed predicate edges between two nodes.
-- weight   : reinforcement counter (incremented on every re-observation).
-- evidence_json : JSON array of flux record sha256 hashes that produced/
--                 reinforced this edge. Append-only, deduped at write time.
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

CREATE INDEX IF NOT EXISTS idx_edges_source     ON edges(source);
CREATE INDEX IF NOT EXISTS idx_edges_target     ON edges(target);
CREATE INDEX IF NOT EXISTS idx_edges_predicate  ON edges(predicate);
CREATE INDEX IF NOT EXISTS idx_edges_src_pred   ON edges(source, predicate);
CREATE INDEX IF NOT EXISTS idx_edges_tgt_pred   ON edges(target, predicate);

-- ----------------------------------------------------------------------------
-- watermarks
-- ----------------------------------------------------------------------------
-- Per-lane tailing progress. The Graph Weaver daemon resumes from
-- (last_processed_ts, last_processed_hash) on restart — idempotent.
-- Lanes correspond to flux directories under /mnt/ae_flux/events/:
--   reality / thought / merge / ...
CREATE TABLE IF NOT EXISTS watermarks (
  lane                TEXT PRIMARY KEY,
  last_processed_ts   INTEGER NOT NULL DEFAULT 0,
  last_processed_hash TEXT NOT NULL DEFAULT '',
  updated_at          TEXT NOT NULL
);

-- ----------------------------------------------------------------------------
-- ontology_candidates
-- ----------------------------------------------------------------------------
-- Receipt-gated ontology extension. The 10-type ontology is LOCKED;
-- novel proposed types extracted by the LLM land here as candidates,
-- not as live node types. A candidate is promoted when either:
--   (a) occurrence_count >= 5 AND referencing_receipts_json has >= 5 distinct
--       Receipt-typed referencing nodes, OR
--   (b) operator types `promote-ontology <name>` (sets promoted = 1).
-- Promotion is a manual schema change — promoted = 1 is the journal record,
-- not a license for the daemon to silently start writing the new type.
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

CREATE INDEX IF NOT EXISTS idx_ontology_candidates_promoted
  ON ontology_candidates(promoted);
CREATE INDEX IF NOT EXISTS idx_ontology_candidates_count
  ON ontology_candidates(occurrence_count);

-- ----------------------------------------------------------------------------
-- schema_version  (set by migrations.sql, mirrored here for first init)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL,
  note       TEXT
);

INSERT OR IGNORE INTO schema_version (version, applied_at, note)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'initial schema: nodes, edges, watermarks, ontology_candidates');
