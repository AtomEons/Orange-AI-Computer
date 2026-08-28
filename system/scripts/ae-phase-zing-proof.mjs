#!/usr/bin/env bun

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clearLocalAEPhaseSignal,
  sendLocalAEPhaseSignal,
} from '../03-BACKEND/ae-phase-fabric.mjs';

const ROOT = path.resolve(import.meta.dir, '..');
const DATA_ROOT = process.env.ORANGE5_DATA_ROOT || path.join(os.homedir(), 'OrangeBox-Data', 'orange5');
const SIGNAL = path.join(DATA_ROOT, 'topology', 'ae-phase-signal.json');
const RECEIPTS = path.join(ROOT, '10-RECEIPTS', 'orange5-build', 'ae-phase');
const SSH = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
const SSH_KEY = process.env.ORANGE5_CODEXA_KEY || path.join(os.homedir(), '.ssh', 'orange_codexa_automation_ed25519');
const DEFAULT_BASIS_FILE = path.join(DATA_ROOT, 'crystal', 'ae-phase-basis-64m.bin');
const BASIS_FILE = process.env.ORANGE5_AE_PHASE_REFERENCE_FILE
  || (fs.existsSync(DEFAULT_BASIS_FILE) ? DEFAULT_BASIS_FILE : null);
const REMOTE_BASIS_FILE = process.env.ORANGE5_AE_PHASE_REMOTE_REFERENCE_FILE
  || (BASIS_FILE ? 'C:/Users/Atom/OrangeBox-Data/orange5/crystal/ae-phase-basis-64m.bin' : null);

const getHealth = async () => {
  const response = await fetch('http://127.0.0.1:8907/health', { signal: AbortSignal.timeout(2_000) });
  return response.json();
};

const getRemoteHealth = () => {
  const result = Bun.spawnSync([
    SSH, '-i', SSH_KEY, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
    'Atom@10.0.99.1',
    'curl.exe --silent --show-error --max-time 3 http://127.0.0.1:8907/health',
  ], { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || 'Codexa health failed');
  return JSON.parse(result.stdout.toString());
};

const getRemoteBasis = (filePath) => {
  if (!filePath) return null;
  const result = Bun.spawnSync([
    SSH, '-i', SSH_KEY, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
    'Atom@10.0.99.1',
    'C:/Users/Atom/.bun/bin/bun.exe',
    'C:/AtomEons/Orange5/scripts/ae-phase-basis-verify.mjs',
    filePath,
  ], { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || 'Codexa basis verification failed');
  return JSON.parse(result.stdout.toString());
};

const existed = fs.existsSync(SIGNAL);
const previous = existed ? fs.readFileSync(SIGNAL, 'utf8') : null;
const before = await getHealth();
const localBasis = BASIS_FILE ? {
  path: BASIS_FILE,
  bytes: fs.statSync(BASIS_FILE).size,
  sha256: createHash('sha256').update(fs.readFileSync(BASIS_FILE)).digest('hex'),
} : null;
const remoteBasis = getRemoteBasis(REMOTE_BASIS_FILE);
if (localBasis && (!remoteBasis || remoteBasis.bytes !== localBasis.bytes || remoteBasis.sha256 !== localBasis.sha256)) {
  throw new Error('AE Phase Crystal basis differs between N150 and Codexa');
}
const id = `zing-${randomUUID()}`;
const signal = {
  id,
  kind: 'phase_zing_proof',
  referenceHash: localBasis?.sha256 || createHash('sha256').update(id).digest('hex'),
  referenceBytes: localBasis?.bytes || Number(process.env.ORANGE5_AE_PHASE_REFERENCE_BYTES || 0),
  at: new Date().toISOString(),
};

let after = null;
let remote = null;
try {
  await sendLocalAEPhaseSignal(signal);
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    const current = await getHealth();
    if (current.localStateRoot !== before.localStateRoot
      && current.deltaAck?.root === current.localStateRoot
      && current.peers?.some((peer) => peer.observedLocalRoot === current.localStateRoot)) {
      after = current;
      break;
    }
    await Bun.sleep(1);
  }
  if (!after) throw new Error('AE Phase signal did not converge within 2 seconds');
  remote = getRemoteHealth();
} finally {
  if (existed) await sendLocalAEPhaseSignal(JSON.parse(previous));
  else await clearLocalAEPhaseSignal();
}

const remotePeer = remote.peers?.find((peer) => peer.nodeId === after.nodeId) || null;
const checks = {
  shared_basis_exact: !localBasis || (
    remoteBasis?.bytes === localBasis.bytes && remoteBasis?.sha256 === localBasis.sha256
  ),
  signal_changed_state_root: after.localStateRoot !== before.localStateRoot,
  internal_delta_ack_present: Number.isFinite(after.deltaAck?.lastMs),
  local_peer_observed_exact_root: after.peers?.some((peer) => peer.observedLocalRoot === after.localStateRoot),
  codexa_received_exact_root: remotePeer?.remoteStateRoot === after.localStateRoot,
  no_new_auth_fault: after.counters?.authFailures === before.counters?.authFailures,
  direct_path_acked_without_retry: after.pendingCriticalFrames === 0,
};
const ok = Object.values(checks).every(Boolean);
const receipt = {
  schema: 'orange.receipt.ae-phase-zing-proof.v1',
  status: ok ? 'AE_PHASE_ZING_GREEN' : 'AE_PHASE_ZING_NEEDS_WORK',
  ok,
  at: new Date().toISOString(),
  deltaToAckMs: after.deltaAck.lastMs,
  stateEquivalentBytes: after.deltaAck.stateEquivalentBytes,
  deltaPayloadBytes: after.deltaAck.deltaPayloadBytes,
  wireBytes: after.deltaAck.wireBytes,
  semanticGain: after.deltaAck.semanticGain,
  effectiveStateMbps: after.deltaAck.effectiveStateMbps,
  path: '10.0.99.2 -> 10.0.99.1:8905/udp',
  checks,
  stateRoot: after.localStateRoot,
  signalId: id,
  basis: localBasis ? {
    bytes: localBasis.bytes,
    sha256: localBasis.sha256,
    localPath: localBasis.path,
    remotePath: remoteBasis.path,
  } : null,
};
receipt.sha256 = createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
fs.mkdirSync(RECEIPTS, { recursive: true });
const receiptPath = path.join(RECEIPTS, `${receipt.at.replace(/[:.]/g, '-')}-zing.json`);
fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ ...receipt, receiptPath }, null, 2)}\n`);
if (!ok) process.exitCode = 1;
