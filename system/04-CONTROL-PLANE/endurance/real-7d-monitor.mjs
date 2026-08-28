#!/usr/bin/env node
// Orange5 endurance — real 7-day uptime monitor.
//
// Path:    04-CONTROL-PLANE/endurance/real-7d-monitor.mjs
// Runtime: Node >= 20. Imports node: builtins + 06-CONTROL-PLANE/receipts/db.mjs.
//          better-sqlite3 resolves transitively through db.mjs's own
//          node_modules at 06-CONTROL-PLANE/receipts/node_modules/.
//
// Doctrine alignment
//   - Mom's Law: a real 7-day monitor, with real probes against the four live
//     services, real JSONL on disk, and a real receipt at the end. No theater.
//     If the monitor cannot reach a service it logs that fact honestly; it
//     does not pretend a 5xx is a 200.
//   - Receipts: parallel storage holds. Operator-audit canonical form is the
//     Markdown receipt at 10-RECEIPTS/orange5-build/<YYYY-MM-DD>-endurance-real-7d-week-N.md.
//     The same bytes are SHA-256 hashed and mirrored into the SQLite store at
//     06-CONTROL-PLANE/receipts/orange5.db via the single-writer db.mjs
//     upsertReceipt path. SHA-256 column matches the file bytes exactly.
//   - Frontier-Isolation: the monitor probes loopback-only endpoints. No
//     external network is touched. The probe HTTP client refuses any URL that
//     does not resolve to 127.0.0.1 / ::1 / localhost.
//   - No-Take-Down Law: the monitor is read-only against the services. It
//     never POSTs, never restarts anything, never holds connections open
//     beyond a per-probe AbortController.
//   - Sole writer: this script writes ONLY (a) its JSONL telemetry file and
//     (b) one Markdown receipt + matching SQLite row at the end of the run
//     (or on weekly Friday rollover when the run spans multiple weeks). It
//     never touches 05-FLOW/state/flow.json, never touches flux roots, never
//     touches any service config.
//   - Receipts are append-only on the operator side. If a slug already exists
//     in SQLite, the idempotent UPSERT path in db.mjs updates that row in
//     place — but the markdown file gets a date+slug that incorporates the
//     ISO week so a 7-day run that crosses Friday 23:55 ET emits one receipt
//     per week-N segment.
//
// What it does
//   1. Boots a long-lived daemon (default 7 days, configurable --days N).
//   2. Every SAMPLE_INTERVAL_MS (default 600_000 = 10 min) probes:
//        - Æ Cobra        GET 127.0.0.1:7419/healthz
//        - OrangeLLM gw   GET 127.0.0.1:1337/healthz
//        - ColPali        GET 127.0.0.1:7440/healthz
//        - Graph-Weaver   GET 127.0.0.1:1337/v1/graph/health   (gateway-routed)
//      Each probe has a per-probe timeout (default 5_000 ms). Records:
//        { ts, target, url, status, ok, latency_ms, body_excerpt?, error? }
//   3. Appends every sample as one JSONL line to:
//        04-CONTROL-PLANE/endurance/state/real-7d-monitor.<YYYY-WW>.jsonl
//      One file per ISO week. Days inside a week share a file so weekly
//      receipts can read a single source.
//   4. Friday 23:55 ET (or daemon exit, whichever comes first) emits a
//      weekly endurance receipt with:
//        - sample counts per target
//        - uptime %, p50/p95/p99/max latency per target
//        - longest outage window per target
//        - any consecutive-failure spikes ( >= 3 fails in a row )
//        - verdict: PASS if all four targets ran with >= 99.0% probe-success
//                    within their availability window, else FAIL.
//      Receipt is written to:
//        10-RECEIPTS/orange5-build/<YYYY-MM-DD>-endurance-real-7d-week-N-<verdict>.md
//      and mirrored into orange5.db with sha256 of the markdown bytes.
//   5. Graceful shutdown on SIGINT/SIGTERM: flushes JSONL buffer, emits a
//     partial-week receipt if at least 24h of samples were collected, then
//     exits.
//
// CLI
//   node real-7d-monitor.mjs                       # default 7d, 10min cadence
//   node real-7d-monitor.mjs --days 1              # short run for shakedown
//   node real-7d-monitor.mjs --interval 60         # seconds between samples
//   node real-7d-monitor.mjs --probe-timeout 3000  # ms per probe
//   node real-7d-monitor.mjs --no-receipt          # skip end-of-run receipt
//   node real-7d-monitor.mjs --foreground          # don't background; log to stdout
//   node real-7d-monitor.mjs --once                # one probe round, then exit
//   node real-7d-monitor.mjs --uptime-bar 99.0     # min uptime % for PASS verdict
//
// Env overrides (CLI > env > default)
//   ORANGE5_COBRA_HEALTHZ          default http://127.0.0.1:7419/healthz
//   ORANGE5_GATEWAY_HEALTHZ        default http://127.0.0.1:1337/healthz
//   ORANGE5_COLPALI_HEALTHZ        default http://127.0.0.1:7440/healthz
//   ORANGE5_GRAPHWEAVER_HEALTHZ    default http://127.0.0.1:1337/v1/graph/health
//   ORANGE5_MONITOR_STATE_DIR      default <this dir>/state
//   ORANGE5_RECEIPTS_DIR           default <repo>/10-RECEIPTS/orange5-build
//   ORANGE5_RECEIPTS_DB            default <repo>/06-CONTROL-PLANE/receipts/orange5.db
//
// Exit codes
//   0  clean exit, verdict PASS (or no-receipt mode)
//   1  clean exit, verdict FAIL
//   2  fatal error (config, disk, db, etc.) — surfaced in stderr + JSONL

import {
    appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- paths -----------------------------------------------------------

// 04-CONTROL-PLANE/endurance/ -> ../../
const REPO_ROOT = resolve(__dirname, '..', '..');
const DEFAULT_STATE_DIR    = process.env.ORANGE5_MONITOR_STATE_DIR
    || resolve(__dirname, 'state');
const DEFAULT_RECEIPTS_MD  = process.env.ORANGE5_RECEIPTS_DIR
    || resolve(REPO_ROOT, '10-RECEIPTS', 'orange5-build');
const DEFAULT_RECEIPTS_DB  = process.env.ORANGE5_RECEIPTS_DB
    || resolve(REPO_ROOT, '06-CONTROL-PLANE', 'receipts', 'orange5.db');
const RECEIPTS_DB_MODULE   = resolve(REPO_ROOT, '06-CONTROL-PLANE', 'receipts', 'db.mjs');

// ---------- targets ---------------------------------------------------------

const TARGETS = [
    {
        id:   'ae-cobra',
        name: 'Æ Cobra',
        url:  process.env.ORANGE5_COBRA_HEALTHZ       || 'http://127.0.0.1:7419/healthz',
    },
    {
        id:   'orangellm-gateway',
        name: 'OrangeLLM gateway',
        url:  process.env.ORANGE5_GATEWAY_HEALTHZ     || 'http://127.0.0.1:1337/healthz',
    },
    {
        id:   'colpali',
        name: 'ColPali visual service',
        url:  process.env.ORANGE5_COLPALI_HEALTHZ     || 'http://127.0.0.1:7440/healthz',
    },
    {
        id:   'graph-weaver',
        name: 'Graph-Weaver (gateway route)',
        // graph-weaver is a daemon, not an HTTP server. Its liveness surfaces
        // through the gateway's /v1/graph/* routes. If that route is absent,
        // the probe records a 404 — which honestly reflects "graph route not
        // wired yet" rather than pretending green.
        url:  process.env.ORANGE5_GRAPHWEAVER_HEALTHZ || 'http://127.0.0.1:1337/v1/graph/health',
    },
];

// ---------- defaults --------------------------------------------------------

const DEFAULTS = Object.freeze({
    days:           7,
    interval_ms:    10 * 60 * 1000,   // 10 minutes
    probe_timeout:  5_000,            // 5s per probe
    body_excerpt:   240,              // chars of body kept on success/error
    uptime_bar:     99.0,             // % min probe success for PASS
    consec_fail_threshold: 3,         // record consecutive-failure spikes
    weekly_receipt_dow:    5,         // Friday (0=Sun..6=Sat) in America/New_York
    weekly_receipt_hour:   23,        // 23:55 local NY
    weekly_receipt_min:    55,
    timezone:              'America/New_York',
    state_dir:             DEFAULT_STATE_DIR,
    receipts_md_dir:       DEFAULT_RECEIPTS_MD,
    receipts_db_path:      DEFAULT_RECEIPTS_DB,
    foreground:            false,
    emit_receipt:          true,
    once:                  false,
});

// ---------- CLI -------------------------------------------------------------

function parseArgs(argv) {
    const cfg = { ...DEFAULTS };
    const args = argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        const next = () => {
            const v = args[++i];
            if (v === undefined) throw new Error(`flag ${a} requires a value`);
            return v;
        };
        switch (a) {
            case '--days':           cfg.days = parsePosInt(next(), '--days'); break;
            case '--interval':       cfg.interval_ms = parsePosInt(next(), '--interval') * 1000; break;
            case '--interval-ms':    cfg.interval_ms = parsePosInt(next(), '--interval-ms'); break;
            case '--probe-timeout':  cfg.probe_timeout = parsePosInt(next(), '--probe-timeout'); break;
            case '--uptime-bar':     cfg.uptime_bar = parseFloat(next()); break;
            case '--state-dir':      cfg.state_dir = resolve(next()); break;
            case '--receipts-dir':   cfg.receipts_md_dir = resolve(next()); break;
            case '--receipts-db':    cfg.receipts_db_path = resolve(next()); break;
            case '--foreground':     cfg.foreground = true; break;
            case '--no-receipt':     cfg.emit_receipt = false; break;
            case '--once':           cfg.once = true; break;
            case '-h':
            case '--help':
                printHelp();
                process.exit(0);
                break;
            default:
                throw new Error(`unknown flag: ${a}`);
        }
    }
    if (!Number.isFinite(cfg.uptime_bar) || cfg.uptime_bar < 0 || cfg.uptime_bar > 100) {
        throw new Error(`--uptime-bar must be 0..100, got ${cfg.uptime_bar}`);
    }
    return cfg;
}

function parsePosInt(s, label) {
    const n = Number(s);
    if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`${label} must be a positive integer, got "${s}"`);
    }
    return n;
}

function printHelp() {
    process.stdout.write(
        'Orange5 real-7d-monitor — long-running endurance probe of four services.\n' +
        '\n' +
        'Usage: node real-7d-monitor.mjs [flags]\n' +
        '\n' +
        '  --days N              run for N days (default 7)\n' +
        '  --interval SEC        seconds between sample rounds (default 600)\n' +
        '  --probe-timeout MS    ms per HTTP probe (default 5000)\n' +
        '  --uptime-bar PCT      min %success for PASS verdict (default 99.0)\n' +
        '  --state-dir PATH      JSONL output dir (default <this>/state)\n' +
        '  --receipts-dir PATH   markdown receipts dir\n' +
        '  --receipts-db PATH    SQLite mirror path\n' +
        '  --foreground          log human-readable lines to stdout\n' +
        '  --once                run one probe round then exit (CI smoke)\n' +
        '  --no-receipt          skip end-of-run receipt emission\n' +
        '  -h / --help           this message\n'
    );
}

// ---------- logger ----------------------------------------------------------

// Structured one-line JSON to stderr by default; if --foreground, also a
// human-readable line to stdout. Stderr always carries the machine form so
// the daemon log is parseable when redirected.

function makeLogger(foreground) {
    return function log(level, message, extra = {}) {
        const rec = {
            ts:    new Date().toISOString(),
            level,
            actor: 'orange5-endurance-real-7d',
            message,
            ...extra,
        };
        try {
            process.stderr.write(JSON.stringify(rec) + '\n');
        } catch {
            // last-resort: drop on the floor rather than crash the daemon
        }
        if (foreground) {
            const tag = level.toUpperCase().padEnd(5);
            const extraStr = Object.keys(extra).length
                ? ' ' + JSON.stringify(extra)
                : '';
            process.stdout.write(`${rec.ts} ${tag} ${message}${extraStr}\n`);
        }
    };
}

// ---------- loopback guard --------------------------------------------------

const LOOPBACK_HOSTS = new Set([
    '127.0.0.1', 'localhost', '::1', '[::1]',
]);

function assertLoopback(urlStr) {
    let u;
    try {
        u = new URL(urlStr);
    } catch (err) {
        throw new Error(`invalid url "${urlStr}": ${err.message}`);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new Error(`url "${urlStr}" must be http(s)`);
    }
    if (!LOOPBACK_HOSTS.has(u.hostname)) {
        throw new Error(
            `loopback guard: url "${urlStr}" host "${u.hostname}" is not loopback. ` +
            'Endurance monitor is loopback-only by doctrine (Frontier-Isolation).'
        );
    }
    return u;
}

// ---------- single-instance guard ------------------------------------------

function acquirePidLock(stateDir) {
    const lockPath = join(stateDir, 'real-7d-monitor.pid');
    if (existsSync(lockPath)) {
        const prev = readFileSync(lockPath, 'utf8').trim();
        const prevPid = Number(prev);
        if (Number.isInteger(prevPid) && prevPid > 0) {
            const alive = isProcessAlive(prevPid);
            if (alive) {
                throw new Error(
                    `another monitor already running (pid ${prevPid}). ` +
                    `Remove ${lockPath} only if you are certain pid ${prevPid} is dead.`
                );
            }
        }
        // stale lock — overwrite
    }
    writeFileSync(lockPath, String(process.pid), 'utf8');
    return lockPath;
}

function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err.code === 'EPERM'; // exists but not ours
    }
}

function releasePidLock(lockPath) {
    try {
        const cur = readFileSync(lockPath, 'utf8').trim();
        if (Number(cur) === process.pid) {
            // best-effort delete; missing-file is fine
            unlinkSync(lockPath);
        }
    } catch { /* ignore */ }
}

// ---------- ISO week helpers -----------------------------------------------

// ISO 8601 week: weeks start Monday, week 1 contains the first Thursday of
// the year. We use this for the JSONL file naming so a run that crosses a
// Sunday lands sample data into the correct week file.

function isoWeekParts(date = new Date()) {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    // Thursday in current week determines the year of the iso week
    const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
    d.setUTCDate(d.getUTCDate() - dayNum + 3);
    const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    const weekNum = 1 + Math.round(
        ((d - firstThursday) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7
    );
    return { year: d.getUTCFullYear(), week: weekNum };
}

function isoWeekTag(date = new Date()) {
    const { year, week } = isoWeekParts(date);
    return `${year}-W${String(week).padStart(2, '0')}`;
}

// ---------- NY-time helper for Friday 23:55 -------------------------------

// We don't need full tz arithmetic — we need: given Date now, the next
// instant where it is Friday 23:55 in America/New_York. Use Intl.DateTimeFormat
// to inspect now's parts in NY, then walk to the target.

function nextFriday2355NY(from = new Date()) {
    // parts in NY for "from"
    const parts = nyParts(from);
    // delta days to Friday (5)
    let deltaDays = (5 - parts.weekday + 7) % 7;
    let target = new Date(from.getTime());
    // approximate: add deltaDays in milliseconds then adjust to 23:55 NY
    target = new Date(target.getTime() + deltaDays * 86_400_000);
    target = setNYClock(target, 23, 55);
    if (target <= from) {
        // already past this Friday's 23:55 — go to next week
        target = new Date(target.getTime() + 7 * 86_400_000);
        target = setNYClock(target, 23, 55);
    }
    return target;
}

function nyParts(date) {
    const f = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        weekday:  'short',
        year:     'numeric',
        month:    '2-digit',
        day:      '2-digit',
        hour:     '2-digit',
        minute:   '2-digit',
        second:   '2-digit',
        hour12:   false,
    });
    const parts = Object.fromEntries(f.formatToParts(date).map(p => [p.type, p.value]));
    const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
        year:    Number(parts.year),
        month:   Number(parts.month),
        day:     Number(parts.day),
        hour:    Number(parts.hour === '24' ? '00' : parts.hour),
        minute:  Number(parts.minute),
        second:  Number(parts.second),
        weekday: weekdayMap[parts.weekday] ?? 0,
    };
}

// Set the time-of-day in NY tz. Uses a single iteration to land within ~1 min
// without pulling a full tz database. Good enough for a 5-min-granularity
// scheduling decision.
function setNYClock(date, hour, minute) {
    let candidate = new Date(date.getTime());
    for (let attempt = 0; attempt < 3; attempt++) {
        const p = nyParts(candidate);
        const deltaMin = (hour * 60 + minute) - (p.hour * 60 + p.minute);
        if (Math.abs(deltaMin) < 1) break;
        candidate = new Date(candidate.getTime() + deltaMin * 60_000);
    }
    return candidate;
}

// ---------- probe ----------------------------------------------------------

async function probeOne(target, timeoutMs, log) {
    const startMs = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res, body = null, ok = false, status = 0, error = null;
    try {
        res = await fetch(target.url, {
            method:  'GET',
            signal:  ctrl.signal,
            headers: { 'accept': 'application/json, text/plain;q=0.9, */*;q=0.5' },
            // do not follow redirects: a /healthz that redirects is a smell
            redirect: 'manual',
        });
        status = res.status;
        ok = res.status >= 200 && res.status < 300;
        // small body excerpt, never the full payload
        const text = await readBodyExcerpt(res, DEFAULTS.body_excerpt);
        body = text;
    } catch (err) {
        if (err.name === 'AbortError') {
            error = `timeout after ${timeoutMs}ms`;
        } else {
            error = `${err.name || 'Error'}: ${err.message}`;
        }
    } finally {
        clearTimeout(timer);
    }
    const latency_ms = Date.now() - startMs;
    return {
        ts:           new Date().toISOString(),
        target:       target.id,
        target_name:  target.name,
        url:          target.url,
        status,
        ok,
        latency_ms,
        body_excerpt: body,
        error,
    };
}

async function readBodyExcerpt(res, maxChars) {
    try {
        const text = await res.text();
        if (text.length <= maxChars) return text;
        return text.slice(0, maxChars) + `…[+${text.length - maxChars}b]`;
    } catch {
        return null;
    }
}

// ---------- JSONL writer ---------------------------------------------------

class JsonlSink {
    constructor(stateDir) {
        this.stateDir = stateDir;
        mkdirSync(this.stateDir, { recursive: true });
    }
    pathForDate(d) {
        return join(this.stateDir, `real-7d-monitor.${isoWeekTag(d)}.jsonl`);
    }
    append(record) {
        const line = JSON.stringify(record) + '\n';
        appendFileSync(this.pathForDate(new Date(record.ts)), line, 'utf8');
    }
    /** Read all samples that fall within [fromIso, toIso) across week files. */
    readWindow(fromIso, toIso) {
        const samples = [];
        const fromDate = new Date(fromIso);
        const toDate = new Date(toIso);
        // collect every weekly file from fromDate..toDate inclusive
        const weeks = new Set();
        const cursor = new Date(fromDate.getTime());
        while (cursor <= toDate) {
            weeks.add(isoWeekTag(cursor));
            cursor.setUTCDate(cursor.getUTCDate() + 1);
        }
        weeks.add(isoWeekTag(toDate));
        for (const wk of weeks) {
            const p = join(this.stateDir, `real-7d-monitor.${wk}.jsonl`);
            if (!existsSync(p)) continue;
            const text = readFileSync(p, 'utf8');
            for (const raw of text.split('\n')) {
                if (!raw) continue;
                try {
                    const obj = JSON.parse(raw);
                    if (!obj.ts) continue;
                    if (obj.ts < fromIso || obj.ts >= toIso) continue;
                    samples.push(obj);
                } catch {
                    // corrupt line — skip honestly, do not pretend it's a sample
                }
            }
        }
        return samples;
    }
}

// ---------- summarizer -----------------------------------------------------

function percentile(arr, p) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
    return Number(sorted[idx].toFixed(2));
}

function summarize(samples, cfg) {
    // group by target
    const byTarget = new Map();
    for (const t of TARGETS) byTarget.set(t.id, []);
    for (const s of samples) {
        const arr = byTarget.get(s.target);
        if (arr) arr.push(s);
    }

    const perTarget = {};
    let worstFailRunGlobal = { target: null, length: 0, started_at: null, ended_at: null };
    let allTargetsMetBar = true;

    for (const t of TARGETS) {
        const arr = byTarget.get(t.id) || [];
        arr.sort((a, b) => a.ts.localeCompare(b.ts));

        const total = arr.length;
        const okCount = arr.filter(s => s.ok).length;
        const uptime_pct = total === 0 ? 0 : Number(((okCount / total) * 100).toFixed(3));
        const latencies = arr.filter(s => s.ok).map(s => s.latency_ms);

        // longest consecutive-failure run
        let runLen = 0, runStart = null;
        let worstRun = { length: 0, started_at: null, ended_at: null };
        for (const s of arr) {
            if (!s.ok) {
                if (runLen === 0) runStart = s.ts;
                runLen += 1;
                if (runLen > worstRun.length) {
                    worstRun = { length: runLen, started_at: runStart, ended_at: s.ts };
                }
            } else {
                runLen = 0;
                runStart = null;
            }
        }
        if (worstRun.length > worstFailRunGlobal.length) {
            worstFailRunGlobal = { target: t.id, ...worstRun };
        }

        // status code distribution for forensics
        const statusHist = {};
        for (const s of arr) {
            const k = s.error ? `err:${truncate(s.error, 80)}` : String(s.status);
            statusHist[k] = (statusHist[k] || 0) + 1;
        }

        const metBar = total === 0 ? false : uptime_pct >= cfg.uptime_bar;
        if (!metBar) allTargetsMetBar = false;

        perTarget[t.id] = {
            name: t.name,
            url:  t.url,
            samples: total,
            ok_count: okCount,
            fail_count: total - okCount,
            uptime_pct,
            uptime_bar_met: metBar,
            latency_ms: {
                p50: percentile(latencies, 0.5),
                p95: percentile(latencies, 0.95),
                p99: percentile(latencies, 0.99),
                max: latencies.length ? Number(Math.max(...latencies).toFixed(2)) : 0,
            },
            worst_consecutive_fail: worstRun,
            status_histogram: statusHist,
        };
    }

    return {
        per_target: perTarget,
        worst_outage: worstFailRunGlobal,
        all_targets_met_bar: allTargetsMetBar,
        total_samples: samples.length,
    };
}

function truncate(s, n) {
    if (!s) return '';
    return s.length > n ? s.slice(0, n) + '…' : s;
}

// ---------- receipt emission -----------------------------------------------

async function emitWeeklyReceipt({
    fromIso, toIso, weekTag, weekNumber, samples, cfg, log,
}) {
    const summary = summarize(samples, cfg);
    const verdict = summary.all_targets_met_bar && summary.total_samples > 0
        ? 'PASS'
        : 'FAIL';

    const date = new Date().toISOString().slice(0, 10);
    const slug = `${date}-endurance-real-7d-${weekTag.toLowerCase()}-week-${weekNumber}-${verdict.toLowerCase()}`;

    mkdirSync(cfg.receipts_md_dir, { recursive: true });
    const receiptPath = join(cfg.receipts_md_dir, `${slug}.md`);
    const md = buildMarkdown({ summary, verdict, fromIso, toIso, weekTag, weekNumber, cfg, slug });
    writeFileSync(receiptPath, md, 'utf8');

    const bytes = readFileSync(receiptPath);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    log('info', 'markdown receipt written', { path: receiptPath, sha256, verdict });

    // SQLite mirror
    let dbMod;
    try {
        dbMod = await import(`file://${RECEIPTS_DB_MODULE.replace(/\\/g, '/')}`);
    } catch (err) {
        log('error', 'sqlite mirror skipped — db.mjs load failed (markdown receipt authoritative)', {
            error: err.message,
        });
        return { verdict, sha256, receiptPath, mirrored: false };
    }

    let handle = null;
    try {
        handle = dbMod.openDb(cfg.receipts_db_path);
        const row = {
            receipt_id:    slug,
            generated_at:  new Date().toISOString(),
            schema:        'orange5.endurance.real7d.v0',
            status:        verdict,
            confidence:    verdict === 'PASS' ? 0.97 : 0.99,
            confidence_raw: verdict === 'PASS'
                ? `all 4 services >= ${cfg.uptime_bar}% over ${samples.length} probes`
                : `one or more services below ${cfg.uptime_bar}% bar`,
            prior_receipt: null,
            hash_chain:    null,
            actor:         'orange5-endurance-real-7d-monitor',
            sovereign:     'atom-mccree',
            markdown_path: receiptPath,
            sha256,
            body_json:     JSON.stringify({ summary, fromIso, toIso, weekTag, weekNumber, cfg }),
            file_mtime_ms: statSync(receiptPath).mtimeMs,
        };
        const op = dbMod.upsertReceipt(handle, row);
        dbMod.logIngest(handle, {
            event: 'endurance.real7d.complete',
            receipt_id: slug,
            markdown_path: receiptPath,
            detail: JSON.stringify({ verdict, op, week_tag: weekTag, week_number: weekNumber }),
        });
        log('info', 'sqlite mirror written', {
            db_path: cfg.receipts_db_path, op: op.op, sha256,
        });
        return { verdict, sha256, receiptPath, mirrored: true, op: op.op };
    } catch (err) {
        log('error', 'sqlite mirror failed (markdown receipt still authoritative)', {
            error: err.message,
        });
        return { verdict, sha256, receiptPath, mirrored: false };
    } finally {
        if (handle && dbMod && dbMod.close) dbMod.close(handle);
    }
}

function buildMarkdown({ summary, verdict, fromIso, toIso, weekTag, weekNumber, cfg, slug }) {
    const lines = [];
    lines.push(`# Orange5 endurance — real 7-day uptime monitor (${verdict})`);
    lines.push('');
    lines.push(`- **receipt_id:** ${slug}`);
    lines.push(`- **generated_at:** ${new Date().toISOString()}`);
    lines.push(`- **schema:** orange5.endurance.real7d.v0`);
    lines.push(`- **status:** ${verdict}`);
    lines.push(`- **window:** ${fromIso} .. ${toIso}`);
    lines.push(`- **iso week:** ${weekTag}  •  week_number: ${weekNumber}`);
    lines.push(`- **uptime bar:** ${cfg.uptime_bar.toFixed(2)}%`);
    lines.push(`- **sample interval:** ${(cfg.interval_ms / 1000).toFixed(0)}s`);
    lines.push(`- **probe timeout:** ${cfg.probe_timeout}ms`);
    lines.push(`- **total samples:** ${summary.total_samples}`);
    lines.push(`- **actor:** orange5-endurance-real-7d-monitor`);
    lines.push(`- **sovereign:** atom-mccree`);
    lines.push('');
    lines.push('## Per-target results');
    lines.push('');
    lines.push('| Target | Samples | OK | Fail | Uptime % | Bar | p50 ms | p95 ms | p99 ms | Worst outage |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const t of TARGETS) {
        const r = summary.per_target[t.id];
        const bar = r.uptime_bar_met ? 'green' : 'FAIL';
        const wo  = r.worst_consecutive_fail.length
            ? `${r.worst_consecutive_fail.length} consec (${r.worst_consecutive_fail.started_at} → ${r.worst_consecutive_fail.ended_at})`
            : 'none';
        lines.push(
            `| ${t.name} | ${r.samples} | ${r.ok_count} | ${r.fail_count} | ` +
            `${r.uptime_pct.toFixed(3)} | ${bar} | ` +
            `${r.latency_ms.p50.toFixed(1)} | ${r.latency_ms.p95.toFixed(1)} | ${r.latency_ms.p99.toFixed(1)} | ` +
            `${wo} |`
        );
    }
    lines.push('');

    lines.push('## Status / error histograms');
    lines.push('');
    for (const t of TARGETS) {
        const r = summary.per_target[t.id];
        const hist = Object.entries(r.status_histogram)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `\`${k}\`: ${v}`)
            .join(', ');
        lines.push(`- **${t.name}** (${r.url}) → ${hist || 'no samples'}`);
    }
    lines.push('');

    if (summary.worst_outage.target) {
        lines.push('## Worst outage window (across all targets)');
        lines.push('');
        lines.push(`- target: **${summary.worst_outage.target}**`);
        lines.push(`- consecutive failed probes: **${summary.worst_outage.length}**`);
        lines.push(`- started_at: ${summary.worst_outage.started_at}`);
        lines.push(`- ended_at: ${summary.worst_outage.ended_at}`);
        lines.push('');
    }

    lines.push('## Verdict');
    lines.push('');
    if (verdict === 'PASS') {
        lines.push(
            `All four monitored services held above the ${cfg.uptime_bar.toFixed(2)}% probe-success bar across `
            + `${summary.total_samples} samples in the window. Paired with the synthetic 24h replay `
            + `(\`synth-24h.mjs\`), this closes the endurance gate for the week.`
        );
    } else {
        const below = TARGETS
            .filter(t => !summary.per_target[t.id].uptime_bar_met)
            .map(t => `${t.name} (${summary.per_target[t.id].uptime_pct.toFixed(2)}%)`);
        lines.push(
            `**FAIL** — service(s) below the ${cfg.uptime_bar.toFixed(2)}% bar: ${below.join(', ') || 'no samples collected'}. ` +
            `Inspect the JSONL at \`${cfg.state_dir}\` and the status_histogram above before the next weekly window.`
        );
    }
    lines.push('');

    lines.push('## Footer');
    lines.push('');
    lines.push('- emitted by `04-CONTROL-PLANE/endurance/real-7d-monitor.mjs`');
    lines.push('- JSONL telemetry lives at `04-CONTROL-PLANE/endurance/state/real-7d-monitor.<YYYY-WW>.jsonl`');
    lines.push('- markdown receipt is operator-audit canonical form; SQLite mirror at `06-CONTROL-PLANE/receipts/orange5.db` carries the same SHA-256');
    lines.push('- Loopback-only by construction. No external network was touched.');
    lines.push('- Mom is watching.');
    lines.push('');
    return lines.join('\n');
}

// ---------- main loop ------------------------------------------------------

async function run(cfg) {
    const log = makeLogger(cfg.foreground);

    // pre-flight
    mkdirSync(cfg.state_dir,        { recursive: true });
    mkdirSync(cfg.receipts_md_dir,  { recursive: true });
    for (const t of TARGETS) assertLoopback(t.url);

    const lockPath = acquirePidLock(cfg.state_dir);
    let exiting = false;
    let lastSampleTs = null;
    let weekNumber = 1;

    const sink = new JsonlSink(cfg.state_dir);

    const startedAt = new Date();
    const startedAtIso = startedAt.toISOString();
    const endAt = new Date(startedAt.getTime() + cfg.days * 86_400_000);

    log('info', 'monitor starting', {
        pid: process.pid,
        days: cfg.days,
        interval_ms: cfg.interval_ms,
        probe_timeout_ms: cfg.probe_timeout,
        targets: TARGETS.map(t => ({ id: t.id, url: t.url })),
        started_at: startedAtIso,
        end_at: endAt.toISOString(),
        state_dir: cfg.state_dir,
        receipts_md_dir: cfg.receipts_md_dir,
        receipts_db_path: cfg.receipts_db_path,
        once: cfg.once,
        emit_receipt: cfg.emit_receipt,
    });

    // graceful shutdown — emit a partial receipt only if we collected >= 24h
    // of samples, otherwise just flush JSONL and exit honestly.
    const shutdown = async (signal) => {
        if (exiting) return;
        exiting = true;
        log('info', 'shutdown signal received', { signal });
        try {
            if (cfg.emit_receipt) {
                const toIso = new Date().toISOString();
                const elapsedMs = Date.now() - startedAt.getTime();
                if (elapsedMs >= 24 * 60 * 60 * 1000) {
                    const samples = sink.readWindow(startedAtIso, toIso);
                    const { week } = isoWeekParts(startedAt);
                    await emitWeeklyReceipt({
                        fromIso: startedAtIso,
                        toIso,
                        weekTag: isoWeekTag(startedAt),
                        weekNumber: week,
                        samples,
                        cfg,
                        log,
                    });
                } else {
                    log('warn', 'partial run < 24h — receipt skipped (no theater)', {
                        elapsed_ms: elapsedMs,
                    });
                }
            }
        } catch (err) {
            log('error', 'shutdown receipt emit failed', { error: err.message, stack: err.stack });
        } finally {
            releasePidLock(lockPath);
            process.exit(0);
        }
    };
    process.on('SIGINT',  () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Per-target consecutive failure counters (for surfaced log warnings)
    const consecFail = new Map(TARGETS.map(t => [t.id, 0]));

    let nextWeeklyAt = nextFriday2355NY(startedAt);
    log('info', 'next weekly receipt window', { at: nextWeeklyAt.toISOString() });

    // Anchor "week N" relative to start of monitor: ceil(elapsed_days / 7)
    function currentWeekNumber(now = new Date()) {
        const elapsedMs = now.getTime() - startedAt.getTime();
        const elapsedDays = elapsedMs / 86_400_000;
        return Math.max(1, Math.ceil(elapsedDays / 7));
    }

    while (!exiting) {
        const now = new Date();
        if (now >= endAt) {
            log('info', 'reached configured end time', { end_at: endAt.toISOString() });
            break;
        }

        // ---- sample round -------------------------------------------------
        const roundStart = Date.now();
        const roundIso   = new Date(roundStart).toISOString();
        log('debug', 'sample round start', { ts: roundIso });

        // Run probes in parallel — they target different ports and a slow
        // service should not delay the others. Each probe has its own
        // AbortController so a hung socket cannot block the daemon.
        const results = await Promise.all(
            TARGETS.map(t => probeOne(t, cfg.probe_timeout, log))
        );
        for (const r of results) {
            sink.append(r);
            const prev = consecFail.get(r.target) || 0;
            if (!r.ok) {
                const nextN = prev + 1;
                consecFail.set(r.target, nextN);
                if (nextN === cfg.consec_fail_threshold) {
                    log('warn', 'consecutive failure threshold tripped', {
                        target: r.target, threshold: nextN,
                        last_status: r.status, last_error: r.error,
                    });
                }
            } else {
                if (prev >= cfg.consec_fail_threshold) {
                    log('info', 'service recovered', { target: r.target, prior_fail_run: prev });
                }
                consecFail.set(r.target, 0);
            }
        }
        lastSampleTs = roundIso;

        // ---- once mode ----------------------------------------------------
        if (cfg.once) {
            log('info', 'once mode: exiting after single round', { samples_written: results.length });
            break;
        }

        // ---- weekly receipt window ---------------------------------------
        if (now >= nextWeeklyAt) {
            try {
                const fromIso = startedAtIso;
                const toIso   = nextWeeklyAt.toISOString();
                const samples = sink.readWindow(fromIso, toIso);
                await emitWeeklyReceipt({
                    fromIso,
                    toIso,
                    weekTag: isoWeekTag(nextWeeklyAt),
                    weekNumber,
                    samples,
                    cfg,
                    log,
                });
                weekNumber += 1;
            } catch (err) {
                log('error', 'weekly receipt emit failed (continuing daemon)', {
                    error: err.message, stack: err.stack,
                });
            }
            nextWeeklyAt = nextFriday2355NY(new Date(nextWeeklyAt.getTime() + 60_000));
            log('info', 'next weekly receipt window', { at: nextWeeklyAt.toISOString() });
        }

        // ---- sleep until next sample -------------------------------------
        const roundElapsed = Date.now() - roundStart;
        const sleepMs = Math.max(0, cfg.interval_ms - roundElapsed);
        await interruptibleSleep(sleepMs, () => exiting);
    }

    // ---- end-of-run receipt ------------------------------------------------
    if (!cfg.once && cfg.emit_receipt) {
        try {
            const toIso = new Date().toISOString();
            const samples = sink.readWindow(startedAtIso, toIso);
            const weekN = currentWeekNumber(new Date());
            const { verdict } = await emitWeeklyReceipt({
                fromIso: startedAtIso,
                toIso,
                weekTag: isoWeekTag(startedAt),
                weekNumber: weekN,
                samples,
                cfg,
                log,
            });
            releasePidLock(lockPath);
            return verdict === 'PASS' ? 0 : 1;
        } catch (err) {
            log('error', 'end-of-run receipt emit failed', { error: err.message, stack: err.stack });
            releasePidLock(lockPath);
            return 2;
        }
    }

    releasePidLock(lockPath);
    return 0;
}

function interruptibleSleep(ms, isCancelled) {
    return new Promise((resolve) => {
        const step = 1_000;
        let remaining = ms;
        const tick = () => {
            if (isCancelled()) return resolve();
            if (remaining <= 0) return resolve();
            const slice = Math.min(step, remaining);
            remaining -= slice;
            setTimeout(tick, slice);
        };
        tick();
    });
}

// ---------- entrypoint ------------------------------------------------------

let cfg;
try {
    cfg = parseArgs(process.argv);
} catch (err) {
    process.stderr.write(`real-7d-monitor: ${err.message}\n`);
    printHelp();
    process.exit(2);
}

run(cfg).then((code) => {
    process.exit(code);
}).catch((err) => {
    process.stderr.write(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'fatal',
        actor: 'orange5-endurance-real-7d',
        message: 'unhandled',
        error: err.message,
        stack: err.stack,
    }) + '\n');
    process.exit(2);
});
