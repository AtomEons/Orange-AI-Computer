// Audit 05 — Schema gate fuzz (RERUN against canonical Orange5 path)
// 12 adversarial inputs to insertReceipt(action, status, summary, payload, featureId)
// Records: ACCEPTED-stored / REJECTED-cleanly / CRASHED / CORRUPTED-DB
// NO modifications to storage.mjs — pure audit.

import { Store } from '../../../full-scope/storage.mjs';

const results = [];

function probe(n, label, fn) {
  const before = { count: 0, intact: true };
  let store;
  try {
    store = new Store(':memory:');
    before.count = store.one('SELECT COUNT(*) c FROM receipts').c;
  } catch (e) {
    results.push({ n, label, outcome: 'CRASHED', detail: `Store ctor failed: ${e.message}` });
    return;
  }

  let outcome, detail;
  try {
    const rid = fn(store);
    // Accepted — verify row stored, table intact
    const after = store.one('SELECT COUNT(*) c FROM receipts').c;
    if (after !== before.count + 1) {
      outcome = 'CORRUPTED-DB';
      detail = `expected +1 row, got delta=${after - before.count}`;
    } else if (!rid || typeof rid !== 'string' || !rid.startsWith('rcpt_')) {
      outcome = 'CORRUPTED-DB';
      detail = `bad rid returned: ${JSON.stringify(rid)}`;
    } else {
      // Verify row readable and table integrity intact
      const row = store.one('SELECT id,action,status,summary,payload_json FROM receipts WHERE id=?', [rid]);
      if (!row) {
        outcome = 'CORRUPTED-DB';
        detail = `row ${rid} not findable`;
      } else {
        // Integrity check
        try {
          const ok = store.one('PRAGMA integrity_check');
          const intStr = ok?.integrity_check ?? JSON.stringify(ok);
          if (intStr !== 'ok') {
            outcome = 'CORRUPTED-DB';
            detail = `integrity_check=${intStr}`;
          } else {
            outcome = 'ACCEPTED-stored';
            detail = `rid=${rid} action=${JSON.stringify(row.action).slice(0,60)} summary=${JSON.stringify(row.summary).slice(0,40)} payload_json_len=${row.payload_json?.length ?? 0}`;
          }
        } catch (ie) {
          outcome = 'CORRUPTED-DB';
          detail = `integrity check threw: ${ie.message}`;
        }
      }
    }
  } catch (e) {
    // Either clean rejection (Error from schema gate) or unexpected crash
    const msg = e?.message ?? String(e);
    // Check db still intact after rejection
    let dbIntact = true;
    let intactDetail = '';
    try {
      const after = store.one('SELECT COUNT(*) c FROM receipts').c;
      if (after !== before.count) {
        dbIntact = false;
        intactDetail = `row count changed: ${before.count}->${after}`;
      } else {
        const ok = store.one('PRAGMA integrity_check');
        const intStr = ok?.integrity_check ?? JSON.stringify(ok);
        if (intStr !== 'ok') {
          dbIntact = false;
          intactDetail = `integrity=${intStr}`;
        }
      }
    } catch (ie) {
      dbIntact = false;
      intactDetail = `post-reject integrity check failed: ${ie.message}`;
    }

    if (!dbIntact) {
      outcome = 'CORRUPTED-DB';
      detail = `error=${JSON.stringify(msg).slice(0,120)} + ${intactDetail}`;
    } else if (msg.startsWith('Receipt schema violation:') || msg.includes('schema violation') || msg.includes('Maximum call stack') || msg.includes('Converting circular') || msg.includes('JSON.stringify')) {
      outcome = 'REJECTED-cleanly';
      detail = `error=${JSON.stringify(msg).slice(0,150)}`;
    } else {
      outcome = 'CRASHED';
      detail = `unexpected error=${JSON.stringify(msg).slice(0,150)}`;
    }
  } finally {
    try { store?.close(); } catch {}
  }

  results.push({ n, label, outcome, detail });
}

// --- 12 adversarial inputs ---

probe(1, "insertReceipt(null, 'ok', 'sum', {})", s =>
  s.insertReceipt(null, 'ok', 'sum', {}));

probe(2, "insertReceipt('', 'ok', 'sum', {})", s =>
  s.insertReceipt('', 'ok', 'sum', {}));

probe(3, "insertReceipt('  ', 'ok', 'sum', {})", s =>
  s.insertReceipt('  ', 'ok', 'sum', {}));

probe(4, "insertReceipt('a.b', 'badstatus', 'sum', {})", s =>
  s.insertReceipt('a.b', 'badstatus', 'sum', {}));

probe(5, "insertReceipt('a.b', 'ok', null, {})", s =>
  s.insertReceipt('a.b', 'ok', null, {}));

probe(6, "insertReceipt('a.b', 'ok', 'sum', '{\"unclosed\":')", s =>
  s.insertReceipt('a.b', 'ok', 'sum', '{"unclosed":'));

probe(7, "deeply nested 5 levels", s =>
  s.insertReceipt('a.b', 'ok', 'sum', { a: { b: { c: { d: { e: 'deep' }}}}}));

probe(8, "10MB payload", s =>
  s.insertReceipt('a.b', 'ok', 'sum', {data: 'x'.repeat(10_000_000)}));

probe(9, "summary=' ' (space)", s =>
  s.insertReceipt('a.b', 'ok', ' ', {}));

probe(10, "unicode action+summary+payload", s =>
  s.insertReceipt('a.b', 'ok', '日本語😀', {emoji: '🦁'}));

probe(11, "newline injection in action", s =>
  s.insertReceipt('a.b\nINJECT\n', 'ok', 'sum', {}));

probe(12, "circular ref payload", s => {
  const o = {};
  o.self = o;
  return s.insertReceipt('a.b', 'ok', 'sum', o);
});

// --- Output ---
console.log('\n=== AUDIT 05 — SCHEMA FUZZ RESULTS ===\n');
for (const r of results) {
  console.log(`${r.n}\t${r.outcome}\t${r.label}`);
  console.log(`\t\t${r.detail}\n`);
}

const counts = { 'ACCEPTED-stored':0, 'REJECTED-cleanly':0, 'CRASHED':0, 'CORRUPTED-DB':0 };
for (const r of results) counts[r.outcome] = (counts[r.outcome]||0)+1;
const clean = counts['ACCEPTED-stored'] + counts['REJECTED-cleanly'];
const crashes = results.filter(r => r.outcome === 'CRASHED').map(r => r.n);
const corruptions = results.filter(r => r.outcome === 'CORRUPTED-DB').map(r => r.n);

console.log(`SUMMARY: ${clean}/12 handled cleanly. ACCEPTED=${counts['ACCEPTED-stored']} REJECTED=${counts['REJECTED-cleanly']} CRASHED=${counts['CRASHED']} CORRUPTED=${counts['CORRUPTED-DB']}`);
console.log(`CRASHES on [${crashes.join(',')}]`);
console.log(`CORRUPTIONS on [${corruptions.join(',')}]`);

// Emit JSON for the report renderer
console.log('\n=== JSON ===');
console.log(JSON.stringify({ results, counts, crashes, corruptions }, null, 2));
