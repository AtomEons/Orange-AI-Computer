// air-codec/codec.mjs
//
// AtomSmasher module — AIR Codec (Anti-Inflation Recursive).
//
// Purpose:
//   Compress verbose model output to dense information per byte. The codec
//   does NOT do statistical compression (we are not gzipping). It does
//   STRUCTURAL compression: it lifts out the load-bearing pieces of an
//   answer (facts, claims, citations, numbers, dates, identifiers, code
//   spans, decisions, questions) and drops the connective tissue that
//   carries no information per byte (hedges, fluff, throat-clearing,
//   ceremonial closers, pleasantries, transitional filler, duplicate
//   sentences). The output is a typed frame; the input prose is no longer
//   the source of truth, the frame is.
//
// Doctrine:
//   - Frames are content-addressed. `frame_id` is sha256 over canonical-JSON
//     of the extracted slots ONLY (not created_at, not source_hash). Two
//     callers compressing semantically identical input get identical
//     frame_ids — the same property Commitment Atoms have.
//   - Compression is lossy by design. The original prose is NOT stored.
//     `source_hash` lets a receipt holder prove what was fed in if they
//     still hold the input. The codec's job is information density, not
//     archival.
//   - Decompression reconstructs a READABLE rendition from the structured
//     slots. It is NOT byte-identical to the source and we do not pretend
//     it is. Anyone hashing the decompressed prose is using the codec
//     wrong; hash the frame.
//   - Anti-fluff doctrine: this codec ENFORCES the LIVE Anti-fluff Gate's
//     judgments — text classified as hedge/fluff/transition/pleasantry is
//     dropped, not kept. Compression debt = chars dropped. This module
//     emits the audit slot the Compression Debt Ledger module will consume.
//   - Zero deps. Matches Anti-fluff Gate + Commitment Atoms style.
//
// This file is the pure encoder/decoder. Persistence, gateway routes, and
// telemetry belong to sibling modules.

import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FRAME_SCHEMA_ID = 'orange5.atomsmasher.air-frame.v0';

// Hedge / certainty signals — borrowed from the Anti-fluff Gate so the two
// modules agree on what counts as a hedge. Kept inline (not imported) so the
// codec can stand alone if Anti-fluff is unavailable, but the lists are
// kept in sync intentionally.
const HEDGE_WORDS = Object.freeze([
  'might', 'maybe', 'perhaps', 'possibly', 'presumably',
  'likely', 'probably', 'arguably', 'reportedly', 'allegedly',
]);

const SPECULATIVE_MARKERS = Object.freeze([
  'speculative', 'hypothetical', 'imagine if', "what if",
  'in theory', 'conjecture', 'rumor has it',
]);

// Fluff sentence-openers and transitions that carry zero information per byte.
// If a sentence matches one of these at its head, the head is stripped before
// kernel extraction; if the sentence is ONLY the fluff, the whole sentence is
// dropped to the residue auditor as 'fluff'.
const FLUFF_PREFIXES = Object.freeze([
  /^(in summary|to summarize|in conclusion|to conclude|in essence|essentially|basically),?\s+/i,
  /^(it is important to note that|it should be noted that|note that|note,|notably,)\s*/i,
  /^(i hope this helps|let me know if|feel free to|please don't hesitate)[^.]*\.?\s*/i,
  /^(certainly|absolutely|definitely|of course|sure|great question)[!,.]?\s*/i,
  /^(unfortunately|regrettably|sadly),?\s+/i,
  /^(as you (?:may know|might know|probably know|already know))[,.]?\s*/i,
  /^(at the end of the day|when all is said and done|all things considered),?\s+/i,
]);

const TRANSITION_PREFIXES = Object.freeze([
  /^(furthermore|moreover|additionally|in addition|on top of that),?\s+/i,
  /^(however|nevertheless|nonetheless|that said|having said that),?\s+/i,
  /^(first(?:ly)?|second(?:ly)?|third(?:ly)?|finally|lastly),?\s+/i,
]);

const PLEASANTRY_PATTERNS = Object.freeze([
  /\bthank(?:s| you)(?: so much| very much)?[.!]?/gi,
  /\byou'?re welcome[.!]?/gi,
  /\bhope this helps[.!]?/gi,
  /\bhappy to (?:help|assist)[.!]?/gi,
]);

const SELF_REFERENCE_PATTERNS = Object.freeze([
  /\b(?:as an (?:ai|assistant|llm)|i'?m (?:an? )?(?:ai|assistant|language model))[^.]*\./gi,
  /\bi (?:do not|don'?t) have (?:access to|the ability to)[^.]*\./gi,
  /\bmy (?:knowledge|training) (?:cutoff|cut-off|cut off)[^.]*\./gi,
]);

// Identifier-shaped tokens: CamelCase, snake_case_words, dotted.paths,
// SCREAMING_SNAKE, hex hashes, brand-style tokens. The codec preserves these
// verbatim so reconstruction never paraphrases them.
const IDENTIFIER_RE = /\b(?:[A-Z][a-z]+(?:[A-Z][a-z]+)+|[a-zA-Z][a-zA-Z0-9_]*_[a-zA-Z0-9_]+|[a-z]+(?:\.[a-z][a-zA-Z0-9_]*){1,}|[A-Z]{2,}(?:_[A-Z0-9]+)*|[0-9a-f]{8,64})\b/g;

// Numbers: integers, decimals, percentages, currency, ranges. Captured with
// a small trailing unit window to keep units attached.
const NUMBER_RE = /(-?\d+(?:[,_]\d{3})*(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*([%]|[A-Za-z][A-Za-z%/\-]{0,15})?/g;

// Currency-prefixed numbers ($1.2M, €500, £42k) — captured separately so the
// unit lands as the currency symbol.
const CURRENCY_RE = /([$€£¥₹])\s*(-?\d+(?:[,_]\d{3})*(?:\.\d+)?)\s*([KkMmBbTt])?/g;

// Citations
const URL_RE = /\bhttps?:\/\/[^\s)>\]"']+/gi;
const DOI_RE = /\b10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/g;
const ARXIV_RE = /\barXiv:\s*(\d{4}\.\d{4,5})(v\d+)?\b/gi;
const RFC_RE = /\bRFC\s?\d{3,5}\b/g;
const STATUTE_RE = /\b\d+\s+U\.?S\.?C\.?\s+§?\s?\d+(?:\([a-z0-9]+\))?\b/g;
const ISSUE_RE = /\b(?:#|GH-|gh-)(\d{2,7})\b/g;
// PATH: Windows-drive paths OR POSIX paths with 2+ segments. Use a leading
// (?:^|[\s(]) anchor instead of \b because `/` is non-word and \b won't fire
// between a space and a `/`.
const PATH_RE = /(?:^|[\s(])([A-Za-z]:[\\/][^\s)>\]"']+|\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._\-]+){1,})(?=[\s).,;:?!]|$)/g;

// Dates: ISO 8601 (with optional time), Month DD YYYY, DD Month YYYY, YYYY-MM, etc.
const ISO_DATE_RE = /\b(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?)?\b/g;
const MONTH_NAMES = [
  'january','february','march','april','may','june',
  'july','august','september','october','november','december',
];
const SHORT_MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const MONTH_DAY_YEAR_RE = new RegExp(
  '\\b(' + MONTH_NAMES.concat(SHORT_MONTHS).join('|') + ')\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b',
  'gi',
);
const DAY_MONTH_YEAR_RE = new RegExp(
  '\\b(\\d{1,2})\\s+(' + MONTH_NAMES.concat(SHORT_MONTHS).join('|') + ')\\.?\\s+(\\d{4})\\b',
  'gi',
);

// Code fences (```lang ... ```), inline backtick spans.
const FENCED_CODE_RE = /```([A-Za-z0-9_+-]*)\n([\s\S]*?)```/g;
const INLINE_CODE_RE = /`([^`\n]{1,512})`/g;

// Decision verbs at sentence head (kept narrow to avoid false positives).
const DECISION_VERBS = Object.freeze([
  /^(?:we|i|the team|the system) (?:will|shall|are going to|'?re going to|plan to|commit to|intend to|decide to|have decided to|hereby)\s+/i,
  /^(?:ship(?:ping)?|deploy(?:ing)?|launch(?:ing)?|deliver(?:ing)?|cut(?:ting)?|rule(?:ing| out)?) /i,
  /^(?:by|before|no later than)\s+\d{4}/i,
]);

// Question detector
const QUESTION_RE = /\?\s*$/;

// ---------------------------------------------------------------------------
// Canonical JSON + hashing (matches Commitment Atoms convention)
// ---------------------------------------------------------------------------

function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalStringify).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(value[k])).join(',') + '}';
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// ---------------------------------------------------------------------------
// Lexical helpers
// ---------------------------------------------------------------------------

/**
 * Split prose into sentences. Not a parser — a heuristic tuned for model
 * output: respect terminal punctuation, keep abbreviations attached (Dr.,
 * Mr., Inc., e.g., i.e.), keep decimal numbers intact, keep ellipses
 * attached. Code fences are pulled out BEFORE this is called.
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitSentences(text) {
  if (!text) return [];
  const ABBREVIATIONS = new Set([
    'mr','mrs','ms','dr','prof','sr','jr','st',
    'inc','co','ltd','corp','llc','etc','vs','vol','no',
    'eg','ie','cf','approx','est','min','max','avg',
    'al', // et al.
  ]);
  const out = [];
  let buf = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    buf += ch;
    if (ch === '.' || ch === '!' || ch === '?') {
      // Check whether this period closes a sentence or just an abbreviation.
      const next = text[i + 1] || '';
      // ellipsis -> keep accumulating
      if (text[i + 1] === '.' && text[i + 2] === '.') continue;
      if (ch === '.') {
        // Pull the last token, see if it's an abbreviation.
        const m = buf.match(/(?:^|\s)([A-Za-z]+)\.$/);
        if (m && ABBREVIATIONS.has(m[1].toLowerCase())) continue;
        // decimal numbers: 3.14 — already handled because '.' is mid-token
        // and the next char is a digit, not whitespace.
        if (/\d/.test(next)) continue;
      }
      // Sentence terminator. Consume whitespace and push.
      const trimmed = buf.trim();
      if (trimmed) out.push(trimmed);
      buf = '';
    } else if (ch === '\n' && /\n\s*\n/.test(text.slice(i, i + 3))) {
      // Blank line ends a sentence even without terminal punctuation
      // (markdown paragraph break).
      const trimmed = buf.trim();
      if (trimmed) out.push(trimmed);
      buf = '';
    }
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

/**
 * Classify a sentence's certainty cue based on hedge words and speculative
 * markers. Used to set `claims[].confidence`.
 *
 * @param {string} sentence
 * @returns {'asserted'|'hedged'|'speculative'|null}
 */
function classifyConfidence(sentence) {
  const lc = sentence.toLowerCase();
  for (const marker of SPECULATIVE_MARKERS) {
    if (lc.includes(marker)) return 'speculative';
  }
  // Count hedge words; >=1 is hedged.
  for (const w of HEDGE_WORDS) {
    if (new RegExp('\\b' + w + '\\b', 'i').test(lc)) return 'hedged';
  }
  // Look for assertive verbs.
  if (/\b(?:is|are|was|were|will|must|shall|always|never)\b/i.test(lc)) return 'asserted';
  return null;
}

/**
 * Strip a fluff/transition prefix from a sentence, returning {stripped,
 * removedChars, removedTags}. If the sentence is ONLY fluff (nothing left
 * after stripping), `stripped` is the empty string.
 */
function stripPrefixes(sentence) {
  let s = sentence;
  let removed = 0;
  const tags = [];
  for (const re of FLUFF_PREFIXES) {
    const m = s.match(re);
    if (m) {
      removed += m[0].length;
      s = s.slice(m[0].length);
      tags.push('fluff');
    }
  }
  for (const re of TRANSITION_PREFIXES) {
    const m = s.match(re);
    if (m) {
      removed += m[0].length;
      s = s.slice(m[0].length);
      tags.push('transition');
    }
  }
  return { stripped: s, removedChars: removed, removedTags: tags };
}

/**
 * Strip in-line pleasantries and self-references. Returns {cleaned, drops}
 * where drops is { tag: charCount } accumulated.
 */
function scrubInline(sentence) {
  let s = sentence;
  const drops = { pleasantry: 0, self_reference: 0 };
  for (const re of PLEASANTRY_PATTERNS) {
    s = s.replace(re, (m) => {
      drops.pleasantry += m.length;
      return '';
    });
  }
  for (const re of SELF_REFERENCE_PATTERNS) {
    s = s.replace(re, (m) => {
      drops.self_reference += m.length;
      return '';
    });
  }
  return { cleaned: s.replace(/\s{2,}/g, ' ').trim(), drops };
}

/**
 * Try to ISO-normalize a date string. Returns ISO string or null. We do not
 * pull in a date library — only handle the shapes our regexes captured.
 */
function tryIso(raw, components) {
  // components for ISO_DATE_RE: full match, date, time, tz
  if (components && components.date) {
    const d = components.date;
    const t = components.time ? `T${components.time}${components.tz || 'Z'}` : '';
    const candidate = `${d}${t}`;
    if (!Number.isNaN(Date.parse(candidate))) return candidate;
  }
  if (components && components.year && components.monthIdx != null && components.day) {
    const mm = String(components.monthIdx + 1).padStart(2, '0');
    const dd = String(components.day).padStart(2, '0');
    const iso = `${components.year}-${mm}-${dd}`;
    if (!Number.isNaN(Date.parse(iso))) return iso;
  }
  if (!Number.isNaN(Date.parse(raw))) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return null;
}

function monthIndex(name) {
  const lc = name.toLowerCase().replace(/\.$/, '');
  let idx = MONTH_NAMES.indexOf(lc);
  if (idx >= 0) return idx;
  idx = SHORT_MONTHS.indexOf(lc);
  return idx;
}

/**
 * Build a short context window (≤120 chars) around a match within its
 * sentence. Used for citations / numbers / dates.
 */
function contextWindow(sentence, matchStart, matchLen) {
  // Tight radius. The structured slots ARE the information; context is just
  // a breadcrumb pointing back to the sentence. Bigger windows duplicate
  // prose and tank the compression ratio.
  const radius = 12;
  const start = Math.max(0, matchStart - radius);
  const end = Math.min(sentence.length, matchStart + matchLen + radius);
  let ctx = sentence.slice(start, end).trim();
  if (start > 0) ctx = '…' + ctx;
  if (end < sentence.length) ctx = ctx + '…';
  return ctx.slice(0, 64);
}

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

/**
 * Pull fenced + inline code spans out of text. Returns {stripped, spans}
 * where stripped has the spans replaced with single-space placeholders so
 * the rest of the pipeline doesn't see code as prose.
 */
function extractCode(text) {
  const spans = [];
  let s = text.replace(FENCED_CODE_RE, (_m, lang, body) => {
    spans.push({ text: body.replace(/\s+$/, ''), lang: lang || null });
    return ' ';
  });
  s = s.replace(INLINE_CODE_RE, (_m, body) => {
    spans.push({ text: body, lang: null });
    return ' ';
  });
  return { stripped: s, spans };
}

/**
 * Extract all citation tokens from the FULL prose (pre-sentence-split) and
 * replace each hit with a stable placeholder. The placeholders are inert
 * tokens that survive sentence splitting and identifier extraction, so
 * URLs, statutes, and paths can never be fragmented mid-token. The
 * placeholder itself is not emitted in any output slot.
 *
 * Order matters: URL first (because URLs contain DOI-shaped fragments,
 * arXiv-shaped fragments, and path-shaped fragments), then DOI, arXiv,
 * RFC, statute, issue, path.
 *
 * @param {string} text
 * @returns {{ stripped: string, citations: Array<{ref, kind, context}> }}
 */
function extractCitationsGlobal(text) {
  const citations = [];
  const seen = new Set();
  let work = text;

  const ORDERED = [
    [URL_RE, 'url'],
    [DOI_RE, 'doi'],
    [ARXIV_RE, 'arxiv'],
    [RFC_RE, 'rfc'],
    [STATUTE_RE, 'statute'],
    [ISSUE_RE, 'issue'],
    [PATH_RE, 'path'],
  ];

  for (const [re, kind] of ORDERED) {
    // Reset because regexes are stateful (global flag).
    re.lastIndex = 0;
    work = work.replace(re, (match, ...rest) => {
      // PATH_RE captures into group 1 (the path itself) because of the
      // leading non-capturing anchor. Other regexes use the full match.
      let ref;
      let leading = '';
      if (kind === 'path') {
        // rest is [g1, ..., offset, fullString] — pull g1 and re-prepend the
        // separator the anchor consumed.
        const g1 = rest[0];
        const fullMatch = match;
        leading = fullMatch.slice(0, fullMatch.length - g1.length);
        ref = g1;
      } else {
        ref = match;
      }
      const key = `${kind}::${ref}`;
      if (!seen.has(key)) {
        seen.add(key);
        // Build context window from ORIGINAL text — find ref in original.
        const origIdx = text.indexOf(ref);
        const ctx = origIdx >= 0 ? contextWindow(text, origIdx, ref.length) : ref;
        citations.push({ ref, kind, context: ctx });
      }
      // Replace with a placeholder of equal "non-tokenness" so sentence
      // splitting still works. A single space keeps positions stable enough.
      return leading + ' [[CIT]] ';
    });
  }

  return { stripped: work, citations };
}

function extractCitations(sentence) {
  // Per-sentence variant retained for unit testing __internals.
  return extractCitationsGlobal(sentence).citations;
}

/**
 * Extract numeric values. Skips positions already consumed by date matches
 * (so "2026-06-15" doesn't produce ghost numbers 2026, -6, -15) and by
 * currency matches (so "$1.2M" doesn't double-emit as "1.2"). Also drops
 * numbers that look like bare years inside Month-DD-YYYY phrases.
 *
 * @param {string} sentence
 * @param {Set<number>} [reservedPositions] character indexes already claimed
 *   by another extractor (dates, code, citations). Numbers overlapping a
 *   reserved span are dropped.
 */
function extractNumbers(sentence, reservedPositions) {
  const out = [];
  const consumed = new Set(reservedPositions || []);
  let m;

  // 1) Currency first: $1.2M -> value 1_200_000, unit '$'.
  CURRENCY_RE.lastIndex = 0;
  while ((m = CURRENCY_RE.exec(sentence)) !== null) {
    if (consumed.has(m.index)) continue;
    const [full, sym, num, scale] = m;
    const raw = Number(num.replace(/[,_]/g, ''));
    const mult = scale ? { k: 1e3, K: 1e3, m: 1e6, M: 1e6, b: 1e9, B: 1e9, t: 1e12, T: 1e12 }[scale] : 1;
    if (!Number.isNaN(raw)) {
      out.push({
        value: raw * mult,
        unit: sym,
        context: contextWindow(sentence, m.index, full.length),
      });
      for (let i = m.index; i < m.index + full.length; i++) consumed.add(i);
    }
  }

  // 2) Plain numbers, skipping anything that overlaps a consumed span.
  NUMBER_RE.lastIndex = 0;
  while ((m = NUMBER_RE.exec(sentence)) !== null) {
    const [full, numStr, unit] = m;
    let overlap = false;
    for (let i = m.index; i < m.index + numStr.length; i++) {
      if (consumed.has(i)) { overlap = true; break; }
    }
    if (overlap) continue;
    const v = Number(numStr.replace(/[,_]/g, ''));
    if (Number.isNaN(v)) continue;
    // Skip bare sentence-numbering ("1." at start)
    if (m.index === 0 && /^\d+\.$/.test(numStr + (sentence[m.index + numStr.length] || ''))) continue;
    out.push({
      value: v,
      unit: unit && unit.trim().length ? unit.trim() : null,
      context: contextWindow(sentence, m.index, full.length),
    });
    for (let i = m.index; i < m.index + full.length; i++) consumed.add(i);
  }
  return out;
}

function extractDates(sentence) {
  const out = [];
  const positions = new Set();
  const seen = new Set();
  const claim = (start, len) => { for (let i = start; i < start + len; i++) positions.add(i); };
  ISO_DATE_RE.lastIndex = 0;
  let m;
  while ((m = ISO_DATE_RE.exec(sentence)) !== null) {
    const [full, date, time, tz] = m;
    const iso = tryIso(full, { date, time, tz });
    if (!seen.has(full)) {
      seen.add(full);
      out.push({ raw: full, iso, context: contextWindow(sentence, m.index, full.length) });
    }
    claim(m.index, full.length);
  }
  MONTH_DAY_YEAR_RE.lastIndex = 0;
  while ((m = MONTH_DAY_YEAR_RE.exec(sentence)) !== null) {
    const [full, mon, day, year] = m;
    const iso = tryIso(full, { year, monthIdx: monthIndex(mon), day: Number(day) });
    if (!seen.has(full)) {
      seen.add(full);
      out.push({ raw: full, iso, context: contextWindow(sentence, m.index, full.length) });
    }
    claim(m.index, full.length);
  }
  DAY_MONTH_YEAR_RE.lastIndex = 0;
  while ((m = DAY_MONTH_YEAR_RE.exec(sentence)) !== null) {
    const [full, day, mon, year] = m;
    const iso = tryIso(full, { year, monthIdx: monthIndex(mon), day: Number(day) });
    if (!seen.has(full)) {
      seen.add(full);
      out.push({ raw: full, iso, context: contextWindow(sentence, m.index, full.length) });
    }
    claim(m.index, full.length);
  }
  return { dates: out, positions };
}

function extractIdentifiers(sentence) {
  const out = new Set();
  IDENTIFIER_RE.lastIndex = 0;
  let m;
  while ((m = IDENTIFIER_RE.exec(sentence)) !== null) {
    // Skip pure numeric matches that the number extractor will own
    if (/^\d+$/.test(m[0])) continue;
    out.add(m[0]);
  }
  return [...out];
}

function isDecisionSentence(sentence) {
  for (const re of DECISION_VERBS) {
    if (re.test(sentence)) return true;
  }
  return false;
}

function isQuestionSentence(sentence) {
  return QUESTION_RE.test(sentence);
}

/**
 * Heuristically distinguish fact vs claim. A FACT is asserted ("X is Y"
 * with no hedge) AND grounded by a citation OR a number OR a date OR an
 * identifier in the same sentence. Otherwise it's a CLAIM.
 *
 * This is a deliberate, narrow rule. Calling more sentences "claims" than
 * "facts" is the conservative direction — claims are wrapped with
 * confidence so downstream consumers know the codec didn't certify them.
 */
function classifyAssertion(sentence, hasGrounding) {
  const conf = classifyConfidence(sentence);
  if (conf === 'asserted' && hasGrounding) return { slot: 'facts', confidence: 'asserted' };
  return { slot: 'claims', confidence: conf };
}

// ---------------------------------------------------------------------------
// Compress
// ---------------------------------------------------------------------------

/**
 * Compress verbose text to an AIR frame.
 *
 * @param {string} input
 * @param {Object} [opts]
 * @param {number} [opts.ts]  unix ms — test override
 * @returns {Object} air-frame.v0
 */
export function compress(input, opts = {}) {
  if (typeof input !== 'string') {
    throw new TypeError('air-codec.compress: input must be a string');
  }
  const original_chars = input.length;
  const source_hash = sha256(input);

  // 1) Pull code spans before any sentence work — code is byte-exact.
  const { stripped: noCode, spans: codeSpans } = extractCode(input);

  // 2) Pull citation tokens globally BEFORE sentence-splitting. URLs,
  //    statutes (with U.S.C. dots), and POSIX paths must not be fragmented
  //    by the sentence boundary heuristic. This step replaces each token
  //    with " [[CIT]] " so the prose pipeline sees structure but no
  //    citation bytes.
  const { stripped: noCites, citations: globalCitations } = extractCitationsGlobal(noCode);

  // 3) Track dropped chars by tag
  const drops = {
    hedge: 0,
    fluff: 0,
    transition: 0,
    pleasantry: 0,
    self_reference: 0,
    whitespace: 0,
    duplicate: 0,
    other: 0,
  };

  // Whitespace normalisation cost — multiple spaces, leading/trailing.
  const wsBefore = noCites.length;
  const wsNormalized = noCites.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  drops.whitespace += Math.max(0, wsBefore - wsNormalized.length);

  // 4) Split sentences
  const sentences = splitSentences(wsNormalized);

  // 5) Per-sentence extract + classify. Citations were already pulled
  //    globally; the placeholder [[CIT]] marks where they sat so we can
  //    count grounding per sentence without re-scanning for refs.
  const facts = [];
  const claims = [];
  const citations = globalCitations.slice();
  const numbers = [];
  const dates = [];
  const identifierSet = new Set();
  const decisions = [];
  const questions = [];
  const residue = [];

  const seenFact = new Set();
  const seenClaim = new Set();
  const seenDecision = new Set();
  const seenQuestion = new Set();
  const seenResidue = new Set();

  for (const rawSentence of sentences) {
    // Strip prefixes
    const { stripped, removedChars, removedTags } = stripPrefixes(rawSentence);
    for (const tag of removedTags) drops[tag] += 0; // tags counted via removedChars below; per-tag bucket needs explicit accounting:
    // Re-account per tag:
    // We do a second pass to split removedChars by tag — small overhead, honest accounting.
    {
      let s2 = rawSentence;
      for (const re of FLUFF_PREFIXES) {
        const m = s2.match(re);
        if (m) { drops.fluff += m[0].length; s2 = s2.slice(m[0].length); }
      }
      for (const re of TRANSITION_PREFIXES) {
        const m = s2.match(re);
        if (m) { drops.transition += m[0].length; s2 = s2.slice(m[0].length); }
      }
    }

    // If the sentence was ONLY prefix fluff, it's fully consumed.
    if (!stripped.trim()) continue;

    // Scrub inline pleasantries / self-references.
    const { cleaned, drops: inlineDrops } = scrubInline(stripped);
    drops.pleasantry += inlineDrops.pleasantry;
    drops.self_reference += inlineDrops.self_reference;
    if (!cleaned) continue;

    // Citations were extracted globally; count [[CIT]] markers in this
    // sentence as a proxy for "this sentence carried at least one citation".
    const citMarkerCount = (cleaned.match(/\[\[CIT\]\]/g) || []).length;

    // Pull number / date / identifier groundings from the cleaned text.
    // Dates first — their positions are reserved so number extraction does
    // not double-count the year/month/day digits as bare numbers.
    const dateOut = extractDates(cleaned);
    for (const d of dateOut.dates) dates.push(d);
    const ns = extractNumbers(cleaned, dateOut.positions);
    for (const n of ns) numbers.push(n);
    for (const id of extractIdentifiers(cleaned)) identifierSet.add(id);

    // Strip citation markers BEFORE classification + storage so the
    // readable form is clean and our pattern matches see real prose.
    const display = cleaned.replace(/\s*\[\[CIT\]\]\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (!display) continue;

    // Question?
    if (isQuestionSentence(display)) {
      if (!seenQuestion.has(display)) {
        seenQuestion.add(display);
        questions.push(display);
      } else {
        drops.duplicate += display.length;
      }
      continue;
    }

    // Decision?
    if (isDecisionSentence(display)) {
      if (!seenDecision.has(display)) {
        seenDecision.add(display);
        decisions.push(display);
      } else {
        drops.duplicate += display.length;
      }
      continue;
    }

    const hasGrounding = citMarkerCount + ns.length + dateOut.dates.length > 0;
    const { slot, confidence } = classifyAssertion(display, hasGrounding);

    if (slot === 'facts') {
      if (!seenFact.has(display)) {
        seenFact.add(display);
        facts.push(display);
      } else {
        drops.duplicate += display.length;
      }
    } else {
      const isEmpty = display.length < 24 && !hasGrounding && confidence !== 'asserted';
      if (isEmpty) {
        if (!seenResidue.has(display)) {
          seenResidue.add(display);
          residue.push(display);
        } else {
          drops.duplicate += display.length;
        }
      } else {
        const key = display + '::' + (confidence || '');
        if (!seenClaim.has(key)) {
          seenClaim.add(key);
          claims.push({ text: display, confidence });
        } else {
          drops.duplicate += display.length;
        }
      }
    }

    // Hedge auditing: even if we keep the sentence, count the hedge tokens
    // it contained so the Compression Debt Ledger can see how hedged the
    // source was.
    for (const w of HEDGE_WORDS) {
      const re = new RegExp('\\b' + w + '\\b', 'gi');
      const matches = display.match(re);
      if (matches) drops.hedge += matches.reduce((acc, x) => acc + x.length, 0);
    }
  }

  // 5) Assemble the structured payload that defines frame_id.
  const dropped = Object.entries(drops)
    .filter(([, n]) => n > 0)
    .map(([tag, chars]) => ({ tag, chars }));

  const structured = {
    facts,
    claims,
    citations,
    numbers,
    dates,
    identifiers: [...identifierSet].sort(),
    code_spans: codeSpans,
    decisions,
    questions,
    residue,
    dropped,
  };

  const compressed_chars = canonicalStringify(structured).length;
  const compression_ratio = original_chars === 0 ? 0 : compressed_chars / original_chars;

  const frame_id = sha256(canonicalStringify(structured));
  const created_at = new Date(typeof opts.ts === 'number' ? opts.ts : Date.now()).toISOString();

  return {
    schema: FRAME_SCHEMA_ID,
    frame_id,
    source_hash,
    original_chars,
    compressed_chars,
    compression_ratio,
    facts: structured.facts,
    claims: structured.claims,
    citations: structured.citations,
    numbers: structured.numbers,
    dates: structured.dates,
    identifiers: structured.identifiers,
    code_spans: structured.code_spans,
    decisions: structured.decisions,
    questions: structured.questions,
    residue: structured.residue,
    dropped: structured.dropped,
    created_at,
  };
}

// ---------------------------------------------------------------------------
// Decompress
// ---------------------------------------------------------------------------

/**
 * Decompress an AIR frame into a readable prose rendition. NOT byte-identical
 * to the source. The frame remains the source of truth.
 *
 * Format: a structured outline. Headings only appear for non-empty sections.
 *
 * @param {Object} frame
 * @returns {string}
 */
export function decompress(frame) {
  const v = validate(frame);
  if (!v.valid) {
    throw new Error(`air-codec.decompress: invalid frame — ${v.errors.join('; ')}`);
  }
  const lines = [];

  if (frame.facts.length) {
    lines.push('# Facts');
    for (const f of frame.facts) lines.push(`- ${f}`);
    lines.push('');
  }

  if (frame.claims.length) {
    lines.push('# Claims');
    for (const c of frame.claims) {
      const conf = c.confidence ? ` _(${c.confidence})_` : '';
      lines.push(`- ${c.text}${conf}`);
    }
    lines.push('');
  }

  if (frame.decisions.length) {
    lines.push('# Decisions');
    for (const d of frame.decisions) lines.push(`- ${d}`);
    lines.push('');
  }

  if (frame.numbers.length) {
    lines.push('# Numbers');
    for (const n of frame.numbers) {
      const u = n.unit ? ` ${n.unit}` : '';
      lines.push(`- ${n.value}${u}  — _${n.context}_`);
    }
    lines.push('');
  }

  if (frame.dates.length) {
    lines.push('# Dates');
    for (const d of frame.dates) {
      const iso = d.iso ? ` → ${d.iso}` : '';
      lines.push(`- ${d.raw}${iso}  — _${d.context}_`);
    }
    lines.push('');
  }

  if (frame.citations.length) {
    lines.push('# Citations');
    for (const c of frame.citations) {
      lines.push(`- [${c.kind}] ${c.ref}  — _${c.context}_`);
    }
    lines.push('');
  }

  if (frame.identifiers.length) {
    lines.push('# Identifiers');
    lines.push(frame.identifiers.join(', '));
    lines.push('');
  }

  if (frame.code_spans.length) {
    lines.push('# Code');
    for (const s of frame.code_spans) {
      lines.push('```' + (s.lang || ''));
      lines.push(s.text);
      lines.push('```');
    }
    lines.push('');
  }

  if (frame.questions.length) {
    lines.push('# Open questions');
    for (const q of frame.questions) lines.push(`- ${q}`);
    lines.push('');
  }

  if (frame.residue.length) {
    lines.push('# Residue');
    for (const r of frame.residue) lines.push(`- ${r}`);
    lines.push('');
  }

  if (frame.dropped.length) {
    lines.push('# Dropped (audit)');
    for (const d of frame.dropped) lines.push(`- ${d.tag}: ${d.chars} chars`);
    lines.push('');
  }

  lines.push(`<!-- frame_id=${frame.frame_id} source_hash=${frame.source_hash} ratio=${frame.compression_ratio.toFixed(3)} -->`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

/**
 * Validate an AIR frame against the schema + frame_id integrity.
 *
 * @param {unknown} frame
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validate(frame) {
  const errors = [];
  if (frame == null || typeof frame !== 'object' || Array.isArray(frame)) {
    return { valid: false, errors: ['frame must be a non-null object'] };
  }
  const required = [
    'schema', 'frame_id', 'source_hash', 'original_chars', 'compressed_chars',
    'compression_ratio', 'facts', 'claims', 'citations', 'numbers', 'dates',
    'identifiers', 'code_spans', 'decisions', 'questions', 'residue', 'dropped',
    'created_at',
  ];
  for (const key of required) {
    if (!(key in frame)) errors.push(`missing required field: ${key}`);
  }
  if (errors.length) return { valid: false, errors };

  if (frame.schema !== FRAME_SCHEMA_ID) {
    errors.push(`schema must be '${FRAME_SCHEMA_ID}', got '${frame.schema}'`);
  }
  if (!/^[a-f0-9]{64}$/.test(frame.frame_id || '')) {
    errors.push('frame_id must be 64-char lowercase hex (sha256)');
  }
  if (!/^[a-f0-9]{64}$/.test(frame.source_hash || '')) {
    errors.push('source_hash must be 64-char lowercase hex (sha256)');
  }
  for (const k of ['original_chars', 'compressed_chars']) {
    if (!Number.isInteger(frame[k]) || frame[k] < 0) errors.push(`${k} must be non-negative integer`);
  }
  if (typeof frame.compression_ratio !== 'number' || frame.compression_ratio < 0) {
    errors.push('compression_ratio must be non-negative number');
  }
  for (const arrField of ['facts', 'decisions', 'questions', 'residue', 'identifiers']) {
    if (!Array.isArray(frame[arrField])) errors.push(`${arrField} must be an array`);
  }
  for (const arrField of ['claims', 'citations', 'numbers', 'dates', 'code_spans', 'dropped']) {
    if (!Array.isArray(frame[arrField])) errors.push(`${arrField} must be an array`);
  }
  if (typeof frame.created_at !== 'string' || Number.isNaN(Date.parse(frame.created_at))) {
    errors.push('created_at must be parseable ISO 8601 string');
  }
  if (errors.length) return { valid: false, errors };

  // frame_id integrity — recompute over the structured slots only.
  const structured = {
    facts: frame.facts,
    claims: frame.claims,
    citations: frame.citations,
    numbers: frame.numbers,
    dates: frame.dates,
    identifiers: frame.identifiers,
    code_spans: frame.code_spans,
    decisions: frame.decisions,
    questions: frame.questions,
    residue: frame.residue,
    dropped: frame.dropped,
  };
  const expectedId = sha256(canonicalStringify(structured));
  if (expectedId !== frame.frame_id) {
    errors.push(
      `frame_id integrity: expected ${expectedId}, got ${frame.frame_id} (frame tampered or canonicalization drift)`,
    );
  }
  // compressed_chars should match canonical size of structured payload.
  const expectedCompressed = canonicalStringify(structured).length;
  if (expectedCompressed !== frame.compressed_chars) {
    errors.push(
      `compressed_chars integrity: expected ${expectedCompressed}, got ${frame.compressed_chars}`,
    );
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Internals for downstream tooling / tests
// ---------------------------------------------------------------------------

export const __internals = Object.freeze({
  canonicalStringify,
  sha256,
  splitSentences,
  stripPrefixes,
  scrubInline,
  classifyConfidence,
  extractCode,
  extractCitations,
  extractNumbers,
  extractDates,
  extractIdentifiers,
  isDecisionSentence,
  isQuestionSentence,
  FRAME_SCHEMA_ID,
  HEDGE_WORDS: [...HEDGE_WORDS],
  FLUFF_PREFIXES: [...FLUFF_PREFIXES],
  TRANSITION_PREFIXES: [...TRANSITION_PREFIXES],
});
