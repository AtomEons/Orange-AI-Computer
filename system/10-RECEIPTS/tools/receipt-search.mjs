#!/usr/bin/env bun
// Orange5 DX — receipt-search
//
// CLI-queryable search over the build-receipt corpus:
//   10-RECEIPTS/orange5-build/*.md
//
// Markdown is the source of truth (per the receipts doctrine — "Markdown
// remains truth"), so this reads the .md files directly. No SQLite, no deps.
//
// Two receipt shapes coexist and both are handled:
//   * structured front matter:  `- **receipt_id:** ...`, `- **status:** ...`,
//                               `- **hash_chain:** #NNN`, `- **generated_at:** ...`
//   * header style:             `**Date:** ...`, `**Type:** ...`
// Plus the universal fallback: the `YYYY-MM-DD` prefix of the filename is an
// authoritative date, and RED/GREEN are detected from the body.
//
// Usage:
//   bun 10-RECEIPTS/tools/receipt-search.mjs "what shipped this week"
//   bun 10-RECEIPTS/tools/receipt-search.mjs "RED runs"
//   bun 10-RECEIPTS/tools/receipt-search.mjs --week
//   bun 10-RECEIPTS/tools/receipt-search.mjs --since 2026-06-25 --status red
//   bun 10-RECEIPTS/tools/receipt-search.mjs --text hermes --json
//   bun 10-RECEIPTS/tools/receipt-search.mjs --status green --limit 10
//
// Programmatic:  import { loadReceipts, searchReceipts, parseQuery } from './receipt-search.mjs'
//
// Mom's Law: honest matches, real counts, no fabricated hits.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_DIR = join(ROOT, '10-RECEIPTS', 'orange5-build');

const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/;

// ---- parsing a single receipt file into a normalized record ----
export function parseReceipt(filename, body) {
  const m = DATE_PREFIX.exec(filename);
  const fileDate = m ? m[1] : null;
  const slug = m ? m[2] : filename.replace(/\.md$/, '');

  const field = (label) => {
    // matches "- **label:** value" or "**label:** value"
    const re = new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`, 'i');
    const mm = re.exec(body);
    return mm ? mm[1].trim() : null;
  };

  const receiptId = field('receipt_id') ?? slug;
  const status = field('status');
  const generatedAt = field('generated_at');
  const hashField = field('hash_chain');
  const hashChain = hashField ? (/#(\d+)/.exec(hashField)?.[1] ?? null) : null;
  const priorRaw = field('prior_receipt');

  // title = first markdown H1, else slug
  const h1 = /^#\s+(.+)$/m.exec(body);
  const title = h1 ? h1[1].trim() : slug;

  // Outcome classification is honest and status-anchored: a receipt's OWN
  // status field is the authoritative signal it carries about itself. Prose
  // that merely mentions reds-since-fixed does NOT make a receipt red — its
  // status is green. We only fall back to the title/type when status is absent.
  const { red, green } = classifyOutcome({ status, title, slug, body });

  return {
    file: filename,
    date: generatedAtDate(generatedAt) ?? fileDate,
    fileDate,
    receiptId,
    title,
    status,
    generatedAt,
    hashChain: hashChain ? Number(hashChain) : null,
    priorReceipt: priorRaw,
    green,
    red,
    bytes: body.length,
  };
}

// Honest outcome rules (in priority order):
//  1. If a status field exists, it decides:
//       RED  when it contains RED / FAIL / BLOCKED / INCIDENT (and not "0 red")
//       GREEN when it contains GREEN / PASS / CLOSED / LIVE / DONE
//  2. No status field -> use the slug/title: postmortem/incident/red-team-*
//     naming marks a red-adjacent record; otherwise treat as green-by-default
//     only if the body actually asserts GREEN/PASS, else neutral (neither).
export function classifyOutcome({ status, title = '', slug = '', body = '' }) {
  if (status) {
    // Normalize separators to spaces so `\b` works across underscores/digits:
    // "BUILD_RED_3_OF_10" -> "BUILD RED 3 OF 10". Status tokens in this corpus
    // are frequently SCREAMING_SNAKE, where `_RED_` has no regex word boundary.
    const s = status.toUpperCase().replace(/[^A-Z0-9]+/g, ' ');
    const declaresRed = /\b(RED|FAIL|FAILED|BLOCKED|INCIDENT|BROKEN)\b/.test(s) &&
                        !/\b(0|NO|ZERO)\s+REDS?\b/.test(s);
    if (declaresRed) return { red: true, green: false };
    const declaresGreen = /\b(GREEN|PASS|PASSED|CLOSED|LIVE|DONE|COMPLETE|GO|LANDED|STAGED|LOCKED|BUILT|ACTIVE)\b/.test(s);
    return { red: false, green: declaresGreen };
  }
  // no status field — fall back to naming, conservatively.
  const name = `${slug} ${title}`.toLowerCase();
  const namedRed = /\b(postmortem|incident|red-team|red team|regression|outage|failure)\b/.test(name);
  if (namedRed) return { red: true, green: false };
  const bodyGreen = /\b(GREEN|all pass|passed \/ 0 failed|0 failed)\b/i.test(body);
  return { red: false, green: bodyGreen };
}

function generatedAtDate(gen) {
  if (!gen) return null;
  const m = /(\d{4}-\d{2}-\d{2})/.exec(gen);
  return m ? m[1] : null;
}

// ---- load the whole corpus ----
export function loadReceipts(dir = DEFAULT_DIR) {
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.md'));
  } catch (e) {
    throw new Error(`cannot read receipt dir ${dir}: ${e.message}`);
  }
  const out = [];
  for (const name of names) {
    const full = join(dir, name);
    try {
      if (!statSync(full).isFile()) continue;
      const body = readFileSync(full, 'utf8');
      out.push(parseReceipt(name, body));
    } catch { /* skip unreadable */ }
  }
  // newest first by date then filename
  out.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || b.file.localeCompare(a.file));
  return out;
}

// ---- query language ----
// Natural-language shortcuts fold into a structured filter object.
export function parseQuery(argv) {
  const q = {
    since: null,        // YYYY-MM-DD inclusive
    until: null,        // YYYY-MM-DD inclusive
    status: null,       // 'red' | 'green' | null
    text: null,         // substring match over title+status+receiptId+slug
    limit: Infinity,
    json: false,
    dir: DEFAULT_DIR,
  };
  const free = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') q.json = true;
    else if (a === '--week') { q.since = daysAgoISO(7); }
    else if (a === '--since') q.since = argv[++i];
    else if (a === '--until') q.until = argv[++i];
    else if (a === '--status') q.status = String(argv[++i] ?? '').toLowerCase();
    else if (a === '--text') q.text = argv[++i];
    else if (a === '--limit') q.limit = Number(argv[++i]);
    else if (a === '--dir') q.dir = argv[++i];
    else free.push(a);
  }
  // fold the free-text natural-language query
  const phrase = free.join(' ').trim();
  if (phrase) {
    const lower = phrase.toLowerCase();
    if (/\b(this week|shipped this week|past week|last week)\b/.test(lower)) {
      q.since = q.since ?? daysAgoISO(7);
    }
    if (/\bred\b/.test(lower) && !/\bno red/.test(lower)) q.status = q.status ?? 'red';
    else if (/\bgreen\b/.test(lower)) q.status = q.status ?? 'green';
    // any remaining meaningful words become a text filter, unless the phrase
    // was purely a date/status shortcut we already consumed.
    const residual = lower
      .replace(/\b(what|shipped|this|week|past|last|red|runs?|green|show|me|the|all)\b/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    if (residual && !q.text) q.text = residual.split(/\s+/)[0];
  }
  return q;
}

export function searchReceipts(receipts, q) {
  let r = receipts;
  if (q.since) r = r.filter((x) => (x.date ?? x.fileDate ?? '') >= q.since);
  if (q.until) r = r.filter((x) => (x.date ?? x.fileDate ?? '') <= q.until);
  if (q.status === 'red') r = r.filter((x) => x.red);
  else if (q.status === 'green') r = r.filter((x) => x.green && !x.red);
  if (q.text) {
    const t = q.text.toLowerCase();
    r = r.filter((x) =>
      (x.title ?? '').toLowerCase().includes(t) ||
      (x.receiptId ?? '').toLowerCase().includes(t) ||
      (x.status ?? '').toLowerCase().includes(t) ||
      (x.file ?? '').toLowerCase().includes(t));
  }
  if (Number.isFinite(q.limit)) r = r.slice(0, Math.max(0, q.limit));
  return r;
}

function daysAgoISO(n, now = new Date()) {
  const d = new Date(now.getTime() - n * 86_400_000);
  return d.toISOString().slice(0, 10);
}

// ---- CLI ----
function main() {
  const q = parseQuery(process.argv.slice(2));
  const all = loadReceipts(q.dir);
  const hits = searchReceipts(all, q);
  if (q.json) {
    console.log(JSON.stringify({
      query: { since: q.since, until: q.until, status: q.status, text: q.text },
      corpusSize: all.length,
      matches: hits.length,
      results: hits,
    }, null, 2));
    return;
  }
  console.log(`receipt-search — ${hits.length} match(es) of ${all.length} receipts` +
    (q.since ? `  since=${q.since}` : '') + (q.status ? `  status=${q.status}` : '') +
    (q.text ? `  text="${q.text}"` : ''));
  for (const h of hits) {
    const flag = h.red ? 'RED  ' : (h.green ? 'GREEN' : '  -  ');
    const chain = h.hashChain != null ? `#${h.hashChain}` : '   ';
    console.log(`  ${h.date ?? '----------'}  [${flag}] ${chain.padStart(5)}  ${h.title}`);
  }
}

if (import.meta.main) main();
