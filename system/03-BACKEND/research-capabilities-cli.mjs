#!/usr/bin/env bun
import fs from 'node:fs';
import { collectResearchEvidence } from './research-capabilities.mjs';
import { exportBehaviorLearningPack, getCurrentAwareness, readCurrentAwareness, recordCandidateBenchmark } from './current-awareness.mjs';
import { readProjectLock } from './project-lock.mjs';

const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith('-') ? args[0] : 'scout';
const query = valueAfter('--query') || (command === 'scout' || command === 'evidence' ? positionalAfterCommand().join(' ') : '');

let result;
if (command === 'scout') {
  if (!query.trim()) usage(2);
  result = await getCurrentAwareness({
    query,
    project: readProjectLock(),
    force: args.includes('--force'),
    budgetMs: Number(valueAfter('--budget-ms')) || 60_000,
  });
} else if (command === 'brief') {
  if (query.trim()) {
    result = await getCurrentAwareness({ query, project: readProjectLock(), force: false, budgetMs: Number(valueAfter('--budget-ms')) || 60_000 });
    result = { schema: result.schema, status: result.status, generatedAt: result.generatedAt, cacheHit: result.cacheHit, sourceCount: result.sourceCount, brief: result.brief, opportunities: result.opportunities, sha256: result.sha256 };
  } else result = readCurrentAwareness();
} else if (command === 'status') {
  result = readCurrentAwareness();
} else if (command === 'export-learning') {
  result = exportBehaviorLearningPack({ outPath: valueAfter('--out') });
} else if (command === 'evidence') {
  if (!query.trim()) usage(2);
  result = await collectResearchEvidence({ query, delegationId: valueAfter('--id') || undefined, budgetMs: Number(valueAfter('--budget-ms')) || 60_000 });
} else if (command === 'benchmark') {
  const inputPath = valueAfter('--input');
  if (!inputPath) usage(2);
  result = recordCandidateBenchmark(JSON.parse(fs.readFileSync(inputPath, 'utf8')));
} else usage(2);

console.log(JSON.stringify(result, null, 2));
if (result?.ok === false || ['CURRENT_EVIDENCE_STALE', 'CURRENT_EVIDENCE_UNAVAILABLE'].includes(result?.status)) process.exitCode = 1;

function positionalAfterCommand() {
  const start = args[0] === command ? 1 : 0;
  const values = [];
  for (let index = start; index < args.length; index++) {
    if (args[index].startsWith('--')) { index += 1; continue; }
    values.push(args[index]);
  }
  return values;
}
function valueAfter(flag) { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; }
function usage(code = 0) {
  console.log('orange:research scout --query "build a current local AI tool" [--force] [--budget-ms 60000]');
  console.log('orange:research brief [--query "project task"]');
  console.log('orange:research status');
  console.log('orange:research evidence --query "topic"');
  console.log('orange:research benchmark --input BENCHMARK.json');
  console.log('orange:research export-learning [--out FILE]');
  process.exit(code);
}
