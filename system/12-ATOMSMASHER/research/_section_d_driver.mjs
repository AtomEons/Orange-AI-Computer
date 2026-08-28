// Section D driver: spawn 2 workers concurrently against same DB.
import fs from 'node:fs';
import path from 'node:path';

const tmpDb = path.join(process.cwd(), 'research', '_section_d_db_' + Date.now() + '.sqlite');
try { fs.rmSync(tmpDb, { force: true }); } catch {}
try { fs.rmSync(tmpDb + '-wal', { force: true }); } catch {}
try { fs.rmSync(tmpDb + '-shm', { force: true }); } catch {}

// Pre-init schema by opening Store once and closing
const { Store } = await import('../full-scope/storage.mjs');
const init = new Store(tmpDb);
init.db?.close?.();

const workerPath = path.join(process.cwd(), 'research', '_section_d_worker.mjs');
const spawn = (wid) => Bun.spawn(['bun', workerPath, tmpDb, wid], {
  cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe',
});
const t0 = Date.now();
const p1 = spawn('A');
const p2 = spawn('B');
const [out1, err1, ec1, out2, err2, ec2] = await Promise.all([
  new Response(p1.stdout).text(),
  new Response(p1.stderr).text(),
  p1.exited,
  new Response(p2.stdout).text(),
  new Response(p2.stderr).text(),
  p2.exited,
]);
const wallMs = Date.now() - t0;

console.log('Worker A:', out1.trim(), 'stderr:', err1.trim(), 'exit:', ec1);
console.log('Worker B:', out2.trim(), 'stderr:', err2.trim(), 'exit:', ec2);

// Verify counts in DB
const verify = new Store(tmpDb);
const total = verify.all('SELECT COUNT(*) AS c FROM receipts')[0].c;
const distinct = verify.all('SELECT COUNT(DISTINCT id) AS c FROM receipts')[0].c;
const byWorker = verify.all("SELECT feature_id, COUNT(*) AS c FROM receipts GROUP BY feature_id ORDER BY feature_id");
verify.db?.close?.();

console.log(JSON.stringify({
  total_rows: total,
  distinct_ids: distinct,
  by_worker: byWorker,
  wall_ms: wallMs,
  pass: total === 1000 && distinct === 1000
}, null, 2));

// Cleanup
try { fs.rmSync(tmpDb, { force: true }); } catch {}
try { fs.rmSync(tmpDb + '-wal', { force: true }); } catch {}
try { fs.rmSync(tmpDb + '-shm', { force: true }); } catch {}
