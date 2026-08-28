// Anti-fluff gate — flags verbose / hedged / theater text.

const FLUFF_PATTERNS = [
  /\b(in summary|to summarize|in conclusion|to conclude|in essence|essentially|basically)\b/gi,
  /\b(it is important to note that|it should be noted that|note that)\b/gi,
  /\b(i hope this helps|let me know if|feel free to)\b/gi,
  /\b(certainly|absolutely|definitely|of course)\s*[!,.]/gi,
  /\b(unfortunately|regrettably|sadly)\b/gi,
];

const HEDGE_PATTERNS = [
  /\b(might|maybe|perhaps|possibly|presumably|likely|probably)\b/gi,
  /\b(seems to|appears to|tends to|kind of|sort of)\b/gi,
];

/**
 * @param {string} text
 * @returns {{ verdict: 'pass'|'warn'|'reject', fluff_hits: number, hedge_hits: number, snippets: string[] }}
 */
export function antiFluffGate(text) {
  let fluff = 0, hedge = 0;
  const snippets = [];
  for (const re of FLUFF_PATTERNS) {
    const matches = text.match(re);
    if (matches) { fluff += matches.length; snippets.push(...matches); }
  }
  for (const re of HEDGE_PATTERNS) {
    const matches = text.match(re);
    if (matches) { hedge += matches.length; snippets.push(...matches); }
  }
  const total = fluff + hedge;
  let verdict;
  if (total === 0) verdict = "pass";
  else if (total <= 2) verdict = "warn";
  else verdict = "reject";
  return { verdict, fluff_hits: fluff, hedge_hits: hedge, snippets: snippets.slice(0, 10) };
}
