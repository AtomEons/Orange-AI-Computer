// Experiment 96 — zstd --long=27 (128MB window).
// Honest report: zstd CLI is NOT available on this Windows box (no `zstd.exe`
// in PATH, no zstd-* npm binding installed). Marked N/A per brief rule:
// "If a codec is unavailable on this box, mark as N/A and skip."

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

let codecAvailable = false;
let probeOutput = '';
try {
  probeOutput = execSync('zstd --version', { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  codecAvailable = true;
} catch (e) {
  probeOutput = e.message;
}

const summary = {
  experiment: '96-zstd-long-window',
  codec_available: codecAvailable,
  probe: probeOutput.split('\n')[0] || 'zstd not found',
  status: codecAvailable ? 'codec-found-would-run' : 'N/A',
  ratio: null,
  vs_M19: null,
  enc_ms: null,
  dec_ms: null,
  lossless: null,
  verdict: 'N/A',
  notes: 'zstd CLI not installed on this Windows box. No Node zstd binding present in repo node_modules. Skipped per brief.',
};

fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
