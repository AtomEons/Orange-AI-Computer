// AtomSmasher Full-Scope — Crystal Lattice Compression Engine (production POC)
//
// Faithful Bun port of `AeoNs/extracted/atomeons/memory/clc_engine.py` (238 LOC Python).
// Status per docstring: "Implemented (1.a P3) — regex POC, full NLP pipeline pending"
// Patent pending: ATOM-CLC-2026-0331 (filed 2026-03-31)
// SHA-256: 21d2f40df17631089365363ebae3dc6797be710ad8fcdcd8b8e86c31b8e2dbf7
//
// Why this file exists (per operator law 2026-06-25):
// "ADD THE REAL THINGS. SKIP THEORY. IMPLEMENT ALL THINGS THAT EXIST BUT ARENT
//  CONNECTED OR PLUGGED IN."
//
// This is the real production POC CLC engine. NOT the v1 research-scaffolding doctor
// (that lives at `clc.mjs`). NOT the v3 canonical-predicate spec (that's SKILL.md only).
//
// Compression model: structural — extract entities/decisions/emotions/void from a
// thread; drop everything else. Per-thread ratio reported on each LatticeThread.

import crypto from 'node:crypto';

export const CLC_IDENTIFIER = 'ATOM-CLC-2026-0331';
export const CLC_DISCLOSURE_SHA256 = '21d2f40df17631089365363ebae3dc6797be710ad8fcdcd8b8e86c31b8e2dbf7';

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function now() { return Date.now() / 1000; }

// SPEED: precompiled regexes / signal arrays / emotion-map for the regex-POC
// CLC. Stage 2b of runAsOrganism calls _extractEntities/_extractDecisions/
// _extractEmotions/_extractVoid for every order + every atom in a single run
// (~50-150 invocations). Per-call overhead from repeated `Object.entries(map)`,
// `[...].some(w => lower.includes(w))`, and inline regex literals is small
// individually but adds up; precomputing flips it to O(1) lookups.
const _CLC_ENT_RE = /\b(my\s+\w+|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/g;
const _CLC_DEC_RE = /(?:decided|choosing|going to|will)\s+(.+?)(?:\.|$)/gi;
const _CLC_GOAL_RE = /(?:goal|target|want to|need to|plan to)\s+(.+?)(?:\.|$)/i;

const _CLC_GOAL_WORDS = ['goal', 'target', 'want to', 'need to', 'plan to'];
const _CLC_VALUE_WORDS = ['believe', 'value', 'important', 'matters'];
const _CLC_VOID_REJECT = ["don't want", 'never', 'refuse', "won't", 'hate'];
const _CLC_VOID_BOUND = ['boundary', 'limit', 'not acceptable', 'off limits'];

const _CLC_EMOTION_PAIRS = [
  ['love', 'love'], ['hate', 'anger'], ['happy', 'joy'], ['sad', 'sadness'],
  ['angry', 'anger'], ['excited', 'excitement'], ['afraid', 'fear'],
  ['grateful', 'gratitude'], ['proud', 'pride'], ['ashamed', 'shame'],
  ['frustrated', 'frustration'], ['hopeful', 'hope'], ['anxious', 'anxiety'],
];

function _hasAny(lower, words) {
  for (let i = 0; i < words.length; i++) {
    if (lower.includes(words[i])) return true;
  }
  return false;
}

export const EntityType = Object.freeze({
  PERSON: 'person',
  PLACE: 'place',
  THING: 'thing',
  CONCEPT: 'concept',
  GOAL: 'goal',
  DECISION: 'decision',
  EMOTION: 'emotion',
  VALUE: 'value',
  SKILL: 'skill',
  BELIEF: 'belief',
});

export class LatticeEntity {
  constructor({ entityId = '', entityType = EntityType.THING, name = '', context = '', confidence = 0.5 } = {}) {
    this.name = String(name);
    this.entityType = String(entityType);
    this.context = String(context);
    this.confidence = Number(confidence);
    this.firstSeen = now();
    this.lastSeen = now();
    this.mentionCount = 1;
    this.relatedEntities = [];
    this.entityId = entityId || sha256Hex(`e:${this.name}:${this.entityType}`).slice(0, 12);
  }
  reinforce() {
    this.mentionCount += 1;
    this.lastSeen = now();
    this.confidence = Math.min(0.99, this.confidence + 0.05);
  }
  toDict() {
    return {
      id: this.entityId,
      type: this.entityType,
      name: this.name,
      context: this.context.slice(0, 50),
      confidence: Number(this.confidence.toFixed(2)),
      mentions: this.mentionCount,
    };
  }
}

export class LatticeThread {
  constructor({ threadId = 0, topic = '', content = '', entities = [], decisions = [], emotions = [], originalSize = 0, compressedSize = 0 } = {}) {
    this.threadId = Number(threadId);
    this.topic = String(topic);
    this.content = String(content);
    this.entities = entities;
    this.decisions = decisions;
    this.emotions = emotions;
    this.timestamp = now();
    this.originalSize = Number(originalSize);
    this.compressedSize = Number(compressedSize);
  }
  get compressionRatio() {
    return this.originalSize / Math.max(this.compressedSize, 1);
  }
}

export class VoidEntry {
  constructor({ description = '', category = '', reason = '' } = {}) {
    this.description = String(description);
    this.category = String(category); // 'rejection' | 'boundary' | 'tone' | 'depth'
    this.reason = String(reason);
    this.createdAt = now();
  }
}

export class CrystalLattice {
  constructor() {
    this._entities = new Map();
    this._threads = [];
    this._voidEntries = [];
    this.totalThreads = 0;
    this._rawSize = 0;
    this._compressedSize = 0;
  }

  addEntity(name, entityType, context = '') {
    const key = `${entityType}:${String(name).toLowerCase()}`;
    if (this._entities.has(key)) {
      const e = this._entities.get(key);
      e.reinforce();
      return e;
    }
    const entity = new LatticeEntity({ entityType, name, context });
    this._entities.set(key, entity);
    return entity;
  }

  addVoid(description, category, reason = '') {
    this._voidEntries.push(new VoidEntry({ description, category, reason }));
  }

  getEntity(name, entityType = null) {
    if (entityType) {
      return this._entities.get(`${entityType}:${String(name).toLowerCase()}`) || null;
    }
    for (const e of this._entities.values()) {
      if (e.name.toLowerCase() === String(name).toLowerCase()) return e;
    }
    return null;
  }

  entitiesByType(entityType) {
    return [...this._entities.values()].filter(e => e.entityType === entityType);
  }

  recentEntities(n = 20) {
    return [...this._entities.values()].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, n);
  }

  highConfidence(threshold = 0.7) {
    return [...this._entities.values()].filter(e => e.confidence >= threshold);
  }

  /** Generate context string for LLM injection. */
  toContext(maxEntities = 30) {
    const entities = this.recentEntities(maxEntities);
    if (entities.length === 0) return '';
    const parts = ['[Crystal Lattice Context]'];
    const byType = new Map();
    for (const e of entities) {
      if (!byType.has(e.entityType)) byType.set(e.entityType, []);
      byType.get(e.entityType).push(e);
    }
    for (const [etype, ents] of byType.entries()) {
      const names = ents.slice(0, 5).map(e => e.name).join(', ');
      parts.push(`  ${etype}: ${names}`);
    }
    if (this._voidEntries.length > 0) {
      parts.push(`  Void: ${this._voidEntries.length} exclusions active`);
    }
    return parts.join('\n');
  }

  stats() {
    return {
      entities: this._entities.size,
      threads: this._threads.length,
      void_entries: this._voidEntries.length,
      total_threads: this.totalThreads,
      compression_ratio: Number((this._rawSize / Math.max(this._compressedSize, 1)).toFixed(1)),
    };
  }
}

export class CLCEngine {
  constructor(store = null) {
    this.lattice = new CrystalLattice();
    this.store = store; // optional Orange5 Store for receipt emission
  }

  /** Ingest a message into the lattice. */
  ingest(threadId, topic, content) {
    const text = String(content);
    const originalSize = text.length;

    const entities = this._extractEntities(text);
    const decisions = this._extractDecisions(text);
    const emotions = this._extractEmotions(text);
    const voids = this._extractVoid(text);

    const entityIds = [];
    for (const [name, etype] of entities) {
      const e = this.lattice.addEntity(name, etype, text.slice(0, 50));
      entityIds.push(e.entityId);
    }
    for (const [desc, cat] of voids) {
      this.lattice.addVoid(desc, cat);
    }

    const compressedSize = topic.length + entityIds.reduce((s, id) => s + id.length, 0) + decisions.length * 20;

    const thread = new LatticeThread({
      threadId, topic,
      content: text.slice(0, 200),
      entities: entityIds,
      decisions, emotions,
      originalSize,
      compressedSize,
    });
    this.lattice._threads.push(thread);
    this.lattice.totalThreads += 1;
    this.lattice._rawSize += originalSize;
    this.lattice._compressedSize += compressedSize;

    if (this.store) {
      this.store.insertReceipt('clc.ingest', 'ok',
        `thread ${threadId} compressed ${originalSize}B → ${compressedSize}B (${thread.compressionRatio.toFixed(2)}x) — ${entityIds.length} entities, ${decisions.length} decisions, ${voids.length} voids`,
        { thread_id: threadId, entities: entityIds.length, decisions: decisions.length, voids: voids.length, ratio: thread.compressionRatio });
    }

    return thread;
  }

  _extractEntities(text) {
    const out = [];
    const lower = text.toLowerCase();
    // SPEED: module-scope compiled regex (was rebuilt per call).
    _CLC_ENT_RE.lastIndex = 0;
    let m;
    while ((m = _CLC_ENT_RE.exec(text)) !== null && out.length < 10) {
      const name = m[0].trim();
      if (name.toLowerCase().startsWith('my ')) out.push([name, EntityType.PERSON]);
      else if (name.length > 2 && name[0] >= 'A' && name[0] <= 'Z') out.push([name, EntityType.CONCEPT]);
    }
    // SPEED: precomputed signal arrays + indexed loop (no closure alloc per call).
    if (_hasAny(lower, _CLC_GOAL_WORDS)) {
      const gm = _CLC_GOAL_RE.exec(text);
      if (gm) out.push([gm[1].slice(0, 40), EntityType.GOAL]);
    }
    if (_hasAny(lower, _CLC_VALUE_WORDS)) {
      out.push([text.slice(0, 40), EntityType.VALUE]);
    }
    return out.length > 10 ? out.slice(0, 10) : out;
  }

  _extractDecisions(text) {
    const out = [];
    _CLC_DEC_RE.lastIndex = 0;
    let m;
    while ((m = _CLC_DEC_RE.exec(text)) !== null && out.length < 3) {
      out.push(m[1].slice(0, 60));
    }
    return out;
  }

  _extractEmotions(text) {
    // SPEED: precomputed pair array (no Object.entries alloc per call).
    const lower = text.toLowerCase();
    const out = [];
    for (let i = 0; i < _CLC_EMOTION_PAIRS.length && out.length < 5; i++) {
      const [word, emotion] = _CLC_EMOTION_PAIRS[i];
      if (lower.includes(word)) out.push(emotion);
    }
    return out;
  }

  _extractVoid(text) {
    const out = [];
    const lower = text.toLowerCase();
    if (_hasAny(lower, _CLC_VOID_REJECT)) {
      out.push([text.slice(0, 40), 'rejection']);
    }
    if (_hasAny(lower, _CLC_VOID_BOUND)) {
      out.push([text.slice(0, 40), 'boundary']);
    }
    return out;
  }

  /** Generate compressed context for AI injection. */
  contextForAi(maxTokens = 500) {
    return this.lattice.toContext(Math.floor(maxTokens / 20));
  }

  stats() {
    return this.lattice.stats();
  }
}
