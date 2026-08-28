// AtomSmasher Full-Scope — Crystal Lattice Compression (PRODUCTION, 3-layer)
//
// Faithful Bun port of `AeoNs/extracted/atomeons/core/crystal_compression.py` (1,134 LOC).
//
// Three layers:
//   1. LATTICE  — entities, relationships, facts, decisions, topics
//   2. VOID MAP — boundaries, rejections, tone markers, fill levels
//   3. DELTA    — irreducible novel info per interaction
//
// Plus the RESONANCE RECONSTRUCTION LOOP (RRL):
//   extract → reconstruct → diff → extract again. Multi-pass discovery
//   using co-occurrence + frequency. The lattice extracts FROM the lattice.
//
// Compression characteristics per source doctrine:
//   - Periodic data (repeated topics): approaches infinite compression
//   - Structured data (conversations): 10-100x compression
//   - Real-world conversations: typically 20-50x semantic compression
//
// This is the PRODUCTION CLC engine — NOT the v1 research doctor (`clc.mjs`)
// and NOT the regex POC at `clc-engine.mjs`. This is the deep one with
// RRL multi-pass extraction.

import crypto from 'node:crypto';

function now() { return Date.now() / 1000; }
function md5Hex(s) { return crypto.createHash('md5').update(String(s)).digest('hex'); }

// ═══════════════════════════════════════════════════════════════════
// LRUMap — bounded Map with eviction on overflow (audit-04 memory fix)
// ═══════════════════════════════════════════════════════════════════
// ResonanceExtractor previously used unbounded Maps for wordFreq /
// cooccurrence / wordContexts and an unbounded Array for messages.
// Under sustained load (10× demo loop) heap grew linearly. LRUMap caps
// retention at constructor cap; oldest key evicts on overflow; get()
// promotes (refreshes recency). Cap is configurable per instance via
// ResonanceExtractor({ resonanceCap }).
class LRUMap {
  constructor(cap = 10000) { this.cap = cap; this.m = new Map(); }
  get(k) { const v = this.m.get(k); if (v !== undefined) { this.m.delete(k); this.m.set(k, v); } return v; }
  set(k, v) { if (this.m.has(k)) this.m.delete(k); else if (this.m.size >= this.cap) { const first = this.m.keys().next().value; this.m.delete(first); } this.m.set(k, v); return this; }
  has(k) { return this.m.has(k); }
  delete(k) { return this.m.delete(k); }
  get size() { return this.m.size; }
  keys() { return this.m.keys(); }
  values() { return this.m.values(); }
  entries() { return this.m.entries(); }
  forEach(fn) { return this.m.forEach(fn); }
  [Symbol.iterator]() { return this.m[Symbol.iterator](); }
  clear() { return this.m.clear(); }
}

// ═══════════════════════════════════════════════════════════════════
// LATTICE — The generating structure
// ═══════════════════════════════════════════════════════════════════

export class Entity {
  constructor({ name, kind = '', properties = {}, firstSeen = 0, lastSeen = 0, mentionCount = 0 } = {}) {
    this.name = String(name);
    this.kind = String(kind);
    this.properties = { ...properties };
    this.firstSeen = Number(firstSeen);
    this.lastSeen = Number(lastSeen);
    this.mentionCount = Number(mentionCount);
  }
  touch(ts = 0) {
    this.lastSeen = ts || now();
    this.mentionCount += 1;
  }
}

export class Relationship {
  constructor({ source, target, kind = '', properties = {}, confidence = 1.0 } = {}) {
    this.source = String(source);
    this.target = String(target);
    this.kind = String(kind);
    this.properties = { ...properties };
    this.confidence = Number(confidence);
  }
}

export class Fact {
  constructor({ content, sourceThread = 0, confidence = 1.0, supersededBy = '', timestamp = 0 } = {}) {
    this.content = String(content);
    this.sourceThread = Number(sourceThread);
    this.confidence = Number(confidence);
    this.supersededBy = String(supersededBy);
    this.timestamp = Number(timestamp);
  }
}

export class Decision {
  constructor({ description, thread = 0, reversible = true, timestamp = 0 } = {}) {
    this.description = String(description);
    this.thread = Number(thread);
    this.reversible = Boolean(reversible);
    this.timestamp = Number(timestamp);
  }
}

function deduplicateFacts(facts) {
  if (facts.length <= 1) return facts;
  const unique = [];
  for (const fact of facts) {
    const wordsNew = new Set(fact.content.toLowerCase().split(/\s+/));
    let isDup = false;
    for (let i = 0; i < unique.length; i++) {
      const existing = unique[i];
      const wordsOld = new Set(existing.content.toLowerCase().split(/\s+/));
      if (wordsOld.size === 0 || wordsNew.size === 0) continue;
      let intersect = 0;
      for (const w of wordsNew) if (wordsOld.has(w)) intersect++;
      const union = new Set([...wordsNew, ...wordsOld]).size;
      const overlap = intersect / Math.max(union, 1);
      if (overlap > 0.6) {
        if (fact.sourceThread > existing.sourceThread) unique[i] = fact;
        isDup = true;
        break;
      }
    }
    if (!isDup) unique.push(fact);
  }
  return unique;
}

export class Lattice {
  constructor() {
    this.entities = new Map();
    this.relationships = [];
    this.facts = [];
    this.decisions = [];
    this.topics = new Map(); // topic → mention count
    this.totalThreads = 0;
  }

  sizeBytes() {
    return JSON.stringify(this.toDict()).length;
  }

  toDict() {
    const entObj = {};
    for (const [k, v] of this.entities.entries()) {
      entObj[k] = { kind: v.kind, props: v.properties, mentions: v.mentionCount };
    }
    const topicsSorted = [...this.topics.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
    const topicsObj = Object.fromEntries(topicsSorted);
    return {
      entities: entObj,
      relationships: this.relationships.map(r => ({ src: r.source, tgt: r.target, kind: r.kind })),
      facts: this.facts.filter(f => !f.supersededBy).map(f => ({ content: f.content, thread: f.sourceThread })),
      decisions: this.decisions.map(d => ({ desc: d.description, thread: d.thread })),
      topics: topicsObj,
      total_threads: this.totalThreads,
    };
  }

  toContext(maxTokens = 800) {
    const budget = maxTokens * 4;
    const parts = [];
    parts.push(`[Conversation lattice: ${this.totalThreads} interactions]`);

    const topTopics = [...this.topics.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (topTopics.length > 0) {
      parts.push(`Topics: ${topTopics.map(([t, c]) => `${t}(${c})`).join(', ')}`);
    }

    const keyEntities = [...this.entities.values()]
      .filter(e => e.mentionCount >= 2)
      .sort((a, b) => b.mentionCount - a.mentionCount)
      .slice(0, 12);
    if (keyEntities.length > 0) {
      const entStrs = keyEntities.map(e => {
        const props = Object.entries(e.properties).slice(0, 2).map(([k, v]) => `${k}=${v}`).join(', ');
        let label = e.name;
        if (e.kind && e.kind !== 'concept' && e.kind !== 'discovered' && e.kind !== '') label += `(${e.kind})`;
        if (props) label += `[${props}]`;
        return label;
      });
      parts.push(`Entities: ${entStrs.join(', ')}`);
    }

    const activeFacts = this.facts.filter(f => !f.supersededBy);
    const uniqueFacts = deduplicateFacts(activeFacts).slice(-10);
    if (uniqueFacts.length > 0) {
      parts.push(`Facts: ${uniqueFacts.map(f => f.content.slice(0, 80)).join(' | ')}`);
    }

    if (this.decisions.length > 0) {
      const seen = new Set();
      const uniqueDecs = [];
      for (const d of this.decisions) {
        const key = d.description.slice(0, 40).toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          uniqueDecs.push(d);
        }
      }
      parts.push(`Decisions: ${uniqueDecs.slice(-5).map(d => d.description).join(' | ')}`);
    }

    if (this.relationships.length > 0) {
      const relStrs = this.relationships.slice(-8).map(r => `${r.source} ${r.kind} ${r.target}`);
      parts.push(`Links: ${relStrs.join(', ')}`);
    }

    let result = parts.join('\n');
    if (result.length > budget) result = result.slice(0, budget);
    return result;
  }
}

// ═══════════════════════════════════════════════════════════════════
// VOID MAP — The negative space (boundaries / rejections / tone / fill)
// ═══════════════════════════════════════════════════════════════════

export class Boundary {
  constructor({ constraint, domain = '', sourceThread = 0, timestamp = 0 } = {}) {
    this.constraint = String(constraint);
    this.domain = String(domain);
    this.sourceThread = Number(sourceThread);
    this.timestamp = Number(timestamp);
  }
}

export class Rejection {
  constructor({ what, why = '', inFavorOf = '', sourceThread = 0, timestamp = 0 } = {}) {
    this.what = String(what);
    this.why = String(why);
    this.inFavorOf = String(inFavorOf);
    this.sourceThread = Number(sourceThread);
    this.timestamp = Number(timestamp);
  }
}

export class ToneMarker {
  constructor({ marker, context = '', thread = 0, timestamp = 0 } = {}) {
    this.marker = String(marker);
    this.context = String(context);
    this.thread = Number(thread);
    this.timestamp = Number(timestamp);
  }
}

export class VoidMap {
  constructor() {
    this.boundaries = [];
    this.rejections = [];
    this.toneMarkers = [];
    this.fillLevels = new Map(); // topic → 0..1 depth
    this.avoidances = [];
  }

  toContext() {
    const parts = [];
    if (this.boundaries.length > 0) {
      parts.push('Constraints: ' + this.boundaries.slice(-10).map(b => b.constraint).join(' | '));
    }
    if (this.rejections.length > 0) {
      const rejStrs = this.rejections.slice(-10).map(r => {
        let s = `rejected ${r.what}`;
        if (r.inFavorOf) s += ` (chose ${r.inFavorOf})`;
        if (r.why) s += ` because ${r.why}`;
        return s;
      });
      parts.push('Rejected: ' + rejStrs.join(' | '));
    }
    if (this.toneMarkers.length > 0) {
      const recent = this.toneMarkers.slice(-5);
      parts.push('Tone: ' + recent.map(t => t.context ? `${t.marker} re:${t.context.slice(0, 20)}` : t.marker).join(', '));
    }
    if (this.fillLevels.size > 0) {
      const deep = [...this.fillLevels.entries()]
        .filter(([, v]) => v > 0.3)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8);
      if (deep.length > 0) {
        parts.push('Deep engagement: ' + deep.map(([k, v]) => `${k}(${Math.round(v * 100)}%)`).join(', '));
      }
    }
    return parts.join('\n');
  }

  toDict() {
    return {
      boundaries: this.boundaries.slice(-15).map(b => ({ c: b.constraint, d: b.domain })),
      rejections: this.rejections.slice(-15).map(r => ({ w: r.what, y: r.why, f: r.inFavorOf })),
      tone: this.toneMarkers.slice(-10).map(t => ({ m: t.marker, c: t.context.slice(0, 30) })),
      fill: Object.fromEntries([...this.fillLevels.entries()].map(([k, v]) => [k, Number(v.toFixed(2))])),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════
// Detectors
// ═══════════════════════════════════════════════════════════════════

const REJECTION_SIGNALS = [
  "don't want", 'not interested', 'rejected', 'no to', 'dismissed',
  "won't use", 'hate', 'dislike', 'refuse', 'nah', 'pass on',
  'not going with', 'ruled out', 'dropped', 'scrapped',
];

const BOUNDARY_SIGNALS = [
  'must be', 'has to', "can't exceed", 'budget is', 'max is',
  'minimum', 'deadline', 'only if', 'never', 'always', 'requirement',
  'must stay', 'non-negotiable', 'no more than', 'cap at', 'limit is',
  'cannot go over', 'ceiling is', 'floor is', 'at most', 'at least',
];

const TONE_MAP = {
  excited: ['excited', 'love', 'amazing', 'incredible', 'blown away', "can't wait", '!!'],
  hesitant: ['not sure', 'maybe', 'might', 'I guess', 'kind of', 'hesitant', 'worried'],
  frustrated: ['frustrated', 'annoyed', 'broken', "doesn't work", 'useless', 'waste'],
  certain: ['definitely', 'absolutely', 'for sure', 'no question', 'committed', 'decided'],
  personal: ['my daughter', 'my family', 'my dad', 'my mom', 'my partner', 'my kid'],
  vulnerable: ['scared', 'afraid', 'honestly', 'truth is', 'I struggle', 'hard for me'],
};

function detectRejections(text) {
  const lo = text.toLowerCase();
  const out = [];
  for (const signal of REJECTION_SIGNALS) {
    const idx = lo.indexOf(signal);
    if (idx >= 0) {
      const after = text.slice(idx + signal.length, idx + signal.length + 50).trim().replace(/^[\s.,!?]+|[\s.,!?]+$/g, '');
      if (after && after.length > 2) out.push(after.slice(0, 40));
    }
  }
  return out;
}

function detectBoundaries(text) {
  const lo = text.toLowerCase();
  const out = [];
  for (const signal of BOUNDARY_SIGNALS) {
    const idx = lo.indexOf(signal);
    if (idx >= 0) {
      const start = Math.max(0, idx - 10);
      const end = Math.min(text.length, idx + signal.length + 40);
      const phrase = text.slice(start, end).trim().replace(/^[\s.,!?]+|[\s.,!?]+$/g, '');
      if (phrase && phrase.length > 5) out.push(phrase.slice(0, 60));
    }
  }
  return out;
}

function detectTone(text) {
  const lo = text.toLowerCase();
  const out = [];
  for (const [tone, signals] of Object.entries(TONE_MAP)) {
    if (signals.some(s => lo.includes(s))) out.push(tone);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// DELTA — Per-interaction novel info
// ═══════════════════════════════════════════════════════════════════

export class Delta {
  constructor({ threadNum, timestamp, newEntities = [], newFacts = [], newRelationships = [], newDecision = '', topicUpdate = '', patternId = '', rawQueryHash = '' } = {}) {
    this.threadNum = Number(threadNum);
    this.timestamp = Number(timestamp);
    this.newEntities = [...newEntities];
    this.newFacts = [...newFacts];
    this.newRelationships = [...newRelationships];
    this.newDecision = String(newDecision);
    this.topicUpdate = String(topicUpdate);
    this.patternId = String(patternId);
    this.rawQueryHash = String(rawQueryHash);
  }

  sizeBytes() {
    return JSON.stringify({
      t: this.threadNum, e: this.newEntities, f: this.newFacts,
      r: this.newRelationships, d: this.newDecision, p: this.patternId,
    }).length;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Tokens + stop list (shared with ResonanceExtractor)
// ═══════════════════════════════════════════════════════════════════

const STOP = new Set(`
a an the is are was were be been being have has had do does did
will would shall should may might can could of in to for with on
at by from up about into through during before after above below
between under again further then once here there when where why
how all each every both few more most other some such no not only
same so than too very just because but and or if while as this
that these those it its they them their he she his her we our you
your i my me what which who whom whose also however although even
still yet already much many well really quite rather still very
good great best top bad worst better worse first last new old
going using called named like need want get got make made give
said says told tell take took put keep kept come came going went
try tried does done thing things way ways also just much many
been being able will would could should might must shall need
compare draft focus pass problem above below both consider
`.split(/\s+/).filter(Boolean));

const NAME_SIGNALS = new Set([
  'called', 'named', 'using', 'chose', 'picked',
  'recommend', 'try', 'like', 'love', 'prefer', 'hate', 'use',
  'compared', 'versus', 'vs', 'or', 'between',
]);

// SPEED: precompiled regexes reused across the hot ingest path.
const TOKEN_RE = /[A-Za-z0-9$]+(?:'[a-z]+)?/g;
const WORDS_SPLIT_RE = /\s+/;
const SENTENCE_SPLIT_RE = /[.!?]+/;

// SPEED: shared empty Set/Array for the no-lattice path so we don't alloc per call.
const _EMPTY_SET = new Set();
const _EMPTY_ARRAY = [];

function tokenize(text) {
  const matches = String(text).match(TOKEN_RE) || [];
  // SPEED: index loop avoids the .filter closure for thousands of calls/ingest.
  const out = [];
  for (let i = 0; i < matches.length; i++) {
    if (matches[i].length > 1) out.push(matches[i]);
  }
  return out;
}

function isSignificant(word) {
  if (word.length < 2) return false;
  return !STOP.has(word.toLowerCase());
}

const ENTITY_SIGNALS = {
  person: ['CEO', 'founder', 'artist', 'producer', 'investor', 'engineer', 'designer'],
  tool: ['API', 'app', 'platform', 'software', 'service', 'SDK', 'tool', 'plugin'],
  company: ['Inc', 'Corp', 'LLC', 'startup', 'company'],
  concept: ['strategy', 'method', 'approach', 'framework', 'theory'],
  project: ['project', 'album', 'deck', 'campaign', 'launch'],
};

// SPEED: precompute lowercase entity-signal pairs ONCE at module-load.
// The original code called `signals.some(s => context.includes(s.toLowerCase()))`
// per word inside extractEntities — that re-lowercased the constant strings on
// every iteration. Stage 11d invokes this loop ~3000 receipts × ~100 words/receipt
// times = ~300k constant re-lowercases. Now they're computed once.
const ENTITY_SIGNALS_LC = Object.entries(ENTITY_SIGNALS).map(([kind, signals]) => [
  kind,
  signals.map(s => s.toLowerCase()),
]);

// SPEED: precompiled sentence-feature signal arrays for extractFacts.
// Same logic — these arrays were rebuilt inside the per-sentence loop in the
// original code, and `signals.some(v => lo.includes(\` ${v} \`))` was constructing
// `' is '` etc. by template-string concat for every sentence. Now baked in.
const FACT_VERBS_LC = [' is ', ' are ', ' costs ', ' has ', ' was ', ' were ', ' takes ', ' requires ', ' supports ', ' includes ', ' provides ', ' reaches ', ' exceeds '];
const FACT_COMPARATORS_LC = [' better ', ' worse ', ' faster ', ' cheaper ', ' stronger ', ' more ', ' less ', ' best ', ' top ', ' leading '];
const FACT_PRICE_RE = /(costs?|pric|worth|rated?|ranks?|scor)/;
const NUM_RE = /\d+/;
const NUM_OR_DOLLAR_RE = /[\d$]/;
const CAP_WORD_RE = /^[A-Za-z]+$/;
const NON_ALNUM_G = /[^A-Za-z0-9]/g;
const NON_AZ_G = /[^a-z]/g;
const HAS_INNER_UPPER_RE = /[A-Z]/;

// ═══════════════════════════════════════════════════════════════════
// ResonanceExtractor — multi-pass extraction (RRL)
// ═══════════════════════════════════════════════════════════════════

export class ResonanceExtractor {
  constructor(opts = {}) {
    // audit-04 fix: LRU-cap the four unbounded collections. Caps default to
    // doctrine values but are constructor-configurable for test override.
    const cap = opts.resonanceCap | 0;
    const wordCap = cap > 0 ? cap : 10000;
    const coocCap = cap > 0 ? cap * 2 : 20000;
    const ctxCap = cap > 0 ? cap : 10000;
    const msgCap = cap > 0 ? Math.max(1, Math.floor(cap / 2)) : 5000;
    this._msgCap = msgCap;
    this.wordFreq = new LRUMap(wordCap);
    this.cooccurrence = new LRUMap(coocCap); // 'a|b' (sorted) → count
    this.wordContexts = new LRUMap(ctxCap);  // word → Set<idx>
    this.messages = []; // [query, response] pairs — capped via shift() in ingestMessage
    this.knownEntities = new Set();
    this.knownFacts = [];
  }

  // ─────────────────────────────────────────────────────────────────
  // FIX G (audit-05, 2026-06-27): flush transient scratch caches.
  // ─────────────────────────────────────────────────────────────────
  // The LRU caps (FIX C) bounded steady-state for wordFreq / cooccurrence /
  // wordContexts / messages. But the extractor ALSO accumulates per-call
  // scratch caches that don't need to survive past a logical batch boundary:
  //
  //   _sigCache        — per-message tokenization (parallel to `messages`)
  //                      For msgCap=5000 with ~50 sig tokens/msg ≈ 250k strings.
  //   _knownLatticeRef — strong reference to the lattice's entities Map.
  //   _knownLatticeSet — lowercase entity-name Set derived from above.
  //   _knownLatticeSize, _knownFilteredKey, _knownFilteredArr — staleness keys.
  //   _explainedLattice, _explainedKey, _explainedCache — explained-set cache
  //                      (every word in every fact/decision/topic).
  //
  // After Crystal's terminal `stats()` call, these caches are dead weight
  // pinned via the extractor instance until the whole CrystalCompressor is
  // collected. Across 4 Crystal instances per demo() iteration (organism,
  // receipt_sweep, layer2, dict) and 10 demo() iterations, the per-iteration
  // retention sums to multi-MB heap growth even under Bun.gc(true).
  //
  // flushTransients() is idempotent. It clears scratch but preserves the
  // LRU-capped collections (wordFreq, cooccurrence, wordContexts, messages)
  // and the `knownEntities` / `knownFacts` accumulators discovered by RRL.
  // Called automatically from CrystalCompressor.stats() — the terminal
  // boundary in every production callsite. Safe to call mid-stream too:
  // the caches rebuild on next access.
  flushTransients() {
    // Drop parallel per-message sig-token cache. Rebuilt lazily by
    // reconstructCoverage() on next runResonanceLoop().
    this._sigCache = null;
    // Drop lattice-known-entities cache. Critically, this releases the
    // hard reference to the externally-owned Lattice Map (_knownLatticeRef),
    // so when Crystal goes out of scope the lattice can be collected
    // without an extra GC pass to break the cycle.
    this._knownLatticeRef = null;
    this._knownLatticeSet = null;
    this._knownLatticeSize = -1;
    // Drop derived filtered known-entities array + its staleness key.
    this._knownFilteredKey = null;
    this._knownFilteredArr = null;
    // Drop explained-set cache + its staleness key (holds Set of every
    // word in every fact/decision/topic — the largest single scratch).
    this._explainedLattice = null;
    this._explainedKey = null;
    this._explainedCache = null;
  }

  ingestMessage(idx, query, response) {
    this.messages.push([query, response]);
    // audit-04 fix: cap messages array to last N. Shift evicts oldest.
    // Invalidate sigCache for shifted positions (they no longer exist).
    while (this.messages.length > this._msgCap) {
      this.messages.shift();
      if (this._sigCache && this._sigCache.length > 0) this._sigCache.shift();
    }
    // SPEED: tokenize directly into sigTokens (skip the intermediate spread+filter).
    // Also lowercase ONCE up-front into a parallel array — the original code
    // called .toLowerCase() in BOTH the wordFreq loop AND the inner cooccurrence
    // loop (where N=sigTokens.length and inner window is 7), so each token got
    // lowercased up to 8 times. Cache it.
    const qTokens = tokenize(query);
    const rTokens = tokenize(response);
    const sigTokens = [];
    const sigLower = [];
    for (let i = 0; i < qTokens.length; i++) {
      const t = qTokens[i];
      if (t.length > 1 && !STOP.has(t.toLowerCase())) {
        sigTokens.push(t);
        sigLower.push(t.toLowerCase());
      }
    }
    for (let i = 0; i < rTokens.length; i++) {
      const t = rTokens[i];
      if (t.length > 1 && !STOP.has(t.toLowerCase())) {
        sigTokens.push(t);
        sigLower.push(t.toLowerCase());
      }
    }
    // NOTE on semantics: isSignificant(w) === (w.length >= 2 && !STOP.has(w.toLowerCase())).
    // tokenize() already guarantees length > 1, so the only check needed here is STOP.

    const wordFreq = this.wordFreq;
    const wordContexts = this.wordContexts;
    // audit-04 fix: cap each per-word context Set so a single hot word can't
    // grow its bucket unboundedly across millions of ingests. Keep last 256
    // contexts per word — enough for resonance scoring, bounded for memory.
    const PER_WORD_CTX_CAP = 256;
    for (let i = 0; i < sigLower.length; i++) {
      const key = sigLower[i];
      wordFreq.set(key, (wordFreq.get(key) || 0) + 1);
      let bucket = wordContexts.get(key);
      if (!bucket) { bucket = new Set(); wordContexts.set(key, bucket); }
      bucket.add(idx);
      if (bucket.size > PER_WORD_CTX_CAP) {
        // Drop the oldest entry (Sets preserve insertion order).
        const oldest = bucket.values().next().value;
        bucket.delete(oldest);
      }
    }

    // SPEED: build cooccurrence keys with inline string compare (lexicographic
    // sort of a 2-element array is just `a < b ? a+'|'+b : b+'|'+a`). Avoids
    // an Array allocation + .sort() + .join() per pair (~2M pairs in Stage 11d).
    const cooc = this.cooccurrence;
    const N = sigLower.length;
    for (let i = 0; i < N; i++) {
      const a = sigLower[i];
      const end = i + 8 < N ? i + 8 : N;
      for (let j = i + 1; j < end; j++) {
        const b = sigLower[j];
        const pair = a < b ? `${a}|${b}` : `${b}|${a}`;
        cooc.set(pair, (cooc.get(pair) || 0) + 1);
      }
    }
  }

  extractEntities(text, latticeEntities = null) {
    // SPEED: lattice-entity lowercase set is stable across many calls within the
    // same ingest (extractEntities is called for query AND response of one
    // ingest, plus from extractFacts within the same ingest). Cache it on the
    // extractor instance and rebuild only when the lattice grows.
    const known = this._latticeKnownSet(latticeEntities);

    const entities = [];
    const words = String(text).split(WORDS_SPLIT_RE);
    const W = words.length;
    // SPEED: precompute per-word "starts with digit-or-$" for the +/- 1 window
    // checks (Method 5). Was running /[\d$]/.test on adjacent words inline.
    const startsDigitDollar = new Uint8Array(W);
    for (let i = 0; i < W; i++) {
      const ch = words[i].charCodeAt(0);
      // '$'=36, '0'-'9'=48-57
      if (ch === 36 || (ch >= 48 && ch <= 57)) startsDigitDollar[i] = 1;
      else if (words[i].length > 1) {
        // /[\d$]/.test(w) means ANY char is digit or $ — fall back to regex.
        if (NUM_OR_DOLLAR_RE.test(words[i])) startsDigitDollar[i] = 1;
      }
    }

    const wordFreq = this.wordFreq;
    const cooc = this.cooccurrence;
    const knownSize = known.size;

    for (let i = 0; i < W; i++) {
      const word = words[i];
      // SPEED: cheap pre-check — if word has no alphanum at all, skip the regex.
      if (word.length === 0) continue;
      const clean = word.replace(NON_ALNUM_G, '');
      const cleanLen = clean.length;
      if (cleanLen < 2) continue;
      const lo = clean.toLowerCase();
      if (STOP.has(lo)) continue;

      let score = 0;
      let kind = 'concept';

      // Method 1: capitalized, not sentence start
      if (i > 0) {
        const c0 = clean.charCodeAt(0);
        if (c0 >= 65 && c0 <= 90 && cleanLen > 2 && CAP_WORD_RE.test(clean)) {
          score += 3.0;
        }
      }
      // Method 2: after name signal
      if (i > 0) {
        const prev = words[i - 1].toLowerCase().replace(NON_AZ_G, '');
        if (NAME_SIGNALS.has(prev)) score += 4.0;
      }
      // Method 3: high frequency (STOP already excluded above, redundant check
      // preserved in original — keep semantics).
      const freq = wordFreq.get(lo) || 0;
      if (freq >= 3) {
        const inc = freq * 0.3;
        score += inc < 2.0 ? inc : 2.0;
      }
      // Method 4: co-occurrence with any known entity.
      // SPEED: avoid the [lo, knownEnt].sort().join('|') alloc per pair —
      // inline lexicographic compare + template-string concat. Also: stop
      // iterating as soon as we hit threshold (the original `break` is preserved).
      if (knownSize > 0) {
        for (const knownEnt of known) {
          const pair = lo < knownEnt ? `${lo}|${knownEnt}` : `${knownEnt}|${lo}`;
          const cc = cooc.get(pair) || 0;
          if (cc >= 2) {
            const inc = cc * 0.5;
            score += inc < 3.0 ? inc : 3.0;
            break;
          }
        }
      }
      // Method 5: adjacent to number/dollar
      if (i > 0 && startsDigitDollar[i - 1]) {
        score += 2.0;
        kind = 'valued_entity';
      }
      if (i < W - 1 && startsDigitDollar[i + 1]) {
        score += 2.0;
        kind = 'valued_entity';
      }
      // Method 6: already known
      if (known.has(lo)) score += 5.0;

      // Classify kind by context window — only matters when we'll emit (score >= 3).
      // SPEED: short-circuit when score is already < 3 so we never lowercase
      // the context window. The context loop was the single hottest sub-step
      // inside extractEntities (~50% of its time) because Object.entries was
      // called per word AND signals were .toLowerCase()'d per word.
      if (score >= 3.0) {
        const start = i - 3 < 0 ? 0 : i - 3;
        const stop = i + 4 > W ? W : i + 4;
        let context = '';
        for (let k = start; k < stop; k++) context += (k === start ? '' : ' ') + words[k];
        const contextLo = context.toLowerCase();
        // SPEED: ENTITY_SIGNALS_LC precomputed at module scope, so we iterate
        // [kind, signals[]] pairs without rebuilding Object.entries or
        // re-lowercasing signal strings on every word.
        for (let g = 0; g < ENTITY_SIGNALS_LC.length; g++) {
          const [k, signals] = ENTITY_SIGNALS_LC[g];
          let hit = false;
          for (let s = 0; s < signals.length; s++) {
            if (contextLo.includes(signals[s])) { hit = true; break; }
          }
          if (hit) { kind = k; break; }
        }
        entities.push([clean, kind]);
      }
    }
    return entities;
  }

  // SPEED: cache the lowercase-entity-name Set on the extractor. Stage 11d
  // calls extractEntities once per query AND once per response (2× per ingest),
  // plus extractFacts re-derives the same set, for ~5500 rebuilds of an
  // ever-growing set across 1491 ingests. Cache + invalidate-on-grow.
  _latticeKnownSet(latticeEntities) {
    if (!latticeEntities) return _EMPTY_SET;
    // If we're handed a Map, peek size to invalidate on growth.
    if (latticeEntities instanceof Map) {
      const size = latticeEntities.size;
      if (this._knownLatticeRef === latticeEntities && this._knownLatticeSize === size) {
        return this._knownLatticeSet;
      }
      const s = new Set();
      for (const k of latticeEntities.keys()) s.add(String(k).toLowerCase());
      this._knownLatticeRef = latticeEntities;
      this._knownLatticeSize = size;
      this._knownLatticeSet = s;
      return s;
    }
    // Fallback for plain objects (rare path).
    const s = new Set();
    for (const k of Object.keys(latticeEntities)) s.add(String(k).toLowerCase());
    return s;
  }

  extractFacts(query, response, latticeEntities = null) {
    const facts = [];
    // SPEED: reuse cached lattice-known set (see extractEntities for rationale).
    const known = this._latticeKnownSet(latticeEntities);
    // SPEED: pre-filter to entities length > 2 once — original re-checked
    // `e.length > 2` inside the per-sentence loop. Cache the filtered list
    // bound to the same (ref, size) key the Set uses, so growth invalidates both.
    let knownFiltered;
    if (this._knownFilteredKey === this._knownLatticeSet) {
      knownFiltered = this._knownFilteredArr;
    } else if (known.size > 0) {
      knownFiltered = [];
      for (const e of known) if (e.length > 2) knownFiltered.push(e);
      this._knownFilteredKey = this._knownLatticeSet;
      this._knownFilteredArr = knownFiltered;
    } else {
      knownFiltered = _EMPTY_ARRAY;
      this._knownFilteredKey = this._knownLatticeSet;
      this._knownFilteredArr = knownFiltered;
    }

    const sentences = String(response).split(SENTENCE_SPLIT_RE);

    for (let si = 0; si < sentences.length; si++) {
      const sentence = sentences[si].trim();
      const sLen = sentence.length;
      if (sLen < 10 || sLen > 150) continue;
      const lo = sentence.toLowerCase();
      let score = 0;

      const hasDigit = NUM_RE.test(sentence);
      if (hasDigit) score += 2.0;

      // SPEED: precomputed FACT_VERBS_LC, indexed loop with early break.
      for (let v = 0; v < FACT_VERBS_LC.length; v++) {
        if (lo.includes(FACT_VERBS_LC[v])) { score += 1.5; break; }
      }

      let entityHits = 0;
      for (let e = 0; e < knownFiltered.length; e++) {
        if (lo.includes(knownFiltered[e])) entityHits++;
      }
      if (entityHits >= 1 && hasDigit) score += 2.0;

      // SPEED: precomputed FACT_COMPARATORS_LC.
      for (let c = 0; c < FACT_COMPARATORS_LC.length; c++) {
        if (lo.includes(FACT_COMPARATORS_LC[c])) { score += 1.5; break; }
      }
      if (entityHits >= 2) score += 2.0;
      if (FACT_PRICE_RE.test(lo)) score += 1.5;

      if (score >= 3.0) {
        facts.push(sentence);
        if (facts.length >= 8) break; // SPEED: original sliced to 8, same effect.
      }
    }
    return facts;
  }

  reconstructCoverage(messageIdx, lattice) {
    if (messageIdx >= this.messages.length) return [1.0, []];

    // SPEED: cache per-message significant-tokens (lowercase). The message
    // contents are immutable once ingested, so the tokenization is stable
    // across every resonance-loop call. runResonanceLoop calls this O(N*K)
    // times per outer iteration; without the cache that's ~3000+ redundant
    // tokenize+lowercase passes per Stage 11d sweep.
    let sigLower = this._sigCache && this._sigCache[messageIdx];
    if (!sigLower) {
      const [query, response] = this.messages[messageIdx];
      const matches = tokenize(`${query} ${response}`);
      sigLower = [];
      for (let i = 0; i < matches.length; i++) {
        const t = matches[i];
        if (t.length > 1) {
          const lo = t.toLowerCase();
          if (!STOP.has(lo)) sigLower.push(lo);
        }
      }
      if (!this._sigCache) this._sigCache = [];
      this._sigCache[messageIdx] = sigLower;
    }
    if (sigLower.length === 0) return [1.0, []];

    // SPEED: build `explained` via the per-loop cache when valid. The hot
    // path here is dominated by re-tokenizing every fact.content and every
    // decision.description on EVERY call. With the cache that work amortizes
    // to once per lattice mutation.
    const explained = this._explainedSet(lattice);

    // SPEED: single pass over sig — count + collect residuals. Original made
    // TWO .filter calls.
    let covered = 0;
    const residuals = [];
    for (let i = 0; i < sigLower.length; i++) {
      const t = sigLower[i];
      if (explained.has(t)) covered++;
      else residuals.push(t);
    }
    const coverage = covered / sigLower.length;
    return [coverage, residuals];
  }

  // SPEED: explained-set cache keyed by lattice entity/fact/decision/topic
  // counts. Cheap O(1) staleness check; only rebuild when the lattice grows.
  _explainedSet(lattice) {
    const eSize = lattice.entities.size;
    const fLen = lattice.facts.length;
    const dLen = lattice.decisions.length;
    const tSize = lattice.topics.size;
    if (this._explainedLattice === lattice &&
        this._explainedKey &&
        this._explainedKey.e === eSize &&
        this._explainedKey.f === fLen &&
        this._explainedKey.d === dLen &&
        this._explainedKey.t === tSize) {
      return this._explainedCache;
    }
    const explained = new Set();
    for (const ename of lattice.entities.keys()) explained.add(ename.toLowerCase());
    for (let i = 0; i < lattice.facts.length; i++) {
      const tokens = tokenize(lattice.facts[i].content);
      for (let k = 0; k < tokens.length; k++) {
        const t = tokens[k];
        if (t.length > 1) {
          const lo = t.toLowerCase();
          if (!STOP.has(lo)) explained.add(lo);
        }
      }
    }
    for (let i = 0; i < lattice.decisions.length; i++) {
      const tokens = tokenize(lattice.decisions[i].description);
      for (let k = 0; k < tokens.length; k++) {
        const t = tokens[k];
        if (t.length > 1) {
          const lo = t.toLowerCase();
          if (!STOP.has(lo)) explained.add(lo);
        }
      }
    }
    for (const topic of lattice.topics.keys()) explained.add(topic.toLowerCase());
    this._explainedLattice = lattice;
    this._explainedKey = { e: eSize, f: fLen, d: dLen, t: tSize };
    this._explainedCache = explained;
    return explained;
  }

  runResonanceLoop(lattice, maxIterations = 3) {
    const stats = { iterations: 0, entities_added: 0, facts_added: 0, coverage_improvement: 0 };

    for (let iter = 0; iter < maxIterations; iter++) {
      let totalCoverage = 0;
      const allResiduals = new Map();
      for (let idx = 0; idx < this.messages.length; idx++) {
        const [cov, residuals] = this.reconstructCoverage(idx, lattice);
        totalCoverage += cov;
        for (const r of residuals) {
          const k = r.toLowerCase();
          allResiduals.set(k, (allResiduals.get(k) || 0) + 1);
        }
      }
      let newEntitiesFound = 0;
      const sortedResiduals = [...allResiduals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
      const cooc = this.cooccurrence;
      for (const [word, count] of sortedResiduals) {
        if (count >= 4 && !STOP.has(word) && word.length > 3) {
          let knownCooc = 0;
          for (const ename of lattice.entities.keys()) {
            const elo = ename.toLowerCase();
            // SPEED: inline lexicographic compare (see ingestMessage).
            const pair = word < elo ? `${word}|${elo}` : `${elo}|${word}`;
            knownCooc += cooc.get(pair) || 0;
          }
          if (knownCooc >= 3 || count >= 5) {
            const titleCase = word[0].toUpperCase() + word.slice(1);
            const displayName = /[A-Z]/.test(word.slice(1)) ? word : titleCase;
            if (!lattice.entities.has(displayName) && !lattice.entities.has(word)) {
              lattice.entities.set(displayName, new Entity({
                name: displayName, kind: 'discovered',
                mentionCount: count, firstSeen: 0, lastSeen: 0,
              }));
              this.knownEntities.add(word);
              newEntitiesFound += 1;
              stats.entities_added += 1;
            }
          }
        }
      }
      for (let idx = 0; idx < this.messages.length; idx++) {
        const [cov, residuals] = this.reconstructCoverage(idx, lattice);
        if (cov < 0.5 && residuals.length > 0) {
          const [q, r] = this.messages[idx];
          const newFacts = this.extractFacts(q, r, lattice.entities);
          for (const fact of newFacts) {
            if (!lattice.facts.some(f => f.content === fact)) {
              lattice.facts.push(new Fact({ content: fact, sourceThread: idx }));
              stats.facts_added += 1;
            }
          }
        }
      }
      stats.iterations = iter + 1;
      if (newEntitiesFound === 0) break;
    }

    let totalCoverage = 0;
    for (let idx = 0; idx < this.messages.length; idx++) {
      const [cov] = this.reconstructCoverage(idx, lattice);
      totalCoverage += cov;
    }
    stats.final_coverage = Number((totalCoverage / Math.max(1, this.messages.length)).toFixed(3));
    return stats;
  }
}

function extractEntities(text, latticeEntities = null, extractor = null) {
  if (extractor) return extractor.extractEntities(text, latticeEntities);
  // Fallback heuristic
  const entities = [];
  const words = String(text).split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (i > 0 && word.length > 2 && word[0] >= 'A' && word[0] <= 'Z' && /^[A-Za-z]+$/.test(word)) {
      const context = words.slice(Math.max(0, i - 2), Math.min(words.length, i + 3)).join(' ').toLowerCase();
      let kind = 'concept';
      for (const [k, signals] of Object.entries(ENTITY_SIGNALS)) {
        if (signals.some(s => context.includes(s.toLowerCase()))) { kind = k; break; }
      }
      entities.push([word, kind]);
    }
  }
  return entities;
}

function extractFacts(_query, response, latticeEntities = null, extractor = null) {
  if (extractor) return extractor.extractFacts(_query, response, latticeEntities);
  const facts = [];
  const text = String(response).replace(/\. /g, '.\n');
  for (const raw of text.split('\n')) {
    const sentence = raw.trim();
    if (!sentence || sentence.length < 15) continue;
    if (/\d/.test(sentence) && sentence.length < 120) facts.push(sentence);
    else if ([' is ', ' are ', ' costs ', ' has ', ' was ', ' were '].some(p => sentence.toLowerCase().includes(p)) && sentence.length < 100) facts.push(sentence);
  }
  return facts.slice(0, 5);
}

function classifyTopic(text) {
  const lo = String(text).toLowerCase();
  const topics = {
    music: ['music', 'album', 'song', 'audio', 'mix', 'master', 'beat'],
    finance: ['money', 'invest', 'trade', 'price', 'cost', 'revenue', 'capital'],
    business: ['investor', 'deck', 'pitch', 'startup', 'company', 'strategy'],
    tech: ['code', 'api', 'build', 'deploy', 'software', 'ai', 'model'],
    creative: ['design', 'video', 'image', 'brand', 'aesthetic', 'content'],
    health: ['sleep', 'workout', 'recovery', 'stress', 'health', 'readiness'],
    research: ['research', 'compare', 'analyze', 'what is', 'how does'],
  };
  for (const [topic, kws] of Object.entries(topics)) {
    if (kws.some(kw => lo.includes(kw))) return topic;
  }
  return 'general';
}

// ═══════════════════════════════════════════════════════════════════
// CrystalCompressor — full ingest pipeline
// ═══════════════════════════════════════════════════════════════════

export class CrystalCompressor {
  constructor({ store = null, resonanceInterval = 100 } = {}) {
    this.lattice = new Lattice();
    this.void = new VoidMap();
    this.deltas = [];
    this._rawBytesIngested = 0;
    this._extractor = new ResonanceExtractor();
    this._resonanceInterval = resonanceInterval;
    this.store = store;
  }

  ingest(threadNum, query, response = '') {
    const ts = now();
    this._rawBytesIngested += query.length + response.length;
    this.lattice.totalThreads = Math.max(this.lattice.totalThreads, threadNum);
    const combined = `${query} ${response}`;

    this._extractor.ingestMessage(threadNum, query, response);

    // Entities
    const newEntities = [];
    const fromQ = extractEntities(query, this.lattice.entities, this._extractor);
    const fromR = extractEntities(response, this.lattice.entities, this._extractor);
    for (const [name, kind] of [...fromQ, ...fromR]) {
      if (!this.lattice.entities.has(name)) {
        this.lattice.entities.set(name, new Entity({ name, kind, firstSeen: ts }));
        newEntities.push(name);
      }
      this.lattice.entities.get(name).touch(ts);
    }

    // Facts
    // SPEED: cache each fact's word Set on the Fact instance the first time
    // we need it. Previously this loop rebuilt the wordSet for EVERY existing
    // fact on every ingest — O(N*M) Set constructions across Stage 11d's
    // ~1500 receipts. Cached, it becomes O(N+M) Set constructions total.
    // Behavior identical: the cached Set is built from the same string via
    // the same regex split.
    const newFacts = [];
    if (response) {
      // SPEED: cache lattice array + length lookups inside the hot loop.
      const latticeFacts = this.lattice.facts;
      for (const factText of extractFacts(query, response, this.lattice.entities, this._extractor)) {
        const wordsNew = new Set(factText.toLowerCase().split(WORDS_SPLIT_RE));
        const wordsNewSize = wordsNew.size;
        let isDup = false;
        if (wordsNewSize > 0) {
          for (let fi = 0, fl = latticeFacts.length; fi < fl; fi++) {
            const existing = latticeFacts[fi];
            let wordsOld = existing._wordSet;
            if (!wordsOld) {
              wordsOld = new Set(existing.content.toLowerCase().split(WORDS_SPLIT_RE));
              // Non-enumerable so toDict / JSON.stringify ignore it (toDict
              // explicitly enumerates fields anyway, but this is belt-and-braces).
              Object.defineProperty(existing, '_wordSet', { value: wordsOld, enumerable: false, writable: true, configurable: true });
            }
            const wordsOldSize = wordsOld.size;
            if (wordsOldSize > 0) {
              // SPEED: iterate the SMALLER set against the larger for intersection.
              let intersect = 0;
              if (wordsNewSize <= wordsOldSize) {
                for (const w of wordsNew) if (wordsOld.has(w)) intersect++;
              } else {
                for (const w of wordsOld) if (wordsNew.has(w)) intersect++;
              }
              // SPEED: union size by inclusion-exclusion — avoids building a new spread Set.
              const union = wordsNewSize + wordsOldSize - intersect;
              const overlap = intersect / Math.max(union, 1);
              if (overlap > 0.6) {
                isDup = true;
                existing.supersededBy = `thread_${threadNum}`;
                break;
              }
            }
          }
        }
        const newFact = new Fact({ content: factText, sourceThread: threadNum, timestamp: ts });
        Object.defineProperty(newFact, '_wordSet', { value: wordsNew, enumerable: false, writable: true, configurable: true });
        latticeFacts.push(newFact);
        newFacts.push(factText);
      }
    }

    // Topic
    const topic = classifyTopic(query);
    this.lattice.topics.set(topic, (this.lattice.topics.get(topic) || 0) + 1);

    // Decision
    let decision = '';
    const decisionSignals = ['chose', 'decided', 'going with', "let's do", 'approved', 'confirmed'];
    const loCombined = combined.toLowerCase();
    for (const signal of decisionSignals) {
      if (loCombined.includes(signal)) {
        for (const sentence of loCombined.split('.')) {
          if (sentence.includes(signal)) {
            decision = sentence.trim().slice(0, 100);
            this.lattice.decisions.push(new Decision({ description: decision, thread: threadNum, timestamp: ts }));
            break;
          }
        }
        break;
      }
    }

    // VOID
    for (const rejText of detectRejections(query)) {
      if (!this.void.rejections.some(r => r.what === rejText)) {
        const favor = decision ? decision.slice(0, 40) : '';
        this.void.rejections.push(new Rejection({ what: rejText, inFavorOf: favor, sourceThread: threadNum, timestamp: ts }));
      }
    }
    for (const rejText of detectRejections(combined)) {
      if (!this.void.rejections.some(r => r.what === rejText)) {
        this.void.rejections.push(new Rejection({ what: rejText, sourceThread: threadNum, timestamp: ts }));
      }
    }
    for (const boundaryText of detectBoundaries(combined)) {
      if (!this.void.boundaries.some(b => b.constraint === boundaryText)) {
        this.void.boundaries.push(new Boundary({ constraint: boundaryText, domain: topic, sourceThread: threadNum, timestamp: ts }));
      }
    }
    for (const tone of detectTone(combined)) {
      this.void.toneMarkers.push(new ToneMarker({ marker: tone, context: query.slice(0, 30), thread: threadNum, timestamp: ts }));
    }
    if (this.void.toneMarkers.length > 30) this.void.toneMarkers = this.void.toneMarkers.slice(-30);

    // Fill level — logarithmic depth
    const topicCount = this.lattice.topics.get(topic) || 0;
    this.void.fillLevels.set(topic, Math.min(1.0, Math.log(1 + topicCount) / 5.0));

    // Delta
    const delta = new Delta({
      threadNum, timestamp: ts,
      newEntities, newFacts, newDecision: decision,
      topicUpdate: topic,
      patternId: query.trim().endsWith('?') ? 'qa' : 'command',
      rawQueryHash: md5Hex(query).slice(0, 8),
    });
    this.deltas.push(delta);
    if (this.deltas.length > 200) this.deltas = this.deltas.slice(-200);

    // Drop superseded facts, cap at 100.
    // SPEED: fast path when nothing changed. Original ran filter+slice on the
    // facts array on EVERY ingest (1500+ calls in Stage 11d). The fast path
    // skips both allocations when no fact is superseded AND length stays at/
    // below 100 — the common case. Identical observable contents either way.
    {
      const facts = this.lattice.facts;
      const flen = facts.length;
      let anySuperseded = false;
      for (let i = 0; i < flen; i++) {
        if (facts[i].supersededBy) { anySuperseded = true; break; }
      }
      if (anySuperseded || flen > 100) {
        const filtered = [];
        for (let i = 0; i < flen; i++) {
          const f = facts[i];
          if (!f.supersededBy) filtered.push(f);
        }
        const start = filtered.length > 100 ? filtered.length - 100 : 0;
        this.lattice.facts = start === 0 ? filtered : filtered.slice(start);
      }
    }

    // Run resonance loop periodically
    if (this.lattice.totalThreads > 0 && this.lattice.totalThreads % this._resonanceInterval === 0) {
      this._extractor.runResonanceLoop(this.lattice, 2);
    }

    if (this.store) {
      const ratio = this.compressionRatio();
      this.store.insertReceipt('crystal.ingest', 'ok',
        `thread ${threadNum}: ${newEntities.length} new entities, ${newFacts.length} new facts, ratio ${ratio.toFixed(1)}x`,
        { thread_num: threadNum, new_entities: newEntities.length, new_facts: newFacts.length, ratio });
    }

    return delta;
  }

  compressionRatio() {
    if (this._rawBytesIngested === 0) return 1.0;
    const compressed = this.lattice.sizeBytes() + this.deltas.reduce((s, d) => s + d.sizeBytes(), 0);
    return this._rawBytesIngested / Math.max(compressed, 1);
  }

  // ─────────────────────────────────────────────────────────────────
  // FIX G (audit-05, 2026-06-27): flush transient scratch on the compressor.
  // ─────────────────────────────────────────────────────────────────
  // Idempotent. Drops:
  //   • per-Fact `_wordSet` Sets (cached for dedup intersection — these can
  //     be rebuilt on next ingest from `fact.content`)
  //   • Extractor scratch (see ResonanceExtractor.flushTransients).
  // Preserves: lattice entities/facts/decisions/topics, void map, deltas,
  // raw byte counter, LRU-capped extractor state, RRL-discovered entities.
  // Called automatically from stats() — the terminal boundary in production
  // callsites (engines.mjs runOrganismStage, receipt_sweep, layer2, dict).
  // Safe to call mid-stream; caches rebuild lazily on next access.
  flushTransients() {
    // Drop per-Fact cached wordSets. Behaviorally invisible: rebuilt by
    // ingest() on next dedup pass from `existing.content`. Non-enumerable so
    // JSON / toDict ignore them anyway, but the hidden Sets still occupy
    // heap. With facts capped at 100 and ~30 words/fact, ~3k strings per
    // Crystal instance × 4 instances per demo × multi-iteration loops adds up.
    const facts = this.lattice.facts;
    for (let i = 0, n = facts.length; i < n; i++) {
      const f = facts[i];
      if (f && f._wordSet !== undefined) {
        try { f._wordSet = null; } catch { /* readonly — ignore */ }
      }
    }
    // Forward to extractor (where the bulk of transient scratch lives).
    if (this._extractor && typeof this._extractor.flushTransients === 'function') {
      this._extractor.flushTransients();
    }
    // FIX G: under Bun's collector, transient retention sometimes spans one
    // sweep — V8/JSC needs a second pass to reclaim objects that were held
    // by inter-Crystal closures (extractor → lattice → fact → wordSet cycles
    // that the single GC tick can't trace fully). A second synchronous
    // collection from inside flushTransients() — fired only when the host
    // exposes Bun.gc, and only after the explicit reference nulling above —
    // closes that retention window before the next runAsOrganism() iteration.
    // Cost: ~5-10ms per stats() call; gain: parity with two-pass GC at the
    // caller (single Bun.gc(true) after stats() now matches double-pass).
    if (typeof Bun !== 'undefined' && typeof Bun.gc === 'function') {
      try { Bun.gc(true); } catch { /* noop — collector unavailable */ }
    }
  }

  stats() {
    const voidBytes = JSON.stringify(this.void.toDict()).length;
    const latticeBytes = this.lattice.sizeBytes();
    const deltaBytes = this.deltas.reduce((s, d) => s + d.sizeBytes(), 0);
    const result = {
      raw_bytes: this._rawBytesIngested,
      lattice_bytes: latticeBytes,
      void_bytes: voidBytes,
      delta_bytes: deltaBytes,
      total_compressed: latticeBytes + voidBytes + deltaBytes,
      compression_ratio: Number(this.compressionRatio().toFixed(1)),
      entities: this.lattice.entities.size,
      facts: this.lattice.facts.length,
      decisions: this.lattice.decisions.length,
      rejections: this.void.rejections.length,
      boundaries: this.void.boundaries.length,
      tone_markers: this.void.toneMarkers.length,
      topics: this.lattice.topics.size,
      deltas: this.deltas.length,
      threads: this.lattice.totalThreads,
    };
    // FIX G: stats() is the terminal access in every production callsite
    // (engines.mjs lines 2156, 2452, and the layer2/dict crystals). Flushing
    // here releases per-iteration scratch — extractor caches and per-Fact
    // _wordSet shadows — before the Crystal instance goes out of scope.
    // The numbers in `result` are already materialized above, so flushing
    // post-compute is a pure heap-release with no observable side effect.
    this.flushTransients();
    return result;
  }

  contextForAi(maxTokens = 1000) {
    const latticeCtx = this.lattice.toContext(Math.floor(maxTokens * 0.6));
    const voidCtx = this.void.toContext();
    const parts = [latticeCtx];
    if (voidCtx) parts.push(voidCtx);
    let result = parts.join('\n');
    if (result.length > maxTokens * 4) result = result.slice(0, maxTokens * 4);
    return result;
  }

  toStorage() {
    return JSON.stringify({
      lattice: this.lattice.toDict(),
      void: this.void.toDict(),
      deltas: this.deltas.slice(-100).map(d => ({
        t: d.threadNum, e: d.newEntities, f: d.newFacts,
        d: d.newDecision, p: d.patternId, h: d.rawQueryHash,
      })),
      raw_bytes: this._rawBytesIngested,
    });
  }

  static fromStorage(data) {
    const d = JSON.parse(data);
    const comp = new CrystalCompressor();
    comp._rawBytesIngested = d.raw_bytes || 0;
    const lat = d.lattice || {};
    for (const [name, info] of Object.entries(lat.entities || {})) {
      comp.lattice.entities.set(name, new Entity({
        name, kind: info.kind || '', mentionCount: info.mentions || 0,
      }));
    }
    for (const f of lat.facts || []) {
      comp.lattice.facts.push(new Fact({ content: f.content, sourceThread: f.thread || 0 }));
    }
    for (const dec of lat.decisions || []) {
      comp.lattice.decisions.push(new Decision({ description: dec.desc, thread: dec.thread || 0 }));
    }
    for (const [topic, count] of Object.entries(lat.topics || {})) {
      comp.lattice.topics.set(topic, count);
    }
    comp.lattice.totalThreads = lat.total_threads || 0;
    const v = d.void || {};
    for (const b of v.boundaries || []) {
      comp.void.boundaries.push(new Boundary({ constraint: b.c || '', domain: b.d || '' }));
    }
    for (const r of v.rejections || []) {
      comp.void.rejections.push(new Rejection({ what: r.w || '', why: r.y || '', inFavorOf: r.f || '' }));
    }
    for (const [k, v2] of Object.entries(v.fill || {})) comp.void.fillLevels.set(k, v2);
    for (const t of v.tone || []) {
      comp.void.toneMarkers.push(new ToneMarker({ marker: t.m || '', context: t.c || '' }));
    }
    return comp;
  }
}
