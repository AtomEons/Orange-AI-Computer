#!/usr/bin/env node
// Orange5 receipts ingest
// Path:    06-CONTROL-PLANE/receipts/ingest.mjs
// Runtime: Node >= 20
//
// Watches 10-RECEIPTS/orange5-build/ via fs.watch and mirrors every markdown
// receipt into the SQLite store. Markdown remains the operator-audit ground
// truth; this lane only writes the parallel machine-query index.
//
// First run does a full backfill (every *.md file is parsed + upserted),
// then enters watch mode. fs.watch on Windows is "recursive=false-but-flaky",
// so we ALSO poll the directory mtime every POLL_INTERVAL_MS as a safety net.
// Both paths feed the same idempotent upsertReceipt — duplicate fires are no-ops.
//
// CLI:
//   node ingest.mjs                 # backfill + watch (default)
//   node ingest.mjs --backfill-only # one-shot, exit
//   node ingest.mjs --once          # alias for --backfill-only
//   node ingest.mjs --dir <path>    # override receipts source dir
//   node ingest.mjs --db   <path>   # override sqlite path
//
// Front-matter format observed in orange5-build/ is a markdown bullet list at
// the top of the file:
//
//   - **receipt_id:** 2026-06-24-graph-weaver-built
//   - **generated_at:** 2026-06-24T00:00:00Z
//   - **schema:** orange5.receipt.v0
//   - **status:** GRAPH_WEAVER_BUILT_AWAITING_AE_COBRA_LIVE
//   - **confidence:** 0.86 — every file authored...
//   - **prior_receipt:** 2026-06-24-mirage-recall-live (#020)
//   - **hash_chain:** #021
//
// Some receipts use a bold-prefixed line form (no leading bullet):
//
//   **Receipt ID:** `2026-06-23-master-receipt`
//
// The parser handles both, is case-insensitive on keys, strips backticks,
// and snake_cases keys ('Receipt ID' -> 'receipt_id'). If receipt_id is
// missing from front-matter we fall back to the filename slug (without `.md`).

import { createHash } from 'node:crypto';
import { promises as fsp, statSync, watch as fsWatch } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
    openDb,
    upsertReceipt,
    logIngest,
    countReceipts,
    defaultReceiptsDir,
    DEFAULT_DB_PATH,
    close as closeDb,
} from './db.mjs';

// ---------- config ----------------------------------------------------------

const POLL_INTERVAL_MS  = 2_000;   // safety-net poll cadence
const DEBOUNCE_MS       = 250;    // collapse rapid fs.watch bursts
const MAX_BODY_PREVIEW  = 64 * 1024; // bytes of raw markdown stashed in body_json
const VERBOSE           = process.env.ORANGE5_INGEST_VERBOSE === '1';

// ---------- arg parsing -----------------------------------------------------

function parseArgs(argv) {
    const out = { backfillOnly: false, dir: null, db: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--backfill-only' || a === '--once') out.backfillOnly = true;
        else if (a === '--dir') out.dir = argv[++i];
        else if (a === '--db')  out.db  = argv[++i];
        else if (a === '--help' || a === '-h') {
            process.stdout.write(
                'orange5 receipts ingest\n'
              + 'usage: node ingest.mjs [--backfill-only] [--dir <path>] [--db <path>]\n'
            );
            process.exit(0);
        }
    }
    return out;
}

// ---------- front-matter parser --------------------------------------------

const KEY_ALIASES = {
    'receipt id':     'receipt_id',
    'receipt_id':     'receipt_id',
    'generated_at':   'generated_at',
    'generated at':   'generated_at',
    'schema':         'schema',
    'status':         'status',
    'confidence':     'confidence',
    'prior_receipt':  'prior_receipt',
    'prior receipt':  'prior_receipt',
    'hash_chain':     'hash_chain',
    'hash chain':     'hash_chain',
    'actor':          'actor',
    'sovereign':      'sovereign',
};

const FRONTMATTER_KEYS = new Set(Object.values(KEY_ALIASES));

// Matches:  - **Key:** value      or      **Key:** value
const FRONT_LINE_RE = /^\s*(?:-\s+)?\*\*\s*([A-Za-z _]+?)\s*:?\s*\*\*\s*:?\s*(.+?)\s*$/;

/**
 * Parse the leading front-matter region. Stops at the first horizontal rule
 * (`---`), the first H1/H2 after the bullet block, or after PARSE_MAX_LINES.
 */
function parseFrontMatter(md) {
    const lines = md.split(/\r?\n/);
    const fm = {};
    const PARSE_MAX_LINES = 80;

    let sawAnyKey = false;
    let blanksSinceKey = 0;

    for (let i = 0; i < Math.min(lines.length, PARSE_MAX_LINES); i++) {
        const line = lines[i];

        if (/^\s*---\s*$/.test(line)) {
            if (sawAnyKey) break;
            continue; // tolerate optional yaml-style fence at top
        }
        if (/^##\s+/.test(line) && sawAnyKey) break;
        if (line.trim() === '') {
            if (sawAnyKey && ++blanksSinceKey >= 2) break;
            continue;
        }

        const m = FRONT_LINE_RE.exec(line);
        if (!m) {
            // Plain heading line at the very top is fine.
            if (!sawAnyKey && /^#\s+/.test(line)) continue;
            if (sawAnyKey) break;
            continue;
        }

        const rawKey = m[1].toLowerCase().trim();
        const key    = KEY_ALIASES[rawKey];
        if (!key) continue;

        const rawVal = m[2].trim();
        fm[key] = cleanValue(rawVal);
        sawAnyKey = true;
        blanksSinceKey = 0;
    }

    return fm;
}

function cleanValue(v) {
    // Strip surrounding backticks: `2026-06-23` -> 2026-06-23
    let out = v.trim();
    if (out.startsWith('`') && out.endsWith('`') && out.length >= 2) {
        out = out.slice(1, -1).trim();
    }
    return out;
}

/**
 * Confidence values appear in three flavors in the wild:
 *   - "0.86"                 -> 0.86
 *   - "0.86 — every file..." -> 0.86 (drop the em-dash justification)
 *   - "HIGH" / "MEDIUM"      -> null (preserved in confidence_raw)
 *   - "1.0"                  -> 1.0
 */
function coerceConfidence(raw) {
    if (raw == null) return { num: null, raw: null };
    const text = String(raw).trim();
    if (!text) return { num: null, raw: null };
    const m = /^([0-9]*\.?[0-9]+)/.exec(text);
    if (!m) return { num: null, raw: text };
    const n = Number(m[1]);
    if (!Number.isFinite(n)) return { num: null, raw: text };
    return { num: n, raw: text };
}

// ---------- file -> row -----------------------------------------------------

function sha256Hex(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

async function buildRow(filePath) {
    const buf  = await fsp.readFile(filePath);
    const text = buf.toString('utf8');
    const stat = await fsp.stat(filePath);

    const fm = parseFrontMatter(text);
    const { num: confNum, raw: confRaw } = coerceConfidence(fm.confidence);

    const receipt_id =
          fm.receipt_id
       || basename(filePath, '.md');

    const body_json = JSON.stringify({
        frontmatter: fm,
        confidence_parsed: confNum,
        bytes: buf.length,
        head: text.length > MAX_BODY_PREVIEW
            ? text.slice(0, MAX_BODY_PREVIEW) + '\n...[truncated]'
            : text,
    });

    return {
        receipt_id,
        generated_at:   fm.generated_at   ?? null,
        schema:         fm.schema         ?? null,
        status:         fm.status         ?? null,
        confidence:     confNum,
        confidence_raw: confRaw,
        prior_receipt:  fm.prior_receipt  ?? null,
        hash_chain:     fm.hash_chain     ?? null,
        actor:          fm.actor          ?? null,
        sovereign:      fm.sovereign      ?? null,
        markdown_path:  resolve(filePath),
        sha256:         sha256Hex(buf),
        body_json,
        file_mtime_ms:  Math.floor(stat.mtimeMs),
    };
}

// ---------- ingest core -----------------------------------------------------

async function ingestOne(db, filePath) {
    try {
        const row = await buildRow(filePath);
        const res = upsertReceipt(db, row);
        if (res.op === 'unchanged') {
            logIngest(db, {
                event: 'SKIP_UNCHANGED',
                receipt_id: row.receipt_id,
                markdown_path: row.markdown_path,
            });
            if (VERBOSE) log(`unchanged: ${row.receipt_id}`);
        } else {
            logIngest(db, {
                event: 'UPSERT',
                receipt_id: row.receipt_id,
                markdown_path: row.markdown_path,
                detail: res.op,
            });
            log(`${res.op}: ${row.receipt_id}`);
        }
        return res;
    } catch (err) {
        logIngest(db, {
            event: 'PARSE_ERROR',
            markdown_path: filePath,
            detail: err.message,
        });
        log(`PARSE_ERROR ${filePath}: ${err.message}`, true);
        return { changed: false, op: 'error', error: err };
    }
}

async function listMarkdownFiles(dir) {
    let entries;
    try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }
    return entries
        .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.md'))
        .map(e => join(dir, e.name));
}

async function backfill(db, dir) {
    logIngest(db, { event: 'BACKFILL_START', detail: dir });
    const files = await listMarkdownFiles(dir);
    log(`backfill: ${files.length} markdown files at ${dir}`);
    let inserted = 0, updated = 0, unchanged = 0, errors = 0;
    for (const f of files) {
        const r = await ingestOne(db, f);
        if (r.op === 'inserted')   inserted++;
        else if (r.op === 'updated') updated++;
        else if (r.op === 'unchanged') unchanged++;
        else errors++;
    }
    const summary = `inserted=${inserted} updated=${updated} unchanged=${unchanged} errors=${errors} total_rows=${countReceipts(db)}`;
    logIngest(db, { event: 'BACKFILL_DONE', detail: summary });
    log(`backfill done: ${summary}`);
    return { inserted, updated, unchanged, errors };
}

// ---------- watch -----------------------------------------------------------

function startWatcher(db, dir) {
    log(`watch: ${dir}`);
    const pending = new Map(); // filename -> timer

    function schedule(name) {
        if (!name || !name.toLowerCase().endsWith('.md')) return;
        const full = join(dir, name);
        const existing = pending.get(name);
        if (existing) clearTimeout(existing);
        pending.set(name, setTimeout(async () => {
            pending.delete(name);
            try {
                statSync(full); // EEXIST check; ENOENT means deleted, skip
                await ingestOne(db, full);
            } catch (err) {
                if (err.code === 'ENOENT') {
                    if (VERBOSE) log(`watch: ${name} vanished before parse`);
                } else {
                    logIngest(db, { event: 'WATCH_ERROR', markdown_path: full, detail: err.message });
                    log(`WATCH_ERROR ${name}: ${err.message}`, true);
                }
            }
        }, DEBOUNCE_MS));
    }

    let watcher;
    try {
        watcher = fsWatch(dir, { persistent: true }, (_evt, filename) => schedule(filename));
        watcher.on('error', (err) => {
            logIngest(db, { event: 'WATCH_ERROR', detail: err.message });
            log(`fs.watch error: ${err.message}`, true);
        });
    } catch (err) {
        log(`fs.watch unavailable on this platform: ${err.message}. Falling back to poll-only.`, true);
        logIngest(db, { event: 'WATCH_ERROR', detail: `fs.watch init failed: ${err.message}` });
    }

    // Safety-net poll: directory mtime + per-file mtime catches everything
    // fs.watch may miss (Windows network share, antivirus rewrite, etc.).
    const seen = new Map(); // path -> mtimeMs
    const pollTimer = setInterval(async () => {
        try {
            const files = await listMarkdownFiles(dir);
            for (const f of files) {
                let st;
                try { st = statSync(f); } catch { continue; }
                const prev = seen.get(f);
                if (prev !== st.mtimeMs) {
                    seen.set(f, st.mtimeMs);
                    await ingestOne(db, f);
                }
            }
        } catch (err) {
            logIngest(db, { event: 'WATCH_ERROR', detail: `poll: ${err.message}` });
        }
    }, POLL_INTERVAL_MS);
    pollTimer.unref?.();

    return () => {
        clearInterval(pollTimer);
        for (const t of pending.values()) clearTimeout(t);
        try { watcher?.close(); } catch { /* idempotent */ }
    };
}

// ---------- log -------------------------------------------------------------

function log(msg, isErr = false) {
    const line = `[receipts/ingest ${new Date().toISOString()}] ${msg}`;
    if (isErr) process.stderr.write(line + '\n');
    else       process.stdout.write(line + '\n');
}

// ---------- main ------------------------------------------------------------

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const dir  = resolve(args.dir || defaultReceiptsDir());
    const dbp  = resolve(args.db  || DEFAULT_DB_PATH);

    log(`db:  ${dbp}`);
    log(`dir: ${dir}`);

    const db = openDb(dbp);

    await backfill(db, dir);

    if (args.backfillOnly) {
        closeDb(db);
        return;
    }

    const stop = startWatcher(db, dir);

    const shutdown = (signal) => {
        log(`shutdown on ${signal}`);
        try { stop(); } catch { /* idempotent */ }
        closeDb(db);
        process.exit(0);
    };
    process.on('SIGINT',  () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Keep the event loop alive forever (the poll timer is unref'd).
    // A no-op interval is the cleanest cross-platform "park here" primitive.
    setInterval(() => {}, 1 << 30);
}

// Only run main when invoked directly, not when imported by a test.
const invokedDirectly =
    import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` ||
    import.meta.url === new URL(`file:///${process.argv[1]?.replace(/\\/g, '/')}`).href ||
    process.argv[1]?.endsWith('ingest.mjs');

if (invokedDirectly) {
    main().catch((err) => {
        log(`fatal: ${err.stack || err.message}`, true);
        process.exit(1);
    });
}

export { parseFrontMatter, coerceConfidence, buildRow, ingestOne, backfill };
