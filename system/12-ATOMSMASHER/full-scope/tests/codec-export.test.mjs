// Codec export test — verify exportCompressedAuditLog produces real compression
// on a live AtomSmasher demo() run.

import { Store } from '../storage.mjs';
import { demo } from '../engines.mjs';

const TESTS = [];
function test(name, fn) { TESTS.push({ name, fn }); }

test('export_runs_without_throwing', () => {
  const store = new Store(':memory:');
  store.insertReceipt('order.add', 'ok', 'test order', { text: 'hello' });
  store.insertReceipt('cache.hit', 'ok', 'cache hit', { key: 'abc' });
  const result = store.exportCompressedAuditLog();
  store.close();
  if (!result) throw new Error('no result');
  if (typeof result.ratio !== 'number') throw new Error('no ratio');
  return `ok (2 receipts, ${result.originalBytes}B → ${result.encoded.length}B, ratio=${result.ratio}x)`;
});

test('export_hydrates_byte_exact_jsonl', () => {
  const store = new Store(':memory:');
  const featureId = store.one('SELECT id FROM features ORDER BY id LIMIT 1').id;
  store.insertReceipt('mesh.compress', 'ok', 'packet #7: 123B -> 45B', '{"raw_bytes":123, "compressed_bytes":45, "ratio":2.7333333333}', featureId);
  store.insertReceipt('cache.hit', 'warn', 'numeric packet 42.5 preserved', { values: [1, 2.5, 4], ratio: 1.875 });
  const expectedRows = store.all('SELECT id,feature_id,action,status,summary,payload_json,created_at FROM receipts ORDER BY created_at, id');
  const expectedJsonl = expectedRows.map(r => JSON.stringify(r)).join('\n') + '\n';
  const result = store.exportCompressedAuditLog();
  const hydrated = Store.hydrateCompressedAuditLog(result.encoded);
  store.close();
  if (hydrated.jsonl !== expectedJsonl) throw new Error('hydrated JSONL changed source bytes');
  const hydratedFeatureRow = hydrated.receipts.find((row) => row.feature_id === featureId);
  if (!hydratedFeatureRow) throw new Error('feature_id was not hydrated');
  if (!result.hydration_proof?.lossless || !result.hydration_proof?.sha256_match) throw new Error('missing lossless hydration proof');
  const honestRatio = Number((result.originalBytes / Math.max(1, result.encoded.length)).toFixed(3));
  if (result.ratio !== honestRatio) throw new Error(`dishonest ratio: got ${result.ratio}, expected ${honestRatio}`);
  return `ok (${hydrated.n_receipts} receipts, sha=${hydrated.originalSha256.slice(0, 12)}, ratio=${result.ratio}x)`;
});

test('export_preserves_lexical_json_and_text_exactly', () => {
  const store = new Store(':memory:');
  const payload = '{"unsafe_integer":9007199254740993,"decimal":1.2300,"exponent":1e-9,"text":"line 1\\nline 2"}';
  store.insertReceipt('numeric.lexical', 'ok', 'line 1\nline 2', payload);
  const expected = store.one('SELECT payload_json,summary FROM receipts WHERE action=?', ['numeric.lexical']);
  const result = store.exportCompressedAuditLog({ batchSize: 1 });
  const hydrated = Store.hydrateCompressedAuditLog(result.encoded).receipts[0];
  store.close();
  if (hydrated.payload_json !== expected.payload_json) throw new Error('payload lexical bytes changed');
  if (hydrated.summary !== expected.summary) throw new Error('summary text changed');
  return 'ok (unsafe integer and lexical decimals preserved as source text)';
});

test('hydrate_rejects_header_or_payload_corruption', () => {
  const store = new Store(':memory:');
  store.insertReceipt('proof.integrity', 'ok', 'tamper target', { n: 42 });
  const result = store.exportCompressedAuditLog();
  store.close();

  const badHeader = Buffer.from(result.encoded);
  const fieldOffset = badHeader.indexOf(Buffer.from('feature_id'));
  if (fieldOffset < 0) throw new Error('protected field missing from header');
  badHeader[fieldOffset + 'feature_'.length] = 'x'.charCodeAt(0);
  let headerRejected = false;
  try { Store.hydrateCompressedAuditLog(badHeader); } catch { headerRejected = true; }
  if (!headerRejected) throw new Error('tampered protected fields were accepted');

  const badPayload = Buffer.from(result.encoded);
  badPayload[badPayload.length - 1] ^= 0xff;
  let payloadRejected = false;
  try { Store.hydrateCompressedAuditLog(badPayload); } catch { payloadRejected = true; }
  if (!payloadRejected) throw new Error('tampered compressed payload was accepted');
  return 'ok (header and payload corruption rejected)';
});

test('export_enforces_receipt_cap_before_unbounded_scan', () => {
  const store = new Store(':memory:');
  store.insertReceipt('order.add', 'ok', 'one', { n: 1 });
  store.insertReceipt('order.add', 'ok', 'two', { n: 2 });
  try {
    store.exportCompressedAuditLog({ maxReceipts: 1 });
  } catch (e) {
    store.close();
    if (!String(e.message).includes('receipt cap exceeded')) throw e;
    return 'ok (receipt cap tripped)';
  }
  store.close();
  throw new Error('receipt cap did not trip');
});

test('export_compresses_repeated_receipts', () => {
  const store = new Store(':memory:');
  // Insert 200 highly repetitive receipts
  for (let i = 0; i < 100; i++) {
    store.insertReceipt('order.add', 'ok', 'fixed text ' + i, { value: i });
    store.insertReceipt('cache.hit', 'ok', 'cache hit for k', { key_hash: 'common_hash' });
  }
  const result = store.exportCompressedAuditLog();
  store.close();
  if (result.ratio < 5) throw new Error(`Expected ratio >= 5x for repetitive data, got ${result.ratio}x`);
  return `ok (200 receipts, ${result.originalBytes}B → ${result.encoded.length}B, ratio=${result.ratio}x)`;
});

test('export_on_demo_run', () => {
  // Run a real demo() and export its audit log
  const store = new Store(':memory:');
  const proof = demo(store);
  const result = store.exportCompressedAuditLog();
  if (!result) throw new Error('no result');
  // Even on a small demo run, expect at least some compression
  if (result.ratio < 1.5) throw new Error(`Expected ratio >= 1.5x on demo run, got ${result.ratio}x with ${result.n_receipts} receipts`);
  store.close();
  return `ok (demo ran ${proof.all_features.attempted}/${proof.all_features.ok} features, ${result.n_receipts} receipts, ratio=${result.ratio}x)`;
});

test('export_handles_empty_store', () => {
  const store = new Store(':memory:');
  const result = store.exportCompressedAuditLog();
  store.close();
  if (result.n_receipts !== undefined && result.n_receipts !== 0) throw new Error('Should be 0 receipts');
  return `ok (empty store handled)`;
});

test('export_with_mesh_receipts', () => {
  const store = new Store(':memory:');
  // Insert mesh.compress receipts matching the canonical pattern
  for (let i = 1; i <= 50; i++) {
    const raw = 100 + i * 7;
    const comp = 50 + i * 3;
    const ratio = Math.round(raw / comp * 100) / 100;
    store.insertReceipt(
      'mesh.compress', 'ok',
      `packet #${i}: ${raw}B → ${comp}B`,
      { raw_bytes: raw, compressed_bytes: comp, ratio }
    );
  }
  const result = store.exportCompressedAuditLog();
  store.close();
  // mesh.compress is the most compressible action type (Method 14 wins big here)
  if (result.ratio < 4) throw new Error(`Expected high ratio on mesh-only, got ${result.ratio}x`);
  return `ok (50 mesh receipts, ${result.originalBytes}B → ${result.encoded.length}B, ratio=${result.ratio}x)`;
});

console.log('AtomSmasher Production Codec Export — 9-case Bun test sweep');
console.log('Bun ' + (process.versions?.bun || 'unknown'));
console.log('');
let pass = 0, fail = 0;
for (const t of TESTS) {
  const t0 = Date.now();
  try {
    const note = t.fn();
    pass++;
    console.log(`  PASS  ${t.name.padEnd(45)} ${(Date.now() - t0).toString().padStart(4)}ms  ${note || ''}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL  ${t.name.padEnd(45)} ${(Date.now() - t0).toString().padStart(4)}ms  ${e.message}`);
  }
}
console.log('');
console.log(`Summary: ${pass} pass / ${fail} fail of ${TESTS.length}`);
if (fail > 0) process.exit(1);
