#!/usr/bin/env bun

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LAUNCHER_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const FABRIC_MODULE_PATH = path.resolve(LAUNCHER_DIRECTORY, '../03-BACKEND/ae-phase-fabric.mjs');
let runtimeLog = null;

function logRuntime(message) {
  if (!runtimeLog) return;
  try {
    mkdirSync(path.dirname(runtimeLog), { recursive: true });
    appendFileSync(runtimeLog, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch {}
}

function argument(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

export function parseAEPhaseServiceArguments(argv = process.argv.slice(2)) {
  const mode = argv[0] ?? 'server';
  if (mode !== 'server' && mode !== 'client') {
    throw new Error(`AE Phase Fabric mode must be server or client, received: ${mode}`);
  }
  const dataRoot = argument(argv, '--data-root');
  if (!dataRoot) throw new Error('AE Phase Fabric requires --data-root');
  const keyFile = argument(argv, '--key-file', path.join(dataRoot, 'secrets', 'ae-phase-key.txt'));
  return Object.freeze({
    mode,
    dataRoot: path.resolve(dataRoot),
    keyFile: path.resolve(keyFile),
  });
}

function resolveStarter(fabricModule, mode) {
  const candidates = mode === 'server'
    ? ['startAEPhaseFabricServer', 'startPhaseFabricServer']
    : ['startAEPhaseFabricClient', 'startPhaseFabricClient'];
  const name = candidates.find((candidate) => typeof fabricModule[candidate] === 'function');
  if (!name) {
    throw new Error(`AE Phase Fabric backend does not export ${candidates.join(' or ')}`);
  }
  return fabricModule[name];
}

export async function launchAEPhaseService(argv = process.argv.slice(2)) {
  const options = parseAEPhaseServiceArguments(argv);
  if (!existsSync(options.keyFile)) throw new Error(`AE Phase Fabric key is missing: ${options.keyFile}`);
  if (!existsSync(FABRIC_MODULE_PATH)) throw new Error(`AE Phase Fabric backend is missing: ${FABRIC_MODULE_PATH}`);

  // Runtime configuration must exist before backend module initialization.
  process.env.ORANGE5_DATA_ROOT = options.dataRoot;
  process.env.ORANGE5_AE_PHASE_MODE = options.mode;
  process.env.ORANGE5_AE_PHASE_KEY_FILE = options.keyFile;
  runtimeLog = path.join(options.dataRoot, 'topology', `ae-phase-${options.mode}.runtime.log`);
  logRuntime(`launch pid=${process.pid} bun=${Bun.version}`);

  const fabricModule = await import(FABRIC_MODULE_PATH);
  const start = resolveStarter(fabricModule, options.mode);
  const fabric = await start({
    mode: options.mode,
    dataRoot: options.dataRoot,
    keyFile: options.keyFile,
  });
  if (!fabric || typeof fabric.close !== 'function') {
    throw new Error('AE Phase Fabric backend must return a runtime with close()');
  }
  logRuntime(`active pid=${process.pid}`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await fabric.close();
      logRuntime(`closed pid=${process.pid}`);
      process.exitCode = 0;
    } catch (error) {
      process.stderr.write(`${error?.stack || error}\n`);
      process.exitCode = 1;
    } finally {
      setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
    }
  };

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return fabric;
}

if (import.meta.main) {
  process.on('uncaughtException', (error) => {
    logRuntime(`uncaught ${error?.stack || error}`);
    process.exit(1);
  });
  process.on('unhandledRejection', (error) => {
    logRuntime(`unhandled ${error?.stack || error}`);
    process.exit(1);
  });
  process.on('exit', (code) => logRuntime(`exit code=${code}`));
  launchAEPhaseService().catch((error) => {
    logRuntime(`start_failed ${error?.stack || error}`);
    process.stderr.write(`${error?.stack || error}\n`);
    process.exit(1);
  });
}
