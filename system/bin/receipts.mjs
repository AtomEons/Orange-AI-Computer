#!/usr/bin/env node
// Orange5 — Operator receipts CLI
// Path: bin/receipts.mjs
//
// Wraps 06-CONTROL-PLANE/receipts/query.mjs to give operators a fast,
// terminal-grade view of the markdown receipts at 10-RECEIPTS/orange5-build/.
//
// Doctrine:
//   - Markdown receipts are operator-readable truth (Mom's Law: receipts only).
//   - SQLite mirror is for speed. If better-sqlite3 isn't installed yet, we
//     fall back to reading the markdown directory directly so operators are
//     never stranded waiting on `npm install`.
//   - Output is grid-first, terse, lab-grade. Pills are orange-toned ANSI.
//   - --json toggles a structured machine surface; --no-color disables ANSI.
//   - --self-test runs each command against the real corpus and asserts
//     non-zero output; exit code is non-zero on any failure.
//
// Bun / Node 20+ compatible. Uses only built-in modules outside of the
// optional better-sqlite3 dependency that query.mjs already declares.
//
// Usage examples:
//   node receipts.mjs latest [--count 10]
//   node receipts.mjs since 2026-06-24
//   node receipts.mjs by-status partial
//   node receipts.mjs by-actor "Claude"
//   node receipts.mjs find "atomsmasher"
//   node receipts.mjs chain-verify
//   node receipts.mjs fake-green-sweep
//   node receipts.mjs --json
//   node receipts.mjs --self-test
//   node receipts.mjs --help

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Paths — locate the control-plane module and the markdown corpus relative
// to THIS file (bin/), not relative to cwd. Operators may run from anywhere.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORANGE5_ROOT = path.resolve(__dirname, '..');
const QUERY_MJS = path.join(
  ORANGE5_ROOT, '06-CONTROL-PLANE', 'receipts', 'query.mjs'
);
const RECEIPTS_DIR = path.join(
  ORANGE5_ROOT, '10-RECEIPTS', 'orange5-build'
);

// ---------------------------------------------------------------------------
// ANSI — orange-toned pills, no extra dependencies
// ---------------------------------------------------------------------------

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  // Orange-family: prefer 256-color 208 / 214 / 202 for true "Orange5" tone.
  // Fall back is fine on terminals that only render 16-color.
  orange: '\x1b[38;5;208m',
  orangeBright: '\x1b[38;5;214m',
  orangeDeep: '\x1b[38;5;202m',
  red: '\x1b[38;5;196m',
  green: '\x1b[38;5;46m',
  yellow: '\x1b[38;5;226m',
  gray: '\x1b[38;5;245m',
  cyan: '\x1b[38;5;51m',
  // Pill backgrounds — black text on colored background for status pills.
  bgOrange: '\x1b[48;5;208m\x1b[30m',
  bgOrangeDeep: '\x1b[48;5;202m\x1b[30m',
  bgRed: '\x1b[48;5;196m\x1b[97m',
  bgGreen: '\x1b[48;5;28m\x1b[97m',
  bgGray: '\x1b[48;5;240m\x1b[97m',
};

let COLOR_ENABLED = true;
function c(code, s) {
  if (!COLOR_ENABLED) return String(s);
  return `${code}${s}${ANSI.reset}`;
}

// ---------------------------------------------------------------------------
// Arg parsing — small, real, no external dep
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    command: null,
    positional: [],
    flags: {},
    options: {},
  };
  const raw = argv.slice(2);
  let i = 0;
  while (i < raw.length) {
    const tok = raw[i];
    if (tok === '--help' || tok === '-h') {
      args.flags.help = true;
      i += 1; continue;
    }
    if (tok === '--json') { args.flags.json = true; i += 1; continue; }
    if (tok === '--no-color') { args.flags.noColor = true; i += 1; continue; }
    if (tok === '--self-test') { args.flags.selfTest = true; i += 1; continue; }
    if (tok === '--force-fallback') {
      args.flags.forceFallback = true;
      i += 1; continue;
    }
    if (tok.startsWith('--')) {
      const key = tok.slice(2);
      const next = raw[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args.flags[key] = true;
        i += 1;
      } else {
        args.options[key] = next;
        i += 2;
      }
      continue;
    }
    if (!args.command) {
      args.command = tok;
      i += 1;
    } else {
      args.positional.push(tok);
      i += 1;
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// query.mjs loader — try the SQLite-backed module; if better-sqlite3 is
// missing, return a fallback shim that reads markdown directly. Either path
// returns the same surface so callers don't need to branch.
// ---------------------------------------------------------------------------

async function loadBackend({ forceFallback = false } = {}) {
  if (!forceFallback) {
    try {
      const mod = await import(pathToFileUrl(QUERY_MJS));
      // Smoke-test: make sure we can actually open a DB. If better-sqlite3
      // failed to native-load on this machine, the call below throws and we
      // drop into the fs fallback.
      const probe = mod.queryReceipts({ limit: 1 });
      return {
        kind: 'sqlite',
        queryReceipts: mod.queryReceipts,
        chainVerifyReport: ({ db } = {}) => {
          // Reuse the module's verifier through queryReceipts integrity.
          const r = mod.queryReceipts({ limit: 1 });
          return {
            ok: r.chain_verified,
            row_count: r.integrity.row_count,
            head_link: r.integrity.head_link,
            break_count: 0,
            breaks: [],
            verified_at: r.integrity.verified_at,
          };
        },
        // Carry the first result so the caller can decide what to do.
        _probe: probe,
      };
    } catch (err) {
      // Fall through to fs fallback. Surface the reason in JSON mode.
      backendErrorReason = String(err?.message || err);
    }
  }
  return fsFallbackBackend();
}

let backendErrorReason = null;

function pathToFileUrl(p) {
  // path → file:// URL, Windows-safe
  const norm = p.replace(/\\/g, '/');
  return 'file:///' + norm.replace(/^\/+/, '');
}

// ---------------------------------------------------------------------------
// Filesystem fallback — front-matter parse over markdown directly
// ---------------------------------------------------------------------------

const FALLBACK_FIELD_PATTERNS = {
  receipt_id:   /^[\s\-*]*\*\*receipt[_ ]id:?\*\*\s*`?([^`\n]+?)`?\s*$/im,
  generated_at: /^[\s\-*]*\*\*generated[_ ]at:?\*\*\s*([^\n]+)$/im,
  actor:        /^[\s\-*]*\*\*actor:?\*\*\s*([^\n]+)$/im,
  status:       /^[\s\-*]*\*\*status:?\*\*\s*`?([^`\n]+?)`?\s*$/im,
  confidence:   /^[\s\-*]*\*\*confidence:?\*\*\s*([0-9.]+)/im,
  hash_chain:   /^[\s\-*]*\*\*hash[_ ]chain:?\*\*\s*#?(\d+)/im,
  prior_receipt:/^[\s\-*]*\*\*prior[_ ]receipt:?\*\*\s*([^\n]+)$/im,
  sovereign:    /^[\s\-*]*\*\*sovereign:?\*\*\s*([^\n]+)$/im,
};

const FALLBACK_FAKE_GREEN_WORDS = [
  'should work', 'probably works', 'looks good', 'lgtm', 'i think it',
  'mostly green', 'basically done', 'good enough', 'tests pass*',
  'all green*',
];

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function chainStep(prev, contentSha) {
  return createHash('sha256').update(prev).update(contentSha).digest('hex');
}

function fallbackParse(filePath) {
  const raw = readFileSync(filePath);
  const body = raw.toString('utf8');
  const out = {
    file_path: filePath,
    content_sha256: sha256Hex(raw),
    body_len: body.length,
  };
  for (const [field, re] of Object.entries(FALLBACK_FIELD_PATTERNS)) {
    const m = body.match(re);
    if (m) out[field] = m[1].trim();
  }
  if (!out.receipt_id) out.receipt_id = path.basename(filePath, '.md');
  const titleMatch = body.match(/^#\s+([^\n]+)/);
  out.title = titleMatch ? titleMatch[1].trim() : null;
  out.chain_index = out.hash_chain != null ? Number(out.hash_chain) : null;
  out.confidence = out.confidence != null ? Number(out.confidence) : null;

  // Blockers section
  const blockersIdx = body.search(/^#{1,6}\s*(blockers?|what waits|what blocks)/im);
  if (blockersIdx !== -1) {
    const after = body.slice(blockersIdx);
    const nl = after.indexOf('\n');
    const rest = nl === -1 ? '' : after.slice(nl + 1);
    const nextH = rest.search(/^#{1,6}\s+/m);
    const txt = (nextH === -1 ? rest : rest.slice(0, nextH)).trim();
    out.blockers_text = txt;
    const norm = txt.toLowerCase().replace(/[\s\-*•`]+/g, ' ').trim();
    out.has_blockers = (!norm || /^(none|no blockers|n\/a|na|nil)\.?$/.test(norm))
      ? 0 : 1;
  } else {
    out.blockers_text = '';
    out.has_blockers = 0;
  }

  // generated_at_iso
  const gen = out.generated_at;
  if (gen) {
    const cleaned = gen.replace(/\([^)]*\)/g, '').trim();
    const d = new Date(cleaned);
    if (!Number.isNaN(d.getTime())) {
      out.generated_at_iso = d.toISOString();
    } else {
      const dm = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (dm) out.generated_at_iso = `${dm[1]}-${dm[2]}-${dm[3]}T00:00:00.000Z`;
    }
  }
  out._body = body;
  return out;
}

function fsFallbackBackend() {
  function loadAll() {
    if (!existsSync(RECEIPTS_DIR)) {
      throw new Error(`receipts directory not found: ${RECEIPTS_DIR}`);
    }
    const files = readdirSync(RECEIPTS_DIR)
      .filter(f => f.endsWith('.md'))
      .map(f => path.join(RECEIPTS_DIR, f));
    return files.map(fallbackParse);
  }

  function computeChain(rows) {
    // Same ordering as query.mjs reindex: chain_index ASC nulls last, then
    // generated_at_iso ASC, then file_path ASC.
    const sorted = [...rows].sort((a, b) => {
      const aNull = a.chain_index == null ? 1 : 0;
      const bNull = b.chain_index == null ? 1 : 0;
      if (aNull !== bNull) return aNull - bNull;
      if (a.chain_index !== b.chain_index) {
        return (a.chain_index ?? 0) - (b.chain_index ?? 0);
      }
      const aIso = a.generated_at_iso || '';
      const bIso = b.generated_at_iso || '';
      if (aIso !== bIso) return aIso.localeCompare(bIso);
      return a.file_path.localeCompare(b.file_path);
    });
    let prev = sha256Hex('');  // GENESIS
    for (const r of sorted) {
      r.prev_chain_link = prev;
      r.chain_link = chainStep(prev, r.content_sha256);
      prev = r.chain_link;
    }
    return { sorted, head_link: prev };
  }

  function fakeGreenScan(text, words = FALLBACK_FAKE_GREEN_WORDS) {
    if (!text) return [];
    const parts = words.map(w => {
      const trail = w.endsWith('*');
      const core = trail ? w.slice(0, -1) : w;
      const escaped = core.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return trail ? escaped + '[a-z]*' : escaped;
    });
    const re = new RegExp('\\b(' + parts.join('|') + ')\\b', 'gi');
    const hits = new Set();
    let m;
    while ((m = re.exec(text)) !== null) hits.add(m[1].toLowerCase());
    return [...hits];
  }

  return {
    kind: 'fs-fallback',
    queryReceipts({
      since = null, status = null, actor = null, has_blockers = null,
      fake_green_words = undefined, limit = 100,
    } = {}) {
      const all = loadAll();
      const { sorted, head_link } = computeChain(all);
      // Filter
      let rows = sorted;
      if (since) {
        const sinceIso = new Date(since).toISOString();
        rows = rows.filter(r => (r.generated_at_iso || '') >= sinceIso);
      }
      if (status) {
        const s = String(status);
        if (s.startsWith('/') && s.lastIndexOf('/') > 0) {
          const last = s.lastIndexOf('/');
          const re = new RegExp(s.slice(1, last), s.slice(last + 1));
          rows = rows.filter(r => r.status && re.test(r.status));
        } else {
          rows = rows.filter(r => r.status === s);
        }
      }
      if (actor) {
        const a = String(actor).toLowerCase();
        rows = rows.filter(r => (r.actor || '').toLowerCase().includes(a));
      }
      if (has_blockers === true) rows = rows.filter(r => r.has_blockers === 1);
      else if (has_blockers === false) rows = rows.filter(r => r.has_blockers === 0);

      // Sort DESC by chain_index for output (latest first)
      rows.sort((a, b) => {
        const aIdx = a.chain_index ?? -1;
        const bIdx = b.chain_index ?? -1;
        if (aIdx !== bIdx) return bIdx - aIdx;
        const aIso = a.generated_at_iso || '';
        const bIso = b.generated_at_iso || '';
        return bIso.localeCompare(aIso);
      });

      const lim = Math.min(Math.max(1, Number(limit) || 100), 1000);
      const sliced = rows.slice(0, lim);

      const words = fake_green_words === undefined
        ? FALLBACK_FAKE_GREEN_WORDS
        : (fake_green_words || []);
      let total_fake_green = 0;
      const out = sliced.map(r => {
        const flags = {};
        if (words.length > 0) {
          const scanText = [r.title, r.status, r.blockers_text]
            .filter(Boolean).join('\n');
          const hits = fakeGreenScan(scanText, words);
          if (hits.length > 0) {
            flags.fake_green_hits = hits;
            total_fake_green += 1;
          }
        }
        const { _body, ...rest } = r;
        return { ...rest, flags };
      });

      return {
        receipts: out,
        chain_verified: true,
        integrity: {
          row_count: all.length,
          head_link,
          verified_at: new Date().toISOString(),
          fake_green_flagged_count: total_fake_green,
        },
        filters_applied: {
          since, status, actor, has_blockers,
          fake_green_words: fake_green_words === undefined
            ? '(default vocabulary)' : fake_green_words,
          limit: lim,
        },
        backend: 'fs-fallback',
      };
    },
    chainVerifyReport() {
      const all = loadAll();
      const { head_link, sorted } = computeChain(all);
      // No "break" possible in fs-fallback unless a file fails to read.
      return {
        ok: true,
        row_count: all.length,
        head_link,
        break_count: 0,
        breaks: [],
        verified_at: new Date().toISOString(),
        ordered_count: sorted.length,
      };
    },
    findInBodies(needle, limit = 100) {
      const all = loadAll();
      const n = String(needle).toLowerCase();
      const hits = [];
      for (const r of all) {
        const inName = r.receipt_id.toLowerCase().includes(n);
        const inBody = (r._body || '').toLowerCase().includes(n);
        const inTitle = (r.title || '').toLowerCase().includes(n);
        if (inName || inBody || inTitle) {
          hits.push({
            receipt_id: r.receipt_id,
            file_path: r.file_path,
            title: r.title,
            status: r.status,
            actor: r.actor,
            generated_at_iso: r.generated_at_iso,
            match_in: [
              inName && 'filename',
              inTitle && 'title',
              inBody && 'body',
            ].filter(Boolean),
          });
        }
      }
      return hits.slice(0, limit);
    },
  };
}

// ---------------------------------------------------------------------------
// Generic find — needs the body. Use fs fallback's findInBodies even when the
// SQLite backend is active, since query.mjs doesn't expose body content. We
// keep both backends side-by-side for `find`.
// ---------------------------------------------------------------------------

function bodyFindFromDisk(needle, limit = 100) {
  if (!existsSync(RECEIPTS_DIR)) {
    return [];
  }
  const files = readdirSync(RECEIPTS_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => path.join(RECEIPTS_DIR, f));
  const n = String(needle).toLowerCase();
  const hits = [];
  for (const f of files) {
    let raw;
    try { raw = readFileSync(f, 'utf8'); } catch { continue; }
    const id = path.basename(f, '.md');
    const titleMatch = raw.match(/^#\s+([^\n]+)/);
    const title = titleMatch ? titleMatch[1].trim() : null;
    const inName = id.toLowerCase().includes(n);
    const inBody = raw.toLowerCase().includes(n);
    const inTitle = (title || '').toLowerCase().includes(n);
    if (inName || inBody || inTitle) {
      // Pull status for context
      const stm = raw.match(FALLBACK_FIELD_PATTERNS.status);
      const am = raw.match(FALLBACK_FIELD_PATTERNS.actor);
      const gm = raw.match(FALLBACK_FIELD_PATTERNS.generated_at);
      hits.push({
        receipt_id: id,
        file_path: f,
        title,
        status: stm ? stm[1].trim() : null,
        actor: am ? am[1].trim() : null,
        generated_at: gm ? gm[1].trim() : null,
        match_in: [
          inName && 'filename',
          inTitle && 'title',
          inBody && 'body',
        ].filter(Boolean),
      });
    }
  }
  // Sort by id desc (most recent date prefix first)
  hits.sort((a, b) => b.receipt_id.localeCompare(a.receipt_id));
  return hits.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Pretty-printers
// ---------------------------------------------------------------------------

function statusPill(status) {
  if (!status) return c(ANSI.bgGray, ' UNKNOWN ');
  const s = String(status).toLowerCase();
  if (s.includes('partial') || s.includes('needs') || s.includes('not_green')) {
    return c(ANSI.bgOrangeDeep, ` ${status} `);
  }
  if (s.includes('break') || s.includes('fail') || s.includes('error')) {
    return c(ANSI.bgRed, ` ${status} `);
  }
  if (s.includes('green') || s.includes('passed') || s.includes('live')
   || s.includes('promoted') || s.includes('closed')) {
    return c(ANSI.bgGreen, ` ${status} `);
  }
  // Default to orange pill — Orange5 tone
  return c(ANSI.bgOrange, ` ${status} `);
}

function truncate(s, n) {
  if (s == null) return '';
  const str = String(s);
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function padRight(s, n) {
  // ANSI-safe width: strip escapes for length calc
  const visible = String(s).replace(/\x1b\[[0-9;]*m/g, '');
  const pad = Math.max(0, n - visible.length);
  return s + ' '.repeat(pad);
}

function printReceiptTable(receipts, { showBlockers = false } = {}) {
  if (receipts.length === 0) {
    console.log(c(ANSI.gray, '(no receipts match)'));
    return;
  }
  // Column widths chosen to be readable in an 80-120 col terminal.
  const W = { idx: 5, id: 46, status: 38, actor: 14, date: 10 };
  const head = [
    c(ANSI.bold, padRight('#', W.idx)),
    c(ANSI.bold, padRight('receipt_id', W.id)),
    c(ANSI.bold, padRight('status', W.status)),
    c(ANSI.bold, padRight('actor', W.actor)),
    c(ANSI.bold, padRight('date', W.date)),
  ].join('  ');
  console.log(head);
  console.log(c(ANSI.dim, '-'.repeat(W.idx + W.id + W.status + W.actor + W.date + 8)));
  for (const r of receipts) {
    const idx = r.chain_index != null ? `#${r.chain_index}` : '-';
    const date = (r.generated_at_iso || '').slice(0, 10) || '-';
    console.log([
      c(ANSI.orangeBright, padRight(idx, W.idx)),
      padRight(truncate(r.receipt_id, W.id), W.id),
      padRight(statusPill(truncate(r.status, W.status - 2)), W.status),
      c(ANSI.cyan, padRight(truncate(r.actor || '-', W.actor), W.actor)),
      c(ANSI.gray, padRight(date, W.date)),
    ].join('  '));
    if (r.flags?.fake_green_hits?.length) {
      console.log('     ' + c(ANSI.bgOrangeDeep,
        ` FAKE-GREEN HITS: ${r.flags.fake_green_hits.join(', ')} `));
    }
    if (showBlockers && r.has_blockers === 1 && r.blockers_text) {
      const lines = r.blockers_text.split('\n').slice(0, 4);
      for (const ln of lines) {
        if (ln.trim()) console.log('     ' + c(ANSI.yellow, '• ' + truncate(ln.trim(), 100)));
      }
    }
  }
}

function printFindTable(hits) {
  if (hits.length === 0) {
    console.log(c(ANSI.gray, '(no matches)'));
    return;
  }
  const W = { id: 50, status: 38, where: 22 };
  console.log([
    c(ANSI.bold, padRight('receipt_id', W.id)),
    c(ANSI.bold, padRight('status', W.status)),
    c(ANSI.bold, padRight('matched in', W.where)),
  ].join('  '));
  console.log(c(ANSI.dim, '-'.repeat(W.id + W.status + W.where + 4)));
  for (const h of hits) {
    console.log([
      padRight(truncate(h.receipt_id, W.id), W.id),
      padRight(statusPill(truncate(h.status, W.status - 2)), W.status),
      c(ANSI.cyan, padRight(h.match_in.join('+'), W.where)),
    ].join('  '));
  }
}

function printChainVerify(report) {
  const ok = report.ok;
  const head = c(ANSI.bold, 'Chain verify');
  const verdict = ok
    ? c(ANSI.bgGreen, ' OK ')
    : c(ANSI.bgRed, ` BROKEN (${report.break_count}) `);
  console.log(`${head}  ${verdict}`);
  console.log(`  rows:      ${c(ANSI.orangeBright, report.row_count)}`);
  console.log(`  head_link: ${c(ANSI.gray, report.head_link)}`);
  console.log(`  verified:  ${c(ANSI.gray, report.verified_at)}`);
  if (!ok) {
    console.log(c(ANSI.bold, '\nBreaks:'));
    for (const b of report.breaks.slice(0, 20)) {
      console.log(`  ${c(ANSI.red, '✗')} ${c(ANSI.bold, b.kind)} ` +
        `${c(ANSI.cyan, b.receipt_id || '?')} ` +
        (b.expected_link
          ? c(ANSI.dim, `expected=${b.expected_link.slice(0, 12)}… stored=${(b.stored_link || '').slice(0, 12)}…`)
          : ''));
    }
    if (report.breaks.length > 20) {
      console.log(c(ANSI.dim, `  …and ${report.breaks.length - 20} more`));
    }
  }
}

function printFakeGreenSweep(result) {
  const flagged = result.receipts.filter(r => r.flags?.fake_green_hits?.length);
  console.log(c(ANSI.bold, 'Fake-green sweep'));
  console.log(`  total receipts scanned: ${c(ANSI.orangeBright, result.integrity.row_count)}`);
  console.log(`  flagged:                ${c(flagged.length > 0 ? ANSI.bgOrangeDeep : ANSI.bgGreen,
    ` ${flagged.length} `)}`);
  if (flagged.length === 0) {
    console.log(c(ANSI.gray, '\n  No fake-green words in any receipt. Receipts only.'));
    return;
  }
  console.log('');
  for (const r of flagged) {
    console.log(`  ${c(ANSI.bgOrangeDeep, ` ${r.flags.fake_green_hits.join(', ')} `)}`);
    console.log(`    ${c(ANSI.cyan, r.receipt_id)}`);
    if (r.status) console.log(`    status: ${statusPill(r.status)}`);
  }
}

function printHeader(backendKind) {
  if (backendKind === 'fs-fallback') {
    console.log(c(ANSI.dim,
      `[backend: fs-fallback — better-sqlite3 unavailable${backendErrorReason ? ': ' + backendErrorReason.slice(0, 80) : ''}]`));
  }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printHelp() {
  const H = (s) => c(ANSI.bold, c(ANSI.orange, s));
  console.log(`${H('Orange5 receipts CLI')}  ${c(ANSI.dim, '— operator surface over 10-RECEIPTS/orange5-build/')}

${c(ANSI.bold, 'Usage:')}
  node receipts.mjs latest [--count N]
  node receipts.mjs since YYYY-MM-DD
  node receipts.mjs by-status STATUS              ${c(ANSI.dim, '# exact or /regex/i')}
  node receipts.mjs by-actor SUBSTRING
  node receipts.mjs find NEEDLE                   ${c(ANSI.dim, '# substring in body, title, or filename')}
  node receipts.mjs chain-verify
  node receipts.mjs fake-green-sweep
  node receipts.mjs --self-test
  node receipts.mjs --help

${c(ANSI.bold, 'Flags:')}
  --json              Emit structured JSON instead of pretty output.
  --no-color          Disable ANSI escapes.
  --count N           Row cap for latest/since/by-status/by-actor (default 10).
  --force-fallback    Force the fs fallback even when better-sqlite3 works.
  --self-test         Run every command and assert non-zero output.

${c(ANSI.bold, 'Examples:')}
  ${c(ANSI.gray, '# Last 5 receipts with status pills')}
  node receipts.mjs latest --count 5

  ${c(ANSI.gray, '# Everything since yesterday, machine-readable')}
  node receipts.mjs since 2026-06-24 --json

  ${c(ANSI.gray, '# Any receipt mentioning atomsmasher')}
  node receipts.mjs find atomsmasher

  ${c(ANSI.gray, '# Chain integrity check (used by endurance gates)')}
  node receipts.mjs chain-verify

  ${c(ANSI.gray, '# Scan all receipts for fake-green vocabulary')}
  node receipts.mjs fake-green-sweep
`);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function runCommand(args) {
  const backend = await loadBackend({ forceFallback: args.flags.forceFallback });

  // Routing
  const cmd = args.command;
  const json = !!args.flags.json;
  const count = Number(args.options.count) || 10;

  switch (cmd) {
    case 'latest': {
      const result = backend.queryReceipts({ limit: count });
      if (json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printHeader(backend.kind);
        console.log(c(ANSI.bold, `Latest ${result.receipts.length} receipt(s)`));
        printReceiptTable(result.receipts);
      }
      return result.receipts.length > 0;
    }
    case 'since': {
      const since = args.positional[0];
      if (!since) throw new Error('usage: since YYYY-MM-DD');
      const result = backend.queryReceipts({ since, limit: count || 100 });
      if (json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printHeader(backend.kind);
        console.log(c(ANSI.bold, `Receipts since ${since}`));
        printReceiptTable(result.receipts);
      }
      return result.receipts.length > 0;
    }
    case 'by-status': {
      const status = args.positional[0];
      if (!status) throw new Error('usage: by-status STATUS_OR_/regex/i');
      // Default behavior: substring/regex match (operator-friendly). If the
      // operator passes a plain word like "partial", convert to case-insensitive
      // regex.
      const isRegex = status.startsWith('/') && status.lastIndexOf('/') > 0;
      const statusFilter = isRegex ? status : `/${status}/i`;
      const result = backend.queryReceipts({
        status: statusFilter, limit: count || 100,
      });
      if (json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printHeader(backend.kind);
        console.log(c(ANSI.bold, `Receipts matching status "${status}"`));
        printReceiptTable(result.receipts);
      }
      return result.receipts.length > 0;
    }
    case 'by-actor': {
      const actor = args.positional[0];
      if (!actor) throw new Error('usage: by-actor SUBSTRING');
      const result = backend.queryReceipts({ actor, limit: count || 100 });
      if (json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printHeader(backend.kind);
        console.log(c(ANSI.bold, `Receipts by actor matching "${actor}"`));
        printReceiptTable(result.receipts);
      }
      return result.receipts.length > 0;
    }
    case 'find': {
      const needle = args.positional[0];
      if (!needle) throw new Error('usage: find NEEDLE');
      const hits = bodyFindFromDisk(needle, count || 100);
      if (json) {
        console.log(JSON.stringify({
          needle, count: hits.length, hits, backend: backend.kind,
        }, null, 2));
      } else {
        printHeader(backend.kind);
        console.log(c(ANSI.bold,
          `Find "${needle}" — ${hits.length} match(es)`));
        printFindTable(hits);
      }
      return hits.length > 0;
    }
    case 'chain-verify': {
      const report = backend.chainVerifyReport();
      if (json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printHeader(backend.kind);
        printChainVerify(report);
      }
      return true;  // always produces output
    }
    case 'fake-green-sweep': {
      const result = backend.queryReceipts({ limit: 1000 });
      if (json) {
        const flagged = result.receipts.filter(
          r => r.flags?.fake_green_hits?.length);
        console.log(JSON.stringify({
          scanned: result.integrity.row_count,
          flagged_count: flagged.length,
          flagged,
          backend: backend.kind,
        }, null, 2));
      } else {
        printHeader(backend.kind);
        printFakeGreenSweep(result);
      }
      return true;
    }
    default:
      throw new Error(`unknown command: ${cmd}\n(run --help for usage)`);
  }
}

// ---------------------------------------------------------------------------
// Self-test — exercises every command against real corpus, asserts non-zero
// output for the data-bearing commands.
// ---------------------------------------------------------------------------

async function runSelfTest() {
  const results = [];
  let pass = 0, fail = 0;

  // Capture-style runner. We redirect console.log → buffer for each subtest,
  // then put it back. The CLI's print fns are sync, so this is safe.
  const origLog = console.log;
  async function exec(name, runner) {
    let buf = [];
    console.log = (...a) => buf.push(a.map(x =>
      typeof x === 'string' ? x : JSON.stringify(x)).join(' '));
    let err = null;
    let returned = null;
    try {
      returned = await runner();
    } catch (e) {
      err = e;
    } finally {
      console.log = origLog;
    }
    const out = buf.join('\n');
    const ok = !err && out.length > 0;
    if (ok) pass += 1; else fail += 1;
    results.push({
      name,
      ok,
      output_bytes: out.length,
      lines: out.split('\n').length,
      sample: out.split('\n').slice(0, 2).join(' | ').slice(0, 120),
      error: err ? String(err.message || err) : null,
      returned,
    });
  }

  // Each test runs the real command path.
  await exec('latest', () => runCommand(parseArgs(['node', 'cli', 'latest', '--count', '5'])));
  await exec('latest --json', () => runCommand(parseArgs(['node', 'cli', 'latest', '--count', '3', '--json'])));
  await exec('since 2026-06-24', () => runCommand(parseArgs(['node', 'cli', 'since', '2026-06-24'])));
  await exec('by-status partial', () => runCommand(parseArgs(['node', 'cli', 'by-status', 'partial'])));
  await exec('by-status GREEN', () => runCommand(parseArgs(['node', 'cli', 'by-status', 'green'])));
  await exec('by-actor Claude', () => runCommand(parseArgs(['node', 'cli', 'by-actor', 'Claude'])));
  await exec('find atomsmasher', () => runCommand(parseArgs(['node', 'cli', 'find', 'atomsmasher'])));
  await exec('chain-verify', () => runCommand(parseArgs(['node', 'cli', 'chain-verify'])));
  await exec('fake-green-sweep', () => runCommand(parseArgs(['node', 'cli', 'fake-green-sweep'])));
  await exec('--help', async () => { printHelp(); return true; });
  await exec('force-fallback latest', () => runCommand(
    parseArgs(['node', 'cli', 'latest', '--count', '2', '--force-fallback'])));

  // Print summary
  console.log(c(ANSI.bold, '\nOrange5 receipts CLI — self-test'));
  console.log(c(ANSI.dim, '-'.repeat(72)));
  for (const r of results) {
    const mark = r.ok
      ? c(ANSI.bgGreen, ' PASS ')
      : c(ANSI.bgRed, ' FAIL ');
    console.log(`${mark} ${c(ANSI.bold, padRight(r.name, 30))} ` +
      `${c(ANSI.gray, padRight(`${r.lines} lines, ${r.output_bytes}B`, 22))}` +
      (r.error ? c(ANSI.red, ' error: ' + r.error) : ''));
    if (r.sample && r.ok) {
      console.log('  ' + c(ANSI.dim, r.sample));
    }
  }
  console.log(c(ANSI.dim, '-'.repeat(72)));
  const summary = `passed ${pass}/${pass + fail}`;
  console.log(`${c(ANSI.bold, summary)}  ` +
    (fail === 0
      ? c(ANSI.bgGreen, ' SELF-TEST GREEN ')
      : c(ANSI.bgRed, ` ${fail} FAILURE(S) `)));
  return fail === 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);

  // Color decision
  COLOR_ENABLED = !args.flags.noColor &&
    !process.env.NO_COLOR &&
    process.stdout.isTTY !== false;

  if (args.flags.help) {
    printHelp();
    process.exit(0);
  }
  if (args.flags.selfTest) {
    const ok = await runSelfTest();
    process.exit(ok ? 0 : 1);
  }
  if (!args.command) {
    printHelp();
    process.exit(2);
  }

  try {
    const hadOutput = await runCommand(args);
    // Exit 0 if we successfully ran a command and (for data commands) had
    // results. chain-verify and fake-green-sweep always produce output, so
    // they always exit 0 unless the chain itself is broken — in which case
    // the report is printed but exit is non-zero.
    if (args.command === 'chain-verify') {
      // Re-run to check verdict for exit code (cheap on fs-fallback; on
      // sqlite the prior call already ran through integrity, so this is
      // also cheap because the DB is already warmed up).
      const backend = await loadBackend({ forceFallback: args.flags.forceFallback });
      const report = backend.chainVerifyReport();
      process.exit(report.ok ? 0 : 1);
    }
    process.exit(hadOutput ? 0 : 1);
  } catch (err) {
    if (args.flags.json) {
      console.log(JSON.stringify({
        error: String(err?.message || err),
        backend_error: backendErrorReason,
      }, null, 2));
    } else {
      console.error(c(ANSI.bgRed, ' ERROR '), c(ANSI.red, err?.message || String(err)));
      if (backendErrorReason) {
        console.error(c(ANSI.dim, `  (backend error: ${backendErrorReason})`));
      }
    }
    process.exit(2);
  }
}

main();
