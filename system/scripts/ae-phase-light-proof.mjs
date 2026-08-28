#!/usr/bin/env bun

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AE_PHASE_TYPES,
  applyReceiveSequence,
  createReceiveWindow,
  decodePhaseFrame,
  encodePhaseFrame,
} from '../03-BACKEND/ae-phase-protocol.mjs';

const ROOT = path.resolve(import.meta.dir, '..');
const RECEIPT_DIR = path.join(ROOT, '10-RECEIPTS', 'orange5-build', 'ae-phase');
const SSH = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
const SSH_KEY = process.env.ORANGE5_CODEXA_KEY
  || path.join(os.homedir(), '.ssh', 'orange_codexa_automation_ed25519');
const CODEXA = process.env.ORANGE5_CODEXA_PHASE_HOST || '10.0.99.1';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function localHealth() {
  const response = await fetch('http://127.0.0.1:8907/health', { signal: AbortSignal.timeout(3_000) });
  return response.json();
}

function remoteHealth() {
  const result = Bun.spawnSync([
    SSH,
    '-i', SSH_KEY,
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=5',
    `Atom@${CODEXA}`,
    'curl.exe --silent --show-error --max-time 3 http://127.0.0.1:8907/health',
  ], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || `remote health exit ${result.exitCode}`);
  return JSON.parse(result.stdout.toString());
}

function protocolProof() {
  const baseKey = randomBytes(32);
  const senderHash = randomBytes(8);
  const packet = encodePhaseFrame({
    type: AE_PHASE_TYPES.DELTA,
    senderHash,
    epoch: 1n,
    seq: 1,
    payload: Buffer.from('{"probe":"phase"}'),
  }, { baseKey });
  const frame = decodePhaseFrame(packet, { baseKey });
  const window = createReceiveWindow({ senderHash, epoch: 1n });
  applyReceiveSequence(window, frame);
  let replayRejected = false;
  try { applyReceiveSequence(window, frame); }
  catch (error) { replayRejected = error.code === 'REPLAY_SEQUENCE'; }
  return {
    authenticatedRoundTrip: frame.payload.toString() === '{"probe":"phase"}',
    replayRejected,
  };
}

const local = await localHealth();
const remote = remoteHealth();
const protocol = protocolProof();
const localPeer = local.peers?.find((peer) => peer.nodeId === 'CODEXA') || local.peers?.[0] || null;
const remotePeer = remote.peers?.find((peer) => peer.nodeId === local.nodeId) || remote.peers?.[0] || null;
const checks = {
  local_active: local.ok === true && local.status === 'AE_PHASE_FABRIC_ACTIVE',
  codexa_active: remote.ok === true && remote.status === 'AE_PHASE_FABRIC_ACTIVE',
  direct_udp_path: local.transport === 'bun-udp-datagram'
    && local.directTcp === false
    && local.dnsOnFabric === false
    && localPeer?.endpoints?.some((endpoint) => endpoint.address === '10.0.99.1'),
  authenticated_encryption: local.authenticated === true
    && remote.authenticated === true
    && local.encrypted === 'aes-256-gcm'
    && remote.encrypted === 'aes-256-gcm'
    && protocol.authenticatedRoundTrip,
  replay_protection: protocol.replayRejected === true,
  n150_sees_codexa_exact_state: localPeer?.remoteStateValid === true
    && localPeer?.remoteStateRoot === remote.localStateRoot,
  codexa_sees_n150_exact_state: remotePeer?.remoteStateValid === true
    && remotePeer?.remoteStateRoot === local.localStateRoot,
  mutual_observation: localPeer?.observedLocalRoot === local.localStateRoot
    && remotePeer?.observedLocalRoot === remote.localStateRoot,
  no_auth_or_send_faults: local.counters?.authFailures === 0
    && remote.counters?.authFailures === 0
    && local.counters?.droppedSends === 0
    && remote.counters?.droppedSends === 0,
};

const ok = Object.values(checks).every(Boolean);
const receipt = {
  schema: 'orange.receipt.ae-phase-light-proof.v1',
  status: ok ? 'AE_PHASE_FABRIC_GREEN' : 'AE_PHASE_FABRIC_NEEDS_WORK',
  ok,
  at: new Date().toISOString(),
  checks,
  n150: {
    nodeId: local.nodeId,
    epoch: local.epoch,
    localStateRoot: local.localStateRoot,
    peerStateRoot: localPeer?.remoteStateRoot || null,
    endpoint: localPeer?.endpoints?.find((item) => item.address === '10.0.99.1') || null,
  },
  codexa: {
    nodeId: remote.nodeId,
    epoch: remote.epoch,
    localStateRoot: remote.localStateRoot,
    peerStateRoot: remotePeer?.remoteStateRoot || null,
  },
  protocol,
  transportLaw: {
    interMachine: 'authenticated Bun UDP datagrams',
    tcpAcrossDirectCable: false,
    dnsOnFabric: false,
    diskIsTruth: true,
  },
};
receipt.sha256 = sha256(Buffer.from(JSON.stringify(receipt), 'utf8'));
fs.mkdirSync(RECEIPT_DIR, { recursive: true });
const name = `${receipt.at.replace(/[:.]/g, '-')}-ae-phase-green.json`;
const receiptPath = path.join(RECEIPT_DIR, name);
fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ ...receipt, receiptPath }, null, 2)}\n`);
if (!ok) process.exitCode = 1;
