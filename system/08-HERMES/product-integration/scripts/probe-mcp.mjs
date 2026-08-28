#!/usr/bin/env bun
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const get = (name, fallback = null) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};

const bunPath = get('--bun', process.execPath);
const serverPath = resolve(get('--server', ''));
const timeoutMs = Number(get('--timeout', '15000'));
if (!serverPath) throw new Error('--server is required');

const child = Bun.spawn([bunPath, serverPath], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
const decoder = new TextDecoder();
let buffer = '';
let nextId = 1;
const pending = new Map();

const reader = child.stdout.getReader();
const readLoop = (async () => {
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (waiter) { pending.delete(message.id); waiter.resolve(message); }
    }
  }
})();

function call(method, params = {}) {
  const id = nextId++;
  const request = { jsonrpc: '2.0', id, method, params };
  child.stdin.write(`${JSON.stringify(request)}\n`);
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP timeout for ${method}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolvePromise(value); },
      reject,
    });
  });
}

try {
  const initialized = await call('initialize', {
    protocolVersion: '2026-07-28',
    capabilities: {},
    clientInfo: { name: 'orange5-hermes-preflight', version: '1.0.0' },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const listed = await call('tools/list', {
    _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
  });
  const tools = (listed.result?.tools || []).map((tool) => tool.name).sort();
  const required = ['orange5_health', 'orange5_order', 'orange5_route', 'orange5_receipts', 'orange5_delegate'].sort();
  const expectedRaw = [
    'orange5_browser', 'orange5_chat', 'orange5_delegate', 'orange5_execute', 'orange5_health',
    'orange5_model_lease', 'orange5_order', 'orange5_receipts', 'orange5_route', 'orange5_superstack',
  ].sort();
  const missing = required.filter((name) => !tools.includes(name));
  const drift = tools.filter((name) => !expectedRaw.includes(name)).concat(expectedRaw.filter((name) => !tools.includes(name)));
  console.log(JSON.stringify({
    schema: 'orange5.hermes-mcp-probe.v1',
    status: missing.length || drift.length ? 'FAIL' : 'PASS',
    protocol: initialized.result?.protocolVersion || null,
    server: initialized.result?.serverInfo || null,
    required,
    missing,
    expectedRaw,
    drift,
    discoveredCount: tools.length,
  }));
  process.exitCode = missing.length || drift.length ? 1 : 0;
} catch (error) {
  console.log(JSON.stringify({ schema: 'orange5.hermes-mcp-probe.v1', status: 'FAIL', error: error.message }));
  process.exitCode = 1;
} finally {
  child.kill();
  await Promise.race([readLoop, Bun.sleep(500)]);
}
