// mistake-cluster.mjs — Æ Cobra recall-ext #5: cluster mistakes/repairs by kind.
//
// WHY. The engine's recallMistakes returns a FLAT, newest-first list of every
// logged failure/risk/repair. The learning loop (spine Phase 5 — "have I hit this
// before, and did I fix it?") needs that list SHAPED: mistakes of the same kind
// grouped together, each cluster showing how many times it recurred, whether a
// repair ever followed, and how fresh the last occurrence is. Recurrence is the
// signal the learning loop consumes — a mistake that keeps happening and never
// gets a repair is a standing lesson; one that happened once and was fixed is
// closed. This module turns the flat stream into that lesson ledger.
//
// HOW (deterministic clustering — no ML clustering, a keyed grouping):
//   1. Pull the mistake stream from the engine (engine.recallMistakes) so "what
//      counts as a mistake" is EXACTLY the engine's definition (single source of
//      truth; we never re-decide mistake-ness).
//   2. Derive a stable CLUSTER KEY per mistake, most-specific-first:
//        explicit guardrail_id  →  "guardrail:G02"
//        else a recognized error family from a keyword lexicon (env/timeout/
//          parse/network/oom/permission/hash/schema/…)  →  "family:timeout"
//        else the dominant kind/origin substring  →  "kind:error"
//        else a topic-token signature (top shared tokens)  →  "topic:brotli+q11"
//   3. For each cluster: count, first/last occurrence, whether a REPAIR followed
//      (a later record whose surface says fixed/repaired/resolved/patched and that
//      shares the cluster's topic), the distinct files/guardrails involved, and a
//      representative example. Clusters rank by recurrence then recency.
//
// This is the honest, auditable stand-in for the pattern-memory a trained Cobra
// would carry: recurrence = repetition of a keyed signature, repair-detection =
// a later lexical repair signal on the same topic. Every cluster shows its
// members (Mom's Law — the lesson shows its receipts).
//
// HONESTY. Reuses engine.recallMistakes + _internal; no model, no network, no
// modification to engine or reader.
//
// EMPTY-SAFE. Missing/empty ledger → { ok:true, clusters:[], ... }. Never throws.
//
// CLI:
//   bun recall-ext/mistake-cluster.mjs clusters --flux-root <dir>
//   bun recall-ext/mistake-cluster.mjs clusters --kind guardrail --flux-root <dir>

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recallMistakes, buildDualIndex, _internal } from '../recall-engine.mjs';

const { tokenizeText, recordTokens, bodyText, sharedCount, projectRecord } = _internal;

const DAY_MS = 86_400_000;

// Error-family lexicon → canonical family label. First matching family wins
// (checked against the record's whole text surface). Curated, legible, extend by
// adding a row. This is how two differently-worded env-var failures land in the
// SAME "env" cluster.
const FAMILY_LEXICON = [
  ['env', ['env unset', 'env var', 'environment variable', 'not set', 'unset', 'founder_salary', 'secret missing', 'missing env']],
  ['timeout', ['timeout', 'timed out', 'deadline exceeded', 'etimedout', 'took too long']],
  ['parse', ['parse error', 'unexpected token', 'json parse', 'syntaxerror', 'malformed', 'invalid json']],
  ['network', ['network', 'econnrefused', 'econnreset', 'fetch failed', 'dns', 'socket', 'offline', 'unreachable']],
  ['oom', ['out of memory', 'oom', 'heap', 'rss ceiling', 'memory ceiling', 'allocation failed']],
  ['permission', ['permission denied', 'eacces', 'eperm', 'forbidden', 'unauthorized', 'access denied']],
  ['hash', ['hash mismatch', 'sha mismatch', 'checksum', 'integrity', 'chain break', 'prev_hash']],
  ['schema', ['schema', 'validation failed', 'invalid shape', 'does not match', 'assertion failed']],
  ['guardrail', ['guardrail', 'gate 0', 'gate0', 'lbce', 'lattice', 'constitutional']],
  ['build', ['build blocked', 'build failed', 'compile error', 'compilation']],
  ['rollback', ['rollback', 'reverted', 'revert', 'undo deploy']],
];

// Repair-signal lexicon — a later record whose surface contains one of these,
// AND that shares topic with a cluster, is treated as a REPAIR for that cluster.
const REPAIR_SIGNALS = ['fixed', 'repaired', 'resolved', 'patched', 'restored', 'unblocked', 'mitigated', 'corrected', 'remediated', 'closed'];

// ---------------------------------------------------------------------------
// clusterKeyFor — stable, most-specific-first cluster key for one mistake record.
// ---------------------------------------------------------------------------
export function clusterKeyFor(rec) {
  const body = rec && typeof rec.body === 'object' && rec.body ? rec.body : {};
  // 1. explicit guardrail id.
  const gid = String(body.guardrail_id || '').trim();
  if (gid) return { key: `guardrail:${gid}`, kind: 'guardrail', label: gid };

  // 2. error family from the text surface.
  const surface = mistakeSurface(rec);
  for (const [family, needles] of FAMILY_LEXICON) {
    for (const n of needles) if (surface.includes(n)) return { key: `family:${family}`, kind: 'family', label: family };
  }

  // 3. dominant kind / origin substring.
  const kind = String(rec?.kind || '').toLowerCase();
  const origin = String(rec?.origin || '').toLowerCase();
  if (kind && kind !== 'error' && kind !== 'risk') {
    return { key: `kind:${kind.split(/[.\s]/)[0]}`, kind: 'kind', label: kind.split(/[.\s]/)[0] };
  }
  if (origin) {
    const oh = origin.split(/[.\s]/)[0];
    if (oh) return { key: `origin:${oh}`, kind: 'origin', label: oh };
  }

  // 4. topic-token signature — top 2 distinctive tokens, sorted for stability.
  const toks = [...recordTokens(rec)].sort().slice(0, 2);
  if (toks.length) return { key: `topic:${toks.join('+')}`, kind: 'topic', label: toks.join('+') };

  return { key: 'kind:error', kind: 'kind', label: 'error' };
}

function mistakeSurface(rec) {
  const body = rec && typeof rec.body === 'object' && rec.body ? rec.body : {};
  return [
    bodyText(rec),
    String(rec?.kind || ''),
    String(rec?.origin || ''),
    String(body.severity || ''),
    Array.isArray(body.entities) ? body.entities.join(' ') : '',
  ].join(' ').toLowerCase();
}

// ===========================================================================
// clusterMistakes — group the engine's mistake stream by cluster key.
//
// Params:
//   fluxRoot, nowMs, lookbackMs (365d), kind (optional engine kind-filter passed
//   straight through to recallMistakes), limit (max clusters, 100).
//
// Returns:
//   { ok, kind, window, counts:{ mistakes, clusters, repaired, open },
//     clusters:[ {
//       key, cluster_kind, label,
//       count, first_ts, last_ts, first_iso, last_iso, age_days_last,
//       repaired:boolean, repaired_by:{...}|null,
//       guardrails:[], files:[], example:{...}, members:[...] } ] }
//
// A cluster is `repaired` iff some reality/thought record AFTER the cluster's
// last mistake carries a repair signal AND shares topic with the cluster.
//
// Empty/missing ledger → clusters:[]. Never throws.
// ===========================================================================
export function clusterMistakes({ fluxRoot, nowMs = Date.now(), lookbackMs = 365 * DAY_MS, kind, limit = 100 } = {}) {
  // Single source of truth for mistake-ness: the engine.
  const stream = recallMistakes({ fluxRoot, kind, nowMs, lookbackMs, limit: 100000 });
  // Full record set (both lanes) for repair detection.
  const idx = buildDualIndex({ fluxRoot, startMs: Math.max(0, nowMs - lookbackMs), endMs: nowMs });
  const allRecs = [...idx.reality, ...idx.thought];

  // We need the ORIGINAL records (recallMistakes returns projections without body
  // internals like guardrail_id). Re-read raw for clustering by re-matching on
  // receipt_id (hash) against the dual index; fall back to projection fields.
  const byHash = new Map();
  for (const e of allRecs) if (e.rec.hash) byHash.set(e.rec.hash, e.rec);

  const clusters = new Map();
  for (const m of stream.mistakes) {
    const raw = (m.receipt_id && byHash.get(m.receipt_id)) || projectionToRec(m);
    const ck = clusterKeyFor(raw);
    let c = clusters.get(ck.key);
    if (!c) {
      c = {
        key: ck.key, cluster_kind: ck.kind, label: ck.label,
        count: 0, first_ts: Infinity, last_ts: -Infinity,
        guardrails: new Set(), files: new Set(),
        topicTokens: new Set(), members: [], _lastRec: null,
      };
      clusters.set(ck.key, c);
    }
    c.count += 1;
    const ts = Number.isFinite(raw.ts) ? raw.ts : m.ts;
    if (ts < c.first_ts) c.first_ts = ts;
    if (ts > c.last_ts) { c.last_ts = ts; c._lastRec = raw; }
    const body = raw.body && typeof raw.body === 'object' ? raw.body : {};
    if (body.guardrail_id) c.guardrails.add(String(body.guardrail_id));
    if (Array.isArray(body.files)) for (const f of body.files) if (f) c.files.add(String(f));
    for (const t of recordTokens(raw)) c.topicTokens.add(t);
    if (c.members.length < 50) c.members.push(projectRecord(raw));
  }

  // Repair detection per cluster.
  const out = [];
  for (const c of clusters.values()) {
    let repaired = false, repairedBy = null;
    for (const e of allRecs) {
      const r = e.rec;
      if (!Number.isFinite(r.ts) || r.ts <= c.last_ts) continue;    // must be AFTER last occurrence
      const surface = mistakeSurface(r) + ' ' + bodyText(r).toLowerCase();
      if (!REPAIR_SIGNALS.some((sig) => surface.includes(sig))) continue;
      // must share topic with the cluster (avoid crediting an unrelated "resolved").
      const sh = sharedCount(c.topicTokens, recordTokens(r));
      if (sh >= 2) { repaired = true; repairedBy = projectRecord(r); break; }
    }
    out.push({
      key: c.key, cluster_kind: c.cluster_kind, label: c.label,
      count: c.count,
      first_ts: c.first_ts, last_ts: c.last_ts,
      first_iso: new Date(c.first_ts).toISOString(), last_iso: new Date(c.last_ts).toISOString(),
      age_days_last: Math.floor((nowMs - c.last_ts) / DAY_MS),
      recurring: c.count >= 2,
      repaired, repaired_by: repairedBy,
      guardrails: [...c.guardrails].sort(),
      files: [...c.files].sort().slice(0, 20),
      example: projectRecord(c._lastRec),
      members: c.members,
    });
  }

  // Rank: most-recurring first, then most-recent, then still-open before repaired.
  out.sort((a, b) =>
    (b.count - a.count)
    || (b.last_ts - a.last_ts)
    || (Number(a.repaired) - Number(b.repaired)));

  const repairedN = out.filter((c) => c.repaired).length;
  return {
    ok: true,
    kind: stream.kind,
    window: stream.window,
    counts: {
      mistakes: stream.total,
      clusters: out.length,
      repaired: repairedN,
      open: out.length - repairedN,
      recurring: out.filter((c) => c.recurring).length,
    },
    clusters: out.slice(0, limit),
  };
}

// Reconstruct a minimal record from an engine projection (fallback when the raw
// record isn't in the dual-index window, e.g. hash absent).
function projectionToRec(p) {
  return {
    ts: p.ts, lane: p.lane, origin: p.origin, kind: p.kind, hash: p.receipt_id,
    body: {
      summary: p.summary, entities: p.entities, files: p.files, commands: p.commands,
      risk: p.risk, next_action: p.next_action,
    },
  };
}

export const _internal_cluster = { clusterKeyFor, mistakeSurface, FAMILY_LEXICON, REPAIR_SIGNALS };

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseCliArgs(argv) {
  const a = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) a.flags[t.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else a._.push(t);
  }
  return a;
}

function cliMain(argv) {
  const a = parseCliArgs(argv);
  const cmd = a._[0];
  const fluxRoot = a.flags['flux-root'] || process.env.AE_FLUX_ROOT;
  let out;
  switch (cmd) {
    case 'clusters':
      out = clusterMistakes({ fluxRoot, kind: typeof a.flags.kind === 'string' ? a.flags.kind : undefined });
      break;
    default:
      process.stderr.write(
        'Æ Cobra recall-ext mistake-cluster — cluster mistakes/repairs by kind.\n\n' +
        'Usage:\n' +
        '  bun recall-ext/mistake-cluster.mjs clusters [--kind guardrail] [--flux-root <dir>]\n'
      );
      process.exit(a._.length ? 1 : 0);
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(0);
}

const isDirect = (() => {
  try { return process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]); }
  catch { return false; }
})();

if (isDirect) {
  try { cliMain(process.argv.slice(2)); }
  catch (e) { process.stderr.write(`fatal: ${e.stack || e.message}\n`); process.exit(1); }
}
