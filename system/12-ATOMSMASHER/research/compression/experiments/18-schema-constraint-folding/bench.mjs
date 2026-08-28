// Experiment 18 — Schema-Derived Field Constraints (functional folding)
//
// Key insight from honest framing: the corpus has fields that are FUNCTIONS
// of other fields. The payload {"raw_bytes":X, "compressed_bytes":Y, "ratio":Z}
// has Z = X/Y *exactly* for every mesh.compress receipt. The summary often
// repeats parameters from the payload. The id is a hash of content + nonce.
//
// Strategy: identify functional dependencies; encode only the INDEPENDENT bits;
// derive the rest on decode.
//
// This is "folding" in the algebraic sense — collapsing redundant degrees of
// freedom that the schema enforces but the byte representation forgets.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const RECEIPT_FILE = path.join(ROOT, 'RECEIPT.json');
const RESULT_FILE = path.join(ROOT, 'RESULT.md');
const HYP = path.join(ROOT, 'HYPOTHESIS.md');

if (!fs.existsSync(HYP)) {
  fs.writeFileSync(HYP, `# Experiment 18 — Schema-Derived Field Constraints

## Hypothesis
The corpus has functional dependencies: fields whose values are determined by other fields.
- payload \`{"raw_bytes":X, "compressed_bytes":Y, "ratio":Z}\` has Z = X/Y *exactly*
- summary often contains a printable form of payload numerics
- ratio field in receipts is a function of the bytes fields

Encoding only the *independent* axes losslessly + deriving the rest on decode should give a real ratio improvement.

## Method
1. Per-payload-template, identify numeric fields that are deterministic functions of others
2. Verify the relationship holds across ALL receipts using that template
3. Strip the derived field; store only inputs
4. On decode, recompute the derived field

## Pass criterion
PASS if functional folding + brotli beats Experiment 07 plait baseline (18.05×).
`);
}

const corpusBytes = fs.readFileSync(CORPUS);
const corpusSha = crypto.createHash('sha256').update(corpusBytes).digest('hex');
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
console.log(`Loaded ${receipts.length} receipts, ${corpusBytes.length} B`);

// ─── Detect functional dependencies in mesh.compress payloads ───────────────
const meshRecs = receipts.filter(r => r.action === 'mesh.compress');
console.log(`\nmesh.compress receipts: ${meshRecs.length}`);

// Check: in mesh.compress payloads, is ratio = raw_bytes / compressed_bytes exactly?
let exactMatch = 0, total = 0;
for (const r of meshRecs) {
  try {
    const p = JSON.parse(r.payload_json);
    if (typeof p.raw_bytes === 'number' && typeof p.compressed_bytes === 'number' && typeof p.ratio === 'number') {
      total++;
      // The displayed ratio is rounded — check if it matches the displayed precision
      const computed = p.raw_bytes / p.compressed_bytes;
      const computedRounded = Number(computed.toFixed(2));
      if (Math.abs(computedRounded - p.ratio) < 0.001) exactMatch++;
    }
  } catch (e) {}
}
console.log(`  Receipts with (raw, comp, ratio) triples: ${total}`);
console.log(`  Where ratio == round(raw/comp, 2):         ${exactMatch} (${(exactMatch / total * 100).toFixed(1)}%)`);

// ─── Detect similar dependencies across all action types ────────────────────
// Group payloads by action; look for numeric fields where one is a deterministic
// function of the others (we check ratio-like relationships specifically).
function payloadShape(p) {
  if (p == null) return null;
  try {
    const obj = JSON.parse(p);
    if (typeof obj !== 'object' || obj === null) return null;
    const keys = Object.keys(obj).sort();
    const types = {};
    for (const k of keys) types[k] = typeof obj[k];
    return { keys, types };
  } catch { return null; }
}

const actionShapes = new Map(); // action → most-common payload shape
const shapeStats = new Map(); // action → count of receipts with each numeric-key
for (const r of receipts) {
  const shape = payloadShape(r.payload_json);
  if (!shape) continue;
  const sig = shape.keys.join(',');
  if (!actionShapes.has(r.action)) actionShapes.set(r.action, new Map());
  const m = actionShapes.get(r.action);
  m.set(sig, (m.get(sig) || 0) + 1);
}

// For each action, find the dominant payload shape
const actionDominant = new Map();
for (const [action, shapes] of actionShapes) {
  let best = null, bestCount = 0;
  for (const [sig, c] of shapes) if (c > bestCount) { best = sig; bestCount = c; }
  actionDominant.set(action, { sig: best, count: bestCount, total: [...shapes.values()].reduce((a,b)=>a+b, 0) });
}

// ─── For each (action, shape), detect functional dependencies ───────────────
function detectFunctionalDeps(receipts, action) {
  const dominant = actionDominant.get(action);
  if (!dominant) return null;
  const keys = dominant.sig.split(',');
  // Collect rows
  const rows = [];
  for (const r of receipts.filter(r => r.action === action)) {
    try {
      const p = JSON.parse(r.payload_json);
      if (p == null) continue;
      const row = {};
      let ok = true;
      for (const k of keys) {
        if (typeof p[k] !== 'number') { ok = false; break; }
        row[k] = p[k];
      }
      if (ok) rows.push(row);
    } catch {}
  }
  if (rows.length < 3) return null;
  // For each triple (a, b, c), test if c ≈ a/b OR c ≈ round(a/b, 2) OR c ≈ a-b OR c ≈ a+b
  const numericKeys = keys.filter(k => rows.every(r => typeof r[k] === 'number'));
  const deps = [];
  for (let i = 0; i < numericKeys.length; i++) {
    for (let j = 0; j < numericKeys.length; j++) {
      for (let k = 0; k < numericKeys.length; k++) {
        if (i === j || j === k || i === k) continue;
        const [A, B, C] = [numericKeys[i], numericKeys[j], numericKeys[k]];
        // Test C = round(A/B, 2)
        let match_div = true;
        for (const r of rows) {
          if (r[B] === 0) { match_div = false; break; }
          if (Math.abs(Number((r[A] / r[B]).toFixed(2)) - r[C]) > 0.001) { match_div = false; break; }
        }
        if (match_div) deps.push({ derived: C, formula: `round(${A}/${B}, 2)` });
      }
    }
  }
  return { action, total_receipts: rows.length, numeric_keys: numericKeys, functional_dependencies: deps };
}

console.log(`\nFunctional dependency scan across top action types:`);
const allDeps = [];
const topActions = [...actionShapes.entries()].map(([a, m]) => ({ a, c: [...m.values()].reduce((x,y)=>x+y, 0) })).sort((a,b) => b.c - a.c).slice(0, 15);
for (const { a: action, c } of topActions) {
  const d = detectFunctionalDeps(receipts, action);
  if (!d) continue;
  if (d.functional_dependencies.length > 0) {
    console.log(`  ${action.padEnd(28)} ${c.toString().padStart(5)} rec  → ${d.functional_dependencies.length} functional deps: ${d.functional_dependencies.map(x => `${x.derived}=${x.formula}`).join(', ')}`);
    allDeps.push(d);
  } else {
    console.log(`  ${action.padEnd(28)} ${c.toString().padStart(5)} rec  → no detected functional deps in ${d.numeric_keys.length} numeric keys`);
  }
}

// ─── Compute lossless savings ───────────────────────────────────────────────
// For each action with functional deps, count bytes saved by stripping derived fields.
let totalRawBytes = 0;
let totalFoldedBytes = 0;
function varint(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return Buffer.from(b); }
function readVarint(buf, ofs) { let n = 0, m = 1, b; do { b = buf[ofs++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return [n, ofs]; }
function writeStr(s) { const b = Buffer.from(s, 'utf8'); return [varint(b.length), b]; }

// Build the folded corpus: same receipts but payloads with derived fields removed
const depMap = new Map();
for (const d of allDeps) depMap.set(d.action, d.functional_dependencies);

let foldedReceipts = receipts.map(r => {
  if (!depMap.has(r.action)) return r;
  const deps = depMap.get(r.action);
  try {
    const p = JSON.parse(r.payload_json);
    if (p == null) return r;
    const derivedFields = new Set(deps.map(d => d.derived));
    const folded = {};
    for (const k of Object.keys(p)) {
      if (!derivedFields.has(k)) folded[k] = p[k];
    }
    return { ...r, payload_json: JSON.stringify(folded) };
  } catch {
    return r;
  }
});

// Encode folded receipts as JSONL + brotli
const foldedJsonl = foldedReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
const foldedBytes = Buffer.from(foldedJsonl, 'utf8');
const foldedBrotli = zlib.brotliCompressSync(foldedBytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });

// Also encode the dep recipe (small fixed cost)
const recipeParts = [varint(allDeps.length)];
for (const d of allDeps) {
  recipeParts.push(...writeStr(d.action));
  recipeParts.push(varint(d.functional_dependencies.length));
  for (const fd of d.functional_dependencies) {
    recipeParts.push(...writeStr(fd.derived));
    recipeParts.push(...writeStr(fd.formula));
  }
}
const recipeBuf = Buffer.concat(recipeParts);

const totalFolded = foldedBrotli.length + recipeBuf.length;
const foldedRatio = corpusBytes.length / totalFolded;
console.log(`\n=== Folded encoding ===`);
console.log(`  Folded JSONL bytes:    ${foldedBytes.length}`);
console.log(`  Folded + brotli q11:   ${foldedBrotli.length}`);
console.log(`  Dep recipe overhead:   ${recipeBuf.length}`);
console.log(`  Total lossless:        ${totalFolded}`);
console.log(`  Ratio vs raw corpus:   ${foldedRatio.toFixed(2)}x`);
console.log(`  vs plait baseline:     ${foldedRatio > 18.05 ? `BEATS by ${(foldedRatio - 18.05).toFixed(2)}x` : `BELOW by ${(18.05 - foldedRatio).toFixed(2)}x`}`);

// ─── Roundtrip via recipe: decode brotli → reconstruct derived fields ────────
const decoded = zlib.brotliDecompressSync(foldedBrotli).toString('utf8');
const reFolded = decoded.split('\n').filter(Boolean).map(l => JSON.parse(l));
// Read recipe (we'd encode + read it; for test we use depMap directly)
const reconstructed = reFolded.map(r => {
  if (!depMap.has(r.action)) return r;
  const deps = depMap.get(r.action);
  try {
    const p = JSON.parse(r.payload_json);
    if (p == null) return r;
    const reb = { ...p };
    for (const fd of deps) {
      // Parse formula: "round(A/B, 2)"
      const match = fd.formula.match(/round\(([^/]+)\/([^,]+),\s*(\d+)\)/);
      if (match) {
        const A = match[1].trim(), B = match[2].trim(), prec = Number(match[3]);
        if (typeof reb[A] === 'number' && typeof reb[B] === 'number' && reb[B] !== 0) {
          reb[fd.derived] = Number((reb[A] / reb[B]).toFixed(prec));
        }
      }
    }
    // Need to preserve original key order — re-emit in original payload field order
    // The original had keys sorted as in source; canonical-corpus.jsonl preserves field order from SQL select
    // For exact byte match, we need the original key order. We don't have it post-fold.
    return { ...r, payload_json: JSON.stringify(reb) };
  } catch {
    return r;
  }
});

const recJsonl = reconstructed.map(r => JSON.stringify(r)).join('\n') + '\n';
const recSha = crypto.createHash('sha256').update(recJsonl).digest('hex');
const roundtripOk = recSha === corpusSha;
console.log(`  Roundtrip: ${roundtripOk ? '✓ BYTE-EXACT' : '✗ MISMATCH (likely key-order loss in payload JSON)'}`);

if (!roundtripOk) {
  const orig = corpusBytes.toString('utf8');
  const minLen = Math.min(orig.length, recJsonl.length);
  for (let i = 0; i < minLen; i++) {
    if (orig[i] !== recJsonl[i]) {
      console.log(`  First diff at byte ${i}:`);
      console.log(`    orig: ...${orig.slice(Math.max(0, i-60), i+60)}...`);
      console.log(`    dec:  ...${recJsonl.slice(Math.max(0, i-60), i+60)}...`);
      break;
    }
  }
}

const receipt = {
  experiment: '18-schema-constraint-folding',
  generated_at: new Date().toISOString(),
  corpus_sha256_in: corpusSha,
  corpus_bytes_in: corpusBytes.length,
  mesh_compress_ratio_check: { total, exact_match: exactMatch, percentage: Number((exactMatch / total * 100).toFixed(1)) },
  functional_deps_found: allDeps,
  folded_jsonl_bytes: foldedBytes.length,
  folded_brotli_bytes: foldedBrotli.length,
  recipe_overhead_bytes: recipeBuf.length,
  total_lossless_bytes: totalFolded,
  ratio: Number(foldedRatio.toFixed(2)),
  roundtrip_lossless: roundtripOk,
  beats_plait: foldedRatio > 18.05,
  pass: roundtripOk && foldedRatio > 18.05,
};
fs.writeFileSync(RECEIPT_FILE, JSON.stringify(receipt, null, 2));

const resultMd = `# Experiment 18 — Schema-Derived Field Constraints — RESULT

**Status:** ${receipt.pass ? '✅ PASS' : roundtripOk ? '⚠️ measured' : '❌ key-order roundtrip issue'}
**Generated:** ${receipt.generated_at}

## Functional dependency detection

### mesh.compress ratio = round(raw_bytes/compressed_bytes, 2)?

| Metric | Value |
|---|---|
| mesh.compress receipts | ${total.toLocaleString()} |
| Where ratio matches exactly | ${exactMatch.toLocaleString()} (${(exactMatch / total * 100).toFixed(1)}%) |

### All functional dependencies found

${allDeps.length === 0 ? '*No exact functional dependencies detected across the top 15 action types.*' : allDeps.map(d => `- **${d.action}** (${d.total_receipts} receipts): ${d.functional_dependencies.map(fd => `\`${fd.derived} = ${fd.formula}\``).join(', ')}`).join('\n')}

## Compression measurement

| Metric | Value |
|---|---|
| Raw corpus | ${corpusBytes.length.toLocaleString()} B |
| Folded JSONL (derived fields stripped) | ${foldedBytes.length.toLocaleString()} B |
| Folded + Brotli q11 | ${foldedBrotli.length.toLocaleString()} B |
| Dep recipe overhead | ${recipeBuf.length.toLocaleString()} B |
| **Total lossless** | **${totalFolded.toLocaleString()} B** |
| **Compression ratio** | **${foldedRatio.toFixed(2)}×** |
| Roundtrip lossless | ${roundtripOk ? '✓ sha256 match' : '✗ MISMATCH'} |

## Analysis

${allDeps.length === 0 ?
  `No exact functional dependencies were detected across the top 15 action types. This suggests the receipt payloads, while structurally similar within each action, have *independent* numeric values across fields — ratios are computed and stored but may have rounding that breaks exact-derive verification, or the corpus has no perfect functional dependencies.` :
  `Found ${allDeps.length} action types with ${allDeps.flatMap(d => d.functional_dependencies).length} total functional dependencies. Notable: ${allDeps[0]?.action} has \`${allDeps[0]?.functional_dependencies[0]?.derived} = ${allDeps[0]?.functional_dependencies[0]?.formula}\` across all ${allDeps[0]?.total_receipts} receipts of that type.`}

${roundtripOk ? '' : `**Roundtrip failed.** The most likely cause: when reconstructing the payload JSON, JavaScript's \`JSON.stringify\` preserves insertion order, but the FOLDED payload doesn't have the derived field in its original position. To make this lossless we'd need to store the original key order per payload-template (small overhead, fixable).`}

## Honest finding

${foldedRatio > 18.05 ?
  `Schema-constraint folding **${roundtripOk ? 'BEATS' : 'would beat (modulo key-order fix)'}** the plait baseline. The corpus has algorithmic redundancy that no byte-level compressor exploits.` :
  `Schema-constraint folding at ${foldedRatio.toFixed(2)}× ${foldedRatio > 18.05 ? 'beats' : 'is below'} plait baseline. The detected functional dependencies were ${allDeps.length === 0 ? 'rare' : 'present but limited in byte-impact'}.`}

## Reproduction

\`\`\`
bun 12-ATOMSMASHER/research/compression/experiments/18-schema-constraint-folding/bench.mjs
\`\`\`
`;
fs.writeFileSync(RESULT_FILE, resultMd);
console.log(`\nResult: ${RESULT_FILE}`);
