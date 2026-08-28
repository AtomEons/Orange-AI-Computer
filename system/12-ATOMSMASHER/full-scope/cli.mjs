#!/usr/bin/env bun
// AtomSmasher Full-Scope — CLI
// Faithful Bun port of `atomsmasher_full_scope_v1_0/atomsmasher/cli.py`.
//
// Usage (mirrors Python's argparse):
//   bun cli.mjs [--db PATH] <cmd> [args...]
//
// Commands:
//   init                                — print version + feature count
//   ingest-text --title T --text X      — ingest a text source
//   ingest-file PATH                    — ingest a file (txt/md/json/etc.)
//   orders [--add TEXT] [--json]        — show or add orders
//   show-hot                            — list HOT heat items
//   coverage [--source-id ID]           — show coverage receipts
//   search QUERY                        — FTS5 search across ingested text
//   air                                 — print active AIR rendering
//   equation-fit --name N --values v1,v2,...   — fit a series
//   equation-show EQ_ID                 — show + reconstruct an equation
//   compile QUERY                       — total-work compile
//   execute-addition NAME_OR_ID         — run one feature
//   run-all-additions [--limit N]       — run all 620 features
//   proof                               — local proof lab probes
//   v10-demo                            — full demo end-to-end

import { Store } from './storage.mjs';
import {
  SourceEngine, OrderSpine, CommitmentCodec, EquationMemory,
  FeatureExecutor, TotalWorkCompiler, LocalProofLab, demo,
} from './engines.mjs';
import { jdump } from './utils.mjs';
import { VERSION, CODENAME, SCHEMA_VERSION, SYSTEM_LAW } from './version.mjs';

function parseArgs(argv) {
  const args = { db: 'atomsmasher.db', cmd: null, rest: {}, positional: [] };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--db') { args.db = argv[++i]; i++; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { args.rest[key] = next; i += 2; }
      else { args.rest[key] = true; i++; }
      continue;
    }
    if (args.cmd === null) { args.cmd = a; i++; continue; }
    args.positional.push(a);
    i++;
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  const store = new Store(args.db);

  if (args.cmd === null || args.cmd === 'init') {
    console.log(jdump({
      version: VERSION, codename: CODENAME, schema_version: SCHEMA_VERSION,
      features: store.one('SELECT COUNT(*) c FROM features').c,
      law: SYSTEM_LAW,
    }));
    return;
  }
  if (args.cmd === 'ingest-text') {
    console.log(jdump(new SourceEngine(store).ingestText(args.rest.title, args.rest.text)));
    return;
  }
  if (args.cmd === 'ingest-file') {
    console.log(jdump(new SourceEngine(store).ingestFile(args.positional[0])));
    return;
  }
  if (args.cmd === 'orders') {
    if (args.rest.add) new OrderSpine(store).addOrder(args.rest.add);
    console.log(jdump(new OrderSpine(store).digest()));
    return;
  }
  if (args.cmd === 'show-hot') {
    console.log(jdump(store.all('SELECT * FROM heat_items ORDER BY heat DESC, created_at DESC')));
    return;
  }
  if (args.cmd === 'coverage') {
    const rows = args.rest['source-id']
      ? store.all('SELECT * FROM coverage_receipts WHERE source_id=?', [args.rest['source-id']])
      : store.all('SELECT * FROM coverage_receipts ORDER BY created_at DESC');
    console.log(jdump(rows));
    return;
  }
  if (args.cmd === 'search') {
    console.log(jdump(new SourceEngine(store).search(args.positional[0])));
    return;
  }
  if (args.cmd === 'air') {
    console.log(new CommitmentCodec(store).activeAir(100));
    return;
  }
  if (args.cmd === 'equation-fit') {
    const vals = String(args.rest.values).split(',').map(s => s.trim()).filter(Boolean).map(Number);
    console.log(jdump(new EquationMemory(store).fitSeries(vals, args.rest.name || 'series')));
    return;
  }
  if (args.cmd === 'equation-show') {
    const eqId = args.positional[0];
    console.log(jdump({
      equation: store.one('SELECT * FROM equations WHERE id=?', [eqId]),
      reconstruction: new EquationMemory(store).reconstruct(eqId),
    }));
    return;
  }
  if (args.cmd === 'compile') {
    console.log(jdump(new TotalWorkCompiler(store).compile(args.positional[0])));
    return;
  }
  if (args.cmd === 'execute-addition') {
    console.log(jdump(new FeatureExecutor(store).executeFeature(args.positional[0])));
    return;
  }
  if (args.cmd === 'run-all-additions') {
    const limit = args.rest.limit ? parseInt(args.rest.limit, 10) : null;
    console.log(jdump(new FeatureExecutor(store).runAll(limit)));
    return;
  }
  if (args.cmd === 'proof') {
    console.log(jdump(new LocalProofLab(store).runProbes()));
    return;
  }
  if (args.cmd === 'v10-demo') {
    console.log(jdump(demo(store)));
    return;
  }
  console.error(`unknown command: ${args.cmd}`);
  process.exit(2);
}

main(process.argv.slice(2));
