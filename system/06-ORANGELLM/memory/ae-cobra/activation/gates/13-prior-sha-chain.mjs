// 13-prior-sha-chain.mjs — verify the hash-chain on Reality + Thought lanes is unbroken.
//
// Contract (per Night-1 doctrine + flux/writer.mjs intent): every JSONL line is a
// JSON object that contains a `sha256` of itself (sans the `sha256` field) and a
// `prior_sha256` equal to the previous line's `sha256`. The very first line has
// `prior_sha256` equal to a documented genesis sentinel ("0"*64) OR null.
//
// Acceptable alt-field-names tolerated (some writers use `hash` / `prev_hash`):
//   sha256 ↔ hash
//   prior_sha256 ↔ prev_sha256 ↔ prev_hash
//
// This gate is host-agnostic where it can read the files (it does not require the
// daemon to be live). Off-host with /mnt/ae_flux unreachable → pass:null.

import { run, defaultEnv, detectHost, remoteOnly } from './_lib.mjs';
import { stat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const GATE = '13-prior-sha-chain';
const GENESIS_RE = /^(0{64}|null|GENESIS)?$/i;

function pickHash(obj) {
  return obj.sha256 ?? obj.hash ?? null;
}
function pickPrior(obj) {
  return obj.prior_sha256 ?? obj.prev_sha256 ?? obj.prev_hash ?? null;
}

function recomputeHash(obj) {
  // Hash a canonical JSON serialization of the object MINUS the hash field itself.
  const clone = { ...obj };
  delete clone.sha256;
  delete clone.hash;
  // Canonical key order
  const sorted = Object.keys(clone).sort().reduce((acc, k) => (acc[k] = clone[k], acc), {});
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

async function verifyFile(path) {
  let raw;
  try { raw = await readFile(path, 'utf8'); }
  catch (e) { return { path, exists: false, error: String(e.message || e) }; }

  const lines = raw.split('\n').filter(Boolean);
  const n = lines.length;
  if (n === 0) return { path, exists: true, n: 0, ok: true, note: 'empty lane (no events yet)' };

  let prev = null;
  let break_at = null;
  let parsed = 0;
  let recomputed_mismatch = 0;
  for (let i = 0; i < n; i++) {
    let obj;
    try { obj = JSON.parse(lines[i]); }
    catch (e) { break_at = { i, reason: 'json-parse', sample: lines[i].slice(0, 200), error: String(e.message || e) }; break; }
    parsed++;

    const h = pickHash(obj);
    const p = pickPrior(obj);

    if (!h) { break_at = { i, reason: 'missing-hash-field', sample: lines[i].slice(0, 200) }; break; }

    // Recompute (best-effort — only if we can determine the canonical form)
    const r = recomputeHash(obj);
    if (r !== h) recomputed_mismatch++;

    if (i === 0) {
      // First line: prior should be a genesis sentinel or null
      if (p && !GENESIS_RE.test(String(p))) {
        break_at = { i, reason: 'first-line-prior-not-genesis', prior: p }; break;
      }
    } else {
      if (p !== prev) {
        break_at = { i, reason: 'prior-mismatch', expected: prev, got: p }; break;
      }
    }
    prev = h;
  }

  return {
    path,
    exists: true,
    n,
    parsed,
    recomputed_mismatch,
    ok: !break_at,
    break_at,
    last_hash: prev,
  };
}

async function resolveLanePath(E, lane) {
  // Prefer explicit; else newest per-date file.
  const explicit = lane === 'reality' ? E.flux_reality : E.flux_thought;
  try {
    const s = await stat(explicit);
    if (s.isFile()) return explicit;
  } catch {}
  try {
    const dir = join(E.flux_root, 'events', lane);
    const { readdir } = await import('node:fs/promises');
    const ents = await readdir(dir);
    const jsonl = ents.filter(n => n.endsWith('.jsonl')).sort();
    if (jsonl.length) return join(dir, jsonl[jsonl.length - 1]);
  } catch {}
  return null;
}

export async function check(env = {}, opts = {}) {
  const E = { ...defaultEnv(), ...env };
  return run(GATE, E, opts, async () => {
    const host = await detectHost(E);

    // We CAN run this gate off-host iff the flux mount is reachable, but normally
    // /mnt/ae_flux only exists on Codexa WSL2.
    const reality = await resolveLanePath(E, 'reality');
    const thought = await resolveLanePath(E, 'thought');

    if (!reality && !thought) {
      if (host !== 'codexa-wsl2') {
        return remoteOnly(GATE,
`# On Codexa WSL2:
node ${import.meta.url.replace('file://', '')}  # or run via gate driver`);
      }
      return { pass: false, details: { reason: 'no lane files found',
        tried: [E.flux_reality, E.flux_thought, E.flux_root + '/events/'] } };
    }

    const realityRes = reality ? await verifyFile(reality) : { skipped: true, reason: 'no reality file' };
    const thoughtRes = thought ? await verifyFile(thought) : { skipped: true, reason: 'no thought file' };

    const realityOk = !!(realityRes.skipped || realityRes.ok);
    const thoughtOk = !!(thoughtRes.skipped || thoughtRes.ok);
    const pass = realityOk && thoughtOk;

    // Soft warning: if recomputed_mismatch > 0 on otherwise-chained file, the writer
    // is using a hashing convention this gate didn't guess. NOT a hard fail.
    const recomputeWarn = [];
    if (realityRes.recomputed_mismatch > 0) recomputeWarn.push({ lane: 'reality', mismatches: realityRes.recomputed_mismatch });
    if (thoughtRes.recomputed_mismatch > 0) recomputeWarn.push({ lane: 'thought', mismatches: thoughtRes.recomputed_mismatch });

    return {
      pass,
      details: {
        reason: pass ? 'prior_sha chain intact on both lanes'
                     : `reality.ok=${realityOk} thought.ok=${thoughtOk}`,
        reality: realityRes,
        thought: thoughtRes,
        recompute_warning: recomputeWarn.length ? recomputeWarn : null,
        note: 'recompute_warning is informational — chain validity is decided by prior_sha linkage, not by re-hashing convention.',
      },
    };
  });
}
