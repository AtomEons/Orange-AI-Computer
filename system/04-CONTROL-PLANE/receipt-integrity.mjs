// receipt-integrity.mjs — Orange5 Control Plane, receipt hash-chain verifier.
// Path:    04-CONTROL-PLANE/receipt-integrity.mjs
// Runtime: Bun (imports #sqlite -> ../bin/sqlite-shim.mjs via Orange5 root
//          package.json imports map). Mom's Law: Bun-only, no Node fallback.
//
// What this is
// ------------
// A tested, offline, JSON-returning getter that walks the receipt hash-chain
// held in a SQLite store and reports break/tamper. NO UI. NO operator-facing
// scrub interface (Master Plan §14: "SQLite hash-chained log, consumed by
// OrangeLLM internally, NO operator-facing scrub UI"). Atomic Orange consumes
// the JSON later; this module never renders.
//
// The chain law
// -------------
// A tamper-evident append-only log is a sequence of entries where each entry
// carries a content hash and a link to its predecessor's hash. We define a
// deterministic rolling chain hash:
//
//     entry_hash[i] = sha256hex( seq[i] ∥ receipt_id[i] ∥ sha256[i] ∥ prev_hash[i] )
//     prev_hash[0]  = GENESIS
//     prev_hash[i]  = entry_hash[i-1]        (the chain-link law, i > 0)
//
// (∥ is the 0x1F unit separator; sha256[i] is the receipt's own content hash —
// the hex sha256 of the markdown bytes, which the 06 receipts store already
// records per row.)
//
// Two verification modes, chosen by what columns the table actually has:
//
//   NATIVE  — the table is a purpose-built hash-chain log carrying `seq`,
//             `prev_hash`, and `entry_hash` columns. We recompute each
//             entry_hash and compare against what is stored, and we check the
//             stored prev_hash against the previous entry's stored entry_hash.
//             A prev mismatch is a BROKEN LINK; an entry_hash recompute
//             mismatch is TAMPER (the row's own bytes/link were altered after
//             it was chained).
//
//   DERIVED — the table is the canonical `receipts` mirror, which records
//             `receipt_id` + `sha256` but predates explicit chain columns.
//             There is no stored prev_hash to contradict, so we derive the
//             chain deterministically (ordered by receipt_id) and can only
//             honestly flag structural faults that ARE detectable offline:
//             a NULL/short content hash (unhashed -> can't be chain-anchored),
//             or a duplicate receipt_id (ambiguous sequence). We do NOT chase
//             the free-text `prior_receipt` prose pointers — in the live store
//             they are human-authored annotations (backticks, "(#016)", ".md"
//             suffixes), not clean foreign keys, and reporting them as broken
//             links would be a false alarm. Mom's Law: no fake findings.
//
// Public surface (narrow, JSON-only):
//   verifyChain({ db, table?, order? }) ->
//       { ok, mode, table, total,
//         genesis, head_hash,
//         broken_links: [{ index, receipt_id, expected_prev, actual_prev }],
//         tampered:     [{ index, receipt_id, reason, expected_hash, actual_hash }] }
//   chainHash(prevHex, { seq, receipt_id, sha256 })  -> hex   (the primitive)
//   GENESIS                                            -> hex

import { createHash } from "node:crypto";

// Genesis anchor: sha256 of a fixed domain-separation label. Deterministic,
// documented, and distinct from any real entry hash.
export const GENESIS = createHash("sha256")
  .update("orange5.receipt-chain.genesis.v1")
  .digest("hex");

const US = ""; // 0x1F unit separator — unambiguous field join.

/**
 * The rolling chain-hash primitive. Pure. Deterministic.
 * @param {string} prevHex   previous entry_hash (or GENESIS for index 0)
 * @param {{seq:number, receipt_id:string, sha256:string}} entry
 * @returns {string} hex sha256
 */
export function chainHash(prevHex, { seq, receipt_id, sha256 }) {
  return createHash("sha256")
    .update(String(seq) + US + String(receipt_id) + US + String(sha256) + US + String(prevHex))
    .digest("hex");
}

function tableColumns(db, table) {
  // PRAGMA table_info returns [] for a missing table rather than throwing.
  const rows = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all();
  return new Set(rows.map((r) => r.name));
}

// Only identifiers we generate/control flow through here, but keep it strict:
// allow word chars only, else refuse (defends the PRAGMA/ORDER BY interpolation).
function quoteIdent(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`receipt-integrity: unsafe identifier ${JSON.stringify(name)}`);
  }
  return name;
}

const HEX64 = /^[0-9a-f]{64}$/i;

/**
 * Walk the receipt hash-chain and report break/tamper. Offline-safe: reads
 * only the DB (never markdown, never network).
 *
 * @param {{ db: any, table?: string, order?: string }} args
 *   db:    an open #sqlite Database handle (better-sqlite3-compatible surface)
 *   table: chain table name (default 'receipts')
 *   order: column to order the canonical sequence by in DERIVED mode
 *          (default 'receipt_id'); ignored in NATIVE mode (seq governs).
 * @returns {object} JSON integrity report
 */
export function verifyChain({ db, table = "receipts", order = "receipt_id" } = {}) {
  if (!db || typeof db.prepare !== "function") {
    throw new TypeError("verifyChain: { db } must be an open #sqlite handle");
  }
  quoteIdent(table);
  quoteIdent(order);

  const cols = tableColumns(db, table);
  const native = cols.has("seq") && cols.has("prev_hash") && cols.has("entry_hash");

  const report = {
    ok: true,
    mode: native ? "native" : "derived",
    table,
    total: 0,
    genesis: GENESIS,
    head_hash: GENESIS,
    broken_links: [],
    tampered: [],
  };

  const rows = native
    ? db
        .prepare(
          `SELECT seq, receipt_id, sha256, prev_hash, entry_hash
             FROM ${quoteIdent(table)} ORDER BY seq ASC`
        )
        .all()
    : db
        .prepare(
          `SELECT receipt_id, sha256
             FROM ${quoteIdent(table)} ORDER BY ${quoteIdent(order)} ASC, receipt_id ASC`
        )
        .all();

  report.total = rows.length;
  if (rows.length === 0) {
    // Empty chain is a valid (trivially intact) chain; head stays at genesis.
    return report;
  }

  let prev = GENESIS;
  const seenIds = new Set();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const seq = native ? row.seq : i;
    const rid = row.receipt_id;
    const sha = row.sha256;

    // --- structural faults detectable in BOTH modes ------------------------
    if (rid == null || rid === "") {
      report.tampered.push({
        index: i,
        receipt_id: rid ?? null,
        reason: "missing_receipt_id",
        expected_hash: null,
        actual_hash: null,
      });
      report.ok = false;
    } else if (seenIds.has(rid)) {
      // Duplicate primary key => ambiguous sequence => chain is not well-formed.
      report.tampered.push({
        index: i,
        receipt_id: rid,
        reason: "duplicate_receipt_id",
        expected_hash: null,
        actual_hash: null,
      });
      report.ok = false;
    }
    if (rid != null) seenIds.add(rid);

    if (!sha || !HEX64.test(String(sha))) {
      // A row with no valid content hash cannot be anchored into the chain.
      report.tampered.push({
        index: i,
        receipt_id: rid ?? null,
        reason: "invalid_content_hash",
        expected_hash: null,
        actual_hash: sha ?? null,
      });
      report.ok = false;
    }

    // Recompute this entry's chain hash from (seq, id, sha, prev).
    const recomputed = chainHash(prev, { seq, receipt_id: rid, sha256: sha });

    if (native) {
      // BROKEN LINK: the row's stored prev_hash must equal the previous row's
      // stored entry_hash (== `prev` we are carrying, which for a well-formed
      // chain is the prior stored entry_hash).
      const storedPrev = row.prev_hash;
      if (storedPrev !== prev) {
        report.broken_links.push({
          index: i,
          receipt_id: rid ?? null,
          expected_prev: prev,
          actual_prev: storedPrev ?? null,
        });
        report.ok = false;
      }

      // TAMPER: the row's stored entry_hash must equal what we recompute from
      // its own fields chained onto its stored prev_hash. If the row's bytes
      // (sha256/id/seq) or its recorded prev were altered after chaining, the
      // stored entry_hash no longer matches.
      const selfRecomputed = chainHash(storedPrev ?? prev, {
        seq,
        receipt_id: rid,
        sha256: sha,
      });
      if (row.entry_hash !== selfRecomputed) {
        report.tampered.push({
          index: i,
          receipt_id: rid ?? null,
          reason: "entry_hash_mismatch",
          expected_hash: selfRecomputed,
          actual_hash: row.entry_hash ?? null,
        });
        report.ok = false;
      }

      // Advance using the STORED entry_hash. Link integrity is a stored-vs-
      // stored property: row i is "broken" iff its stored prev_hash differs
      // from row i-1's stored entry_hash. This carrier makes that check exact.
      //
      // How the two checks partition real failures:
      //   * A silent content edit (sha256 changed, entry_hash left stale, link
      //     fields untouched) is caught as TAMPER at that row — its stored
      //     entry_hash no longer matches a recompute over its own fields. No
      //     downstream link breaks, because the stored link fields still agree.
      //     One edit -> exactly one finding, localized to the edited row.
      //   * A re-pointed / severed link (prev_hash rewritten) is caught as a
      //     BROKEN LINK at that row. If the attacker also recomputed entry_hash
      //     to match the bad prev, the tamper check stays clean and only the
      //     link break fires — again, one fault, one finding.
      //   * An edit that rewrites sha256 AND re-seals entry_hash over the old
      //     prev leaves this row self-consistent (no tamper) but breaks the
      //     NEXT row's link (its stored prev_hash == the old entry_hash, which
      //     no longer equals this row's new stored entry_hash) -> BROKEN LINK
      //     downstream. The chain still catches it.
      prev = row.entry_hash ?? recomputed;
    } else {
      // DERIVED mode: no stored prev/entry to contradict. Advance the rolling
      // hash so head_hash is a real, reproducible chain tip over the mirror.
      prev = recomputed;
    }
  }

  report.head_hash = prev;
  return report;
}

export default { verifyChain, chainHash, GENESIS };
