// Experiment 98 — zpaq -m5 max-effort.
// Honest report: zpaq is NOT available on this Windows box. Marked N/A.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

let codecAvailable = false;
let probeOutput = '';
try {
  probeOutput = execSync('zpaq -version', { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  codecAvailable = true;
} catch (e) {
  probeOutput = e.message;
}

const summary = {
  experiment: '98-zpaq',
  codec_available: codecAvailable,
  probe: probeOutput.split('\n')[0] || 'zpaq not found',
  status: codecAvailable ? 'codec-found-would-run' : 'N/A',
  ratio: null,
  vs_M19: null,
  enc_ms: null,
  dec_ms: null,
  lossless: null,
  verdict: 'N/A',
  notes: 'zpaq not installed on this Windows box. Skipped per brief.',
};

fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
