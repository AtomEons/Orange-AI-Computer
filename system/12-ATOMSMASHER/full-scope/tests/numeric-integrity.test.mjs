import assert from 'node:assert/strict';

import { fitEquationPacket, verifyEquationPacket } from '../../../03-BACKEND/numeric-equation-packet.mjs';
import { EquationMemory, SourceEngine } from '../engines.mjs';
import { Store } from '../storage.mjs';
import { sha256Text } from '../utils.mjs';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function exactNumbers(actual, expected, message) {
  assert.equal(actual.length, expected.length, `${message}: length`);
  for (let i = 0; i < expected.length; i++) {
    assert.ok(Object.is(actual[i], expected[i]), `${message}: index ${i} (${actual[i]} !== ${expected[i]})`);
  }
}

test('sparse_replacement_residual_reconstructs_exactly', () => {
  const store = new Store(':memory:');
  try {
    const values = Array.from({ length: 200 }, (_, i) => 2 + 3 * i);
    values[117] += 0.25;
    const equation = new EquationMemory(store);
    const row = equation.fitSeries(values, 'sparse-residual');
    assert.equal(row.equation_type, 'linear');
    assert.deepEqual(Object.keys(JSON.parse(row.residuals_json)), ['117']);
    exactNumbers(equation.reconstruct(row.id), values, 'replacement residual');
    assert.equal(equation.verifyReconstruction(row.id).verified, true);

    const receipt = store.one("SELECT payload_json FROM receipts WHERE action='equation.fit' ORDER BY rowid DESC LIMIT 1");
    const best = JSON.parse(receipt.payload_json).best;
    const storedBytes = Buffer.byteLength(row.parameters_json + row.residuals_json, 'utf8');
    assert.equal(best.encoded_bytes, storedBytes);
    assert.equal(best.exact_reconstruction, true);
    assert.ok(best.compression_ratio > 1);
    return `linear residual packet ${best.raw_bytes}B -> ${best.encoded_bytes}B (${best.compression_ratio}x)`;
  } finally {
    store.close();
  }
});

test('raw_fallback_reports_storage_regression_honestly', () => {
  const store = new Store(':memory:');
  try {
    const values = [0.11, 91.7, -4.2, 808.03, 7.777, -921.4, 52.02, 13.3];
    const equation = new EquationMemory(store);
    const row = equation.fitSeries(values, 'raw-regression');
    assert.equal(row.equation_type, 'raw');
    exactNumbers(equation.reconstruct(row.id), values, 'raw fallback');
    const receipt = store.one("SELECT payload_json FROM receipts WHERE action='equation.fit' ORDER BY rowid DESC LIMIT 1");
    const best = JSON.parse(receipt.payload_json).best;
    assert.equal(best.encoded_bytes, Buffer.byteLength(row.parameters_json + row.residuals_json, 'utf8'));
    assert.ok(best.encoded_bytes > best.raw_bytes);
    assert.ok(best.compression_ratio < 1);
    assert.equal(best.storage_mode, 'raw_fallback');
    return `honest regression ${best.raw_bytes}B -> ${best.encoded_bytes}B (${best.compression_ratio}x)`;
  } finally {
    store.close();
  }
});

test('finite_extremes_survive_and_signed_zero_is_normalized', () => {
  const store = new Store(':memory:');
  try {
    const equation = new EquationMemory(store);
    const extremes = [1e308, -1e308, 1e308, -1e308];
    const extremeRow = equation.fitSeries(extremes, 'finite-extremes');
    exactNumbers(equation.reconstruct(extremeRow.id), extremes, 'finite extremes');
    assert.equal(equation.verifyReconstruction(extremeRow.id).verified, true);

    const zeroRow = equation.fitSeries([-0, 0, -0, 0], 'signed-zero');
    const zeros = equation.reconstruct(zeroRow.id);
    assert.ok(zeros.every(value => Object.is(value, 0)), 'signed zero must normalize to JSON-safe zero');
    assert.equal(equation.verifyReconstruction(zeroRow.id).verified, true);
    return 'finite float64 exact; -0 normalized to 0';
  } finally {
    store.close();
  }
});

test('source_hydration_and_numeric_scanner_cover_exponents', () => {
  const store = new Store(':memory:');
  try {
    const text = 'Measurements: 1e3 +2.5E-2 -.75 4.\nThe source must remain byte exact.';
    const result = new SourceEngine(store).ingestText('numeric-source', text);
    const source = store.one('SELECT text,text_hash,raw_bytes FROM sources WHERE id=?', [result.source_id]);
    assert.equal(source.text, text);
    assert.equal(source.text_hash, sha256Text(text));
    assert.equal(source.raw_bytes, Buffer.byteLength(text, 'utf8'));
    const row = store.one('SELECT id FROM equations WHERE source_pointer=?', [result.source_id]);
    assert.ok(row, 'numeric source equation missing');
    exactNumbers(new EquationMemory(store).reconstruct(row.id), [1000, 0.025, -0.75, 4], 'scientific notation scan');
    return `${source.raw_bytes} source bytes and four numeric values hydrated exactly`;
  } finally {
    store.close();
  }
});

test('post_write_equation_tamper_is_detected', () => {
  const store = new Store(':memory:');
  try {
    const equation = new EquationMemory(store);
    const row = equation.fitSeries(Array.from({ length: 30 }, (_, i) => 7 + 2 * i), 'tamper-check');
    assert.equal(equation.verifyReconstruction(row.id).verified, true);
    const parameters = JSON.parse(row.parameters_json);
    if ('a' in parameters) parameters.a += 1;
    else if ('values' in parameters) parameters.values[0] += 1;
    else throw new Error(`unsupported tamper fixture type ${row.equation_type}`);
    store.execute('UPDATE equations SET parameters_json=? WHERE id=?', [JSON.stringify(parameters), row.id]);
    assert.equal(equation.verifyReconstruction(row.id).verified, false);
    return 'float64 reconstruction hash rejected changed parameters';
  } finally {
    store.close();
  }
});

test('orange_numeric_packet_oracle_agrees_on_exactness', () => {
  const values = Array.from({ length: 64 }, (_, i) => 4 + 5 * i + (i === 31 ? 0.125 : 0));
  const packet = fitEquationPacket({ name: 'atomsmasher-oracle', values });
  const proof = verifyEquationPacket(packet, { expectedValues: values });
  assert.equal(proof.ok, true);
  assert.equal(packet.metrics.exact_reconstruction, true);
  return `OrangeFive oracle exact (${packet.equation_type}, ${packet.metrics.compression_ratio}x full packet)`;
});

console.log('AtomSmasher Numeric Integrity - focused Bun test sweep');
let pass = 0;
let fail = 0;
for (const entry of tests) {
  const started = Date.now();
  try {
    const note = entry.fn();
    pass++;
    console.log(`  PASS  ${entry.name.padEnd(55)} ${String(Date.now() - started).padStart(4)}ms  ${note || ''}`);
  } catch (error) {
    fail++;
    console.error(`  FAIL  ${entry.name.padEnd(55)} ${String(Date.now() - started).padStart(4)}ms  ${error.message}`);
  }
}
console.log(`Summary: ${pass} pass / ${fail} fail of ${tests.length}`);
if (fail > 0) process.exit(1);
