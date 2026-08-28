#!/usr/bin/env node
// Orange5 Control Plane — Rail Token Generator
// =============================================
// Mints a fresh ORANGEBOX_RAIL_TOKEN (HS256 256-bit secret) used to authorize
// Codexa-side calls into the Orangebox gateway on the N150.
//
// Doctrine (rotation flow):
//   1. This script is the SOLE place where the raw token value exists.
//   2. The raw token is returned ONCE to stdout (JSON) so the rotation
//      driver can hand it to:
//        - Windows Credential Manager (DPAPI) on the N150
//        - Codexa /opt/atomeons/.rail-token (chmod 600) via rsync ceremony
//        - Atomic Orange Tauri tauri-plugin-stronghold encrypted store
//   3. Subsequent reads of the artifact on disk return ONLY the sha256
//      fingerprint — never the secret material.
//   4. Reality Flux audit rows record the prior + new sha256 only.
//
// Mom's Law:
//   - Tokens never appear in logs. We do not console.error the token.
//   - If stdout is a TTY and --force-tty is not passed, refuse to print.
//   - The on-disk fingerprint file (--fingerprint-out) is the only durable
//     record this script writes.
//
// Kill-switch:
//   - Operator can set ORANGEBOX_RAIL_DISABLED=1 elsewhere; this script
//     still mints (so rotation can pre-stage a token) but the gateway
//     refuses calls regardless.
//
// Usage:
//   node generate.mjs                       # mint, print JSON to stdout
//   node generate.mjs --fingerprint-out F   # also write sha256 row to F
//   node generate.mjs --force-tty           # allow stdout to be a TTY
//   node generate.mjs --read-fingerprint F  # print only sha256 from F
//
// Exit codes:
//   0  ok
//   2  refusing to print to TTY (use --force-tty or pipe)
//   3  io error writing fingerprint
//   4  invalid argument
//   5  read-fingerprint target missing or unreadable

import { randomBytes, createHash } from 'node:crypto';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { argv, stdout, stderr, exit, env } from 'node:process';

const TOKEN_BYTES = 32; // 256 bits — HS256-grade
const VERSION = '1.0.0';

function parseArgs(args) {
  const out = { fingerprintOut: null, forceTty: false, readFingerprint: null };
  for (let i = 2; i < args.length; i++) {
    const a = args[i];
    if (a === '--fingerprint-out') {
      out.fingerprintOut = args[++i];
      if (!out.fingerprintOut) {
        stderr.write('error: --fingerprint-out requires a path\n');
        exit(4);
      }
    } else if (a === '--force-tty') {
      out.forceTty = true;
    } else if (a === '--read-fingerprint') {
      out.readFingerprint = args[++i];
      if (!out.readFingerprint) {
        stderr.write('error: --read-fingerprint requires a path\n');
        exit(4);
      }
    } else if (a === '--help' || a === '-h') {
      stdout.write(
        'rail-token/generate.mjs v' + VERSION + '\n' +
        'Usage:\n' +
        '  node generate.mjs [--fingerprint-out PATH] [--force-tty]\n' +
        '  node generate.mjs --read-fingerprint PATH\n'
      );
      exit(0);
    } else {
      stderr.write(`error: unknown argument: ${a}\n`);
      exit(4);
    }
  }
  return out;
}

function base64url(buf) {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function sha256Hex(s) {
  return createHash('sha256').update(s).digest('hex');
}

function readFingerprint(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    stderr.write(`error: cannot read fingerprint file at ${path}: ${err.message}\n`);
    exit(5);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    stderr.write(`error: fingerprint file is not valid JSON: ${err.message}\n`);
    exit(5);
  }
  if (!parsed || typeof parsed.sha256 !== 'string') {
    stderr.write('error: fingerprint file missing sha256 field\n');
    exit(5);
  }
  // Emit ONLY the fingerprint — never the token (which is never on disk anyway).
  stdout.write(JSON.stringify({
    sha256: parsed.sha256,
    generated_at: parsed.generated_at || null,
    version: parsed.version || null,
  }) + '\n');
  exit(0);
}

function writeFingerprint(path, payload) {
  try {
    const dir = dirname(resolve(path));
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    // Fingerprint payload is sha256 + timestamp ONLY — no token material.
    const safe = {
      sha256: payload.sha256,
      generated_at: payload.generated_at,
      version: payload.version,
      algo: 'HS256',
      bits: TOKEN_BYTES * 8,
    };
    writeFileSync(path, JSON.stringify(safe, null, 2) + '\n', { mode: 0o600 });
  } catch (err) {
    stderr.write(`error: failed to write fingerprint to ${path}: ${err.message}\n`);
    exit(3);
  }
}

function main() {
  const args = parseArgs(argv);

  if (args.readFingerprint) {
    readFingerprint(args.readFingerprint);
    return;
  }

  // Mint
  const raw = randomBytes(TOKEN_BYTES);
  const token = base64url(raw);
  const sha256 = sha256Hex(token);
  const generated_at = new Date().toISOString();

  // Mom's Law guard: do not splash the token onto a human's terminal
  // unless the operator explicitly asked. The rotation driver should
  // always pipe to a process or a secure sink.
  if (stdout.isTTY && !args.forceTty) {
    stderr.write(
      'refusing to emit raw token to a TTY. Pipe to the rotation driver, ' +
      'or pass --force-tty if you really mean it.\n' +
      `sha256=${sha256}\n` +
      `generated_at=${generated_at}\n`
    );
    if (args.fingerprintOut) {
      writeFingerprint(args.fingerprintOut, { sha256, generated_at, version: VERSION });
      stderr.write(`fingerprint written to ${args.fingerprintOut}\n`);
    }
    exit(2);
  }

  if (args.fingerprintOut) {
    writeFingerprint(args.fingerprintOut, { sha256, generated_at, version: VERSION });
  }

  // Single-shot stdout emission. Caller MUST consume immediately.
  const payload = {
    token,           // RAW — present exactly once, here.
    sha256,          // fingerprint for audit
    generated_at,    // ISO-8601 UTC
    algo: 'HS256',
    bits: TOKEN_BYTES * 8,
    version: VERSION,
  };
  stdout.write(JSON.stringify(payload) + '\n');

  // Best-effort: scrub local references. (Node will GC; we cannot zero
  // the underlying buffer reliably, but we drop refs to discourage
  // accidental reuse in any embedder.)
  payload.token = null;
}

main();
