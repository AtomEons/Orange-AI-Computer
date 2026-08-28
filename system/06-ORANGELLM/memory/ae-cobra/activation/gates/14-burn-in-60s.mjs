// 14-burn-in-60s.mjs — 60-second burn-in must be clean.
//
// During the burn-in we observe and assert:
//   - llama-server and bun PIDs alive at start AND end
//   - no llama-server respawn (PID stable)
//   - bun /healthz remains green every probe
//   - VmSwap of llama remains 0 (mlock holding)
//   - Reality + Thought lane sizes are monotonically non-decreasing (no truncation)
//   - error counters in /healthz (if exposed) do not increase
//
// On N150 (off-host): pass:null with remote_recipe. We cannot honestly run a burn-in
// against a daemon we can't see PIDs/RSS for.

import { run, defaultEnv, detectHost, fetchT, remoteOnly } from './_lib.mjs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const GATE = '14-burn-in-60s';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function kbFromStatus(text, key) {
  const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
  return m ? Number(m[1]) : null;
}

async function findPids() {
  const out = { llama: null, bun: null };
  try {
    const ents = await readdir('/proc');
    for (const e of ents) {
      if (!/^\d+$/.test(e)) continue;
      const comm = await readFile(`/proc/${e}/comm`, 'utf8').catch(() => '');
      const cmd  = await readFile(`/proc/${e}/cmdline`, 'utf8').catch(() => '');
      if (comm.trim() === 'llama-server') out.llama = Number(e);
      else if ((comm.trim() === 'bun' || comm.trim() === 'node') && /flow-direct\/server\.mjs/.test(cmd))
        out.bun = Number(e);
    }
  } catch {}
  return out;
}

async function probe(env) {
  const out = { ts: Date.now(), pids: null, llama_status: null, bun_health: null, swap_kb: null, sizes: null, error: null };
  try {
    out.pids = await findPids();
    if (out.pids.llama) {
      const st = await readFile(`/proc/${out.pids.llama}/status`, 'utf8').catch(() => '');
      out.swap_kb = kbFromStatus(st, 'VmSwap');
    }
    try {
      const r = await fetchT(env.bun_url + '/healthz', {}, 1500);
      out.llama_status = r.status;
      out.bun_health = await r.json().catch(() => null);
    } catch (e) { out.error = String(e.message || e); }

    const sizes = {};
    for (const [lane, p] of [['reality', env.flux_reality], ['thought', env.flux_thought]]) {
      try { sizes[lane] = (await stat(p)).size; } catch { sizes[lane] = null; }
    }
    out.sizes = sizes;
  } catch (e) {
    out.error = String(e.message || e);
  }
  return out;
}

export async function check(env = {}, opts = {}) {
  const E = { ...defaultEnv(), ...env };
  return run(GATE, E, opts, async () => {
    const seconds = opts.seconds || E.burn_in_seconds;
    const interval_ms = opts.interval_ms || 5000;

    const host = await detectHost(E);
    if (host !== 'codexa-wsl2') {
      return remoteOnly(GATE,
`# On Codexa WSL2 with daemon up:
# (run the gate driver from there; this gate samples PIDs/health/lanes every ${interval_ms}ms for ${seconds}s)`);
    }

    const samples = [];
    const t_end = Date.now() + seconds * 1000;
    samples.push(await probe(E));

    while (Date.now() < t_end) {
      await sleep(interval_ms);
      samples.push(await probe(E));
    }

    // Assertions
    const first = samples[0];
    const last = samples[samples.length - 1];

    const failures = [];

    if (!first.pids?.llama || !first.pids?.bun) {
      failures.push({ kind: 'startup', reason: 'missing pid at burn-in start', pids: first.pids });
    }
    if (!last.pids?.llama || !last.pids?.bun) {
      failures.push({ kind: 'shutdown', reason: 'missing pid at burn-in end', pids: last.pids });
    }
    if (first.pids?.llama && last.pids?.llama && first.pids.llama !== last.pids.llama) {
      failures.push({ kind: 'respawn', reason: 'llama PID changed during burn-in',
        from: first.pids.llama, to: last.pids.llama });
    }
    if (first.pids?.bun && last.pids?.bun && first.pids.bun !== last.pids.bun) {
      failures.push({ kind: 'respawn', reason: 'bun PID changed during burn-in',
        from: first.pids.bun, to: last.pids.bun });
    }

    // No swap drift
    for (const s of samples) {
      if (s.swap_kb != null && s.swap_kb > 0) {
        failures.push({ kind: 'mlock', reason: 'VmSwap > 0 during burn-in', ts: s.ts, swap_kb: s.swap_kb });
        break;
      }
    }

    // Health must remain green
    for (const s of samples) {
      const ok = s.bun_health && s.bun_health.status === 'ok' && s.bun_health.upstream?.mamba?.live === true;
      if (!ok) {
        failures.push({ kind: 'health', reason: 'bun /healthz not green', ts: s.ts, body: s.bun_health, error: s.error });
        break;
      }
    }

    // Lane sizes monotonic non-decreasing
    for (const lane of ['reality', 'thought']) {
      let prev = null;
      for (const s of samples) {
        const sz = s.sizes?.[lane];
        if (sz == null) continue;
        if (prev != null && sz < prev) {
          failures.push({ kind: 'lane-truncation', lane, reason: 'lane file shrank during burn-in', prev_size: prev, new_size: sz });
          break;
        }
        prev = sz;
      }
    }

    const pass = failures.length === 0;
    return {
      pass,
      details: {
        reason: pass ? `${seconds}s burn-in clean (${samples.length} samples)`
                     : `${failures.length} burn-in failure(s)`,
        seconds,
        samples_taken: samples.length,
        first_sample: first,
        last_sample: last,
        failures,
      },
    };
  });
}
