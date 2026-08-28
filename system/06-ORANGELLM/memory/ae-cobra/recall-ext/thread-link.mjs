// thread-link.mjs — Æ Cobra recall-ext #3: link related threads across projects.
//
// WHY. The base engine answers "where does project X stand" one project at a
// time. But the operator runs many projects that quietly share substance — a
// compression idea raised under AtomSmasher is the same substance as a receipt-
// archive plan under OrangeLLM; a guardrail lesson in one is the lesson for all.
// Siloed recall hides those bridges. This module finds them: it groups ledger
// records into project buckets, then links buckets (and individual records)
// whose topic surfaces overlap, so a recall answer can say "this also connects
// to <other project> via <shared tokens>."
//
// HOW (deterministic graph over the shared state):
//   1. Assign each record a PROJECT label. A project is inferred from the record's
//      strongest project-like signal: an explicit body.project/run_id, else the
//      leading path segment of its first file (e.g. "12-ATOMSMASHER/..." →
//      "12-ATOMSMASHER"), else the first entity, else "unlabeled". Callers may
//      pass an explicit `projects` list of names to force bucketing by those.
//   2. For every pair of records in DIFFERENT projects, compute exact-token
//      overlap (engine tokenizer). A pair is a LINK when overlap ≥ minOverlap and
//      shared ≥ minShared. Reality↔thought and thought↔thought both count.
//   3. Aggregate record-links into PROJECT-LEVEL edges (sum of link strength +
//      the shared vocabulary), producing a small cross-project graph.
//
// This is the concrete, auditable stand-in for the associative recall a trained
// Cobra would do over its hidden state: two threads are "linked" iff they share
// enough surface vocabulary, and every edge carries the exact tokens that justify
// it (Mom's Law — the link shows its work).
//
// HONESTY. No model, no embedding, no network. Pure set overlap over the engine's
// own tokens. Reuses engine _internal + buildDualIndex; modifies nothing.
//
// EMPTY-SAFE. Missing/empty ledger → { ok:true, edges:[], links:[], ... }.
//
// CLI:
//   bun recall-ext/thread-link.mjs graph --flux-root <dir>
//   bun recall-ext/thread-link.mjs links --project "AtomSmasher" --flux-root <dir>

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDualIndex, _internal } from '../recall-engine.mjs';

const { tokenizeText, recordTokens, bodyText, tokenOverlap, sharedCount, projectRecord } = _internal;

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// projectLabel — infer the project a record belongs to. Deterministic priority:
//   body.project → run_id → leading path segment of first file → first entity →
//   'unlabeled'. Leading path segment matches the Orange5 numbered-pillar layout
//   ("12-ATOMSMASHER/crystal/x.mjs" → "12-ATOMSMASHER").
// ---------------------------------------------------------------------------
export function projectLabel(rec) {
  const body = rec && typeof rec.body === 'object' && rec.body ? rec.body : {};
  if (typeof body.project === 'string' && body.project.trim()) return body.project.trim();
  if (typeof body.run_id === 'string' && body.run_id.trim()) return body.run_id.trim();
  const files = Array.isArray(body.files) ? body.files : [];
  for (const f of files) {
    const seg = String(f || '').replace(/\\/g, '/').split('/').filter(Boolean)[0];
    if (seg && !/^\.+$/.test(seg)) return seg;
  }
  const ents = Array.isArray(body.entities) ? body.entities : [];
  if (ents.length && String(ents[0]).trim()) return String(ents[0]).trim();
  return 'unlabeled';
}

// If the caller supplies explicit project names, bucket by which name's tokens
// best match the record (falls back to inferred label when none match).
function forcedLabel(rec, tokens, forcedProjects) {
  let best = null, bestShared = 0;
  for (const name of forcedProjects) {
    const nameToks = new Set(tokenizeText(name));
    if (!nameToks.size) continue;
    const sh = sharedCount(nameToks, tokens);
    // require ALL tokens for multi-token names; single-token match on that token
    let matched = false;
    if (nameToks.size >= 2) { matched = [...nameToks].every((t) => tokens.has(t)); }
    else { matched = sh >= 1; }
    if (matched && sh > bestShared) { bestShared = sh; best = name; }
  }
  return best;
}

// ===========================================================================
// linkThreads — the cross-project link graph.
//
// Params:
//   nowMs, lookbackMs (365d)
//   minOverlap (0.16), minShared (2)   — link thresholds (slightly looser than
//                                        the forgotten-thread join; cross-project
//                                        links are weaker by nature)
//   projects[]                          — optional forced bucket names
//   maxLinks (200), maxEdges (100)
//
// Returns:
//   { ok, projects:[names], record_links:[{a,b,overlap,shared,tokens}],
//     edges:[{ projects:[p,q], strength, links, vocab }], counts }
//
// Empty/missing ledger → empty graph. Never throws.
// ===========================================================================
export function linkThreads({
  fluxRoot,
  nowMs = Date.now(),
  lookbackMs = 365 * DAY_MS,
  minOverlap = 0.16,
  minShared = 2,
  projects = null,
  maxLinks = 200,
  maxEdges = 100,
} = {}) {
  const startMs = Math.max(0, nowMs - lookbackMs);
  const idx = buildDualIndex({ fluxRoot, startMs, endMs: nowMs });
  const forced = Array.isArray(projects) && projects.length ? projects : null;

  // Build a flat node list with tokens + project label, dropping token-empty recs.
  const nodes = [];
  for (const e of [...idx.reality, ...idx.thought]) {
    const tokens = e.tokens instanceof Set ? e.tokens : recordTokens(e.rec);
    if (!tokens.size) continue;
    const label = forced ? (forcedLabel(e.rec, tokens, forced) || projectLabel(e.rec)) : projectLabel(e.rec);
    nodes.push({ rec: e.rec, tokens, project: label });
  }

  const projectSet = new Set(nodes.map((n) => n.project));

  // Pairwise cross-project links (O(n^2) — fine for a per-session ledger window).
  const recordLinks = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const A = nodes[i], B = nodes[j];
      if (A.project === B.project) continue;           // cross-project only
      const ov = tokenOverlap(A.tokens, B.tokens);
      const sh = sharedCount(A.tokens, B.tokens);
      if (ov < minOverlap || sh < minShared) continue;
      const shared = [...A.tokens].filter((t) => B.tokens.has(t));
      recordLinks.push({
        a: { ...projectRecord(A.rec), project: A.project },
        b: { ...projectRecord(B.rec), project: B.project },
        overlap: round4(ov),
        shared: sh,
        tokens: shared.slice(0, 16),
      });
    }
  }
  recordLinks.sort((x, y) => (y.overlap - x.overlap) || (y.shared - x.shared));

  // Aggregate into project-level edges (undirected, keyed by sorted pair).
  const edgeMap = new Map();
  for (const l of recordLinks) {
    const key = [l.a.project, l.b.project].sort().join(' ⇄ ');
    let e = edgeMap.get(key);
    if (!e) { e = { projects: [l.a.project, l.b.project].sort(), strength: 0, links: 0, vocab: new Set() }; edgeMap.set(key, e); }
    e.strength += l.overlap;
    e.links += 1;
    for (const t of l.tokens) e.vocab.add(t);
  }
  const edges = [...edgeMap.values()]
    .map((e) => ({ projects: e.projects, strength: round4(e.strength), links: e.links, vocab: [...e.vocab].slice(0, 24) }))
    .sort((a, b) => (b.strength - a.strength) || (b.links - a.links));

  return {
    ok: true,
    window: { startMs, endMs: nowMs, startIso: new Date(startMs).toISOString(), endIso: new Date(nowMs).toISOString() },
    projects: [...projectSet].sort(),
    counts: { nodes: nodes.length, record_links: recordLinks.length, edges: edges.length },
    edges: edges.slice(0, maxEdges),
    record_links: recordLinks.slice(0, maxLinks),
  };
}

// ===========================================================================
// linksForProject — every cross-project link that touches a named project, plus
// the ranked list of the OTHER projects it connects to. The "what else does this
// project touch" query.
//
// Empty/no-match → { ok:true, project, related:[], links:[] }. Never throws.
// ===========================================================================
export function linksForProject({ fluxRoot, project, nowMs = Date.now(), lookbackMs = 365 * DAY_MS, minOverlap = 0.16, minShared = 2, limit = 100 } = {}) {
  const name = String(project || '').trim();
  if (!name) return { ok: false, reason: 'no project name provided', project: null, related: [], links: [] };

  const g = linkThreads({ fluxRoot, nowMs, lookbackMs, minOverlap, minShared });
  const nameLc = name.toLowerCase();
  const nameToks = new Set(tokenizeText(name));

  const matchesProject = (p) => {
    const pl = String(p || '').toLowerCase();
    if (pl === nameLc || pl.includes(nameLc) || nameLc.includes(pl)) return true;
    const pt = new Set(tokenizeText(p));
    if (!nameToks.size || !pt.size) return false;
    return sharedCount(nameToks, pt) >= 1;
  };

  const links = g.record_links.filter((l) => matchesProject(l.a.project) || matchesProject(l.b.project));
  const relatedMap = new Map();
  for (const l of links) {
    const other = matchesProject(l.a.project) ? l.b.project : l.a.project;
    let r = relatedMap.get(other);
    if (!r) { r = { project: other, strength: 0, links: 0, vocab: new Set() }; relatedMap.set(other, r); }
    r.strength += l.overlap; r.links += 1;
    for (const t of l.tokens) r.vocab.add(t);
  }
  const related = [...relatedMap.values()]
    .map((r) => ({ project: r.project, strength: round4(r.strength), links: r.links, vocab: [...r.vocab].slice(0, 24) }))
    .sort((a, b) => (b.strength - a.strength) || (b.links - a.links));

  return {
    ok: true,
    project: name,
    found: links.length > 0,
    counts: { links: links.length, related_projects: related.length },
    related,
    links: links.slice(0, limit),
  };
}

function round4(n) { return Math.round(n * 1e4) / 1e4; }

export const _internal_link = { projectLabel, forcedLabel, round4 };

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
    case 'graph':
      out = linkThreads({ fluxRoot });
      break;
    case 'links':
      out = linksForProject({ fluxRoot, project: a.flags.project });
      break;
    default:
      process.stderr.write(
        'Æ Cobra recall-ext thread-link — cross-project thread linking.\n\n' +
        'Usage:\n' +
        '  bun recall-ext/thread-link.mjs graph                       [--flux-root <dir>]\n' +
        '  bun recall-ext/thread-link.mjs links --project "<name>"    [--flux-root <dir>]\n'
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
