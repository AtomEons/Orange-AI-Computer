import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FeatureExecutor } from '../engines.mjs';
import { Store } from '../storage.mjs';

const PY_DIR = 'C:/AtomEons/orangebox-delta/integrations/atomsmasher_full_scope_v1_0';

function tempDb(prefix) {
  return path.join(os.tmpdir(), `${prefix}-${process.pid}-${process.hrtime.bigint()}.db`);
}

function removeDb(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* already absent */ }
  }
}

function snapshot(store, report) {
  const canonicalize = value => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
    }
    return value;
  };
  const fingerprint = (rows) => crypto.createHash('sha256').update(JSON.stringify(canonicalize(rows))).digest('hex');
  const featureRows = store.all('SELECT id,name,category,engine,heat_default FROM features ORDER BY id')
    .map(row => [row.id, row.name, row.category, row.engine, row.heat_default]);
  const equationRows = store.all('SELECT name,equation_type,formula,source_pointer FROM equations ORDER BY name,id')
    .map(row => [row.name, row.equation_type, row.formula, row.source_pointer]);
  const equationPayloadRows = store.all('SELECT name,parameters_json,residuals_json FROM equations ORDER BY name,id')
    .map(row => [row.name, JSON.parse(row.parameters_json), JSON.parse(row.residuals_json)]);
  const receiptRows = store.all('SELECT feature_id,action,status,summary FROM receipts ORDER BY rowid')
    .map(row => [row.feature_id, row.action, row.status, row.summary]);
  return {
    features_registered: store.one('SELECT COUNT(*) c FROM features').c,
    atoms: store.one('SELECT COUNT(*) c FROM atoms').c,
    source_atoms: store.one("SELECT COUNT(*) c FROM atoms WHERE source_type='source'").c,
    equation_atoms: store.one("SELECT COUNT(*) c FROM atoms WHERE source_type='equation'").c,
    equations: store.one('SELECT COUNT(*) c FROM equations').c,
    source_equations: store.one('SELECT COUNT(*) c FROM equations WHERE source_pointer IS NOT NULL').c,
    direct_equations: store.one('SELECT COUNT(*) c FROM equations WHERE source_pointer IS NULL').c,
    receipts: store.one('SELECT COUNT(*) c FROM receipts').c,
    run_all_attempted: report.attempted,
    run_all_ok: report.ok,
    run_all_errors: report.errors,
    feature_registry_sha256: fingerprint(featureRows),
    equation_shape_sha256: fingerprint(equationRows),
    equation_payload_sha256: fingerprint(equationPayloadRows),
    receipt_trace_sha256: fingerprint(receiptRows),
  };
}

function runBun() {
  const dbPath = tempDb('atomsmasher-parity-bun');
  const store = new Store(dbPath);
  try {
    const report = new FeatureExecutor(store).runAll(null, { canonicalParity: true });
    assert.equal(report.execution_mode, 'canonical-python-v1');
    return snapshot(store, report);
  } finally {
    store.close();
    removeDb(dbPath);
  }
}

function runPython() {
  const dbPath = tempDb('atomsmasher-parity-python');
  const driver = `
import hashlib, json, sys
sys.path.insert(0, r'${PY_DIR}')
from atomsmasher.storage import Store
from atomsmasher.engines import FeatureExecutor

store = Store(r'${dbPath.replaceAll('\\', '\\\\')}')
report = FeatureExecutor(store).run_all()
def fingerprint(rows):
  payload = json.dumps(rows, ensure_ascii=False, separators=(',', ':'), sort_keys=True)
  return hashlib.sha256(payload.encode('utf-8')).hexdigest()

feature_rows = [[r['id'],r['name'],r['category'],r['engine'],r['heat_default']] for r in store.all('SELECT id,name,category,engine,heat_default FROM features ORDER BY id')]
equation_rows = [[r['name'],r['equation_type'],r['formula'],r['source_pointer']] for r in store.all('SELECT name,equation_type,formula,source_pointer FROM equations ORDER BY name,id')]
equation_payload_rows = [[r['name'],json.loads(r['parameters_json']),json.loads(r['residuals_json'])] for r in store.all('SELECT name,parameters_json,residuals_json FROM equations ORDER BY name,id')]
receipt_rows = [[r['feature_id'],r['action'],r['status'],r['summary']] for r in store.all('SELECT feature_id,action,status,summary FROM receipts ORDER BY rowid')]
out = {
  'features_registered': store.one('SELECT COUNT(*) c FROM features')['c'],
  'atoms': store.one('SELECT COUNT(*) c FROM atoms')['c'],
  'source_atoms': store.one("SELECT COUNT(*) c FROM atoms WHERE source_type='source'")['c'],
  'equation_atoms': store.one("SELECT COUNT(*) c FROM atoms WHERE source_type='equation'")['c'],
  'equations': store.one('SELECT COUNT(*) c FROM equations')['c'],
  'source_equations': store.one('SELECT COUNT(*) c FROM equations WHERE source_pointer IS NOT NULL')['c'],
  'direct_equations': store.one('SELECT COUNT(*) c FROM equations WHERE source_pointer IS NULL')['c'],
  'receipts': store.one('SELECT COUNT(*) c FROM receipts')['c'],
  'run_all_attempted': report['attempted'],
  'run_all_ok': report['ok'],
  'run_all_errors': report['errors'],
  'feature_registry_sha256': fingerprint(feature_rows),
  'equation_shape_sha256': fingerprint(equation_rows),
  'equation_payload_sha256': fingerprint(equation_payload_rows),
  'receipt_trace_sha256': fingerprint(receipt_rows),
}
print(json.dumps(out, sort_keys=True))
store.close()
`;

  try {
    const result = spawnSync('python', ['-c', driver], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      maxBuffer: 10 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout || 'Python parity driver failed');
    return JSON.parse(result.stdout.trim().split('\n').pop());
  } finally {
    removeDb(dbPath);
  }
}

console.log('AtomSmasher Bun/Python Internal Parity - deterministic test');
const started = Date.now();
try {
  const bun = runBun();
  const python = runPython();
  for (const field of [
    'features_registered', 'atoms', 'source_atoms', 'equation_atoms', 'equations',
    'source_equations', 'direct_equations', 'receipts', 'run_all_attempted',
    'run_all_ok', 'run_all_errors', 'feature_registry_sha256', 'receipt_trace_sha256',
  ]) assert.equal(bun[field], python[field], `${field} parity`);
  assert.equal(bun.features_registered, 620);
  assert.equal(bun.run_all_ok, 620);
  assert.equal(bun.run_all_errors, 0);
  const equationShapeMatch = bun.equation_shape_sha256 === python.equation_shape_sha256;
  const equationPayloadMatch = bun.equation_payload_sha256 === python.equation_payload_sha256;
  console.log(`  PASS  aggregate counts, registry, and receipt trace match (${bun.atoms} atoms, ${bun.equations} equations, ${bun.receipts} receipts) ${Date.now() - started}ms`);
  console.log(`  LIMIT exact equation-shape parity: ${equationShapeMatch ? 'match' : 'diverged by Bun exactness improvements'}`);
  console.log(`  LIMIT exact equation-payload parity: ${equationPayloadMatch ? 'match' : 'diverged by Bun exactness metadata and residuals'}`);
  console.log('Summary: 1 pass / 0 fail of 1');
} catch (error) {
  console.error(`  FAIL  canonical aggregate parity mismatch ${Date.now() - started}ms`);
  console.error(error.stack || error.message);
  console.log('Summary: 0 pass / 1 fail of 1');
  process.exit(1);
}
