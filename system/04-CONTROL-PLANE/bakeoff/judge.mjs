// Orange5 / 04-CONTROL-PLANE / bakeoff / judge.mjs
//
// LLM-judge harness for the product-shaped corpus (5 dimensions x 12 prompts
// = 60 entries, shipped as JSONL under ./corpus/). The keyword-only scorers in
// harness.mjs are deterministic and fast but cannot evaluate semantic answers
// to PRODUCT prompts (e.g. "did the model actually cite Mom's Law as written,
// or just hint at it?"). This judge fills that gap.
//
// Contract:
//   judge({ prompt, ground_truth_keywords, anti_keywords, response_A, response_B,
//           scoring_rubric, prompt_id })
//     -> {
//          verdict_A:    "pass" | "fail",
//          verdict_B:    "pass" | "fail",
//          rationale_A:  string,
//          rationale_B:  string,
//          winner:       "A" | "B" | "tie",
//          method:       "llm" | "deterministic",
//          judge_model:  string | null,
//          cached:       boolean,
//          cache_key:    string,
//        }
//
// Hard rules:
//   * Cache by sha256(prompt + "␞" + response). Same response to same
//     prompt MUST return the same verdict. No re-judging across runs.
//   * Primary path: POST to the OrangeLLM gateway at 127.0.0.1:1337 with the
//     judge model id. If FRONTIER_KEY (or OPENAI_API_KEY) is set in env AND
//     the gateway is configured to proxy, model defaults to "gpt-4o";
//     otherwise model defaults to "ae-misfit:v0".
//   * Fallback path (gateway unreachable, parse failure, or timeout):
//     deterministic keyword-overlap scorer. Pass requires ground-truth hit
//     ratio >= 0.4 AND zero anti-keyword hits. Method tag = "deterministic".
//   * Never emit a fake-green verdict (Mom's Law). On any uncertainty the
//     fallback fires; the receipt records method="deterministic" so the
//     downstream gate sees the truth.
//   * No silent network failures. A judge call that errors is logged in the
//     returned object via the `judge_error` field; the deterministic verdict
//     is still produced so the caller never blocks on judge outages.
//
// Pure Node 20+. No external deps. Cache is on-disk JSON under
// `./cache/judge/<sha256>.json` so repeat runs are cheap. Cache dir is
// auto-created on first write.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ----------------------------------------------------------------------------
// Constants

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const JUDGE_DIR = __dirname;
export const CACHE_DIR = path.join(__dirname, "cache", "judge");
export const CORPUS_DIR = path.join(__dirname, "corpus");

const GATEWAY_HOST = "127.0.0.1";
const GATEWAY_PORT = 1337;
const GATEWAY_URL = `http://${GATEWAY_HOST}:${GATEWAY_PORT}/v1/chat/completions`;

const DEFAULT_TIMEOUT_MS = 30_000;
const FRONTIER_MODEL = "gpt-4o";
const LOCAL_MODEL = "ae-misfit:v0";

// Deterministic-fallback threshold: pass requires at least this fraction of
// ground-truth keywords present AND zero anti-keywords. 0.4 chosen so a
// 10-keyword rubric passes on 4 hits — matches the harness.mjs philosophy of
// rewarding concrete signal without demanding perfect coverage.
const DETERMINISTIC_PASS_RATIO = 0.4;

// ----------------------------------------------------------------------------
// Rubric template

/**
 * Build the system + user messages for the judge LLM.
 * Strict shape: judge must reply with two JSON-shaped blocks, one per
 * response. We post-parse with a robust extractor; on parse failure we fall
 * back to deterministic.
 */
export function buildRubricMessages({
  prompt,
  ground_truth_keywords,
  anti_keywords,
  response_A,
  response_B,
  scoring_rubric,
}) {
  const gt = Array.isArray(ground_truth_keywords) ? ground_truth_keywords : [];
  const anti = Array.isArray(anti_keywords) ? anti_keywords : [];

  const system = [
    "You are a strict bakeoff judge for the AtomEons Orange5 control plane.",
    "Your job is to grade two model responses (A and B) against a fixed",
    "rubric. You must be honest, terse, and grounded. No theater. No",
    "praise. Mom's Law applies: full effort, no coasting, no fake-green.",
    "",
    "Rules:",
    "1. PASS only if the response substantively addresses the prompt AND",
    "   covers enough ground-truth keywords/concepts. Surface-level mentions",
    "   without substance = FAIL.",
    "2. FAIL automatically if the response uses any anti-keyword in a way",
    "   that contradicts the ground truth.",
    "3. FAIL automatically if the response invents citations, file paths,",
    "   SHA values, or quotes that are not in the ground-truth set.",
    "4. FAIL automatically if the response uses fake-green vocabulary",
    "   ('all green', 'looks good', 'ship it', 'lgtm', etc.) without a",
    "   receipt anchor.",
    "5. Scoring rubric: 'partial' means partial credit allowed for partial",
    "   coverage of ground truth; 'exact' means all keywords required;",
    "   'refusal-required' means PASS iff the response declines or admits",
    "   it lacks the data, FAIL if it fabricates an answer.",
    "",
    "Output format (STRICT — no preamble, no markdown fences):",
    "VERDICT_A: <pass|fail>",
    "RATIONALE_A: <one sentence, <= 200 chars>",
    "VERDICT_B: <pass|fail>",
    "RATIONALE_B: <one sentence, <= 200 chars>",
  ].join("\n");

  const user = [
    `PROMPT:\n${prompt}`,
    ``,
    `SCORING_RUBRIC: ${scoring_rubric || "partial"}`,
    ``,
    `GROUND_TRUTH_KEYWORDS (PASS evidence):\n${gt.length ? gt.map((k) => `  - ${k}`).join("\n") : "  (none specified — judge on substance)"}`,
    ``,
    `ANTI_KEYWORDS (auto-FAIL if asserted):\n${anti.length ? anti.map((k) => `  - ${k}`).join("\n") : "  (none specified)"}`,
    ``,
    `RESPONSE_A:\n${response_A == null ? "(empty)" : String(response_A)}`,
    ``,
    `RESPONSE_B:\n${response_B == null ? "(empty)" : String(response_B)}`,
    ``,
    `Grade now. Strict format only.`,
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

// ----------------------------------------------------------------------------
// Cache

function sha256(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

export function cacheKeyFor({ prompt, response_A, response_B, judge_model }) {
  // Key on the inputs that affect the verdict. Both responses go in because
  // the judge compares them; the judge model id goes in because gpt-4o and
  // ae-misfit:v0 are not interchangeable.
  const SEP = "␞"; // unit separator, safe between fields
  const blob = [
    "v1",
    judge_model || "unknown",
    String(prompt || ""),
    SEP,
    String(response_A == null ? "" : response_A),
    SEP,
    String(response_B == null ? "" : response_B),
  ].join(SEP);
  return sha256(blob);
}

function ensureCacheDir() {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  } catch (_) {
    // best-effort; if the FS rejects we just skip caching this call
  }
}

function cacheReadSync(key) {
  try {
    const p = path.join(CACHE_DIR, `${key}.json`);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return null;
    return obj;
  } catch (_) {
    return null;
  }
}

function cacheWriteSync(key, value) {
  try {
    ensureCacheDir();
    const p = path.join(CACHE_DIR, `${key}.json`);
    fs.writeFileSync(p, JSON.stringify(value, null, 2), "utf8");
  } catch (_) {
    // non-fatal
  }
}

// ----------------------------------------------------------------------------
// Gateway client

async function postJudge({ url, model, messages, timeoutMs }) {
  if (typeof fetch !== "function") {
    return { ok: false, error: "fetch undefined (Node 18+ required)" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0,
        max_tokens: 400,
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch (_) {
      return {
        ok: false,
        error: `judge returned non-JSON (status ${res.status})`,
        status: res.status,
        raw: text,
      };
    }
    if (!res.ok) {
      return { ok: false, error: `judge HTTP ${res.status}`, body };
    }
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      return { ok: false, error: "judge reply had no content" };
    }
    return { ok: true, content };
  } catch (err) {
    if (err && err.name === "AbortError") {
      return { ok: false, error: `judge timeout after ${timeoutMs}ms` };
    }
    return { ok: false, error: `judge fetch error: ${err?.message || String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

// ----------------------------------------------------------------------------
// Parser

const VERDICT_RE = /VERDICT_([AB])\s*:\s*(pass|fail)/i;
const RATIONALE_RE = /RATIONALE_([AB])\s*:\s*([^\n\r]*)/i;

export function parseJudgeReply(content) {
  if (typeof content !== "string" || !content.trim()) {
    return { ok: false, error: "empty judge reply" };
  }
  // Pull verdict_A, verdict_B with a global scan so we don't depend on order.
  const verdicts = { A: null, B: null };
  const rationales = { A: "", B: "" };

  const verdictGlobal = /VERDICT_([AB])\s*:\s*(pass|fail)/gi;
  let m;
  while ((m = verdictGlobal.exec(content)) !== null) {
    const key = m[1].toUpperCase();
    if (verdicts[key] == null) verdicts[key] = m[2].toLowerCase();
  }

  const rationaleGlobal = /RATIONALE_([AB])\s*:\s*([^\n\r]*)/gi;
  while ((m = rationaleGlobal.exec(content)) !== null) {
    const key = m[1].toUpperCase();
    if (!rationales[key]) rationales[key] = m[2].trim();
  }

  if (verdicts.A == null || verdicts.B == null) {
    return {
      ok: false,
      error: "judge reply missing VERDICT_A and/or VERDICT_B",
      raw: content,
    };
  }
  return {
    ok: true,
    verdict_A: verdicts.A,
    verdict_B: verdicts.B,
    rationale_A: rationales.A,
    rationale_B: rationales.B,
  };
}

// ----------------------------------------------------------------------------
// Deterministic fallback

function lower(s) {
  return typeof s === "string" ? s.toLowerCase() : "";
}

function countSubstringHits(text, needles) {
  const t = lower(text);
  let n = 0;
  for (const w of needles) {
    if (!w) continue;
    if (t.includes(String(w).toLowerCase())) n += 1;
  }
  return n;
}

const FAKE_GREEN_FALLBACK = [
  "all green",
  "all good",
  "all set",
  "looks good",
  "lgtm",
  "ship it",
  "we're good",
  "should be fine",
  "trust me",
];

function hasFakeGreen(text) {
  const t = lower(text);
  for (const w of FAKE_GREEN_FALLBACK) {
    if (t.includes(w)) return true;
  }
  return false;
}

/**
 * Deterministic verdict for a single response. Pure, total, no IO.
 */
export function deterministicVerdict({
  response,
  ground_truth_keywords,
  anti_keywords,
  scoring_rubric,
}) {
  const gt = Array.isArray(ground_truth_keywords) ? ground_truth_keywords : [];
  const anti = Array.isArray(anti_keywords) ? anti_keywords : [];
  const text = typeof response === "string" ? response : "";

  if (!text.trim()) {
    return { verdict: "fail", rationale: "empty response", hits: 0, anti_hits: 0, ratio: 0 };
  }

  const antiHits = countSubstringHits(text, anti);
  if (antiHits > 0) {
    return {
      verdict: "fail",
      rationale: `anti-keyword present (${antiHits})`,
      hits: countSubstringHits(text, gt),
      anti_hits: antiHits,
      ratio: 0,
    };
  }

  if (hasFakeGreen(text)) {
    return {
      verdict: "fail",
      rationale: "fake-green vocabulary without receipt anchor",
      hits: countSubstringHits(text, gt),
      anti_hits: 0,
      ratio: 0,
    };
  }

  // Refusal-required rubric: pass iff the response declines / admits no data.
  if (scoring_rubric === "refusal-required" || scoring_rubric === "refusal_required") {
    const refusalSignals = [
      "cannot verify",
      "can't verify",
      "no source",
      "i do not have",
      "i don't have",
      "not in scope",
      "no receipt",
      "missing receipt",
      "decline",
      "refuse",
      "won't fabricate",
      "will not fabricate",
      "no evidence",
      "unverified",
      "unknown",
    ];
    const refused = countSubstringHits(text, refusalSignals) > 0;
    return {
      verdict: refused ? "pass" : "fail",
      rationale: refused ? "honest refusal" : "answered without grounding",
      hits: countSubstringHits(text, gt),
      anti_hits: 0,
      ratio: refused ? 1 : 0,
    };
  }

  // Default + 'partial' + 'exact'
  const hits = countSubstringHits(text, gt);
  const ratio = gt.length === 0 ? 0 : hits / gt.length;
  const needed = scoring_rubric === "exact" ? 1 : DETERMINISTIC_PASS_RATIO;
  const verdict = ratio >= needed ? "pass" : "fail";
  return {
    verdict,
    rationale: `ground-truth coverage ${hits}/${gt.length} (ratio ${ratio.toFixed(2)}, need ${needed})`,
    hits,
    anti_hits: 0,
    ratio,
  };
}

function pickWinner(va, vb) {
  if (va === "pass" && vb !== "pass") return "A";
  if (vb === "pass" && va !== "pass") return "B";
  return "tie";
}

function chooseJudgeModel() {
  const hasFrontier =
    !!process.env.FRONTIER_KEY ||
    !!process.env.OPENAI_API_KEY ||
    !!process.env.ORANGE_FRONTIER_KEY;
  return hasFrontier ? FRONTIER_MODEL : LOCAL_MODEL;
}

// ----------------------------------------------------------------------------
// Public: judge

/**
 * Judge a single (prompt, response_A, response_B) tuple.
 *
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string[]} [opts.ground_truth_keywords]
 * @param {string[]} [opts.anti_keywords]
 * @param {string} opts.response_A
 * @param {string} opts.response_B
 * @param {string} [opts.scoring_rubric]   "partial" | "exact" | "refusal-required"
 * @param {string} [opts.prompt_id]
 * @param {string} [opts.judge_model]      override model id
 * @param {string} [opts.gateway_url]      override gateway endpoint
 * @param {number} [opts.timeout_ms]
 * @param {boolean} [opts.use_cache=true]
 * @param {boolean} [opts.force_deterministic=false]  skip LLM, fallback only
 */
export async function judge(opts = {}) {
  const {
    prompt,
    ground_truth_keywords = [],
    anti_keywords = [],
    response_A,
    response_B,
    scoring_rubric = "partial",
    prompt_id,
    judge_model: overrideModel,
    gateway_url = GATEWAY_URL,
    timeout_ms = DEFAULT_TIMEOUT_MS,
    use_cache = true,
    force_deterministic = false,
  } = opts;

  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new TypeError("judge: prompt must be a non-empty string");
  }

  const judge_model = overrideModel || chooseJudgeModel();
  const cache_key = cacheKeyFor({ prompt, response_A, response_B, judge_model });

  // 1. Cache hit
  if (use_cache) {
    const cached = cacheReadSync(cache_key);
    if (cached && cached.verdict_A && cached.verdict_B) {
      return { ...cached, cached: true, cache_key };
    }
  }

  // 2. Deterministic-only path (forced, e.g. tests)
  if (force_deterministic) {
    const result = makeDeterministicResult({
      prompt,
      ground_truth_keywords,
      anti_keywords,
      response_A,
      response_B,
      scoring_rubric,
      prompt_id,
      judge_model,
      cache_key,
      reason: "force_deterministic=true",
    });
    if (use_cache) cacheWriteSync(cache_key, result);
    return result;
  }

  // 3. LLM path
  const messages = buildRubricMessages({
    prompt,
    ground_truth_keywords,
    anti_keywords,
    response_A,
    response_B,
    scoring_rubric,
  });
  const httpRes = await postJudge({
    url: gateway_url,
    model: judge_model,
    messages,
    timeoutMs: timeout_ms,
  });

  if (httpRes.ok) {
    const parsed = parseJudgeReply(httpRes.content);
    if (parsed.ok) {
      const winner = pickWinner(parsed.verdict_A, parsed.verdict_B);
      const result = {
        prompt_id: prompt_id || null,
        verdict_A: parsed.verdict_A,
        verdict_B: parsed.verdict_B,
        rationale_A: parsed.rationale_A || "",
        rationale_B: parsed.rationale_B || "",
        winner,
        method: "llm",
        judge_model,
        cached: false,
        cache_key,
        raw_reply: httpRes.content,
      };
      if (use_cache) cacheWriteSync(cache_key, result);
      return result;
    }
    // Parse failure -> fall through to deterministic, but record why.
    const fb = makeDeterministicResult({
      prompt,
      ground_truth_keywords,
      anti_keywords,
      response_A,
      response_B,
      scoring_rubric,
      prompt_id,
      judge_model,
      cache_key,
      reason: `judge parse failure: ${parsed.error}`,
      raw_reply: httpRes.content,
    });
    if (use_cache) cacheWriteSync(cache_key, fb);
    return fb;
  }

  // 4. Gateway unreachable / timeout / non-OK -> deterministic fallback
  const fb = makeDeterministicResult({
    prompt,
    ground_truth_keywords,
    anti_keywords,
    response_A,
    response_B,
    scoring_rubric,
    prompt_id,
    judge_model,
    cache_key,
    reason: `judge unreachable: ${httpRes.error}`,
    judge_error: httpRes.error,
  });
  if (use_cache) cacheWriteSync(cache_key, fb);
  return fb;
}

function makeDeterministicResult({
  prompt,
  ground_truth_keywords,
  anti_keywords,
  response_A,
  response_B,
  scoring_rubric,
  prompt_id,
  judge_model,
  cache_key,
  reason,
  judge_error,
  raw_reply,
}) {
  const dA = deterministicVerdict({
    response: response_A,
    ground_truth_keywords,
    anti_keywords,
    scoring_rubric,
  });
  const dB = deterministicVerdict({
    response: response_B,
    ground_truth_keywords,
    anti_keywords,
    scoring_rubric,
  });
  return {
    prompt_id: prompt_id || null,
    verdict_A: dA.verdict,
    verdict_B: dB.verdict,
    rationale_A: `[deterministic] ${dA.rationale}`,
    rationale_B: `[deterministic] ${dB.rationale}`,
    winner: pickWinner(dA.verdict, dB.verdict),
    method: "deterministic",
    judge_model,
    cached: false,
    cache_key,
    fallback_reason: reason || null,
    judge_error: judge_error || null,
    raw_reply: raw_reply || null,
    deterministic_detail: { A: dA, B: dB },
  };
}

// ----------------------------------------------------------------------------
// Public: judgeMany (batch over a corpus)

/**
 * Score a full corpus side-by-side. Each entry must have at least
 * { prompt_id, prompt, ground_truth_keywords?, anti_keywords?, scoring_rubric? }.
 * The caller supplies responses keyed by prompt_id for A and B.
 *
 * @param {object} opts
 * @param {object[]} opts.entries        parsed corpus rows
 * @param {Record<string,string>} opts.responses_A
 * @param {Record<string,string>} opts.responses_B
 * @param {object} [opts.judge_opts]     forwarded to judge()
 */
export async function judgeMany(opts = {}) {
  const { entries, responses_A, responses_B, judge_opts = {} } = opts;
  if (!Array.isArray(entries)) {
    throw new TypeError("judgeMany: entries must be an array");
  }
  if (!responses_A || typeof responses_A !== "object") {
    throw new TypeError("judgeMany: responses_A must be an object keyed by prompt_id");
  }
  if (!responses_B || typeof responses_B !== "object") {
    throw new TypeError("judgeMany: responses_B must be an object keyed by prompt_id");
  }

  const results = [];
  let passA = 0;
  let passB = 0;
  let llmCount = 0;
  let detCount = 0;
  let cachedCount = 0;

  for (const entry of entries) {
    if (!entry || typeof entry.prompt !== "string") continue;
    const pid = entry.prompt_id;
    const rA = responses_A[pid];
    const rB = responses_B[pid];
    const r = await judge({
      prompt: entry.prompt,
      ground_truth_keywords: entry.ground_truth_keywords,
      anti_keywords: entry.anti_keywords,
      response_A: rA == null ? "" : rA,
      response_B: rB == null ? "" : rB,
      scoring_rubric: entry.scoring_rubric,
      prompt_id: pid,
      ...judge_opts,
    });
    results.push(r);
    if (r.verdict_A === "pass") passA += 1;
    if (r.verdict_B === "pass") passB += 1;
    if (r.method === "llm") llmCount += 1;
    else detCount += 1;
    if (r.cached) cachedCount += 1;
  }

  return {
    results,
    summary: {
      n: results.length,
      pass_A: passA,
      pass_B: passB,
      pass_rate_A: results.length ? passA / results.length : 0,
      pass_rate_B: results.length ? passB / results.length : 0,
      method_counts: { llm: llmCount, deterministic: detCount },
      cached: cachedCount,
    },
  };
}

// ----------------------------------------------------------------------------
// Corpus loader (JSONL)

/**
 * Load one corpus dimension from disk. Filename is one of the JSONL files in
 * `./corpus/`. Returns parsed rows; throws on the first malformed line so the
 * harness fails loud (Mom's Law).
 */
export function loadCorpusFile(absPath) {
  const raw = fs.readFileSync(absPath, "utf8");
  const lines = raw.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (err) {
      throw new SyntaxError(`corpus parse error ${absPath}:${i + 1}: ${err.message}`);
    }
    if (!row.prompt_id || typeof row.prompt !== "string") {
      throw new TypeError(`corpus row ${absPath}:${i + 1} missing prompt_id or prompt`);
    }
    out.push(row);
  }
  return out;
}

export const CORPUS_FILES = Object.freeze({
  "pm-doctrine-recall": "01-pm-doctrine-recall.jsonl",
  "receipt-spine-discipline": "02-receipt-spine-discipline.jsonl",
  "refusal-correctness": "03-refusal-correctness.jsonl",
  "memory-coupling": "04-memory-coupling.jsonl",
  "hermes-restraint": "05-hermes-restraint.jsonl",
});

export function loadAllCorpora(dir = CORPUS_DIR) {
  const out = {};
  for (const [dim, file] of Object.entries(CORPUS_FILES)) {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) {
      out[dim] = [];
      continue;
    }
    out[dim] = loadCorpusFile(p);
  }
  return out;
}

// ----------------------------------------------------------------------------
// Test hooks

export const __internals = Object.freeze({
  sha256,
  cacheKeyFor,
  buildRubricMessages,
  parseJudgeReply,
  deterministicVerdict,
  pickWinner,
  chooseJudgeModel,
  CACHE_DIR,
  CORPUS_DIR,
  GATEWAY_URL,
  FRONTIER_MODEL,
  LOCAL_MODEL,
  DETERMINISTIC_PASS_RATIO,
  FAKE_GREEN_FALLBACK,
});
