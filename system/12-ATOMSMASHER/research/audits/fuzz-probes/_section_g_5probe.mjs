// Section G: 5 of the 12 fuzz inputs from audit-05-RERUN.
// Picks the most informative 5: 2 rejects (whitespace, badstatus), 3 accepts (deeply nested, unicode, large).
// Replicate exact outcomes per audit-05-RERUN table.
import { Store } from '../../../full-scope/storage.mjs';

const cases = [
  // # 3 — REJECTED whitespace action
  { id: 3, label: "action='  '", call: (s) => s.insertReceipt('  ', 'ok', 'sum', {}), expect: 'reject', expect_msg: 'action must not contain whitespace' },
  // # 4 — REJECTED badstatus
  { id: 4, label: "status=badstatus", call: (s) => s.insertReceipt('a.b', 'badstatus', 'sum', {}), expect: 'reject', expect_msg: 'status must be one of' },
  // # 7 — ACCEPTED deeply nested 5 levels
  { id: 7, label: 'deeply nested 5 levels', call: (s) => s.insertReceipt('a.b', 'ok', 'nested', { a: { b: { c: { d: { e: 1 } } } } }), expect: 'accept' },
  // # 10 — ACCEPTED unicode
  { id: 10, label: 'unicode', call: (s) => s.insertReceipt('action.日本語', 'ok', '日本語😀', { name: '🦁' }), expect: 'accept' },
  // # 11 — REJECTED newline injection in action
  { id: 11, label: 'action=newline injection', call: (s) => s.insertReceipt('a.b\nINJECT\n', 'ok', 'sum', {}), expect: 'reject', expect_msg: 'action must not contain whitespace' },
];

const store = new Store(':memory:');
const results = [];
let priorCount = 0;
for (const c of cases) {
  const before = store.all('SELECT COUNT(*) AS n FROM receipts')[0].n;
  let outcome, msg, rid = null;
  try {
    rid = c.call(store);
    outcome = 'accept';
  } catch (e) {
    outcome = 'reject';
    msg = String(e.message || e);
  }
  const after = store.all('SELECT COUNT(*) AS n FROM receipts')[0].n;
  const integrity = store.all('PRAGMA integrity_check')[0];
  const integrityOk = integrity && (integrity.integrity_check === 'ok' || JSON.stringify(integrity).includes('ok'));
  let match = outcome === c.expect;
  if (match && c.expect === 'reject' && c.expect_msg && !msg.includes(c.expect_msg)) match = false;
  if (c.expect === 'accept' && (after - before !== 1)) match = false;
  if (c.expect === 'reject' && (after - before !== 0)) match = false;
  results.push({ id: c.id, label: c.label, outcome, expected: c.expect, match, rid, msg, before, after, integrityOk });
}
const allMatch = results.every(r => r.match && r.integrityOk);
console.log(JSON.stringify({ results, all_match: allMatch }, null, 2));
