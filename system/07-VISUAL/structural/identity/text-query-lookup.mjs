// text-query-lookup.mjs — Wave 3b.
//
// Given a text query and a transcript-index (built by transcript-binding.mjs),
// return the concept fingerprints (from an identity-store) whose transcript
// lexicon best matches the query.
//
// Zero LLM inference. Pure token overlap with TF-IDF scoring.
//
// Usage:
//   import { queryTextForConcepts } from "./text-query-lookup.mjs";
//   const matches = queryTextForConcepts("show me a cat", transcriptIndex);
//   // matches[0] = { label, score, matched_tokens }

const STOPWORDS = new Set([
  "the","a","an","and","or","but","if","then","when","of","in","on","at","to","for","with","by","from",
  "is","was","are","were","be","been","being","have","has","had","do","does","did","will","would","should",
  "could","can","may","might","must","shall","this","that","these","those","i","you","he","she","it","we",
  "they","me","him","her","us","them","my","your","his","its","our","their","what","which","who","how",
  "why","because","also","so","just","not","no","yes","up","down","out","over","under","again","very","get",
  "show","find","look","tell","give","want","need","help","please",
]);

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
}

/**
 * Query the transcript index for concept matches.
 *
 * @param {string} query        natural-language query
 * @param {object} index        transcript-index built by transcript-binding.mjs
 * @param {object} [opts]
 *   opts.topK — return at most K concepts (default 5)
 *   opts.minScore — require score above this (default 0.1)
 * @returns {Array<{label, score, matched_tokens}>}
 */
export function queryTextForConcepts(query, index, opts = {}) {
  const topK = opts.topK ?? 5;
  const minScore = opts.minScore ?? 0.1;
  const qTokens = tokenize(query);
  if (!qTokens.length) return [];

  const totalConcepts = index.concept_count || 1;
  const scores = new Map();  // label → { score, matched_tokens }

  for (const qToken of qTokens) {
    const conceptsForToken = index.token_to_concepts?.[qToken];
    if (!conceptsForToken) continue;
    const df = Object.keys(conceptsForToken).length;
    const idf = Math.log(totalConcepts / df);
    for (const [label, tf] of Object.entries(conceptsForToken)) {
      const s = scores.get(label) || { score: 0, matched_tokens: [] };
      s.score += tf * idf;
      s.matched_tokens.push(qToken);
      scores.set(label, s);
    }
  }

  const ranked = [...scores.entries()]
    .map(([label, s]) => ({ label, score: s.score, matched_tokens: s.matched_tokens }))
    .filter(x => x.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return ranked;
}

/**
 * Given a text query, look up matching concepts in the transcript index,
 * then return their identity-store signatures.
 *
 * @param {string} query
 * @param {object} store       identity-store-v2
 * @param {object} index       transcript-index
 * @returns {Array<{label, score, matched_tokens, signatures}>}
 */
export function queryTextForFingerprints(query, store, index, opts = {}) {
  const matches = queryTextForConcepts(query, index, opts);
  return matches.map(m => {
    const row = store.labels?.find(r => r.label === m.label);
    return { ...m, signatures: row?.signatures ?? [] };
  });
}
