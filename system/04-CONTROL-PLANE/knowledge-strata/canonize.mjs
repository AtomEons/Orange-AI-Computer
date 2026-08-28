#!/usr/bin/env node
// canonize.mjs — Knowledge Strata compiler loop
// AtomEons canon: intake -> canon -> durable artifact -> integrity pass -> reuse.
//
// Each step is a gate. A row only earns canon status when every gate passes.
// Cheap pre-pass runs on Smart Skinny (8797). Authoritative extraction runs on
// OrangeLLM (1337). Both are loopback-only by Orange5 boundary law.
//
// Output shape per AtomEons completion law:
//   result, evidence, blockers, next-action.
//
// Layout (created on first run):
//   ./intake/<id>.{txt,md,json}            raw operator/agent input
//   ./canon/<dept>/<id>.canon.json         structured canon row
//   ./artifacts/<dept>/<id>.md             durable, human-readable artifact
//   ./artifacts/<dept>/<id>.meta.json      artifact sidecar (hashes, lineage)
//   ./strata.index.jsonl                   append-only canon index
//   ./strata.receipts.jsonl                append-only receipts log
//
// Departments: AE0..AE14 (AtomEons departmental taxonomy).
//
// CLI:
//   node canonize.mjs <intake-file>            single intake
//   node canonize.mjs --dir <dir>              every readable file in dir
//   node canonize.mjs --stdin --id <id>        stdin pipeline
//   node canonize.mjs --reuse <query>          cite-search across canon
//   node canonize.mjs --verify                 re-run integrity over full canon
//
// Flags:
//   --cheap            skip OrangeLLM, accept Smart Skinny output as canon
//   --no-llm           extract heuristically only (offline mode)
//   --dept <code>      force department tag (AE0..AE14)
//   --tags <a,b,c>     extra tags
//   --dry              do not write artifacts, print plan
//   --force            overwrite an existing canon row (lineage preserved)
//
// Node 20+. No external deps. Loopback only.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, appendFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { argv, exit, stdin } from "node:process";

const __filename = fileURLToPath(import.meta.url);
const ROOT = dirname(__filename);

// ----- configuration -----

const ORANGELLM_URL = process.env.ORANGE5_ORANGELLM_URL || "http://127.0.0.1:1337";
const SMART_SKINNY_URL = process.env.ORANGE5_SMART_SKINNY_URL || "http://127.0.0.1:8797";
const ORANGELLM_MODEL = process.env.ORANGE5_ORANGELLM_MODEL || "orangellm-router-v0";
const SMART_SKINNY_MODEL = process.env.ORANGE5_SMART_SKINNY_MODEL_PUBLIC || "orangellm-smart-skinny-0.5b";
const TIMEOUT_PREPASS_MS = Number(process.env.ORANGE5_KS_PREPASS_TIMEOUT_MS || 30_000);
const TIMEOUT_AUTH_MS = Number(process.env.ORANGE5_KS_AUTH_TIMEOUT_MS || 90_000);

const DEPARTMENTS = Object.freeze([
  "AE0", "AE1", "AE2", "AE3", "AE4", "AE5", "AE6", "AE7",
  "AE8", "AE9", "AE10", "AE11", "AE12", "AE13", "AE14",
]);

// Department keyword priors. Heuristic-only; LLM may override.
const DEPT_PRIORS = Object.freeze({
  AE0:  ["factory", "orchestrator", "doctrine", "canon", "charter", "mom"],
  AE1:  ["product", "spec", "feature", "prd"],
  AE2:  ["research", "study", "paper", "literature", "preprint", "doc"],
  AE3:  ["design", "ux", "ui", "figma", "shadcn"],
  AE4:  ["marketing", "brand", "voice", "campaign", "seo"],
  AE5:  ["sales", "outreach", "pipeline", "crm"],
  AE6:  ["code", "implementation", "module", "engine", "runtime"],
  AE7:  ["review", "lakestrike", "adversarial", "regression"],
  AE8:  ["launch", "release", "ship", "promotion"],
  AE9:  ["legal", "contract", "license", "compliance"],
  AE10: ["ops", "ops/", "runbook", "incident", "deploy"],
  AE11: ["security", "audit", "secret", "vuln", "cve"],
  AE12: ["data", "metric", "telemetry", "warehouse", "sql"],
  AE13: ["automation", "openclaw", "cron", "dispatch"],
  AE14: ["bench", "benchmark", "latency", "throughput"],
});

// ----- utilities -----

function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

function nowIso() { return new Date().toISOString(); }

function shortId(seed) {
  return sha256(`${seed}|${Date.now()}|${Math.random()}`).slice(0, 12);
}

async function ensureDir(p) { await mkdir(p, { recursive: true }); }

async function pathExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

// Flags that NEVER take a value. Everything else may pair with the next token.
const BOOLEAN_FLAGS = new Set([
  "cheap", "no-llm", "dry", "force", "stdin", "verify",
  "allow-contradictions",
]);

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (BOOLEAN_FLAGS.has(key)) { args.flags[key] = true; continue; }
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) { args.flags[key] = next; i++; }
      else args.flags[key] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ----- LLM clients -----

async function llmChatCompletion({ baseUrl, model, messages, temperature = 0.1, maxTokens = 1024, timeoutMs }) {
  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  const res = await fetchWithTimeout(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, timeoutMs);
  const text = await res.text();
  if (!res.ok) {
    const detail = text.slice(0, 500);
    throw new Error(`llm ${baseUrl} returned ${res.status}: ${detail}`);
  }
  const data = JSON.parse(text);
  const content = data?.choices?.[0]?.message?.content ?? "";
  return { content, raw: data };
}

async function tryHealth(baseUrl) {
  try {
    const res = await fetchWithTimeout(`${baseUrl}/healthz`, {}, 3_000);
    return res.ok;
  } catch { return false; }
}

// ----- extraction -----

// Build the system prompt for extraction. Same shape used by both Smart Skinny
// (cheap pre-pass) and OrangeLLM (authoritative). The cheap pass produces a
// sketch; the authoritative pass refines and signs off.

function buildExtractionMessages({ text, deptHint, knownCanonSnippets }) {
  const system = `You are the Knowledge Strata extractor for AtomEons.
You receive raw operator or agent input (notes, transcripts, receipts).
Your job: return STRICT JSON only, no prose, with this exact shape:

{
  "title": string,                    // <= 90 chars, descriptive, no marketing
  "summary": string,                  // <= 280 chars, factual
  "department": "AE0".."AE14",        // best-fit AtomEons department
  "entities": [                       // distinct things named
    { "name": string, "kind": string, "aliases": string[] }
  ],
  "claims": [                         // factual assertions made by the source
    { "text": string, "confidence": "high"|"medium"|"low", "supports": string[] }
  ],
  "cited_doctrine": [                 // explicit cites of AtomEons doctrine / canon
    { "doc": string, "section": string|null }
  ],
  "tags": string[],                   // freeform low-cardinality tags
  "open_questions": string[]          // explicit unresolved items
}

Rules:
- No invented facts. If the source does not say it, do not assert it.
- Doctrine cite is allowed only if the source quotes or names the doctrine.
- Department codes are AE0..AE14 only. Hint: ${deptHint || "none"}.
- Output ONLY the JSON object. No backticks. No commentary.`;

  const priorSnippets = (knownCanonSnippets && knownCanonSnippets.length)
    ? `\n\nKnown canon (do not repeat, may contradict-check):\n${knownCanonSnippets.map(s => `- ${s}`).join("\n")}`
    : "";

  const user = `RAW INPUT:\n${text}${priorSnippets}`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function tryParseJsonObject(s) {
  if (!s) return null;
  const trimmed = s.trim();
  // Tolerate fenced code blocks even though we asked for none.
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    const obj = JSON.parse(stripped);
    return (obj && typeof obj === "object" && !Array.isArray(obj)) ? obj : null;
  } catch {
    // Try to find the first {...} block.
    const m = stripped.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
  }
}

function heuristicExtract(text, deptHint) {
  // Pure-Node fallback. No LLM. Used in --no-llm mode and when both upstreams
  // are unreachable. Honest about its weakness; everything is "low" confidence.
  const lower = text.toLowerCase();
  let dept = deptHint && DEPARTMENTS.includes(deptHint) ? deptHint : null;
  if (!dept) {
    let best = { dept: "AE0", score: 0 };
    for (const [code, words] of Object.entries(DEPT_PRIORS)) {
      const score = words.reduce((acc, w) => acc + (lower.includes(w) ? 1 : 0), 0);
      if (score > best.score) best = { dept: code, score };
    }
    dept = best.dept;
  }
  const firstLine = text.split(/\r?\n/).find(l => l.trim().length) || "";
  const title = firstLine.slice(0, 90).replace(/^#+\s*/, "") || "Untitled intake";
  const summary = text.replace(/\s+/g, " ").trim().slice(0, 280);
  const claims = text.split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 12 && l.length < 240)
    .slice(0, 10)
    .map(t => ({ text: t.replace(/^[-*]\s*/, ""), confidence: "low", supports: [] }));
  return {
    title,
    summary,
    department: dept,
    entities: [],
    claims,
    cited_doctrine: [],
    tags: ["heuristic"],
    open_questions: [],
    _extractor: "heuristic",
  };
}

function normalizeExtraction(obj) {
  // Defensive normalization. Drop unknown keys, coerce types, clamp lengths.
  if (!obj || typeof obj !== "object") return null;
  const dept = DEPARTMENTS.includes(obj.department) ? obj.department : "AE0";
  const arr = (v) => Array.isArray(v) ? v : [];
  const str = (v, n = 280) => (typeof v === "string" ? v : String(v ?? "")).slice(0, n);
  const conf = (v) => ["high", "medium", "low"].includes(v) ? v : "low";

  return {
    title: str(obj.title, 90) || "Untitled intake",
    summary: str(obj.summary, 280),
    department: dept,
    entities: arr(obj.entities).slice(0, 64).map(e => ({
      name: str(e?.name, 120),
      kind: str(e?.kind, 40) || "thing",
      aliases: arr(e?.aliases).slice(0, 8).map(a => str(a, 120)),
    })).filter(e => e.name),
    claims: arr(obj.claims).slice(0, 128).map(c => ({
      text: str(c?.text, 480),
      confidence: conf(c?.confidence),
      supports: arr(c?.supports).slice(0, 8).map(s => str(s, 240)),
    })).filter(c => c.text),
    cited_doctrine: arr(obj.cited_doctrine).slice(0, 32).map(d => ({
      doc: str(d?.doc, 240),
      section: d?.section == null ? null : str(d?.section, 240),
    })).filter(d => d.doc),
    tags: arr(obj.tags).slice(0, 32).map(t => str(t, 60)).filter(Boolean),
    open_questions: arr(obj.open_questions).slice(0, 32).map(q => str(q, 280)).filter(Boolean),
  };
}

// ----- gates -----

// Gate 1: INTAKE
//   Material exists, is readable, is not empty, has a stable hash.

async function gateIntake({ source, text, id }) {
  const blockers = [];
  if (!text || !text.trim()) blockers.push("intake_empty");
  if (text && text.length > 2_000_000) blockers.push("intake_too_large_2MB");
  const hash = text ? sha256(text) : null;
  return {
    name: "intake",
    ok: blockers.length === 0,
    blockers,
    evidence: { source, id, byte_length: text?.length ?? 0, sha256: hash },
  };
}

// Gate 2: CANON (extraction)
//   Cheap pre-pass via Smart Skinny if available. Authoritative pass via
//   OrangeLLM. If --cheap, accept cheap result. If --no-llm, heuristic only.
//   Either way, normalize and reject if title/department invalid.

async function gateCanon({ text, deptHint, knownCanonSnippets, flags }) {
  const blockers = [];
  const evidence = { upstreams: {} };
  let extraction = null;
  let extractor = "unknown";

  if (flags["no-llm"]) {
    extraction = heuristicExtract(text, deptHint);
    extractor = "heuristic";
    evidence.upstreams.heuristic = true;
  } else {
    const skinnyOk = await tryHealth(SMART_SKINNY_URL);
    const oraOk = flags.cheap ? false : await tryHealth(ORANGELLM_URL);
    evidence.upstreams.smart_skinny = skinnyOk;
    evidence.upstreams.orangellm = oraOk;

    let cheap = null;
    if (skinnyOk) {
      try {
        const messages = buildExtractionMessages({ text, deptHint, knownCanonSnippets });
        const out = await llmChatCompletion({
          baseUrl: SMART_SKINNY_URL,
          model: SMART_SKINNY_MODEL,
          messages,
          timeoutMs: TIMEOUT_PREPASS_MS,
          maxTokens: 1024,
        });
        cheap = normalizeExtraction(tryParseJsonObject(out.content));
        evidence.cheap_ok = !!cheap;
      } catch (e) {
        evidence.cheap_error = e.message;
      }
    }

    if (oraOk) {
      try {
        // Authoritative pass. Includes cheap sketch as a refinement target.
        const augmentedText = cheap
          ? `${text}\n\n---\nCHEAP PRE-PASS SKETCH (refine, do not blindly trust):\n${JSON.stringify(cheap, null, 2)}`
          : text;
        const messages = buildExtractionMessages({
          text: augmentedText,
          deptHint,
          knownCanonSnippets,
        });
        const out = await llmChatCompletion({
          baseUrl: ORANGELLM_URL,
          model: ORANGELLM_MODEL,
          messages,
          timeoutMs: TIMEOUT_AUTH_MS,
          maxTokens: 2048,
        });
        extraction = normalizeExtraction(tryParseJsonObject(out.content));
        extractor = "orangellm";
        evidence.authoritative_ok = !!extraction;
      } catch (e) {
        evidence.authoritative_error = e.message;
      }
    }

    if (!extraction) {
      if (cheap && flags.cheap) {
        extraction = cheap;
        extractor = "smart-skinny (cheap mode)";
      } else if (cheap) {
        // OrangeLLM unavailable, fall back to cheap. Flag honestly.
        extraction = cheap;
        extractor = "smart-skinny (fallback, orangellm unavailable)";
        evidence.fallback = "smart-skinny-only";
      } else {
        extraction = heuristicExtract(text, deptHint);
        extractor = "heuristic (all llm upstreams failed)";
        evidence.fallback = "heuristic";
      }
    }
  }

  if (!extraction) blockers.push("extraction_failed");
  else {
    if (!extraction.title) blockers.push("missing_title");
    if (!DEPARTMENTS.includes(extraction.department)) blockers.push("invalid_department");
  }

  return {
    name: "canon",
    ok: blockers.length === 0,
    blockers,
    evidence: { ...evidence, extractor },
    extraction,
  };
}

// Gate 3: ARTIFACT
//   Render durable Markdown + JSON sidecar. Hash both. Refuse to write if
//   --dry. Refuse to overwrite unless --force.

function renderArtifactMarkdown({ id, extraction, intakeHash, lineage }) {
  const lines = [];
  lines.push(`# ${extraction.title}`);
  lines.push("");
  lines.push(`> **Department:** ${extraction.department}  `);
  lines.push(`> **Canon ID:** \`${id}\`  `);
  lines.push(`> **Intake SHA-256:** \`${intakeHash}\`  `);
  lines.push(`> **Canonized:** ${nowIso()}  `);
  if (lineage?.supersedes) lines.push(`> **Supersedes:** \`${lineage.supersedes}\`  `);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(extraction.summary || "_no summary_");
  lines.push("");
  if (extraction.entities.length) {
    lines.push("## Entities");
    lines.push("");
    for (const e of extraction.entities) {
      const aliases = e.aliases.length ? ` _(aliases: ${e.aliases.join(", ")})_` : "";
      lines.push(`- **${e.name}** — ${e.kind}${aliases}`);
    }
    lines.push("");
  }
  if (extraction.claims.length) {
    lines.push("## Claims");
    lines.push("");
    for (const c of extraction.claims) {
      const sup = c.supports.length ? `  \n  _supports:_ ${c.supports.join("; ")}` : "";
      lines.push(`- [${c.confidence}] ${c.text}${sup}`);
    }
    lines.push("");
  }
  if (extraction.cited_doctrine.length) {
    lines.push("## Cited doctrine");
    lines.push("");
    for (const d of extraction.cited_doctrine) {
      const sec = d.section ? ` § ${d.section}` : "";
      lines.push(`- ${d.doc}${sec}`);
    }
    lines.push("");
  }
  if (extraction.tags.length) {
    lines.push(`**Tags:** ${extraction.tags.map(t => `\`${t}\``).join(" ")}`);
    lines.push("");
  }
  if (extraction.open_questions.length) {
    lines.push("## Open questions");
    lines.push("");
    for (const q of extraction.open_questions) lines.push(`- ${q}`);
    lines.push("");
  }
  lines.push("---");
  lines.push("_Knowledge Strata artifact. Canon row authoritative; this Markdown is the durable view._");
  lines.push("");
  return lines.join("\n");
}

async function gateArtifact({ id, extraction, intakeHash, intakeSource, flags, existingCanon }) {
  const blockers = [];
  const dept = extraction.department;
  const canonDir = join(ROOT, "canon", dept);
  const artDir = join(ROOT, "artifacts", dept);
  const canonPath = join(canonDir, `${id}.canon.json`);
  const artPath = join(artDir, `${id}.md`);
  const metaPath = join(artDir, `${id}.meta.json`);

  if (await pathExists(canonPath) && !flags.force) {
    if (!existingCanon) blockers.push("canon_row_already_exists_no_force");
  }

  const lineage = existingCanon ? { supersedes: existingCanon.id, version: (existingCanon.version || 1) + 1 }
                                : { supersedes: null, version: 1 };

  const md = renderArtifactMarkdown({ id, extraction, intakeHash, lineage });
  const mdHash = sha256(md);

  const canonRow = {
    id,
    version: lineage.version,
    supersedes: lineage.supersedes,
    department: dept,
    title: extraction.title,
    summary: extraction.summary,
    entities: extraction.entities,
    claims: extraction.claims,
    cited_doctrine: extraction.cited_doctrine,
    tags: Array.from(new Set([...(extraction.tags || []), ...(flags._extraTags || [])])),
    open_questions: extraction.open_questions,
    intake: {
      source: intakeSource,
      sha256: intakeHash,
    },
    artifact: {
      markdown_path: artPath,
      sha256: mdHash,
    },
    created_at: nowIso(),
    extractor: extraction._extractor || "llm",
  };
  delete extraction._extractor;

  const meta = {
    id,
    version: lineage.version,
    canon_path: canonPath,
    markdown_path: artPath,
    markdown_sha256: mdHash,
    intake_sha256: intakeHash,
    canonized_at: canonRow.created_at,
  };

  if (flags.dry) {
    return {
      name: "artifact",
      ok: blockers.length === 0,
      blockers,
      evidence: { dry: true, canon_path: canonPath, markdown_path: artPath, markdown_sha256: mdHash },
      canonRow, md, meta, canonPath, artPath, metaPath,
    };
  }

  if (blockers.length === 0) {
    await ensureDir(canonDir);
    await ensureDir(artDir);
    await writeFile(canonPath, JSON.stringify(canonRow, null, 2), "utf8");
    await writeFile(artPath, md, "utf8");
    await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");
  }

  return {
    name: "artifact",
    ok: blockers.length === 0,
    blockers,
    evidence: { canon_path: canonPath, markdown_path: artPath, markdown_sha256: mdHash },
    canonRow, md, meta, canonPath, artPath, metaPath,
  };
}

// Gate 4: INTEGRITY
//   Cross-check against prior canon. Surface direct contradictions on
//   claim text. A contradiction is a near-identical claim with opposite
//   polarity (very small heuristic — extended check via LLM is optional).

function normalizeClaim(s) {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

function isLikelyNegation(a, b) {
  const na = normalizeClaim(a);
  const nb = normalizeClaim(b);
  if (!na || !nb) return false;
  const negators = [" not ", " no ", " never ", " cannot ", " can't ", " won't ", " isn't ", " aren't "];
  const hasNegA = negators.some(n => ` ${na} `.includes(n));
  const hasNegB = negators.some(n => ` ${nb} `.includes(n));
  if (hasNegA === hasNegB) return false;
  const stripped = (s) => negators.reduce((acc, n) => acc.split(n).join(" "), ` ${s} `).replace(/\s+/g, " ").trim();
  const sa = stripped(na);
  const sb = stripped(nb);
  if (!sa || !sb) return false;
  // Coarse token overlap.
  const ta = new Set(sa.split(" "));
  const tb = new Set(sb.split(" "));
  const inter = [...ta].filter(t => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  return union > 0 && (inter / union) >= 0.6;
}

async function loadPriorCanon({ department, excludeId }) {
  const dir = join(ROOT, "canon", department);
  if (!existsSync(dir)) return [];
  const files = await readdir(dir);
  const rows = [];
  for (const f of files) {
    if (!f.endsWith(".canon.json")) continue;
    const p = join(dir, f);
    try {
      const raw = await readFile(p, "utf8");
      const row = JSON.parse(raw);
      if (row.id !== excludeId) rows.push(row);
    } catch { /* skip malformed */ }
  }
  return rows;
}

async function gateIntegrity({ canonRow, flags }) {
  const blockers = [];
  const contradictions = [];
  const dups = [];

  const prior = await loadPriorCanon({ department: canonRow.department, excludeId: canonRow.id });
  for (const row of prior) {
    if (row.intake?.sha256 && row.intake.sha256 === canonRow.intake.sha256 && !flags.force) {
      dups.push({ id: row.id, reason: "identical_intake_sha256" });
    }
    for (const newClaim of canonRow.claims) {
      for (const oldClaim of row.claims) {
        if (isLikelyNegation(newClaim.text, oldClaim.text)) {
          contradictions.push({
            new_claim: newClaim.text,
            old_claim: oldClaim.text,
            against_canon_id: row.id,
          });
        }
      }
    }
  }

  if (dups.length && !flags.force) blockers.push("duplicate_intake_hash");
  if (contradictions.length && !flags["allow-contradictions"]) blockers.push("contradicts_existing_canon");

  return {
    name: "integrity",
    ok: blockers.length === 0,
    blockers,
    evidence: {
      prior_canon_compared: prior.length,
      contradictions,
      duplicates: dups,
    },
  };
}

// Gate 5: REUSE
//   Append to the global index so future receipts can cite this row.
//   Also write a receipts row capturing the full chain.

async function gateReuse({ canonRow, gates, flags }) {
  const blockers = [];
  const indexPath = join(ROOT, "strata.index.jsonl");
  const receiptsPath = join(ROOT, "strata.receipts.jsonl");

  const indexRow = {
    id: canonRow.id,
    version: canonRow.version,
    department: canonRow.department,
    title: canonRow.title,
    summary: canonRow.summary,
    tags: canonRow.tags,
    canon_path: join(ROOT, "canon", canonRow.department, `${canonRow.id}.canon.json`),
    markdown_path: canonRow.artifact.markdown_path,
    intake_sha256: canonRow.intake.sha256,
    markdown_sha256: canonRow.artifact.sha256,
    canonized_at: canonRow.created_at,
  };

  const receiptRow = {
    id: canonRow.id,
    canonized_at: canonRow.created_at,
    department: canonRow.department,
    gates: gates.map(g => ({ name: g.name, ok: g.ok, blockers: g.blockers, evidence: g.evidence })),
    intake_sha256: canonRow.intake.sha256,
    markdown_sha256: canonRow.artifact.sha256,
    extractor: canonRow.extractor,
  };

  if (!flags.dry) {
    await appendFile(indexPath, JSON.stringify(indexRow) + "\n", "utf8");
    await appendFile(receiptsPath, JSON.stringify(receiptRow) + "\n", "utf8");
  }

  return {
    name: "reuse",
    ok: blockers.length === 0,
    blockers,
    evidence: { index_path: indexPath, receipts_path: receiptsPath, dry: !!flags.dry },
  };
}

// ----- pipeline -----

async function canonizeOne({ text, source, id, flags }) {
  const intakeId = id || shortId(source || "stdin");
  const deptHint = flags.dept && DEPARTMENTS.includes(flags.dept) ? flags.dept : null;

  // Light prior-context lookup: surface a few canon titles in the candidate
  // department so the LLM has anchors but isn't drowned.
  let knownCanonSnippets = [];
  if (deptHint) {
    const prior = await loadPriorCanon({ department: deptHint, excludeId: intakeId });
    knownCanonSnippets = prior.slice(0, 5).map(r => `${r.id} :: ${r.title}`);
  }

  const g1 = await gateIntake({ source, text, id: intakeId });
  if (!g1.ok) return { ok: false, id: intakeId, gates: [g1], next_action: "fix_intake" };

  const g2 = await gateCanon({ text, deptHint, knownCanonSnippets, flags });
  if (!g2.ok) return { ok: false, id: intakeId, gates: [g1, g2], next_action: "rerun_with_orangellm_up_or_no_llm" };

  // After extraction we may know a better department than deptHint; reload
  // prior canon under that department for integrity.
  const g3 = await gateArtifact({
    id: intakeId,
    extraction: g2.extraction,
    intakeHash: g1.evidence.sha256,
    intakeSource: source,
    flags,
  });
  if (!g3.ok) return { ok: false, id: intakeId, gates: [g1, g2, g3], next_action: "use_--force_or_change_id" };

  const g4 = await gateIntegrity({ canonRow: g3.canonRow, flags });
  if (!g4.ok) {
    return {
      ok: false,
      id: intakeId,
      gates: [g1, g2, g3, g4],
      next_action: "resolve_contradiction_or_pass_--allow-contradictions_or_--force",
      canonRow: g3.canonRow,
    };
  }

  const g5 = await gateReuse({ canonRow: g3.canonRow, gates: [g1, g2, g3, g4], flags });
  return {
    ok: g5.ok,
    id: intakeId,
    gates: [g1, g2, g3, g4, g5],
    canonRow: g3.canonRow,
    artifact_path: g3.artPath,
    canon_path: g3.canonPath,
    next_action: g5.ok ? "cite_in_future_receipts" : "investigate_reuse_gate",
  };
}

async function canonizeFile(path, flags) {
  const abs = resolve(path);
  const text = await readFile(abs, "utf8");
  const id = flags.id || basename(abs, extname(abs)).replace(/[^a-z0-9_-]+/gi, "_").toLowerCase() + "_" + shortId(abs).slice(0, 6);
  return canonizeOne({ text, source: abs, id, flags });
}

async function canonizeDir(dir, flags) {
  const abs = resolve(dir);
  const entries = await readdir(abs);
  const results = [];
  for (const f of entries) {
    const p = join(abs, f);
    const s = await stat(p);
    if (!s.isFile()) continue;
    if (!/\.(txt|md|json|log)$/i.test(f)) continue;
    results.push(await canonizeFile(p, flags));
  }
  return results;
}

async function reuseSearch(query) {
  const indexPath = join(ROOT, "strata.index.jsonl");
  if (!await pathExists(indexPath)) return { ok: true, matches: [], evidence: { index_missing: true } };
  const raw = await readFile(indexPath, "utf8");
  const q = query.toLowerCase();
  const matches = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      const hay = `${row.title} ${row.summary} ${(row.tags || []).join(" ")} ${row.department} ${row.id}`.toLowerCase();
      if (hay.includes(q)) matches.push(row);
    } catch { /* skip */ }
  }
  return { ok: true, matches, evidence: { searched: indexPath, query } };
}

async function verifyAll() {
  const departments = DEPARTMENTS;
  const failures = [];
  let checked = 0;
  for (const d of departments) {
    const dir = join(ROOT, "canon", d);
    if (!existsSync(dir)) continue;
    const files = await readdir(dir);
    for (const f of files) {
      if (!f.endsWith(".canon.json")) continue;
      checked++;
      const p = join(dir, f);
      try {
        const row = JSON.parse(await readFile(p, "utf8"));
        const mdPath = row.artifact?.markdown_path;
        if (!mdPath || !await pathExists(mdPath)) {
          failures.push({ id: row.id, reason: "markdown_missing", path: mdPath });
          continue;
        }
        const md = await readFile(mdPath, "utf8");
        if (sha256(md) !== row.artifact.sha256) {
          failures.push({ id: row.id, reason: "markdown_hash_mismatch" });
        }
      } catch (e) {
        failures.push({ id: f, reason: "row_unreadable", detail: e.message });
      }
    }
  }
  return { ok: failures.length === 0, evidence: { checked, failures } };
}

// ----- main -----

async function main() {
  const args = parseArgs(argv);
  const flags = args.flags;

  // Extra tags surface internally on canonRow build.
  if (typeof flags.tags === "string") {
    flags._extraTags = flags.tags.split(",").map(s => s.trim()).filter(Boolean);
  }

  // Subcommands first.
  if (flags.reuse) {
    const q = typeof flags.reuse === "string" ? flags.reuse : args._.join(" ");
    if (!q) { console.error("reuse mode requires a query"); exit(2); }
    const out = await reuseSearch(q);
    process.stdout.write(JSON.stringify({ result: out.matches.length ? "matches" : "no_match", ...out }, null, 2) + "\n");
    return;
  }
  if (flags.verify) {
    const out = await verifyAll();
    process.stdout.write(JSON.stringify({ result: out.ok ? "integrity_ok" : "integrity_fail", ...out }, null, 2) + "\n");
    if (!out.ok) exit(1);
    return;
  }

  let result;
  if (flags.stdin) {
    const text = await readStdin();
    const id = flags.id || `stdin_${shortId("stdin")}`;
    result = await canonizeOne({ text, source: "stdin", id, flags });
  } else if (flags.dir) {
    const target = typeof flags.dir === "string" ? flags.dir : args._[0];
    if (!target) { console.error("--dir requires a path"); exit(2); }
    result = await canonizeDir(target, flags);
  } else {
    const target = args._[0];
    if (!target) {
      console.error("usage:");
      console.error("  node canonize.mjs <intake-file>");
      console.error("  node canonize.mjs --dir <dir>");
      console.error("  node canonize.mjs --stdin --id <id>");
      console.error("  node canonize.mjs --reuse <query>");
      console.error("  node canonize.mjs --verify");
      exit(2);
    }
    result = await canonizeFile(target, flags);
  }

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");

  const failed = Array.isArray(result)
    ? result.some(r => !r.ok)
    : !result.ok;
  if (failed) exit(1);
}

main().catch(err => {
  console.error(JSON.stringify({
    result: "fatal",
    error: err?.message || String(err),
    stack: err?.stack,
  }));
  exit(1);
});
