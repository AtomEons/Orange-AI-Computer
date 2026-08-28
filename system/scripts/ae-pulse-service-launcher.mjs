#!/usr/bin/env bun

import path from 'node:path';

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const mode = process.argv[2] === 'client' ? 'client' : 'server';
const dataRoot = argument('--data-root');
if (dataRoot) process.env.ORANGE5_DATA_ROOT = path.resolve(dataRoot);
process.env.ORANGE5_AE_PULSE_MODE = mode;

const {
  startPulseCarrierClient,
  startPulseCarrierServer,
} = await import('../03-BACKEND/ae-pulse-carrier.mjs');

const carrier = mode === 'server'
  ? startPulseCarrierServer()
  : startPulseCarrierClient();

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  carrier.close();
  setTimeout(() => process.exit(0), 50);
};

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
