// LOOM gate 4 — human_approval
//
// Hermes pre-flight gate 4 of 8. Enforces operator-in-the-loop authority
// for any lease that carries `requires_approval: true`. A lease may only
// retire through this gate if (a) the operator (the Sovereign) has signed
// an entry in the pending-approvals queue, (b) that entry is `approved`,
// and (c) the lease window has not expired.
//
// This gate is the codified form of the "Human Final Stop Authority"
// invariant (see project CLAUDE.md). It is the only LOOM gate whose
// decision rule references a signed external artifact rather than a
// schema or filesystem shape — by design. Approval is not a typecheck;
// it is a sovereignty event.
//
// Contract: every action that any LLM in the superstack proposes must
// arrive inside a lease. If `lease.requires_approval === false`, this
// gate is a no-op pass — gates 5..8 still run downstream. If
// `lease.requires_approval === true`, the gate searches the queue at
// 08-HERMES/approvals/pending.jsonl for a record whose `lease_id`
// matches and whose `approved === true && signed === true` (where
// `signed` means the approval bears the Sovereign's signature; see
// "Signature semantics" below). On hit, the gate passes; on miss or on
// expired lease, the gate refuses and Hermes returns control to the
// operator with structured reasons.
//
// Module shape:
//   - default export: async function humanApprovalGate(lease, opts?) → { pass, reasons, approval? }
//   - named exports: humanApprovalGate, loadPendingApprovals, findApproval,
//                    isLeaseExpired, GATE_ID, GATE_INDEX, DEFAULT_QUEUE_PATH
//
// Honest gaps (read me):
//   - Signature semantics. This gate trusts the `signed_by` and
//     `signature` fields on the approval record but does NOT itself
//     perform cryptographic verification. Verifying that the signature
//     matches the Sovereign's published key is a separate concern that
//     lives in the gateway's pre-write hook for the queue file (writes
//     to pending.jsonl come through gateway /v1/hermes/approve, which
//     is the surface that holds the keys). If the gateway-side check
//     is bypassed and a forged record lands in the queue, this gate
//     will accept it. That is a known and documented threat boundary;
//     fixing it requires a real Ed25519/Sigstore verification step
//     here. Tracked: see Hermes daemon roadmap.
//   - SOVEREIGN_PRINCIPAL is configurable via `opts.sovereignPrincipal`
//     or the `HERMES_SOVEREIGN_PRINCIPAL` env var. Default is "atom"
//     (the Sovereign — Atom McCree). The gate matches `signed_by`
//     case-insensitively against this principal and against the
//     literal string "sovereign" (since some adapters write the role
//     name rather than the principal).
//   - The queue is read fresh on every call (no cache). The file is
//     append-only JSONL; each non-blank line must parse as JSON. Lines
//     that fail to parse are skipped with a reason recorded — they do
//     not crash the gate. This is deliberate: a partially-written line
//     during a concurrent append should not take down the LOOM chain.
//   - Missing queue file is treated as "no approvals" — gate fails with
//     reason `pending_approvals_queue_missing`. The directory and file
//     are NOT auto-created by this gate; creation is the gateway's job
//     (queue-as-spine, not queue-as-side-effect).
//   - The gate evaluates lease expiry using `Date.now()` by default.
//     Tests may inject `opts.now` (number, ms since epoch) for
//     deterministic clocks.
//   - This is gate 4 of 8. It does not look at the order or report
//     payload; gates 1, 2, 3, 5, 6, 7, 8 own those concerns. Separation
//     of concerns is intentional: each LOOM gate owns one assertion so
//     failure reasons localise cleanly to a single gate index.
//   - Requires Node 20+ (uses `node:fs/promises`, `import.meta.url`,
//     top-level `URL` resolution).
//
// Approval record shape (orange.approval.v1, informal — schema TBD):
//   {
//     "lease_id":   "lease_1718...",
//     "approved":   true,
//     "signed":     true,
//     "signed_by":  "atom",
//     "signature":  "<base64 ed25519 sig over canonical(approval_body)>",
//     "timestamp":  "2026-06-24T14:35:00Z",
//     "note":       "optional operator note"
//   }
//
// Refusal reasons surfaced to the operator (stable strings — adapters
// may key off these):
//   - "lease_invalid"                       — lease arg was not a usable object
//   - "lease_expired"                       — Date.now() > lease.expires_at
//   - "pending_approvals_queue_missing"     — file does not exist on disk
//   - "pending_approvals_queue_unreadable"  — file exists but cannot be read
//   - "approval_not_found"                  — no record for this lease_id
//   - "approval_denied"                     — record exists but approved !== true
//   - "approval_unsigned"                   — record exists but signed !== true
//   - "approval_signed_by_wrong_principal"  — signed_by does not match Sovereign

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const GATE_ID = "human_approval";
export const GATE_INDEX = 4;

// Resolved at module load — points at the canonical pending-approvals
// queue. 08-HERMES/src/loom-gates/04-human-approval.mjs
//   → ../../approvals/pending.jsonl
export const DEFAULT_QUEUE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..",
  "approvals",
  "pending.jsonl",
);

const DEFAULT_SOVEREIGN_PRINCIPAL = (process.env.HERMES_SOVEREIGN_PRINCIPAL || "atom").trim();
// Some adapters write the role name instead of the principal.
const SOVEREIGN_ROLE_ALIAS = "sovereign";

/**
 * Read the pending-approvals queue from disk and parse it as JSONL.
 * Returns the list of parsed records and a list of structured parse
 * issues (line-number indexed). Never throws on a missing file —
 * missing is a load_status of "missing". Throws only on unexpected I/O
 * errors (permission, EIO).
 *
 * @param {{ queuePath?: string }} [opts]
 * @returns {Promise<{
 *   load_status: "ok" | "missing" | "unreadable",
 *   records: object[],
 *   parse_issues: { line: number, reason: string }[],
 *   path: string,
 *   io_error?: { code?: string, message: string },
 * }>}
 */
export async function loadPendingApprovals({ queuePath = DEFAULT_QUEUE_PATH } = {}) {
  let raw;
  try {
    raw = await readFile(queuePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { load_status: "missing", records: [], parse_issues: [], path: queuePath };
    }
    return {
      load_status: "unreadable",
      records: [],
      parse_issues: [],
      path: queuePath,
      io_error: { code: err?.code, message: err?.message || String(err) },
    };
  }

  const records = [];
  const parse_issues = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || !line.trim()) continue; // blank lines are legal in JSONL
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      parse_issues.push({ line: i + 1, reason: `malformed_json: ${err.message}` });
      continue;
    }
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
      parse_issues.push({ line: i + 1, reason: "record_not_object" });
      continue;
    }
    records.push(obj);
  }
  return { load_status: "ok", records, parse_issues, path: queuePath };
}

/**
 * Find the most recent approval record for a given lease id. The queue
 * is append-only — later writes for the same lease (e.g. revocation,
 * re-approval) supersede earlier ones — so we scan from the tail and
 * return the first match.
 *
 * @param {object[]} records  parsed approval records, in file order
 * @param {string} leaseId
 * @returns {object | null}
 */
export function findApproval(records, leaseId) {
  if (!Array.isArray(records) || typeof leaseId !== "string" || leaseId.length === 0) {
    return null;
  }
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const r = records[i];
    if (r && typeof r === "object" && r.lease_id === leaseId) return r;
  }
  return null;
}

/**
 * @param {{ expires_at?: number }} lease
 * @param {number} now
 * @returns {boolean}
 */
export function isLeaseExpired(lease, now) {
  if (!lease || typeof lease.expires_at !== "number" || !Number.isFinite(lease.expires_at)) {
    // No expires_at → treat as expired. A lease without a lifetime is
    // not a lease; it is a permanent grant, which the doctrine forbids.
    return true;
  }
  return now > lease.expires_at;
}

function matchesSovereign(signedBy, sovereignPrincipal) {
  if (typeof signedBy !== "string") return false;
  const sb = signedBy.trim().toLowerCase();
  if (sb.length === 0) return false;
  const sp = (sovereignPrincipal || DEFAULT_SOVEREIGN_PRINCIPAL).trim().toLowerCase();
  return sb === sp || sb === SOVEREIGN_ROLE_ALIAS;
}

/**
 * LOOM gate 4 entry point. Pure decision over (lease, queue state, now).
 * Pass `opts.records` to inject a pre-loaded queue (skips disk read; for
 * tests). Pass `opts.queuePath` to override the queue location. Pass
 * `opts.now` for deterministic clocks. Pass `opts.sovereignPrincipal`
 * to override the principal name match (defaults to env or "atom").
 *
 * Never throws on a failed approval — only returns structured
 * `{ pass: false, reasons }`. Even an unreadable queue file is reported
 * as a gate-4 reject rather than an unhandled exception, so the LOOM
 * chain can localise the failure to this gate.
 *
 * @param {object} lease
 * @param {{
 *   records?: object[],
 *   queuePath?: string,
 *   now?: number,
 *   sovereignPrincipal?: string,
 * }} [opts]
 * @returns {Promise<{ pass: boolean, reasons: string[], approval?: object | null }>}
 */
export async function humanApprovalGate(lease, opts = {}) {
  const now = typeof opts.now === "number" && Number.isFinite(opts.now) ? opts.now : Date.now();

  // 0. lease sanity
  if (lease === null || typeof lease !== "object" || Array.isArray(lease)) {
    return { pass: false, reasons: ["lease_invalid: lease must be an object"] };
  }
  if (typeof lease.id !== "string" || lease.id.length === 0) {
    return { pass: false, reasons: ["lease_invalid: lease.id must be a non-empty string"] };
  }

  // 1. expiry. Per doctrine: approval expires after lease.expires_at.
  //    We check expiry BEFORE the queue read so an expired lease fails
  //    cheaply and with a single, unambiguous reason.
  if (isLeaseExpired(lease, now)) {
    return {
      pass: false,
      reasons: [`lease_expired: lease ${lease.id} expired at ${lease.expires_at} (now=${now})`],
    };
  }

  // 2. fast-path: lease does not require approval.
  //    Per Hermes lease shape, `requires_approval` is a boolean. Any
  //    falsy value (false, undefined, 0) means "no operator gate". This
  //    matches the lease.mjs grantLease() behaviour.
  if (!lease.requires_approval) {
    return { pass: true, reasons: [], approval: null };
  }

  // 3. queue load (or accept injected records).
  let records;
  if (Array.isArray(opts.records)) {
    records = opts.records;
  } else {
    const load = await loadPendingApprovals({ queuePath: opts.queuePath });
    if (load.load_status === "missing") {
      return {
        pass: false,
        reasons: [`pending_approvals_queue_missing: ${load.path}`],
      };
    }
    if (load.load_status === "unreadable") {
      return {
        pass: false,
        reasons: [
          `pending_approvals_queue_unreadable: ${load.path}` +
            (load.io_error ? ` (${load.io_error.code || "?"}: ${load.io_error.message})` : ""),
        ],
      };
    }
    records = load.records;
    // parse_issues are advisory — we do not fail the gate on a single
    // malformed line, because that would let a poisoned record DoS the
    // whole queue. If the target lease's record is among the malformed
    // lines, findApproval will return null and the gate will fail with
    // approval_not_found, which is the correct, conservative outcome.
  }

  const approval = findApproval(records, lease.id);
  if (!approval) {
    return {
      pass: false,
      reasons: [`approval_not_found: no record for lease_id ${lease.id} in pending queue`],
    };
  }

  // 4. evaluate the approval record.
  const reasons = [];
  if (approval.approved !== true) {
    reasons.push(`approval_denied: lease ${lease.id} approval record has approved=${JSON.stringify(approval.approved)}`);
  }
  if (approval.signed !== true) {
    reasons.push(`approval_unsigned: lease ${lease.id} approval record has signed=${JSON.stringify(approval.signed)}`);
  }
  if (!matchesSovereign(approval.signed_by, opts.sovereignPrincipal)) {
    reasons.push(
      `approval_signed_by_wrong_principal: lease ${lease.id} approval signed_by=${JSON.stringify(approval.signed_by)}, ` +
      `expected "${(opts.sovereignPrincipal || DEFAULT_SOVEREIGN_PRINCIPAL)}" or "${SOVEREIGN_ROLE_ALIAS}"`,
    );
  }

  if (reasons.length > 0) {
    return { pass: false, reasons, approval };
  }
  return { pass: true, reasons: [], approval };
}

export default humanApprovalGate;
