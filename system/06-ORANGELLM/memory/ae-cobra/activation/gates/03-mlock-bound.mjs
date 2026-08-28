// 03-mlock-bound.mjs — verify llama-server has mlock-pinned its weights.
//
// Truth source: /proc/<pid>/status on Codexa WSL2 — fields VmLck (>0) and VmSwap (==0).
// Belt-and-suspenders: check that --mlock is on the cmdline.
//
// Off-host: pass:null with a remote_recipe.

import { run, defaultEnv, detectHost, remoteOnly } from './_lib.mjs';
import { readFile, readdir } from 'node:fs/promises';

const GATE = '03-mlock-bound';

async function findLlamaPid() {
  try {
    const ents = await readdir('/proc');
    for (const e of ents) {
      if (!/^\d+$/.test(e)) continue;
      const comm = await readFile(`/proc/${e}/comm`, 'utf8').catch(() => '');
      if (comm.trim() === 'llama-server') return Number(e);
    }
  } catch {}
  return null;
}

function parseKb(statusText, key) {
  const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(statusText);
  return m ? Number(m[1]) : null;
}

export async function check(env = {}, opts = {}) {
  const E = { ...defaultEnv(), ...env };
  return run(GATE, E, opts, async () => {
    const host = await detectHost(E);
    if (host !== 'codexa-wsl2') {
      return remoteOnly(GATE,
`# On Codexa WSL2:
pid=$(pgrep -x llama-server | head -1)
grep -E '^(VmLck|VmSwap):' /proc/$pid/status
tr '\\0' ' ' < /proc/$pid/cmdline | grep -- '--mlock'`);
    }

    const pid = await findLlamaPid();
    if (!pid) return { pass: false, details: { reason: 'llama-server not running' } };

    const status = await readFile(`/proc/${pid}/status`, 'utf8').catch(() => '');
    const vmLck = parseKb(status, 'VmLck');
    const vmSwap = parseKb(status, 'VmSwap');
    const vmRss  = parseKb(status, 'VmRSS');

    const cmd = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
    const mlockFlag = cmd.split('\0').includes('--mlock');

    const locked = (vmLck ?? 0) > 0;
    const noSwap = (vmSwap ?? 0) === 0;
    const pass = locked && noSwap && mlockFlag;

    return {
      pass,
      details: {
        reason: pass ? 'mlock active, no swap, flag present' :
                       `mlock check failed: locked=${locked} noSwap=${noSwap} flag=${mlockFlag}`,
        pid,
        VmLck_kB: vmLck,
        VmSwap_kB: vmSwap,
        VmRSS_kB: vmRss,
        mlock_flag: mlockFlag,
      },
    };
  });
}
