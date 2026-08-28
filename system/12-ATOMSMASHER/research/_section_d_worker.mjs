// Section D worker: writes 500 receipts to a shared file DB path.
import { Store } from '../full-scope/storage.mjs';
const dbPath = process.argv[2];
const workerId = process.argv[3];
if (!dbPath || !workerId) { console.error('NO_ARGS'); process.exit(2); }

const store = new Store(dbPath);
let inserted = 0;
let busyErrors = 0;
for (let i = 0; i < 500; i++) {
  try {
    store.insertReceipt(
      'concurrent_write_test',
      'ok',
      `worker=${workerId} i=${i}`,
      { worker: workerId, i },
      `worker_${workerId}`
    );
    inserted++;
  } catch (e) {
    if (String(e.message || e).includes('SQLITE_BUSY')) busyErrors++;
    else { console.error('UNEXPECTED', e.message); process.exit(3); }
  }
}
console.log(JSON.stringify({ worker: workerId, inserted, busyErrors }));
