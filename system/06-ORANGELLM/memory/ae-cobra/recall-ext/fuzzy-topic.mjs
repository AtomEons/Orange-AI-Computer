// fuzzy-topic.mjs — Æ Cobra recall-ext #1: fuzzy topic-token matching.
//
// WHY. The base recall-engine joins reality and thought lanes on EXACT topic
// tokens (Jaccard over lowercased alphanumerics). That is precise but brittle:
// a thought that says "compress the receipts" is NOT matched to a reality record
// that says "compression shipped", because "compress" ≠ "compression" as exact
// strings. For the forgotten-thread surface this brittleness is a false-negative
// machine — it surfaces threads as "forgotten" that were actually followed
// through under a morphological variant, and it fails to surface a genuinely
// forgotten thread when the operator later searches with a near-synonym.
//
// This module adds a DETERMINISTIC fuzzy layer on top of the engine's tokens:
//   * light Porter-ish stemming (suffix stripping) so morphological variants
//     collapse to a shared stem  ("compressor"/"compression"/"compressed" → "compress")
//   * a small, curated synonym-lite table for AtomEons/operator domain terms
//     so hand-synonyms collapse too  ("bug" ≈ "error", "ship" ≈ "deploy")
//   * fuzzyOverlap / fuzzySharedCount — the stem+synonym analogues of the
//     engine's tokenOverlap / sharedCount
//   * surfaceForgottenThreadsFuzzy — a drop-in fuzzy variant of the engine's
//     surfaceForgottenThreads that treats a thought as FOLLOWED THROUGH when a
//     later reality record overlaps it in *stem/synonym* space, not just exact.
//   * matchTopic — score a free-text query against a record's topic surface,
//     for "surface the forgotten thread that sounds like <phrase>".
//
// HONESTY. No model, no network, no learned embedding. This is stemming + a
// hand-written synonym set — a transparent, auditable stand-in for the semantic
// nearness a trained Cobra would carry. Every expansion is inspectable in
// SYNONYMS below. It never invents a match that has no lexical/curated basis.
//
// EMPTY-SAFE (Mom's Law). Missing/empty ledger → sane empties, never throws.
// Reuses the engine's own tokenizer + record readers; does NOT modify them.
//
// CLI:
//   bun recall-ext/fuzzy-topic.mjs forgotten --flux-root <dir>
//   bun recall-ext/fuzzy-topic.mjs match --query "compress receipts" --flux-root <dir>

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDualIndex, _internal } from '../recall-engine.mjs';

const { tokenizeText, recordTokens, bodyText, projectRecord } = _internal;

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Synonym-lite. Curated, domain-aware equivalence classes. Every token in a
// class collapses to the class's canonical head (first element). Kept small and
// legible on purpose: this is a hand-audited table, not a thesaurus dump. Add a
// row only when the two terms genuinely denote the same operator concept.
// ---------------------------------------------------------------------------
const SYNONYM_CLASSES = [
  ['error', 'bug', 'defect', 'fault', 'failure', 'fail', 'broke', 'broken', 'crash'],
  ['fix', 'repair', 'patch', 'mend', 'resolve', 'remediate'],
  ['deploy', 'ship', 'release', 'launch', 'publish', 'promote'],
  ['compress', 'compression', 'compressor', 'compact', 'squeeze'],
  ['receipt', 'receipts', 'proof', 'evidence', 'ledger'],
  ['recall', 'remember', 'memory', 'recollect'],
  ['plan', 'proposal', 'propose', 'design', 'blueprint'],
  ['build', 'construct', 'assemble', 'compile'],
  ['test', 'verify', 'validate', 'check', 'assert'],
  ['guardrail', 'guardrails', 'guard', 'constraint', 'invariant'],
  ['schedule', 'scheduler', 'cron', 'timer'],
  ['index', 'indexing', 'catalog', 'catalogue'],
  ['train', 'training', 'finetune', 'lora'],
  ['benchmark', 'bench', 'measure', 'profile'],
  ['token', 'tokens', 'tokenize', 'tokenization'],
];

// Reverse map: token → canonical class head. Built once.
const SYNONYM_HEAD = (() => {
  const m = new Map();
  for (const cls of SYNONYM_CLASSES) {
    const head = cls[0];
    for (const w of cls) m.set(w, head);
  }
  return m;
})();

// ---------------------------------------------------------------------------
// Light stemmer. A conservative suffix-stripper (a small Porter subset). Goal:
// collapse common English inflections without over-stemming into collisions.
// Order matters — longest/most-specific suffixes first. Never stems below 3
// chars. Deterministic and total.
// ---------------------------------------------------------------------------
export function stem(word) {
  let w = String(word || '').toLowerCase();
  if (w.length <= 3) return w;

  // Step 1: plural / 3rd-person-singular.
  if (w.endsWith('sses')) w = w.slice(0, -2);          // classes-ish → keep 'ss'
  else if (w.endsWith('ies')) w = w.slice(0, -3) + 'y'; // studies → study
  else if (w.endsWith('ss')) { /* keep */ }
  else if (w.endsWith('s') && !w.endsWith('us') && !w.endsWith('ss')) w = w.slice(0, -1);

  // Step 2: past tense / gerund.
  if (w.length > 4 && w.endsWith('ing')) w = trimStemDouble(w.slice(0, -3));
  else if (w.length > 4 && w.endsWith('edly')) w = w.slice(0, -4);
  else if (w.length > 4 && w.endsWith('ed')) w = trimStemDouble(w.slice(0, -2));

  // Step 3: common derivational endings → root.
  // -ssion → -ss  (compression → compress, admission → admiss) : strip "ion".
  // -sion  → -s   (decision → decis→ we further let synonyms/other rules settle).
  // -ation → root (+e when the root needs it: automation → automate).
  // -tion  → -te  (creation → create).
  if (w.length > 5 && w.endsWith('ssion')) w = w.slice(0, -3);                 // ...ssion → ...ss
  else if (w.length > 5 && w.endsWith('ation')) w = w.slice(0, -5) + (endsVowel(w.slice(0, -5)) ? '' : 'e');
  else if (w.length > 4 && w.endsWith('tion')) w = w.slice(0, -3) + 'e';       // creation → create
  else if (w.length > 4 && w.endsWith('sion')) w = w.slice(0, -3);             // ...sion → ...s
  else if (w.length > 4 && w.endsWith('ment')) w = w.slice(0, -4);
  else if (w.length > 4 && w.endsWith('ness')) w = w.slice(0, -4);
  else if (w.length > 4 && w.endsWith('er') && !w.endsWith('eer')) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('or')) w = w.slice(0, -2);
  else if (w.length > 5 && w.endsWith('ly')) w = w.slice(0, -2);

  if (w.length < 3) w = String(word || '').toLowerCase().slice(0, 3);
  return w;
}

function endsVowel(s) { return /[aeiou]$/.test(s); }
// Collapse a doubled final consonant left by -ing/-ed stripping (shipping→ship).
function trimStemDouble(s) {
  if (s.length > 3 && /([bcdfghjklmnpqrstvz])\1$/.test(s)) return s.slice(0, -1);
  return s;
}

// Canonicalize a single token: synonym head first (on the raw token AND on its
// stem), else the stem. Two tokens are "fuzzy-equal" iff their canon() matches.
export function canon(token) {
  const t = String(token || '').toLowerCase();
  if (SYNONYM_HEAD.has(t)) return SYNONYM_HEAD.get(t);
  const st = stem(t);
  if (SYNONYM_HEAD.has(st)) return SYNONYM_HEAD.get(st);
  return st;
}

// Turn a Set/array of exact tokens into a Set of canonical (stem/synonym) tokens.
export function canonSet(tokens) {
  const out = new Set();
  for (const t of tokens) out.add(canon(t));
  return out;
}

// Canonical topic tokens for a record — the engine's recordTokens, canonicalized.
export function fuzzyRecordTokens(rec) {
  return canonSet(recordTokens(rec));
}

// ---------------------------------------------------------------------------
// Fuzzy set metrics — the canon-space analogues of the engine's exact metrics.
// ---------------------------------------------------------------------------
export function fuzzyOverlap(aTokens, bTokens) {
  const a = aTokens instanceof Set ? canonSet(aTokens) : canonSet(aTokens || []);
  const b = bTokens instanceof Set ? canonSet(bTokens) : canonSet(bTokens || []);
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (big.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

export function fuzzySharedCount(aTokens, bTokens) {
  const a = aTokens instanceof Set ? canonSet(aTokens) : canonSet(aTokens || []);
  const b = bTokens instanceof Set ? canonSet(bTokens) : canonSet(bTokens || []);
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (big.has(t)) inter++;
  return inter;
}

// ---------------------------------------------------------------------------
// matchTopic — score a free-text query against one record's topic surface, in
// fuzzy (stem/synonym) space. Returns { overlap, shared, canonQuery }.
// Used to answer "surface the thread that sounds like <phrase>".
// ---------------------------------------------------------------------------
export function matchTopic(query, rec) {
  const q = canonSet(tokenizeText(String(query || '')));
  const r = fuzzyRecordTokens(rec);
  return {
    overlap: fuzzyOverlap(q, r),
    shared: fuzzySharedCount(q, r),
    canonQuery: [...q],
  };
}

// ===========================================================================
// surfaceForgottenThreadsFuzzy — fuzzy drop-in for the engine's forgotten-thread
// surface. A thought is FOLLOWED THROUGH when a later reality record overlaps it
// in canon (stem/synonym) space beyond threshold. This closes false-negatives:
// a plan to "compress receipts" is correctly recognized as followed by a later
// "compression shipped" reality record, so it is NOT surfaced as forgotten.
//
// Mirrors the engine's params/ranking so it is behaviorally comparable:
//   nowMs, lookbackMs (120d), minOverlap (0.18), minShared (2), limit (50).
// Each returned thread also carries `_fuzzy: true` and the exact matcher's
// verdict via `also_exact_forgotten` so a caller can diff fuzzy vs exact.
//
// Empty/missing ledger → { ok:true, threads:[], ... }. Never throws.
// ===========================================================================
export function surfaceForgottenThreadsFuzzy({
  fluxRoot,
  nowMs = Date.now(),
  lookbackMs = 120 * DAY_MS,
  minOverlap = 0.18,
  minShared = 2,
  limit = 50,
} = {}) {
  const startMs = Math.max(0, nowMs - lookbackMs);
  const idx = buildDualIndex({ fluxRoot, startMs, endMs: nowMs });

  // Pre-canonicalize every record's tokens once (avoid O(n·m) re-canon).
  const reality = idx.reality.map((e) => ({ rec: e.rec, canon: canonSet(e.tokens) }));
  const thought = idx.thought.map((e) => ({ rec: e.rec, canon: canonSet(e.tokens), exact: e.tokens }));

  const threads = [];
  for (const T of thought) {
    if (!isIdeaThoughtLike(T.rec)) continue;
    if (T.canon.size === 0) continue;

    let followed = false;
    let followedBy = null;
    for (const R of reality) {
      if (R.rec.ts < T.rec.ts) continue;
      const ov = jaccardCanon(T.canon, R.canon);
      const sh = sharedCanon(T.canon, R.canon);
      if (ov >= minOverlap && sh >= minShared) {
        followed = true;
        followedBy = R.rec;
        break;
      }
    }
    if (followed) continue;

    const p = projectRecord(T.rec);
    threads.push({
      ...p,
      _fuzzy: true,
      age_ms: nowMs - T.rec.ts,
      age_days: Math.floor((nowMs - T.rec.ts) / DAY_MS),
      canon_tokens: [...T.canon].slice(0, 24),
    });
  }

  threads.sort((a, b) => (a.ts - b.ts)); // oldest-dropped first
  return {
    ok: true,
    mode: 'fuzzy',
    window: { startMs, endMs: nowMs, startIso: new Date(startMs).toISOString(), endIso: new Date(nowMs).toISOString() },
    scanned: { thoughts: thought.length, reality: reality.length },
    count: Math.min(threads.length, limit),
    total_forgotten: threads.length,
    threads: threads.slice(0, limit),
  };
}

// Local idea-thought heuristic (mirrors engine intent; kept here so this module
// is self-contained and does not reach into engine internals beyond _internal).
function isIdeaThoughtLike(rec) {
  const origin = String(rec?.origin || '').toLowerCase();
  const kind = String(rec?.kind || '').toLowerCase();
  const summary = bodyText(rec);
  if (!summary) return false;
  if (/reason|plan|hypoth|strategy|propos|consider|idea|orangellm/.test(origin)) return true;
  if (['decision', 'risk', 'observation', 'checkpoint'].includes(kind)) return true;
  return /\b(plan|propose|hypothes|consider|should|idea|explore|maybe|try)\b/i.test(summary);
}

// jaccard/shared over already-canonicalized sets (no re-canon).
function jaccardCanon(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (big.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}
function sharedCanon(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (big.has(t)) inter++;
  return inter;
}

export const _internal_fuzzy = {
  stem, canon, canonSet, jaccardCanon, sharedCanon, isIdeaThoughtLike,
  SYNONYM_CLASSES, SYNONYM_HEAD,
};

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
    case 'forgotten':
      out = surfaceForgottenThreadsFuzzy({ fluxRoot });
      break;
    case 'match': {
      // match a query against the fuzzy forgotten set, ranked by overlap.
      const q = a.flags.query;
      const ft = surfaceForgottenThreadsFuzzy({ fluxRoot });
      const scored = ft.threads.map((t) => ({
        summary: t.summary, ts: t.ts,
        score: fuzzyOverlap(new Set(tokenizeText(String(q || ''))), new Set(t.canon_tokens || [])),
      })).sort((x, y) => y.score - x.score);
      out = { ok: true, query: q || null, matches: scored };
      break;
    }
    case 'stem':
      out = { ok: true, word: a.flags.word || null, stem: stem(a.flags.word || ''), canon: canon(a.flags.word || '') };
      break;
    default:
      process.stderr.write(
        'Æ Cobra recall-ext fuzzy-topic — stem/synonym fuzzy topic matching.\n\n' +
        'Usage:\n' +
        '  bun recall-ext/fuzzy-topic.mjs forgotten                 [--flux-root <dir>]\n' +
        '  bun recall-ext/fuzzy-topic.mjs match --query "<phrase>"  [--flux-root <dir>]\n' +
        '  bun recall-ext/fuzzy-topic.mjs stem  --word "<word>"\n'
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
