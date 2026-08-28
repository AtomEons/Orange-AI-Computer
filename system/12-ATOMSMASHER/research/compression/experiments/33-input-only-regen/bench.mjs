// Experiment 33 — Input-Only Regeneration (the KTR-style ceiling)
//
// Hypothesis: the corpus is the audit log of ONE organism.run. Most receipts
// (air.compress × 3,126; mesh.compress × 1,565; cache.hit/miss × 138; etc.)
// are DETERMINISTIC OUTPUTS of upstream pipeline operations, not independent
// data. If the decoder has the organism code AND we transmit only the true
// INPUT receipts (feature.execute, source.ingest, organism.run, etc.), then
// the decoder can REGENERATE all derived receipts.
//
// This measures the KTR ceiling: how small can the "essential information"
// of the corpus be, treating all derivable receipts as free?

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const RECEIPT_FILE = path.join(ROOT, 'RECEIPT.json');

const corpusBytes = fs.readFileSync(CORPUS);
const corpusSha = crypto.createHash('sha256').update(corpusBytes).digest('hex');
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
console.log(`Corpus: ${corpusBytes.length} B, ${receipts.length} receipts`);

function brotli11(b) {
  return zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
}

// Classify each action as INPUT (must transmit) or DERIVED (regeneratable from inputs + organism code)
const DERIVED_ACTIONS = new Set([
  // Pipeline outputs of compression stages
  'air.compress', 'mesh.compress', 'cache.hit', 'cache.miss', 'prefix.canonicalize',
  'embedding.probe', 'crystal.ingest', 'clc.ingest', 'air.decompress', 'pathwave.compress',
  // Probes/scans triggered by features
  'prooflab.probes', 'thermo.tick', 'awareness.snapshot', 'awareness.causal_trace',
  'immune.scan', 'canon.detect', 'pattern.detect', 'canon.phase_transition',
  'thermo.entropy', 'mode.evidence_ladder', 'mode.enter', 'memory.scope_probe',
  // Routing / agent selection (deterministic given context)
  'route.select', 'agent.lease',
  // Organism stage receipts (one each, deterministic from configuration)
  'crystal.receipt_sweep', 'clc.organism_stage', 'workset.organism_stage',
  'db.compression_landscape', 'schema.optimal_encoding', 'air.receipt_sweep',
  'primitive.cool', 'dictionary.handoff', 'wellbeing.organism_stage',
  'expansion_warrant.organism_stage', 'crystal.organism_stage',
  'primitive.pin', 'mesh.organism_stage', 'primitive.commit', 'primitive.retire',
  'pipeline.air_then_mesh', 'feature.run_all', 'pipeline.recursive_pass_b',
  // Order/canon/memory lifecycle (deterministic from rules)
  'order.add', 'canon.detect', 'memory.lifecycle', 'debt.record', 'cartridge.build',
  'pathwave.rejected',
  // Source ingestion is borderline — for now treat as input since it carries text
]);

const INPUT_ACTIONS = new Set([
  // True inputs: the things that DRIVE pipeline execution
  'organism.run',     // single top-level invocation
  'feature.execute',  // each feature being run
  'source.ingest',    // source documents being ingested
  'source.search',    // queries
  'workset.build',    // worksets being built
  'equation.fit',     // equations to fit
]);

const inputRecs = [];
const derivedRecs = [];
const ambiguous = [];
for (const r of receipts) {
  if (INPUT_ACTIONS.has(r.action)) inputRecs.push(r);
  else if (DERIVED_ACTIONS.has(r.action)) derivedRecs.push(r);
  else ambiguous.push(r);
}
console.log(`\nClassification:`);
console.log(`  INPUT receipts:    ${inputRecs.length} (${inputRecs.reduce((s, r) => s + JSON.stringify(r).length + 1, 0)} B raw)`);
console.log(`  DERIVED receipts:  ${derivedRecs.length} (${derivedRecs.reduce((s, r) => s + JSON.stringify(r).length + 1, 0)} B raw)`);
console.log(`  AMBIGUOUS:         ${ambiguous.length}`);
const ambActions = new Map();
for (const r of ambiguous) ambActions.set(r.action, (ambActions.get(r.action) || 0) + 1);
console.log(`  Ambiguous actions: ${[...ambActions.entries()].map(([a, c]) => `${a}×${c}`).join(', ')}`);

// Treat ambiguous as INPUT (safer — overestimates the transmitted size)
const allInputs = [...inputRecs, ...ambiguous];

// ── Method A: Brotli the INPUT receipts only ───────────────────────────────
const inputJsonl = allInputs.map(r => JSON.stringify(r)).join('\n') + '\n';
const inputBytes = Buffer.from(inputJsonl, 'utf8');
const inputBrotli = brotli11(inputBytes);
console.log(`\nINPUT receipts: ${inputBytes.length} B raw → ${inputBrotli.length} B brotli (${(inputBytes.length / inputBrotli.length).toFixed(2)}x)`);

// Plus: organism code hash + seed for IDs + any non-deterministic seeds
const protocolHeader = Buffer.from(JSON.stringify({
  organism_version: 'orange5-bun-as2-v1',
  seed: 'orange5-receipt-stream-v1',
  n_receipts: receipts.length,
  derived_ratio: derivedRecs.length / receipts.length,
}), 'utf8');
const headerBrotli = brotli11(protocolHeader);
console.log(`Protocol header: ${protocolHeader.length} B → ${headerBrotli.length} B brotli`);

const totalKTR = inputBrotli.length + headerBrotli.length;
const ktrRatio = corpusBytes.length / totalKTR;
console.log(`\n=== KTR-style total (input-only transmission, decoder has organism) ===`);
console.log(`Input brotli + header:           ${totalKTR.toString().padStart(8)} B`);
console.log(`Original corpus:                 ${corpusBytes.length.toString().padStart(8)} B`);
console.log(`Compression ratio:               ${ktrRatio.toFixed(2)}x`);
console.log(``);
console.log(`vs Exp 31 (det-ID regen 31.39x): ${ktrRatio > 31.39 ? `BEATS by +${(ktrRatio-31.39).toFixed(2)}x` : `below by ${(31.39-ktrRatio).toFixed(2)}x`}`);
console.log(`vs Exp 21 (two-stream 17.99x):   ${ktrRatio > 17.99 ? `BEATS by +${(ktrRatio-17.99).toFixed(2)}x` : `below by ${(17.99-ktrRatio).toFixed(2)}x`}`);

// ── Method B: Even more aggressive — JUST organism.run + tiny seed ─────────
// The organism.run receipt's payload contains a complete state snapshot.
// In principle, if the decoder has the organism, the organism.run payload
// alone is enough to RECONSTRUCT what happened.
const orgRunOnly = receipts.filter(r => r.action === 'organism.run');
const orgRunJsonl = orgRunOnly.map(r => JSON.stringify(r)).join('\n') + '\n';
const orgRunBytes = Buffer.from(orgRunJsonl, 'utf8');
const orgRunBrotli = brotli11(orgRunBytes);
console.log(`\n=== Method B: organism.run ONLY (most aggressive Kolmogorov) ===`);
console.log(`organism.run: ${orgRunBytes.length} B raw → ${orgRunBrotli.length} B brotli`);
console.log(`Organism.run + seed + header:    ${(orgRunBrotli.length + headerBrotli.length).toString().padStart(8)} B`);
console.log(`Compression ratio:               ${(corpusBytes.length / (orgRunBrotli.length + headerBrotli.length)).toFixed(2)}x`);
console.log(``);
console.log(`HONESTY: this only counts IF the organism deterministically regenerates`);
console.log(`every other receipt from this one snapshot. NOT VERIFIED — requires running organism.`);

// ── Method C: Hybrid — input receipts + DERIVED receipts that we can't recompute ──
// Some "derived" receipts might have content brotli can compress massively because
// they're truly templates with only numeric variation. Let's see what compressing
// JUST the derived receipts costs (i.e., the upper bound of "what brotli alone gets").
const derivedJsonl = derivedRecs.map(r => JSON.stringify(r)).join('\n') + '\n';
const derivedBytes = Buffer.from(derivedJsonl, 'utf8');
const derivedBrotli = brotli11(derivedBytes);
console.log(`\n=== Method C reference: derived receipts brotli'd alone ===`);
console.log(`Derived receipts: ${derivedBytes.length} B raw → ${derivedBrotli.length} B brotli (${(derivedBytes.length / derivedBrotli.length).toFixed(2)}x)`);
console.log(`This is what we SAVE if the decoder regenerates them.`);
console.log(`Total saved by regen:              ${derivedBrotli.length} B`);
console.log(``);
console.log(`Inputs + organism-side-regen-stub: ${(inputBrotli.length + headerBrotli.length)} B`);
console.log(`Same with derived re-included:     ${(inputBrotli.length + headerBrotli.length + derivedBrotli.length)} B`);
console.log(`Original corpus brotli alone:      ${zlib.brotliCompressSync(corpusBytes, {params:{[zlib.constants.BROTLI_PARAM_QUALITY]:11}}).length} B`);

const receipt = {
  experiment: '33-input-only-regen',
  generated_at: new Date().toISOString(),
  corpus_sha256_in: corpusSha,
  input_actions: [...INPUT_ACTIONS],
  derived_actions: [...DERIVED_ACTIONS],
  classification: {
    input_count: inputRecs.length,
    derived_count: derivedRecs.length,
    ambiguous_count: ambiguous.length,
  },
  method_a_input_only_brotli: inputBrotli.length,
  method_a_header_brotli: headerBrotli.length,
  method_a_total: totalKTR,
  method_a_ratio: Number(ktrRatio.toFixed(2)),
  method_b_organism_run_only_brotli: orgRunBrotli.length,
  method_b_total: orgRunBrotli.length + headerBrotli.length,
  method_b_ratio: Number((corpusBytes.length / (orgRunBrotli.length + headerBrotli.length)).toFixed(2)),
  method_c_derived_brotli_alone: derivedBrotli.length,
  caveat: 'Methods A and B require the decoder to have the organism code AND to be able to deterministically regenerate the derived receipts. NOT byte-exact lossless verified via roundtrip in this experiment — measures the THEORETICAL ceiling under that assumption.',
};
fs.writeFileSync(RECEIPT_FILE, JSON.stringify(receipt, null, 2));
console.log(`\nReceipt: ${RECEIPT_FILE}`);
