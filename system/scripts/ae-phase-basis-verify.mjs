#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import fs from 'node:fs';

const filePath = process.argv[2];
if (!filePath || !fs.existsSync(filePath)) {
  process.stderr.write(`AE Phase basis is missing: ${filePath || '<none>'}\n`);
  process.exit(1);
}

const bytes = fs.statSync(filePath).size;
const sha256 = createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
process.stdout.write(`${JSON.stringify({
  schema: 'orange.ae-phase.basis-proof.v1',
  ok: true,
  path: filePath,
  bytes,
  sha256,
})}\n`);
