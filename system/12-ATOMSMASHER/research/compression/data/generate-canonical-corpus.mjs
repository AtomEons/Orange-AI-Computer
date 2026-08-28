// generate-canonical-corpus.mjs
// Produces the canonical apples-to-apples test corpus for all compression
// research experiments. ONE organism run, receipts exported as JSONL.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Store, FeatureExecutor } from '../../../full-scope/index.mjs';

const OUT_DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS_FILE = path.join(OUT_DIR, 'canonical-corpus.jsonl');
const META_FILE = path.join(OUT_DIR, 'canonical-corpus.meta.json');

console.log('Generating canonical research corpus...');
const tmpDb = path.join(os.tmpdir(), `research-corpus-${Date.now()}.db`);
const s = new Store(tmpDb);
s.registerFeatures();
const fe = new FeatureExecutor(s);
const t0 = Date.now();
const organismOut = fe.runAsOrganism();
const elapsedMs = Date.now() - t0;

const rows = s.all('SELECT id, action, status, summary, payload_json, created_at FROM receipts ORDER BY id');
const jsonl = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
fs.writeFileSync(CORPUS_FILE, jsonl);

const corpusBytes = Buffer.byteLength(jsonl);
const corpusSha256 = crypto.createHash('sha256').update(jsonl).digest('hex');

const meta = {
  generated_at: new Date().toISOString(),
  source: 'runAsOrganism() at max-mode-v2',
  receipts_count: rows.length,
  corpus_bytes: corpusBytes,
  corpus_sha256: corpusSha256,
  organism_elapsed_ms: elapsedMs,
  organism_id: organismOut.organism_id,
  baseline_4weave_ratio: organismOut.stages.max_compression_report.compound_total_ratio,
  baseline_regen_ratio: organismOut.stages.max_compression_report.regen_ratio,
  notes: 'apples-to-apples test corpus for compression research experiments 01-10',
};
fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));

console.log(`Corpus written: ${CORPUS_FILE}`);
console.log(`  receipts:         ${rows.length}`);
console.log(`  corpus bytes:     ${corpusBytes}`);
console.log(`  corpus sha256:    ${corpusSha256}`);
console.log(`  organism elapsed: ${elapsedMs} ms`);
console.log(`  4weave baseline:  ${meta.baseline_4weave_ratio}x`);
console.log(`  regen baseline:   ${meta.baseline_regen_ratio}x`);

fs.unlinkSync(tmpDb);
