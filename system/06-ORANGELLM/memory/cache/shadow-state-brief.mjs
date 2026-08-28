// shadow-state-brief.mjs — Compute a StateBrief from the N150 shadow cache.
//
// Same shape as the live Æ Cobra /state-brief response, plus:
//   shadow:        true
//   last_sync_at:  ISO string of the last successful shadow sync
//   freshness:     classification + age_ms (fresh|aging|stale|unknown)
//
// The gateway calls this when the Cobra daemon at 127.0.0.1:7419 is
// unreachable. Output is drop-in compatible for the auto-inject (Option C)
// system-message path and the <recall>{query}</recall> deeper-brief path.
//
// Mirage doctrine reminder:
//   - Reality (reality + receipts lanes) overrides Thought (thought lane)
//     on conflict. We surface open conflicts explicitly.
//   - This brief is mirage/memory shadow. Caller MUST mark shadow=true to
//     the model so it knows it is consuming cached, not live, memory.

import { readShadowCache } from './shadow-reader.mjs';

const DEFAULT_LIMITS = {
  reality: 5,
  thought: 3,
  conflicts: 5,
  receipts: 3,
};

// ---- helpers ----------------------------------------------------------------

function pickLine(rec) {
  // Compress a Flux event to a single-line bullet for the system message.
  // Tolerate several known shapes (Cobra emits one of these for reality/thought/receipts).
  const ts = rec.ts;
  const iso = ts ? new Date(ts).toISOString() : '';
  const kind = rec.kind || rec.type || rec.event || rec.lane || '';
  const subject = rec.subject || rec.topic || rec.key || rec.target || '';
  const summary =
    rec.summary ||
    rec.text ||
    rec.message ||
    rec.decision ||
    rec.note ||
    rec.title ||
    '';
  const id = rec.id || rec.event_id || '';

  const parts = [];
  if (iso) parts.push(iso);
  if (kind) parts.push(`[${kind}]`);
  if (subject) parts.push(subject);
  if (summary) parts.push('— ' + String(summary).slice(0, 240));
  if (id) parts.push(`(${id})`);
  return parts.join(' ').trim();
}

function topN(lane, recs, n) {
  // records arrive newest-first from shadow-reader
  return recs.slice(0, n).map(pickLine).filter(Boolean);
}

function detectOpenConflicts(by_lane, limit) {
  // 1. Explicit conflicts lane wins.
  const explicit = by_lane.conflicts || [];
  const open = explicit
    .filter((r) => r.status !== 'resolved' && r.resolved !== true)
    .slice(0, limit);
  if (open.length) return open.map(pickLine);

  // 2. Fallback heuristic: thought event whose subject matches a reality
  //    event with a different decision/value field within the window.
  const realityBySubject = new Map();
  for (const r of by_lane.reality || []) {
    const subj = r.subject || r.topic || r.key;
    if (!subj) continue;
    if (!realityBySubject.has(subj)) realityBySubject.set(subj, r);
  }
  const heuristic = [];
  for (const t of by_lane.thought || []) {
    const subj = t.subject || t.topic || t.key;
    if (!subj) continue;
    const r = realityBySubject.get(subj);
    if (!r) continue;
    const tv = t.decision ?? t.value ?? t.summary;
    const rv = r.decision ?? r.value ?? r.summary;
    if (tv && rv && String(tv) !== String(rv)) {
      heuristic.push(
        `${new Date(t.ts).toISOString()} CONFLICT subject="${subj}" thought="${String(
          tv,
        ).slice(0, 120)}" vs reality="${String(rv).slice(0, 120)}" (reality overrides)`,
      );
      if (heuristic.length >= limit) break;
    }
  }
  return heuristic;
}

// ---- public API -------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string}   [opts.query]        Optional focus query (for <recall> path).
 * @param {number}   [opts.windowMs]     Time window. Default 24h.
 * @param {object}   [opts.limits]       Per-lane top-N caps. Default DEFAULT_LIMITS.
 * @param {number}   [opts.now]          For testability.
 * @returns {Promise<object>}            StateBrief.
 */
export async function computeStateBrief(opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : 24 * 60 * 60 * 1000;
  const limits = { ...DEFAULT_LIMITS, ...(opts.limits || {}) };
  const lanes = ['reality', 'thought', 'receipts', 'conflicts'];

  // Pull enough headroom for query filtering then trim.
  const cache = await readShadowCache({
    lanes,
    startMs: now - windowMs,
    endMs: now,
    maxRecords: 5000,
  });

  let { by_lane } = cache;

  // Apply query filter if present (case-insensitive substring on common fields).
  if (opts.query && typeof opts.query === 'string' && opts.query.trim()) {
    const q = opts.query.trim().toLowerCase();
    const matches = (r) => {
      const haystacks = [
        r.summary,
        r.text,
        r.message,
        r.subject,
        r.topic,
        r.key,
        r.decision,
        r.note,
        r.title,
        r.kind,
        r.type,
      ];
      for (const h of haystacks) {
        if (h && String(h).toLowerCase().includes(q)) return true;
      }
      return false;
    };
    by_lane = Object.fromEntries(
      Object.entries(by_lane).map(([l, recs]) => [l, recs.filter(matches)]),
    );
  }

  const reality = topN('reality', by_lane.reality || [], limits.reality);
  const thought = topN('thought', by_lane.thought || [], limits.thought);
  const receipts = topN('receipts', by_lane.receipts || [], limits.receipts);
  const conflicts = detectOpenConflicts(by_lane, limits.conflicts);

  const brief = {
    // identical shape to live /state-brief response
    generated_at: new Date(now).toISOString(),
    window_ms: windowMs,
    query: opts.query || null,
    reality,
    thought,
    receipts,
    open_conflicts: conflicts,
    counts: {
      reality: (by_lane.reality || []).length,
      thought: (by_lane.thought || []).length,
      receipts: (by_lane.receipts || []).length,
      conflicts: (by_lane.conflicts || []).length,
    },

    // shadow-only fields
    shadow: true,
    last_sync_at: cache.freshness.last_sync_at,
    last_sync_ms: cache.freshness.last_sync_ms,
    freshness: {
      classification: cache.freshness.classification,
      age_ms: cache.freshness.age_ms,
      stale: cache.freshness.stale,
      per_lane: cache.freshness.by_lane,
    },
    source: 'shadow-cache',
  };

  return brief;
}

/**
 * Format the brief as the system-role message body that the gateway
 * auto-injects on every chat completion (Option C hybrid).
 * Keep this short and unambiguous.
 */
export function formatBriefAsSystemMessage(brief) {
  const lines = [];
  lines.push('[MEMORY:SHADOW]');
  lines.push(
    `source=shadow-cache last_sync_at=${brief.last_sync_at || 'never'} ` +
      `freshness=${brief.freshness?.classification || 'unknown'}` +
      (brief.freshness?.stale ? ' STALE>2h' : ''),
  );
  if (brief.query) lines.push(`query="${brief.query}"`);

  if (brief.reality.length) {
    lines.push('Reality (last 5):');
    for (const r of brief.reality) lines.push(`  - ${r}`);
  }
  if (brief.thought.length) {
    lines.push('Thought (last 3):');
    for (const r of brief.thought) lines.push(`  - ${r}`);
  }
  if (brief.open_conflicts.length) {
    lines.push('Open conflicts (reality overrides thought):');
    for (const r of brief.open_conflicts) lines.push(`  - ${r}`);
  }
  if (brief.receipts.length) {
    lines.push('Receipts (last 3):');
    for (const r of brief.receipts) lines.push(`  - ${r}`);
  }
  lines.push(
    'Rule: Reality + Receipts override Thought on any conflict. Cache is shadow; live Cobra unavailable.',
  );
  return lines.join('\n');
}

export const __test__ = { pickLine, detectOpenConflicts };
