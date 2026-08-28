#!/usr/bin/env bun
// Non-destructive one-time/idempotent migration from historical repo-local
// Flux trees into the canonical persistent Cobra ledger.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalFluxRoot } from './paths.mjs';
import { verifyChainStream } from './flux/reader.mjs';
import { __loopInternals } from '../../../03-BACKEND/learning-loop.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const COBRA = path.join(ROOT, '06-ORANGELLM', 'memory', 'ae-cobra');
const DEST = canonicalFluxRoot();
const SOURCES = [
  { id: 'repo-spine', events: path.join(COBRA, 'events') },
  { id: 'repo-legacy-flux', events: path.join(COBRA, 'flux', 'events') },
];

function jsonlFiles(root) {
  if (!fs.existsSync(root)) return [];
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(full);
    }
  };
  walk(root);
  return found.sort();
}

function readRecords(file, source, errors) {
  const out = [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  lines.forEach((line, index) => {
    try {
      const record = JSON.parse(line);
      if (!['reality', 'thought', 'merge'].includes(record.lane)) throw new Error(`invalid lane ${record.lane}`);
      out.push({ record, source, file, line: index + 1 });
    } catch (error) {
      errors.push({ source, file, line: index + 1, error: error.message });
    }
  });
  return out;
}

function canonicalIdentity() {
  const hashes = new Set();
  const migrated = new Set();
  for (const file of jsonlFiles(path.join(DEST, 'events'))) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)) {
      try {
        const record = JSON.parse(line);
        if (record.hash) hashes.add(record.hash);
        if (record.body?._migration?.source_hash) migrated.add(record.body._migration.source_hash);
      } catch {}
    }
  }
  return { hashes, migrated };
}

const errors = [];
const discovered = SOURCES.flatMap((source) => jsonlFiles(source.events).flatMap((file) => readRecords(file, source.id, errors)))
  .sort((a, b) => Number(a.record.ts ?? 0) - Number(b.record.ts ?? 0));
const identity = canonicalIdentity();
const migrated = [];
let skipped = 0;
let migrationTs = Date.now();

for (const item of discovered) {
  const sourceHash = item.record.hash ?? `${item.source}:${path.relative(COBRA, item.file)}:${item.line}`;
  if (identity.hashes.has(sourceHash) || identity.migrated.has(sourceHash)) {
    skipped += 1;
    continue;
  }
  const body = {
    ...(item.record.body && typeof item.record.body === 'object' ? item.record.body : {}),
    _migration: {
      source: item.source,
      source_file: path.relative(COBRA, item.file),
      source_line: item.line,
      source_hash: sourceHash,
      source_ts: item.record.ts ?? null,
    },
  };
  const written = __loopInternals.appendFlux({
    fluxRoot: DEST,
    lane: item.record.lane,
    origin: item.record.origin ?? `migration:${item.source}`,
    kind: item.record.kind ?? 'migrated',
    body,
    // Backfills append to the live chain in migration order. The original
    // timestamp remains in provenance; inserting old dates would reorder the
    // daily files ahead of an existing live chain and invalidate continuity.
    ts: migrationTs++,
  });
  identity.migrated.add(sourceHash);
  migrated.push({ source: item.source, source_hash: sourceHash, canonical_hash: written.hash, lane: written.lane, ts: written.ts });
}

const chains = Object.fromEntries(['reality', 'thought', 'merge'].map((lane) => [lane, verifyChainStream({ fluxRoot: DEST, lane })]));
const chainOk = Object.values(chains).every((result) => result.ok !== false);
const receipt = {
  schema: 'orange5.cobra.flux-unification.v1',
  status: chainOk && errors.length === 0 ? 'VERIFIED' : 'NEEDS_ATTENTION',
  generated_at: new Date().toISOString(), canonical_root: DEST,
  sources: SOURCES, discovered: discovered.length, migrated: migrated.length, skipped,
  parse_errors: errors, chains,
  source_trees_preserved: true,
  migrated_records: migrated,
};
const receiptDir = path.join(ROOT, '10-RECEIPTS', 'orange5-build');
fs.mkdirSync(receiptDir, { recursive: true });
const receiptPath = path.join(receiptDir, `${receipt.generated_at.replace(/[:.]/g, '-')}-cobra-flux-unification.json`);
fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ ...receipt, receiptPath }, null, 2));
if (receipt.status !== 'VERIFIED') process.exitCode = 1;
