#!/usr/bin/env bun
// Standalone test harness for session-close.mjs (no framework import).
// Tests the pure receipt builder + chain math. Does NOT write to the real
// corpus (only buildReceipt, which returns a string).
// Run:  bun 10-RECEIPTS/tools/tests/session-close.test.mjs

import { buildReceipt, nextChainOrdinal, newestReceiptId } from '../session-close.mjs';

let pass = 0, fail = 0;
const T = (name, cond) => {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
};

// ---------- chain math ----------
const corpus = [
  { receiptId: 'r-c', hashChain: 58, file: 'r-c.md' },
  { receiptId: 'r-a', hashChain: 31, file: 'r-a.md' },
  { receiptId: 'r-b', hashChain: null, file: 'r-b.md' },
];
T('nextChainOrdinal = max+1', nextChainOrdinal(corpus) === 59);
T('nextChainOrdinal empty = 1', nextChainOrdinal([]) === 1);
T('nextChainOrdinal ignores null chains', nextChainOrdinal([{ hashChain: null }, { hashChain: 5 }]) === 6);
T('newestReceiptId = first', newestReceiptId(corpus) === 'r-c');
T('newestReceiptId empty = null', newestReceiptId([]) === null);

// ---------- buildReceipt structure ----------
const FIXED = new Date('2026-07-04T15:30:00.000Z');
const built = buildReceipt({
  title: 'DX Tools Shipped',
  result: '7 DX + receipt tools built and tested.',
  evidence: ['all tool tests green', 'verifier untouched'],
  blockers: ['operator Codexa steps remain'],
  next: ['wire tools into bun run scripts'],
  now: FIXED,
  chain: 59,
  prior: 'r-c',
});
T('receiptId = date-slug', built.receiptId === '2026-07-04-dx-tools-shipped');
T('filename ends .md', built.filename === '2026-07-04-dx-tools-shipped.md');
T('markdown has Result section', built.markdown.includes('## Result'));
T('markdown has Evidence section', built.markdown.includes('## Evidence'));
T('markdown has Blockers section', built.markdown.includes('## Blockers'));
T('markdown has Next action section', built.markdown.includes('## Next action'));
T('markdown embeds result text', built.markdown.includes('7 DX + receipt tools built and tested.'));
T('markdown embeds evidence bullet', built.markdown.includes('- all tool tests green'));
T('markdown embeds blocker bullet', built.markdown.includes('- operator Codexa steps remain'));
T('markdown embeds next bullet', built.markdown.includes('- wire tools into bun run scripts'));
T('hash_chain formatted #059', built.markdown.includes('- **hash_chain:** #059'));
T('prior_receipt embedded', built.markdown.includes('- **prior_receipt:** r-c'));
T('generated_at is fixed ISO', built.markdown.includes('2026-07-04T15:30:00.000Z'));
T('status default SESSION_CLOSE', built.status === 'SESSION_CLOSE');

// ---------- empty sections render honest defaults ----------
const minimal = buildReceipt({
  title: 'Minimal', result: 'did a thing', now: FIXED, chain: 1, prior: null,
});
T('empty evidence → "none recorded"', minimal.markdown.includes('- none recorded'));
T('empty blockers → "none"', /## Blockers\n\n- none\n/.test(minimal.markdown));
T('empty next → "none"', /## Next action\n\n- none\n/.test(minimal.markdown));
T('prior none → "(none)"', minimal.markdown.includes('- **prior_receipt:** (none)'));

// ---------- verifier badge folds into evidence + status ----------
const withBadge = buildReceipt({
  title: 'Verified Close', result: 'closed green', now: FIXED, chain: 2, prior: 'x',
  verifierBadge: { green: 58, total: 58, red: 0, pct: 100, allGreen: true, timestamp: '2026-07-04T00:00:00.000Z' },
});
T('badge green → status GREEN', withBadge.status === 'SESSION_CLOSE_GREEN');
T('badge folds into evidence', withBadge.markdown.includes('verifier: 58/58 GREEN (100%)'));
const withRedBadge = buildReceipt({
  title: 'Red Close', result: 'closed with reds', now: FIXED, chain: 3, prior: 'x',
  verifierBadge: { green: 50, total: 58, red: 8, pct: 86.2, allGreen: false, timestamp: '2026-07-04T00:00:00.000Z' },
});
T('red badge → status WITH_OPEN_REDS', withRedBadge.status === 'SESSION_CLOSE_WITH_OPEN_REDS');

// ---------- required-field guards ----------
let noTitle = false, noResult = false;
try { buildReceipt({ result: 'x', chain: 1 }); } catch { noTitle = true; }
try { buildReceipt({ title: 'x', chain: 1 }); } catch { noResult = true; }
T('missing title throws', noTitle === true);
T('missing result throws', noResult === true);

const total = pass + fail;
console.log(`Summary: ${pass} pass / ${fail} fail of ${total}`);
process.exit(fail === 0 ? 0 : 1);
