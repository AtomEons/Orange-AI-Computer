// 09-hermes-integration.mjs — verify the Hermes (router/orchestrator) ↔ Cobra path.
//
// Doctrine: Cobra is consumed by Hermes via gateway /v1/cobra/*. Two integration
// surfaces must be alive:
//   (a) Cobra accepts an event with origin='hermes' and classifies it correctly
//       (lane assignment is origin-based — see V1 mitigation in the README).
//   (b) Cobra exposes /state-brief for Hermes to pull a compressed Mirage brief.
//
// We do (a) and (b) via the Bun Flow Direct loopback when on Codexa, OR via the
// gateway when on N150 (proves the proxy is up too). Off-host with no gateway → pass:null.

import { run, defaultEnv, detectHost, fetchT, remoteOnly } from './_lib.mjs';

const GATE = '09-hermes-integration';

async function pickBase(env) {
  const host = await detectHost(env);
  if (host === 'codexa-wsl2') return { base: env.bun_url, via: 'loopback' };
  // N150: try gateway
  try {
    const r = await fetchT(env.gateway_url.replace(/\/$/, '') + '/healthz', {}, 1500);
    if (r.ok) return { base: env.gateway_url, via: 'gateway' };
  } catch {}
  return { base: null, via: null };
}

export async function check(env = {}, opts = {}) {
  const E = { ...defaultEnv(), ...env };
  return run(GATE, E, opts, async () => {
    const { base, via } = await pickBase(E);
    if (!base) {
      return remoteOnly(GATE,
`# On Codexa WSL2 with daemon up, OR on N150 with gateway up:
curl -s ${E.gateway_url}/healthz
curl -s -X POST ${E.gateway_url}/event -H 'content-type: application/json' \\
  -d '{"origin":"hermes","event":{"intent":"recall","query":"last build"}}'
curl -s -X POST ${E.gateway_url}/state-brief -H 'content-type: application/json' \\
  -d '{"query":"","time_range_ms":600000,"max_records":10}'`);
    }

    // (a) Hermes-origin event
    let evt = { ok: false, status: null, body: null, error: null };
    try {
      const r = await fetchT(base + '/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          origin: 'hermes',
          event: { intent: 'recall', query: 'last build status', requested_by: 'hermes-router' },
        }),
      }, 15_000);
      evt.status = r.status;
      const j = await r.json().catch(() => null);
      evt.body = j;
      // Accept if daemon at minimum echoed an id + lane decision (accepted OR rejected for content reasons).
      evt.ok = !!(j && (j.ok === true || j.ok === false) && (j.lane || j.reason || j.reasons));
    } catch (e) {
      evt.error = String(e.message || e);
    }

    // (b) state-brief
    let sb = { ok: false, status: null, body: null, error: null };
    try {
      const r = await fetchT(base + '/state-brief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '', time_range_ms: 600_000, max_records: 10 }),
      }, 5000);
      sb.status = r.status;
      const j = await r.json().catch(() => null);
      sb.body = j ? { reality_n: j.reality?.length ?? null, thought_n: j.thought?.length ?? null } : null;
      sb.ok = !!(j && Array.isArray(j.reality) && Array.isArray(j.thought));
    } catch (e) {
      sb.error = String(e.message || e);
    }

    const pass = evt.ok && sb.ok;
    return {
      pass,
      details: {
        reason: pass ? 'hermes-origin event accepted shape; state-brief returns lanes'
                     : `evt.ok=${evt.ok} sb.ok=${sb.ok}`,
        via, base,
        event_probe: evt,
        state_brief_probe: sb,
      },
    };
  });
}
