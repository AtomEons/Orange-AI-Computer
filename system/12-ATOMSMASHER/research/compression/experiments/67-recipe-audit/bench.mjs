// Experiment 67: Recipe-overhead audit
// Walks experiments 01..66, classifies each *_bytes key as RECIPE vs PAYLOAD,
// computes savings vs uncompressed-NDJSON baseline (2,075,585), and flags:
//   - law6_violator: recipe > savings  (overhead exceeds gain)
//   - template_winner: recipe < 10% of total AND ratio > 5x  (lean wins)
//
// Heuristic classification (case-insensitive substring match on key name):
//   RECIPE  : template | tpl | vocab | dict | meta | schema | header | proto | key
//   PAYLOAD : everything else ending in _bytes (stream, payload, data, brotli, etc.)
//
// Numeric keys that are NOT byte counts (sizes, counts, ratios) are ignored
// by requiring the key to end with "_bytes" OR equal "total" / "encoded" /
// "compressed" for opaque-total receipts.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const NDJSON_BASELINE = 2075585;

const RECIPE_PAT = /(template|tpl|vocab|dict|meta|schema|header|proto|key)/i;

function classifyKey(k) {
  return RECIPE_PAT.test(k) ? 'recipe' : 'payload';
}

function readReceipt(dir) {
  const r = path.join(dir, 'RECEIPT.json');
  if (fs.existsSync(r)) {
    try { return { src: 'RECEIPT.json', data: JSON.parse(fs.readFileSync(r, 'utf8')) }; }
    catch (e) { return { src: 'RECEIPT.json', error: String(e) }; }
  }
  const r2 = path.join(dir, 'RECEIPT-v2.json');
  if (fs.existsSync(r2)) {
    try { return { src: 'RECEIPT-v2.json', data: JSON.parse(fs.readFileSync(r2, 'utf8')) }; }
    catch (e) { return { src: 'RECEIPT-v2.json', error: String(e) }; }
  }
  const s = path.join(dir, 'summary.json');
  if (fs.existsSync(s)) {
    try { return { src: 'summary.json', data: JSON.parse(fs.readFileSync(s, 'utf8')) }; }
    catch (e) { return { src: 'summary.json', error: String(e) }; }
  }
  return null;
}

// Walk an arbitrary object collecting numeric leaves with their key name.
// Returns [{ key, value, path }]
function collectByteCandidates(obj, basePath = '') {
  const out = [];
  if (!obj || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      out.push(...collectByteCandidates(obj[i], `${basePath}[${i}]`));
    }
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const p = basePath ? `${basePath}.${k}` : k;
    if (typeof v === 'number' && Number.isFinite(v)) {
      out.push({ key: k, value: v, path: p });
    } else if (v && typeof v === 'object') {
      out.push(...collectByteCandidates(v, p));
    }
  }
  return out;
}

// From the receipt, extract:
//   total_bytes  : authoritative final compressed size
//   recipe_bytes : sum of RECIPE-classified component byte counts
//   payload_bytes: sum of PAYLOAD-classified component byte counts
//   ratio        : taken directly if present
//   lossless     : roundtrip_lossless / lossless field if present
//   opaque       : true when we only have a `total` and no component breakdown
function auditReceipt(name, data) {
  let total = null;
  let ratio = null;
  let lossless = null;

  if (typeof data.ratio === 'number') ratio = data.ratio;
  if (typeof data.roundtrip_lossless === 'boolean') lossless = data.roundtrip_lossless;
  if (typeof data.lossless === 'boolean') lossless = data.lossless;

  // Total candidates (in order of preference).
  const totalKeys = ['total', 'encoded', 'compressed', 'brotli_bytes', 'compressed_bytes'];
  for (const k of totalKeys) {
    if (typeof data[k] === 'number') { total = data[k]; break; }
  }

  // results[] arrays (exp 30): use the best ratio entry's encoded.
  if (total == null && Array.isArray(data.results) && data.results.length) {
    let best = null;
    for (const r of data.results) {
      if (typeof r?.encoded === 'number') {
        if (!best || r.encoded < best.encoded) best = r;
      }
    }
    if (best) {
      total = best.encoded;
      if (best.ratio && !ratio) ratio = best.ratio;
    }
  }

  // Collect component byte counts. Walk the whole tree and pick numeric leaves
  // whose key name ends in _bytes OR sits under a "components" / "summary"
  // sub-object with byte-looking values.
  const candidates = collectByteCandidates(data);
  const components = candidates.filter(c => {
    const k = c.key.toLowerCase();
    if (k === 'corpus_bytes_in' || k === 'corpus_bytes' || k === 'baseline_bytes') return false;
    if (k.endsWith('_bytes')) return true;
    // exp 37 shape: components.{name}: int
    if (c.path.startsWith('components.')) return true;
    return false;
  });

  // If no breakdown, mark opaque.
  let recipe = 0, payload = 0;
  let opaque = true;
  if (components.length > 0) {
    opaque = false;
    for (const c of components) {
      const cls = classifyKey(c.key);
      if (cls === 'recipe') recipe += c.value;
      else payload += c.value;
    }
    // If we lack a top-level total but have components, derive total from sum.
    if (total == null) total = recipe + payload;
  }

  if (total == null) return null; // nothing usable

  // Receipt-mismatch detection. If the receipt reports its own ratio, that
  // ratio implies an authoritative compressed size (NDJSON_BASELINE / ratio).
  // Compare against our component-sum.
  //   * total < implied/1.5  => we under-rolled (missing component)  => trust ratio
  //   * total > implied*1.5  => we over-rolled (counted intermediates/uncompressed
  //                              representations)                    => trust ratio
  // In both cases the row is a sub_problem rollup and the recipe split is
  // unreliable — collapse to opaque interpretation but keep ratio honest.
  let subProblem = false;
  if (typeof ratio === 'number' && ratio > 0) {
    const impliedTotal = NDJSON_BASELINE / ratio;
    const skewLow  = impliedTotal > total * 1.5;
    const skewHigh = total > impliedTotal * 1.5;
    if (skewLow || skewHigh) {
      subProblem = true;
      total = Math.round(impliedTotal);
      // recipe/payload split is meaningless on a mis-rolled-up receipt
      recipe = 0;
      payload = total;
    }
  }
  if (ratio == null) ratio = NDJSON_BASELINE / total;

  const savings = NDJSON_BASELINE - total;
  // Law-6 violator: recipe overhead alone exceeds total savings vs NDJSON.
  // Translation: you carried more dictionary than you saved. Impossible
  // unless the experiment is "overhead-laden" relative to its compression gain.
  const law6 = recipe > savings && !opaque;
  const recipePct = total > 0 ? (recipe / total) * 100 : 0;
  const templateWinner = !opaque && recipePct < 10 && ratio > 5;

  return {
    experiment: name,
    total_bytes: total,
    recipe_bytes: recipe,
    payload_bytes: payload,
    savings_vs_ndjson: savings,
    recipe_pct_of_total: Number(recipePct.toFixed(2)),
    ratio: Number((typeof ratio === 'number' ? ratio : 0).toFixed(3)),
    lossless,
    opaque,
    sub_problem: subProblem,
    law6_violator: law6,
    template_winner: templateWinner,
  };
}

// --- Walk experiments 01..66 ---
const entries = fs.readdirSync(ROOT, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name)
  .filter(n => {
    const m = n.match(/^(\d+)-/);
    if (!m) return false;
    const num = parseInt(m[1], 10);
    return num >= 1 && num <= 66;
  })
  .sort((a, b) => parseInt(a) - parseInt(b));

const rows = [];
const missing = [];
const opaqueList = [];
for (const name of entries) {
  const dir = path.join(ROOT, name);
  const r = readReceipt(dir);
  if (!r || !r.data) { missing.push(name); continue; }
  const row = auditReceipt(name, r.data);
  if (!row) { missing.push(name); continue; }
  if (row.opaque) opaqueList.push(name);
  rows.push(row);
}

// --- Write violations.csv ---
const HERE = path.resolve(import.meta.dir);
const csvHeader = [
  'experiment',
  'total_bytes',
  'recipe_bytes',
  'payload_bytes',
  'savings_vs_ndjson',
  'recipe_pct_of_total',
  'ratio',
  'lossless',
  'opaque',
  'sub_problem',
  'law6_violator',
  'template_winner',
].join(',');
const csvLines = rows.map(r => [
  r.experiment,
  r.total_bytes,
  r.recipe_bytes,
  r.payload_bytes,
  r.savings_vs_ndjson,
  r.recipe_pct_of_total,
  r.ratio,
  r.lossless === null ? '' : r.lossless,
  r.opaque,
  r.sub_problem,
  r.law6_violator,
  r.template_winner,
].join(','));
fs.writeFileSync(
  path.join(HERE, 'violations.csv'),
  [csvHeader, ...csvLines].join('\n') + '\n',
);

const law6Violators = rows.filter(r => r.law6_violator);
// Clean winners must NOT be sub-problem rollups — those are optical illusions
// where the receipt only measured a slice of the corpus.
const cleanWinners = rows.filter(r => r.template_winner && !r.sub_problem);
const subProblemCount = rows.filter(r => r.sub_problem).length;

// Top 5 clean winners by ratio
const topWinners = [...cleanWinners]
  .sort((a, b) => b.ratio - a.ratio)
  .slice(0, 5)
  .map(r => ({
    experiment: r.experiment,
    ratio: r.ratio,
    total_bytes: r.total_bytes,
    recipe_bytes: r.recipe_bytes,
    recipe_pct_of_total: r.recipe_pct_of_total,
  }));

const summary = {
  experiment: '67-recipe-audit',
  ratio: 'N/A',
  encode_ms: 0,
  decode_ms: 0,
  lossless: null,
  notes: 'analysis-only; see violations.csv',
  experiments_audited: rows.length,
  law6_violators: law6Violators.length,
  law6_clean_winners: cleanWinners.length,
  opaque_receipts: opaqueList.length,
  sub_problem_rollups: subProblemCount,
  missing_receipts: missing,
  opaque_list: opaqueList,
  top_winners: topWinners,
};

fs.writeFileSync(
  path.join(HERE, 'summary.json'),
  JSON.stringify(summary, null, 2),
);

console.log(JSON.stringify(summary, null, 2));
console.log('---');
console.log('violations.csv rows:', rows.length);
console.log('law6_violators experiments:', law6Violators.map(r => r.experiment));
console.log('template_winners experiments:', cleanWinners.map(r => `${r.experiment}@${r.ratio}x (${r.recipe_pct_of_total}%)`));
