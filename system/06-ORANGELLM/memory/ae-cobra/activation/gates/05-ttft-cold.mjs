// 05-ttft-cold.mjs — measure time-to-first-token on a cold request.
//
// "Cold" here means: the gate driver is responsible for ordering this gate
// FIRST after start.sh (or after a stop/start cycle) so the daemon hasn't
// served any completion since boot. The gate itself just measures TTFT honestly.
//
// Two paths:
//   (a) llama.cpp /completion with stream:true — measure ms until first non-empty
//       data chunk arrives. This is the right physical measurement.
//   (b) Off-host: pass:null with a remote_recipe.
//
// N150-cockpit "cold TTFT" is meaningless because the daemon doesn't live there;
// we measure on Codexa WSL2 next to the model.

import { run, defaultEnv, detectHost, now, ms, remoteOnly } from './_lib.mjs';

const GATE = '05-ttft-cold';

export async function check(env = {}, opts = {}) {
  const E = { ...defaultEnv(), ...env };
  return run(GATE, E, opts, async () => {
    const max_s = opts.ttft_cold_max_s || E.ttft_cold_max_s;
    const host = await detectHost(E);

    if (host !== 'codexa-wsl2') {
      return remoteOnly(GATE,
`# On Codexa WSL2, immediately after start.sh (cold):
curl -sN ${E.llama_url}/completion \\
  -H 'Content-Type: application/json' \\
  -d '{"prompt":"hi","n_predict":1,"stream":true}' \\
  | awk 'BEGIN{t0=systime()} /^data: /{print systime()-t0; exit}'
# (must be < ${max_s}s)`);
    }

    const url = E.llama_url + '/completion';
    const body = JSON.stringify({
      prompt: opts.prompt || 'ok',
      n_predict: 1,
      stream: true,
      temperature: 0,
    });

    const ac = new AbortController();
    const hardTimer = setTimeout(() => ac.abort(), Math.max(2000, max_s * 1000 * 3));
    const t0 = now();

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: ac.signal,
      });
    } catch (e) {
      clearTimeout(hardTimer);
      return { pass: false, details: { reason: 'fetch failed (daemon down?)', error: String(e.message || e) } };
    }

    if (!res.ok || !res.body) {
      clearTimeout(hardTimer);
      return { pass: false, details: { reason: 'non-ok response', status: res.status } };
    }

    // Read the first SSE chunk that contains a non-empty token.
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let ttft_ms = null;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        // SSE: "data: {json}\n\n"
        const idx = buf.indexOf('\n\n');
        if (idx !== -1) {
          const evt = buf.slice(0, idx);
          // Look for first non-empty content / token field
          const m = /^data:\s*(.*)$/m.exec(evt);
          if (m) {
            try {
              const j = JSON.parse(m[1]);
              const tok = j.content ?? j.token ?? j.choices?.[0]?.delta?.content ?? '';
              if (typeof tok === 'string' && tok.length > 0) {
                ttft_ms = ms(t0);
                break;
              }
              if (j.stop === true) { ttft_ms = ms(t0); break; }
            } catch {
              // malformed event — keep reading
            }
            buf = buf.slice(idx + 2);
          } else {
            buf = buf.slice(idx + 2);
          }
        }
      }
    } finally {
      clearTimeout(hardTimer);
      try { await reader.cancel(); } catch {}
    }

    if (ttft_ms == null) {
      return { pass: false, details: { reason: 'no token observed before stream end', max_s } };
    }

    const pass = (ttft_ms / 1000) < max_s;
    return {
      pass,
      details: {
        reason: pass ? `ttft ${ttft_ms}ms < ${max_s}s` : `ttft ${ttft_ms}ms >= ${max_s}s`,
        ttft_ms,
        max_s,
        cold_assumption: 'driver must run this gate first after start.sh — gate cannot self-verify cold state',
      },
    };
  });
}
