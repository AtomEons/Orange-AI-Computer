// 07-healthcheck-green.mjs — both the llama-server /health and the Bun Flow Direct /healthz
// must report green. Bun /healthz is the public health surface for the daemon.

import { run, defaultEnv, fetchT } from './_lib.mjs';

const GATE = '07-healthcheck-green';

export async function check(env = {}, opts = {}) {
  const E = { ...defaultEnv(), ...env };
  return run(GATE, E, opts, async () => {
    const probes = [];

    // Bun Flow Direct (the contract surface)
    let bun = { url: E.bun_url + '/healthz', ok: false, status: null, json: null, error: null };
    try {
      const r = await fetchT(bun.url, {}, 2000);
      bun.status = r.status;
      bun.ok = r.ok;
      bun.json = await r.json().catch(() => null);
    } catch (e) {
      bun.error = String(e.message || e);
    }
    probes.push(bun);

    // llama-server (upstream)
    let llama = { url: E.llama_url + '/health', ok: false, status: null, json: null, error: null };
    try {
      const r = await fetchT(llama.url, {}, 2000);
      llama.status = r.status;
      llama.ok = r.ok;
      llama.json = await r.json().catch(() => null);
    } catch (e) {
      llama.error = String(e.message || e);
    }
    probes.push(llama);

    // Decision: bun /healthz must return ok-shape. Per smoke-test it expects
    // { status: 'ok', upstream: { mamba: { live: true } }, lanes: {...} }.
    const bunGreen =
      bun.ok &&
      bun.json &&
      bun.json.status === 'ok' &&
      bun.json.upstream?.mamba?.live === true;

    // llama /health returns { status: 'ok' } when ready.
    const llamaGreen = llama.ok && (llama.json?.status === 'ok' || llama.json?.status === 'loading model done');

    const pass = bunGreen && llamaGreen;
    return {
      pass,
      details: {
        reason: pass ? 'both health endpoints green'
                     : `bunGreen=${bunGreen} llamaGreen=${llamaGreen}`,
        bun_healthz: bun,
        llama_health: llama,
      },
    };
  });
}
