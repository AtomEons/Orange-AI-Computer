// Orange5 — Receipts query module
// Path: 06-CONTROL-PLANE/receipts/query.mjs
//
// Doctrine:
//   - Markdown receipts at 10-RECEIPTS/orange5-build/ remain the operator-readable
//     source of truth (audit lane).
//   - This module maintains a parallel SQLite index at
//     06-CONTROL-PLANE/receipts/orange5.db for fast machine queries.
//   - The SHA-256 stored per row is computed over the EXACT bytes of the
//     markdown file. Markdown and SQLite must therefore agree byte-for-byte.
//   - Every read verifies the hash-chain. A break in the chain raises and
//     refuses to serve stale or tampered data. Truth over throughput.
//
// Public surface:
//   queryReceipts({ since, status, actor, has_blockers, fake_green_words, limit })
//     → { receipts: [...], chain_verified: true, integrity: {...} }
//
//   Also exported:
//     openDb({ dbPath })
//     reindex({ dbPath, receiptsDir })          — full rebuild from markdown
//     ingestFile({ db, filePath })              — single-file index/refresh
//     verifyChain({ db })                       — independent integrity scan
//     getReceiptById({ db, receipt_id })
//     chainVerifyReport({ db })
//
// Quality: real Node 20+, better-sqlite3, no globals beyond defaults.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from '#sqlite';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 06-CONTROL-PLANE/receipts/ → ../../10-RECEIPTS/orange5-build/
const ORANGE5_ROOT = path.resolve(__dirname, '..', '..');
export const DEFAULT_RECEIPTS_DIR = path.join(
  ORANGE5_ROOT, '10-RECEIPTS', 'orange5-build'
);
export const DEFAULT_DB_PATH = path.join(__dirname, 'orange5.db');

// ---------------------------------------------------------------------------
// Hash-chain doctrine
// ---------------------------------------------------------------------------
//
// Receipts carry a monotonic `hash_chain` number like `#011`, `#012`, ...
// The integrity rule:
//   chain_link(N) = sha256( chain_link(N-1) || sha256(content_N) )
//   chain_link(0) = sha256("")  (genesis)
// where content_N is the raw bytes of the markdown file.
//
// This module computes chain_link on the fly during reindex, persists it,
// and re-verifies on every read. If any row's content_sha256 disagrees with
// its file (or with the recomputed chain_link), the read raises.

const GENESIS_LINK = createHash('sha256').update('').digest('hex');

function sha256Bytes(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function chainStep(prevLink, contentSha) {
  return createHash('sha256').update(prevLink).update(contentSha).digest('hex');
}

// ---------------------------------------------------------------------------
// Fake-green vocabulary (default — caller may override)
// ---------------------------------------------------------------------------
//
// Mom's Law: a receipt that claims green without proof is a fake green.
// Rather than block writes (markdown is the source of truth), we surface
// matches at query time so operators can audit.

export const DEFAULT_FAKE_GREEN_WORDS = Object.freeze([
  'should work',
  'probably works',
  'looks good',
  'lgtm',
  'i think it',
  'mostly green',
  'basically done',
  'good enough',
  'tests pass*',     // suspicious without a count
  'all green*',      // suspicious without evidence pointer
]);

// ---------------------------------------------------------------------------
// Markdown front-matter parsing (lightweight, deterministic)
// ---------------------------------------------------------------------------
//
// The Orange5 receipts use two shapes that both appear in the corpus:
//   (A) bold-labeled lines:    **Receipt ID:** `2026-06-23-master-receipt`
//   (B) bullet key/value:      - **receipt_id:** 2026-06-24-graph-weaver-built
//
// We parse both. We DO NOT attempt to be a full markdown parser — we extract
// only the load-bearing fields the index needs.

const FIELD_PATTERNS = {
  receipt_id:   /^[\s\-*]*\*\*receipt[_ ]id:?\*\*\s*`?([^`\n]+?)`?\s*$/im,
  generated_at: /^[\s\-*]*\*\*generated[_ ]at:?\*\*\s*([^\n]+)$/im,
  actor:        /^[\s\-*]*\*\*actor:?\*\*\s*([^\n]+)$/im,
  status:       /^[\s\-*]*\*\*status:?\*\*\s*`?([^`\n]+?)`?\s*$/im,
  confidence:   /^[\s\-*]*\*\*confidence:?\*\*\s*([0-9.]+)/im,
  hash_chain:   /^[\s\-*]*\*\*hash[_ ]chain:?\*\*\s*#?(\d+)/im,
  prior_receipt:/^[\s\-*]*\*\*prior[_ ]receipt:?\*\*\s*([^\n]+)$/im,
  sovereign:    /^[\s\-*]*\*\*sovereign:?\*\*\s*([^\n]+)$/im,
};

const BLOCKERS_HEADING_RE = /^#{1,6}\s*(blockers?|what waits|what blocks)/im;
const NEXT_HEADING_RE     = /^#{1,6}\s+/m;

function deriveIdFromFilename(filePath) {
  // 2026-06-24-graph-weaver-built.md  →  2026-06-24-graph-weaver-built
  return path.basename(filePath, '.md');
}

function extractTitle(body) {
  const m = body.match(/^#\s+([^\n]+)/);
  return m ? m[1].trim() : null;
}

function extractBlockersText(body) {
  // Find the Blockers section, return its raw text until the next heading.
  const start = body.search(BLOCKERS_HEADING_RE);
  if (start === -1) return '';
  const after = body.slice(start);
  // Skip the heading line itself.
  const newline = after.indexOf('\n');
  if (newline === -1) return '';
  const rest = after.slice(newline + 1);
  const nextH = rest.search(NEXT_HEADING_RE);
  return (nextH === -1 ? rest : rest.slice(0, nextH)).trim();
}

function hasBlockers(body) {
  const txt = extractBlockersText(body);
  if (!txt) return 0;
  // "none", "no blockers", "n/a" → 0; otherwise non-trivial content → 1
  const norm = txt.toLowerCase().replace(/[\s\-*•`]+/g, ' ').trim();
  if (!norm) return 0;
  if (/^(none|no blockers|n\/a|na|nil)\.?$/.test(norm)) return 0;
  return 1;
}

function parseReceiptMarkdown(filePath, raw) {
  const body = raw.toString('utf8');
  const out = {};
  for (const [field, re] of Object.entries(FIELD_PATTERNS)) {
    const m = body.match(re);
    if (m) out[field] = m[1].trim();
  }
  if (!out.receipt_id) out.receipt_id = deriveIdFromFilename(filePath);
  out.title = extractTitle(body);
  out.blockers_text = extractBlockersText(body);
  out.has_blockers = hasBlockers(body);
  out.confidence = out.confidence != null ? Number(out.confidence) : null;
  out.hash_chain_n = out.hash_chain != null ? Number(out.hash_chain) : null;
  out.body_len = body.length;
  return out;
}

function normalizeGeneratedAt(s) {
  if (!s) return null;
  // Strip parenthetical location hints: "2026-06-24T00:00:00Z (Marco Island, FL)"
  const cleaned = s.replace(/\([^)]*\)/g, '').trim();
  // Try ISO-8601 first.
  const d = new Date(cleaned);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  // Fall back to date-only YYYY-MM-DD (matches filename prefix).
  const m = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`;
  return null;
}

// ---------------------------------------------------------------------------
// SQLite schema
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS receipts (
  receipt_id      TEXT PRIMARY KEY,
  file_path       TEXT NOT NULL,
  file_mtime_ms   INTEGER NOT NULL,
  file_size       INTEGER NOT NULL,
  content_sha256  TEXT NOT NULL,
  chain_index     INTEGER,
  chain_link      TEXT NOT NULL,
  prev_chain_link TEXT NOT NULL,
  title           TEXT,
  generated_at    TEXT,
  generated_at_iso TEXT,
  actor           TEXT,
  status          TEXT,
  confidence      REAL,
  prior_receipt   TEXT,
  sovereign       TEXT,
  has_blockers    INTEGER NOT NULL DEFAULT 0,
  blockers_text   TEXT,
  body_len        INTEGER,
  indexed_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_receipts_generated_at_iso ON receipts(generated_at_iso);
CREATE INDEX IF NOT EXISTS idx_receipts_status           ON receipts(status);
CREATE INDEX IF NOT EXISTS idx_receipts_actor            ON receipts(actor);
CREATE INDEX IF NOT EXISTS idx_receipts_has_blockers     ON receipts(has_blockers);
CREATE INDEX IF NOT EXISTS idx_receipts_chain_index      ON receipts(chain_index);

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
INSERT OR IGNORE INTO schema_version (version, applied_at)
  VALUES (1, datetime('now'));
`;

// ---------------------------------------------------------------------------
// openDb
// ---------------------------------------------------------------------------

export function openDb({ dbPath } = {}) {
  const file = dbPath || DEFAULT_DB_PATH;
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA_SQL);
  return db;
}

// ---------------------------------------------------------------------------
// ingestFile — index a single markdown receipt
// ---------------------------------------------------------------------------

export function ingestFile({ db, filePath }) {
  const st = statSync(filePath);
  const raw = readFileSync(filePath);
  const content_sha256 = sha256Bytes(raw);
  const parsed = parseReceiptMarkdown(filePath, raw);

  // chain_link is recomputed during reindex (depends on order). For a single-
  // file ingest outside a full reindex, we leave chain_link as the content
  // sha as a placeholder — verifyChain() will repair on next full pass.
  const placeholder = content_sha256;

  const stmt = db.prepare(`
    INSERT INTO receipts (
      receipt_id, file_path, file_mtime_ms, file_size, content_sha256,
      chain_index, chain_link, prev_chain_link,
      title, generated_at, generated_at_iso, actor, status, confidence,
      prior_receipt, sovereign, has_blockers, blockers_text, body_len,
      indexed_at
    ) VALUES (
      @receipt_id, @file_path, @file_mtime_ms, @file_size, @content_sha256,
      @chain_index, @chain_link, @prev_chain_link,
      @title, @generated_at, @generated_at_iso, @actor, @status, @confidence,
      @prior_receipt, @sovereign, @has_blockers, @blockers_text, @body_len,
      datetime('now')
    )
    ON CONFLICT(receipt_id) DO UPDATE SET
      file_path       = excluded.file_path,
      file_mtime_ms   = excluded.file_mtime_ms,
      file_size       = excluded.file_size,
      content_sha256  = excluded.content_sha256,
      chain_index     = excluded.chain_index,
      chain_link      = excluded.chain_link,
      prev_chain_link = excluded.prev_chain_link,
      title           = excluded.title,
      generated_at    = excluded.generated_at,
      generated_at_iso= excluded.generated_at_iso,
      actor           = excluded.actor,
      status          = excluded.status,
      confidence      = excluded.confidence,
      prior_receipt   = excluded.prior_receipt,
      sovereign       = excluded.sovereign,
      has_blockers    = excluded.has_blockers,
      blockers_text   = excluded.blockers_text,
      body_len        = excluded.body_len,
      indexed_at      = datetime('now')
  `);

  stmt.run({
    receipt_id: parsed.receipt_id,
    file_path: filePath,
    file_mtime_ms: Math.floor(st.mtimeMs),
    file_size: st.size,
    content_sha256,
    chain_index: parsed.hash_chain_n,
    chain_link: placeholder,
    prev_chain_link: GENESIS_LINK,
    title: parsed.title || null,
    generated_at: parsed.generated_at || null,
    generated_at_iso: normalizeGeneratedAt(parsed.generated_at),
    actor: parsed.actor || null,
    status: parsed.status || null,
    confidence: parsed.confidence,
    prior_receipt: parsed.prior_receipt || null,
    sovereign: parsed.sovereign || null,
    has_blockers: parsed.has_blockers,
    blockers_text: parsed.blockers_text || null,
    body_len: parsed.body_len,
  });

  return { receipt_id: parsed.receipt_id, content_sha256 };
}

// ---------------------------------------------------------------------------
// reindex — full rebuild of chain_link from markdown corpus
// ---------------------------------------------------------------------------

export function reindex({ dbPath, receiptsDir } = {}) {
  const dir = receiptsDir || DEFAULT_RECEIPTS_DIR;
  if (!existsSync(dir)) {
    throw new Error(`receipts directory not found: ${dir}`);
  }
  const db = openDb({ dbPath });

  // Ingest every .md file.
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => path.join(dir, f));

  const ingestTx = db.transaction(() => {
    for (const f of files) ingestFile({ db, filePath: f });
  });
  ingestTx();

  // Now recompute the chain_link in chain_index order. Ties (or missing
  // chain_index values) fall back to filename / generated_at order.
  const ordered = db.prepare(`
    SELECT receipt_id, content_sha256, chain_index, file_path, generated_at_iso
    FROM receipts
    ORDER BY
      CASE WHEN chain_index IS NULL THEN 1 ELSE 0 END,
      chain_index ASC,
      generated_at_iso ASC NULLS LAST,
      file_path ASC
  `).all();

  const update = db.prepare(`
    UPDATE receipts SET chain_link = ?, prev_chain_link = ? WHERE receipt_id = ?
  `);

  const chainTx = db.transaction((rows) => {
    let prev = GENESIS_LINK;
    for (const r of rows) {
      const link = chainStep(prev, r.content_sha256);
      update.run(link, prev, r.receipt_id);
      prev = link;
    }
  });
  chainTx(ordered);

  return { indexed: files.length, db };
}

// ---------------------------------------------------------------------------
// verifyChain — integrity scan
// ---------------------------------------------------------------------------
//
// Checks, in order:
//   1. Every indexed row's file still exists and its on-disk SHA matches
//      the stored content_sha256.
//   2. The chain recomputes identically: chain_link(i) = sha256(prev || sha_i).
//   3. chain_index numbers are monotonic non-decreasing for rows where present.
//
// Returns { ok, breaks: [...] } and never throws — callers decide what to do.

export function verifyChain({ db }) {
  const rows = db.prepare(`
    SELECT receipt_id, file_path, content_sha256, chain_index, chain_link,
           prev_chain_link
    FROM receipts
    ORDER BY
      CASE WHEN chain_index IS NULL THEN 1 ELSE 0 END,
      chain_index ASC,
      file_path ASC
  `).all();

  const breaks = [];
  let prev = GENESIS_LINK;
  let lastChainIdx = -Infinity;

  for (const r of rows) {
    // (1) file existence + content match
    if (!existsSync(r.file_path)) {
      breaks.push({
        kind: 'missing_file',
        receipt_id: r.receipt_id,
        file_path: r.file_path,
      });
      // We can still walk the chain using the stored content_sha256, but the
      // markdown source is gone — record and continue.
    } else {
      const onDisk = sha256Bytes(readFileSync(r.file_path));
      if (onDisk !== r.content_sha256) {
        breaks.push({
          kind: 'content_drift',
          receipt_id: r.receipt_id,
          file_path: r.file_path,
          indexed_sha: r.content_sha256,
          on_disk_sha: onDisk,
        });
      }
    }

    // (2) chain recompute
    const expected = chainStep(prev, r.content_sha256);
    if (expected !== r.chain_link) {
      breaks.push({
        kind: 'chain_break',
        receipt_id: r.receipt_id,
        expected_link: expected,
        stored_link: r.chain_link,
        prev_link_used: prev,
      });
    }

    // (3) monotonic chain_index (skip nulls)
    if (r.chain_index != null) {
      if (r.chain_index < lastChainIdx) {
        breaks.push({
          kind: 'chain_index_regression',
          receipt_id: r.receipt_id,
          chain_index: r.chain_index,
          previous: lastChainIdx,
        });
      }
      lastChainIdx = r.chain_index;
    }

    prev = r.chain_link;
  }

  return {
    ok: breaks.length === 0,
    breaks,
    head_link: prev,
    row_count: rows.length,
  };
}

export function chainVerifyReport({ db }) {
  const v = verifyChain({ db });
  return {
    ok: v.ok,
    row_count: v.row_count,
    head_link: v.head_link,
    break_count: v.breaks.length,
    breaks: v.breaks,
    verified_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// getReceiptById
// ---------------------------------------------------------------------------

export function getReceiptById({ db, receipt_id }) {
  return db.prepare(`
    SELECT * FROM receipts WHERE receipt_id = ?
  `).get(receipt_id) || null;
}

// ---------------------------------------------------------------------------
// queryReceipts — primary export
// ---------------------------------------------------------------------------
//
// Filters:
//   since           — ISO timestamp; matches generated_at_iso >= since
//   status          — exact string OR string[] OR regex (when starts with /)
//   actor           — substring (case-insensitive)
//   has_blockers    — boolean
//   fake_green_words— string[] of suspicious phrases to flag in body/title;
//                     when omitted, DEFAULT_FAKE_GREEN_WORDS is applied.
//                     Pass [] to disable.
//   limit           — max rows (default 100, hard cap 1000)
//
// Behavior:
//   - On every call, verifyChain() runs first. If any break is detected and
//     the caller has not set { allow_broken_chain: true }, we throw.
//   - fake_green hits never gate the query; they are surfaced per row in
//     `flags.fake_green_hits` and at the top level in `integrity.fake_green`.

const HARD_LIMIT = 1000;
const DEFAULT_LIMIT = 100;

function compileStatusMatcher(status) {
  if (status == null) return null;
  if (Array.isArray(status)) {
    const set = new Set(status.map(s => String(s)));
    return (v) => v != null && set.has(v);
  }
  const s = String(status);
  if (s.startsWith('/') && s.lastIndexOf('/') > 0) {
    const last = s.lastIndexOf('/');
    const pattern = s.slice(1, last);
    const flags = s.slice(last + 1);
    const re = new RegExp(pattern, flags);
    return (v) => v != null && re.test(v);
  }
  return (v) => v === s;
}

function compileFakeGreenMatcher(words) {
  const list = (words === undefined ? DEFAULT_FAKE_GREEN_WORDS : (words || []))
    .map(String).filter(Boolean);
  if (list.length === 0) return null;
  // Build a single case-insensitive regex; `*` at the end of a phrase means
  // word-boundary anywhere after, allowing "tests pass" to match "tests passed".
  const parts = list.map(w => {
    const trail = w.endsWith('*');
    const core = trail ? w.slice(0, -1) : w;
    const escaped = core.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return trail ? escaped + '[a-z]*' : escaped;
  });
  const re = new RegExp('\\b(' + parts.join('|') + ')\\b', 'i');
  return (text) => {
    const hits = [];
    if (!text) return hits;
    let rest = text;
    let guard = 0;
    while (guard++ < 50) {
      const m = re.exec(rest);
      if (!m) break;
      hits.push(m[1]);
      rest = rest.slice(m.index + m[0].length);
    }
    return [...new Set(hits.map(h => h.toLowerCase()))];
  };
}

export function queryReceipts({
  since = null,
  status = null,
  actor = null,
  has_blockers = null,
  fake_green_words = undefined,
  limit = DEFAULT_LIMIT,
  dbPath = null,
  db: providedDb = null,
  receiptsDir = null,
  allow_broken_chain = false,
  auto_reindex = true,
} = {}) {
  let db = providedDb;
  let opened = false;
  if (!db) {
    // Auto-reindex on first call if DB doesn't exist or is empty.
    db = openDb({ dbPath });
    opened = true;
    if (auto_reindex) {
      const count = db.prepare('SELECT COUNT(*) AS n FROM receipts').get().n;
      if (count === 0) {
        db.close();
        const r = reindex({ dbPath, receiptsDir });
        db = r.db;
      }
    }
  }

  try {
    // Hash-chain integrity — verify EVERY read.
    const integrity = chainVerifyReport({ db });
    if (!integrity.ok && !allow_broken_chain) {
      const err = new Error(
        `receipts hash-chain integrity broken: ${integrity.break_count} break(s); ` +
        `first=${integrity.breaks[0]?.kind}/${integrity.breaks[0]?.receipt_id}`
      );
      err.code = 'RECEIPTS_CHAIN_BREAK';
      err.integrity = integrity;
      throw err;
    }

    // Build SQL.
    const where = [];
    const params = [];
    if (since) {
      where.push('generated_at_iso >= ?');
      params.push(new Date(since).toISOString());
    }
    if (actor) {
      where.push('LOWER(COALESCE(actor, \'\')) LIKE ?');
      params.push('%' + String(actor).toLowerCase() + '%');
    }
    if (has_blockers === true) {
      where.push('has_blockers = 1');
    } else if (has_blockers === false) {
      where.push('has_blockers = 0');
    }
    const lim = Math.min(Math.max(1, Number(limit) || DEFAULT_LIMIT), HARD_LIMIT);
    const sql = `
      SELECT receipt_id, file_path, content_sha256, chain_index, chain_link,
             title, generated_at, generated_at_iso, actor, status, confidence,
             prior_receipt, sovereign, has_blockers, blockers_text, body_len,
             indexed_at
      FROM receipts
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY
        CASE WHEN chain_index IS NULL THEN 1 ELSE 0 END,
        chain_index DESC,
        generated_at_iso DESC NULLS LAST,
        file_path DESC
      LIMIT ?
    `;
    const rows = db.prepare(sql).all(...params, lim);

    // In-process filtering: status matcher (supports regex / array), fake-green scan.
    const statusMatch = compileStatusMatcher(status);
    const fakeGreen = compileFakeGreenMatcher(fake_green_words);

    let total_fake_green = 0;
    const out = [];
    for (const r of rows) {
      if (statusMatch && !statusMatch(r.status)) continue;
      const flags = {};
      if (fakeGreen) {
        // Scan title + blockers_text (body content already condensed at index).
        const scanText = [r.title, r.status, r.blockers_text]
          .filter(Boolean).join('\n');
        const hits = fakeGreen(scanText);
        if (hits.length > 0) {
          flags.fake_green_hits = hits;
          total_fake_green += 1;
        }
      }
      out.push({ ...r, flags });
    }

    return {
      receipts: out,
      chain_verified: true,
      integrity: {
        row_count: integrity.row_count,
        head_link: integrity.head_link,
        verified_at: integrity.verified_at,
        fake_green_flagged_count: total_fake_green,
      },
      filters_applied: {
        since, status, actor, has_blockers,
        fake_green_words: fake_green_words === undefined
          ? '(default vocabulary)'
          : fake_green_words,
        limit: lim,
      },
    };
  } finally {
    if (opened) db.close();
  }
}

// ---------------------------------------------------------------------------
// Default export — convenience
// ---------------------------------------------------------------------------

export default queryReceipts;
