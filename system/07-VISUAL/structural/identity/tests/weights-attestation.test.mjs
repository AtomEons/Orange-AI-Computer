// weights-attestation.test.mjs
//
// The invariant: a store cannot lie about what it is. A fitted store cannot
// look default; a default store cannot look fitted. An old store predating
// provenance must not silently default to "clean" — that would be the exact
// fake-green the attestation exists to stop.
//
// Run: bun 07-VISUAL/structural/identity/tests/weights-attestation.test.mjs

import {
  attachSignaturesV2, updateChannelWeights, weightsAttestation,
  DEFAULT_CHANNEL_WEIGHTS,
} from '../identity-store-v2.mjs';
import { applyLearnedWeights } from '../second-pass-alpha.mjs';

let pass = 0, fail = 0;
function t(n, f) { try { f(); console.log(`  PASS  ${n}`); pass++; } catch (e) { console.log(`  FAIL  ${n}\n        ${e.message}`); fail++; } }
function assert(c, m) { if (!c) throw new Error(m); }

console.log('\nweights-attestation — a store must be able to say what it is\n');

// tiny helper — a signature shape the store will accept
const sig = () => ({
  color: [0.5, 0.5, 0.5], edge: 0.1, texture: 0.1, specular: 0.1, spatial: 0.1,
  subsurface: 0, colorRatio: 0, spatialFreq: 0, retinal12: {},
});
const build = () => {
  const store = { labels: [] };
  for (const l of ['apple', 'orange', 'lemon']) attachSignaturesV2(store, l, [sig()], 'test');
  return store;
};

// ── DEFAULT_ONLY — nothing was ever changed ────────────────────────────────
t('a fresh store attests DEFAULT_ONLY', () => {
  const a = weightsAttestation(build());
  assert(a.status === 'DEFAULT_ONLY', `expected DEFAULT_ONLY, got ${a.status}`);
  assert(a.learned.length === 0 && a.manual.length === 0 && a.unknown.length === 0);
  assert(/no.*fitted per-concept parameter/i.test(a.claim), 'claim must state the honest bottom line');
});

// ── CONTAINS_FITTED_WEIGHTS — the important one ─────────────────────────────
t('applyLearnedWeights stamps CONTAINS_FITTED_WEIGHTS — the whole point', () => {
  const store = build();
  const learned = new Map([['apple', { color: 3.0, edge: 0.1 }], ['orange', { color: 2.5 }]]);
  applyLearnedWeights(store, learned);
  const a = weightsAttestation(store);
  assert(a.status === 'CONTAINS_FITTED_WEIGHTS', `expected CONTAINS_FITTED_WEIGHTS, got ${a.status}`);
  assert(a.learned.length === 2, 'apple + orange are fitted');
  assert(/fitted per-concept parameters at eval time/i.test(a.claim),
    'claim must warn that recognition uses fitted parameters');
});

t('applyLearnedWeights records a "learned" provenance entry per concept', () => {
  const store = build();
  applyLearnedWeights(store, new Map([['apple', { color: 3 }]]));
  const row = store.labels.find(r => r.label === 'apple');
  assert(Array.isArray(row.weight_provenance), 'provenance array must exist');
  assert(row.weight_provenance.some(p => p.source === 'learned'),
    'source MUST be "learned" — mislabeling fitted weights as manual is worse than not stamping');
});

// ── MANUALLY_TUNED ──────────────────────────────────────────────────────────
t('manual updates stamp MANUALLY_TUNED, not CONTAINS_FITTED_WEIGHTS', () => {
  const store = build();
  updateChannelWeights(store, 'apple', { color: 2.0 }, 'manual', 'operator choice');
  const a = weightsAttestation(store);
  assert(a.status === 'MANUALLY_TUNED', `expected MANUALLY_TUNED, got ${a.status}`);
  assert(a.manual.length === 1 && a.learned.length === 0, 'must not conflate manual with fitted');
});

// ── UNKNOWN_PRE_PROVENANCE — the honest line ────────────────────────────────
t('non-default weights without provenance ⇒ UNKNOWN_PRE_PROVENANCE (never silently DEFAULT_ONLY)', () => {
  // Simulate a store that predates the stamp: mutate .channel_weights directly.
  const store = build();
  const row = store.labels.find(r => r.label === 'apple');
  row.channel_weights = { ...row.channel_weights, color: 4.2 };  // altered, unstamped
  const a = weightsAttestation(store);
  assert(a.status === 'UNKNOWN_PRE_PROVENANCE',
    `MUST be UNKNOWN_PRE_PROVENANCE — defaulting to DEFAULT_ONLY would be the fake-green this exists to stop; got ${a.status}`);
  assert(/CANNOT be established/i.test(a.claim),
    'claim must plainly state the origin cannot be verified from the artifact');
});

// ── weight_provenance is append-only ────────────────────────────────────────
t('weight_provenance is append-only — history of every change survives', () => {
  const store = build();
  updateChannelWeights(store, 'apple', { color: 1.5 }, 'manual', 'first');
  updateChannelWeights(store, 'apple', { color: 2.5 }, 'manual', 'second');
  applyLearnedWeights(store, new Map([['apple', { edge: 0.9 }]]));
  const row = store.labels.find(r => r.label === 'apple');
  assert(row.weight_provenance.length === 3, `expected 3 entries, got ${row.weight_provenance.length}`);
  assert(row.weight_provenance[0].note === 'first', 'first entry preserved');
  assert(row.weight_provenance[2].source === 'learned', 'latest reflects the learned pass');
});

// ── provenance records only actually-changed keys ───────────────────────────
t('the "changed" list captures only keys that actually moved', () => {
  const store = build();
  const row = store.labels.find(r => r.label === 'apple');
  const beforeColor = row.channel_weights.color;
  // "change" color to its existing value; touch edge for real
  updateChannelWeights(store, 'apple', { color: beforeColor, edge: 0.99 }, 'manual');
  const entry = row.weight_provenance[0];
  assert(entry.changed.includes('edge'), 'edge changed');
  assert(!entry.changed.includes('color'), 'color did not actually change');
});

// ── missing label is a no-op, not a crash ───────────────────────────────────
t('updating a non-existent label returns null cleanly', () => {
  const store = build();
  const result = updateChannelWeights(store, 'does-not-exist', { color: 1 }, 'manual');
  assert(result === null, 'must return null, not throw');
});

console.log(`\nSummary: ${pass} pass / ${fail} fail of ${pass + fail}\n`);
if (fail > 0) process.exit(1);
