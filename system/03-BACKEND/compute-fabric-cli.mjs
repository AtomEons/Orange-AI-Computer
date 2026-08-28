#!/usr/bin/env bun
import { execFileSync } from 'node:child_process';
import { configureComputeNode, discoverComputeFabric } from './compute-fabric.mjs';

const args = process.argv.slice(2);
const command = args[0] || 'discover';

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function cachedNeighborHosts() {
  if (args.includes('--no-neighbors')) return [];
  try {
    const output = execFileSync(process.platform === 'win32' ? 'arp.exe' : 'arp', ['-a'], { encoding: 'utf8', timeout: 3_000 });
    return [...new Set(output.match(/\b(?:10(?:\.\d{1,3}){3}|127(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g) || [])]
      .filter((host) => host !== '127.0.0.1' && !/\.255$/.test(host))
      .slice(0, 24);
  } catch {
    return [];
  }
}

if (command === 'add') {
  const id = args[1];
  const host = args[2];
  if (!id || !host) throw new Error('usage: orange fabric add NAME HOST [--trust] [--priority N]');
  const configured = configureComputeNode({ id, name: id, host, trusted: args.includes('--trust'), priority: Number(valueAfter('--priority')) || 0 });
  console.log(JSON.stringify({ status: 'CONFIGURED', node: configured }, null, 2));
} else if (command === 'discover' || command === 'status') {
  const state = await discoverComputeFabric({ neighborHosts: cachedNeighborHosts(), timeoutMs: Number(valueAfter('--timeout-ms')) || 900 });
  console.log(JSON.stringify(state, null, 2));
  if (!state.operational) process.exitCode = 1;
} else {
  throw new Error('usage: orange fabric [discover|status] [--no-neighbors] OR orange fabric add NAME HOST [--trust]');
}
