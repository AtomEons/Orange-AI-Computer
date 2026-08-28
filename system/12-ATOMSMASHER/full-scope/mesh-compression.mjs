// AtomSmasher Full-Scope — Mesh Compression (zlib + delta + semantic dedup + void map)
//
// Faithful Bun port of `AeoNs/extracted/atomeons/glyphspeak/compression.py` (7.5 KB Python).
//
// This is the REAL working GlyphSpeak code — NOT the Sigil/TB cross-model glyph encoders
// from the SKILL.md (which are spec-only). The Python code is internal AtomEons mesh
// transport: standard zlib + JSON delta + semantic reference table.
//
// Why this file exists (operator law 2026-06-25):
// "ADD THE REAL THINGS. SKIP THEORY FOR THE GLIPHSPEAK."
//
// Used for: inter-pillar JSON message compression in Orange5
// (OrangeBrain ↔ AE Cobra ↔ AtomSmasher 2 ↔ AE Eyes).
// NOT for cross-model frontier handoff — receiving Opus/GPT/Gemini can't decode zlib.

import crypto from 'node:crypto';
import zlib from 'node:zlib';

function now() { return Date.now() / 1000; }

function sha256Short(s, n = 12) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, n);
}

// ---------------------------------------------------------------------------
// PacketCompressor — byte-level zlib over canonical JSON
// ---------------------------------------------------------------------------
export class PacketCompressor {
  constructor() {
    this._compressed = 0;
    this._bytesSaved = 0;
  }
  compress(data) {
    const raw = Buffer.from(JSON.stringify(data, null, 0), 'utf8');
    const compressed = zlib.deflateSync(raw, { level: 6 });
    this._compressed += 1;
    this._bytesSaved += raw.length - compressed.length;
    return compressed;
  }
  decompress(buf) {
    const raw = zlib.inflateSync(Buffer.from(buf));
    return JSON.parse(raw.toString('utf8'));
  }
  ratio() {
    if (this._compressed === 0) return 1.0;
    return 1 - (this._bytesSaved / (this._compressed * 500));
  }
  stats() { return { compressed: this._compressed, bytes_saved: this._bytesSaved }; }
}

// ---------------------------------------------------------------------------
// DeltaCompressor — only transmit fields that changed
// ---------------------------------------------------------------------------
export class DeltaCompressor {
  constructor() {
    this._last = {};
    this._deltas = 0;
  }
  delta(current) {
    const last = this._last;
    // SPEED: avoid Object.keys() allocation just to test emptiness.
    let hasAny = false;
    for (const _k in last) { hasAny = true; break; }
    if (!hasAny) {
      this._last = { ...current };
      return current;
    }
    const changed = {};
    // SPEED: in the hot Stage 10 sweep this fires 1500+ times. Original did
    // TWO JSON.stringify() per key per packet. Fast path:
    //   - identical primitives or === references skip JSON entirely
    //   - only stringify when at least one side is an object/array
    // Identical semantics (deep value equality via canonical JSON).
    for (const k in current) {
      const v = current[k];
      const prior = last[k];
      if (prior === v) continue; // primitive equal or same reference
      const priorIsObj = prior !== null && typeof prior === 'object';
      const vIsObj = v !== null && typeof v === 'object';
      if (!priorIsObj && !vIsObj) {
        // Both primitives, not equal → changed.
        changed[k] = v;
        continue;
      }
      // At least one is an object — fall back to JSON.stringify comparison.
      if (JSON.stringify(prior) !== JSON.stringify(v)) changed[k] = v;
    }
    this._last = { ...current };
    this._deltas += 1;
    return changed;
  }
  apply(base, delta) {
    return { ...base, ...delta };
  }
  stats() { return { deltas: this._deltas }; }
}

// ---------------------------------------------------------------------------
// SemanticCompressor — dedupe known facts; emit {ref: id} for repeats
// ---------------------------------------------------------------------------
export class SemanticCompressor {
  constructor() {
    this._factRegistry = new Map();
    this._nextRef = 1;
    this._compressions = 0;
    this._factsDeduplicated = 0;
  }
  compressClaims(claims) {
    const out = [];
    for (const claim of claims) {
      const factKey = `${claim.type || ''}/${claim.value || ''}`;
      if (this._factRegistry.has(factKey)) {
        out.push({ ref: this._factRegistry.get(factKey), source: claim.source || '' });
        this._factsDeduplicated += 1;
      } else {
        this._factRegistry.set(factKey, this._nextRef);
        const enriched = { ...claim, ref: this._nextRef };
        this._nextRef += 1;
        out.push(enriched);
      }
    }
    this._compressions += 1;
    return out;
  }
  resolveRef(refId) {
    for (const [key, rid] of this._factRegistry.entries()) {
      if (rid === refId) return key;
    }
    return null;
  }
  compressionRatio() {
    const total = this._compressions * 3;
    if (total === 0) return 0.0;
    return this._factsDeduplicated / total;
  }
  stats() {
    return {
      compressions: this._compressions,
      facts_registry: this._factRegistry.size,
      deduplicated: this._factsDeduplicated,
      ratio: Number(this.compressionRatio().toFixed(3)),
    };
  }
}

// ---------------------------------------------------------------------------
// VoidMapCompressor — suppress retransmission of known facts within TTL
// ---------------------------------------------------------------------------
export class MeshVoidMapCompressor {
  constructor(ttlSeconds = 300) {
    this._known = new Map();
    this._ttl = ttlSeconds;
    this._suppressed = 0;
    this._retransmitted = 0;
  }
  shouldTransmit(factKey) {
    const t = now();
    const factHash = sha256Short(factKey, 12);
    if (this._known.has(factHash)) {
      const age = t - this._known.get(factHash);
      if (age < this._ttl) {
        this._suppressed += 1;
        return false;
      }
      this._retransmitted += 1;
    }
    this._known.set(factHash, t);
    return true;
  }
  invalidate(factKey) {
    this._known.delete(sha256Short(factKey, 12));
  }
  resync() {
    this._known.clear();
  }
  suppressionRate() {
    const total = this._suppressed + this._retransmitted + this._known.size;
    if (total === 0) return 0.0;
    return this._suppressed / total;
  }
  stats() {
    return {
      known_facts: this._known.size,
      suppressed: this._suppressed,
      retransmitted: this._retransmitted,
      suppression_rate: Number(this.suppressionRate().toFixed(3)),
    };
  }
}

// ---------------------------------------------------------------------------
// StreamCompressor — full pipeline: semantic → delta → zlib, with window
// ---------------------------------------------------------------------------
export class MeshStreamCompressor {
  constructor(windowSize = 50, store = null) {
    this._byte = new PacketCompressor();
    this._semantic = new SemanticCompressor();
    this._delta = new DeltaCompressor();
    this._window = [];
    this._windowSize = windowSize;
    this._packetsProcessed = 0;
    this.store = store;
  }
  compressPacket(packetData) {
    const work = { ...packetData };
    if (Array.isArray(work.claims)) {
      work.claims = this._semantic.compressClaims(work.claims);
    }
    const delta = this._delta.delta(work);
    const compressed = this._byte.compress(delta);
    this._window.push(work);
    if (this._window.length > this._windowSize) {
      this._window = this._window.slice(-this._windowSize);
    }
    this._packetsProcessed += 1;
    if (this.store) {
      const rawBytes = Buffer.byteLength(JSON.stringify(packetData));
      const compBytes = compressed.length;
      this.store.insertReceipt('mesh.compress', 'ok',
        `packet #${this._packetsProcessed}: ${rawBytes}B → ${compBytes}B`,
        { raw_bytes: rawBytes, compressed_bytes: compBytes, ratio: Number((rawBytes / Math.max(1, compBytes)).toFixed(2)) });
    }
    return compressed;
  }
  // -------------------------------------------------------------------------
  // prewarm(corpus) — hydrate internal codec state from a representative
  // sample BEFORE the first live packet. Closes the cold-start gap on:
  //   1. DeltaCompressor._last  — provides a populated delta baseline so the
  //      first live packet only transmits actually-changed fields.
  //   2. SemanticCompressor._factRegistry — pre-registers common claim
  //      (type,value) pairs so the first live packet emits {ref:id} stubs
  //      instead of full claim objects.
  //   3. The internal window — pre-fills so the slice tail is already at
  //      windowSize, keeping the steady-state branch hot from packet 1.
  // Idempotent: replaying the same corpus does not double-grow the registry
  // (semantic dedup naturally collapses repeats), and the delta baseline is
  // overwritten on every call rather than accumulated.
  // Telemetry suppressed: prewarm intentionally bypasses this.store so
  // training-data ingestion is not mistaken for live-traffic receipts.
  // Returns { packets, registry_size, baseline_keys } for callers that want it.
  // -------------------------------------------------------------------------
  prewarm(corpus) {
    if (!Array.isArray(corpus) || corpus.length === 0) {
      return { packets: 0, registry_size: this._semantic._factRegistry.size, baseline_keys: 0 };
    }
    const savedStore = this.store;
    this.store = null; // suppress receipt emission during prewarm
    try {
      // Reset volatile state so prewarm is idempotent (same corpus → same
      // post-state regardless of prior calls).
      this._delta = new DeltaCompressor();
      this._semantic = new SemanticCompressor();
      this._window = [];
      const startPackets = this._packetsProcessed;
      for (const packetData of corpus) {
        const work = { ...packetData };
        if (Array.isArray(work.claims)) {
          work.claims = this._semantic.compressClaims(work.claims);
        }
        this._delta.delta(work);
        this._window.push(work);
        if (this._window.length > this._windowSize) {
          this._window = this._window.slice(-this._windowSize);
        }
      }
      // _packetsProcessed counts LIVE packets only. Roll it back so
      // downstream counters stay honest.
      this._packetsProcessed = startPackets;
      return {
        packets: corpus.length,
        registry_size: this._semantic._factRegistry.size,
        baseline_keys: Object.keys(this._delta._last).length,
      };
    } finally {
      this.store = savedStore;
    }
  }
  decompressPacket(data, base = null) {
    const delta = this._byte.decompress(data);
    if (base) return this._delta.apply(base, delta);
    return delta;
  }
  stats() {
    return {
      packets: this._packetsProcessed,
      byte_compression: this._byte.stats(),
      semantic: this._semantic.stats(),
      delta: this._delta.stats(),
    };
  }
}
