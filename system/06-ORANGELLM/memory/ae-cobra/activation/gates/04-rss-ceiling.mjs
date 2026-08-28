// 04-rss-ceiling.mjs — total daemon resident set must stay <= 10 GB.
//
// Sums VmRSS of llama-server + the Bun Flow Direct process (any node/bun whose
// argv includes flow-direct/server.mjs). Codexa WSL2 only.

import { run, defaultEnv, detectHost, remoteOnly } from './_lib.mjs';
import { readFile, readdir } from 'node:fs/promises';

const GATE = '04-rss-ceiling';

function kbFromStatus(text, key) {
  const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
  return m ? Number(m[1]) : 0;
}

async function listPids() {
  const ents = await readdir('/proc');
  return ents.filter(e => /^\d+$/.test(e)).map(Number);
}

async function describePid(pid) {
  const comm = await readFile(`/proc/${pid}/comm`, 'utf8').catch(() => '');
  const cmd  = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
  const stat = await readFile(`/proc/${pid}/status`, 'utf8').catch(() => '');
  return { pid, comm: comm.trim(), cmdline: cmd.split('\0').filter(Boolean), rss_kb: kbFromStatus(stat, 'VmRSS') };
}

export async function check(env = {}, opts = {}) {
  const E = { ...defaultEnv(), ...env };
  return run(GATE, E, opts, async () => {
    const ceiling_gb = opts.rss_ceiling_gb || E.rss_ceiling_gb;
    const ceiling_kb = ceiling_gb * 1024 * 1024;

    const host = await detectHost(E);
    if (host !== 'codexa-wsl2') {
      return remoteOnly(GATE,
`# On Codexa WSL2:
ps -e -o pid,comm,rss,args | awk '$2=="llama-server" || /flow-direct\\/server\\.mjs/ {sum+=$3; print} END {print "total_kb=" sum}'`);
    }

    const pids = await listPids();
    const matches = [];
    for (const pid of pids) {
      const d = await describePid(pid);
      if (!d) continue;
      const isLlama = d.comm === 'llama-server';
      const isBun   = (d.comm === 'bun' || d.comm === 'node') &&
                      d.cmdline.some(a => /flow-direct\/server\.mjs$/.test(a));
      if (isLlama || isBun) matches.push({ ...d, role: isLlama ? 'llama' : 'bun' });
    }

    const total_kb = matches.reduce((s, m) => s + (m.rss_kb || 0), 0);
    const total_gb = total_kb / 1024 / 1024;

    if (matches.length === 0) {
      return { pass: false, details: { reason: 'no daemon processes found', ceiling_gb } };
    }

    const pass = total_kb <= ceiling_kb;
    return {
      pass,
      details: {
        reason: pass
          ? `total ${total_gb.toFixed(2)} GiB <= ceiling ${ceiling_gb} GiB`
          : `total ${total_gb.toFixed(2)} GiB EXCEEDS ceiling ${ceiling_gb} GiB`,
        ceiling_gb,
        total_kb,
        total_gb: +total_gb.toFixed(3),
        processes: matches.map(m => ({ pid: m.pid, role: m.role, rss_kb: m.rss_kb })),
      },
    };
  });
}
