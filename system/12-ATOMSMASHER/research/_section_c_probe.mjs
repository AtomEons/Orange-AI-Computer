// Section C: 10x demo() loop with Bun.gc(true) between, sample heap at iter 1,3,5,7,10.
import { demo } from '../full-scope/engines.mjs';
import { Store } from '../full-scope/storage.mjs';

const samples = [];
const SAMPLE_AT = new Set([1, 3, 5, 7, 10]);

for (let i = 1; i <= 10; i++) {
  const store = new Store(':memory:');
  demo(store);
  store.db?.close?.();
  Bun.gc(true);
  if (SAMPLE_AT.has(i)) {
    const m = process.memoryUsage();
    samples.push({ iter: i, heap_mb: +(m.heapUsed / 1048576).toFixed(2), rss_mb: +(m.rss / 1048576).toFixed(2) });
  }
}

console.log(JSON.stringify({ samples }, null, 2));
const iter3 = samples.find(s => s.iter === 3).heap_mb;
const iter10 = samples.find(s => s.iter === 10).heap_mb;
const growth = +(iter10 - iter3).toFixed(2);
console.log(JSON.stringify({ heap_growth_iter3_to_10_mb: growth, pass: growth < 5 }));
