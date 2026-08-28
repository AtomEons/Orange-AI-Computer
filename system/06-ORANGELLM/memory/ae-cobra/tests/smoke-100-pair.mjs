#!/usr/bin/env node
// smoke-100-pair.mjs — Æ Cobra live AgentTurn contract smoke.
//
// Fires 100 representative prompts at the daemon's /event endpoint and measures
// JSON validity rate against the AgentTurn GBNF + JSON Schema. Pass threshold:
// >= 95 / 100 valid. Writes report JSON to activation/last-smoke.json.
//
// Runtime context (read README.md and grammar/agent_turn.gbnf for full law):
//   * Current daemon: Bun Flow Direct at 127.0.0.1:7419. Reality events are
//     compiled deterministically; thought events are processed by OrangeBrain.
//   * The retired Codexa Mamba/llama.cpp bridge may still be exercised explicitly
//     with AE_COBRA_BASE, but it is not the OrangeFive default runtime.
//   * POST /event accepts {origin,event}; this smoke exercises that actual contract.
//   * This is gate G06 of the operator's 14-point activation checklist
//     (JSON validity rate >= 95% on 100-pair smoke). activation/runner.mjs runs
//     a similar probe inline; this file is the standalone, runner-independent
//     version that can be re-fired by hand or by CI without invoking the full gate
//     chain. The two MUST agree — if this smoke diverges from runner G06, the
//     runner is the source of truth.
//
// Invocation:
//   node tests/smoke-100-pair.mjs
//   AE_COBRA_BASE=http://127.0.0.1:9100 node tests/smoke-100-pair.mjs  # legacy bridge
//   bun tests/smoke-100-pair.mjs   # also works
//
// Exit codes:
//   0 — pass (>= 95/100 valid)
//   1 — fail (< 95/100 valid, or daemon unreachable, or report write failed)
//   2 — caller error (bad args / schema load failure)
//
// Honest-green discipline:
//   * If the daemon is unreachable, this exits 1 with a report row labeled
//     "daemon_unreachable: true". It does NOT skip-to-green.
//   * Every per-prompt failure is captured in the report with reason + sample.
//   * The schema validator is hand-rolled against the explicit AgentTurn shape
//     (zero npm deps so this can run on a fresh WSL2 with only node available).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─────────────────────────────────────────────────────────────────────────────
// Paths

const __filename = fileURLToPath(import.meta.url);
const TESTS_DIR  = path.dirname(__filename);
const AE_COBRA_DIR = path.resolve(TESTS_DIR, '..');
const ACTIVATION_DIR = path.join(AE_COBRA_DIR, 'activation');
const REPORT_PATH = path.join(ACTIVATION_DIR, 'last-smoke.json');
const SCHEMA_PATH = path.join(AE_COBRA_DIR, 'schemas', 'agent-turn.schema.json');

// ─────────────────────────────────────────────────────────────────────────────
// Config

const CFG = {
  base: process.env.AE_COBRA_BASE || 'http://127.0.0.1:7419',
  pairCount: parseInt(process.env.AE_COBRA_SMOKE_N || '100', 10),
  passThreshold: parseFloat(process.env.AE_COBRA_SMOKE_THRESHOLD || '0.95'),
  perRequestTimeoutMs: parseInt(process.env.AE_COBRA_SMOKE_TIMEOUT_MS || '30000', 10),
  endpoint: process.env.AE_COBRA_SMOKE_ENDPOINT || '/event',
};

// ─────────────────────────────────────────────────────────────────────────────
// 100 representative prompts.
//
// Coverage rationale (mapped to Reality vs Thought vs Merge lanes the daemon
// classifies BY ORIGIN, not by content — but the daemon's GBNF still has to
// emit valid AgentTurn JSON across the full content surface):
//   * Terminal / shell output (Reality lane in production)
//   * Hermes recall + tool calls (Reality)
//   * OrangeLLM reasoning / hypothesis / plan (Thought)
//   * Operator commands / decisions (Reality)
//   * Receipts + checkpoints (Reality, kind=receipt/checkpoint)
//   * Errors + risks (either lane)
//   * Edge cases that historically break GBNF: long input, embedded JSON, code
//     fences, unicode, control chars, ambiguous lane signals.
//
// 25 of each across 4 origins gets us to 100, with deliberate edge cases woven in.

const PROMPTS = [
  // — Terminal / Reality (25) —
  { origin: 'terminal', text: 'npm test exited 0; 47 tests passed, 0 failed, 1.2s' },
  { origin: 'terminal', text: 'git commit -m "wave 32: ae-cobra smoke + gate G06 standalone"' },
  { origin: 'terminal', text: 'docker compose up -d returned: orange5-rail-1 Started' },
  { origin: 'terminal', text: 'curl -s http://127.0.0.1:9100/healthz → {"status":"ok"}' },
  { origin: 'terminal', text: 'pytest -k cobra: 12 passed, 0 failed, 0 skipped in 3.4s' },
  { origin: 'terminal', text: 'rsync -a /mnt/c/AtomEons/Orange5/.../ae-cobra/ /opt/atomeons/ae-cobra/' },
  { origin: 'terminal', text: 'systemctl status ae-cobra → active (running) since 22:14:03' },
  { origin: 'terminal', text: 'ls /mnt/ae_flux/events/reality/ → 2026-06-24.jsonl (4.2 MB)' },
  { origin: 'terminal', text: 'free -h → Mem: 31Gi used 8.4Gi, available 22Gi' },
  { origin: 'terminal', text: 'kill -TERM 31415 succeeded; llama-server PID 31415 exited cleanly' },
  { origin: 'terminal', text: 'cat /proc/31415/status | grep VmLck → VmLck: 3145728 kB' },
  { origin: 'terminal', text: 'tail -1 /mnt/ae_flux/reality.jsonl | jq .hash → "9f3a..."' },
  { origin: 'terminal', text: 'sha256sum ae-blackmamba-2.8b-Q5_K_M.gguf → 7c4e9...  matches expected' },
  { origin: 'terminal', text: 'ss -ltnp | grep 9100 → 127.0.0.1:9100  users:(("bun",pid=4221))' },
  { origin: 'terminal', text: 'iperf3 N150→Codexa: 9.41 Gbits/sec, 0 retries' },
  { origin: 'terminal', text: 'mount | grep ae_flux → /dev/nvme1n1p1 on /mnt/ae_flux type ext4 (rw,noatime)' },
  { origin: 'terminal', text: 'journalctl -u ae-cobra --since "1 hour ago" → no errors' },
  { origin: 'terminal', text: 'bun run build → bundled 1.4 MB in 218ms' },
  { origin: 'terminal', text: 'gh pr view 22 → MERGED by atomeons-bot 12 minutes ago' },
  { origin: 'terminal', text: 'wc -l /mnt/ae_flux/events/thought/2026-06-24.jsonl → 1847' },
  { origin: 'terminal', text: 'df -h /mnt/ae_flux → 1.8T used 142G, 1.6T avail (8%)' },
  { origin: 'terminal', text: 'nvidia-smi → no NVIDIA driver (CPU-only inference, as designed)' },
  { origin: 'terminal', text: 'ping -c 3 codexa.local → 0% loss, avg 0.412 ms' },
  { origin: 'terminal', text: 'bun --version → 1.1.34' },
  { origin: 'terminal', text: 'history | tail -1 → bun smoke-100-pair.mjs' },

  // — Hermes / Reality (25) —
  { origin: 'hermes', text: 'Recall query: last 5 events on reality lane in window=3600s' },
  { origin: 'hermes', text: 'Tool call: read_file path=/mnt/ae_flux/events/reality/2026-06-24.jsonl bytes=4200' },
  { origin: 'hermes', text: 'Hermes received intent: classify current llama-server runtime state' },
  { origin: 'hermes', text: 'Recall: prior_sha at index 1847 = 9f3a8b7c... matches chain head' },
  { origin: 'hermes', text: 'Tool call: verify_chain lane=reality → ok=true, count=1847' },
  { origin: 'hermes', text: 'Hermes lease check: outbound NOT permitted (no active lease)' },
  { origin: 'hermes', text: 'Recall query empty result: no events match origin=operator in 30s window' },
  { origin: 'hermes', text: 'Hermes routing: AE Cobra StateBrief requested by OrangeLLM' },
  { origin: 'hermes', text: 'Tool call: list_lanes → ["reality","thought","merge"]' },
  { origin: 'hermes', text: 'Hermes ack: receipt id=2026-06-24T22:14:03Z-r0042 written to reality lane' },
  { origin: 'hermes', text: 'Recall: thought lane has 312 rejected entries in last 1h (CLR score < 0.5)' },
  { origin: 'hermes', text: 'Tool call: get_health → {mamba: {live: true}, lanes: {reality: 1847, thought: 312}}' },
  { origin: 'hermes', text: 'Hermes received tool error: timeout reading /mnt/ae_flux/events/merge/' },
  { origin: 'hermes', text: 'Recall query: who modified runtime/node.py last? → atomeons-lead, 2026-06-23' },
  { origin: 'hermes', text: 'Hermes redact: secret token detected in event payload — masking before write' },
  { origin: 'hermes', text: 'Tool call: drift_check → 27 guardrails intact, Gate 0 LBCE present' },
  { origin: 'hermes', text: 'Hermes ack: smoke-100-pair invocation registered for trace' },
  { origin: 'hermes', text: 'Recall: founder salary cents invariant present in payout module' },
  { origin: 'hermes', text: 'Tool call: emit_receipt kind=checkpoint summary="cobra night-1 G06 fired"' },
  { origin: 'hermes', text: 'Hermes routing: operator-decision event takes precedence over thought-lane' },
  { origin: 'hermes', text: 'Recall: last gate failure = G05 ttft=5421ms on attempt #3 (warm)' },
  { origin: 'hermes', text: 'Tool call: open_lease scope=outbound:1.1.1.1 ttl=5s → DENIED (no operator approval)' },
  { origin: 'hermes', text: 'Hermes ack: GBNF grammar load confirmed by llama-server start log' },
  { origin: 'hermes', text: 'Recall: VmSwap = 0 kB on llama-server PID 31415 (mlock holding)' },
  { origin: 'hermes', text: 'Tool call: snapshot_state → {flux_bytes: 4423104, chain_head: "9f3a..."}' },

  // — OrangeLLM reasoning / Thought (25) —
  { origin: 'orangellm_reasoning', text: 'Hypothesis: swapping Smart Skinny to qwen3:1.7b would cut TTFT by ~40%' },
  { origin: 'orangellm_reasoning', text: 'Plan: run G06 smoke first, then G14 burn-in, then propose promotion' },
  { origin: 'orangellm_reasoning', text: 'Considering: should the daemon expose a /chain/verify endpoint or compute in-process?' },
  { origin: 'orangellm_reasoning', text: 'Weighing two paths: GBNF grammar tightening vs. JSON Schema post-parse rejection' },
  { origin: 'orangellm_reasoning', text: 'Risk: if ctx-size grows to 2048 the mlock budget overruns the 10GB ceiling' },
  { origin: 'orangellm_reasoning', text: 'Thought: the brief says :9100 but scaffolding uses :7419 — runner takes :9100, smoke aligns' },
  { origin: 'orangellm_reasoning', text: 'Plan revision: G06 should validate JSON at the parser layer, not trust GBNF blindly' },
  { origin: 'orangellm_reasoning', text: 'Considering whether origin=operator should auto-flip to lane=reality on receipt events' },
  { origin: 'orangellm_reasoning', text: 'Hypothesis: prior_sha chain breakage is most likely from concurrent writes, not malice' },
  { origin: 'orangellm_reasoning', text: 'Weighing CLR threshold: K=1 at 0.5 may be too lenient under high-utility-low-evidence cases' },
  { origin: 'orangellm_reasoning', text: 'Thought: the smoke prompt set should include unicode and code fences to stress-test GBNF' },
  { origin: 'orangellm_reasoning', text: 'Plan: route N150 → Codexa via rail token; never expose 9100 to LAN' },
  { origin: 'orangellm_reasoning', text: 'Risk: GBNF guarantees structure but NOT semantic truth — HRE still needed downstream' },
  { origin: 'orangellm_reasoning', text: 'Considering merge-lane logic: when should two events synthesize into one?' },
  { origin: 'orangellm_reasoning', text: 'Hypothesis: the 95% threshold is achievable; 99% may require Q6_K quant upgrade' },
  { origin: 'orangellm_reasoning', text: 'Plan: write the report to activation/last-smoke.json so the runner can ingest on next gate run' },
  { origin: 'orangellm_reasoning', text: 'Thought: fake-green words detected in this very sentence? should_work, looks_ok — meta-test' },
  { origin: 'orangellm_reasoning', text: 'Weighing: should the smoke fire serially or in parallel? Serial keeps GBNF state honest' },
  { origin: 'orangellm_reasoning', text: 'Risk: parallel firing could hit llama-server connection cap; serial preferred for N=100' },
  { origin: 'orangellm_reasoning', text: 'Considering whether to bundle the smoke into systemd timer or keep manual-fire' },
  { origin: 'orangellm_reasoning', text: 'Hypothesis: most JSON failures will be on long inputs hitting max_length on summary field' },
  { origin: 'orangellm_reasoning', text: 'Plan: clip prompts to 240 chars or accept that the model may truncate summary' },
  { origin: 'orangellm_reasoning', text: 'Thought: GBNF should also enforce ASCII-safe entities to avoid downstream parse drift' },
  { origin: 'orangellm_reasoning', text: 'Weighing: report schema — should we include per-prompt latency or just aggregate?' },
  { origin: 'orangellm_reasoning', text: 'Plan: include first 5 failures verbatim, aggregate the rest by reason class' },

  // — Operator / Reality (25) with edge cases woven in —
  { origin: 'operator', text: '/verify' },
  { origin: 'operator', text: 'ship it' },
  { origin: 'operator', text: 'cobra promote' },
  { origin: 'operator', text: 'Decision: hold promotion until G14 burn-in completes clean.' },
  { origin: 'operator', text: 'Receipt: wave 32 smoke 100/100 — green or it does not ship.' },
  { origin: 'operator', text: 'Checkpoint: night-1 spine staged; activation runner ready.' },
  { origin: 'operator', text: 'Risk acknowledged: GBNF lock is structural, not semantic. HRE still required.' },
  { origin: 'operator', text: 'Override: gate G05 may report warm; mark cold_observed=false honestly.' },
  // Edge: long input near 1024-token ctx boundary
  { origin: 'operator', text: 'Operator brief: ' + 'the night-1 spine includes Mamba 2.8B Q5_K_M GGUF, GBNF-locked output, hash-chained Flux on dedicated NVMe, origin-classified lanes, mlock-pinned weights, no frontier reach, lease-gated outbound, receipt writes, 60s burn-in, 14-gate activation, 100-pair smoke at 95+/100. '.repeat(3) },
  // Edge: embedded JSON in prompt
  { origin: 'operator', text: 'Input includes JSON: {"lane":"reality","confidence":0.9,"summary":"meta-prompt"} — daemon must still emit valid AgentTurn.' },
  // Edge: code fence
  { origin: 'operator', text: 'Code block in operator text:\n```bash\ncurl -s http://127.0.0.1:9100/healthz\n```\nThis must not break GBNF.' },
  // Edge: unicode
  { origin: 'operator', text: 'Unicode stress: ÆoNs, café, naïve, 日本語, 🚀, π ≈ 3.14159 — emit valid JSON regardless.' },
  // Edge: control chars (literal, not escaped — daemon must sanitize)
  { origin: 'operator', text: 'Tab\there and newline\nshould be handled by GBNF short_string char class.' },
  // Edge: ambiguous lane signal
  { origin: 'operator', text: 'I am thinking maybe we should hypothesize considering a plan — but this IS an operator decision.' },
  // Edge: empty-ish
  { origin: 'operator', text: '.' },
  // Edge: numeric-heavy
  { origin: 'operator', text: '47 tests, 0 failed, 1.2s, RSS=3145728kB, VmLck=3145728kB, VmSwap=0, ctx=1024, port=9100' },
  // Edge: fake-green words (should still emit valid JSON — CLR may reject downstream, but GBNF must hold)
  { origin: 'operator', text: 'This should_work and looks_ok and is probably_fine, green_assumed.' },
  // Edge: quotes inside
  { origin: 'operator', text: 'Operator said "ship it" but reviewer said "not yet" — both quoted in event text.' },
  // Edge: backslashes
  { origin: 'operator', text: 'Windows path C:\\AtomEons\\Orange5\\06-ORANGELLM\\memory\\ae-cobra\\ vs WSL2 /mnt/c/AtomEons/...' },
  { origin: 'operator', text: 'Decision: route all non-trivial orchestration through Orange3 per standing law 2026-06-18.' },
  { origin: 'operator', text: 'Receipt: Spiral Reasoning paper integrated into doctrine at SPIRAL_REASONING_INTEGRATION_v1.md.' },
  { origin: 'operator', text: 'Risk: cymbal crash demo must run on Codexa, not N150 — N150 has no GPU.' },
  { origin: 'operator', text: 'Checkpoint: 06-24 wave 32 — smoke standalone in tests/ — gate G06 callable independent of runner.' },
  { origin: 'operator', text: 'Override: AE_COBRA_BASE may be set to gateway URL for N150-side smoke. Honest mode disclosure required.' },
  { origin: 'operator', text: 'Final: Mom is watching. 95 of 100 or it does not ship. No fake-green.' },
];

if (PROMPTS.length !== 100) {
  console.error(`FATAL caller error: PROMPTS array has ${PROMPTS.length} entries, expected 100.`);
  process.exit(2);
}

// ─────────────────────────────────────────────────────────────────────────────
// Load schema (best-effort; we hand-validate below so this is belt + suspenders)

let SCHEMA = null;
try {
  SCHEMA = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
} catch (e) {
  console.error(`WARN: could not load AgentTurn schema at ${SCHEMA_PATH}: ${e.message}`);
  console.error('Proceeding with hand-rolled validator (matches schema by inspection).');
}

// ─────────────────────────────────────────────────────────────────────────────
// AgentTurn validator — mirrors schemas/agent-turn.schema.json and the GBNF.
// Returns { ok: bool, reason?: string }.

const LANES = new Set(['reality', 'thought', 'merge']);
const EVENT_TYPES = new Set(['observation', 'decision', 'error', 'checkpoint', 'recall', 'receipt', 'risk']);
const RISKS = new Set(['low', 'medium', 'high']);

function isStringArray(v, maxItems, maxLenPer) {
  if (!Array.isArray(v)) return false;
  if (v.length > maxItems) return false;
  for (const s of v) {
    if (typeof s !== 'string') return false;
    if (s.length > maxLenPer) return false;
  }
  return true;
}

function validateAgentTurn(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return { ok: false, reason: 'not an object' };
  const required = ['lane', 'event_type', 'summary', 'entities', 'files', 'commands', 'risk', 'next_action', 'confidence'];
  for (const k of required) if (!(k in t)) return { ok: false, reason: `missing required: ${k}` };

  // Allow extra keys ONLY if the daemon wraps AgentTurn in an envelope; the caller is
  // expected to extract turn already. Strict-mode here per schema additionalProperties:false.
  const allowed = new Set(required);
  for (const k of Object.keys(t)) if (!allowed.has(k)) return { ok: false, reason: `unexpected key: ${k}` };

  if (!LANES.has(t.lane)) return { ok: false, reason: `bad lane: ${t.lane}` };
  if (!EVENT_TYPES.has(t.event_type)) return { ok: false, reason: `bad event_type: ${t.event_type}` };
  if (typeof t.summary !== 'string' || t.summary.length < 1 || t.summary.length > 240) {
    return { ok: false, reason: `summary length out of range (${t.summary?.length})` };
  }
  if (!isStringArray(t.entities, 20, 80)) return { ok: false, reason: 'entities shape invalid' };
  if (!isStringArray(t.files, 20, 240)) return { ok: false, reason: 'files shape invalid' };
  if (!isStringArray(t.commands, 20, 240)) return { ok: false, reason: 'commands shape invalid' };
  if (!RISKS.has(t.risk)) return { ok: false, reason: `bad risk: ${t.risk}` };
  if (typeof t.next_action !== 'string' || t.next_action.length < 1 || t.next_action.length > 240) {
    return { ok: false, reason: `next_action length out of range (${t.next_action?.length})` };
  }
  if (typeof t.confidence !== 'number' || t.confidence < 0 || t.confidence > 1) {
    return { ok: false, reason: `confidence out of range (${t.confidence})` };
  }
  return { ok: true };
}

// Extract AgentTurn from whatever envelope the daemon returns. The daemon may return
// the raw turn (GBNF-output direct) or an envelope { ok, agentTurn|agent_turn, ... }.
function extractTurn(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.agentTurn && typeof parsed.agentTurn === 'object') return parsed.agentTurn;
  if (parsed.agent_turn && typeof parsed.agent_turn === 'object') return parsed.agent_turn;
  // If it looks like the turn directly, return it.
  if ('lane' in parsed && 'event_type' in parsed && 'summary' in parsed) return parsed;
  return null;
}

function validatePolicyRejection(parsed) {
  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'rejection is not an object' };
  if (parsed.ok !== true || parsed.accepted !== false) return { ok: false, reason: 'not a policy rejection envelope' };
  if (!Array.isArray(parsed.reasons) || parsed.reasons.length === 0) return { ok: false, reason: 'rejection reasons missing' };
  if (!parsed.reasons.every((reason) => typeof reason === 'string' && reason.trim())) {
    return { ok: false, reason: 'rejection reasons malformed' };
  }
  if (typeof parsed.rejection_id !== 'string' || !parsed.rejection_id.trim()) {
    return { ok: false, reason: 'rejection id missing' };
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP — node 18+ has global fetch. AbortController for per-request timeout.

async function fireEvent(prompt, idx) {
  const url = `${CFG.base.replace(/\/+$/, '')}${CFG.endpoint}`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), CFG.perRequestTimeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        origin: prompt.origin,
        event: {
          event_type: prompt.origin === 'operator' ? 'decision' : 'observation',
          summary: prompt.text,
          entities: ['cobra-smoke', `case-${idx}`],
          files: [],
          commands: [],
          risk: 'low',
          next_action: 'Continue the governed smoke test.',
          confidence: 1,
          smoke_idx: idx,
        },
      }),
      signal: ac.signal,
    });
    const elapsedMs = Date.now() - t0;
    const text = await res.text();
    return { http: res.status, body: text, elapsedMs, transport_error: null };
  } catch (e) {
    return {
      http: null,
      body: '',
      elapsedMs: Date.now() - t0,
      transport_error: e.name === 'AbortError' ? `timeout after ${CFG.perRequestTimeoutMs}ms` : e.message,
    };
  } finally {
    clearTimeout(t);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main

async function main() {
  const startedAt = new Date().toISOString();
  console.error(`[smoke-100-pair] starting against ${CFG.base}${CFG.endpoint}`);
  console.error(`[smoke-100-pair] n=${CFG.pairCount}, threshold=${CFG.passThreshold}, timeout=${CFG.perRequestTimeoutMs}ms/req`);

  const results = [];
  let valid = 0;
  let agentTurnValid = 0;
  let policyRejections = 0;
  let invalid = 0;
  let unreachable = 0;
  const failureSamples = [];
  const reasonHistogram = Object.create(null);
  const latencies = [];

  for (let i = 0; i < CFG.pairCount; i++) {
    const prompt = PROMPTS[i];
    const r = await fireEvent(prompt, i);
    latencies.push(r.elapsedMs);

    let row = {
      idx: i,
      origin: prompt.origin,
      http: r.http,
      latency_ms: r.elapsedMs,
      transport_error: r.transport_error,
      valid: false,
      outcome: null,
      reason: null,
    };

    if (r.transport_error) {
      unreachable++;
      invalid++;
      row.reason = `transport: ${r.transport_error}`;
    } else if (r.http !== 200 && r.http !== 201) {
      invalid++;
      row.reason = `http ${r.http}`;
    } else {
      let parsed = null;
      try { parsed = JSON.parse(r.body); }
      catch (e) {
        invalid++;
        row.reason = `parse error: ${e.message}`;
      }
      if (parsed) {
        const turn = extractTurn(parsed);
        if (!turn) {
          const rejection = validatePolicyRejection(parsed);
          if (rejection.ok) {
            valid++;
            policyRejections++;
            row.valid = true;
            row.outcome = 'policy_rejection';
          } else {
            invalid++;
            row.reason = `no valid AgentTurn or policy rejection (keys: ${Object.keys(parsed).join(',')}; ${rejection.reason})`;
          }
        } else {
          const v = validateAgentTurn(turn);
          if (v.ok) {
            valid++;
            agentTurnValid++;
            row.valid = true;
            row.outcome = 'agent_turn';
          } else {
            invalid++;
            row.reason = `schema: ${v.reason}`;
          }
        }
      }
    }

    if (!row.valid) {
      const cls = (row.reason || 'unknown').split(':')[0].trim();
      reasonHistogram[cls] = (reasonHistogram[cls] || 0) + 1;
      if (failureSamples.length < 5) {
        failureSamples.push({
          idx: i,
          origin: prompt.origin,
          prompt_excerpt: prompt.text.slice(0, 160),
          reason: row.reason,
          http: r.http,
          body_excerpt: (r.body || '').slice(0, 400),
        });
      }
    }
    results.push(row);

    if ((i + 1) % 10 === 0) {
      process.stderr.write(`[smoke-100-pair] ${i + 1}/${CFG.pairCount}  valid=${valid}  invalid=${invalid}\n`);
    }
  }

  const finishedAt = new Date().toISOString();
  const total = results.length;
  const validityRate = total ? valid / total : 0;
  const pass = validityRate >= CFG.passThreshold && unreachable < total; // any pass requires reachable daemon

  // Latency stats
  const sorted = [...latencies].sort((a, b) => a - b);
  const pct = (q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null;
  const latencyStats = {
    mean_ms: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
    p50_ms: pct(0.50),
    p95_ms: pct(0.95),
    p99_ms: pct(0.99),
    max_ms: sorted.length ? sorted[sorted.length - 1] : null,
  };

  const report = {
    suite: 'ae-cobra-smoke-100-pair',
    gate_id: 'G06',
    started_at: startedAt,
    finished_at: finishedAt,
    config: {
      base: CFG.base,
      endpoint: CFG.endpoint,
      n: CFG.pairCount,
      threshold: CFG.passThreshold,
      per_request_timeout_ms: CFG.perRequestTimeoutMs,
    },
    schema: {
      path: SCHEMA_PATH,
      loaded: !!SCHEMA,
      id: SCHEMA?.$id || null,
    },
    totals: {
      valid,
      agent_turn_valid: agentTurnValid,
      policy_rejections: policyRejections,
      invalid,
      unreachable,
      validity_rate: validityRate,
      pass,
    },
    latency: latencyStats,
    failure_reason_histogram: reasonHistogram,
    failure_samples: failureSamples,
    per_prompt: results,
    honest_notes: [
      unreachable === total
        ? 'Daemon unreachable for every request — this report is a TRANSPORT failure, not a model failure. Honest fail.'
        : null,
      unreachable > 0 && unreachable < total
        ? `${unreachable} of ${total} requests failed at transport layer — partial daemon outage during smoke.`
        : null,
      CFG.base.includes('127.0.0.1') && process.platform === 'win32'
        ? 'Running against 127.0.0.1 from win32 — if the daemon lives on Codexa WSL2 this will only work with a WSL2 port-forward or by running this script inside WSL2 itself.'
        : null,
      'A structured policy rejection is valid behavior: fake-green and insufficient-evidence inputs must not be forced into accepted memory.',
      'Accepted AgentTurns and policy rejections are counted separately; malformed responses count as invalid.',
      'Pass threshold is 95/100 valid (operator brief). Latency and reachability are NOT pass criteria for G06 — they live in G05 and G07.',
    ].filter(Boolean),
  };

  // Write report
  try {
    fs.mkdirSync(ACTIVATION_DIR, { recursive: true });
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  } catch (e) {
    console.error(`FATAL: could not write report to ${REPORT_PATH}: ${e.message}`);
    process.exit(1);
  }

  // Console summary
  console.error('');
  console.error(`[smoke-100-pair] result: ${pass ? 'PASS' : 'FAIL'}`);
  console.error(`[smoke-100-pair]   contract_valid=${valid}/${total}  rate=${(validityRate * 100).toFixed(1)}%  threshold=${(CFG.passThreshold * 100).toFixed(0)}%`);
  console.error(`[smoke-100-pair]   agent_turns=${agentTurnValid}  policy_rejections=${policyRejections}`);
  console.error(`[smoke-100-pair]   invalid=${invalid}  unreachable=${unreachable}`);
  console.error(`[smoke-100-pair]   latency mean=${latencyStats.mean_ms}ms  p95=${latencyStats.p95_ms}ms  max=${latencyStats.max_ms}ms`);
  if (Object.keys(reasonHistogram).length) {
    console.error(`[smoke-100-pair]   failure classes: ${JSON.stringify(reasonHistogram)}`);
  }
  console.error(`[smoke-100-pair]   report: ${REPORT_PATH}`);

  // Stdout: machine-readable result
  console.log(JSON.stringify({
    pass,
    valid,
    agent_turn_valid: agentTurnValid,
    policy_rejections: policyRejections,
    invalid,
    unreachable,
    total,
    validity_rate: validityRate,
    threshold: CFG.passThreshold,
    report_path: REPORT_PATH,
  }, null, 2));

  process.exit(pass ? 0 : 1);
}

// Run only when invoked directly (allow import for unit reuse).
const isMain = (() => {
  try { return fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || ''); }
  catch { return false; }
})();

if (isMain) {
  main().catch((e) => {
    console.error('FATAL smoke error:', e);
    process.exit(1);
  });
}

export { CFG, PROMPTS, validateAgentTurn, extractTurn };
