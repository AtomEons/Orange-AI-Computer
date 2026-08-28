// Experiment 84 — Templated-summary regeneration.
// Hypothesis: `summary` is a templated string derivable from payload + action.
// Mine templates per action class (longest common prefix/suffix). Strip summary
// where reconstructable. Regenerate at decode. SHA256 verify.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');

const corpusBytes = fs.readFileSync(CORPUS);
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
const N = receipts.length;
const rawTotal = corpusBytes.length;

function brotli11(b) { return zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }); }
function sha256(b) { return crypto.createHash('sha256').update(b).digest('hex'); }

const t0 = performance.now();

// Group by action
const byAction = new Map();
for (let i = 0; i < N; i++) {
  const r = receipts[i];
  if (!byAction.has(r.action)) byAction.set(r.action, []);
  byAction.get(r.action).push({ i, r });
}

// Mine templates: per action, replace numeric runs with \x01 in summary.
// If templatized form is constant across the whole class, we have a perfect template.
const NUM_RE = /-?\d+(?:\.\d+)?/g;
function templatize(s) {
  if (s == null) return { tpl: '\0NULL\0', nums: [] };
  const nums = [];
  const tpl = String(s).replace(NUM_RE, m => { nums.push(m); return '\x01'; });
  return { tpl, nums };
}

// For each action: collect templates; identify the dominant (most common) template.
// If a receipt matches the dominant template AND its nums sequence is reproducible
// from existing payload fields → safely strippable. To stay rigorous, we strip ONLY
// when the WHOLE summary is constant (no numeric variation) per action class.
// This is conservative but guarantees roundtrip without payload-formula assumptions.

const stripableActions = new Map(); // action -> constant summary string
for (const [a, items] of byAction) {
  const summaries = new Set();
  for (const { r } of items) summaries.add(r.summary);
  if (summaries.size === 1) {
    stripableActions.set(a, [...summaries][0]);
  }
}

// Build stripped corpus: omit summary when it's the canonical constant for the action.
const stripped = receipts.map(r => {
  if (stripableActions.has(r.action)) {
    const { summary, ...rest } = r;
    return rest;
  }
  return r;
});
const strippedJsonl = stripped.map(o => JSON.stringify(o)).join('\n') + '\n';
const strippedBytes = Buffer.from(strippedJsonl, 'utf8');

// Dict: action -> constant summary
const dict = Object.fromEntries(stripableActions);
const dictJson = JSON.stringify(dict);
const dictBytes = Buffer.from(dictJson, 'utf8');
const compResid = brotli11(strippedBytes);

const lenBuf = Buffer.alloc(4);
lenBuf.writeUInt32LE(dictBytes.length, 0);
const wire = Buffer.concat([lenBuf, dictBytes, compResid]);
const encode_ms = performance.now() - t0;

// Decode
const d0 = performance.now();
const dLen = wire.readUInt32LE(0);
const dStr = wire.slice(4, 4 + dLen).toString('utf8');
const dict2 = JSON.parse(dStr);
const decResid = zlib.brotliDecompressSync(wire.slice(4 + dLen));
const decReceipts = decResid.toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const ORDER = ['id', 'action', 'status', 'summary', 'payload_json', 'created_at'];
const recon = decReceipts.map(r => {
  if (r.action in dict2 && !('summary' in r)) {
    r = { ...r, summary: dict2[r.action] };
  }
  const o = {};
  for (const k of ORDER) if (k in r) o[k] = r[k];
  for (const k of Object.keys(r)) if (!(k in o)) o[k] = r[k];
  return o;
});
const reconJsonl = recon.map(o => JSON.stringify(o)).join('\n') + '\n';
const reconBytes = Buffer.from(reconJsonl, 'utf8');
const decode_ms = performance.now() - d0;

const origSha = sha256(corpusBytes);
const reconSha = sha256(reconBytes);
const lossless = origSha === reconSha;

// Count action-classes affected
const totalStrippedRecs = stripped.filter(r => !('summary' in r)).length;
const ratio = rawTotal / wire.length;

const summary = {
  experiment: '84-templated-summary',
  ratio: Number(ratio.toFixed(3)),
  encode_ms: Number(encode_ms.toFixed(1)),
  decode_ms: Number(decode_ms.toFixed(1)),
  lossless,
  notes: `${stripableActions.size} action classes had constant summary. Stripped summary from ${totalStrippedRecs}/${N} receipts. Dict bytes=${dictBytes.length}. Wire=${wire.length}. orig sha=${origSha.slice(0,16)} recon=${reconSha.slice(0,16)}.`,
  baseline_m19_ratio: 47.071,
  vs_m19_delta: Number((ratio - 47.071).toFixed(3)),
  raw_bytes: rawTotal,
  wire_bytes: wire.length,
  templatable_action_classes: stripableActions.size,
  stripped_receipts: totalStrippedRecs,
};
fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
