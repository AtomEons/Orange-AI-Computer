// 12-receipt-writes.mjs — POST an event that should produce a receipt; verify a
// new line appears in the Reality lane JSONL with kind/event_type='receipt' and
// that the file size strictly increased.
//
// Doctrine note: operator's Night-1 checklist uses /mnt/ae_flux/reality.jsonl
// (top-level). The README also describes per-date files under events/reality/.
// We prefer the top-level path declared in env.flux_reality and fall back to
// the most-recent file under /mnt/ae_flux/events/reality/ if that exists.

import { run, defaultEnv, detectHost, fetchT, remoteOnly } from './_lib.mjs';
import { stat, readFile, readdir, open } from 'node:fs/promises';
import { join } from 'node:path';

const GATE = '12-receipt-writes';

async function resolveRealityFile(E) {
  // 1) explicit
  try {
    const s = await stat(E.flux_reality);
    if (s.isFile()) return { path: E.flux_reality, mode: 'explicit' };
  } catch {}
  // 2) per-date directory
  const dateDir = join(E.flux_root, 'events', 'reality');
  try {
    const ents = await readdir(dateDir);
    const jsonl = ents.filter(n => n.endsWith('.jsonl')).sort();
    if (jsonl.length) return { path: join(dateDir, jsonl[jsonl.length - 1]), mode: 'per-date' };
  } catch {}
  return null;
}

async function tailLines(path, n) {
  // Read last ~64 KiB and split lines (good enough for receipt-tailing).
  const s = await stat(path);
  const len = Math.min(s.size, 64 * 1024);
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, Math.max(0, s.size - len));
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    return lines.slice(-n);
  } finally {
    await fh.close();
  }
}

export async function check(env = {}, opts = {}) {
  const E = { ...defaultEnv(), ...env };
  return run(GATE, E, opts, async () => {
    const host = await detectHost(E);
    if (host !== 'codexa-wsl2') {
      return remoteOnly(GATE,
`# On Codexa WSL2 with daemon up:
before=$(stat -c %s ${E.flux_reality} 2>/dev/null || echo 0)
curl -s -X POST ${E.bun_url}/event -H 'content-type: application/json' \\
  -d '{"origin":"terminal","event":{"stdout":"gate-12 probe","exit_code":0,"emit_receipt":true}}'
after=$(stat -c %s ${E.flux_reality})
echo "delta=$((after-before))"
tail -1 ${E.flux_reality} | jq .`);
    }

    const target = await resolveRealityFile(E);
    if (!target) {
      return { pass: false, details: { reason: 'reality lane file not found',
        tried: [E.flux_reality, join(E.flux_root, 'events/reality/')] } };
    }

    // Baseline size & last line
    let beforeSize = 0;
    try { beforeSize = (await stat(target.path)).size; } catch {}

    // Probe event
    let probe = { ok: false, status: null, body: null, error: null };
    try {
      const r = await fetchT(E.bun_url + '/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          origin: 'terminal',
          event: {
            stdout: 'gate-12 receipt probe ' + Date.now(),
            exit_code: 0,
            emit_receipt: true,
          },
        }),
      }, 15_000);
      probe.status = r.status;
      probe.body = await r.json().catch(() => null);
      probe.ok = !!(probe.body && probe.body.ok === true);
    } catch (e) {
      probe.error = String(e.message || e);
    }

    // Re-stat
    let afterSize = beforeSize;
    let lastLine = null;
    let parsed = null;
    try {
      afterSize = (await stat(target.path)).size;
      const lines = await tailLines(target.path, 3);
      lastLine = lines[lines.length - 1] || null;
      if (lastLine) {
        try { parsed = JSON.parse(lastLine); } catch {}
      }
    } catch {}

    const grew = afterSize > beforeSize;
    const receiptLike = parsed && (parsed.event_type === 'receipt' || parsed.kind === 'receipt' || parsed.lane === 'reality');
    const pass = probe.ok && grew && !!receiptLike;

    return {
      pass,
      details: {
        reason: pass ? 'reality lane grew and tail looks like a receipt'
                     : `probe.ok=${probe.ok} grew=${grew} receiptLike=${!!receiptLike}`,
        reality_file: target.path,
        resolve_mode: target.mode,
        size_before: beforeSize,
        size_after: afterSize,
        size_delta: afterSize - beforeSize,
        last_line_parsed: parsed,
        last_line_raw_head: lastLine ? lastLine.slice(0, 240) : null,
        probe,
      },
    };
  });
}
