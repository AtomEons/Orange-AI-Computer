// Section B probe: run demo() once with fixed seed, dump sorted receipt IDs sha256.
import crypto from 'node:crypto';
import { demo, __resetDeterminismCounter } from '../full-scope/engines.mjs';
import { Store } from '../full-scope/storage.mjs';

if (!process.env.ATOMSMASHER_DETERMINISM_SEED) {
  console.error('NO_SEED');
  process.exit(2);
}
__resetDeterminismCounter();

const store = new Store(':memory:');
demo(store);

const rows = store.all('SELECT id FROM receipts ORDER BY id ASC');
const ids = rows.map(r => r.id).sort();
const sha = crypto.createHash('sha256').update(ids.join('\n')).digest('hex');
console.log(JSON.stringify({ count: ids.length, sha256: sha, first_3: ids.slice(0,3), last_3: ids.slice(-3) }));
