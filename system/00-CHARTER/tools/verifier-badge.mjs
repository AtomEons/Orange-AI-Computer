#!/usr/bin/env bun
// Orange5 DX — verifier-badge
//
// Wraps the FULL verifier's `--json` output into a compact badge:
//   { green, red, total, pct, timestamp }
//
// It NEVER modifies the verifier. It spawns it read-only:
//   bun 00-CHARTER/orange5-full-verifier.mjs --json
// and reduces the machine-readable payload to a one-glance status badge.
//
// The verifier exits 1 when any suite is red and 0 when all green — that is
// NOT an error for us, so we read stdout regardless of exit code and only
// treat a *missing/unparseable* JSON payload as a real failure.
//
// Usage:
//   bun 00-CHARTER/tools/verifier-badge.mjs            # human line + JSON
//   bun 00-CHARTER/tools/verifier-badge.mjs --json     # JSON only
//   bun 00-CHARTER/tools/verifier-badge.mjs --shield   # shields.io endpoint JSON
//
// Programmatic:  import { badgeFromVerifierJson, runBadge } from './verifier-badge.mjs'
//
// Mom's Law: the badge reflects ground truth from the verifier, never a guess.

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const VERIFIER_REL = '00-CHARTER/orange5-full-verifier.mjs';

// Pure reducer: verifier JSON object -> compact badge. Exported for testing so
// the badge shape can be verified without spawning the (multi-minute) verifier.
export function badgeFromVerifierJson(v, at = new Date()) {
  if (v == null || typeof v !== 'object') {
    throw new TypeError('verifier JSON must be an object');
  }
  const total = Number.isFinite(v.total) ? v.total : 0;
  const green = Number.isFinite(v.green) ? v.green : 0;
  const red = Number.isFinite(v.red) ? v.red : Math.max(0, total - green);
  // pct = green / total, 1-decimal, honest 0 when there are no tests.
  const pct = total > 0 ? Math.round((green / total) * 1000) / 10 : 0;
  return {
    green,
    red,
    total,
    pct,
    allGreen: red === 0 && total > 0,
    timestamp: (at instanceof Date ? at : new Date(at)).toISOString(),
  };
}

// shields.io "endpoint" schema so the badge can be surfaced as an image later.
export function toShield(badge) {
  const color = badge.allGreen ? 'brightgreen' : badge.red > 0 ? 'red' : 'lightgrey';
  return {
    schemaVersion: 1,
    label: 'orange5 verify',
    message: `${badge.green}/${badge.total} (${badge.pct}%)`,
    color,
  };
}

// Extract the last complete top-level JSON object from mixed stdout.
// The verifier prints ONLY JSON under --json, but we stay defensive in case a
// wrapper prepends a warning line.
export function extractJson(stdout) {
  const s = String(stdout ?? '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('no JSON object found in verifier output');
  }
  return JSON.parse(s.slice(start, end + 1));
}

// Spawn the verifier read-only and build the badge. Returns { badge, raw }.
export function runBadge({ root = ROOT, verifierRel = VERIFIER_REL } = {}) {
  const res = spawnSync('bun', [verifierRel, '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) {
    throw new Error(`failed to spawn verifier: ${res.error.message}`);
  }
  // exit 1 (reds present) is expected — parse stdout regardless.
  const raw = extractJson(res.stdout);
  return { badge: badgeFromVerifierJson(raw), raw, verifierPath: join(root, verifierRel) };
}

// ---- CLI ----
function main() {
  const args = process.argv.slice(2);
  const jsonOnly = args.includes('--json');
  const shield = args.includes('--shield');
  const { badge } = runBadge();
  if (shield) {
    console.log(JSON.stringify(toShield(badge), null, 2));
    return;
  }
  if (jsonOnly) {
    console.log(JSON.stringify(badge, null, 2));
    return;
  }
  const tag = badge.allGreen ? 'GREEN' : 'RED';
  console.log(`[orange5:${tag}] ${badge.green}/${badge.total} green  (${badge.pct}%)  red=${badge.red}  @ ${badge.timestamp}`);
  console.log(JSON.stringify(badge));
}

if (import.meta.main) main();
