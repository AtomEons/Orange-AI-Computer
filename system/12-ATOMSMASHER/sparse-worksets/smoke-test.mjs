// sparse-worksets/smoke-test.mjs
//
// AtomSmasher Sparse Worksets — end-to-end smoke test.
//
// Exercises the LIVE round-trip:
//   compressWorkset({task, context}, opts)
//     -> validateWorkset(result)
//       -> determinism, pin, budget, fluff-reject, accounting-integrity asserts
//
// Doctrine asserted:
//   - Identical (task, context, opts) => identical workset_id (determinism).
//   - Property: working_set.length + dropped.length === context.length (no
//     silent drops).
//   - Every entry in `dropped` carries a non-empty `reason` string.
//   - Pinned items are never relevance-dropped.
//   - Items whose only content is fluff or empty are dropped with explicit
//     reason ('fluff_only' / 'empty'), not silently kept.
//   - When all items declare `size`, `compression_ratio_bytes` is reported
//     and matches kept_bytes / input_bytes.
//   - When budget is exceeded by relevance-kept items, the lowest-scored
//     non-pinned items get reason 'over_budget'; pinned items survive even
//     over budget but emit `over_budget_pinned` in warnings.
//   - Task consisting only of fluff (e.g. "do the thing.") throws.
//
// Run with: node 12-ATOMSMASHER/sparse-worksets/smoke-test.mjs
// Exits non-zero on any failure. No test framework dep.

import {
  compressWorkset,
  validateWorkset,
  __internals,
} from './compressor.mjs';

// ---------------------------------------------------------------------------
// Test plumbing
// ---------------------------------------------------------------------------

let failed = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

function expectThrow(label, fn) {
  let threw = false;
  let msg = '';
  try {
    fn();
  } catch (e) {
    threw = true;
    msg = e?.message || String(e);
  }
  check(label, threw, threw ? `(threw: ${msg.slice(0, 80)})` : 'did not throw');
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const TASK = 'Compile the AtomSmasher Sparse Worksets module and verify hash chain integrity.';

const CONTEXT = [
  // Strong relevance — overlaps with task on atomsmasher / sparse / worksets / hash / integrity.
  {
    id: 'spec',
    content: 'AtomSmasher Sparse Worksets compress task plus context to the minimum needed working set with hash integrity.',
    tag: 'spec',
    size: 110,
  },
  // Strong relevance.
  {
    id: 'integrity_note',
    content: 'Hash chain integrity is verified by recomputing sha256 over canonical JSON of each atom.',
    tag: 'doctrine',
    size: 92,
  },
  // Moderate relevance — names "module" and "compile" only.
  {
    id: 'build_note',
    content: 'Compile the module under 12-ATOMSMASHER and run smoke-test against the local Reality lane.',
    tag: 'op',
    size: 96,
  },
  // Pinned, low relevance — should survive on the pin.
  {
    id: 'license_header',
    content: 'Copyright 2026 AtomEons. All rights reserved.',
    tag: 'legal',
    pinned: true,
    size: 50,
  },
  // Low relevance.
  {
    id: 'unrelated_recipe',
    content: 'Saute onions in olive oil over medium heat until translucent, about six minutes.',
    tag: 'noise',
    size: 80,
  },
  // Fluff-only — should be dropped with reason 'fluff_only'.
  {
    id: 'fluff_item',
    content: 'do the thing',
    tag: 'noise',
    size: 12,
  },
  // Empty content — should be dropped with reason 'empty'.
  {
    id: 'empty_item',
    content: '   ',
    tag: 'noise',
    size: 4,
  },
];

// ---------------------------------------------------------------------------
// 1. Happy path: compress, validate, basic invariants
// ---------------------------------------------------------------------------
console.log('1. happy path compress + validate');

const r1 = compressWorkset({ task: TASK, context: CONTEXT });
check('returns object', r1 && typeof r1 === 'object');
check('schema id present', r1.schema === __internals.WORKSET_SCHEMA_ID);
check('workset_id is sha256', /^[a-f0-9]{64}$/.test(r1.workset_id));
check('working_set is array', Array.isArray(r1.working_set));
check('dropped is array', Array.isArray(r1.dropped));
check(
  'kept + dropped === input',
  r1.working_set.length + r1.dropped.length === CONTEXT.length,
  `kept=${r1.working_set.length}, dropped=${r1.dropped.length}, input=${CONTEXT.length}`,
);
check(
  'compression_ratio in [0,1]',
  r1.compression_ratio >= 0 && r1.compression_ratio <= 1,
  `ratio=${r1.compression_ratio}`,
);
check(
  'kept count < input count (real compression happened)',
  r1.working_set.length < CONTEXT.length,
);

const v1 = validateWorkset(r1);
check('validateWorkset returns valid', v1.valid, JSON.stringify(v1.errors));

// Every dropped item carries a real reason string.
let allReasonsOk = r1.dropped.length > 0;
for (const d of r1.dropped) {
  if (!d.reason || typeof d.reason !== 'string' || d.reason.length === 0) {
    allReasonsOk = false;
    break;
  }
}
check('every dropped item has non-empty reason', allReasonsOk);

// Strong-relevance items kept.
const keptIds = new Set(r1.working_set.map((w) => w.id));
check('spec kept', keptIds.has('spec'));
check('integrity_note kept', keptIds.has('integrity_note'));
check('build_note kept', keptIds.has('build_note'));

// Pinned item kept regardless of low relevance.
check('pinned license_header kept', keptIds.has('license_header'));

// Fluff + empty dropped with explicit reasons.
const dropMap = new Map(r1.dropped.map((d) => [d.id, d.reason]));
check('fluff_item dropped as fluff_only', dropMap.get('fluff_item') === 'fluff_only');
check('empty_item dropped as empty', dropMap.get('empty_item') === 'empty');
check(
  'unrelated_recipe dropped (low_relevance or no_content_tokens)',
  ['low_relevance', 'no_content_tokens'].includes(dropMap.get('unrelated_recipe')),
);

// Byte-ratio reporting works because every item has size.
check(
  'compression_ratio_bytes is a number when all sizes present',
  typeof r1.compression_ratio_bytes === 'number',
);
const expectedKeptBytes = r1.working_set.reduce((acc, it) => acc + it.size, 0);
const expectedInputBytes = CONTEXT.reduce((acc, it) => acc + it.size, 0);
check(
  'kept_bytes matches working_set sum',
  r1.stats.kept_bytes === expectedKeptBytes,
  `stats=${r1.stats.kept_bytes}, computed=${expectedKeptBytes}`,
);
check(
  'input_bytes matches context sum',
  r1.stats.input_bytes === expectedInputBytes,
);
check(
  'compression_ratio_bytes ≈ kept_bytes / input_bytes',
  Math.abs(r1.compression_ratio_bytes - expectedKeptBytes / expectedInputBytes) < 1e-6,
);

// ---------------------------------------------------------------------------
// 2. Determinism: identical inputs => identical workset_id
// ---------------------------------------------------------------------------
console.log('2. determinism');

const r1b = compressWorkset({ task: TASK, context: CONTEXT });
check('identical inputs yield identical workset_id', r1b.workset_id === r1.workset_id);
check('identical inputs yield identical compression_ratio', r1b.compression_ratio === r1.compression_ratio);
check(
  'identical inputs yield identical working_set order',
  JSON.stringify(r1b.working_set.map((w) => w.id)) ===
    JSON.stringify(r1.working_set.map((w) => w.id)),
);

// Different task with same context => different workset_id.
// NOTE: the rule-based scorer matches literal tokens (no stemming). The task
// uses the exact words ("saute onions olive oil") that appear in the
// unrelated_recipe item, so it should flip from low_relevance to kept.
const r1c = compressWorkset({
  task: 'Saute onions in olive oil for kitchen preparation translucent.',
  context: CONTEXT,
});
check('different task yields different workset_id', r1c.workset_id !== r1.workset_id);
// And — this is a real signal — the relevance flip should let the recipe in.
const r1cKept = new Set(r1c.working_set.map((w) => w.id));
check('recipe context kept under recipe task', r1cKept.has('unrelated_recipe'));

// ---------------------------------------------------------------------------
// 3. Budget enforcement
// ---------------------------------------------------------------------------
console.log('3. budget enforcement');

// Relevance-pass would keep spec(110)+integrity_note(92)+build_note(96)+license_header(50)
//   = 348 bytes. With budget=200, lowest-scored non-pinned should drop with
//   reason 'over_budget'. license_header is pinned so it survives.
const r2 = compressWorkset({ task: TASK, context: CONTEXT }, { budget: 200 });
const overBudget = r2.dropped.filter((d) => d.reason === 'over_budget');
check('over_budget drops occur when budget exceeded', overBudget.length >= 1);

const r2KeptBytes = r2.stats.kept_bytes;
// Pinned override may push us over the literal budget — that's by design — but
// the working set without the pinned item must fit.
const r2NonPinnedBytes = r2.working_set
  .filter((w) => !w.pinned)
  .reduce((acc, it) => acc + it.size, 0);
check(
  'non-pinned kept bytes <= budget',
  r2NonPinnedBytes <= 200,
  `non-pinned=${r2NonPinnedBytes}`,
);
check('pinned license_header survived over budget', new Set(r2.working_set.map((w) => w.id)).has('license_header'));

// If the pin alone exceeds the budget, we should see an over_budget_pinned warning.
const r3 = compressWorkset(
  {
    task: TASK,
    context: [{ id: 'big_pin', content: 'integrity hash AtomSmasher sparse worksets', pinned: true, size: 9999 }],
  },
  { budget: 100 },
);
const pinnedWarn = r3.warnings.find((w) => w.startsWith('over_budget_pinned'));
check('over_budget_pinned warning when pin exceeds budget', !!pinnedWarn);
check('pinned item kept even when alone exceeds budget', r3.working_set.some((w) => w.id === 'big_pin'));

// If any item lacks a size, the budget refuses to trim and emits a warning.
const r4 = compressWorkset(
  {
    task: TASK,
    context: [
      { id: 'a', content: 'AtomSmasher sparse worksets module', size: 50 },
      { id: 'b', content: 'AtomSmasher hash integrity verification', /* no size */ },
    ],
  },
  { budget: 10 },
);
check(
  'budget refuses to trim when any kept item lacks size',
  r4.warnings.some((w) => w.startsWith('budget_not_enforced')),
);

// ---------------------------------------------------------------------------
// 4. Task input hardening
// ---------------------------------------------------------------------------
console.log('4. task input hardening');

expectThrow('empty task throws', () => compressWorkset({ task: '', context: [] }));
expectThrow('fluff-only task throws', () =>
  compressWorkset({ task: 'do the thing.', context: [] }),
);
expectThrow('non-string task throws', () =>
  // @ts-expect-error intentional
  compressWorkset({ task: 42, context: [] }),
);
expectThrow('non-array context throws', () =>
  // @ts-expect-error intentional
  compressWorkset({ task: TASK, context: 'nope' }),
);
expectThrow('invalid keepThreshold throws', () =>
  compressWorkset({ task: TASK, context: [] }, { keepThreshold: 2 }),
);
expectThrow('negative budget throws', () =>
  compressWorkset({ task: TASK, context: [] }, { budget: -1 }),
);
expectThrow('duplicate ids throw', () =>
  compressWorkset({
    task: TASK,
    context: [
      { id: 'dup', content: 'AtomSmasher hash integrity' },
      { id: 'dup', content: 'AtomSmasher sparse worksets' },
    ],
  }),
);

// ---------------------------------------------------------------------------
// 5. String-as-item shorthand
// ---------------------------------------------------------------------------
console.log('5. string-as-item shorthand');

const r5 = compressWorkset({
  task: 'Discuss AtomSmasher sparse worksets compression.',
  context: [
    'AtomSmasher sparse worksets compression keeps only relevant context.',
    'A completely unrelated paragraph about migratory bird patterns.',
  ],
});
check('string items normalize to objects', r5.working_set.every((w) => typeof w.id === 'string'));
check('string-item accounting still balances', r5.working_set.length + r5.dropped.length === 2);

// ---------------------------------------------------------------------------
// 6. Empty context — degenerate but legal
// ---------------------------------------------------------------------------
console.log('6. empty context');

const r6 = compressWorkset({ task: TASK, context: [] });
check('empty context yields empty working_set', r6.working_set.length === 0);
check('empty context yields empty dropped', r6.dropped.length === 0);
check('empty context compression_ratio === 1', r6.compression_ratio === 1);
check('empty context validates', validateWorkset(r6).valid);

// ---------------------------------------------------------------------------
// 7. Validator catches tampering
// ---------------------------------------------------------------------------
console.log('7. validator catches tampering');

const tampered = JSON.parse(JSON.stringify(r1));
tampered.stats.kept_items = 999;
const tv = validateWorkset(tampered);
check('tampered stats.kept_items rejected', !tv.valid);

const tampered2 = JSON.parse(JSON.stringify(r1));
tampered2.dropped.push({ id: 'ghost', reason: '' });
const tv2 = validateWorkset(tampered2);
check('dropped entry with empty reason rejected', !tv2.valid);

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------

console.log('');
if (failed === 0) {
  console.log('PASS — AtomSmasher sparse-worksets end-to-end smoke green');
  process.exit(0);
} else {
  console.log(`FAIL — ${failed} check(s) failed`);
  process.exit(1);
}
