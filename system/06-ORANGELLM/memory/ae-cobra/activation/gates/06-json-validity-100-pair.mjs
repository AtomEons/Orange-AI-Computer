// 06-json-validity-100-pair.mjs — fire 100 GBNF-locked completions; AgentTurn JSON must validate
// (parse + minimal schema check) at >= 95%.
//
// The grammar makes structural failure rare by construction, so this gate primarily catches:
//   - grammar/schema drift
//   - field-count mismatch (e.g. risk vocabulary tightened)
//   - upstream daemon corruption
//
// Schema check is intentionally minimal here (top-level keys + types). The
// authoritative JSON Schema is at schemas/agent-turn.schema.json; we keep this
// gate self-contained to avoid a runtime AJV dep on Codexa.

import { run, defaultEnv, detectHost, now, ms, fetchT, remoteOnly } from './_lib.mjs';

const GATE = '06-json-validity-100-pair';

const REQUIRED_KEYS = ['lane', 'event_type', 'summary', 'entities', 'files', 'commands', 'risk', 'next_action', 'confidence'];
const LANES = new Set(['reality', 'thought', 'merge']);
const RISKS = new Set(['low', 'medium', 'high']);
const TYPES = new Set(['observation', 'decision', 'error', 'checkpoint', 'recall', 'receipt', 'risk']);

const PROMPTS = [
  'observe: terminal reports npm test green',
  'decide: route this through gateway',
  'recall: last sha of reality lane',
  'observation: build passed in 12s',
  'risk: outbound call without lease',
];

function shapeOk(j) {
  if (!j || typeof j !== 'object') return 'not-object';
  for (const k of REQUIRED_KEYS) if (!(k in j)) return `missing:${k}`;
  if (!LANES.has(j.lane)) return `bad-lane:${j.lane}`;
  if (!TYPES.has(j.event_type)) return `bad-event_type:${j.event_type}`;
  if (!RISKS.has(j.risk)) return `bad-risk:${j.risk}`;
  if (typeof j.summary !== 'string') return 'summary-not-string';
  if (typeof j.next_action !== 'string') return 'next_action-not-string';
  if (!Array.isArray(j.entities) || !Array.isArray(j.files) || !Array.isArray(j.commands)) return 'array-fields-wrong';
  if (typeof j.confidence !== 'number' || j.confidence < 0 || j.confidence > 1) return 'confidence-out-of-range';
  return null;
}

async function oneCompletion(env, prompt) {
  const t0 = now();
  let raw = null, status = null;
  try {
    const r = await fetchT(env.llama_url + '/completion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, n_predict: 256, temperature: 0, stream: false }),
    }, 15_000);
    status = r.status;
    if (!r.ok) return { ok: false, reason: `http-${r.status}`, latency_ms: ms(t0) };
    const j = await r.json().catch(() => null);
    raw = j?.content ?? j?.choices?.[0]?.text ?? null;
  } catch (e) {
    return { ok: false, reason: 'fetch-error', error: String(e.message || e), latency_ms: ms(t0) };
  }
  if (typeof raw !== 'string') return { ok: false, reason: 'no-content', latency_ms: ms(t0) };

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return { ok: false, reason: 'json-parse', sample: raw.slice(0, 120), latency_ms: ms(t0) }; }

  const shapeErr = shapeOk(parsed);
  if (shapeErr) return { ok: false, reason: 'shape:' + shapeErr, sample: raw.slice(0, 120), latency_ms: ms(t0) };
  return { ok: true, latency_ms: ms(t0) };
}

export async function check(env = {}, opts = {}) {
  const E = { ...defaultEnv(), ...env };
  return run(GATE, E, opts, async () => {
    const N = opts.n || 100;
    const minRate = opts.min_rate ?? E.json_validity_min;

    const host = await detectHost(E);
    if (host !== 'codexa-wsl2') {
      return remoteOnly(GATE,
`# On Codexa WSL2, with daemon up:
# (See bin/run-gates.mjs once present; this gate calls /completion 100 times.)`);
    }

    const results = [];
    let ok = 0, fail = 0;
    const failureSamples = [];
    for (let i = 0; i < N; i++) {
      const prompt = PROMPTS[i % PROMPTS.length] + ` (#${i})`;
      const r = await oneCompletion(E, prompt);
      results.push(r);
      if (r.ok) ok++; else {
        fail++;
        if (failureSamples.length < 5) failureSamples.push(r);
      }
    }
    const rate = ok / N;
    const pass = rate >= minRate;

    const latencies = results.map(r => r.latency_ms).sort((a, b) => a - b);
    const p50 = latencies[Math.floor(N * 0.5)] || 0;
    const p95 = latencies[Math.floor(N * 0.95)] || 0;

    return {
      pass,
      details: {
        reason: pass ? `validity ${(rate * 100).toFixed(1)}% >= ${(minRate * 100).toFixed(0)}%`
                     : `validity ${(rate * 100).toFixed(1)}% < ${(minRate * 100).toFixed(0)}%`,
        n: N,
        ok, fail,
        rate: +rate.toFixed(4),
        min_rate: minRate,
        latency_p50_ms: p50,
        latency_p95_ms: p95,
        failure_samples: failureSamples,
      },
    };
  });
}
