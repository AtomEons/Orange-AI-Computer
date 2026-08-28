// Phase 5 — Learning Loop test. Proves the REAL round-trip:
// a receipt fed into AE Cobra memory (real writeFluxRecord) is surfaced back
// for a future order of the same class (real recallMistakes). Tool -> wisdom.
//
// Run:  bun 03-BACKEND/tests/learning-loop.test.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestReceipt, lessonFor, closeLoop, __loopInternals } from '../learning-loop.mjs';
import { verifyChainStream } from '../../06-ORANGELLM/memory/ae-cobra/flux/reader.mjs';

const TESTS = [];
const test = (n, f) => TESTS.push({ name: n, fn: f });
const ok = (c, m) => { if (!c) throw new Error(m || 'expected truthy'); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || 'ne'}: ${a} !== ${b}`); };

function tmpRoot() { return mkdtempSync(join(tmpdir(), 'ae-loop-')); }

test('empty_ledger_yields_no_lesson_never_throws', () => {
  const root = tmpRoot();
  try {
    const l = lessonFor('deploy.risky', { fluxRoot: root });
    eq(l.count, 0, 'no mistakes yet');
    eq(l.warning, null, 'no warning on empty');
  } finally { rmSync(root, { recursive: true, force: true }); }
  return 'ok (offline-safe empty)';
});

test('contextual recall suppresses unrelated same-action failures', async () => {
  const root = tmpRoot();
  const now = Date.parse('2026-08-26T20:00:00Z');
  try {
    await ingestReceipt({
      action: 'query.chat', status: 'error', summary: 'image generation diffusion worker timed out',
      targetProject: 'OrangeFive', receipt_id: 'unrelated-image',
    }, { fluxRoot: root, ts: now - 2_000 });
    await ingestReceipt({
      action: 'query.chat', status: 'error', summary: 'runtime routing selected an unavailable specialist',
      targetProject: 'OrangeFive', receipt_id: 'relevant-route',
    }, { fluxRoot: root, ts: now - 1_000 });

    const lesson = lessonFor('query.chat', {
      fluxRoot: root, nowMs: now, intent: 'Explain current runtime routing', targetProject: 'OrangeFive', limit: 10,
    });
    eq(lesson.count, 1, 'only relevant same-action failure is injected');
    eq(lesson.suppressed_count, 1, 'unrelated match remains observable');
    eq(lesson.candidates_considered, 2, 'all action candidates are measured');
    ok(/runtime routing/.test(lesson.mistakes[0].summary), 'relevant route failure survives');
    return 'ok (contextual relevance blocks same-action bleed)';
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('contextual recall rejects wrong project despite lexical overlap', async () => {
  const root = tmpRoot();
  const now = Date.parse('2026-08-26T20:00:00Z');
  try {
    await ingestReceipt({
      action: 'build.api', status: 'error', summary: 'schema validation failed',
      targetProject: 'OtherProject', receipt_id: 'wrong-project',
    }, { fluxRoot: root, ts: now - 1_000 });
    const lesson = lessonFor('build.api', {
      fluxRoot: root, nowMs: now, intent: 'repair schema validation', targetProject: 'OrangeFive', limit: 10,
    });
    eq(lesson.count, 0, 'wrong project is not injected');
    eq(lesson.suppressed_count, 1, 'wrong-project candidate is observable');
    return 'ok (project boundary enforced)';
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ingested_mistake_is_recalled_for_same_action_class', async () => {
  const root = tmpRoot();
  try {
    // a prior order of this class FAILED and was receipted
    await ingestReceipt(
      { action: 'deploy.risky', status: 'halted', summary: 'LOOM gate halted: false_green_guard', receipt_id: 'rcpt_x1' },
      { fluxRoot: root },
    );
    // now a NEW order of the same class arrives — the loop must surface the lesson
    const l = lessonFor('deploy.risky', { fluxRoot: root });
    ok(l.count >= 1, `expected >=1 recalled mistake, got ${l.count}`);
    ok(l.warning && /prior issue/.test(l.warning), 'lesson carries a warning');
    return `ok (recalled ${l.count}; "${l.warning}")`;
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unrelated_action_class_gets_no_false_lesson', async () => {
  const root = tmpRoot();
  try {
    await ingestReceipt({ action: 'deploy.risky', status: 'error', summary: 'boom', receipt_id: 'r1' }, { fluxRoot: root });
    const l = lessonFor('read.file', { fluxRoot: root });
    eq(l.count, 0, 'different class => no lesson');
    eq(l.warning, null, 'no false warning');
    return 'ok (no cross-class bleed)';
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('closeLoop_surfaces_lesson_and_ingests_off_hot_path', async () => {
  const root = tmpRoot();
  try {
    // seed one prior mistake
    await ingestReceipt({ action: 'ship.it', status: 'error', summary: 'failed', receipt_id: 'r0' }, { fluxRoot: root });
    // a spine result for a NEW ship.it order
    const spineResult = {
      report: { action: 'ship.it', status: 'ok', summary: 'executed' },
      receipt: { action: 'ship.it', status: 'ok', summary: 'executed', receipt_id: 'r1' },
    };
    const { lesson, ingestDone } = closeLoop(spineResult, { fluxRoot: root });
    ok(lesson.count >= 1, 'lesson surfaced from the prior mistake before this order commits');
    const written = await ingestDone; // the new receipt lands off the hot path
    ok(written !== undefined, 'ingest completed off the hot path');
    // The successful receipt closes the episode instead of reinjecting a stale
    // warning forever. The closed failure remains measurable.
    const after = lessonFor('ship.it', { fluxRoot: root });
    eq(after.count, 0, 'resolved failure no longer drives the next route');
    eq(after.resolved_count, 1, 'closed failure remains measurable');
    return `ok (lesson before: ${lesson.count}, after ingest: ${after.count})`;
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('production learning uses the canonical AE Cobra HTTP writer', async () => {
  const root = tmpRoot();
  try {
    let posted = null;
    const written = await ingestReceipt(
      { action: 'analyze.agent', status: 'completed', summary: 'analysis returned', receipt_id: 'rcpt_http' },
      {
        fluxRoot: root,
        cobraUrl: 'http://127.0.0.1:7419',
        requireCobra: true,
        fetchImpl: async (url, init) => {
          posted = { url, body: JSON.parse(init.body) };
          return new Response(JSON.stringify({ ok: true, accepted: true, id: 'memory123', lane: 'reality' }), { status: 200 });
        },
      },
    );
    eq(written.transport, 'ae-cobra-http+canonical-flux', 'canonical transport');
    eq(posted.url, 'http://127.0.0.1:7419/event', 'canonical endpoint');
    eq(posted.body.event.event_type, 'receipt', 'completed work is a receipt');
    eq(posted.body.event.entities[0], 'analyze.agent', 'action remains queryable');
    eq(posted.body.event.files[0], '10-RECEIPTS/spine-chain.jsonl', 'receipt ledger grounds the memory');
    return 'ok (single writer)';
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('failed work is sent to memory as an error instead of being skipped', async () => {
  let eventType = null;
  await ingestReceipt(
    { action: 'deploy.risky', status: 'halted', summary: 'gate stopped it', receipt_id: 'rcpt_fail' },
    {
      cobraUrl: 'http://127.0.0.1:7419',
      requireCobra: true,
      fetchImpl: async (_url, init) => {
        eventType = JSON.parse(init.body).event.event_type;
        return new Response(JSON.stringify({ ok: true, accepted: true, id: 'failure123', lane: 'reality' }), { status: 200 });
      },
    },
  );
  eq(eventType, 'error', 'failure becomes recallable error evidence');
  return 'ok (failure learned)';
});

test('correct guarded stops are remembered without poisoning failure recurrence', async () => {
  let event = null;
  await ingestReceipt(
    { action: 'review.system', status: 'needs_action', summary: 'run a governed probe or provide evidence', receipt_id: 'rcpt_guarded' },
    {
      cobraUrl: 'http://127.0.0.1:7419',
      requireCobra: true,
      fetchImpl: async (_url, init) => {
        event = JSON.parse(init.body).event;
        return new Response(JSON.stringify({ ok: true, accepted: true, id: 'guarded', lane: 'reality' }), { status: 200 });
      },
    },
  );
  eq(event.event_type, 'decision', 'guarded stop is a decision, not an error');
  ok(event.summary.includes('outcome=guarded_stop'), 'disposition remains machine-readable');
  return 'ok (guarded stop separated from failure)';
});

test('unresolved blocked work remains recallable failure evidence', async () => {
  let eventType = null;
  await ingestReceipt(
    { action: 'review.system', status: 'blocked', summary: 'required specialist is unavailable', receipt_id: 'rcpt_blocked' },
    {
      cobraUrl: 'http://127.0.0.1:7419',
      requireCobra: true,
      fetchImpl: async (_url, init) => {
        eventType = JSON.parse(init.body).event.event_type;
        return new Response(JSON.stringify({ ok: true, accepted: true, id: 'blocked', lane: 'reality' }), { status: 200 });
      },
    },
  );
  eq(eventType, 'error', 'real blocker remains failure evidence');
  return 'ok (real blocker learned)';
});

test('failure is compiled into a structured reusable lesson', async () => {
  let body = null;
  await ingestReceipt(
    { action: 'build.api', status: 'error', summary: 'typecheck failed in the first verification pass', receipt_id: 'rcpt_structured' },
    { fluxRoot: tmpRoot(), writer: (record) => { body = record.body; return record; } },
  );
  eq(body.failure_class, 'verification_failure', 'failure class');
  ok(body.lesson.includes('first deterministic failure'), 'repair lesson compiled');
  ok(/^[a-f0-9]{64}$/.test(body.lesson_fingerprint), 'stable lesson fingerprint');
  return 'ok (structured lesson)';
});

test('related action family recalls a prior failure without unrelated bleed', async () => {
  const root = tmpRoot();
  try {
    await ingestReceipt({ action: 'build.api', status: 'error', summary: 'typecheck failed', receipt_id: 'r-build' }, { fluxRoot: root });
    const related = lessonFor('build.service', { fluxRoot: root });
    ok(related.count >= 1, 'build family lesson surfaced');
    eq(related.patterns[0].failureClass, 'verification_failure', 'dominant failure class');
    const unrelated = lessonFor('deploy.service', { fluxRoot: root });
    eq(unrelated.count, 0, 'deploy does not inherit build failure');
    return 'ok (family reuse bounded)';
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('query sub-actions do not inherit failures from another query lane', async () => {
  const root = tmpRoot();
  try {
    await ingestReceipt({ action: 'query.chat', status: 'error', summary: 'navigator connection timeout', receipt_id: 'r-query-chat' }, { fluxRoot: root });
    const chat = lessonFor('query.chat', { fluxRoot: root });
    const code = lessonFor('query.code', { fluxRoot: root });
    ok(chat.count >= 1, 'exact query.chat lesson surfaced');
    eq(code.count, 0, 'query.code does not inherit query.chat failure');
    return 'ok (query lanes isolated)';
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a later proven success closes the older failure episode', async () => {
  const root = tmpRoot();
  const now = Date.parse('2026-08-26T18:00:00Z');
  try {
    await ingestReceipt({ action: 'build.api', status: 'error', summary: 'typecheck failed', receipt_id: 'episode-fail' }, { fluxRoot: root, ts: now - 3_000 });
    await ingestReceipt({ action: 'build.api', status: 'completed', summary: 'typecheck and tests passed', receipt_id: 'episode-pass' }, { fluxRoot: root, ts: now - 2_000 });
    const closed = lessonFor('build.api', { fluxRoot: root, nowMs: now, limit: 10 });
    eq(closed.count, 0, 'resolved failure is not reinjected');
    eq(closed.resolved_count, 1, 'closed episode remains measurable');
    eq(closed.last_resolution_disposition, 'success', 'closure carries disposition');

    await ingestReceipt({ action: 'build.api', status: 'error', summary: 'new assertion failed', receipt_id: 'episode-new-fail' }, { fluxRoot: root, ts: now - 1_000 });
    const reopened = lessonFor('build.api', { fluxRoot: root, nowMs: now, limit: 10 });
    eq(reopened.count, 1, 'a new post-resolution failure opens a new episode');
    return 'ok (failure episode closes and can reopen)';
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a correct evidence refusal closes transport failures without becoming a new failure', async () => {
  const root = tmpRoot();
  const now = Date.parse('2026-08-26T19:00:00Z');
  try {
    await ingestReceipt({ action: 'query.chat', status: 'error', summary: 'navigator connection timeout', receipt_id: 'guard-fail' }, { fluxRoot: root, ts: now - 2_000 });
    await ingestReceipt({ action: 'query.chat', status: 'needs_action', summary: 'run a governed probe or provide evidence', receipt_id: 'guard-stop' }, { fluxRoot: root, ts: now - 1_000 });
    const lesson = lessonFor('query.chat', { fluxRoot: root, nowMs: now, limit: 10 });
    eq(lesson.count, 0, 'warranted refusal is not failure recurrence');
    eq(lesson.last_resolution_disposition, 'guarded_stop', 'guarded stop closes the episode');
    return 'ok (correct restraint is not punished)';
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('failure recall recovers connection language and explicit machine causes', () => {
  eq(__loopInternals.classifyFailure({ summary: 'specialist lease failed: Unable to connect to the URL' }), 'connectivity_or_auth', 'connect verb');
  eq(__loopInternals.classifyFailure({ summary: 'failure_class=capability_route_failure; cause=heavy specialist missing' }), 'capability_route_failure', 'explicit cause');
  eq(__loopInternals.classifyFailure({ summary: 'restore the heavy specialist because the model is unavailable' }), 'capability_route_failure', 'capability route');
  eq(__loopInternals.classifyFailure({ summary: 'restore the heavy specialist or run a governed capable council' }), 'capability_route_failure', 'repair-first capability wording');
  return 'ok (causes survive recall prose)';
});

test('bad_input_rejected_cleanly', async () => {
  let threw = false;
  try { await ingestReceipt({ status: 'ok' }, { fluxRoot: tmpRoot() }); } catch { threw = true; }
  ok(threw, 'receipt without action must throw');
  return 'ok';
});

test('lane_hash_chain_continues_across_daily_files', async () => {
  const root = tmpRoot();
  try {
    await ingestReceipt(
      { action: 'memory.chain', status: 'ok', summary: 'day one', receipt_id: 'day-1' },
      { fluxRoot: root, ts: Date.parse('2026-07-28T23:59:59Z') },
    );
    await ingestReceipt(
      { action: 'memory.chain', status: 'ok', summary: 'day two', receipt_id: 'day-2' },
      { fluxRoot: root, ts: Date.parse('2026-07-29T00:00:01Z') },
    );
    const chain = verifyChainStream({ fluxRoot: root, lane: 'thought' });
    ok(chain.ok, `cross-day chain must verify: ${JSON.stringify(chain.broken)}`);
    eq(chain.count, 2, 'both daily records participate in one lane chain');
    return 'ok (continuous across day boundary)';
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log('Orange5 Learning Loop (Phase 5) — round-trip test');
console.log('Bun ' + (process.versions?.bun || 'unknown'));
console.log('');
let pass = 0, fail = 0;
for (const t of TESTS) {
  const t0 = Date.now();
  try { const note = await t.fn(); pass++; console.log(`  PASS  ${t.name.padEnd(52)} ${(Date.now() - t0).toString().padStart(4)}ms  ${note || ''}`); }
  catch (e) { fail++; console.log(`  FAIL  ${t.name.padEnd(52)} ${(Date.now() - t0).toString().padStart(4)}ms  ${e.message}`); }
}
console.log('');
console.log(`Summary: ${pass} pass / ${fail} fail of ${TESTS.length}`);
if (fail > 0) process.exit(1);
