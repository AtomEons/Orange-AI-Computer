import { parentPort, workerData } from 'node:worker_threads';

async function main() {
  const mod = await import(workerData.moduleUrl);
  const selected = [
    ['default', mod.default],
    ['named:check', mod.check],
    ['named:run', mod.run],
  ].find(([, fn]) => typeof fn === 'function');
  if (!selected) {
    parentPort.postMessage({ ok: false, reason: 'no_callable_export' });
    return;
  }
  const [kind, fn] = selected;
  const output = kind === 'named:run'
    ? await fn()
    : await fn(workerData.state || {}, { timeout_ms: workerData.timeoutMs });
  parentPort.postMessage({
    ok: true,
    kind,
    meta: { id: mod.id, slug: mod.slug, severity: mod.severity },
    output,
  });
}

main().catch((error) => parentPort.postMessage({
  ok: false,
  reason: 'check_threw',
  error: String(error?.message || error),
}));
