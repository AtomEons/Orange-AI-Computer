// 08-lease-gated-outbound.mjs — any outbound network from the daemon must be lease-gated.
//
// Two-part check:
//   (a) Static: scan the daemon's runtime code (flow-direct/, mirage/, clr/) for raw
//       fetch()/http calls that target non-loopback hosts without a `requireLease(...)`
//       wrapper. Anything unguarded → red with the file:line evidence.
//   (b) Live: POST a "would-call-outside" probe to the daemon (via a designated
//       /lease-probe endpoint when present). If the daemon refuses without a lease,
//       green. If it tries to dial out, red.
//
// (b) is best-effort — if /lease-probe isn't implemented yet, we report static-only
// and mark live=null honestly (still green overall iff static is clean).

import { run, defaultEnv, fetchT } from './_lib.mjs';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = '08-lease-gated-outbound';

const ROOT_REL = ['flow-direct', 'mirage', 'clr', 'flux'];
const LOOPBACK_RE = /(?:127\.0\.0\.1|localhost|0\.0\.0\.0|::1|\[::1\])/i;

async function walk(dir, acc) {
  let ents;
  try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, acc);
    else if (/\.(mjs|js|cjs|ts)$/i.test(e.name)) acc.push(p);
  }
}

function findOutboundCalls(src, file) {
  const findings = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    // Look for fetch( "http..." or fetch(`http...` patterns
    const m = /(fetch|http\.request|https\.request|undici\.fetch)\s*\(\s*([`'"])([^`'"]+)\2/.exec(ln);
    if (!m) continue;
    const url = m[3];
    if (!/^https?:\/\//i.test(url)) continue;
    if (LOOPBACK_RE.test(url)) continue;
    // Look up to ~5 lines back for a lease guard
    const ctx = lines.slice(Math.max(0, i - 5), i + 1).join('\n');
    const guarded = /requireLease|leaseGate|withLease|lease\.acquire|hasLease\(/.test(ctx);
    if (!guarded) findings.push({ file, line: i + 1, url, context: ln.trim().slice(0, 200) });
  }
  return findings;
}

export async function check(env = {}, opts = {}) {
  const E = { ...defaultEnv(), ...env };
  return run(GATE, E, opts, async () => {
    // (a) Static scan
    const here = dirname(fileURLToPath(import.meta.url));
    const daemonRoot = resolve(here, '..', '..');
    const files = [];
    for (const d of ROOT_REL) await walk(join(daemonRoot, d), files);

    const unguarded = [];
    let scanned = 0;
    for (const f of files) {
      try {
        const src = await readFile(f, 'utf8');
        scanned++;
        unguarded.push(...findOutboundCalls(src, f.replace(daemonRoot + '/', '').replace(daemonRoot + '\\', '')));
      } catch {}
    }

    const staticGreen = unguarded.length === 0;

    // (b) Live probe (best-effort)
    let live = { tried: false, ok: null, status: null, body: null, error: null };
    try {
      const r = await fetchT(E.bun_url + '/lease-probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'https://example.com', lease: null }),
      }, 2000);
      live.tried = true;
      live.status = r.status;
      const j = await r.json().catch(() => null);
      live.body = j;
      // Expect: 403 or {ok:false, reason:'no-lease'} → green
      if (r.status === 403 || r.status === 401) live.ok = true;
      else if (j && j.ok === false && /lease/i.test(j.reason || '')) live.ok = true;
      else if (r.status === 404) { live.ok = null; live.error = 'endpoint-not-implemented'; }
      else live.ok = false;
    } catch (e) {
      live.error = String(e.message || e);
    }

    // Overall verdict (no fake-green: static-clean alone is NOT enough — we
    // also need a live enforcement check, otherwise it's an honest gap):
    //   - static red                                  → red.
    //   - static green + live red                     → red.
    //   - static green + live green                   → green.
    //   - static green + live unknown (404/no probe)  → null (honest gap).
    //   - static green + live error (timeout/refused) → null (honest gap).
    let pass;
    if (!staticGreen) pass = false;
    else if (live.ok === false) pass = false;
    else if (live.ok === true) pass = true;
    else pass = null;

    return {
      pass,
      details: {
        reason: !staticGreen ? `unguarded outbound calls found (${unguarded.length})`
              : (live.ok === false ? 'live lease-probe shows daemon dials without lease'
              : (live.ok === null ? 'static clean BUT live probe endpoint unavailable — honest gap, not green'
              : 'static clean; live lease-probe enforces')),
        scanned_files: scanned,
        unguarded_findings: unguarded,
        live_probe: live,
        recommended_endpoint: 'POST /lease-probe → { target, lease } → 403 when lease missing',
      },
    };
  });
}
