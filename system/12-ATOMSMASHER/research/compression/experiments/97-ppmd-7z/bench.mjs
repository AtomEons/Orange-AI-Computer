// Experiment 97 — PPMd via 7-Zip.
// Honest report: 7z CLI is NOT available on this Windows box. No `7z.exe`,
// no `7za.exe` in PATH, no `C:\Program Files\7-Zip\`. Marked N/A per brief.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

let codecAvailable = false;
let probeOutput = '';
try {
  probeOutput = execSync('7z', { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  codecAvailable = true;
} catch (e) {
  probeOutput = e.message;
}

const summary = {
  experiment: '97-ppmd-7z',
  codec_available: codecAvailable,
  probe: probeOutput.split('\n')[0] || '7z not found',
  status: codecAvailable ? 'codec-found-would-run' : 'N/A',
  ratio: null,
  vs_M19: null,
  enc_ms: null,
  dec_ms: null,
  lossless: null,
  verdict: 'N/A',
  notes: '7-Zip CLI not installed on this Windows box. Skipped per brief.',
};

fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
