// commitment-atoms/decoder.mjs
//
// AtomSmasher module #1 — Commitment Atoms — DECODER.
//
// Companion to ./encoder.mjs. The encoder collapses a commitment into a
// content-hashed, hash-chained atom. The decoder re-expands an atom into:
//
//   1. Human-readable Markdown for audit (decodeCommitmentAtom)
//   2. The full provenance graph reached via `preconditions` + `supersedes`
//      (traverseChain), so an auditor can answer "what does this promise
//      actually rest on, and what older commitments did it replace?"
//
// Doctrine (Mom's Law applies):
//   - The decoder NEVER mutates atoms.
//   - The decoder NEVER fabricates fields. If an atom is missing a field, the
//     Markdown says so explicitly ("(missing)") instead of inventing prose.
//   - Unresolved precondition / supersedes ids are surfaced as
//     "UNRESOLVED" rather than silently dropped. An auditor must see the gap.
//   - Cycles in the graph are detected and labelled, never traversed forever.
//   - Signature-chain integrity is *not re-verified* here (that is
//     validateCommitmentAtom's job in encoder.mjs). The decoder simply
//     displays prev_hash → hash so an auditor can follow the chain.
//   - No external dependencies. Pure Node 20+.
//
// atomStore contract (duck-typed; SQLite index or in-memory Map both work):
//   atomStore.get(atom_id)  -> atom | null | undefined
// OR
//   atomStore[atom_id]      -> atom
// OR
//   plain Map<string, atom>
//
// The decoder accepts any of those shapes so it can run against the LIVE
// SQLite index, an in-process cache, or a unit-test fixture without an
// adapter layer.

import { VALID_KINDS, VALID_STATUSES } from './encoder.mjs';

// ---------------------------------------------------------------------------
// Store accessor (duck-typed)
// ---------------------------------------------------------------------------

/**
 * Resolve an atom_id against any of the supported store shapes.
 * Returns null when the store cannot produce that atom.
 */
function lookup(store, atom_id) {
  if (store == null) return null;
  if (typeof store.get === 'function') {
    try {
      const hit = store.get(atom_id);
      return hit == null ? null : hit;
    } catch {
      return null;
    }
  }
  if (typeof store === 'object' && atom_id in store) {
    const hit = store[atom_id];
    return hit == null ? null : hit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Body summarization
// ---------------------------------------------------------------------------

/**
 * Produce a one-line summary of an atom's body for graph / list rendering.
 * Prefers explicit summary fields, falls back to first scalar value, never
 * dumps an entire JSON blob into a row.
 */
function summarizeBody(body) {
  if (body == null || typeof body !== 'object') return '(no body)';
  const preferred = ['summary', 'statement', 'title', 'name', 'claim', 'rule', 'description'];
  for (const key of preferred) {
    const v = body[key];
    if (typeof v === 'string' && v.length > 0) {
      return v.length > 140 ? v.slice(0, 137) + '...' : v;
    }
  }
  // fall back to first scalar leaf
  for (const k of Object.keys(body)) {
    const v = body[k];
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      const s = `${k}=${v}`;
      return s.length > 140 ? s.slice(0, 137) + '...' : s;
    }
  }
  return '(structured body — see full atom)';
}

/**
 * Derive a title from kind + body. Used as the H1 in Markdown output.
 */
function deriveTitle(atom) {
  const kind = atom?.kind ?? 'unknown';
  const summary = summarizeBody(atom?.body);
  return `[${kind}] ${summary}`;
}

// ---------------------------------------------------------------------------
// Markdown helpers
// ---------------------------------------------------------------------------

function shortHash(h) {
  if (typeof h !== 'string' || h.length === 0) return '(none)';
  if (h === 'GENESIS') return 'GENESIS';
  return h.length > 16 ? h.slice(0, 8) + '..' + h.slice(-8) : h;
}

function renderBodyBlock(body) {
  if (body == null) return '_(no body)_';
  try {
    return '```json\n' + JSON.stringify(body, null, 2) + '\n```';
  } catch (err) {
    return `_(body could not be serialized: ${err.message})_`;
  }
}

function renderEvidence(evidence) {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return '_none_';
  }
  return evidence.map((path, i) => `${i + 1}. \`${path}\``).join('\n');
}

function renderPreconditionsList(resolved) {
  if (resolved.length === 0) return '_none_';
  return resolved
    .map((r) => {
      if (r.resolved) {
        return `- \`${shortHash(r.id)}\` — [${r.kind}] ${r.summary}`;
      }
      return `- \`${shortHash(r.id)}\` — **UNRESOLVED** (not found in atom store)`;
    })
    .join('\n');
}

function renderSupersedesGraph(chain) {
  // chain is an array of {id, kind, summary, resolved} ordered nearest → oldest
  if (chain.length === 0) return '_none — this atom supersedes nothing_';
  return chain
    .map((node, i) => {
      const indent = '  '.repeat(i);
      const arrow = i === 0 ? '' : '↑ ';
      if (node.resolved) {
        return `${indent}${arrow}\`${shortHash(node.id)}\` — [${node.kind}] ${node.summary}`;
      }
      if (node.cycle) {
        return `${indent}${arrow}\`${shortHash(node.id)}\` — **CYCLE DETECTED** (already visited above)`;
      }
      return `${indent}${arrow}\`${shortHash(node.id)}\` — **UNRESOLVED**`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Chain traversal
// ---------------------------------------------------------------------------

/**
 * Resolve a single id against the store and return a lightweight row.
 */
function resolveRow(id, store) {
  const a = lookup(store, id);
  if (a == null) {
    return { id, resolved: false, kind: null, summary: null };
  }
  return {
    id,
    resolved: true,
    kind: a.kind ?? 'unknown',
    summary: summarizeBody(a.body),
  };
}

/**
 * Walk supersedes-pointers from `startId` upward (newest → oldest) until the
 * chain terminates or a cycle is detected. Returns the linear chain in walk
 * order, EXCLUDING the start atom itself.
 *
 * Atom store doctrine: an atom is replaced by issuing a NEW atom whose
 * `supersedes` includes the old atom_id. So walking `supersedes[*]` from a
 * starting atom gives you its prior versions.
 */
function walkSupersedes(startAtom, store, visited) {
  const chain = [];
  const local = new Set(visited);
  let frontier = Array.isArray(startAtom?.supersedes) ? [...startAtom.supersedes] : [];

  // Level-order walk so multiple parallel supersedes branches are surfaced,
  // not just the leftmost.
  while (frontier.length > 0) {
    const next = [];
    for (const id of frontier) {
      if (local.has(id)) {
        chain.push({ id, cycle: true, resolved: false, kind: null, summary: null });
        continue;
      }
      local.add(id);
      const a = lookup(store, id);
      if (a == null) {
        chain.push({ id, resolved: false, kind: null, summary: null });
        continue;
      }
      chain.push({
        id,
        resolved: true,
        kind: a.kind ?? 'unknown',
        summary: summarizeBody(a.body),
      });
      if (Array.isArray(a.supersedes)) {
        for (const parentId of a.supersedes) next.push(parentId);
      }
    }
    frontier = next;
  }

  return chain;
}

/**
 * BFS over both preconditions and supersedes, surfacing the full provenance
 * graph reachable from `atomId`.
 *
 * Returns:
 *   {
 *     atom: <the starting atom, or null if not found>,
 *     preconditions_resolved: [{id, kind, summary, resolved}],
 *     supersedes_chain: [{id, kind, summary, resolved, cycle?}]
 *   }
 *
 * Both lists are flat. supersedes_chain is in walk-order from nearest
 * predecessor to oldest. preconditions_resolved is the direct preconditions
 * of the starting atom (one hop). Callers who want deeper precondition
 * exploration can call traverseChain again on any resolved precondition.
 *
 * The function is iterative — no recursion, no max-depth surprise.
 */
export function traverseChain(atomId, atomStore) {
  if (typeof atomId !== 'string' || atomId.length === 0) {
    throw new Error('traverseChain: atomId must be a non-empty string');
  }

  const startAtom = lookup(atomStore, atomId);
  if (startAtom == null) {
    return {
      atom: null,
      preconditions_resolved: [],
      supersedes_chain: [],
      note: `atom_id '${atomId}' not present in atom store`,
    };
  }

  const preconditions_resolved = Array.isArray(startAtom.preconditions)
    ? startAtom.preconditions.map((id) => resolveRow(id, atomStore))
    : [];

  const visited = new Set([atomId]);
  const supersedes_chain = walkSupersedes(startAtom, atomStore, visited);

  return {
    atom: startAtom,
    preconditions_resolved,
    supersedes_chain,
  };
}

// ---------------------------------------------------------------------------
// Markdown decoder
// ---------------------------------------------------------------------------

/**
 * Render a Commitment Atom as human-readable Markdown for audit.
 *
 * The second argument is an optional atom store. When provided, preconditions
 * and supersedes pointers are resolved into kind + one-line summaries.
 * When omitted, the Markdown lists raw ids only — still honest, just thinner.
 *
 * @param {Object} atom              - a commitment atom (as produced by encoder)
 * @param {Object} [options]
 * @param {*}      [options.atomStore] - duck-typed store: Map, plain object, or {get(id)}
 * @returns {string} Markdown
 */
export function decodeCommitmentAtom(atom, options = {}) {
  const { atomStore } = options;

  if (atom == null || typeof atom !== 'object' || Array.isArray(atom)) {
    return '# (invalid atom)\n\n_decoder received a non-object value._';
  }

  const title = deriveTitle(atom);
  const kind = atom.kind ?? '(missing)';
  const status = atom.status ?? '(missing)';
  const actor = atom.actor ?? '(missing)';
  const createdAt = atom.created_at ?? '(missing)';
  const expiresAt = atom.expires_at ?? 'never';
  const atomId = atom.atom_id ?? '(missing)';
  const schema = atom.schema ?? '(missing)';

  // sanity flags — surfaced but not corrected
  const flags = [];
  if (atom.kind != null && !VALID_KINDS.includes(atom.kind)) {
    flags.push(`kind '${atom.kind}' is not in VALID_KINDS`);
  }
  if (atom.status != null && !VALID_STATUSES.includes(atom.status)) {
    flags.push(`status '${atom.status}' is not in VALID_STATUSES`);
  }
  if (atom.expires_at && Number.isNaN(Date.parse(atom.expires_at))) {
    flags.push(`expires_at '${atom.expires_at}' is not a parseable ISO date`);
  }

  // signature chain
  const prevHash = atom.signature?.prev_hash ?? '(missing)';
  const sigHash = atom.signature?.hash ?? '(missing)';

  // resolve preconditions one-hop
  const preconditionIds = Array.isArray(atom.preconditions) ? atom.preconditions : [];
  const preconditionRows = preconditionIds.map((id) => resolveRow(id, atomStore));

  // walk supersedes graph
  const supersedesIds = Array.isArray(atom.supersedes) ? atom.supersedes : [];
  let supersedesChain = [];
  if (supersedesIds.length > 0 && atomStore != null) {
    const visited = new Set([atomId]);
    supersedesChain = walkSupersedes(atom, atomStore, visited);
  } else {
    // no store — just list ids as unresolved rows so the auditor still sees them
    supersedesChain = supersedesIds.map((id) => ({
      id,
      resolved: false,
      kind: null,
      summary: null,
    }));
  }

  // ---- compose Markdown -------------------------------------------------
  const lines = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push('## Identity');
  lines.push('');
  lines.push(`- **atom_id**: \`${atomId}\``);
  lines.push(`- **schema**: \`${schema}\``);
  lines.push(`- **kind**: \`${kind}\``);
  lines.push(`- **status**: \`${status}\``);
  lines.push(`- **actor**: \`${actor}\``);
  lines.push(`- **created_at**: ${createdAt}`);
  lines.push(`- **expires_at**: ${expiresAt}`);
  if (flags.length > 0) {
    lines.push('');
    lines.push('> **Sanity flags** (decoder did not modify the atom):');
    for (const f of flags) lines.push(`> - ${f}`);
  }
  lines.push('');

  lines.push('## Body');
  lines.push('');
  lines.push(renderBodyBlock(atom.body));
  lines.push('');

  lines.push('## Preconditions');
  lines.push('');
  if (preconditionIds.length === 0) {
    lines.push('_none — this atom has no precondition dependencies._');
  } else if (atomStore == null) {
    lines.push('_(atomStore not provided — ids only)_');
    lines.push('');
    for (const id of preconditionIds) lines.push(`- \`${id}\``);
  } else {
    lines.push(renderPreconditionsList(preconditionRows));
  }
  lines.push('');

  lines.push('## Evidence');
  lines.push('');
  lines.push(renderEvidence(atom.evidence));
  lines.push('');

  lines.push('## Signature chain');
  lines.push('');
  lines.push(`- **prev_hash**: \`${shortHash(prevHash)}\``);
  lines.push(`- **this hash**: \`${shortHash(sigHash)}\``);
  lines.push('');
  lines.push('> Full hashes (for chain verification):');
  lines.push('>');
  lines.push(`> - prev_hash: \`${prevHash}\``);
  lines.push(`> - hash:      \`${sigHash}\``);
  lines.push('');

  lines.push('## Supersedes graph');
  lines.push('');
  if (supersedesIds.length === 0) {
    lines.push('_none — this atom supersedes nothing._');
  } else if (atomStore == null) {
    lines.push('_(atomStore not provided — ids only)_');
    lines.push('');
    for (const id of supersedesIds) lines.push(`- \`${id}\``);
  } else {
    lines.push(renderSupersedesGraph(supersedesChain));
  }
  lines.push('');

  // unresolved-count footer for auditor scan
  const unresolvedPre = preconditionRows.filter((r) => !r.resolved).length;
  const unresolvedSup = supersedesChain.filter((r) => !r.resolved && !r.cycle).length;
  const cycleCount = supersedesChain.filter((r) => r.cycle).length;
  if (atomStore != null && (unresolvedPre > 0 || unresolvedSup > 0 || cycleCount > 0)) {
    lines.push('---');
    lines.push('');
    lines.push('**Audit warnings**');
    if (unresolvedPre > 0) {
      lines.push(`- ${unresolvedPre} precondition id(s) could not be resolved in the atom store.`);
    }
    if (unresolvedSup > 0) {
      lines.push(`- ${unresolvedSup} supersedes id(s) could not be resolved in the atom store.`);
    }
    if (cycleCount > 0) {
      lines.push(`- ${cycleCount} cycle(s) detected while walking supersedes graph.`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Internals (exposed for unit tests, not part of the public contract)
// ---------------------------------------------------------------------------

export const __internals = Object.freeze({
  lookup,
  summarizeBody,
  deriveTitle,
  shortHash,
  walkSupersedes,
  resolveRow,
});
