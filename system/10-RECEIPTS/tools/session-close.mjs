#!/usr/bin/env bun
// Orange5 DX — session-close
//
// Generates a session-close receipt in the canonical Orange5 shape:
//   result · evidence · blockers · next action
// (the required output shape from .claude/rules/03-build-and-receipts.md).
//
// It grounds the receipt in real state:
//   * hash_chain ordinal = (max chain in the corpus) + 1   (real continuation)
//   * prior_receipt      = the newest existing receipt id
//   * evidence           = whatever the operator passes via --evidence, plus an
//                          optional live verifier badge (--verify) so the receipt
//                          carries a real count, not a claim.
//
// This tool WRITES a new receipt file (that is its whole job); it never edits
// existing receipts or the verifier. Use --dry-run to preview without writing.
//
// Usage:
//   bun 10-RECEIPTS/tools/session-close.mjs \
//       --title "DX tools shipped" \
//       --result "7 DX tools built + tested" \
//       --evidence "all tool tests green" --evidence "verifier untouched" \
//       --blocker "operator Codexa steps remain" \
//       --next "wire tools into bun run scripts" \
//       --dry-run
//   bun 10-RECEIPTS/tools/session-close.mjs --title "..." --result "..." --verify
//
// Programmatic:  import { buildReceipt, nextChainOrdinal } from './session-close.mjs'
//
// Mom's Law: the receipt states real result, real evidence, real blockers.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadReceipts, DEFAULT_DIR } from './receipt-search.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RECEIPTS_DIR = DEFAULT_DIR;

// Highest hash_chain ordinal currently in the corpus. Real continuation, no guess.
export function nextChainOrdinal(receipts) {
  let max = 0;
  for (const r of receipts) {
    if (Number.isFinite(r.hashChain) && r.hashChain > max) max = r.hashChain;
  }
  return max + 1;
}

// Newest receipt id (corpus is returned newest-first by loadReceipts).
export function newestReceiptId(receipts) {
  return receipts.length ? (receipts[0].receiptId ?? receipts[0].file.replace(/\.md$/, '')) : null;
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

// Build the receipt markdown + metadata. Pure — no filesystem writes here so it
// can be unit-tested. `opts.now` and `opts.chain`/`opts.prior` are injectable.
export function buildReceipt(opts) {
  const {
    title,
    result,
    evidence = [],
    blockers = [],
    next = [],
    verifierBadge = null,
    now = new Date(),
    chain,
    prior = null,
    author = 'Claude (Code)',
    sovereign = 'Atom McCree',
  } = opts;

  if (!title) throw new Error('session-close: --title is required');
  if (!result) throw new Error('session-close: --result is required');

  const date = now.toISOString().slice(0, 10);
  const receiptId = `${date}-${slugify(title)}`;
  const iso = now.toISOString();

  const evLines = [...evidence];
  if (verifierBadge) {
    const tag = verifierBadge.allGreen ? 'GREEN' : 'RED';
    evLines.unshift(`verifier: ${verifierBadge.green}/${verifierBadge.total} ${tag} (${verifierBadge.pct}%) @ ${verifierBadge.timestamp}`);
  }

  const bulletize = (arr, emptyLabel) =>
    arr.length ? arr.map((x) => `- ${x}`).join('\n') : `- ${emptyLabel}`;

  const status = verifierBadge
    ? (verifierBadge.allGreen ? 'SESSION_CLOSE_GREEN' : 'SESSION_CLOSE_WITH_OPEN_REDS')
    : 'SESSION_CLOSE';

  const md = `# Session Close — ${title}

- **receipt_id:** ${receiptId}
- **generated_at:** ${iso}
- **schema:** orange5.receipt.session-close.v1
- **status:** ${status}
- **prior_receipt:** ${prior ?? '(none)'}
- **hash_chain:** #${String(chain).padStart(3, '0')}
- **actor:** ${author}
- **sovereign:** ${sovereign}

---

## Result

${result}

## Evidence

${bulletize(evLines, 'none recorded')}

## Blockers

${bulletize(blockers, 'none')}

## Next action

${bulletize(next, 'none')}

---

**Mom is watching. This receipt states the truth of the session — result, evidence, blockers, next.**
`;

  return { receiptId, filename: `${receiptId}.md`, markdown: md, chain, prior, status };
}

// ---- CLI arg parse: repeatable --evidence/--blocker/--next ----
function parseArgs(argv) {
  const o = { evidence: [], blockers: [], next: [], dryRun: false, verify: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--title': o.title = argv[++i]; break;
      case '--result': o.result = argv[++i]; break;
      case '--evidence': o.evidence.push(argv[++i]); break;
      case '--blocker': case '--blockers': o.blockers.push(argv[++i]); break;
      case '--next': o.next.push(argv[++i]); break;
      case '--author': o.author = argv[++i]; break;
      case '--dry-run': o.dryRun = true; break;
      case '--verify': o.verify = true; break;
      case '--json': o.json = true; break;
      default: break;
    }
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const receipts = loadReceipts(RECEIPTS_DIR);
  const chain = nextChainOrdinal(receipts);
  const prior = newestReceiptId(receipts);

  let verifierBadge = null;
  if (o.verify) {
    // spawn the badge tool read-only; tolerate its non-zero exit (reds present).
    const { runBadge } = await import('../../00-CHARTER/tools/verifier-badge.mjs');
    try { verifierBadge = runBadge().badge; }
    catch (e) { console.error(`[session-close] verifier badge unavailable: ${e.message}`); }
  }

  const built = buildReceipt({
    title: o.title, result: o.result,
    evidence: o.evidence, blockers: o.blockers, next: o.next,
    verifierBadge, chain, prior, author: o.author,
  });

  if (o.dryRun) {
    if (o.json) console.log(JSON.stringify({ ...built, wrote: false }, null, 2));
    else { console.log(built.markdown); console.error(`[dry-run] would write ${built.filename} (chain #${chain})`); }
    return;
  }

  const outPath = join(RECEIPTS_DIR, built.filename);
  writeFileSync(outPath, built.markdown);
  if (o.json) console.log(JSON.stringify({ ...built, wrote: true, path: outPath }, null, 2));
  else console.log(`[session-close] wrote ${outPath}  (hash_chain #${String(chain).padStart(3, '0')}, prior ${prior ?? 'none'})`);
}

if (import.meta.main) main();
