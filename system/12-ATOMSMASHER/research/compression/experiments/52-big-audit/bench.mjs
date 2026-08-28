// Experiment 52 — Big Audit: systematic empirical search for hidden derivations
//
// For every (action, payload_key) pair: profile values, find functional deps,
// match hashes against corpus content, identify low-cardinality/constant fields.
// Goal: find new derivation predicates we can add to the codec.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const RECEIPT_FILE = path.join(ROOT, 'RECEIPT.json');

const corpusBytes = fs.readFileSync(CORPUS);
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
const N = receipts.length;
console.log(`Corpus: ${N} receipts, ${corpusBytes.length} B\n`);

// ════════════════════════════════════════════════════════════════════
// AUDIT A: Per-(action, payload_key) value distribution
// ════════════════════════════════════════════════════════════════════

const akv = new Map(); // "action|key" → Map(jsonValue → count)
const akr = new Map(); // "action|key" → list of receipts containing this key
for (let i = 0; i < N; i++) {
  const r = receipts[i];
  if (r.payload_json == null) continue;
  let p;
  try { p = JSON.parse(r.payload_json); } catch { continue; }
  if (p == null || typeof p !== 'object' || Array.isArray(p)) continue;
  for (const [k, v] of Object.entries(p)) {
    const key = `${r.action}|${k}`;
    if (!akv.has(key)) { akv.set(key, new Map()); akr.set(key, []); }
    akv.get(key).set(JSON.stringify(v), (akv.get(key).get(JSON.stringify(v)) || 0) + 1);
    akr.get(key).push(i);
  }
}

const akvStats = [];
for (const [key, valMap] of akv) {
  const occ = [...valMap.values()].reduce((a, b) => a + b, 0);
  const unique = valMap.size;
  const isConstant = unique === 1;
  const top = [...valMap.entries()].sort((a, b) => b[1] - a[1])[0];
  const topFrac = top[1] / occ;
  akvStats.push({ key, occ, unique, isConstant, topVal: top[0].slice(0, 60), topFrac });
}
akvStats.sort((a, b) => b.occ - a.occ);

console.log(`=== A1: (action, key) pairs by occurrence ===`);
console.log(`Total pairs: ${akv.size}`);
console.log(`Constants (1 distinct value): ${akvStats.filter(s => s.isConstant).length}`);
console.log(`Low-cardinality (≤8 distinct): ${akvStats.filter(s => s.unique <= 8).length}`);
console.log(`Top-value-≥90% dominance: ${akvStats.filter(s => s.topFrac >= 0.9).length}`);

console.log(`\nTop 15 BY OCCURRENCE × unique-FRACTION (where unique varies but pattern dominant):`);
const dominantNonConst = akvStats.filter(s => !s.isConstant && s.topFrac >= 0.85).sort((a, b) => b.occ * b.topFrac - a.occ * a.topFrac);
for (const s of dominantNonConst.slice(0, 15)) {
  console.log(`  ${s.key.padEnd(45)} occ=${s.occ.toString().padStart(5)} unique=${s.unique.toString().padStart(4)} topFrac=${(s.topFrac*100).toFixed(1)}% top=${s.topVal}`);
}

// ════════════════════════════════════════════════════════════════════
// AUDIT B: Sha256 hash-field origin identification
// ════════════════════════════════════════════════════════════════════
console.log(`\n=== B: Hash-field origin identification ===`);

// Find all 64-char-hex fields in the corpus (potential sha256)
const HASH_RE = /[0-9a-f]{64}/g;
const HASH_RE_16 = /\b[0-9a-f]{16}\b/g;
const hashOccs = new Map(); // hash → list of receipts containing it
for (let i = 0; i < N; i++) {
  const text = JSON.stringify(receipts[i]);
  const matches = text.match(HASH_RE) || [];
  for (const h of matches) {
    if (!hashOccs.has(h)) hashOccs.set(h, []);
    hashOccs.get(h).push(i);
  }
}
console.log(`Distinct 64-hex strings (potential sha256): ${hashOccs.size}`);

// For each hash, try to find what content produces it
// Candidates to hash: payload_json, summary, payload_json sub-fields, etc.
function trySha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

// Build a content pool to test against
const contentPool = [];
for (let i = 0; i < N; i++) {
  const r = receipts[i];
  if (r.payload_json) contentPool.push({ src: `payload_json@${i}`, content: r.payload_json });
  if (r.summary) contentPool.push({ src: `summary@${i}`, content: r.summary });
}

// For first 200 distinct hashes, try to find origin
const hashList = [...hashOccs.keys()].slice(0, 200);
let hashesIdentified = 0;
const identifiedRules = [];
for (const h of hashList) {
  for (const c of contentPool) {
    if (trySha256(c.content) === h) {
      hashesIdentified++;
      identifiedRules.push({ hash: h, occurrences: hashOccs.get(h).length, derivedFrom: c.src });
      break;
    }
  }
}
console.log(`Sha256 hashes with identified origin (first 200 tested): ${hashesIdentified} / 200`);
if (identifiedRules.length > 0) {
  console.log(`Top 5 derived hash rules by occurrence:`);
  identifiedRules.sort((a, b) => b.occurrences - a.occurrences);
  for (const r of identifiedRules.slice(0, 5)) {
    console.log(`  hash=${r.hash.slice(0, 16)}... occ=${r.occurrences} derived_from=${r.derivedFrom}`);
  }
}

// ════════════════════════════════════════════════════════════════════
// AUDIT C: Receipt-pair derivation (action_i → action_{i+1})
// ════════════════════════════════════════════════════════════════════
console.log(`\n=== C: Receipt-pair derivation patterns ===`);

const pairCounts = new Map();
for (let i = 1; i < N; i++) {
  const key = `${receipts[i-1].action}→${receipts[i].action}`;
  pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
}
const pairsSorted = [...pairCounts.entries()].sort((a, b) => b[1] - a[1]);
console.log(`Distinct (prev→cur) action pairs: ${pairCounts.size}`);
console.log(`Top 15 most-common action pairs:`);
for (const [pair, count] of pairsSorted.slice(0, 15)) {
  console.log(`  ${pair.padEnd(50)} ${count}`);
}

// Check: which pairs have 100% same shape? (cur is deterministic from prev's action position)
const deterministicNext = new Map(); // prev_action → cur_action (if 100%)
const prevToNexts = new Map();
for (let i = 1; i < N; i++) {
  const prev = receipts[i-1].action;
  const cur = receipts[i].action;
  if (!prevToNexts.has(prev)) prevToNexts.set(prev, new Map());
  prevToNexts.get(prev).set(cur, (prevToNexts.get(prev).get(cur) || 0) + 1);
}
let actionsWithDetNext = 0;
const detSuccessors = [];
for (const [prev, nextMap] of prevToNexts) {
  const total = [...nextMap.values()].reduce((a, b) => a + b, 0);
  const top = [...nextMap.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top[1] === total && total >= 10) {
    actionsWithDetNext++;
    detSuccessors.push({ prev, next: top[0], count: total });
  }
}
console.log(`Actions where NEXT-action is deterministic (≥10 occurrences): ${actionsWithDetNext}`);
if (detSuccessors.length > 0) {
  console.log(`Top deterministic-next pairs:`);
  detSuccessors.sort((a, b) => b.count - a.count).slice(0, 8).forEach(d =>
    console.log(`  ${d.prev} → always ${d.next} (n=${d.count})`));
}

// ════════════════════════════════════════════════════════════════════
// AUDIT D: Field-name token frequency (for token-replacement codec)
// ════════════════════════════════════════════════════════════════════
console.log(`\n=== D: JSON field-name token frequencies ===`);
const fieldNameCounts = new Map();
for (const r of receipts) {
  if (r.payload_json == null) continue;
  try {
    const p = JSON.parse(r.payload_json);
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      function walk(obj) {
        if (obj == null || typeof obj !== 'object') return;
        if (Array.isArray(obj)) { for (const x of obj) walk(x); return; }
        for (const k of Object.keys(obj)) {
          fieldNameCounts.set(k, (fieldNameCounts.get(k) || 0) + 1);
          walk(obj[k]);
        }
      }
      walk(p);
    }
  } catch {}
}
const topFields = [...fieldNameCounts.entries()].sort((a, b) => b[1] - a[1]);
console.log(`Distinct payload field names (recursive): ${fieldNameCounts.size}`);
console.log(`Top 20 by occurrence count:`);
for (const [k, c] of topFields.slice(0, 20)) {
  console.log(`  ${k.padEnd(35)} ${c.toString().padStart(6)} occurrences`);
}

// Estimate bytes saved by token-encoding the top 100 field names
let topFieldsBytes = 0;
for (const [k, c] of topFields.slice(0, 100)) topFieldsBytes += (k.length + 3) * c; // include quotes + colon
console.log(`Total raw bytes in field names (top 100): ${topFieldsBytes.toLocaleString()}`);
console.log(`If token-encoded as 1-2 byte tokens: would save ~${(topFieldsBytes * 0.7).toFixed(0)} bytes raw`);

// ════════════════════════════════════════════════════════════════════
// AUDIT E: Created_at delta structure
// ════════════════════════════════════════════════════════════════════
console.log(`\n=== E: Created_at temporal structure ===`);
const cas = receipts.map(r => r.created_at);
const distinctCAs = [...new Set(cas)];
console.log(`Distinct created_at values: ${distinctCAs.length}`);
const caTimes = distinctCAs.map(t => new Date(t).getTime() / 1000);
caTimes.sort((a, b) => a - b);
const caRange = caTimes[caTimes.length - 1] - caTimes[0];
console.log(`Time span: ${caRange.toFixed(0)} seconds = ${(caRange/60).toFixed(1)} minutes`);
const deltas = [];
for (let i = 1; i < caTimes.length; i++) deltas.push(caTimes[i] - caTimes[i-1]);
console.log(`Consecutive deltas: min=${Math.min(...deltas)}s, max=${Math.max(...deltas)}s, mean=${(deltas.reduce((a,b)=>a+b,0)/deltas.length).toFixed(2)}s`);

// ════════════════════════════════════════════════════════════════════
// AUDIT F: Numeric value distributions per series
// ════════════════════════════════════════════════════════════════════
console.log(`\n=== F: Numeric series distributions (looking for hidden constants/periodicity) ===`);
const NUM_RE = /-?\d+(?:\.\d+)?/g;
const numSeries = new Map(); // "action|key|valueIdx" → list of values
for (const r of receipts) {
  if (r.payload_json == null) continue;
  try {
    const p = JSON.parse(r.payload_json);
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      for (const [k, v] of Object.entries(p)) {
        if (typeof v === 'number') {
          const key = `${r.action}|${k}`;
          if (!numSeries.has(key)) numSeries.set(key, []);
          numSeries.get(key).push(v);
        }
      }
    }
  } catch {}
}
console.log(`Total numeric series: ${numSeries.size}`);
// Find series that are 99% constant
let constSeries = 0, derivableSeries = 0;
const hiddenConsts = [];
for (const [key, vals] of numSeries) {
  const unique = new Set(vals);
  if (unique.size === 1) {
    constSeries++;
    hiddenConsts.push({ key, val: vals[0], count: vals.length });
  }
}
hiddenConsts.sort((a, b) => b.count - a.count);
console.log(`Truly constant numeric series: ${constSeries}`);
console.log(`Top 15 numeric constants (action|key, value, count):`);
for (const c of hiddenConsts.slice(0, 15)) {
  console.log(`  ${c.key.padEnd(40)} = ${JSON.stringify(c.val).padEnd(10)} (n=${c.count})`);
}

// Compute byte impact of stripping these constants from payloads
let constNumericRawBytes = 0;
for (const c of hiddenConsts) {
  // "key":VAL, → 1 + key.length + 1 + JSON.stringify(val).length + 1 ≈ key.length + JSON.stringify(val).length + 4
  const k = c.key.split('|')[1];
  constNumericRawBytes += (k.length + JSON.stringify(c.val).length + 4) * c.count;
}
console.log(`Total raw bytes that could be eliminated by constant-stripping ALL numeric constants: ${constNumericRawBytes.toLocaleString()}`);

// ════════════════════════════════════════════════════════════════════
// AUDIT G: Cross-receipt content sharing
// ════════════════════════════════════════════════════════════════════
console.log(`\n=== G: Cross-receipt content sharing analysis ===`);
// Find substrings of length 30+ that appear in 50+ DIFFERENT receipts
const substrInReceipts = new Map();
const MIN_SUBSTR_LEN = 50;
const STEP = 20;
for (let i = 0; i < N; i++) {
  const text = JSON.stringify(receipts[i]);
  const seen = new Set();
  for (let off = 0; off + MIN_SUBSTR_LEN <= text.length; off += STEP) {
    const sub = text.slice(off, off + MIN_SUBSTR_LEN);
    if (seen.has(sub)) continue;
    seen.add(sub);
    if (!substrInReceipts.has(sub)) substrInReceipts.set(sub, new Set());
    substrInReceipts.get(sub).add(i);
  }
}
const popularSubstrs = [...substrInReceipts.entries()].filter(([s, set]) => set.size >= 100).sort((a, b) => b[1].size - a[1].size);
console.log(`Distinct ${MIN_SUBSTR_LEN}-char substrings appearing in ≥100 receipts: ${popularSubstrs.length}`);
console.log(`Top 5 most-frequent substrings:`);
for (const [sub, recvSet] of popularSubstrs.slice(0, 5)) {
  console.log(`  in ${recvSet.size} receipts: "${sub.slice(0, 60)}..."`);
}

// ════════════════════════════════════════════════════════════════════
// AUDIT H: organism.run aggregate vs sum of individuals
// ════════════════════════════════════════════════════════════════════
console.log(`\n=== H: organism.run aggregate consistency ===`);
const orgRun = receipts.find(r => r.action === 'organism.run');
if (orgRun) {
  const stages = JSON.parse(orgRun.payload_json).stages || {};
  // Check mesh_full_sweep raw/comp/ratio against sum of mesh.compress
  const meshRecs = receipts.filter(r => r.action === 'mesh.compress');
  let meshRawSum = 0, meshCompSum = 0;
  for (const m of meshRecs) {
    try { const p = JSON.parse(m.payload_json); meshRawSum += p.raw_bytes; meshCompSum += p.compressed_bytes; } catch {}
  }
  const mfs = stages.mesh_full_sweep || {};
  console.log(`mesh.compress sum: raw=${meshRawSum}, comp=${meshCompSum}`);
  console.log(`organism.run.stages.mesh_full_sweep: raw_bytes=${mfs.raw_bytes}, comp_bytes=${mfs.compressed_bytes}, packets=${mfs.packets}`);
  console.log(`Match raw: ${meshRawSum === mfs.raw_bytes}`);
  console.log(`Match comp: ${meshCompSum === mfs.compressed_bytes}`);
  console.log(`Match count: ${meshRecs.length === mfs.packets}`);
  if (meshRawSum === mfs.raw_bytes && meshCompSum === mfs.compressed_bytes) {
    console.log(`  → DERIVABLE: any 1 mesh.compress receipt's (raw, comp) can be derived from the total minus all others'`);
  }
} else {
  console.log(`No organism.run receipt found`);
}

// ════════════════════════════════════════════════════════════════════
// AUDIT I: Functional dependency search across fields (within payload)
// ════════════════════════════════════════════════════════════════════
console.log(`\n=== I: Cross-field functional dependency search ===`);

// For each action with ≥10 receipts, check pairs of numeric fields for ratio/sum/product relationships
const actionRecMap = new Map();
for (const r of receipts) {
  if (!actionRecMap.has(r.action)) actionRecMap.set(r.action, []);
  actionRecMap.get(r.action).push(r);
}
let fdsFound = 0;
const fdRules = [];
for (const [action, recs] of actionRecMap) {
  if (recs.length < 10) continue;
  // Parse payloads, find numeric fields
  const numFields = new Map();
  for (const r of recs) {
    if (!r.payload_json) continue;
    try {
      const p = JSON.parse(r.payload_json);
      if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
      for (const [k, v] of Object.entries(p)) {
        if (typeof v === 'number') {
          if (!numFields.has(k)) numFields.set(k, []);
          numFields.get(k).push(v);
        }
      }
    } catch {}
  }
  if (numFields.size < 2) continue;
  // Try pairwise: is field X = floor(A/B), round(A/B, 2), A-B, A*B, etc.
  const fieldNames = [...numFields.keys()];
  for (let i = 0; i < fieldNames.length; i++) {
    for (let j = 0; j < fieldNames.length; j++) {
      if (i === j) continue;
      const X = numFields.get(fieldNames[i]);
      const A = numFields.get(fieldNames[j]);
      if (X.length !== A.length) continue;
      // X = A (equality)
      if (X.every((v, k) => v === A[k])) {
        fdsFound++;
        fdRules.push({ action, derived: fieldNames[i], from: `${fieldNames[j]}`, formula: 'equality', n: X.length });
      }
    }
    for (let j = 0; j < fieldNames.length; j++) {
      if (i === j) continue;
      for (let k = 0; k < fieldNames.length; k++) {
        if (k === i || k === j) continue;
        const X = numFields.get(fieldNames[i]);
        const A = numFields.get(fieldNames[j]);
        const B = numFields.get(fieldNames[k]);
        if (X.length !== A.length || A.length !== B.length) continue;
        // X = round(A/B, 2)?
        const allRound = X.every((v, idx) => {
          if (B[idx] === 0) return false;
          const computed = Math.round((A[idx] / B[idx]) * 100) / 100;
          return Math.abs(computed - v) < 1e-9;
        });
        if (allRound) { fdsFound++; fdRules.push({ action, derived: fieldNames[i], from: `${fieldNames[j]}/${fieldNames[k]}`, formula: 'round(A/B,2)', n: X.length }); }
        // X = banker_round
        const bankerRound = x => { const f = Math.floor(x); const fr = x - f; if (Math.abs(fr - 0.5) < 1e-9) return f + (f % 2); return Math.round(x); };
        const allBanker = X.every((v, idx) => {
          if (B[idx] === 0) return false;
          const computed = bankerRound((A[idx] / B[idx]) * 100) / 100;
          return Math.abs(computed - v) < 1e-9;
        });
        if (allBanker && !allRound) { fdsFound++; fdRules.push({ action, derived: fieldNames[i], from: `${fieldNames[j]}/${fieldNames[k]}`, formula: 'banker_round(A/B,2)', n: X.length }); }
        // X = A - B
        const allDiff = X.every((v, idx) => v === A[idx] - B[idx]);
        if (allDiff) { fdsFound++; fdRules.push({ action, derived: fieldNames[i], from: `${fieldNames[j]} - ${fieldNames[k]}`, formula: 'A-B', n: X.length }); }
        // X = A + B
        const allSum = X.every((v, idx) => v === A[idx] + B[idx]);
        if (allSum) { fdsFound++; fdRules.push({ action, derived: fieldNames[i], from: `${fieldNames[j]} + ${fieldNames[k]}`, formula: 'A+B', n: X.length }); }
      }
    }
  }
}
console.log(`Functional dependencies found: ${fdsFound}`);
if (fdRules.length > 0) {
  console.log(`Top 10 by occurrence:`);
  fdRules.sort((a, b) => b.n - a.n);
  for (const r of fdRules.slice(0, 10)) {
    console.log(`  ${r.action}.${r.derived} = ${r.formula} (${r.from}) — verified across ${r.n} receipts`);
  }
}

// ════════════════════════════════════════════════════════════════════
// AUDIT J: Summary template derivation from payload
// ════════════════════════════════════════════════════════════════════
console.log(`\n=== J: Summary→payload functional dependency ===`);
const sumPay = new Map();
for (const r of receipts) {
  if (!r.summary || !r.payload_json) continue;
  const sTpl = r.summary.replace(NUM_RE, '\x01');
  const pTpl = r.payload_json.replace(NUM_RE, '\x01');
  const key = `${r.action}|${pTpl}`;
  if (!sumPay.has(key)) sumPay.set(key, new Set());
  sumPay.get(key).add(sTpl);
}
let derivableSummaryGroups = 0, totalGroups = 0;
for (const [key, sums] of sumPay) {
  totalGroups++;
  if (sums.size === 1) derivableSummaryGroups++;
}
console.log(`(action, payload_tpl) groups with single summary_tpl: ${derivableSummaryGroups} / ${totalGroups} (${(derivableSummaryGroups/totalGroups*100).toFixed(1)}%)`);
console.log(`If we DROP summary_tpl and derive via (action, payload_tpl) → summary_tpl table for derivable groups,`);
console.log(`then store explicit summary_tpl only for the ${totalGroups - derivableSummaryGroups} ambiguous groups.`);
// Estimate impact
let summaryRawBytes = 0;
for (const r of receipts) if (r.summary) summaryRawBytes += r.summary.length;
console.log(`Total raw summary bytes: ${summaryRawBytes.toLocaleString()}`);

// ════════════════════════════════════════════════════════════════════
// AUDIT K: Brotli with custom-trained dictionary
// ════════════════════════════════════════════════════════════════════
console.log(`\n=== K: Brotli with trained dictionary ===`);
// Build a "training corpus" from common substrings
const trainingDictParts = [];
trainingDictParts.push('{"id":"rcpt_');
trainingDictParts.push('","action":"');
trainingDictParts.push('","status":"ok","summary":"');
trainingDictParts.push('","payload_json":"');
trainingDictParts.push('","created_at":"');
trainingDictParts.push('Z"}');
// Add all distinct action strings
for (const a of new Set(receipts.map(r => r.action))) trainingDictParts.push(`"${a}"`);
// Add all distinct timestamps
for (const t of new Set(receipts.map(r => r.created_at))) trainingDictParts.push(`"${t}"`);
// Add common JSON keys
trainingDictParts.push('"ratio":', '"raw_bytes":', '"compressed_bytes":', '"atom_count":', '"dropped":', '"citations":');
// Add common values
trainingDictParts.push('"ok"', ',"', '","', ':"', ':{', '}}');
const trainingDict = Buffer.from(trainingDictParts.join('\n'), 'utf8');
console.log(`Trained dict (raw): ${trainingDict.length} B`);

// Compare brotli alone vs brotli with dict prefix on a sample
const sampleReceipts = receipts.slice(0, 1000).map(r => JSON.stringify(r)).join('\n') + '\n';
const sampleBytes = Buffer.from(sampleReceipts, 'utf8');
const sampleBr = zlib.brotliCompressSync(sampleBytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
const withDict = zlib.brotliCompressSync(Buffer.concat([trainingDict, sampleBytes]), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
const dictOnly = zlib.brotliCompressSync(trainingDict, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
const marginal = withDict.length - dictOnly.length;
console.log(`Sample 1000 receipts raw: ${sampleBytes.length} B`);
console.log(`  brotli alone: ${sampleBr.length} B`);
console.log(`  with trained dict prefix: marginal ${marginal} B (savings ${sampleBr.length - marginal} B)`);
if (marginal < sampleBr.length) {
  console.log(`  → Dict gives ${((sampleBr.length - marginal) / sampleBr.length * 100).toFixed(1)}% reduction`);
}

// ════════════════════════════════════════════════════════════════════
// AUDIT L: Receipt-pair full-derivation check (B from A via simple transforms)
// ════════════════════════════════════════════════════════════════════
console.log(`\n=== L: Receipt-pair full-derivation candidates ===`);
// Group receipts by adjacent pair (a_i, a_{i+1}). For each unique pair_class,
// check if the SHAPE of receipt_{i+1} is a deterministic function of receipt_i
// (e.g., does its payload reference the previous receipt's id?)
let pairsWithIdRef = 0;
let pairsWithDataDep = 0;
for (let i = 1; i < N; i++) {
  const prev = receipts[i - 1];
  const cur = receipts[i];
  const curText = JSON.stringify(cur);
  if (prev.id && curText.includes(prev.id)) pairsWithIdRef++;
  // Check if cur.payload contains a sha256 of prev.payload
  if (prev.payload_json && cur.payload_json) {
    const prevHash = crypto.createHash('sha256').update(prev.payload_json).digest('hex');
    if (cur.payload_json.includes(prevHash)) pairsWithDataDep++;
  }
}
console.log(`Adjacent pairs where cur references prev.id: ${pairsWithIdRef} / ${N-1}`);
console.log(`Adjacent pairs where cur contains sha256(prev.payload): ${pairsWithDataDep} / ${N-1}`);

// ════════════════════════════════════════════════════════════════════
// AUDIT M: Encode size impact estimation
// ════════════════════════════════════════════════════════════════════
console.log(`\n=== M: Projected impact summary ===`);

// Compute baseline (Method 12) total
const M12_BASELINE = 49016;  // From Exp 49 v2 champion

// Hash-derivation savings
const hashSavings = identifiedRules.reduce((s, r) => s + 64 * r.occurrences, 0);
console.log(`Hash-derivation potential raw savings: ${hashSavings} B (assuming we drop the hex string)`);

// Numeric constant savings (only for constants we hadn't already captured)
console.log(`Numeric constants raw savings: ${constNumericRawBytes.toLocaleString()} B`);

// Summary-derivation savings
console.log(`Summary-derivation potential: drop summary in ${derivableSummaryGroups} groups; recipe = (action, pay_tpl) → summary_tpl table`);

// Save audit findings to receipt
const audit = {
  experiment: '52-big-audit',
  generated_at: '2026-06-27',
  audit_summary: {
    action_key_pairs: akv.size,
    constant_payload_fields: akvStats.filter(s => s.isConstant).length,
    low_card_payload_fields: akvStats.filter(s => s.unique <= 8).length,
    distinct_64hex_strings: hashOccs.size,
    identified_hash_origins: hashesIdentified,
    deterministic_action_successors: actionsWithDetNext,
    distinct_payload_field_names: fieldNameCounts.size,
    distinct_created_at_values: distinctCAs.length,
    numeric_constant_series: constSeries,
    functional_deps_found: fdsFound,
    derivable_summary_groups: derivableSummaryGroups,
    total_groups: totalGroups,
  },
  hidden_constants: hiddenConsts.slice(0, 30),
  fd_rules: fdRules.slice(0, 30),
  deterministic_successors: detSuccessors.slice(0, 30),
  identified_hash_rules: identifiedRules.slice(0, 30),
  popular_substrings: popularSubstrs.slice(0, 10).map(([s, set]) => ({ substr: s.slice(0, 80), receipts: set.size })),
};
fs.writeFileSync(RECEIPT_FILE, JSON.stringify(audit, null, 2));
console.log(`\nReceipt: ${RECEIPT_FILE}`);
