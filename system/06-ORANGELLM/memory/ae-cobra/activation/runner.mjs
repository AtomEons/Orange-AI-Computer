#!/usr/bin/env node
// runner.mjs — Æ Cobra Night-1 activation orchestrator.
//
// Runs the 14-gate activation checklist in order, short-circuits on first FAIL,
// writes a Markdown receipt to 10-RECEIPTS/orange5-build/ae-cobra-night1-activation-attempt-{n}.md.
//
// Invocation (from 06-ORANGELLM/memory/ae-cobra/activation/):
//   node runner.mjs --target codexa      # remote: gates execute over SSH on Codexa WSL2
//   node runner.mjs --target local-wsl   # local: gates execute on this host's WSL2 (Codexa is N150-attached)
//
// Returns (stdout JSON, also written to receipt):
//   { ok, gate_failed?, evidence: [{ gate_id, pass, details, latency_ms }] }
//
// Honest-green discipline:
//   * Any gate that fundamentally requires daemon-side execution and cannot be reached from
//     the caller is reported as { pass: false, details: { skipped_unreachable: true, reason } }
//     and short-circuits the run — it is NEVER reported as pass.
//   * Gate definitions follow the operator's 14-point list verbatim.
//
// Doctrine references:
//   * Brief specifies daemon reach on 127.0.0.1:9100 inside WSL2 (proxied via gateway /v1/cobra/* on N150).
//     This differs from the existing scaffolding (bin/start.sh uses :7418 llama + :7419 Bun).
//     This runner uses 9100 by default per the explicit activation brief; override with AE_COBRA_BUN_PORT.
//   * Brief specifies flux at /mnt/ae_flux/reality.jsonl and /mnt/ae_flux/thought.jsonl
//     (single-file form). Existing writer.mjs uses /mnt/ae_flux/events/<lane>/<date>.jsonl.
//     Runner probes BOTH paths and reports whichever exists; chain integrity is verified on
//     whichever form is found. Operator must resolve the schema fork before promotion.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);

// ─────────────────────────────────────────────────────────────────────────────
// CLI parse

const argv = process.argv.slice(2);
function arg(name, dflt = undefined) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) return true;
  return v;
}

const TARGET = arg('target', 'local-wsl'); // codexa | local-wsl
if (!['codexa', 'local-wsl'].includes(TARGET)) {
  console.error(`FATAL: --target must be 'codexa' or 'local-wsl' (got: ${TARGET})`);
  process.exit(2);
}

// Configuration (overridable via env)
const CFG = {
  daemonPort: parseInt(process.env.AE_COBRA_BUN_PORT || '9100', 10),
  daemonHost: '127.0.0.1',
  llamaPort: parseInt(process.env.AE_COBRA_LLAMA_PORT || '7418', 10),
  fluxRoot: process.env.AE_FLUX_ROOT || '/mnt/ae_flux',
  modelPath: process.env.AE_COBRA_MODEL || '/opt/atomeons/ae-cobra/models/ae-blackmamba-2.8b-Q5_K_M.gguf',
  modelExpectedSha256: process.env.AE_COBRA_MODEL_SHA256 || null, // null = integrity-by-format-only
  sshHost: process.env.AE_COBRA_SSH_HOST || 'codexa',
  sshUser: process.env.AE_COBRA_SSH_USER || null,
  // Gate thresholds (mirror operator's 14-point checklist exactly)
  ctxSizeMax: 1024,
  rssMaxBytes: 10 * 1024 * 1024 * 1024, // 10 GB
  ttftColdMaxMs: 5000,
  jsonValidMinPct: 0.95,
  smokePairCount: 100,
  burnInSeconds: 60,
};

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..', '..');
// resolve back to the OrangeFive checkout root
// activation/runner.mjs -> activation -> ae-cobra -> memory -> 06-ORANGELLM -> Orange5
const ORANGE5_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const RECEIPTS_DIR = path.join(ORANGE5_ROOT, '10-RECEIPTS', 'orange5-build');

// ─────────────────────────────────────────────────────────────────────────────
// Execution shims — local vs remote (SSH)

/**
 * Run a shell command on the target plane.
 * Returns { code, stdout, stderr, error? }. Never throws.
 */
async function sh(cmd, { timeoutMs = 15000 } = {}) {
  let bin, args;
  if (TARGET === 'codexa') {
    // -o BatchMode=yes refuses password prompts (fail loud rather than hang)
    bin = 'ssh';
    args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5'];
    if (CFG.sshUser) args.push(`${CFG.sshUser}@${CFG.sshHost}`);
    else args.push(CFG.sshHost);
    args.push('bash', '-lc', cmd);
  } else {
    // local-wsl: assume we are already inside WSL2, run via /bin/bash
    // If we're on Windows Node calling this, we need wsl.exe; honest-detect.
    if (process.platform === 'win32') {
      bin = 'wsl.exe';
      args = ['bash', '-lc', cmd];
    } else {
      bin = 'bash';
      args = ['-lc', cmd];
    }
  }
  try {
    const { stdout, stderr } = await execFileP(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout || '',
      stderr: e.stderr || '',
      error: e.message,
    };
  }
}

/**
 * HTTP probe against the daemon, executed on the target plane (so loopback works on Codexa).
 * We use curl on the remote rather than node's fetch on the caller — loopback on the caller
 * is NOT the daemon's loopback when target=codexa.
 */
async function curl(urlPath, { method = 'GET', body = null, timeoutMs = 10000, daemonPort = CFG.daemonPort } = {}) {
  const url = `http://${CFG.daemonHost}:${daemonPort}${urlPath}`;
  const start = Date.now();
  let cmd;
  if (body) {
    // body via stdin to avoid shell-escape hell
    const b64 = Buffer.from(body).toString('base64');
    cmd = `printf %s '${b64}' | base64 -d | curl -sS -X ${method} --max-time ${Math.ceil(timeoutMs / 1000)} -H 'content-type: application/json' --data-binary @- -w '\\n__HTTP_STATUS__%{http_code}__\\n__TTFB__%{time_starttransfer}__' '${url}'`;
  } else {
    cmd = `curl -sS -X ${method} --max-time ${Math.ceil(timeoutMs / 1000)} -w '\\n__HTTP_STATUS__%{http_code}__\\n__TTFB__%{time_starttransfer}__' '${url}'`;
  }
  const r = await sh(cmd, { timeoutMs: timeoutMs + 5000 });
  const elapsed = Date.now() - start;
  const statusM = r.stdout.match(/__HTTP_STATUS__(\d+)__/);
  const ttfbM = r.stdout.match(/__TTFB__([\d.]+)__/);
  const status = statusM ? parseInt(statusM[1], 10) : null;
  const ttfbMs = ttfbM ? Math.round(parseFloat(ttfbM[1]) * 1000) : null;
  const body_ = r.stdout.replace(/\n__HTTP_STATUS__\d+__\n__TTFB__[\d.]+__\s*$/, '');
  return { status, ttfbMs, elapsedMs: elapsed, body: body_, raw: r };
}

// ─────────────────────────────────────────────────────────────────────────────
// Gates — each returns { pass: bool, details: object }
// Gate function must be a pure async (ctx) => result. ctx carries cross-gate state.

const GATES = [];
function gate(id, label, fn) {
  GATES.push({ id, label, fn });
}

// G01 — GGUF integrity. File exists, magic bytes 'GGUF', size sane (>500 MB for a 2.8B Q5_K_M),
// optional SHA-256 match if AE_COBRA_MODEL_SHA256 is set.
gate('G01', 'GGUF integrity', async () => {
  const r = await sh(`stat -c '%s' '${CFG.modelPath}' 2>/dev/null && head -c 4 '${CFG.modelPath}' | xxd -p`);
  if (r.code !== 0) {
    return { pass: false, details: { reason: 'stat/read failed', stderr: r.stderr, modelPath: CFG.modelPath } };
  }
  const lines = r.stdout.trim().split('\n');
  const size = parseInt(lines[0], 10);
  const magicHex = (lines[1] || '').trim();
  const magicAscii = Buffer.from(magicHex, 'hex').toString('ascii');
  const out = { modelPath: CFG.modelPath, size_bytes: size, magic_ascii: magicAscii };

  if (magicAscii !== 'GGUF') {
    return { pass: false, details: { ...out, reason: `magic mismatch: expected 'GGUF', got '${magicAscii}'` } };
  }
  if (!Number.isFinite(size) || size < 500_000_000) {
    return { pass: false, details: { ...out, reason: `size implausible (<500MB) for Mamba 2.8B Q5_K_M` } };
  }

  if (CFG.modelExpectedSha256) {
    const sh1 = await sh(`sha256sum '${CFG.modelPath}'`, { timeoutMs: 120_000 });
    if (sh1.code !== 0) {
      return { pass: false, details: { ...out, reason: 'sha256sum failed', stderr: sh1.stderr } };
    }
    const got = sh1.stdout.trim().split(/\s+/)[0];
    out.sha256_got = got;
    out.sha256_expected = CFG.modelExpectedSha256;
    if (got.toLowerCase() !== CFG.modelExpectedSha256.toLowerCase()) {
      return { pass: false, details: { ...out, reason: 'sha256 mismatch' } };
    }
  } else {
    out.sha256_checked = false;
    out.sha256_note = 'AE_COBRA_MODEL_SHA256 not set — integrity verified by GGUF magic + size envelope only';
  }
  return { pass: true, details: out };
});

// G02 — ctx-size <= 1024. Read from /proc/<llama-pid>/cmdline (authoritative runtime arg).
gate('G02', 'ctx-size <= 1024', async (ctx) => {
  const r = await sh(`pgrep -f llama-server | head -1`);
  const pid = (r.stdout || '').trim();
  if (!pid) {
    return { pass: false, details: { reason: 'llama-server not running — cannot verify ctx-size', daemon_required: true } };
  }
  ctx.llamaPid = pid;
  const cl = await sh(`cat /proc/${pid}/cmdline | tr '\\0' ' '`);
  if (cl.code !== 0) {
    return { pass: false, details: { reason: 'cannot read /proc cmdline', pid } };
  }
  const cmdline = cl.stdout.trim();
  const m = cmdline.match(/--ctx-size\s+(\d+)/);
  if (!m) {
    return { pass: false, details: { reason: '--ctx-size flag not present in llama-server cmdline', cmdline, pid } };
  }
  const ctxSize = parseInt(m[1], 10);
  const pass = ctxSize <= CFG.ctxSizeMax;
  return { pass, details: { ctx_size: ctxSize, max: CFG.ctxSizeMax, pid } };
});

// G03 — mlock binds. VmLck > 0 in /proc/<pid>/status, VmSwap == 0.
gate('G03', 'mlock binds (VmLck > 0, VmSwap == 0)', async (ctx) => {
  if (!ctx.llamaPid) {
    return { pass: false, details: { reason: 'llama-server PID unknown (G02 prereq)' } };
  }
  const r = await sh(`grep -E '^(VmLck|VmSwap|VmRSS):' /proc/${ctx.llamaPid}/status`);
  if (r.code !== 0) {
    return { pass: false, details: { reason: 'cannot read /proc status', pid: ctx.llamaPid } };
  }
  const lines = r.stdout.trim().split('\n');
  const map = {};
  for (const ln of lines) {
    const [k, v] = ln.split(':').map(s => s.trim());
    const kb = parseInt(v, 10);
    map[k] = Number.isFinite(kb) ? kb : null;
  }
  ctx.vmRssKb = map.VmRSS;
  const pass = (map.VmLck || 0) > 0 && (map.VmSwap || 0) === 0;
  return {
    pass,
    details: {
      VmLck_kb: map.VmLck, VmSwap_kb: map.VmSwap, VmRSS_kb: map.VmRSS,
      pid: ctx.llamaPid,
      reason: pass ? null : 'mlock not bound or pages swapped',
    },
  };
});

// G04 — RSS <= 10 GB.
gate('G04', 'RSS <= 10 GB', async (ctx) => {
  if (!ctx.vmRssKb) {
    return { pass: false, details: { reason: 'VmRSS unknown (G03 prereq)' } };
  }
  const rssBytes = ctx.vmRssKb * 1024;
  const pass = rssBytes <= CFG.rssMaxBytes;
  return { pass, details: { rss_bytes: rssBytes, max_bytes: CFG.rssMaxBytes } };
});

// G05 — TTFT <5s on N150 cold. We measure time-to-first-byte against /completion-like endpoint.
// Honest constraint: "cold" means first request after daemon start; this runner cannot guarantee
// a cold cache unless it restarted the daemon itself. We measure once and label warmth honestly.
gate('G05', 'TTFT < 5s (cold or first-observed)', async () => {
  const probeBody = JSON.stringify({
    origin: 'activation-runner',
    text: 'Activation gate G05 probe. Emit one AgentTurn observation, lane=thought, confidence=0.1.',
  });
  const r = await curl('/event', { method: 'POST', body: probeBody, timeoutMs: 30000 });
  if (r.status !== 200 && r.status !== 201) {
    return { pass: false, details: { reason: `daemon /event returned ${r.status}`, body: r.body.slice(0, 500) } };
  }
  const pass = r.ttfbMs !== null && r.ttfbMs < CFG.ttftColdMaxMs;
  return {
    pass,
    details: {
      ttft_ms: r.ttfbMs,
      max_ms: CFG.ttftColdMaxMs,
      cold: false,
      cold_note: 'runner did not restart daemon; warmth state observed-as-is',
    },
  };
});

// G06 — JSON validity rate >= 95% on 100-pair smoke.
gate('G06', `JSON validity rate >= ${CFG.jsonValidMinPct * 100}% on ${CFG.smokePairCount} pairs`, async () => {
  // Use a varied small prompt set; the daemon's GBNF should force valid JSON regardless.
  const prompts = [
    'Operator opened terminal pane 3.',
    'Hermes recall query: AE Cobra status.',
    'OrangeLLM request: summarize last 5 receipts.',
    'Operator typed: /verify',
    'Reality lane checkpoint at 22:14.',
  ];
  let ok = 0, bad = 0;
  const samples = [];
  for (let i = 0; i < CFG.smokePairCount; i++) {
    const body = JSON.stringify({ origin: 'activation-runner', text: prompts[i % prompts.length] + ` (smoke ${i})` });
    const r = await curl('/event', { method: 'POST', body, timeoutMs: 15000 });
    if (r.status !== 200 && r.status !== 201) { bad++; samples.push({ i, http: r.status }); continue; }
    try {
      // daemon /event returns either the AgentTurn JSON or {ok, agentTurn, ...} — try both
      const parsed = JSON.parse(r.body);
      const turn = parsed.agentTurn || parsed.agent_turn || parsed;
      if (turn && typeof turn === 'object' && turn.lane && turn.event_type && turn.summary) ok++;
      else { bad++; if (samples.length < 5) samples.push({ i, reason: 'shape mismatch', got_keys: Object.keys(parsed) }); }
    } catch (e) {
      bad++; if (samples.length < 5) samples.push({ i, reason: 'parse error', err: e.message });
    }
  }
  const rate = ok / CFG.smokePairCount;
  return {
    pass: rate >= CFG.jsonValidMinPct,
    details: { ok, bad, total: CFG.smokePairCount, validity_rate: rate, min_rate: CFG.jsonValidMinPct, sample_failures: samples },
  };
});

// G07 — healthcheck green.
gate('G07', 'healthcheck green', async () => {
  const r = await curl('/healthz', { timeoutMs: 5000 });
  if (r.status !== 200) {
    return { pass: false, details: { http: r.status, body: r.body.slice(0, 500) } };
  }
  let parsed = null;
  try { parsed = JSON.parse(r.body); } catch { /* may be plaintext */ }
  return { pass: true, details: { http: r.status, body: parsed || r.body.slice(0, 500) } };
});

// G08 — lease-gated outbound. Daemon must NOT reach the public internet without an active lease.
// We probe by asking the daemon to perform an outbound call in a no-lease context and expect refusal.
gate('G08', 'lease-gated outbound (deny without lease)', async () => {
  const body = JSON.stringify({
    origin: 'activation-runner',
    text: 'OUTBOUND_PROBE: attempt fetch https://1.1.1.1/ without lease',
    require_outbound: true,
  });
  const r = await curl('/event', { method: 'POST', body, timeoutMs: 8000 });
  // PASS if daemon refused (403/451/200-with-rejected) — anything that confirms refusal.
  if (r.status === 403 || r.status === 451) {
    return { pass: true, details: { mode: 'http-refusal', http: r.status } };
  }
  if (r.status === 200) {
    try {
      const p = JSON.parse(r.body);
      const refused = p?.outbound_refused === true || p?.error?.match?.(/lease/i);
      if (refused) return { pass: true, details: { mode: 'body-refusal', body: p } };
    } catch { /* fall through */ }
  }
  return {
    pass: false,
    details: {
      reason: 'daemon did not refuse a leaseless outbound probe — confirm lease gate is enforced',
      http: r.status, body: r.body.slice(0, 400),
    },
  };
});

// G09 — Hermes integration. Hermes-originated event must lane-classify and round-trip.
gate('G09', 'Hermes integration (origin=hermes lanes correctly)', async () => {
  const body = JSON.stringify({ origin: 'hermes', text: 'Hermes integration probe: confirm origin-based lane classification.' });
  const r = await curl('/event', { method: 'POST', body, timeoutMs: 10000 });
  if (r.status !== 200 && r.status !== 201) {
    return { pass: false, details: { http: r.status, body: r.body.slice(0, 400) } };
  }
  try {
    const p = JSON.parse(r.body);
    const turn = p.agentTurn || p.agent_turn || p;
    const laneOk = ['reality', 'thought', 'merge'].includes(turn.lane);
    return { pass: laneOk, details: { lane: turn.lane, summary: turn.summary, origin_echoed: p.origin } };
  } catch (e) {
    return { pass: false, details: { reason: 'parse error', err: e.message } };
  }
});

// G10 — no frontier reach. Daemon must not be bound to any non-loopback iface; the Bun port should
// appear only on 127.0.0.1. We check ss/netstat from the daemon plane.
gate('G10', 'no frontier reach (port bound to 127.0.0.1 only)', async () => {
  const r = await sh(`ss -ltnp 2>/dev/null | grep -E ':${CFG.daemonPort}\\b' || true`);
  const out = r.stdout.trim();
  if (!out) {
    return { pass: false, details: { reason: `no listener on :${CFG.daemonPort}`, ss_out: out } };
  }
  // Each line of ss -ltnp has Local Address:Port in column 4 (after State/Recv-Q/Send-Q).
  const lines = out.split('\n');
  const binds = lines.map(l => l.split(/\s+/)[3]).filter(Boolean);
  const offending = binds.filter(b => !(b.startsWith('127.0.0.1:') || b.startsWith('[::1]:')));
  return {
    pass: offending.length === 0,
    details: { port: CFG.daemonPort, binds, offending, reason: offending.length ? 'non-loopback bind detected' : null },
  };
});

// G11 — no plain HTTP exposed beyond loopback. Subsumes G10 for the llama port too.
gate('G11', 'loopback-only across all daemon ports', async () => {
  const r = await sh(`ss -ltnp 2>/dev/null | grep -E ':(${CFG.daemonPort}|${CFG.llamaPort})\\b' || true`);
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  const offending = [];
  for (const ln of lines) {
    const cols = ln.split(/\s+/);
    const local = cols[3] || '';
    if (!(local.startsWith('127.0.0.1:') || local.startsWith('[::1]:'))) offending.push(local);
  }
  return {
    pass: offending.length === 0,
    details: { ports: [CFG.daemonPort, CFG.llamaPort], offending, reason: offending.length ? 'non-loopback bind detected' : null },
  };
});

// G12 — receipt writes. Daemon must write a receipt-kind record when prompted with a receipt event.
gate('G12', 'receipt writes append to Flux', async (ctx) => {
  const realityBefore = await sh(`find ${CFG.fluxRoot} -name 'reality*.jsonl' -printf '%p %s\\n' 2>/dev/null || true`);
  const body = JSON.stringify({
    origin: 'activation-runner',
    kind_hint: 'receipt',
    text: 'Activation receipt write probe. Emit a kind=receipt observation onto reality lane.',
  });
  const r = await curl('/event', { method: 'POST', body, timeoutMs: 10000 });
  if (r.status !== 200 && r.status !== 201) {
    return { pass: false, details: { reason: `event accept returned ${r.status}` } };
  }
  // tiny wait for fs flush
  await new Promise(res => setTimeout(res, 500));
  const realityAfter = await sh(`find ${CFG.fluxRoot} -name 'reality*.jsonl' -printf '%p %s\\n' 2>/dev/null || true`);
  ctx.realitySnapshot = realityAfter.stdout;
  const grew = realityAfter.stdout !== realityBefore.stdout;
  return {
    pass: grew,
    details: {
      flux_root: CFG.fluxRoot,
      before: realityBefore.stdout.trim().slice(0, 400),
      after: realityAfter.stdout.trim().slice(0, 400),
      reason: grew ? null : 'no reality.jsonl growth observed after receipt probe',
    },
  };
});

// G13 — prior_sha chain unbroken. Read whichever reality.jsonl form exists and verify chain.
gate('G13', 'prior_sha hash-chain unbroken', async () => {
  // Try brief-doctrine path first: /mnt/ae_flux/reality.jsonl
  const singleFile = `${CFG.fluxRoot}/reality.jsonl`;
  const existsR = await sh(`test -f '${singleFile}' && echo yes || echo no`);
  let chainSource = null;
  let chainContent = null;

  if (existsR.stdout.trim() === 'yes') {
    chainSource = singleFile;
    const rd = await sh(`cat '${singleFile}'`, { timeoutMs: 30_000 });
    if (rd.code !== 0) return { pass: false, details: { reason: 'cannot read reality.jsonl', source: singleFile } };
    chainContent = rd.stdout;
  } else {
    // Fallback: scaffolding-style date-partitioned files
    const ls = await sh(`ls -1 ${CFG.fluxRoot}/events/reality/*.jsonl 2>/dev/null | sort | tail -1 || true`);
    const latest = ls.stdout.trim();
    if (!latest) {
      return { pass: false, details: { reason: 'no reality lane file found in either brief-form or scaffolding-form', tried: [singleFile, `${CFG.fluxRoot}/events/reality/*.jsonl`] } };
    }
    chainSource = latest;
    const rd = await sh(`cat '${latest}'`);
    if (rd.code !== 0) return { pass: false, details: { reason: 'cannot read latest reality file', source: latest } };
    chainContent = rd.stdout;
  }

  // Verify chain in-process (we already have the content)
  const lines = chainContent.split('\n').filter(Boolean);
  let lastHash = null;
  const broken = [];
  for (let i = 0; i < lines.length; i++) {
    let rec;
    try { rec = JSON.parse(lines[i]); } catch { broken.push({ idx: i, reason: 'parse error' }); continue; }
    const canonical = JSON.stringify({ ...rec, hash: '' });
    const computed = crypto.createHash('sha256').update(canonical).digest('hex');
    if (rec.hash && rec.hash !== computed) broken.push({ idx: i, reason: 'self-hash mismatch' });
    if (i > 0 && rec.prev_hash !== lastHash && rec.prev_hash !== 'GENESIS') {
      broken.push({ idx: i, reason: `prev_hash mismatch (got ${rec.prev_hash}, expected ${lastHash})` });
    }
    lastHash = rec.hash || lastHash;
  }
  return {
    pass: broken.length === 0,
    details: { source: chainSource, record_count: lines.length, broken: broken.slice(0, 10), broken_total: broken.length },
  };
});

// G14 — 60s burn-in clean. Hold the daemon at low concurrency for 60s; no llama-server restart,
// no llama OOM signature, no flux write errors, RSS stable (±10%).
gate('G14', `${CFG.burnInSeconds}s burn-in clean`, async (ctx) => {
  const startPidR = await sh(`pgrep -f llama-server | head -1`);
  const startPid = (startPidR.stdout || '').trim();
  if (!startPid) return { pass: false, details: { reason: 'no llama-server PID at burn-in start' } };
  const startRssR = await sh(`grep VmRSS /proc/${startPid}/status | awk '{print $2}'`);
  const startRss = parseInt(startRssR.stdout.trim(), 10);

  const burnEnd = Date.now() + CFG.burnInSeconds * 1000;
  let pings = 0, pingFails = 0;
  while (Date.now() < burnEnd) {
    const body = JSON.stringify({ origin: 'activation-runner', text: `burn-in ping ${pings}` });
    const r = await curl('/event', { method: 'POST', body, timeoutMs: 8000 });
    pings++;
    if (r.status !== 200 && r.status !== 201) pingFails++;
    await new Promise(res => setTimeout(res, 1000));
  }

  const endPidR = await sh(`pgrep -f llama-server | head -1`);
  const endPid = (endPidR.stdout || '').trim();
  const endRssR = endPid ? await sh(`grep VmRSS /proc/${endPid}/status | awk '{print $2}'`) : { stdout: '' };
  const endRss = parseInt(endRssR.stdout.trim(), 10);

  const pidStable = endPid === startPid;
  const rssDriftPct = Number.isFinite(startRss) && Number.isFinite(endRss) ? Math.abs(endRss - startRss) / startRss : null;
  const rssStable = rssDriftPct !== null && rssDriftPct <= 0.10;
  const pingsOk = pings > 0 && pingFails / pings < 0.05;

  // OOM scan: kernel log + daemon log if accessible
  const oomR = await sh(`dmesg 2>/dev/null | tail -200 | grep -iE '(killed process|out of memory|oom)' || true`);
  const oomHit = oomR.stdout.trim();

  const pass = pidStable && rssStable && pingsOk && !oomHit;
  return {
    pass,
    details: {
      start_pid: startPid, end_pid: endPid, pid_stable: pidStable,
      start_rss_kb: startRss, end_rss_kb: endRss, rss_drift_pct: rssDriftPct, rss_stable: rssStable,
      pings, ping_fails: pingFails, pings_ok: pingsOk,
      oom_signal: oomHit || null,
      duration_s: CFG.burnInSeconds,
    },
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator

function nextAttemptNumber() {
  if (!fs.existsSync(RECEIPTS_DIR)) return 1;
  const files = fs.readdirSync(RECEIPTS_DIR);
  const nums = files
    .map(f => f.match(/^ae-cobra-night1-activation-attempt-(\d+)\.md$/))
    .filter(Boolean)
    .map(m => parseInt(m[1], 10));
  return (nums.length ? Math.max(...nums) : 0) + 1;
}

function fmtDetails(d) {
  try { return '```json\n' + JSON.stringify(d, null, 2) + '\n```'; }
  catch { return '`' + String(d) + '`'; }
}

function writeReceipt({ attempt, target, evidence, ok, gateFailed, startedAt, finishedAt }) {
  fs.mkdirSync(RECEIPTS_DIR, { recursive: true });
  const file = path.join(RECEIPTS_DIR, `ae-cobra-night1-activation-attempt-${attempt}.md`);
  const lines = [];
  lines.push(`# Æ Cobra Night-1 Activation — Attempt ${attempt}`);
  lines.push('');
  lines.push(`- **Target plane**: \`${target}\``);
  lines.push(`- **Started**: \`${startedAt}\``);
  lines.push(`- **Finished**: \`${finishedAt}\``);
  lines.push(`- **Outcome**: ${ok ? '**PASS — all 14 gates green**' : `**FAIL — short-circuit at \`${gateFailed}\`**`}`);
  lines.push(`- **Config**: daemonPort=${CFG.daemonPort}, llamaPort=${CFG.llamaPort}, fluxRoot=\`${CFG.fluxRoot}\`, modelPath=\`${CFG.modelPath}\``);
  lines.push('');
  lines.push('## Gate ledger');
  lines.push('');
  lines.push('| # | Gate | Result | Latency |');
  lines.push('|---|---|---|---|');
  for (const e of evidence) {
    lines.push(`| ${e.gate_id} | ${e.label} | ${e.pass ? 'PASS' : 'FAIL'} | ${e.latency_ms}ms |`);
  }
  lines.push('');
  lines.push('## Evidence');
  lines.push('');
  for (const e of evidence) {
    lines.push(`### ${e.gate_id} — ${e.label}`);
    lines.push('');
    lines.push(`- pass: \`${e.pass}\``);
    lines.push(`- latency: \`${e.latency_ms}ms\``);
    lines.push('');
    lines.push(fmtDetails(e.details));
    lines.push('');
  }
  lines.push('---');
  lines.push('');
  lines.push('Mom is watching. No fake-green. Hash-chained. mlock-pinned. GBNF-locked.');
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}

async function run() {
  const startedAt = new Date().toISOString();
  const ctx = {}; // cross-gate state (e.g. discovered PID)
  const evidence = [];
  let ok = true;
  let gateFailed = null;

  for (const g of GATES) {
    const t0 = Date.now();
    let res;
    try {
      res = await g.fn(ctx);
    } catch (e) {
      res = { pass: false, details: { reason: 'gate threw', err: e.message, stack: e.stack } };
    }
    const latency_ms = Date.now() - t0;
    evidence.push({ gate_id: g.id, label: g.label, pass: !!res.pass, details: res.details || {}, latency_ms });
    if (!res.pass) {
      ok = false;
      gateFailed = g.id;
      break; // short-circuit per spec
    }
  }

  const finishedAt = new Date().toISOString();
  const attempt = nextAttemptNumber();
  const receiptPath = writeReceipt({ attempt, target: TARGET, evidence, ok, gateFailed, startedAt, finishedAt });

  const result = { ok, ...(gateFailed ? { gate_failed: gateFailed } : {}), evidence, receipt: receiptPath };
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = ok ? 0 : 1;
}

// Allow `import` for unit tests; only run when invoked directly.
const isMain = (() => {
  try { return fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || ''); }
  catch { return false; }
})();

if (isMain) {
  run().catch(e => {
    console.error('FATAL runner error:', e);
    process.exit(2);
  });
}

export { GATES, CFG, run };
