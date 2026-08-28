// 11-loopback-only.mjs — neither llama-server nor Bun Flow Direct may listen on
// anything other than 127.0.0.1 / ::1. Exposure to LAN must happen via the WSL2
// port-forward (controlled outside the daemon) and the gateway proxy — never by
// the daemon binding 0.0.0.0.
//
// Codexa WSL2 truth source:
//   ss -ltnp     → bound addresses for tcp listeners
//   /proc/<pid>/net/tcp(6) → fallback parser
//
// We accept these binds:
//   127.0.0.1:7418 (llama)   127.0.0.1:7419 (bun)   ::1:* (loopback v6)
// We reject:
//   0.0.0.0:*    LAN IPs on the WSL2 interface    any external bind on these ports
//
// Off-host: pass:null with remote_recipe.

import { run, defaultEnv, detectHost, remoteOnly } from './_lib.mjs';
import { readFile, readdir } from 'node:fs/promises';

const GATE = '11-loopback-only';

function ipFromHex(hex, v6 = false) {
  if (!v6) {
    // /proc/net/tcp uses host-endian little-endian for the ip field
    const b = hex.match(/.{2}/g).reverse().map(s => parseInt(s, 16));
    return b.join('.');
  } else {
    // /proc/net/tcp6 is 32 hex chars, grouped little-endian per 32-bit word
    const words = hex.match(/.{8}/g).map(w => w.match(/.{2}/g).reverse().join(''));
    const joined = words.join('');
    const segs = [];
    for (let i = 0; i < 16; i += 2) segs.push(joined.slice(i * 2, i * 2 + 4));
    return segs.join(':');
  }
}

function isLoopback(ip) {
  if (!ip) return false;
  if (ip === '127.0.0.1') return true;
  if (ip.startsWith('127.')) return true;
  if (ip === '::1') return true;
  if (/^0{1,4}(?::0{1,4})*:1$/.test(ip)) return true; // 0:0:...:1
  return false;
}

async function inodesForPid(pid) {
  try {
    const fds = await readdir(`/proc/${pid}/fd`);
    const out = new Set();
    for (const fd of fds) {
      const target = await (await import('node:fs/promises')).readlink(`/proc/${pid}/fd/${fd}`).catch(() => '');
      const m = /^socket:\[(\d+)\]$/.exec(target);
      if (m) out.add(m[1]);
    }
    return out;
  } catch { return new Set(); }
}

async function listListeners() {
  // Returns [{ ip, port, inode, v6 }]
  const out = [];
  for (const [path, v6] of [['/proc/net/tcp', false], ['/proc/net/tcp6', true]]) {
    let src;
    try { src = await readFile(path, 'utf8'); } catch { continue; }
    const lines = src.split('\n').slice(1).filter(Boolean);
    for (const ln of lines) {
      const cols = ln.trim().split(/\s+/);
      // local_address remote_address st ... inode
      const [, local,, st,,,,,, inode] = cols;
      if (st !== '0A') continue; // 0A = LISTEN
      const [ipHex, portHex] = local.split(':');
      const ip = ipFromHex(ipHex, v6);
      const port = parseInt(portHex, 16);
      out.push({ ip, port, inode, v6 });
    }
  }
  return out;
}

async function findDaemonPids() {
  const pids = [];
  try {
    const ents = await readdir('/proc');
    for (const e of ents) {
      if (!/^\d+$/.test(e)) continue;
      const comm = await readFile(`/proc/${e}/comm`, 'utf8').catch(() => '');
      const cmd  = await readFile(`/proc/${e}/cmdline`, 'utf8').catch(() => '');
      if (comm.trim() === 'llama-server') pids.push({ pid: Number(e), role: 'llama' });
      else if ((comm.trim() === 'bun' || comm.trim() === 'node') && /flow-direct\/server\.mjs/.test(cmd))
        pids.push({ pid: Number(e), role: 'bun' });
    }
  } catch {}
  return pids;
}

export async function check(env = {}, opts = {}) {
  const E = { ...defaultEnv(), ...env };
  return run(GATE, E, opts, async () => {
    const host = await detectHost(E);
    if (host !== 'codexa-wsl2') {
      return remoteOnly(GATE,
`# On Codexa WSL2:
ss -ltnp | awk 'NR>1 {print $4, $7}'
# Expect llama-server -> 127.0.0.1:7418 and bun -> 127.0.0.1:7419 (or [::1]:*). Nothing on 0.0.0.0.`);
    }

    const listeners = await listListeners();
    const daemons = await findDaemonPids();

    const associations = [];
    for (const d of daemons) {
      const inodes = await inodesForPid(d.pid);
      const own = listeners.filter(l => inodes.has(l.inode));
      associations.push({ ...d, listeners: own });
    }

    const offenders = [];
    for (const a of associations) {
      for (const l of a.listeners) {
        if (!isLoopback(l.ip)) {
          offenders.push({ role: a.role, pid: a.pid, ip: l.ip, port: l.port, v6: l.v6 });
        }
      }
    }

    const noListeners = associations.every(a => a.listeners.length === 0);
    if (noListeners) {
      return { pass: false, details: { reason: 'no daemon listeners found (daemon down?)', associations } };
    }

    const pass = offenders.length === 0;
    return {
      pass,
      details: {
        reason: pass ? 'all daemon listeners bound to loopback'
                     : `${offenders.length} non-loopback bind(s) detected`,
        associations,
        offenders,
      },
    };
  });
}
