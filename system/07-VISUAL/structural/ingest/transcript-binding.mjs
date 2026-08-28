#!/usr/bin/env bun
// transcript-binding.mjs — Wave 3a of AE7-driven remediation.
//
// Cross-modal binding: yt-dlp downloads auto-generated subtitles (VTT)
// per video already in the concept corpus. We parse VTT → tokens →
// build a bidirectional map:
//
//   token → concepts_where_token_appears (with count / co-occurrence)
//   concept → token_lexicon (top-N tokens in videos that trained this concept)
//
// The result is `transcript-index.json` written next to the store.
// A downstream text-query lookup (Wave 3b) uses this index to find
// concept fingerprints for a text query, with ZERO LLM inference.
//
// Design principles:
//   - No LLM. Pure text n-gram + co-occurrence.
//   - Backend only.
//   - Deterministic.
//   - Resumable — skip videos that already have subtitle files.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ORANGE5 = path.resolve(__dir, "..", "..", "..");
const FIXTURES = path.resolve(ORANGE5, "07-VISUAL", "fixtures");
const CORPUS_ROOT = path.join(FIXTURES, "youtube-corpus");

const STOPWORDS = new Set([
  "the","a","an","and","or","but","if","then","when","of","in","on","at","to","for","with","by","from",
  "is","was","are","were","be","been","being","have","has","had","do","does","did","will","would","should",
  "could","can","may","might","must","shall","this","that","these","those","i","you","he","she","it","we",
  "they","me","him","her","us","them","my","your","his","its","our","their","what","which","who","how",
  "why","because","also","so","just","not","no","yes","up","down","out","over","under","again","very","get",
  "gets","got","one","two","three","first","see","see","look","looking","going","gonna","really","actually",
  "know","think","yeah","um","uh","okay","like","well","said","says","say","go","went","come","came","take","took",
]);

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32);
}

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
}

function ngrams(tokens, n) {
  const out = [];
  for (let i = 0; i + n <= tokens.length; i++) out.push(tokens.slice(i, i + n).join(" "));
  return out;
}

// Parse VTT subtitles → cleaned text
function vttToText(vttContent) {
  const lines = vttContent.split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip WEBVTT header, timestamps, cue settings, blank lines, styling
    if (!trimmed) continue;
    if (trimmed === "WEBVTT") continue;
    if (trimmed.startsWith("NOTE")) continue;
    if (/-->/.test(trimmed)) continue;
    if (/^\d+$/.test(trimmed)) continue;
    if (/^(align|position|line|size):/i.test(trimmed)) continue;
    // Strip HTML/VTT markup like <c>, <00:00:01.000>
    const cleaned = trimmed.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
    if (cleaned) kept.push(cleaned);
  }
  return kept.join(" ");
}

async function downloadSubtitlesForConceptDir(conceptDir) {
  const files = fs.readdirSync(conceptDir);
  const videos = files.filter(f => /\.(mp4|mkv|webm)$/i.test(f));
  const results = [];
  for (const vid of videos) {
    const id = vid.split(".")[0];
    const vttGlob = files.find(f => f.startsWith(id) && f.endsWith(".vtt"));
    if (vttGlob) {
      results.push({ id, vtt_path: path.join(conceptDir, vttGlob) });
      continue;
    }
    // Try to fetch subs for this id
    const args = [
      "https://www.youtube.com/watch?v=" + id,
      "--skip-download",
      "--write-auto-sub",
      "--sub-lang", "en",
      "--sub-format", "vtt",
      "-o", path.join(conceptDir, "%(id)s.%(ext)s"),
      "--quiet", "--no-warnings",
      "--socket-timeout", "30",
    ];
    const proc = spawnSync("yt-dlp", args, { encoding: "utf-8", timeout: 60_000 });
    // Look for the freshly-written .vtt
    const fresh = fs.readdirSync(conceptDir).find(f => f.startsWith(id) && f.endsWith(".vtt"));
    if (fresh) results.push({ id, vtt_path: path.join(conceptDir, fresh) });
  }
  return results;
}

// MAIN
const argv = process.argv.slice(2);
if (argv.length < 2) {
  console.error("usage: bun transcript-binding.mjs concepts.json transcript-index-out.json");
  process.exit(2);
}
const conceptsPath = argv[0];
const outPath = argv[1];
const { concepts } = JSON.parse(fs.readFileSync(conceptsPath, "utf-8"));

const conceptToTokens = {};   // label → Map<token, count>
const tokenToConcepts = {};   // token → Map<label, count>

for (const c of concepts) {
  const conceptDir = path.join(CORPUS_ROOT, slugify(c.label));
  if (!fs.existsSync(conceptDir)) { console.log("[SKIP] " + c.label + " — no corpus dir"); continue; }
  console.log("[BIND] " + c.label);
  const subFiles = await downloadSubtitlesForConceptDir(conceptDir);
  if (!subFiles.length) { console.log("  no subtitles available"); continue; }
  const bag = new Map();
  for (const sub of subFiles) {
    const vtt = fs.readFileSync(sub.vtt_path, "utf-8");
    const text = vttToText(vtt);
    const tokens = tokenize(text);
    const bigrams = ngrams(tokens, 2);
    for (const t of tokens) bag.set(t, (bag.get(t) || 0) + 1);
    for (const t of bigrams) bag.set(t, (bag.get(t) || 0) + 1);
  }
  console.log("  " + subFiles.length + " subs, " + bag.size + " unique tokens/bigrams");
  conceptToTokens[c.label] = Object.fromEntries([...bag.entries()].sort((a, b) => b[1] - a[1]).slice(0, 100));
  for (const [token, count] of bag.entries()) {
    if (!tokenToConcepts[token]) tokenToConcepts[token] = {};
    tokenToConcepts[token][c.label] = count;
  }
}

// Build normalized token→concept ranking (TF-IDF style)
const totalConcepts = Object.keys(conceptToTokens).length;
const tokenRankByConcept = {};   // concept → [tokens] ranked by (tf * idf)
for (const label of Object.keys(conceptToTokens)) {
  const tokens = conceptToTokens[label];
  const scored = [];
  for (const [token, tf] of Object.entries(tokens)) {
    const df = Object.keys(tokenToConcepts[token] || {}).length;
    const idf = Math.log(totalConcepts / df);
    scored.push({ token, tf, df, score: tf * idf });
  }
  scored.sort((a, b) => b.score - a.score);
  tokenRankByConcept[label] = scored.slice(0, 30);
}

const index = {
  built_at: new Date().toISOString(),
  concept_count: totalConcepts,
  concept_to_tokens: conceptToTokens,
  token_to_concepts: tokenToConcepts,
  token_rank_by_concept: tokenRankByConcept,
};

fs.writeFileSync(outPath, JSON.stringify(index, null, 2));
console.log("\nTranscript index written: " + outPath);
console.log("Concepts indexed: " + totalConcepts);
console.log("Unique tokens/bigrams total: " + Object.keys(tokenToConcepts).length);
