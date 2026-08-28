// commitment-atoms/encoder.mjs
//
// AtomSmasher module #1 — Commitment Atoms.
//
// Smallest unit of operator-or-system promise. Compresses a decision /
// commitment / lock-in / invariant / deadline / threshold into a
// deterministic, hash-chained, verifiable atom.
//
// Doctrine (from AtomSmasher spec):
//   - Atoms are append-only. They are NEVER edited. An atom is changed only by
//     issuing a NEW atom whose `supersedes` array contains the old atom's id.
//   - Atoms persist in the Reality lane via Æ Cobra Flux writer (origin =
//     'atomsmasher', kind = 'commitment'). The flux chain hash is the global
//     audit chain; the atom's own signature_chain is the per-atom causal chain.
//   - atom_id is content-derived (sha256 of canonical {kind, body,
//     preconditions, supersedes}). It is therefore stable across processes and
//     two callers cannot disagree on the id of a logically identical atom.
//   - signature = { prev_hash, hash } where hash is sha256 of the canonical
//     atom WITH `signature.hash` blanked out. This mirrors Æ Cobra Flux's
//     self-hashing convention so the verifier code is the same shape.
//
// Anti-fluff (LIVE):
//   Bodies containing forbidden words (green_assumed, looks_ok, probably,
//   should_work) are rejected. Atoms of kind 'invariant' or 'promise' MUST
//   carry at least one evidence pointer; an empty evidence array is rejected.
//
// This file is the encoder + validator only. Persistence (Flux write, SQLite
// index, gateway route) belongs to sibling modules and is intentionally NOT
// imported here so the encoder stays pure and unit-testable.

import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const VALID_KINDS = Object.freeze([
  'decision',
  'promise',
  'invariant',
  'deadline',
  'threshold',
]);

export const VALID_STATUSES = Object.freeze([
  'active',
  'fulfilled',
  'revoked',
  'superseded',
]);

const FORBIDDEN_WORDS = Object.freeze([
  'green_assumed',
  'looks_ok',
  'probably',
  'should_work',
]);

// Kinds for which an empty evidence array is a hard reject.
const EVIDENCE_REQUIRED_KINDS = new Set(['invariant', 'promise']);

const ATOM_SCHEMA_ID = 'orange5.atomsmasher.commitment-atom.v0';

// ---------------------------------------------------------------------------
// Canonical JSON + hashing
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON serializer. Object keys sorted lexicographically at every
 * depth so two semantically identical atoms hash to the same value regardless
 * of property insertion order.
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
// Anti-fluff scan (LIVE rule, inherited from AtomSmasher doctrine)
// ---------------------------------------------------------------------------

/**
 * Walks an arbitrary body value and returns the list of forbidden words it
 * contains. Match is case-insensitive, whole-substring against the string
 * representation of every leaf string in the body.
 *
 * @param {unknown} body
 * @returns {string[]} forbidden words actually present (deduped, sorted)
 */
function scanForbiddenWords(body) {
  const hits = new Set();
  const stack = [body];
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
      // keys can carry fluff too
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
// Encoder
// ---------------------------------------------------------------------------

/**
 * Encode a Commitment Atom.
 *
 * @param {Object} params
 * @param {'decision'|'promise'|'invariant'|'deadline'|'threshold'} params.kind
 * @param {Object} params.body                 - typed payload, must be a JSON object
 * @param {string[]} [params.preconditions]    - atom_ids this atom depends on
 * @param {string[]} [params.supersedes]       - atom_ids this atom replaces
 * @param {string[]} [params.evidence]         - receipt paths / receipt ids
 * @param {string}  params.actor               - who is committing (e.g. 'operator:atom', 'system:orangellm')
 * @param {string|null} [params.expires_at]    - ISO 8601 timestamp or null
 * @param {string}  params.prevHash            - prior atom's signature.hash, or 'GENESIS'
 * @param {number}  [params.ts]                - unix ms; defaults to Date.now()
 * @returns {Object} commitment atom
 * @throws {Error} on validation or anti-fluff failure
 */
export function encodeCommitmentAtom({
  kind,
  body,
  preconditions = [],
  supersedes = [],
  evidence = [],
  actor,
  expires_at = null,
  prevHash,
  ts,
}) {
  // ---- input shape -------------------------------------------------------
  if (!VALID_KINDS.includes(kind)) {
    throw new Error(
      `commitment-atom: invalid kind '${kind}'. Must be one of: ${VALID_KINDS.join(', ')}`,
    );
  }
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('commitment-atom: body must be a non-null object');
  }
  if (!Array.isArray(preconditions)) {
    throw new Error('commitment-atom: preconditions must be an array');
  }
  if (!Array.isArray(supersedes)) {
    throw new Error('commitment-atom: supersedes must be an array');
  }
  if (!Array.isArray(evidence)) {
    throw new Error('commitment-atom: evidence must be an array');
  }
  if (typeof actor !== 'string' || actor.length === 0) {
    throw new Error('commitment-atom: actor must be a non-empty string');
  }
  if (expires_at !== null && typeof expires_at !== 'string') {
    throw new Error('commitment-atom: expires_at must be ISO string or null');
  }
  if (expires_at && Number.isNaN(Date.parse(expires_at))) {
    throw new Error(`commitment-atom: expires_at not parseable as ISO date: ${expires_at}`);
  }
  if (typeof prevHash !== 'string' || prevHash.length === 0) {
    throw new Error("commitment-atom: prevHash required (use 'GENESIS' for first atom)");
  }

  // ---- anti-fluff (LIVE rule, hard reject) -------------------------------
  const forbidden = scanForbiddenWords(body);
  if (forbidden.length > 0) {
    throw new Error(
      `commitment-atom: anti-fluff reject — body contains forbidden words: ${forbidden.join(', ')}`,
    );
  }
  if (EVIDENCE_REQUIRED_KINDS.has(kind) && evidence.length === 0) {
    throw new Error(
      `commitment-atom: kind '${kind}' requires at least one evidence pointer (got empty array)`,
    );
  }

  // ---- atom_id = sha256(canonical(kind + body + preconditions + supersedes))
  // Note: id is intentionally independent of actor / expires_at / ts / prevHash
  // so the *content* of the commitment has a stable fingerprint. Two callers
  // committing the same content arrive at the same atom_id.
  const idPayload = canonicalStringify({
    kind,
    body,
    preconditions,
    supersedes,
  });
  const atom_id = sha256(idPayload);

  const createdAt = typeof ts === 'number' ? ts : Date.now();

  // Compose atom WITH signature.hash blank, then hash, then fill it in.
  const atom = {
    schema: ATOM_SCHEMA_ID,
    atom_id,
    kind,
    body,
    preconditions,
    supersedes,
    evidence,
    actor,
    expires_at,
    status: 'active',
    created_at: new Date(createdAt).toISOString(),
    signature: {
      prev_hash: prevHash,
      hash: '',
    },
  };

  const canonical = canonicalStringify({
    ...atom,
    signature: { prev_hash: prevHash, hash: '' },
  });
  atom.signature.hash = sha256(canonical);

  return atom;
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/**
 * JSON Schema for a Commitment Atom (draft 2020-12, embedded here so the
 * encoder has no Ajv dependency — fast inline validator below enforces the
 * same rules. The schema object is exported for downstream consumers that
 * want to plug it into Ajv themselves.)
 */
export const COMMITMENT_ATOM_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: ATOM_SCHEMA_ID,
  title: 'Orange5 AtomSmasher Commitment Atom v0',
  type: 'object',
  required: [
    'schema',
    'atom_id',
    'kind',
    'body',
    'preconditions',
    'supersedes',
    'evidence',
    'actor',
    'expires_at',
    'status',
    'created_at',
    'signature',
  ],
  properties: {
    schema: { const: ATOM_SCHEMA_ID },
    atom_id: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    kind: { enum: [...VALID_KINDS] },
    body: { type: 'object' },
    preconditions: { type: 'array', items: { type: 'string' } },
    supersedes: { type: 'array', items: { type: 'string' } },
    evidence: { type: 'array', items: { type: 'string' } },
    actor: { type: 'string', minLength: 1 },
    expires_at: { type: ['string', 'null'] },
    status: { enum: [...VALID_STATUSES] },
    signed_status: { enum: [...VALID_STATUSES] },
    lifecycle_status: { enum: [...VALID_STATUSES] },
    created_at: { type: 'string' },
    signature: {
      type: 'object',
      required: ['prev_hash', 'hash'],
      properties: {
        prev_hash: { type: 'string', minLength: 1 },
        hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
});

/**
 * Validate a Commitment Atom against the schema + anti-fluff rules + signature
 * integrity.
 *
 * @param {unknown} atom
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateCommitmentAtom(atom) {
  const errors = [];

  if (atom == null || typeof atom !== 'object' || Array.isArray(atom)) {
    return { valid: false, errors: ['atom must be a non-null object'] };
  }

  // ---- structural -------------------------------------------------------
  const required = COMMITMENT_ATOM_SCHEMA.required;
  for (const key of required) {
    if (!(key in atom)) errors.push(`missing required field: ${key}`);
  }
  // additionalProperties: false
  for (const key of Object.keys(atom)) {
    if (!(key in COMMITMENT_ATOM_SCHEMA.properties)) {
      errors.push(`unknown field: ${key}`);
    }
  }
  if (errors.length > 0) return { valid: false, errors };

  if (atom.schema !== ATOM_SCHEMA_ID) {
    errors.push(`schema must be '${ATOM_SCHEMA_ID}', got '${atom.schema}'`);
  }
  if (!/^[a-f0-9]{64}$/.test(atom.atom_id)) {
    errors.push('atom_id must be 64-char lowercase hex (sha256)');
  }
  if (!VALID_KINDS.includes(atom.kind)) {
    errors.push(`kind must be one of: ${VALID_KINDS.join(', ')}`);
  }
  if (atom.body == null || typeof atom.body !== 'object' || Array.isArray(atom.body)) {
    errors.push('body must be a non-null object');
  }
  for (const arrField of ['preconditions', 'supersedes', 'evidence']) {
    if (!Array.isArray(atom[arrField])) {
      errors.push(`${arrField} must be an array`);
    } else {
      for (const item of atom[arrField]) {
        if (typeof item !== 'string') {
          errors.push(`${arrField} must contain only strings`);
          break;
        }
      }
    }
  }
  if (typeof atom.actor !== 'string' || atom.actor.length === 0) {
    errors.push('actor must be a non-empty string');
  }
  if (atom.expires_at !== null && typeof atom.expires_at !== 'string') {
    errors.push('expires_at must be ISO string or null');
  }
  if (atom.expires_at && Number.isNaN(Date.parse(atom.expires_at))) {
    errors.push(`expires_at not parseable as ISO date: ${atom.expires_at}`);
  }
  if (!VALID_STATUSES.includes(atom.status)) {
    errors.push(`status must be one of: ${VALID_STATUSES.join(', ')}`);
  }
  if ('signed_status' in atom && !VALID_STATUSES.includes(atom.signed_status)) {
    errors.push(`signed_status must be one of: ${VALID_STATUSES.join(', ')}`);
  }
  if ('lifecycle_status' in atom && !VALID_STATUSES.includes(atom.lifecycle_status)) {
    errors.push(`lifecycle_status must be one of: ${VALID_STATUSES.join(', ')}`);
  }
  if (typeof atom.created_at !== 'string' || Number.isNaN(Date.parse(atom.created_at))) {
    errors.push('created_at must be parseable ISO 8601 string');
  }
  if (
    atom.signature == null ||
    typeof atom.signature !== 'object' ||
    Array.isArray(atom.signature)
  ) {
    errors.push('signature must be an object');
  } else {
    if (typeof atom.signature.prev_hash !== 'string' || atom.signature.prev_hash.length === 0) {
      errors.push('signature.prev_hash must be non-empty string');
    }
    if (!/^[a-f0-9]{64}$/.test(atom.signature.hash || '')) {
      errors.push('signature.hash must be 64-char lowercase hex (sha256)');
    }
    for (const k of Object.keys(atom.signature)) {
      if (k !== 'prev_hash' && k !== 'hash') {
        errors.push(`signature.${k}: unknown field`);
      }
    }
  }

  if (errors.length > 0) return { valid: false, errors };

  // ---- anti-fluff -------------------------------------------------------
  const forbidden = scanForbiddenWords(atom.body);
  if (forbidden.length > 0) {
    errors.push(`anti-fluff: body contains forbidden words: ${forbidden.join(', ')}`);
  }
  if (EVIDENCE_REQUIRED_KINDS.has(atom.kind) && atom.evidence.length === 0) {
    errors.push(`kind '${atom.kind}' requires at least one evidence pointer`);
  }

  // ---- cryptographic integrity -----------------------------------------
  // Recompute atom_id and signature.hash; mismatch means the atom was forged
  // or tampered with after encoding.
  const expectedId = sha256(
    canonicalStringify({
      kind: atom.kind,
      body: atom.body,
      preconditions: atom.preconditions,
      supersedes: atom.supersedes,
    }),
  );
  if (expectedId !== atom.atom_id) {
    errors.push(
      `atom_id integrity: expected ${expectedId}, got ${atom.atom_id} (tampered or wrong canonicalization)`,
    );
  }

  // SQLite exposes mutable lifecycle state while the signed atom remains
  // immutable. Reconstruct the original payload before checking its hash.
  const signedAtom = { ...atom, status: atom.signed_status ?? atom.status };
  delete signedAtom.signed_status;
  delete signedAtom.lifecycle_status;
  const sigCanonical = canonicalStringify({
    ...signedAtom,
    signature: { prev_hash: atom.signature.prev_hash, hash: '' },
  });
  const expectedHash = sha256(sigCanonical);
  if (expectedHash !== atom.signature.hash) {
    errors.push(
      `signature.hash integrity: expected ${expectedHash}, got ${atom.signature.hash}`,
    );
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Re-exports for downstream tooling
// ---------------------------------------------------------------------------

export const __internals = Object.freeze({
  canonicalStringify,
  sha256,
  scanForbiddenWords,
  FORBIDDEN_WORDS: [...FORBIDDEN_WORDS],
  EVIDENCE_REQUIRED_KINDS: [...EVIDENCE_REQUIRED_KINDS],
  ATOM_SCHEMA_ID,
});
