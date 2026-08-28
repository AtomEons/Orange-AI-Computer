#!/usr/bin/env bun
// Standalone test harness for receipt-search.mjs (no framework import).
// Uses synthetic fixtures written to a temp dir so counts are deterministic,
// then also smoke-checks against the REAL corpus (count > 0, no throw).
// Run:  bun 10-RECEIPTS/tools/tests/receipt-search.test.mjs

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseReceipt, classifyOutcome, loadReceipts, searchReceipts, parseQuery, DEFAULT_DIR,
} from '../receipt-search.mjs';

let pass = 0, fail = 0;
const T = (name, cond) => {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
};

// ---------- parseReceipt: structured front matter ----------
const structured = [
  '# Receipt — Weekly Receipt Summarizer',
  '',
  '- **receipt_id:** 2026-06-24-weekly-receipt-summarizer',
  '- **generated_at:** 2026-06-24T22:05:30Z',
  '- **status:** WEEKLY_RECEIPT_SUMMARIZER_GREEN_50_OF_50_TESTS',
  '- **hash_chain:** #031',
  '- **prior_receipt:** 2026-06-24-ae-flow-scheduler-persist-gate (#030)',
].join('\n');
const r1 = parseReceipt('2026-06-24-weekly-receipt-summarizer.md', structured);
T('structured receiptId', r1.receiptId === '2026-06-24-weekly-receipt-summarizer');
T('structured date from generated_at', r1.date === '2026-06-24');
T('structured hashChain = 31', r1.hashChain === 31);
T('structured title parsed', r1.title === 'Receipt — Weekly Receipt Summarizer');
T('structured status GREEN → green true', r1.green === true);
T('structured status GREEN → red false', r1.red === false);
T('structured prior_receipt captured', /#030/.test(r1.priorReceipt));

// ---------- parseReceipt: header style, no status field ----------
const header = [
  '# Orange5 — Full-Surface Green Verification',
  '',
  '**Date:** 2026-07-04',
  '**Type:** verification + repair pass',
  '',
  'Running the full surface exposed 6 genuine reds. All were fixed. Everything GREEN.',
].join('\n');
const r2 = parseReceipt('2026-07-04-orange5-full-green-verification.md', header);
T('header fileDate from name', r2.fileDate === '2026-07-04');
// prose says "6 genuine reds" but they were fixed → NOT a red receipt
T('header prose-reds does NOT mark red', r2.red === false);
T('header body GREEN → green true', r2.green === true);
T('header no hash_chain → null', r2.hashChain === null);

// ---------- classifyOutcome unit rules ----------
T('status RED → red', classifyOutcome({ status: 'BUILD_RED_3_OF_10' }).red === true);
T('status "0 reds" → not red', classifyOutcome({ status: 'VERIFIED 0 REDS' }).red === false);
T('status BLOCKED → red', classifyOutcome({ status: 'BLOCKED on token' }).red === true);
T('status LIVE → green', classifyOutcome({ status: 'HERMES_DAEMON_LIVE' }).green === true);
T('postmortem name w/o status → red', classifyOutcome({ status: null, slug: 'postmortem-x' }).red === true);
T('plain name w/o status, no green body → neutral', classifyOutcome({ status: null, slug: 'foo', body: 'x' }).green === false);

// ---------- fixtures: filter behavior ----------
const dir = mkdtempSync(join(tmpdir(), 'rcpt-'));
try {
  const mk = (name, status) => writeFileSync(join(dir, name),
    `# ${name}\n\n- **receipt_id:** ${name.replace('.md','')}\n- **status:** ${status}\n- **hash_chain:** #001\n`);
  mk('2026-06-01-old-green.md', 'BUILD_GREEN');
  mk('2026-06-25-mid-green.md', 'PILLAR_GREEN_LOCKED');
  mk('2026-07-03-recent-red.md', 'PEN_TEST_RED_2_FINDINGS');
  mk('2026-07-04-recent-green.md', 'FULL_GREEN');

  const all = loadReceipts(dir);
  T('fixtures loaded = 4', all.length === 4);
  T('fixtures sorted newest-first', all[0].file === '2026-07-04-recent-green.md');

  const reds = searchReceipts(all, { status: 'red', limit: Infinity });
  T('status=red returns 1', reds.length === 1 && reds[0].file === '2026-07-03-recent-red.md');

  const greens = searchReceipts(all, { status: 'green', limit: Infinity });
  T('status=green returns 3', greens.length === 3);

  const since = searchReceipts(all, { since: '2026-06-25', limit: Infinity });
  T('since=2026-06-25 returns 3', since.length === 3);

  const windowRed = searchReceipts(all, { since: '2026-07-01', status: 'red', limit: Infinity });
  T('since+status=red returns 1', windowRed.length === 1);

  const limited = searchReceipts(all, { limit: 2 });
  T('limit=2 caps results', limited.length === 2);

  // ---------- parseQuery natural language ----------
  const qWeek = parseQuery(['what', 'shipped', 'this', 'week']);
  T('NL "this week" sets since', typeof qWeek.since === 'string' && /\d{4}-\d{2}-\d{2}/.test(qWeek.since));
  const qRed = parseQuery(['RED', 'runs']);
  T('NL "RED runs" sets status=red', qRed.status === 'red');
  const qFlags = parseQuery(['--since', '2026-06-25', '--status', 'green', '--limit', '5']);
  T('flags parsed: since', qFlags.since === '2026-06-25');
  T('flags parsed: status', qFlags.status === 'green');
  T('flags parsed: limit', qFlags.limit === 5);

  // end-to-end through parseQuery + searchReceipts
  const q2 = parseQuery(['--dir', dir, '--status', 'red']);
  const e2e = searchReceipts(loadReceipts(q2.dir), q2);
  T('e2e --status red via parseQuery', e2e.length === 1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ---------- smoke: real corpus loads and is non-empty ----------
let realCount = 0, realThrew = false;
try { realCount = loadReceipts(DEFAULT_DIR).length; } catch { realThrew = true; }
T('real corpus loads without throw', realThrew === false);
T('real corpus is non-empty', realCount > 0);
console.log(`  (real corpus size: ${realCount} receipts)`);

const total = pass + fail;
console.log(`Summary: ${pass} pass / ${fail} fail of ${total}`);
process.exit(fail === 0 ? 0 : 1);
