// AtomSmasher Full-Scope — package entry
// Re-exports the canonical engine surface for callers within Orange5.
//
// import { Store, FeatureExecutor, CLCEngine, MeshStreamCompressor, FEATURE_NAMES } from './12-ATOMSMASHER/full-scope/index.mjs';

export { Store, classifyFeature } from './storage.mjs';
export {
  OrderSpine, SourceEngine, CommitmentCodec, EquationMemory, CacheEngine,
  RoutingEngine, SavedWork, MemoryImmuneSystem, AgentGovernor, LocalProofLab,
  FeatureExecutor, TotalWorkCompiler, demo, uniqueRuntimeId,
} from './engines.mjs';
export { FEATURE_NAMES } from './feature_data.mjs';
export {
  sha256Text, nowIso, slugify, tokenEstimate, normalize, keywords, cosineLike,
  splitChunks, jdump, canonicalJson,
} from './utils.mjs';
export { VERSION, CODENAME, SCHEMA_VERSION, SYSTEM_LAW } from './version.mjs';

// === Real-things-from-AeoNs ports (2026-06-25) — wired alongside the canonical engine ===

// Production CLC engine (regex POC from AeoNs/extracted/atomeons/memory/clc_engine.py)
// Patent ATOM-CLC-2026-0331. NOT the v1 research doctor (that's `clc.mjs`).
// NOT the v3 spec (that's SKILL.md only). This is the working POC.
export {
  CLCEngine as CLCEngineV1POC,  // disambiguated name; "CLCEngine" without suffix lives in engagements.mjs
  CrystalLattice,
  LatticeEntity,
  LatticeThread,
  VoidEntry as CLCVoidEntry,
  EntityType as CLCEntityType,
  CLC_IDENTIFIER,
  CLC_DISCLOSURE_SHA256,
} from './clc-engine.mjs';

// Mesh compression — the REAL GlyphSpeak code (zlib + delta + dedup, NOT Sigil/TB glyphs).
// Faithful port of AeoNs/extracted/atomeons/glyphspeak/compression.py.
export {
  PacketCompressor,
  DeltaCompressor,
  SemanticCompressor as MeshSemanticCompressor,
  MeshVoidMapCompressor,
  MeshStreamCompressor,
} from './mesh-compression.mjs';

// === Wave 2 real-things ports (2026-06-25) ===

// PRODUCTION Crystal Lattice Compression (1,134 LOC port of core/crystal_compression.py).
// Three layers: Lattice (entities/facts/decisions/relationships) + Void (boundaries/
// rejections/tone/fill levels) + Delta (per-interaction novel info).
// Includes the RESONANCE RECONSTRUCTION LOOP (RRL): multi-pass extract → reconstruct
// → diff → extract again. Co-occurrence matrices boost recall.
// Per source: "20-50x semantic compression typical on real-world conversations."
// NOT the v1 doctor, NOT the regex POC — this is the deep one.
export {
  CrystalCompressor,
  Lattice,
  VoidMap,
  ResonanceExtractor,
  Entity as CrystalEntity,
  Relationship as CrystalRelationship,
  Fact as CrystalFact,
  Decision as CrystalDecision,
  Boundary as CrystalBoundary,
  Rejection as CrystalRejection,
  ToneMarker as CrystalToneMarker,
  Delta as CrystalDelta,
} from './crystal-compression.mjs';

// 27-Guardrails wellbeing constitution (372 LOC port of covenant/wellbeing.py).
// THE constitutional law layer the CLAUDE.md treats as immutable. Closes the
// 27-guardrails daemon "missing" finding — the file exists here now, daemon-visible.
// Enforces: G4 anti-metric block, G6 proactive limit, G7 interruption cooldown,
// G9 high-uncertainty answers, G14 deep-focus protection, G15 recovery respect,
// G18 session-length real-world bias. Plus G19 inspectability + G22 consequence display.
export {
  WellbeingMonitor,
  GuardrailViolation,
  GuardrailCategory,
  InteractionProfile,
  MemoryInspector,
  ConsequenceDisplay,
  ANTI_METRICS,
  PRO_METRICS,
  CONSTITUTION_VERSION as WELLBEING_VERSION,
} from './wellbeing-guardrails.mjs';
