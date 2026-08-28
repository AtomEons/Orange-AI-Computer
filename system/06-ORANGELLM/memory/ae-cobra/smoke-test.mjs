// smoke-test.mjs — quick verification that Æ Cobra is alive and writing Flux correctly.
// Run with: bun smoke-test.mjs

const BASE = process.env.AE_COBRA_BASE || 'http://127.0.0.1:7419';

async function step(label, fn) {
  process.stdout.write(`[ ] ${label} ... `);
  try {
    const r = await fn();
    console.log(`OK${r ? ' — ' + r : ''}`);
    return true;
  } catch (e) {
    console.log(`FAIL — ${e.message}`);
    return false;
  }
}

let passed = 0, total = 0;
async function go(label, fn) { total++; if (await step(label, fn)) passed++; }

await go('healthz', async () => {
  const r = await fetch(`${BASE}/healthz`).then(r => r.json());
  if (r.status !== 'ok') throw new Error(`status=${r.status}`);
  if (!r.upstream?.processor?.live) throw new Error('configured processor upstream not live');
  if (r.upstream?.mamba?.configured && !r.upstream.mamba.live) {
    throw new Error('configured mamba upstream not live');
  }
  return `lanes: ${JSON.stringify(r.lanes)}`;
});

await go('event — terminal origin → Reality lane', async () => {
  const r = await fetch(`${BASE}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      origin: 'terminal',
      event: { stdout: 'npm test passed: 7/7 green', exit_code: 0 },
    }),
  }).then(r => r.json());
  if (!r.ok || !r.accepted) throw new Error(`rejected: ${r.reason || JSON.stringify(r.reasons)}`);
  if (r.lane !== 'reality') throw new Error(`wrong lane: ${r.lane}`);
  return `id=${r.id} score=${r.score}`;
});

await go('event — orangellm_reasoning origin → Thought lane', async () => {
  const r = await fetch(`${BASE}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      origin: 'orangellm_reasoning',
      event: {
        summary: 'Model routing option reviewed against current utility constraints',
        reasoning: 'considering swapping Smart Skinny to qwen3:1.7b for utility',
      },
    }),
  }).then(r => r.json());
  if (!r.ok || !r.accepted) throw new Error(`rejected: ${r.reason || JSON.stringify(r.reasons)}`);
  if (r.lane !== 'thought') throw new Error(`wrong lane: ${r.lane}`);
  return `id=${r.id} score=${r.score}`;
});

await go('event — fake-green word → CLR reject', async () => {
  const r = await fetch(`${BASE}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      origin: 'orangellm_reasoning',
      event: { reasoning: 'this should_work and probably looks_ok, green_assumed' },
    }),
  }).then(r => r.json());
  if (r.accepted) throw new Error('CLR FAILED to reject fake-green content');
  return `rejected (score=${r.score})`;
});

await go('state-brief — recent events', async () => {
  const r = await fetch(`${BASE}/state-brief`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '', time_range_ms: 3600 * 1000, max_records: 20 }),
  }).then(r => r.json());
  if (!Array.isArray(r.reality) || !Array.isArray(r.thought)) throw new Error('invalid StateBrief shape');
  return `reality=${r.reality.length} thought=${r.thought.length}`;
});

await go('verify-chain — Reality lane intact', async () => {
  const r = await fetch(`${BASE}/verify-chain`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lane: 'reality' }),
  }).then(r => r.json());
  if (!r.ok) throw new Error(`chain broken: ${JSON.stringify(r.broken)}`);
  return `count=${r.count}`;
});

console.log(`\n${passed}/${total} smoke tests passed.`);
if (passed === total) {
  console.log('Æ Cobra Night-1 is alive. Receipt-worthy.');
  process.exit(0);
} else {
  console.log('Some checks failed. Æ Cobra is NOT green.');
  process.exit(1);
}
