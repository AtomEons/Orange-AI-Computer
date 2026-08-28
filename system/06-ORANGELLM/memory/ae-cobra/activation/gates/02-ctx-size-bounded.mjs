// 02-ctx-size-bounded.mjs — verify llama-server was launched with --ctx-size <= 1024.
//
// Strategies, in order of trust:
//   (a) Query llama.cpp /props (or /v1/models) — returns the live n_ctx of the loaded model.
//   (b) Inspect the process command-line on Codexa WSL2 via /proc/<pid>/cmdline.
//   (c) Fall back to parsing bin/start.sh for the --ctx-size arg (weakest — pre-launch claim only).
//
// If we're off-host (N150), strategies (a) and (b) are unreachable → honest pass:null.

import { run, defaultEnv, detectHost, fetchT, remoteOnly } from './_lib.mjs';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = '02-ctx-size-bounded';

async function readLlamaProps(url) {
  // llama.cpp exposes /props (recent builds). Older builds: /v1/models. Try both.
  for (const p of ['/props', '/v1/models']) {
    try {
      const r = await fetchT(url + p, {}, 1500);
      if (!r.ok) continue;
      const j = await r.json().catch(() => null);
      if (!j) continue;
      // /props → { default_generation_settings: { n_ctx: ... } } OR { n_ctx: ... }
      // /v1/models → { data: [...] } (no n_ctx). Skip.
      const nctx = j?.default_generation_settings?.n_ctx ?? j?.n_ctx ?? j?.training?.n_ctx ?? null;
      if (Number.isFinite(nctx)) return { source: 'llama-props', n_ctx: Number(nctx) };
    } catch {}
  }
  return null;
}

async function readCmdline(pid) {
  try {
    const buf = await readFile(`/proc/${pid}/cmdline`);
    return buf.toString('utf8').split('\0').filter(Boolean);
  } catch { return null; }
}

function parseCtxFromArgs(args) {
  if (!args) return null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--ctx-size' || args[i] === '-c') {
      const v = Number(args[i + 1]);
      if (Number.isFinite(v)) return v;
    }
    const m = /^--ctx-size=(\d+)$/.exec(args[i]);
    if (m) return Number(m[1]);
  }
  return null;
}

async function findLlamaPid() {
  // Scan /proc for a process whose comm is llama-server. Codexa WSL2 only.
  try {
    const { readdir, readFile } = await import('node:fs/promises');
    const ents = await readdir('/proc');
    for (const e of ents) {
      if (!/^\d+$/.test(e)) continue;
      const comm = await readFile(`/proc/${e}/comm`, 'utf8').catch(() => '');
      if (comm.trim() === 'llama-server') return Number(e);
    }
  } catch {}
  return null;
}

async function readStartScriptCtx() {
  // Fallback: parse the start.sh in this repo's bin/ for --ctx-size. Weak — pre-launch only.
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const start = resolve(here, '..', '..', 'bin', 'start.sh');
    const src = await readFile(start, 'utf8');
    const m = /--ctx-size\s+["']?(\d+)["']?/.exec(src);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

export async function check(env = {}, opts = {}) {
  const E = { ...defaultEnv(), ...env };
  return run(GATE, E, opts, async () => {
    const ceiling = opts.ctx_size_max || E.ctx_size_max;

    // (a) live props
    const props = await readLlamaProps(E.llama_url);
    if (props && Number.isFinite(props.n_ctx)) {
      const pass = props.n_ctx <= ceiling;
      return {
        pass,
        details: {
          reason: pass ? 'live n_ctx within ceiling' : `live n_ctx ${props.n_ctx} > ceiling ${ceiling}`,
          source: 'llama-server/props',
          n_ctx: props.n_ctx,
          ceiling,
          llama_url: E.llama_url,
        },
      };
    }

    // (b) /proc cmdline — only on Codexa WSL2
    const host = await detectHost(E);
    if (host === 'codexa-wsl2') {
      const pid = await findLlamaPid();
      if (pid) {
        const args = await readCmdline(pid);
        const ctx = parseCtxFromArgs(args);
        if (ctx != null) {
          const pass = ctx <= ceiling;
          return {
            pass,
            details: {
              reason: pass ? 'cmdline ctx within ceiling' : `cmdline ctx ${ctx} > ceiling ${ceiling}`,
              source: '/proc/<pid>/cmdline',
              pid, n_ctx: ctx, ceiling,
            },
          };
        }
      }
    }

    // (c) Fallback: start.sh script claim. Weak. Mark pass:null when we can't verify live state.
    const script = await readStartScriptCtx();
    if (script != null) {
      const within = script <= ceiling;
      return {
        pass: null,
        details: {
          reason: 'daemon unreachable; only static start.sh value known — not a live measurement',
          source: 'bin/start.sh',
          n_ctx_declared: script,
          ceiling,
          within_ceiling_if_launched: within,
          remote_recipe:
`# On Codexa WSL2 with daemon running:
curl -s ${E.llama_url}/props | jq '.default_generation_settings.n_ctx // .n_ctx'`,
        },
      };
    }

    return remoteOnly(GATE,
`# On Codexa WSL2 with daemon running:
curl -s ${E.llama_url}/props | jq '.default_generation_settings.n_ctx // .n_ctx'
# (must be <= ${ceiling})`);
  });
}
