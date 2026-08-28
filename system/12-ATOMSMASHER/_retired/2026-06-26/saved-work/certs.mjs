// saved-work/certs.mjs
//
// AtomSmasher module #8 — Saved Work Certificates.
//
// A Saved Work Certificate proves a piece of work was done AND can be reused.
// It is the minted, hash-chained, content-addressed receipt for a unit of
// completed work, designed so a future caller can:
//   1. assert that this work was performed (mint receipt),
//   2. verify the certificate's hash chain + content integrity,
//   3. redeem the certificate to short-circuit re-doing equivalent work.
//
// Doctrine (binding):
//   - Certificates are APPEND-ONLY. A cert is never edited. To revise the
//     work, mint a NEW certificate; the old one can be marked `redeemed` via
//     redeem(), which records the consumer, not by mutation of cert body.
//   - `cert_id` is CONTENT-DERIVED: sha256 of canonical(
//       {schema, work_kind, work_hash, output_hash,
//        inputs_digest, references_receipt}).
//     Two callers asserting the same work AND output collide on cert_id —
//     by design. The chain hash differs (it carries actor/ts/prevHash).
//   - `signature.hash` is sha256 of the canonical cert with `signature.hash`
//     blanked out. Same self-hashing convention as Commitment Atoms so the
//     verifier code shape is identical and the Reality lane can witness both.
//   - `signature_chain` is the per-cert causal chain: a non-empty array of
//     {prev_hash, hash} pairs. The first link's prev_hash MUST be 'GENESIS'
//     or a sha256-shaped string referencing a prior cert/atom hash. Each
//     subsequent link's prev_hash MUST equal the previous link's hash.
//     This lets a cert carry its own provenance history (e.g. mint -> redeem
//     events stamped into the same chain) without a separate event log.
//   - `references_receipt` is a non-empty array of receipt pointers. A
//     certificate that claims work was done with ZERO receipt evidence is a
//     theatrical badge. Anti-fluff hard-rejects it.
//
// Anti-fluff (LIVE, hard reject):
//   - Forbidden words anywhere in stringified body / output_summary:
//     green_assumed, looks_ok, probably, should_work.
//   - references_receipt must be a non-empty array of non-empty strings.
//   - work_hash and output_hash MUST be 64-char lowercase hex (sha256).
//
// Persistence + gateway:
//   - This file is the encoder + validator + verify/redeem state-transition
//     logic. Persistence (Æ Cobra Flux Reality lane write + SQLite index)
//     belongs to a sibling `store.mjs` that is NOT in scope of this drop.
//     The gateway routes POST /v1/atomsmasher/certs/{mint,verify,redeem}
//     are also out of scope here — they ride the same pattern as the
//     commitment-atoms gateway at 06-ORANGELLM/server/routes/atomsmasher.mjs.
//   - Pure & dependency-free so the cert math stays unit-testable on its
//     own. No file I/O, no DB, no HTTP. Mom's Law: state the gap; do not
//     fake the wiring.
//
// What `verify()` checks:
//   - schema id match
//   - additionalProperties: false (no unknown keys)
//   - all required fields present + typed
//   - cert_id integrity (re-derived from canonical payload)
//   - signature_chain shape: non-empty, each link is well-formed sha256,
//     prev_hash linkage is contiguous
//   - signature.hash integrity (re-derived from canonical cert)
//   - anti-fluff scan
//   - references_receipt non-empty and all-string
//   - work_hash + output_hash hex shape
//
// What `redeem()` does:
//   - Validates the cert (rejects if invalid).
//   - Rejects if `status === 'revoked'` or `status === 'redeemed'` and the
//     cert's policy is `single_use` (default).
//   - Returns a NEW cert object: same content fields, status='redeemed',
//     signature_chain extended with a fresh link whose prev_hash points at
//     the prior chain head and whose hash seals the new chain.
//   - The original cert is NOT mutated. The returned cert is what the
//     persistence layer would write as the next row.
//
// Schema id: orange5.atomsmasher.saved-work-cert.v0

import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CERT_SCHEMA_ID = 'orange5.atomsmasher.saved-work-cert.v0';

export const VALID_STATUSES = Object.freeze([
  'minted',     // freshly created, not yet consumed
  'redeemed',   // reused by a downstream caller (single_use policy spent)
  'revoked',    // operator pulled it; do not redeem
]);

export const VALID_POLICIES = Object.freeze([
  'single_use', // one redeem permitted; subsequent redeems must be rejected
  'multi_use',  // any number of redeems permitted; status stays 'minted' but
                // the signature_chain still extends per redeem event
]);

const FORBIDDEN_WORDS = Object.freeze([
  'green_assumed',
  'looks_ok',
  'probably',
  'should_work',
]);

const HEX64_RE = /^[a-f0-9]{64}$/;
const GENESIS = 'GENESIS';

// ---------------------------------------------------------------------------
// Canonical JSON + hashing (lifted from commitment-atoms convention so the
// hash semantics are identical across AtomSmasher modules)
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON serializer. Object keys sorted lexicographically at every
 * depth so two semantically identical certs hash to the same value regardless
 * of property insertion order.
 *
 * @param {unknown} value
 * @returns {string}
 */
function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalStringify).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map(
    (k) => JSON.stringify(k) + ':' + canonicalStringify(value[k]),
  );
  return '{' + parts.join(',') + '}';
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// ---------------------------------------------------------------------------
// Anti-fluff scan
// ---------------------------------------------------------------------------

/**
 * Walks an arbitrary value and returns the list of forbidden words it
 * contains. Case-insensitive substring match against every leaf string AND
 * every object key.
 *
 * @param {unknown} value
 * @returns {string[]} forbidden words present (deduped, sorted)
 */
function scanForbiddenWords(value) {
  const hits = new Set();
  const stack = [value];
  while (stack.length) {
    const v = stack.pop();
    if (v == null) continue;
    if (typeof v === 'string') {
      const lower = v.toLowerCase();
      for (const word of FORBIDDEN_WORDS) {
        if (lower.includes(word)) hits.add(word);
      }
    } else if (Array.isArray(v)) {
      for (const item of v) stack.push(item);
    } else if (typeof v === 'object') {
      for (const k of Object.keys(v)) {
        const lk = k.toLowerCase();
        for (const word of FORBIDDEN_WORDS) {
          if (lk.includes(word)) hits.add(word);
        }
        stack.push(v[k]);
      }
    }
  }
  return [...hits].sort();
}

// ---------------------------------------------------------------------------
// Hashing helpers
// ---------------------------------------------------------------------------

/**
 * Compute the content-derived cert_id from the parts that define WHAT the
 * certificate certifies. Excludes actor/ts/signature_chain so two callers
 * who certify the same {work, output, inputs, receipts} arrive at the same
 * cert_id.
 */
function deriveCertId({
  work_kind,
  work_hash,
  output_hash,
  inputs_digest,
  references_receipt,
}) {
  return sha256(
    canonicalStringify({
      schema: CERT_SCHEMA_ID,
      work_kind,
      work_hash,
      output_hash,
      inputs_digest,
      references_receipt,
    }),
  );
}

/**
 * Compute the self-hash of a cert: canonicalize with the most recent
 * signature_chain link's `hash` field blanked out, then sha256.
 *
 * NOTE: only the LAST chain link is unsealed during the hash. Prior links
 * are part of the canonical payload and contribute to the final seal. This
 * is what makes the chain genuinely append-only: rewriting any earlier link
 * breaks the most recent hash.
 */
function sealCert(cert) {
  if (!Array.isArray(cert.signature_chain) || cert.signature_chain.length === 0) {
    throw new Error('cert.signature_chain must be a non-empty array');
  }
  const tailIdx = cert.signature_chain.length - 1;
  const chainCopy = cert.signature_chain.map((link, i) =>
    i === tailIdx ? { prev_hash: link.prev_hash, hash: '' } : { ...link },
  );
  const canonical = canonicalStringify({ ...cert, signature_chain: chainCopy });
  return sha256(canonical);
}

// ---------------------------------------------------------------------------
// JSON Schema (exported so downstream Ajv consumers can plug it in; inline
// validator below enforces the same rules without an Ajv dependency)
// ---------------------------------------------------------------------------

export const SAVED_WORK_CERT_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: CERT_SCHEMA_ID,
  title: 'Orange5 AtomSmasher Saved Work Certificate v0',
  type: 'object',
  required: [
    'schema',
    'cert_id',
    'work_kind',
    'work_hash',
    'output_hash',
    'inputs_digest',
    'output_summary',
    'references_receipt',
    'actor',
    'created_at',
    'policy',
    'status',
    'signature_chain',
  ],
  properties: {
    schema: { const: CERT_SCHEMA_ID },
    cert_id: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    work_kind: { type: 'string', minLength: 1 },
    work_hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    output_hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    inputs_digest: { type: 'string', minLength: 1 },
    output_summary: { type: 'string', minLength: 1 },
    references_receipt: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 },
    },
    actor: { type: 'string', minLength: 1 },
    created_at: { type: 'string', minLength: 1 },
    policy: { enum: [...VALID_POLICIES] },
    status: { enum: [...VALID_STATUSES] },
    signature_chain: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['prev_hash', 'hash'],
        properties: {
          prev_hash: { type: 'string', minLength: 1 },
          hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          event: { type: 'string', minLength: 1 },
          ts: { type: 'string', minLength: 1 },
          consumer: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
});

// ---------------------------------------------------------------------------
// mint()
// ---------------------------------------------------------------------------

/**
 * Mint a fresh Saved Work Certificate.
 *
 * @param {Object} params
 * @param {string}   params.work_kind          - free-form label (e.g. 'compile', 'eval-run', 'doc-author')
 * @param {string}   params.work_hash          - sha256 of the canonical work spec/input
 * @param {string}   params.output_hash        - sha256 of the canonical output artifact
 * @param {string}   params.inputs_digest      - any stable string fingerprint of inputs (need not be sha256)
 * @param {string}   params.output_summary     - human-readable, non-fluff summary of what was produced
 * @param {string[]} params.references_receipt - non-empty list of receipt paths/ids that prove the work
 * @param {string}   params.actor              - who is minting (e.g. 'operator:atom', 'system:atomsmasher')
 * @param {string}   params.prevHash           - prior chain head: 'GENESIS' or 64-hex sha256
 * @param {'single_use'|'multi_use'} [params.policy] - default 'single_use'
 * @param {number}   [params.ts]               - unix ms; defaults to Date.now()
 * @returns {Object} minted certificate
 * @throws {Error}   on invalid input or anti-fluff hit
 */
export function mint({
  work_kind,
  work_hash,
  output_hash,
  inputs_digest,
  output_summary,
  references_receipt,
  actor,
  prevHash,
  policy = 'single_use',
  ts,
}) {
  // ---- input shape -------------------------------------------------------
  if (typeof work_kind !== 'string' || work_kind.length === 0) {
    throw new Error('saved-work-cert: work_kind must be a non-empty string');
  }
  if (typeof work_hash !== 'string' || !HEX64_RE.test(work_hash)) {
    throw new Error('saved-work-cert: work_hash must be 64-char lowercase hex (sha256)');
  }
  if (typeof output_hash !== 'string' || !HEX64_RE.test(output_hash)) {
    throw new Error('saved-work-cert: output_hash must be 64-char lowercase hex (sha256)');
  }
  if (typeof inputs_digest !== 'string' || inputs_digest.length === 0) {
    throw new Error('saved-work-cert: inputs_digest must be a non-empty string');
  }
  if (typeof output_summary !== 'string' || output_summary.length === 0) {
    throw new Error('saved-work-cert: output_summary must be a non-empty string');
  }
  if (!Array.isArray(references_receipt) || references_receipt.length === 0) {
    throw new Error(
      'saved-work-cert: references_receipt must be a non-empty array of receipt pointers',
    );
  }
  for (const ref of references_receipt) {
    if (typeof ref !== 'string' || ref.length === 0) {
      throw new Error('saved-work-cert: every references_receipt entry must be a non-empty string');
    }
  }
  if (typeof actor !== 'string' || actor.length === 0) {
    throw new Error('saved-work-cert: actor must be a non-empty string');
  }
  if (typeof prevHash !== 'string' || prevHash.length === 0) {
    throw new Error("saved-work-cert: prevHash required (use 'GENESIS' for first cert)");
  }
  if (prevHash !== GENESIS && !HEX64_RE.test(prevHash)) {
    throw new Error("saved-work-cert: prevHash must be 'GENESIS' or 64-char lowercase hex");
  }
  if (!VALID_POLICIES.includes(policy)) {
    throw new Error(
      `saved-work-cert: policy must be one of: ${VALID_POLICIES.join(', ')}`,
    );
  }

  // ---- anti-fluff (LIVE, hard reject) ------------------------------------
  const forbidden = scanForbiddenWords({
    work_kind,
    output_summary,
    references_receipt,
  });
  if (forbidden.length > 0) {
    throw new Error(
      `saved-work-cert: anti-fluff reject — contains forbidden words: ${forbidden.join(', ')}`,
    );
  }

  // ---- content-derived cert_id -------------------------------------------
  const cert_id = deriveCertId({
    work_kind,
    work_hash,
    output_hash,
    inputs_digest,
    references_receipt,
  });

  const createdAtMs = typeof ts === 'number' ? ts : Date.now();
  const createdAt = new Date(createdAtMs).toISOString();

  // ---- compose with a single signature_chain link, hash blank ------------
  const cert = {
    schema: CERT_SCHEMA_ID,
    cert_id,
    work_kind,
    work_hash,
    output_hash,
    inputs_digest,
    output_summary,
    references_receipt: [...references_receipt],
    actor,
    created_at: createdAt,
    policy,
    status: 'minted',
    signature_chain: [
      {
        prev_hash: prevHash,
        hash: '',
        event: 'mint',
        ts: createdAt,
      },
    ],
  };

  cert.signature_chain[0].hash = sealCert(cert);
  return cert;
}

// ---------------------------------------------------------------------------
// verify()
// ---------------------------------------------------------------------------

/**
 * Verify a Saved Work Certificate against schema, anti-fluff, and
 * cryptographic integrity (cert_id + signature_chain + self-hash).
 *
 * @param {unknown} cert
 * @returns {{valid: boolean, errors: string[]}}
 */
export function verify(cert) {
  const errors = [];

  if (cert == null || typeof cert !== 'object' || Array.isArray(cert)) {
    return { valid: false, errors: ['cert must be a non-null object'] };
  }

  // ---- required keys ----
  for (const key of SAVED_WORK_CERT_SCHEMA.required) {
    if (!(key in cert)) errors.push(`missing required field: ${key}`);
  }
  // ---- additionalProperties: false ----
  for (const key of Object.keys(cert)) {
    if (!(key in SAVED_WORK_CERT_SCHEMA.properties)) {
      errors.push(`unknown field: ${key}`);
    }
  }
  if (errors.length > 0) return { valid: false, errors };

  // ---- typed checks ----
  if (cert.schema !== CERT_SCHEMA_ID) {
    errors.push(`schema must be '${CERT_SCHEMA_ID}', got '${cert.schema}'`);
  }
  if (!HEX64_RE.test(cert.cert_id)) {
    errors.push('cert_id must be 64-char lowercase hex (sha256)');
  }
  if (typeof cert.work_kind !== 'string' || cert.work_kind.length === 0) {
    errors.push('work_kind must be a non-empty string');
  }
  if (!HEX64_RE.test(cert.work_hash)) {
    errors.push('work_hash must be 64-char lowercase hex (sha256)');
  }
  if (!HEX64_RE.test(cert.output_hash)) {
    errors.push('output_hash must be 64-char lowercase hex (sha256)');
  }
  if (typeof cert.inputs_digest !== 'string' || cert.inputs_digest.length === 0) {
    errors.push('inputs_digest must be a non-empty string');
  }
  if (typeof cert.output_summary !== 'string' || cert.output_summary.length === 0) {
    errors.push('output_summary must be a non-empty string');
  }
  if (!Array.isArray(cert.references_receipt) || cert.references_receipt.length === 0) {
    errors.push('references_receipt must be a non-empty array');
  } else {
    for (const r of cert.references_receipt) {
      if (typeof r !== 'string' || r.length === 0) {
        errors.push('every references_receipt entry must be a non-empty string');
        break;
      }
    }
  }
  if (typeof cert.actor !== 'string' || cert.actor.length === 0) {
    errors.push('actor must be a non-empty string');
  }
  if (typeof cert.created_at !== 'string' || Number.isNaN(Date.parse(cert.created_at))) {
    errors.push('created_at must be parseable ISO 8601 string');
  }
  if (!VALID_POLICIES.includes(cert.policy)) {
    errors.push(`policy must be one of: ${VALID_POLICIES.join(', ')}`);
  }
  if (!VALID_STATUSES.includes(cert.status)) {
    errors.push(`status must be one of: ${VALID_STATUSES.join(', ')}`);
  }
  if (!Array.isArray(cert.signature_chain) || cert.signature_chain.length === 0) {
    errors.push('signature_chain must be a non-empty array');
  }
  if (errors.length > 0) return { valid: false, errors };

  // ---- signature_chain shape + linkage ----
  for (let i = 0; i < cert.signature_chain.length; i++) {
    const link = cert.signature_chain[i];
    if (link == null || typeof link !== 'object' || Array.isArray(link)) {
      errors.push(`signature_chain[${i}] must be an object`);
      continue;
    }
    if (typeof link.prev_hash !== 'string' || link.prev_hash.length === 0) {
      errors.push(`signature_chain[${i}].prev_hash must be non-empty string`);
    }
    if (!HEX64_RE.test(link.hash || '')) {
      errors.push(`signature_chain[${i}].hash must be 64-char lowercase hex`);
    }
    // chain linkage
    if (i === 0) {
      if (link.prev_hash !== GENESIS && !HEX64_RE.test(link.prev_hash)) {
        errors.push(`signature_chain[0].prev_hash must be 'GENESIS' or 64-char hex`);
      }
    } else {
      const prevLink = cert.signature_chain[i - 1];
      if (link.prev_hash !== prevLink.hash) {
        errors.push(
          `signature_chain[${i}].prev_hash does not match signature_chain[${i - 1}].hash`,
        );
      }
    }
  }
  if (errors.length > 0) return { valid: false, errors };

  // ---- anti-fluff ----
  const forbidden = scanForbiddenWords({
    work_kind: cert.work_kind,
    output_summary: cert.output_summary,
    references_receipt: cert.references_receipt,
  });
  if (forbidden.length > 0) {
    errors.push(`anti-fluff: contains forbidden words: ${forbidden.join(', ')}`);
  }

  // ---- cert_id integrity ----
  const expectedId = deriveCertId({
    work_kind: cert.work_kind,
    work_hash: cert.work_hash,
    output_hash: cert.output_hash,
    inputs_digest: cert.inputs_digest,
    references_receipt: cert.references_receipt,
  });
  if (expectedId !== cert.cert_id) {
    errors.push(
      `cert_id integrity: expected ${expectedId}, got ${cert.cert_id} (tampered or wrong canonicalization)`,
    );
  }

  // ---- signature.hash integrity (recompute on tail link) ----
  let expectedHash;
  try {
    expectedHash = sealCert(cert);
  } catch (err) {
    errors.push(`sealCert failed: ${err.message}`);
    return { valid: false, errors };
  }
  const tail = cert.signature_chain[cert.signature_chain.length - 1];
  if (expectedHash !== tail.hash) {
    errors.push(
      `signature_chain tail hash integrity: expected ${expectedHash}, got ${tail.hash}`,
    );
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// redeem()
// ---------------------------------------------------------------------------

/**
 * Redeem a Saved Work Certificate. Returns a NEW cert object representing
 * the post-redeem state. The input cert is not mutated.
 *
 * Single-use semantics:
 *   - If cert.policy === 'single_use' and cert.status === 'minted', the
 *     returned cert has status='redeemed' and a fresh chain link recording
 *     the redeem event.
 *   - If status is already 'redeemed' (single_use spent) or 'revoked', this
 *     throws.
 *
 * Multi-use semantics:
 *   - If cert.policy === 'multi_use', status stays 'minted' but a fresh
 *     chain link is appended for the redeem event. Each redeem extends the
 *     chain; replays can be distinguished by chain depth.
 *
 * @param {Object} cert
 * @param {Object} params
 * @param {string} params.consumer - actor consuming the cert (e.g. 'task:replay-001')
 * @param {string} [params.reason] - optional human-readable reason
 * @param {number} [params.ts]     - unix ms; defaults to Date.now()
 * @returns {Object} new cert representing the post-redeem state
 * @throws {Error}   on invalid cert or policy violation
 */
export function redeem(cert, { consumer, reason, ts } = {}) {
  // 1. Validate the input cert.
  const v = verify(cert);
  if (!v.valid) {
    throw new Error(`saved-work-cert: redeem refused — invalid cert: ${v.errors.join('; ')}`);
  }
  if (typeof consumer !== 'string' || consumer.length === 0) {
    throw new Error('saved-work-cert: redeem requires a non-empty consumer string');
  }
  if (reason !== undefined && (typeof reason !== 'string' || reason.length === 0)) {
    throw new Error('saved-work-cert: redeem reason, if provided, must be a non-empty string');
  }

  // 2. Policy gating.
  if (cert.status === 'revoked') {
    throw new Error('saved-work-cert: cannot redeem — cert status=revoked');
  }
  if (cert.status === 'redeemed' && cert.policy === 'single_use') {
    throw new Error('saved-work-cert: single_use cert already redeemed');
  }

  // 3. Anti-fluff on consumer/reason text — same standard as mint.
  const forbidden = scanForbiddenWords({ consumer, reason: reason || '' });
  if (forbidden.length > 0) {
    throw new Error(
      `saved-work-cert: anti-fluff reject on redeem — contains forbidden words: ${forbidden.join(', ')}`,
    );
  }

  // 4. Build the post-redeem cert (deep-ish copy of immutable content; new
  //    signature_chain extended with a fresh link).
  const redeemedAtMs = typeof ts === 'number' ? ts : Date.now();
  const redeemedAt = new Date(redeemedAtMs).toISOString();

  const priorChain = cert.signature_chain.map((l) => ({ ...l }));
  const priorTail = priorChain[priorChain.length - 1];

  const newCert = {
    schema: cert.schema,
    cert_id: cert.cert_id,
    work_kind: cert.work_kind,
    work_hash: cert.work_hash,
    output_hash: cert.output_hash,
    inputs_digest: cert.inputs_digest,
    output_summary: cert.output_summary,
    references_receipt: [...cert.references_receipt],
    actor: cert.actor,
    created_at: cert.created_at,
    policy: cert.policy,
    status: cert.policy === 'single_use' ? 'redeemed' : 'minted',
    signature_chain: [
      ...priorChain,
      {
        prev_hash: priorTail.hash,
        hash: '',
        event: 'redeem',
        ts: redeemedAt,
        consumer,
        ...(reason ? { reason } : {}),
      },
    ],
  };

  // Strip undefined keys that may have crept in via spread (defensive — the
  // canonicalizer doesn't choke on them, but additionalProperties:false will).
  const tailLink = newCert.signature_chain[newCert.signature_chain.length - 1];
  for (const k of Object.keys(tailLink)) {
    if (tailLink[k] === undefined) delete tailLink[k];
  }

  tailLink.hash = sealCert(newCert);

  // 5. Final defensive verify on the freshly extended cert.
  const v2 = verify(newCert);
  if (!v2.valid) {
    throw new Error(
      `saved-work-cert: redeem produced an invalid cert: ${v2.errors.join('; ')}`,
    );
  }

  return newCert;
}

// ---------------------------------------------------------------------------
// revoke()
// ---------------------------------------------------------------------------

/**
 * Revoke a Saved Work Certificate. Returns a NEW cert with status='revoked'
 * and a fresh chain link recording the revoke event. Input cert is not
 * mutated.
 *
 * Revoking a 'revoked' cert is a no-op error: idempotent revoke would mask
 * intent. Operator must see the existing revocation.
 */
export function revoke(cert, { actor, reason, ts } = {}) {
  const v = verify(cert);
  if (!v.valid) {
    throw new Error(`saved-work-cert: revoke refused — invalid cert: ${v.errors.join('; ')}`);
  }
  if (typeof actor !== 'string' || actor.length === 0) {
    throw new Error('saved-work-cert: revoke requires a non-empty actor string');
  }
  if (cert.status === 'revoked') {
    throw new Error('saved-work-cert: cert already revoked');
  }
  if (reason !== undefined && (typeof reason !== 'string' || reason.length === 0)) {
    throw new Error('saved-work-cert: revoke reason, if provided, must be a non-empty string');
  }
  const forbidden = scanForbiddenWords({ actor, reason: reason || '' });
  if (forbidden.length > 0) {
    throw new Error(
      `saved-work-cert: anti-fluff reject on revoke — contains forbidden words: ${forbidden.join(', ')}`,
    );
  }

  const revokedAtMs = typeof ts === 'number' ? ts : Date.now();
  const revokedAt = new Date(revokedAtMs).toISOString();

  const priorChain = cert.signature_chain.map((l) => ({ ...l }));
  const priorTail = priorChain[priorChain.length - 1];

  const newCert = {
    schema: cert.schema,
    cert_id: cert.cert_id,
    work_kind: cert.work_kind,
    work_hash: cert.work_hash,
    output_hash: cert.output_hash,
    inputs_digest: cert.inputs_digest,
    output_summary: cert.output_summary,
    references_receipt: [...cert.references_receipt],
    actor: cert.actor,
    created_at: cert.created_at,
    policy: cert.policy,
    status: 'revoked',
    signature_chain: [
      ...priorChain,
      {
        prev_hash: priorTail.hash,
        hash: '',
        event: 'revoke',
        ts: revokedAt,
        consumer: actor,
        ...(reason ? { reason } : {}),
      },
    ],
  };

  const tailLink = newCert.signature_chain[newCert.signature_chain.length - 1];
  for (const k of Object.keys(tailLink)) {
    if (tailLink[k] === undefined) delete tailLink[k];
  }
  tailLink.hash = sealCert(newCert);

  const v2 = verify(newCert);
  if (!v2.valid) {
    throw new Error(
      `saved-work-cert: revoke produced an invalid cert: ${v2.errors.join('; ')}`,
    );
  }
  return newCert;
}

// ---------------------------------------------------------------------------
// Re-exports for downstream tooling + unit tests
// ---------------------------------------------------------------------------

export const __internals = Object.freeze({
  canonicalStringify,
  sha256,
  scanForbiddenWords,
  deriveCertId,
  sealCert,
  HEX64_RE,
  GENESIS,
  FORBIDDEN_WORDS: [...FORBIDDEN_WORDS],
  CERT_SCHEMA_ID,
});
