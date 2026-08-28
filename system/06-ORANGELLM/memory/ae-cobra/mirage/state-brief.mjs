// mirage/state-brief.mjs — Mirage Recall API.
// Returns compressed StateBrief JSON for OrangeLLM memory queries.
// Reality always overrides Thought on conflict. Receipts override recollection.

import { readFluxTail } from '../flux/reader.mjs';

export function computeStateBrief({ fluxRoot, query, timeRangeMs = 86_400_000 * 7, maxRecords = 50, includeConflicts = true }) {
  const endMs = Date.now();
  const startMs = endMs - timeRangeMs;

  const realityRecords = readFluxTail({ fluxRoot, lanes: ['reality'], startMs, endMs, maxRecords: maxRecords * 4 });
  const thoughtRecords = readFluxTail({ fluxRoot, lanes: ['thought'], startMs, endMs, maxRecords: maxRecords * 4 });

  const lowerQuery = (query || '').toLowerCase().trim();
  const queryTerms = tokenize(lowerQuery);
  const isRecallable = (rec) => typeof rec.body?.summary === 'string' && rec.body.summary.trim().length > 0;
  const rankRecords = (records) => {
    const recallable = records.filter(isRecallable);
    if (!lowerQuery) return recallable.slice(-maxRecords).map(toCite);

    const minimumHits = queryTerms.length <= 3 ? 1 : 2;
    return recallable
      .map((rec) => {
        const bodyText = JSON.stringify(rec.body || {}).toLowerCase();
        const summary = (rec.body?.summary || '').toLowerCase();
        const entityText = (rec.body?.entities || []).join(' ').toLowerCase();
        const bodyHits = queryTerms.filter((term) => bodyText.includes(term));
        const summaryHits = queryTerms.filter((term) => summary.includes(term)).length;
        const entityHits = queryTerms.filter((term) => entityText.includes(term)).length;
        const exact = bodyText.includes(lowerQuery) || summary.includes(lowerQuery) || entityText.includes(lowerQuery);
        const coverage = queryTerms.length ? bodyHits.length / queryTerms.length : 0;
        const score = (exact ? 100 : 0) + (bodyHits.length * 10) + (summaryHits * 4) + (entityHits * 2) + coverage;
        return { rec, bodyHits, exact, score };
      })
      .filter((item) => item.exact || item.bodyHits.length >= minimumHits)
      .sort((a, b) => b.score - a.score || Number(b.rec.ts || 0) - Number(a.rec.ts || 0))
      .slice(0, maxRecords)
      .map((item) => toCite(item.rec));
  };

  const reality = rankRecords(realityRecords);
  const thought = rankRecords(thoughtRecords);

  const conflicts = [];
  if (includeConflicts) {
    for (const r of reality) {
      for (const t of thought) {
        if (sharesEntity(r, t) && opposed(r, t)) {
          conflicts.push({
            reality_id: r.id,
            reality_summary: r.summary,
            thought_id: t.id,
            thought_summary: t.summary,
            resolution: 'reality_wins',
          });
        }
      }
    }
  }

  return {
    schema: 'orange5.state-brief.v0',
    query,
    time_range: { start_ms: startMs, end_ms: endMs },
    reality,
    thought,
    conflicts: conflicts.slice(0, 20),
    recommended_next_action: deriveNextAction(reality, thought),
    confidence: reality.length === 0 && thought.length === 0 ? 0 : Math.min(1, (reality.length * 0.7 + thought.length * 0.3) / 10),
    retrieval: {
      method: 'deterministic_ranked_token_overlap_v1',
      query_terms: queryTerms,
      minimum_hits: queryTerms.length <= 3 ? 1 : 2,
      reality_candidates: realityRecords.filter(isRecallable).length,
      thought_candidates: thoughtRecords.filter(isRecallable).length,
    },
    generated_at: new Date().toISOString(),
  };
}

function tokenize(text) {
  const stop = new Set([
    'according', 'anything', 'could', 'from', 'have', 'injected', 'into',
    'just', 'memory', 'orange', 'report', 'should', 'that', 'their', 'there',
    'these', 'they', 'this', 'using', 'what', 'when', 'where', 'which', 'why',
    'with', 'would', 'your',
  ]);
  return [...new Set((String(text).toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) || [])
    .filter((token) => !stop.has(token)))];
}

function toCite(rec) {
  const body = rec.body || {};
  return {
    id: rec.hash?.slice(0, 12) || 'unknown',
    ts: rec.ts,
    lane: rec.lane,
    origin: rec.origin,
    kind: rec.kind,
    summary: body.summary || '',
    entities: body.entities || [],
    files: body.files || [],
    commands: (body.commands || []).slice(0, 5),
    risk: body.risk || null,
    next_action: body.next_action || null,
    confidence: body.confidence ?? null,
    source_pointer: {
      ledger: 'ae-cobra-flux',
      lane: rec.lane,
      ts: rec.ts,
      hash: rec.hash || null,
    },
  };
}

function sharesEntity(a, b) {
  const setA = new Set((a.entities || []).map(s => s.toLowerCase()));
  return (b.entities || []).some(e => setA.has(e.toLowerCase()));
}

function opposed(reality, thought) {
  // Crude Night-1 heuristic: reality says event_type=observation/receipt + thought says decision about same entity
  const realityKinds = new Set(['observation', 'receipt']);
  return realityKinds.has(reality.kind) && thought.kind === 'decision';
}

function deriveNextAction(reality, thought) {
  if (reality.length === 0 && thought.length === 0) return 'no memory found for query';
  if (reality.length > 0) {
    const r = reality[0];
    return `best grounded reality event: ${r.summary || r.kind}`;
  }
  const t = thought[0];
  return `best matching thought: ${t.summary || t.kind} (no reality grounding)`;
}
