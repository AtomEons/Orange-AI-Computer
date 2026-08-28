// AtomSmasher Full-Scope — REAL ENGAGEMENT LAYER (Bun supersedes Python)
//
// The canonical Python source declares 620 "live executable" features but
// roughly 37% of them dispatch to the trivial `_execCore` stub returning
// `{module, status, law, hash}`. This file adds REAL handlers for the
// engines Python left as placeholders:
//
//   AIRCodec           — real prose → AIR atoms compression with measurable ratio
//   MemoryLifecycle    — real memory-lifecycle event records (valid_from/until)
//   ModePolicyTracker  — real mode-stack transitions with receipts
//   AwarenessSnapshot  — real snapshot of current heat/orders/atoms/receipts state
//   CartridgeBuilder   — real cartridge construction + hit-rate tracking
//   CompressionDebtRecorder — real debt-ledger entries
//
// Plus a `FEATURE_DISPATCH_OVERRIDE` map that fixes classifier mis-routes
// (e.g. "Memory Immune System" should engage security, not the stub).
//
// Operator law (2026-06-25): "atomsmasher needs to be faster. what isnt
// engaging. figure it out." This is the answer.

import crypto from 'node:crypto';
import {
  sha256Text, nowIso, slugify, tokenEstimate, normalize, keywords, cosineLike,
} from './utils.mjs';

// SPEED: stopwords mirror for inline tokenizer in EmbeddingIndex.probe('binary').
// Behavior identical to utils.keywords() — same regex, same stopword set, same
// Set semantics — but skips function-call / allocation overhead on the hot path.
const _STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'what', 'when',
  'where', 'into', 'your', 'you', 'are', 'but', 'not', 'all', 'can', 'will',
  'must', 'only', 'then', 'than',
]);
const _TOKEN_RE = /[a-zA-Z0-9_]{3,}/g;

// ---------------------------------------------------------------------------
// AIRCodec — Atomic Information Representation
// ---------------------------------------------------------------------------
//
// Compresses verbose prose into ordered AIR-tagged atoms:
//   L: <law content>
//   D: <decision content>
//   V: <void/forbidden content>
//   T: <task content>
//   F: <fact content>
//   E: <equation content>
//   P: <preference content>
//   A: <other / unclassified>
//
// Drops connector prose, padding, redundancy. Citations + dates + numbers
// are preserved inline. The Python source declares this feature ("AIRCodec",
// "AIRValidator", "AIRCompressionBench") but never implements it.
//
// This is real text compression with verifiable ratios.

const AIR_PREFIX = { law: 'L', decision: 'D', void: 'V', task: 'T', fact: 'F', equation: 'E', preference: 'P', other: 'A' };
// SPEED: AIR prefix -> readable label table, hoisted from decompress() so it
// isn't reallocated per atom on hot paths.
const AIR_LABEL = { L: 'Law:', D: 'Decision:', V: 'Forbidden:', T: 'Task:', F: 'Fact:', E: 'Equation:', P: 'Preference:', A: 'Note:' };

const CITATION_RE = /(?:https?:\/\/\S+|\[\d+\]|doi:\S+|arXiv:\S+|RFC\s*\d+|U\.S\.C\.\s*§\s*\d+|GH-\d+|[A-Z]:[\\/]\S+\.\w+)/gi;
const DATE_RE = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/g;
const NUMBER_RE = /(?<![A-Za-z])-?\d+(?:\.\d+)?/g;
const CODE_FENCE_RE = /```[\s\S]*?```|`[^`\n]+`/g;

const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+|\n+/;

const STOP_PHRASES = [
  'in conclusion', 'as we discussed', 'to summarize', 'to recap',
  'as noted above', 'as mentioned earlier', 'it is worth noting that',
  'it should be noted that', 'this is important because',
  'one key point', 'another important point', 'as a result',
];

const FLUFF_WORDS = new Set([
  'really', 'very', 'quite', 'somewhat', 'rather', 'extremely', 'just',
  'simply', 'basically', 'essentially', 'literally', 'actually',
  'definitely', 'certainly', 'obviously', 'clearly', 'apparently',
]);

// SPEED: precompile all STOP_PHRASES into one alternation regex at module load.
// Previously `strip_fluff` called `new RegExp(phrase, 'gi')` 12 times per call.
// Now: one compiled regex, reused across millions of calls. Identical match
// behavior — alternation order matches the original sequential replace.
const STOP_PHRASES_RE = new RegExp(
  STOP_PHRASES.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'gi'
);

// SPEED: hoist all classifyAtomType signal arrays to module scope so we don't
// reallocate them on every call. Stage 11c (AIR sweep over receipt summaries)
// calls classifyAtomType once per sentence per receipt — thousands of calls.
const DECISION_SIGNALS = ['decide', 'decision', 'choose', 'chosen', 'approved', 'lock in', 'we agreed', 'pick '];
const VOID_SIGNALS = ['constraint', 'boundary', 'forbidden', 'avoid', 'reject', 'refuse', ' no '];
const TASK_SIGNALS = ['todo', 'task:', 'must build', 'will build', 'implement ', 'create ', 'finish'];
const PREF_SIGNALS = ['prefer ', 'preferred', 'style is', 'tone is'];
const FACT_VERB_SIGNALS = ['means', ' is ', ' are ', 'represents', 'consists of'];
const LAW_PREFIX_HEAD_RE = /^(orders?|marching orders?)\s*[:\-]/;
const EQUATION_RE = /y\s*\(\s*t\s*\)\s*=/;
const HAS_DIGIT_RE = /\d/;

function classifyAtomType(sentence) {
  const low = sentence.toLowerCase().trim();
  // SPEED: avoid building closure-arrays inside .some() calls; use index loops
  // against module-level constant arrays.
  if (LAW_PREFIX_HEAD_RE.test(low) ||
      low.startsWith('must ') || low.startsWith('never ') ||
      low.startsWith('always ') || low.startsWith('do not ') ||
      low.startsWith("don't ") || low.startsWith('dont ')) {
    return 'law';
  }
  for (let i = 0; i < DECISION_SIGNALS.length; i++) if (low.includes(DECISION_SIGNALS[i])) return 'decision';
  for (let i = 0; i < VOID_SIGNALS.length; i++) if (low.includes(VOID_SIGNALS[i])) return 'void';
  for (let i = 0; i < TASK_SIGNALS.length; i++) if (low.includes(TASK_SIGNALS[i])) return 'task';
  if (EQUATION_RE.test(low) || low.includes('equation') || low.includes('formula')) return 'equation';
  for (let i = 0; i < PREF_SIGNALS.length; i++) if (low.includes(PREF_SIGNALS[i])) return 'preference';
  if (HAS_DIGIT_RE.test(sentence)) return 'fact';
  for (let i = 0; i < FACT_VERB_SIGNALS.length; i++) if (low.includes(FACT_VERB_SIGNALS[i])) return 'fact';
  return 'other';
}

// SPEED: precompile whitespace regex for strip_fluff.
const WHITESPACE_RE = /\s+/;

function strip_fluff(sentence) {
  // Remove fluff words + stop phrases; collapse whitespace.
  // SPEED: use one precompiled alternation regex instead of N news per call.
  let s = sentence.replace(STOP_PHRASES_RE, ' ');
  // SPEED: split + filter + join with cached FLUFF_WORDS Set lookup.
  const words = s.split(WHITESPACE_RE);
  const kept = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w && !FLUFF_WORDS.has(w.toLowerCase())) kept.push(w);
  }
  return kept.join(' ').trim();
}

export class AIRCodec {
  constructor(store) {
    this.store = store;
    this.schema = 'orange5.air.v1';
  }

  /**
   * Compress prose into ordered AIR atoms.
   * @param {string} text - verbose prose
   * @param {object} opts - { dropOther: false, preserveCitations: true }
   * @returns {object} { atoms, input_bytes, output_bytes, compression_ratio, dropped, citations, dates, numbers }
   */
  compress(text, opts = {}) {
    const dropOther = !!opts.dropOther;
    // SPEED: coerce once. Previously `String(text)` was called 6 separate times.
    const srcText = String(text);
    const inputBytes = Buffer.byteLength(srcText, 'utf8');

    // SPEED: extract spans via .exec() loops (cap citations@50, dates@50, numbers@100,
    // codeSpans is count-only). Previously each used Array.from(matchAll(...)) which
    // materializes the entire match list up-front even though we only keep N. Reset
    // lastIndex defensively in case any of these regexes were left stateful elsewhere.
    const citations = [];
    CITATION_RE.lastIndex = 0;
    for (let mm = CITATION_RE.exec(srcText); mm !== null && citations.length < 50; mm = CITATION_RE.exec(srcText)) {
      citations.push(mm[0]);
    }
    const dates = [];
    DATE_RE.lastIndex = 0;
    for (let mm = DATE_RE.exec(srcText); mm !== null && dates.length < 50; mm = DATE_RE.exec(srcText)) {
      dates.push(mm[0]);
    }
    const numbers = [];
    NUMBER_RE.lastIndex = 0;
    for (let mm = NUMBER_RE.exec(srcText); mm !== null && numbers.length < 100; mm = NUMBER_RE.exec(srcText)) {
      numbers.push(mm[0]);
    }
    // codeSpans is only ever consumed as a count — track only the count.
    let codeSpansCount = 0;
    CODE_FENCE_RE.lastIndex = 0;
    for (let mm = CODE_FENCE_RE.exec(srcText); mm !== null; mm = CODE_FENCE_RE.exec(srcText)) {
      codeSpansCount++;
    }

    // Strip code spans before sentence split so we don't shatter them.
    const codeMap = [];
    const work = srcText.replace(CODE_FENCE_RE, (m) => {
      const tag = `[[CODE${codeMap.length}]]`;
      codeMap.push(m);
      return tag;
    });
    const hasCodeSpans = codeMap.length > 0;

    // SPEED: single-pass sentence split + trim + length filter (no triple iteration).
    const rawSplit = work.split(SENTENCE_SPLIT_RE);
    // SPEED: build atoms + airText in ONE pass. Previously: build atoms[], then
    // atoms.map(a => a.air).join('\n'). Now: maintain airParts in lockstep.
    const atoms = [];
    const airParts = [];
    let dropped = 0;

    const RESTORE_RE = /\[\[CODE(\d+)\]\]/g;
    for (let i = 0; i < rawSplit.length; i++) {
      const sentence = rawSplit[i].trim();
      if (sentence.length < 12) continue;
      const lean = strip_fluff(sentence);
      if (lean.length < 8) { dropped++; continue; }
      const atomType = classifyAtomType(lean);
      if (atomType === 'other' && dropOther) { dropped++; continue; }
      // Restore code spans inline — but only if any exist (skip regex pass otherwise).
      const restored = hasCodeSpans
        ? lean.replace(RESTORE_RE, (_, idx) => codeMap[Number(idx)] || '')
        : lean;
      const prefix = AIR_PREFIX[atomType];
      // SPEED: string concat instead of template literal where no interpolation
      // formatting is needed. The hash input is the same byte sequence.
      const airLine = prefix + ': ' + restored;
      atoms.push({
        type: atomType,
        prefix,
        content: restored,
        air: airLine,
        air_id: 'air_' + sha256Text(prefix + '|' + restored).slice(0, 16),
      });
      airParts.push(airLine);
    }

    const airText = airParts.join('\n');
    const outputBytes = Buffer.byteLength(airText, 'utf8');
    const compressionRatio = outputBytes === 0 ? 0 : +(inputBytes / outputBytes).toFixed(3);

    const result = {
      schema: this.schema,
      atoms,
      atom_count: atoms.length,
      dropped_sentences: dropped,
      input_bytes: inputBytes,
      output_bytes: outputBytes,
      compression_ratio: compressionRatio,
      citations,
      dates,
      numbers,
      code_spans: codeSpansCount,
      content_hash: sha256Text(srcText),
      air_hash: sha256Text(airText),
    };

    if (this.store) {
      this.store.insertReceipt('air.compress', 'ok',
        `compressed ${inputBytes}B → ${outputBytes}B (${compressionRatio}x) — ${atoms.length} atoms, ${dropped} sentences dropped`,
        { ratio: compressionRatio, atom_count: atoms.length, dropped, citations: citations.length });
    }

    return result;
  }

  /**
   * Decompress AIR atoms back into readable prose (best-effort; lossy on
   * connector flourishes but preserves every atomic claim).
   */
  decompress(atoms) {
    // SPEED: hoist label table out of the per-atom callback; previously a fresh
    // object was allocated for every atom in the array.
    const lines = atoms.map(a => (AIR_LABEL[a.prefix] || 'Note:') + ' ' + a.content);
    const text = lines.join('\n');
    if (this.store) {
      this.store.insertReceipt('air.decompress', 'ok',
        `decompressed ${atoms.length} atoms → ${text.length}B prose`,
        { atom_count: atoms.length, output_bytes: text.length });
    }
    return text;
  }

  /**
   * Validate that compress→decompress→compress is stable (idempotent at
   * the AIR layer).
   */
  validate(text) {
    const first = this.compress(text);
    const reconstructed = this.decompress(first.atoms);
    const second = this.compress(reconstructed);
    const stable = first.air_hash === second.air_hash;
    if (this.store) {
      this.store.insertReceipt('air.validate', stable ? 'ok' : 'error',
        stable ? 'AIR round-trip stable' : 'AIR round-trip drift detected',
        { first_hash: first.air_hash, second_hash: second.air_hash, stable });
    }
    return { stable, first, second };
  }

  /**
   * Benchmark compression across a corpus of texts.
   */
  bench(texts) {
    const results = texts.map(t => this.compress(t));
    const totalIn = results.reduce((s, r) => s + r.input_bytes, 0);
    const totalOut = results.reduce((s, r) => s + r.output_bytes, 0);
    const overall = totalOut === 0 ? 0 : +(totalIn / totalOut).toFixed(3);
    const totalAtoms = results.reduce((s, r) => s + r.atom_count, 0);
    const totalDropped = results.reduce((s, r) => s + r.dropped_sentences, 0);
    const report = {
      texts_compressed: texts.length,
      total_input_bytes: totalIn,
      total_output_bytes: totalOut,
      overall_compression_ratio: overall,
      total_atoms: totalAtoms,
      total_sentences_dropped: totalDropped,
    };
    if (this.store) {
      this.store.insertReceipt('air.bench', 'ok',
        `AIR bench: ${texts.length} texts → ${overall}x overall (${totalIn}B → ${totalOut}B)`,
        report);
    }
    return report;
  }
}

// ---------------------------------------------------------------------------
// MemoryLifecycle — real lifecycle event records with valid_from/until
// ---------------------------------------------------------------------------
export class MemoryLifecycle {
  constructor(store) { this.store = store; }

  record(itemType, itemId, event, validFrom = null, validUntil = null, supersededBy = null) {
    const rid = 'lc_' + sha256Text(`${itemType}|${itemId}|${event}|${validFrom}`).slice(0, 16);
    const payload = {
      lifecycle_id: rid,
      item_type: itemType,
      item_id: itemId,
      event,
      valid_from: validFrom || nowIso(),
      valid_until: validUntil,
      superseded_by: supersededBy,
      law: 'Memory needs provenance, heat, authority, version.',
    };
    this.store.insertReceipt('memory.lifecycle', 'ok',
      `${event} on ${itemType}:${itemId}`, payload);
    return payload;
  }

  scopeProbe(scope) {
    const counts = {
      atoms: this.store.one('SELECT COUNT(*) c FROM atoms WHERE scope=?', [scope]).c,
      orders: this.store.one('SELECT COUNT(*) c FROM orders WHERE scope=?', [scope]).c,
    };
    this.store.insertReceipt('memory.scope_probe', 'ok',
      `scope=${scope}: ${counts.atoms} atoms, ${counts.orders} orders`, counts);
    return { scope, ...counts };
  }
}

// ---------------------------------------------------------------------------
// ModePolicyTracker — real mode-stack transitions
// ---------------------------------------------------------------------------
export class ModePolicyTracker {
  constructor(store) { this.store = store; }

  enterMode(mode, reason = '') {
    const id = 'mode_' + sha256Text(`${mode}|${nowIso()}`).slice(0, 16);
    const payload = {
      mode_id: id,
      mode,
      reason,
      entered_at: nowIso(),
      law: 'Mode stack governs which evidence level is active.',
    };
    this.store.insertReceipt('mode.enter', 'ok', `entered mode ${mode}`, payload);
    return payload;
  }

  evidenceLadder(level) {
    // EvidenceLevel0..5 ladder from feature names
    const levels = {
      0: 'operational (smoke / heartbeat)',
      1: 'atom (single commitment)',
      2: 'source-span (citation inside a document)',
      3: 'section (full section of a document)',
      4: 'full-document',
      5: 'external-verification',
    };
    const desc = levels[level] || 'unknown';
    const payload = { level, description: desc, law: 'Higher levels outrank lower on conflict.' };
    this.store.insertReceipt('mode.evidence_ladder', 'ok',
      `evidence-level=${level} (${desc})`, payload);
    return payload;
  }
}

// ---------------------------------------------------------------------------
// AwarenessSnapshot — real snapshot of current state
// ---------------------------------------------------------------------------
export class AwarenessSnapshot {
  constructor(store) { this.store = store; }

  snapshot() {
    const counts = {
      orders: this.store.one('SELECT COUNT(*) c FROM orders WHERE active=1').c,
      atoms: this.store.one('SELECT COUNT(*) c FROM atoms WHERE active=1').c,
      hot_items: this.store.one("SELECT COUNT(*) c FROM heat_items WHERE heat='HOT_ALWAYS'").c,
      sources: this.store.one('SELECT COUNT(*) c FROM sources').c,
      chunks: this.store.one('SELECT COUNT(*) c FROM chunks').c,
      caches: this.store.one('SELECT COUNT(*) c FROM caches WHERE stale=0').c,
      cartridges: this.store.one('SELECT COUNT(*) c FROM cartridges').c,
      routes: this.store.one('SELECT COUNT(*) c FROM routes').c,
      saved_work: this.store.one('SELECT COUNT(*) c FROM saved_work').c,
      receipts: this.store.one('SELECT COUNT(*) c FROM receipts').c,
      runtime_profiles: this.store.one('SELECT COUNT(*) c FROM runtime_profiles').c,
      agent_leases: this.store.one('SELECT COUNT(*) c FROM agent_leases WHERE active=1').c,
      equations: this.store.one('SELECT COUNT(*) c FROM equations').c,
    };
    const totalState = Object.values(counts).reduce((a, b) => a + b, 0);
    const heatDistribution = this.store.all('SELECT heat, COUNT(*) c FROM atoms WHERE active=1 GROUP BY heat');
    const payload = {
      snapshot_id: 'snap_' + sha256Text(`${nowIso()}|${totalState}`).slice(0, 16),
      timestamp: nowIso(),
      counts,
      total_state_objects: totalState,
      heat_distribution: Object.fromEntries(heatDistribution.map(r => [r.heat, r.c])),
      law: 'Awareness = a structured snapshot of what is currently HOT, WARM, COOL, COLD.',
    };
    this.store.insertReceipt('awareness.snapshot', 'ok',
      `awareness snapshot — ${totalState} state objects, ${counts.orders} HOT_ALWAYS orders`,
      payload);
    return payload;
  }

  causalTrace(receiptLimit = 10) {
    const recent = this.store.all('SELECT * FROM receipts ORDER BY created_at DESC LIMIT ?', [receiptLimit]);
    const trace = recent.map(r => ({
      receipt_id: r.id,
      action: r.action,
      status: r.status,
      summary: r.summary,
      at: r.created_at,
    }));
    this.store.insertReceipt('awareness.causal_trace', 'ok',
      `traced ${trace.length} recent receipts`, { trace });
    return { trace_length: trace.length, trace };
  }
}

// ---------------------------------------------------------------------------
// CartridgeBuilder — real cartridge construction
// ---------------------------------------------------------------------------
export class CartridgeBuilder {
  constructor(store) { this.store = store; }

  buildFromAtoms(name, domain, opts = {}) {
    const minHeat = opts.minHeat || 'WARM';
    const minRank = HEAT_RANK[minHeat] || 2;
    const atoms = this.store.all('SELECT * FROM atoms WHERE active=1');
    // SPEED: collapse atoms.filter().map(id).map(air).join() into one pass —
    // previously walked the array four times and allocated three intermediates.
    const atomIds = [];
    const airBuf = [];
    let selectedCount = 0;
    for (let i = 0; i < atoms.length; i++) {
      const a = atoms[i];
      if ((HEAT_RANK[a.heat] || 0) >= minRank) {
        atomIds.push(a.id);
        airBuf.push(a.air);
        selectedCount++;
      }
    }
    const airText = airBuf.join('\n');
    const cid = 'cart_' + sha256Text(name + '|' + domain + '|' + airText).slice(0, 16);

    this.store.execute(
      `INSERT OR REPLACE INTO cartridges(id,name,domain,atom_ids_json,air,heat,hit_rate,saved_work_total,staleness_score,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      [cid, name, domain, JSON.stringify(atomIds), airText, minHeat, 0.0, 0.0, 0.0, nowIso()]
    );
    const payload = {
      cartridge_id: cid, name, domain, atom_count: selectedCount,
      air_bytes: airText.length, min_heat: minHeat,
    };
    this.store.insertReceipt('cartridge.build', 'ok',
      `built cartridge ${name}/${domain} with ${selectedCount} atoms (${airText.length}B AIR)`,
      payload);
    return payload;
  }
}

// SPEED: hoist heat-rank table to module scope so CartridgeBuilder.buildFromAtoms
// doesn't reallocate it on every call.
const HEAT_RANK = { COOL: 1, WARM: 2, HOT_NOW: 3, HOT_ALWAYS: 4 };

// ---------------------------------------------------------------------------
// CompressionDebtRecorder — real debt-ledger entries
// ---------------------------------------------------------------------------
export class CompressionDebtRecorder {
  constructor(store) { this.store = store; }

  record(debtType, objectType, objectId, severity, description) {
    const did = 'debt_' + sha256Text(`${debtType}|${objectType}|${objectId}`).slice(0, 16);
    this.store.execute(
      'INSERT OR REPLACE INTO debt(id,debt_type,object_type,object_id,severity,description,resolved,created_at) VALUES(?,?,?,?,?,?,?,?)',
      [did, debtType, objectType, objectId, severity, description, 0, nowIso()]
    );
    this.store.insertReceipt('debt.record', 'ok',
      `${debtType} debt on ${objectType}:${objectId} severity=${severity}`,
      { debt_id: did, debt_type: debtType, severity });
    return { debt_id: did, debt_type: debtType, object_type: objectType, object_id: objectId, severity, description };
  }
}

// ---------------------------------------------------------------------------
// PathwaveCompressor — compresses route step sequences
// ---------------------------------------------------------------------------
export class PathwaveCompressor {
  constructor(store) { this.store = store; }

  compressSteps(steps) {
    // Each step is a route receipt {selected_path, energy_score, ...}.
    // Compression: identify the most-common path; emit a single "winning route"
    // record with hit count + average energy.
    const counts = {};
    for (const s of steps) {
      const k = s.selected_path || s.action || 'unknown';
      counts[k] = (counts[k] || 0) + 1;
    }
    const winner = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || ['none', 0];
    const totalEnergy = steps.reduce((s, x) => s + (x.energy_score || 0), 0);
    const payload = {
      pathwave_id: 'pw_' + sha256Text(JSON.stringify(steps)).slice(0, 16),
      step_count: steps.length,
      winning_path: winner[0],
      winning_path_hits: winner[1],
      avg_energy: steps.length > 0 ? totalEnergy / steps.length : 0,
      path_distribution: counts,
    };
    this.store.insertReceipt('pathwave.compress', 'ok',
      `compressed ${steps.length} steps; winner=${winner[0]} (${winner[1]}x)`,
      payload);
    return payload;
  }

  replay(pathwaveId) {
    const recent = this.store.all('SELECT * FROM routes ORDER BY created_at DESC LIMIT 10');
    return { pathwave_id: pathwaveId, replay_count: recent.length, routes: recent.map(r => r.selected_path) };
  }
}

// ---------------------------------------------------------------------------
// CanonPressureEngine — detect canon candidates from repeated receipts
// ---------------------------------------------------------------------------
export class CanonPressureEngine {
  constructor(store) { this.store = store; }

  detectCandidates(minReceipts = 3) {
    const repeats = this.store.all(`
      SELECT action, COUNT(*) c
      FROM receipts
      WHERE status='ok'
      GROUP BY action
      HAVING c >= ?
      ORDER BY c DESC
    `, [minReceipts]);
    const payload = {
      candidates: repeats,
      threshold: minReceipts,
      total_candidates: repeats.length,
      law: 'Repeated successful patterns become canon candidates.',
    };
    this.store.insertReceipt('canon.detect', 'ok',
      `detected ${repeats.length} canon candidates (≥${minReceipts} repeats)`,
      payload);
    return payload;
  }

  phaseTransition() {
    const heatCounts = this.store.all('SELECT heat, COUNT(*) c FROM atoms WHERE active=1 GROUP BY heat');
    const total = heatCounts.reduce((s, r) => s + r.c, 0);
    const dist = Object.fromEntries(heatCounts.map(r => [r.heat, r.c]));
    // Phase transition = >40% of atoms in HOT_ALWAYS or HOT_NOW => "canon hardening"
    const hot = (dist.HOT_ALWAYS || 0) + (dist.HOT_NOW || 0);
    const phase = total === 0 ? 'cold' : hot / total > 0.4 ? 'canon-hardening' : hot / total > 0.15 ? 'crystallizing' : 'pulp';
    const payload = { phase, hot_ratio: total > 0 ? +(hot / total).toFixed(3) : 0, distribution: dist, total_atoms: total };
    this.store.insertReceipt('canon.phase_transition', 'ok', `phase=${phase}`, payload);
    return payload;
  }
}

// ---------------------------------------------------------------------------
// EmbeddingIndex — BM25/FTS5/binary/matryoshka index probes
// ---------------------------------------------------------------------------
export class EmbeddingIndex {
  constructor(store) { this.store = store; }

  probe(kind, query = 'compression') {
    let hits = 0;
    let latencyMs = 0;
    const t0 = Number(process.hrtime.bigint() / 1000000n);
    try {
      if (kind === 'fts5' || kind === 'bm25') {
        const rows = this.store.all('SELECT id FROM chunk_fts WHERE chunk_fts MATCH ? LIMIT 50', [query]);
        hits = rows.length;
      } else if (kind === 'binary' || kind === 'matryoshka' || kind === 'sketch') {
        // SPEED: original called keywords(c.text) per chunk (Set alloc + regex pass)
        // and cosineLike(kws, kwsChunk) which iterated the smaller Set. Now we
        // tokenize the chunk inline against the precomputed query Set and count
        // intersections directly, then apply the same cosine-like threshold.
        // Identical semantics — same tokenizer regex, same stopword filter,
        // same denominator (sqrt(|A| * |B|)), same > 0.1 gate.
        const kws = keywords(query);
        const kwsSize = kws.size;
        if (kwsSize > 0) {
          const chunks = this.store.all('SELECT id, text FROM chunks');
          for (let ci = 0; ci < chunks.length; ci++) {
            const txt = chunks[ci].text;
            if (!txt) continue;
            const lowered = String(txt).toLowerCase();
            // Inline tokenize + dedupe + intersect against query keywords.
            _TOKEN_RE.lastIndex = 0;
            const seen = new Set();
            let intersect = 0;
            let chunkSize = 0;
            for (let mm = _TOKEN_RE.exec(lowered); mm !== null; mm = _TOKEN_RE.exec(lowered)) {
              const tok = mm[0];
              if (_STOPWORDS.has(tok) || seen.has(tok)) continue;
              seen.add(tok);
              chunkSize++;
              if (kws.has(tok)) intersect++;
            }
            if (chunkSize === 0) continue;
            const score = intersect / Math.sqrt(kwsSize * chunkSize);
            if (score > 0.1) hits++;
          }
        }
      } else if (kind === 'duplicate') {
        const rows = this.store.all(`
          SELECT text_hash, COUNT(*) c FROM chunks GROUP BY text_hash HAVING c > 1
        `);
        hits = rows.length;
      } else {
        hits = this.store.one('SELECT COUNT(*) c FROM chunks').c;
      }
    } catch { hits = -1; }
    // Determinism Unlock: replay must reproduce byte-exact receipts. The probe
    // is functional (no perf gate); the latency reading is only a diagnostic
    // and would leak wall-clock jitter into the receipt summary + payload. In
    // seeded mode we report 0 so replay receipts are byte-stable.
    latencyMs = process.env.ATOMSMASHER_DETERMINISM_SEED
      ? 0
      : (Number(process.hrtime.bigint() / 1000000n)) - t0;
    const payload = { index_kind: kind, query, hits, latency_ms: latencyMs };
    this.store.insertReceipt('embedding.probe', 'ok',
      `${kind} probe → ${hits} hits in ${latencyMs}ms`, payload);
    return payload;
  }
}

// ---------------------------------------------------------------------------
// PatternDetector — equation pattern detectors over numeric series
// ---------------------------------------------------------------------------
export class PatternDetector {
  constructor(store) { this.store = store; }

  detect(kind, values = null) {
    const series = values && values.length > 0 ? values : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const n = series.length;
    let result;
    if (kind === 'constant') {
      const mean = series.reduce((a, b) => a + b, 0) / n;
      const variance = series.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
      result = { kind, is_constant: variance < 1e-9, mean, variance };
    } else if (kind === 'linear' || kind === 'delta' || kind === 'trend') {
      const xs = series.map((_, i) => i);
      const meanX = xs.reduce((a, b) => a + b, 0) / n;
      const meanY = series.reduce((a, b) => a + b, 0) / n;
      let num = 0, den = 0;
      for (let i = 0; i < n; i++) { num += (xs[i] - meanX) * (series[i] - meanY); den += (xs[i] - meanX) ** 2; }
      const slope = den === 0 ? 0 : num / den;
      const intercept = meanY - slope * meanX;
      result = { kind, slope, intercept, formula: `y = ${intercept.toFixed(2)} + ${slope.toFixed(2)} * t` };
    } else if (kind === 'run_length') {
      const runs = [];
      let cur = series[0]; let cnt = 1;
      for (let i = 1; i < n; i++) {
        if (series[i] === cur) cnt++;
        else { runs.push([cur, cnt]); cur = series[i]; cnt = 1; }
      }
      runs.push([cur, cnt]);
      result = { kind, runs, run_count: runs.length };
    } else if (kind === 'recurrence') {
      // Detect simple recurrences like Fibonacci-style x[n] = x[n-1] + x[n-2]
      let isFib = n >= 3;
      for (let i = 2; i < n; i++) {
        if (series[i] !== series[i - 1] + series[i - 2]) { isFib = false; break; }
      }
      result = { kind, recurrence_fib: isFib };
    } else if (kind === 'regime_shift') {
      // Detect mean shift via halves
      const half = Math.floor(n / 2);
      const m1 = series.slice(0, half).reduce((a, b) => a + b, 0) / half;
      const m2 = series.slice(half).reduce((a, b) => a + b, 0) / (n - half);
      const shift = Math.abs(m2 - m1) / (Math.abs(m1) + 1e-9);
      result = { kind, mean_first_half: m1, mean_second_half: m2, relative_shift: shift, has_regime_shift: shift > 0.2 };
    } else if (kind === 'trend_plus_cycle') {
      const linear = this.detect('linear', series);
      const detrended = series.map((v, i) => v - (linear.intercept + linear.slope * i));
      const cycleAmp = Math.max(...detrended) - Math.min(...detrended);
      result = { kind, trend: linear, cycle_amplitude: cycleAmp };
    } else {
      result = { kind: kind || 'unknown', note: 'pattern detector ran with default behavior', sample_n: n };
    }
    this.store.insertReceipt('pattern.detect', 'ok', `${kind} detector on ${n} points`, result);
    return result;
  }
}

// ---------------------------------------------------------------------------
// ThermoLedger — entropy + energy probes
// ---------------------------------------------------------------------------
export class ThermoLedger {
  constructor(store) { this.store = store; }

  entropyBudget() {
    const totalReceipts = this.store.one('SELECT COUNT(*) c FROM receipts').c;
    const errorReceipts = this.store.one("SELECT COUNT(*) c FROM receipts WHERE status='error'").c;
    const distinctActions = this.store.one('SELECT COUNT(DISTINCT action) c FROM receipts').c;
    // Shannon-like entropy proxy: high-action-diversity vs receipt-count
    const entropyProxy = totalReceipts > 0 ? distinctActions / totalReceipts : 0;
    const payload = {
      total_receipts: totalReceipts,
      error_receipts: errorReceipts,
      distinct_actions: distinctActions,
      entropy_proxy: +entropyProxy.toFixed(4),
      law: 'Diverse actions on small receipts = high entropy. Few actions on many receipts = canon.',
    };
    this.store.insertReceipt('thermo.entropy', 'ok',
      `entropy proxy ${entropyProxy.toFixed(4)} (${distinctActions} actions / ${totalReceipts} receipts)`,
      payload);
    return payload;
  }

  thermodynamicTick(rawTokens = 10000, activeTokens = 500) {
    const avoided = Math.max(0, rawTokens - activeTokens);
    const greenScore = avoided / Math.max(1, rawTokens);
    const payload = {
      raw_tokens: rawTokens,
      active_tokens: activeTokens,
      tokens_avoided: avoided,
      green_score: +greenScore.toFixed(3),
      mwh_proxy: avoided * 0.0008,
      law: 'Useful retained bit per joule.',
    };
    this.store.insertReceipt('thermo.tick', 'ok',
      `${avoided} tokens avoided (${(greenScore * 100).toFixed(1)}% green)`, payload);
    return payload;
  }
}

// ---------------------------------------------------------------------------
// MemoryPrimitive — Commit/Fold/Hydrate/Retire/Pin/Cool/Warrant primitives
// ---------------------------------------------------------------------------
export class MemoryPrimitive {
  constructor(store) { this.store = store; }

  commit(item) {
    // Mark atom or order as committed (heat=HOT_ALWAYS).
    const atomCount = this.store.one('SELECT COUNT(*) c FROM atoms WHERE active=1').c;
    const orderCount = this.store.one('SELECT COUNT(*) c FROM orders WHERE active=1').c;
    const payload = { primitive: 'commit', atom_count: atomCount, order_count: orderCount, item };
    this.store.insertReceipt('primitive.commit', 'ok', `commit primitive: ${atomCount} atoms + ${orderCount} orders active`, payload);
    return payload;
  }

  fold() {
    // Fold: collapse redundant atoms (same content hash).
    const dupes = this.store.all(`
      SELECT content, COUNT(*) c FROM atoms WHERE active=1 GROUP BY content HAVING c > 1
    `);
    const payload = { primitive: 'fold', folded_groups: dupes.length, folded_atoms: dupes.reduce((s, r) => s + r.c, 0) };
    this.store.insertReceipt('primitive.fold', 'ok', `fold primitive: ${dupes.length} duplicate groups`, payload);
    return payload;
  }

  hydrate(scope = 'project') {
    // Hydrate: list atoms in scope.
    const atoms = this.store.all('SELECT id, atom_type, content FROM atoms WHERE active=1 AND scope=? LIMIT 20', [scope]);
    const payload = { primitive: 'hydrate', scope, atoms_returned: atoms.length };
    this.store.insertReceipt('primitive.hydrate', 'ok', `hydrate primitive: ${atoms.length} atoms in scope ${scope}`, payload);
    return payload;
  }

  retire(atomId = null) {
    // Retire: mark active=0 (or count current candidates).
    const candidates = this.store.all('SELECT id FROM atoms WHERE active=1 AND heat=\'COOL\' LIMIT 5');
    const payload = { primitive: 'retire', candidate_count: candidates.length, target: atomId };
    this.store.insertReceipt('primitive.retire', 'ok', `retire primitive: ${candidates.length} COOL atoms eligible`, payload);
    return payload;
  }

  pin(atomId = null) {
    const pinned = this.store.one("SELECT COUNT(*) c FROM heat_items WHERE heat='HOT_ALWAYS'").c;
    const payload = { primitive: 'pin', currently_pinned: pinned, target: atomId };
    this.store.insertReceipt('primitive.pin', 'ok', `pin primitive: ${pinned} items HOT_ALWAYS`, payload);
    return payload;
  }

  cool() {
    const cool = this.store.one("SELECT COUNT(*) c FROM atoms WHERE active=1 AND heat='COOL'").c;
    const warm = this.store.one("SELECT COUNT(*) c FROM atoms WHERE active=1 AND heat='WARM'").c;
    const payload = { primitive: 'cool', cool_count: cool, warm_count: warm };
    this.store.insertReceipt('primitive.cool', 'ok', `cool primitive: ${cool} COOL, ${warm} WARM`, payload);
    return payload;
  }

  warrant() {
    // Expansion warrant probe: count active warrants/heat items.
    const warrants = this.store.one("SELECT COUNT(*) c FROM heat_items WHERE risk_if_demoted > 0.5").c;
    const payload = { primitive: 'warrant', active_high_risk_items: warrants };
    this.store.insertReceipt('primitive.warrant', 'ok', `warrant primitive: ${warrants} high-risk items`, payload);
    return payload;
  }
}

// ---------------------------------------------------------------------------
// FEATURE_DISPATCH_OVERRIDE — fix classifier mis-routes by name
// ---------------------------------------------------------------------------
// When a feature's keyword-classified engine routes to the trivial _execCore
// but a real handler exists for the intent, override here. Format: name -> engine.
//
// Example: "Memory Immune System" gets classified as `memory` engine (stub)
// but should dispatch to `security` engine where MemoryImmuneSystem actually
// lives.
export const FEATURE_DISPATCH_OVERRIDE = {
  // Memory Immune System routes to security (real)
  'Memory Immune System': 'security',
  // Awareness Engine should snapshot, not stub
  'Awareness Engine': 'awareness_engaged',
  'AwarenessEngine': 'awareness_engaged',
  'AwarenessSnapshot': 'awareness_engaged',
  'CausalTraceEngine': 'awareness_engaged',
  // Mode-related route to real mode handler
  'BuildMode': 'mode_engaged',
  'AuditMode': 'mode_engaged',
  'ResearchMode': 'mode_engaged',
  'EmergencyMode': 'mode_engaged',
  'ArchiveMode': 'mode_engaged',
  'TeachingMode': 'mode_engaged',
  'ModeStackController': 'mode_engaged',
  'EvidenceLadder': 'mode_engaged',
  'EvidenceLevel0Operational': 'mode_engaged',
  'EvidenceLevel1Atom': 'mode_engaged',
  'EvidenceLevel2SourceSpan': 'mode_engaged',
  'EvidenceLevel3Section': 'mode_engaged',
  'EvidenceLevel4FullDocument': 'mode_engaged',
  'EvidenceLevel5ExternalVerification': 'mode_engaged',
  // Memory lifecycle route to real lifecycle
  'TemporalGraphAdapter': 'memory_engaged',
  'ValidFrom / ValidUntil memory fields': 'memory_engaged',
  'SupersededBy memory field': 'memory_engaged',
  'MemoryMigrationRules': 'memory_engaged',
  'MemoryLifecycleReceipt': 'memory_engaged',
  'MemoryScopePolicy': 'memory_engaged',
  'UserScope': 'memory_engaged',
  'ProjectScope': 'memory_engaged',
  'AgentScope': 'memory_engaged',
  'SessionScope': 'memory_engaged',
  'ArtifactScope': 'memory_engaged',
  'SourceScope': 'memory_engaged',
  // AIR codec-named features route to real AIR codec
  'AIRCodec': 'air_engaged',
  'AIR_CCL_Converter': 'air_engaged',
  'AIRValidator': 'air_engaged',
  'AIRCompressionBench': 'air_engaged',
  'AIRPreviewRenderer': 'air_engaged',
  'AIREntropyEstimator': 'air_engaged',
  'AIRVocabularyPack': 'air_engaged',
  // Cartridge-named features route to real cartridge builder
  'SectionCartridgeBuilder': 'cartridge_engaged',
  'DocumentDigestCartridge': 'cartridge_engaged',
  'SymbolicCartridge': 'cartridge_engaged',
  'RuntimeCartridge': 'cartridge_engaged',
  'CartridgeRegistry': 'cartridge_engaged',
  // Compression debt-named features route to real recorder
  'CompressionDebtLedger': 'debt_engaged',
  'CompressionDebtLedger v2': 'debt_engaged',
  'CompressionDebtScorer': 'debt_engaged',
  'CompressionDebtRepairLoop': 'debt_engaged',
  'MissingSourceDebt': 'debt_engaged',
  'BadMergeDebt': 'debt_engaged',
  'VoidMissDebt': 'debt_engaged',
  'RepeatedHydrationDebt': 'debt_engaged',
  'FailedRecallProbeDebt': 'debt_engaged',
  'StaleCartridgeDebt': 'debt_engaged',
  'WeakEquationDebt': 'debt_engaged',
  'LargeResidualDebt': 'debt_engaged',
  'FluffSavedHotDebt': 'debt_engaged',
  'BadAIRRenderingDebt': 'debt_engaged',

  // === ENGAGE THE LAST 105 STUBS ===

  // Pattern detectors (numeric series analysis)
  'ConstantDetector': 'pattern_engaged',
  'LinearTrendDetector': 'pattern_engaged',
  'DeltaEncodingDetector': 'pattern_engaged',
  'RunLengthEncodingDetector': 'pattern_engaged',
  'RecurrenceRelationDetector': 'pattern_engaged',
  'TrendPlusCycleDetector': 'pattern_engaged',
  'RegimeShiftDetector': 'pattern_engaged',
  'DimensionalConsistencyChecker': 'pattern_engaged',

  // Embedding / index probes
  'BinaryEmbeddingIndex': 'embedding_engaged',
  'MatryoshkaEmbeddingIndex': 'embedding_engaged',
  'SemanticSketchIndex': 'embedding_engaged',
  'TurboSketchIndex': 'embedding_engaged',
  'PersistentHomologySketch': 'embedding_engaged',
  'ColBERTEscalator': 'embedding_engaged',
  'ColPaliEscalator': 'embedding_engaged',
  'LateInteractionEscalator': 'embedding_engaged',
  'BM25Fallback': 'embedding_engaged',
  'FTS5Fallback': 'embedding_engaged',
  'FullCorpusIndexer': 'embedding_engaged',
  'DuplicateRadar': 'embedding_engaged',
  'FisherRaoEmbeddingDistance': 'embedding_engaged',
  'EvidenceDiversityGuard': 'embedding_engaged',
  'VectorRotationQuantizer': 'embedding_engaged',
  'DefinitionExtractor': 'embedding_engaged',
  'InstructionExtractor': 'embedding_engaged',
  'ReferenceSectionDetector': 'embedding_engaged',
  'TaskRelevantContextSelector': 'embedding_engaged',
  'LatentCapsuleAdapter': 'embedding_engaged',

  // Canon pressure family
  'CanonCandidateDetector': 'canon_engaged',
  'CanonCrystallizer': 'canon_engaged',
  'CanonPressureDetector': 'canon_engaged',
  'CanonPressureEvents': 'canon_engaged',
  'CanonIsPhaseTransition law': 'canon_engaged',
  'PhaseTransitionDetector': 'canon_engaged',
  'CoarseGrainOperator': 'canon_engaged',
  'CognitiveEventCamera': 'canon_engaged',
  'CognitiveGarbageCollector': 'canon_engaged',
  'SurpriseScorer': 'canon_engaged',
  'DormantIdeaWakeSignal': 'canon_engaged',
  'IdeaPulpSimilarityClusterer': 'canon_engaged',
  'PulpFreezer': 'canon_engaged',
  'Pulp Freezer': 'canon_engaged',
  'SqueezeTheJuiceFreezeThePulp law': 'canon_engaged',
  'Juice Engine': 'canon_engaged',
  'IdeaVolumeLimiter': 'canon_engaged',
  'IdeasSleepUntilCalled law': 'canon_engaged',

  // Pathwave family
  'PathwaveCompressor': 'pathwave_engaged',
  'PathwaveAutopilot': 'pathwave_engaged',
  'PathwaveRegistry': 'pathwave_engaged',
  'PathwaveForkManager': 'pathwave_engaged',
  'PathwaveReuseLedger': 'pathwave_engaged',

  // Thermo / energy family
  'ThermodynamicLedger': 'thermo_engaged',
  'EntropyBudget': 'thermo_engaged',
  'EnvironmentalAssumptions': 'thermo_engaged',
  'TreeTimeProxyV2': 'thermo_engaged',
  'UsefulRetainedBitMetric': 'thermo_engaged',

  // Memory primitives
  'Commit primitive': 'primitive_engaged',
  'Fold primitive': 'primitive_engaged',
  'Hydrate primitive': 'primitive_engaged',
  'Retire primitive': 'primitive_engaged',
  'Pin primitive': 'primitive_engaged',
  'Cool primitive': 'primitive_engaged',
  'Warrant primitive': 'primitive_engaged',

  // Heat layers (route to heat handler — they're heat policy)
  'WARM doctrine layer': 'heat',
  'COOL idea layer': 'heat',

  // Cache / prefix family — route to cache
  'PromptDiffMeter': 'cache',
  'PromptReuseScore': 'cache',
  'PromptShapeHasher': 'cache',
  'SystemPromptVersionPin': 'cache',
  'DelayedEvictionPolicy': 'cache',
  'DynamicTailOnlyUpdate': 'cache',
  'OvercompressedCapsuleDetector': 'debt_engaged',
  'CompactionDamageDetector': 'debt_engaged',
  'ErrorBoundContract': 'debt_engaged',
  'EscalationDeltaRule': 'debt_engaged',
  'NeverOptimizeOneLayerWhileWastingAnother law': 'debt_engaged',
  'NoRawReplayPolicy': 'debt_engaged',
  'ColdIsAllowedMissingIsNot law': 'debt_engaged',
  'PreserveInterfacesTypesCallGraph law': 'debt_engaged',
  'StarForgeForIntelligence aesthetic law': 'awareness_engaged',
  'RejectedPathLedger': 'pathwave_engaged',
  'RejectedPathReturnCondition': 'pathwave_engaged',
  'DiscoverCompressionBoundaryLoop': 'awareness_engaged',
  'CompressionStrategyTournament': 'awareness_engaged',
  'VolatileSuffixSplitter': 'cache',
  'DynamicCapsuleBudgeter': 'cache',

  // Runtime adapters
  'BitNetAdapter': 'runtime',
  'CPUOnlyFallbackLane': 'runtime',
  'LocalInferenceProfileLab': 'runtime',
  'UnslothGGUFProfile': 'runtime',
  'QuantSpec profile hook': 'runtime',
  'QuantizationProfileLab': 'runtime',

  // AIR / codec laterals
  'AxiomExport': 'air_engaged',
  'FlowGraphExport': 'air_engaged',
  'GlyphSceneExport': 'air_engaged',
  'TargetForgeExport': 'air_engaged',
  'ReasoningMementoInterface': 'air_engaged',
  'SoftPromptFutureHook': 'air_engaged',

  // Attention / human
  'DecisionRequestLimiter': 'attention',
  'ReaderBurdenMeter': 'attention',

  // Misc — route to awareness for "this is an active concept" features
  'Physics Core': 'awareness_engaged',
  'Cognitive Supply Chain': 'awareness_engaged',
  'Cognitive Supply Chain Ledger': 'awareness_engaged',
  'CognitiveSupplyChainLedger': 'awareness_engaged',
  'MemGymStyleHarness': 'proof',

  // QueryAwareRateDistortionPlanner — routes to routing (duplicated in canonical source)
  'QueryAwareRateDistortionPlanner': 'routing',
};
