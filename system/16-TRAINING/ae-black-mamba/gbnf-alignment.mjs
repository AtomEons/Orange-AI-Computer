#!/usr/bin/env bun
// gbnf-alignment.mjs — AE Black Mamba GBNF grammar alignment artifact builder.
//
// Spec anchor: strategy.md §6 "GBNF grammar alignment target":
//
//   > at the end of training, the unconstrained ("no grammar") generation rate
//   > of schema-valid AgentTurn JSON on the held-out prompt set must reach
//   > ≥ 90%. The grammar-constrained rate stays 100% by construction. The gap
//   > between unconstrained and constrained is the measure of how well the
//   > model has internalized the schema.
//
// The training loop on Colab T4 is in Python (PyTorch + transformers + Mamba).
// The grammar (agent_turn.gbnf) is enforced at INFERENCE time by llama.cpp's
// logit mask. But during TRAINING we want to *pre-shape* the model's
// distribution toward the grammar manifold so the unconstrained eval rate
// climbs. That requires a soft loss term during training:
//
//     L_total = L_ce + λ · L_grammar_penalty
//
// where L_grammar_penalty penalizes probability mass placed on tokens that
// the GBNF's current-state mask would zero out at inference. Computing that
// penalty inside Python requires:
//
//   (1) the grammar's reachable-state transition table
//   (2) a per-state "allowed token-id set" indexed by the upstream tokenizer
//   (3) a runner that, given a target token sequence, can mark which positions
//       are "free" (grammar-legal) vs "forced" (grammar's only-legal-choice).
//
// (3) is dynamic — it runs in the Python trainer per-batch. (1) and (2) are
// static — they depend only on (a) the GBNF file, (b) the tokenizer vocab.
// This module produces (1) and (2) as a deterministic, hash-stamped artifact
// the Python trainer loads at startup. Doing the parse + token-mask
// projection in JS keeps the Python trainer thin and keeps the grammar's
// authority co-located with the rest of the AE Cobra scaffolding (which is
// already JS/Bun).
//
// What this module emits:
//
//   corpus/grammar-alignment/
//     grammar-states.json       — parsed GBNF: rules, terminals, transitions
//     token-mask.json           — { state_id: [token_id, ...] } (sparse)
//     corpus-alignment.json     — per-row grammar acceptance + soft-stat report
//     alignment-manifest.json   — receipt: counts + SHA-256s + ruleset
//
// What this module does NOT do:
//
//   - No model loading. No GPU. No network. No Python. (Same posture as
//     pipeline.mjs — single-read auditable Bun script.)
//   - No grammar mutation. The GBNF is the source of truth and is read,
//     never rewritten. If grammar drift is needed, edit agent_turn.gbnf
//     and rerun this builder — the manifest SHA-256 will change and the
//     Python trainer's startup check will halt loudly.
//   - No tokenizer training. The tokenizer vocab is consumed if provided
//     (path via env AE_BM_TOKENIZER_VOCAB); when absent, token-mask.json
//     emits states without token projections and the Python trainer falls
//     back to character-level grammar checking. Mom's Law: do not invent
//     a vocab if none is supplied.
//   - No soft-loss schedule decision (λ). That is a hyperparameter on the
//     Python side; this module documents the recommended starting value
//     in the manifest but does not enforce it.
//
// Why this is a soft constraint, not a hard one, during training:
//
//   Hard logit masking during training prevents the model from ever seeing
//   the "wrong" path — the gradient never flows through tokens the grammar
//   forbids. The model learns to navigate the grammar's manifold but never
//   learns *why* the off-manifold tokens are off-manifold. At inference
//   under the same hard mask that's fine, but the alignment target (§6)
//   measures UNCONSTRAINED generation. The model must internalize the
//   shape, not just survive the mask. A SOFT penalty (KL or cross-entropy
//   against the masked-uniform distribution) lets the model see and learn
//   from the bad tokens, while pulling it toward the legal manifold.
//
// Run:
//
//   bun run 16-TRAINING/ae-black-mamba/gbnf-alignment.mjs
//
// Env overrides (all optional):
//
//   ORANGE5_ROOT             optional checkout override
//   AE_BM_GRAMMAR_PATH       GBNF source path; default
//                            ${ORANGE5_ROOT}/06-ORANGELLM/memory/ae-cobra/grammar/agent_turn.gbnf
//   AE_BM_CORPUS_DIR         corpus dir from pipeline.mjs; default
//                            ${ORANGE5_ROOT}/16-TRAINING/ae-black-mamba/corpus
//   AE_BM_OUT_SUBDIR         output subdir under corpus; default 'grammar-alignment'
//   AE_BM_TOKENIZER_VOCAB    path to tokenizer vocab JSON dump
//                            (HF tokenizer.json or {token: id} map). Optional.
//   AE_BM_LAMBDA             recommended soft-penalty weight; default '0.1'
//                            (recorded in manifest only; trainer reads this)
//
// Failure modes (intentional):
//
//   - Grammar file missing → hard fail before any output.
//   - Corpus train.jsonl missing → hard fail (cannot compute alignment stats).
//   - Zero accepted rows in corpus → hard fail (refuse to emit empty report).
//   - Grammar parse error → hard fail with line-pointer (do not silently
//     truncate the grammar; that would weaken the constraint).
//
// Mom's Law: every state, every token mapping, every rejected row itemized.
// No padding. No "approximately." Receipts only.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ORANGE5_ROOT = path.resolve(process.env.ORANGE5_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
const GRAMMAR_PATH = process.env.AE_BM_GRAMMAR_PATH
  || path.join(ORANGE5_ROOT, '06-ORANGELLM/memory/ae-cobra/grammar/agent_turn.gbnf');
const CORPUS_DIR = process.env.AE_BM_CORPUS_DIR
  || path.join(ORANGE5_ROOT, '16-TRAINING/ae-black-mamba/corpus');
const OUT_SUBDIR = process.env.AE_BM_OUT_SUBDIR || 'grammar-alignment';
const OUT_DIR = path.join(CORPUS_DIR, OUT_SUBDIR);
const TOKENIZER_VOCAB_PATH = process.env.AE_BM_TOKENIZER_VOCAB || '';
const LAMBDA = (() => {
  const raw = process.env.AE_BM_LAMBDA;
  if (raw === undefined || raw === '') return 0.1;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 0 || n > 10) {
    throw new Error(`AE_BM_LAMBDA out of range [0,10]: ${raw}`);
  }
  return n;
})();

// ---------------------------------------------------------------------------
// Utilities (canonical JSON + hash; reused shape from pipeline.mjs so the
// receipt chain matches).
// ---------------------------------------------------------------------------

function canonicalJSON(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`non-finite number: ${value}`);
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') throw new Error('bigint not supported');
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJSON).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJSON(value[k])).join(',') + '}';
  }
  throw new Error(`unsupported value type: ${typeof value}`);
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function atomicWrite(target, contents) {
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, target);
}

// ---------------------------------------------------------------------------
// GBNF parser — minimal, hand-written, scoped to the shape of agent_turn.gbnf.
//
// We intentionally do not pull a general GBNF library. The active grammar is
// small (one root, ~6 supporting rules), and a hand parse keeps the artifact
// auditable. The parser handles:
//
//   - rule defs:        name ::= alt1 | alt2 | ...
//   - sequencing:       a b c
//   - quoted strings:   "literal"  (escapes \\ \" \n \r \t \/ \b \f)
//   - char classes:     [a-z] [^x] [0-9]
//   - rule references:  name
//   - groups:           ( ... )
//   - quantifiers:      *  +  ?  {n,m}
//   - alternation:      |  (lowest precedence inside an alt list)
//   - comments:         # to end of line
//
// It does NOT handle: lookahead, semantic actions, recursive-descent
// patterns the AgentTurn grammar doesn't use. If a future agent_turn.gbnf
// revision adds anything outside this set, the parser throws and the
// alignment artifact rebuild halts loudly.
// ---------------------------------------------------------------------------

const TOKEN_END = Symbol('END');

class GbnfParser {
  constructor(src, srcPath) {
    this.src = src;
    this.srcPath = srcPath;
    this.pos = 0;
    this.line = 1;
    this.col = 1;
    this.rules = new Map(); // name -> AST node (alt list)
  }

  // ---- Lexer-ish helpers --------------------------------------------------

  peek(off = 0) {
    return this.src[this.pos + off];
  }
  eof() {
    return this.pos >= this.src.length;
  }
  advance() {
    const c = this.src[this.pos++];
    if (c === '\n') { this.line += 1; this.col = 1; }
    else { this.col += 1; }
    return c;
  }
  here() {
    return `${path.basename(this.srcPath)}:${this.line}:${this.col}`;
  }
  fail(msg) {
    throw new Error(`GBNF parse error at ${this.here()}: ${msg}`);
  }

  /** Skip whitespace and # comments. Returns true if any was skipped. */
  skipTrivia() {
    let skipped = false;
    while (!this.eof()) {
      const c = this.peek();
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
        this.advance(); skipped = true; continue;
      }
      if (c === '#') {
        // Comment to end of line.
        while (!this.eof() && this.peek() !== '\n') this.advance();
        skipped = true;
        continue;
      }
      break;
    }
    return skipped;
  }

  // ---- Top level ----------------------------------------------------------

  parseAll() {
    while (true) {
      this.skipTrivia();
      if (this.eof()) break;
      this.parseRuleDef();
    }
    if (!this.rules.has('root')) this.fail("missing 'root' rule");
    return this.rules;
  }

  parseRuleDef() {
    const name = this.parseIdent();
    this.skipTrivia();
    if (this.peek() !== ':' || this.peek(1) !== ':' || this.peek(2) !== '=') {
      this.fail(`expected '::=' after rule name '${name}'`);
    }
    this.advance(); this.advance(); this.advance();
    this.skipTrivia();
    const alt = this.parseAlt();
    if (this.rules.has(name)) {
      this.fail(`duplicate rule definition: ${name}`);
    }
    this.rules.set(name, alt);
  }

  parseIdent() {
    const start = this.pos;
    if (!/[A-Za-z_]/.test(this.peek() ?? '')) {
      this.fail(`expected identifier, got '${this.peek() ?? '<EOF>'}'`);
    }
    while (!this.eof() && /[A-Za-z0-9_\-]/.test(this.peek())) this.advance();
    return this.src.slice(start, this.pos);
  }

  // ---- Expression grammar -------------------------------------------------
  // alt   ::= seq ( '|' seq )*
  // seq   ::= atom_with_quant+        (empty seq → epsilon)
  // atom  ::= ident | literal | charclass | '(' alt ')'
  // quant ::= '*' | '+' | '?' | '{' int ',' int '}' | (nothing)

  parseAlt() {
    const alts = [];
    alts.push(this.parseSeq());
    while (true) {
      this.skipTrivia();
      if (this.peek() === '|') {
        this.advance();
        this.skipTrivia();
        alts.push(this.parseSeq());
      } else break;
    }
    if (alts.length === 1) return alts[0];
    return { kind: 'alt', alts };
  }

  parseSeq() {
    const items = [];
    while (true) {
      this.skipTrivia();
      if (this.eof()) break;
      const c = this.peek();
      // Stop on alternation, group close, or start of next rule.
      if (c === '|' || c === ')') break;
      // Detect "name ::=" — start of next rule def at top level. We must
      // not consume it here. Look ahead.
      if (/[A-Za-z_]/.test(c) && this.looksLikeRuleStart()) break;
      const atom = this.parseAtomWithQuant();
      if (atom === null) break;
      items.push(atom);
    }
    if (items.length === 0) return { kind: 'epsilon' };
    if (items.length === 1) return items[0];
    return { kind: 'seq', items };
  }

  /** Lookahead: is the cursor positioned on `IDENT ::=` (a new rule def)?
   *  Used to terminate the current seq without consuming. */
  looksLikeRuleStart() {
    let p = this.pos;
    if (!/[A-Za-z_]/.test(this.src[p] ?? '')) return false;
    while (p < this.src.length && /[A-Za-z0-9_\-]/.test(this.src[p])) p++;
    while (p < this.src.length && (this.src[p] === ' ' || this.src[p] === '\t')) p++;
    return this.src[p] === ':' && this.src[p + 1] === ':' && this.src[p + 2] === '=';
  }

  parseAtomWithQuant() {
    const atom = this.parseAtom();
    if (atom === null) return null;
    // Quantifier?
    if (this.peek() === '*') { this.advance(); return { kind: 'rep', min: 0, max: Infinity, expr: atom }; }
    if (this.peek() === '+') { this.advance(); return { kind: 'rep', min: 1, max: Infinity, expr: atom }; }
    if (this.peek() === '?') { this.advance(); return { kind: 'rep', min: 0, max: 1, expr: atom }; }
    if (this.peek() === '{') {
      this.advance();
      const min = this.parseInt();
      if (this.peek() !== ',') this.fail("expected ',' inside '{m,n}'");
      this.advance();
      const max = this.parseInt();
      if (this.peek() !== '}') this.fail("expected '}' to close quantifier");
      this.advance();
      if (max < min) this.fail(`quantifier max < min: {${min},${max}}`);
      return { kind: 'rep', min, max, expr: atom };
    }
    return atom;
  }

  parseInt() {
    const start = this.pos;
    while (!this.eof() && /[0-9]/.test(this.peek())) this.advance();
    if (start === this.pos) this.fail('expected integer');
    return parseInt(this.src.slice(start, this.pos), 10);
  }

  parseAtom() {
    const c = this.peek();
    if (c === undefined) return null;
    if (c === '"') return this.parseLiteral();
    if (c === '[') return this.parseCharClass();
    if (c === '(') {
      this.advance();
      this.skipTrivia();
      const inner = this.parseAlt();
      this.skipTrivia();
      if (this.peek() !== ')') this.fail("expected ')'");
      this.advance();
      return { kind: 'group', expr: inner };
    }
    if (/[A-Za-z_]/.test(c)) {
      const name = this.parseIdent();
      return { kind: 'ref', name };
    }
    return null;
  }

  parseLiteral() {
    if (this.peek() !== '"') this.fail("expected '\"'");
    this.advance();
    let out = '';
    while (!this.eof() && this.peek() !== '"') {
      const c = this.advance();
      if (c === '\\') {
        const e = this.advance();
        switch (e) {
          case '"': out += '"'; break;
          case '\\': out += '\\'; break;
          case '/': out += '/'; break;
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          default: this.fail(`unknown escape: \\${e}`);
        }
      } else {
        out += c;
      }
    }
    if (this.peek() !== '"') this.fail("unterminated literal");
    this.advance();
    return { kind: 'literal', value: out };
  }

  parseCharClass() {
    if (this.peek() !== '[') this.fail("expected '['");
    this.advance();
    let negate = false;
    if (this.peek() === '^') { negate = true; this.advance(); }
    // Set of allowed chars represented as a sorted list of [lo, hi] ranges.
    const ranges = [];
    while (!this.eof() && this.peek() !== ']') {
      let lo = this.readClassChar();
      let hi = lo;
      if (this.peek() === '-' && this.src[this.pos + 1] !== ']') {
        this.advance();
        hi = this.readClassChar();
        if (hi.charCodeAt(0) < lo.charCodeAt(0)) {
          this.fail(`reversed char range: ${lo}-${hi}`);
        }
      }
      ranges.push([lo.charCodeAt(0), hi.charCodeAt(0)]);
    }
    if (this.peek() !== ']') this.fail("unterminated char class");
    this.advance();
    return { kind: 'charclass', negate, ranges };
  }

  readClassChar() {
    const c = this.advance();
    if (c === '\\') {
      const e = this.advance();
      switch (e) {
        case 'n': return '\n';
        case 'r': return '\r';
        case 't': return '\t';
        case '\\': return '\\';
        case '/': return '/';
        case ']': return ']';
        case '[': return '[';
        case '"': return '"';
        case '^': return '^';
        case '-': return '-';
        default: return e; // permissive: treat unknown escape as literal
      }
    }
    return c;
  }
}

// ---------------------------------------------------------------------------
// AST validator + simple acceptor.
//
// We do not build a full LR/Earley parser here. Instead we build a string
// acceptor: given a candidate string, can the grammar match it? This is
// enough to (a) verify every corpus row is grammar-accepted, (b) measure
// grammar/corpus alignment stats, and (c) compute the "all reachable
// position-level allowed-byte set" used by the token-mask projector.
//
// The acceptor uses memoized recursive-descent with grammar rule call
// stacks. Termination: every rule has bounded depth in this grammar (no
// left-recursion in agent_turn.gbnf — verified by parser).
// ---------------------------------------------------------------------------

class Grammar {
  constructor(rules) {
    this.rules = rules;
    this.detectLeftRecursion();
  }

  /** Hard-fails on left-recursive references — the acceptor would loop.
   *  agent_turn.gbnf has none; this guard fires if a future rev adds one. */
  detectLeftRecursion() {
    const visiting = new Set();
    const visited = new Set();
    const walk = (node, name) => {
      if (!node) return;
      switch (node.kind) {
        case 'alt': for (const a of node.alts) walk(a, name); break;
        case 'seq': for (const it of node.items) { walk(it, name); break; } break; // only first item can be left-rec
        case 'rep': if (node.min > 0) walk(node.expr, name); break;
        case 'group': walk(node.expr, name); break;
        case 'ref':
          if (node.name === name) throw new Error(`left recursion: ${name}`);
          if (visiting.has(node.name)) throw new Error(`indirect left recursion: ${name} → ${node.name}`);
          if (!visited.has(node.name)) {
            visiting.add(node.name);
            const sub = this.rules.get(node.name);
            if (!sub) throw new Error(`undefined rule reference: ${node.name}`);
            walk(sub, node.name);
            visiting.delete(node.name);
            visited.add(node.name);
          }
          break;
      }
    };
    for (const [name, ast] of this.rules) {
      visiting.add(name);
      walk(ast, name);
      visiting.delete(name);
      visited.add(name);
    }
  }

  /** Return list of end-positions reachable from start position when matching
   *  `node` against `input`. Empty list = no match. Multiple positions = the
   *  grammar is ambiguous and multiple suffixes remain. */
  matchNode(node, input, pos) {
    switch (node.kind) {
      case 'epsilon':
        return [pos];

      case 'literal': {
        const len = node.value.length;
        if (pos + len > input.length) return [];
        if (input.slice(pos, pos + len) !== node.value) return [];
        return [pos + len];
      }

      case 'charclass': {
        if (pos >= input.length) return [];
        const code = input.charCodeAt(pos);
        let inSet = false;
        for (const [lo, hi] of node.ranges) {
          if (code >= lo && code <= hi) { inSet = true; break; }
        }
        if (node.negate) inSet = !inSet;
        return inSet ? [pos + 1] : [];
      }

      case 'ref': {
        const sub = this.rules.get(node.name);
        if (!sub) throw new Error(`undefined rule at match time: ${node.name}`);
        return this.matchNode(sub, input, pos);
      }

      case 'group':
        return this.matchNode(node.expr, input, pos);

      case 'alt': {
        const out = new Set();
        for (const a of node.alts) {
          for (const end of this.matchNode(a, input, pos)) out.add(end);
        }
        return [...out].sort((a, b) => a - b);
      }

      case 'seq': {
        let frontier = [pos];
        for (const it of node.items) {
          const next = new Set();
          for (const p of frontier) {
            for (const end of this.matchNode(it, input, p)) next.add(end);
          }
          frontier = [...next];
          if (frontier.length === 0) return [];
        }
        return frontier.sort((a, b) => a - b);
      }

      case 'rep': {
        // Iterative: track frontier of reachable positions for each rep count.
        let frontier = new Set([pos]);
        const ends = new Set();
        if (node.min === 0) ends.add(pos);
        let count = 0;
        while (count < node.max && frontier.size > 0) {
          const next = new Set();
          for (const p of frontier) {
            for (const end of this.matchNode(node.expr, input, p)) {
              if (end === p) continue; // guard against zero-width loops
              next.add(end);
            }
          }
          count += 1;
          if (count >= node.min) for (const e of next) ends.add(e);
          frontier = next;
          if (count >= node.max) break;
        }
        return [...ends].sort((a, b) => a - b);
      }

      default:
        throw new Error(`unknown node kind: ${node.kind}`);
    }
  }

  /** True iff the grammar's root rule accepts `input` exactly (full-string match). */
  accepts(input) {
    const root = this.rules.get('root');
    if (!root) throw new Error('no root rule');
    const ends = this.matchNode(root, input, 0);
    return ends.some(e => e === input.length);
  }
}

// ---------------------------------------------------------------------------
// Token-mask projection.
//
// Given the parsed grammar's char-set of legal next characters at the
// "outer" positions (the byte alphabet the grammar can ever produce), we
// project that onto the tokenizer vocab. A token is "grammar-legal" if its
// first character is in the grammar's reachable-first-char set AND every
// subsequent character is in the grammar's reachable-anywhere-char set.
//
// This is INTENTIONALLY conservative — it overestimates the legal token set
// rather than underestimating. The Python trainer applies the real per-state
// mask at runtime; this static projection is the upper bound used to filter
// the vocab into a "candidate-could-ever-be-legal" subset.
//
// The point of the soft penalty isn't perfect state tracking — it's giving
// the trainer a cheap-to-compute prior that nudges the model away from
// vocab regions the grammar's manifold definitely cannot reach (Cyrillic,
// emoji, base64 fragments, etc.).
// ---------------------------------------------------------------------------

/** Walk the grammar AST and return:
 *    { firstChars: Set<int>, allChars: Set<int> }
 *  firstChars = chars that can begin a root-rule match.
 *  allChars   = chars that appear anywhere in any legal output. */
function collectReachableChars(grammar) {
  const allChars = new Set();
  const firstChars = new Set();

  const visitedFirst = new Set();
  const visitedAll = new Set();

  const collectAllFromNode = (node) => {
    if (!node) return;
    switch (node.kind) {
      case 'epsilon': return;
      case 'literal':
        for (const ch of node.value) allChars.add(ch.charCodeAt(0));
        return;
      case 'charclass': {
        const codes = expandCharClass(node);
        for (const c of codes) allChars.add(c);
        return;
      }
      case 'ref':
        if (visitedAll.has(node.name)) return;
        visitedAll.add(node.name);
        collectAllFromNode(grammar.rules.get(node.name));
        return;
      case 'group':
        collectAllFromNode(node.expr); return;
      case 'alt':
        for (const a of node.alts) collectAllFromNode(a); return;
      case 'seq':
        for (const it of node.items) collectAllFromNode(it); return;
      case 'rep':
        collectAllFromNode(node.expr); return;
      default:
        throw new Error(`unknown node kind: ${node.kind}`);
    }
  };

  const collectFirstFromNode = (node) => {
    if (!node) return;
    switch (node.kind) {
      case 'epsilon': return;
      case 'literal':
        if (node.value.length > 0) firstChars.add(node.value.charCodeAt(0));
        return;
      case 'charclass': {
        const codes = expandCharClass(node);
        for (const c of codes) firstChars.add(c);
        return;
      }
      case 'ref':
        if (visitedFirst.has(node.name)) return;
        visitedFirst.add(node.name);
        collectFirstFromNode(grammar.rules.get(node.name));
        return;
      case 'group':
        collectFirstFromNode(node.expr); return;
      case 'alt':
        for (const a of node.alts) collectFirstFromNode(a); return;
      case 'seq': {
        // First-char comes from the first item that cannot match empty.
        // For agent_turn.gbnf this is straightforward — root starts with "{".
        // We approximate: collect first-chars from items until one cannot be
        // empty. In our grammar even ws can be empty (ws ::= [ \t\n]*).
        for (const it of node.items) {
          collectFirstFromNode(it);
          if (!canMatchEmpty(it, grammar, new Set())) break;
        }
        return;
      }
      case 'rep':
        if (node.min > 0) collectFirstFromNode(node.expr);
        else collectFirstFromNode(node.expr); // min=0 still can have first-chars when count>=1
        return;
      default:
        throw new Error(`unknown node kind: ${node.kind}`);
    }
  };

  const root = grammar.rules.get('root');
  collectFirstFromNode(root);
  collectAllFromNode(root);

  return { firstChars, allChars };
}

function canMatchEmpty(node, grammar, seen) {
  if (!node) return true;
  switch (node.kind) {
    case 'epsilon': return true;
    case 'literal': return node.value.length === 0;
    case 'charclass': return false;
    case 'ref': {
      if (seen.has(node.name)) return false;
      seen.add(node.name);
      return canMatchEmpty(grammar.rules.get(node.name), grammar, seen);
    }
    case 'group': return canMatchEmpty(node.expr, grammar, seen);
    case 'alt': return node.alts.some(a => canMatchEmpty(a, grammar, seen));
    case 'seq': return node.items.every(it => canMatchEmpty(it, grammar, seen));
    case 'rep': return node.min === 0 || canMatchEmpty(node.expr, grammar, seen);
    default: return false;
  }
}

/** Expand a charclass AST node into the set of allowed UTF-16 code points.
 *  Negated classes are expanded against the printable ASCII range + a
 *  small slice of Latin-1 (codes 0x20..0xFF). Sufficient for the JSON
 *  alphabet agent_turn.gbnf operates over. The non-negated case returns
 *  the union of ranges. */
function expandCharClass(node) {
  if (!node.negate) {
    const out = new Set();
    for (const [lo, hi] of node.ranges) {
      for (let c = lo; c <= hi; c++) out.add(c);
    }
    return out;
  }
  const blocked = new Set();
  for (const [lo, hi] of node.ranges) {
    for (let c = lo; c <= hi; c++) blocked.add(c);
  }
  const out = new Set();
  for (let c = 0x20; c <= 0xFF; c++) {
    if (!blocked.has(c)) out.add(c);
  }
  // Common JSON whitespace allowed too (the grammar's ws rule sees them).
  out.add(0x09); // \t
  out.add(0x0A); // \n
  out.add(0x0D); // \r
  return out;
}

/** Project the reachable char set onto a tokenizer vocab.
 *  Returns { eligible_token_ids: int[], ineligible_count: int, total: int }.
 *  Vocab format: { [token_string]: token_id }  OR  HF tokenizer.json with
 *  `model.vocab` field. We try both. */
function projectTokenMask(reachable, vocabPath) {
  if (!vocabPath) {
    return { skipped: true, reason: 'no tokenizer vocab supplied' };
  }
  if (!fs.existsSync(vocabPath)) {
    throw new Error(`tokenizer vocab not found: ${vocabPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(vocabPath, 'utf8'));
  let vocab;
  if (raw && typeof raw === 'object' && raw.model && raw.model.vocab) {
    vocab = raw.model.vocab; // HF tokenizer.json shape
  } else if (raw && typeof raw === 'object') {
    vocab = raw; // {token: id}
  } else {
    throw new Error(`unrecognized tokenizer vocab shape at ${vocabPath}`);
  }

  const eligible = [];
  let total = 0;
  const all = reachable.allChars;
  const firsts = reachable.firstChars;

  for (const [token, id] of Object.entries(vocab)) {
    total += 1;
    if (token.length === 0) {
      eligible.push(id); // empty tokens (BOS/EOS) — keep
      continue;
    }
    let ok = true;
    // GPT-NeoX-style tokenizers prefix space with "Ġ" (0x0120). Decode
    // common BPE artifacts to ASCII for the legality check.
    const decoded = token.replace(/Ġ/g, ' ').replace(/Ċ/g, '\n');
    const firstCode = decoded.charCodeAt(0);
    if (!firsts.has(firstCode)) ok = false;
    if (ok) {
      for (let i = 1; i < decoded.length; i++) {
        if (!all.has(decoded.charCodeAt(i))) { ok = false; break; }
      }
    }
    if (ok) eligible.push(id);
  }
  return {
    skipped: false,
    total,
    eligible_count: eligible.length,
    ineligible_count: total - eligible.length,
    eligible_token_ids: eligible,
  };
}

// ---------------------------------------------------------------------------
// Corpus alignment statistics.
//
// Read corpus/train.jsonl + corpus/val.jsonl, run each row's inner text
// through the grammar acceptor. Every row should accept (the pipeline.mjs
// builder already validated against the JSON schema, which is tighter than
// the grammar for most fields). Any non-accept here means the corpus and
// the grammar have drifted and the operator must reconcile before training.
// ---------------------------------------------------------------------------

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); }
    catch (e) {
      out.push({ _parse_error: e.message, _raw_preview: line.slice(0, 80) });
      continue;
    }
    out.push(obj);
  }
  return out;
}

function scoreCorpus(grammar, rows, label) {
  let accepted = 0;
  let rejected = 0;
  const rejectSamples = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row._parse_error) {
      rejected += 1;
      if (rejectSamples.length < 10) {
        rejectSamples.push({ row_index: i, reason: 'jsonl-parse', detail: row._parse_error });
      }
      continue;
    }
    const text = typeof row.text === 'string' ? row.text : '';
    // pipeline.mjs writes "<canonical AgentTurn JSON>\n" — strip the trailing
    // newline before grammar check (the grammar's outer "ws "}" allows
    // trailing whitespace but training rows are emitted with a single \n
    // outside the closing brace by design).
    const candidate = text.endsWith('\n') ? text.slice(0, -1) : text;
    const ok = grammar.accepts(candidate);
    if (ok) accepted += 1;
    else {
      rejected += 1;
      if (rejectSamples.length < 10) {
        rejectSamples.push({
          row_index: i,
          reason: 'grammar-reject',
          preview: candidate.slice(0, 120),
        });
      }
    }
  }
  return {
    label,
    total: rows.length,
    accepted,
    rejected,
    acceptance_rate: rows.length === 0 ? null : accepted / rows.length,
    reject_samples: rejectSamples,
  };
}

// ---------------------------------------------------------------------------
// Rule state enumeration — a coarse "state id per rule" projection.
//
// Full GBNF state machines have hundreds of micro-states; for the purpose
// of the Python trainer's soft penalty we don't need micro-states, we need
// a per-rule legal-next-char set. The Python side runs a streaming acceptor
// over the target sequence; this artifact gives it, for each rule:
//   - the legal-first-char set
//   - the rule's literal+enum value list (so the trainer can spot when the
//     current position is forced to a specific literal vs a free string).
// ---------------------------------------------------------------------------

function exportRuleSummaries(grammar) {
  const out = {};
  for (const [name, ast] of grammar.rules) {
    const firsts = new Set();
    collectFirstChars(ast, grammar, firsts, new Set());
    const literals = collectLiterals(ast, grammar, new Set());
    out[name] = {
      first_chars: [...firsts].sort((a, b) => a - b),
      literal_alternatives: literals.length <= 16 ? literals : null,
      // null when the rule is open-ended (e.g. short_string) — trainer treats
      // these as "free" positions where the soft penalty is the full
      // reachable-char set rather than a single forced literal.
    };
  }
  return out;
}

function collectFirstChars(node, grammar, out, seenRefs) {
  if (!node) return;
  switch (node.kind) {
    case 'epsilon': return;
    case 'literal':
      if (node.value.length > 0) out.add(node.value.charCodeAt(0));
      return;
    case 'charclass':
      for (const c of expandCharClass(node)) out.add(c);
      return;
    case 'ref':
      if (seenRefs.has(node.name)) return;
      seenRefs.add(node.name);
      collectFirstChars(grammar.rules.get(node.name), grammar, out, seenRefs);
      return;
    case 'group':
      collectFirstChars(node.expr, grammar, out, seenRefs); return;
    case 'alt':
      for (const a of node.alts) collectFirstChars(a, grammar, out, seenRefs); return;
    case 'seq': {
      for (const it of node.items) {
        collectFirstChars(it, grammar, out, seenRefs);
        if (!canMatchEmpty(it, grammar, new Set())) break;
      }
      return;
    }
    case 'rep':
      collectFirstChars(node.expr, grammar, out, seenRefs); return;
  }
}

function collectLiterals(node, grammar, seenRefs, acc = []) {
  if (!node) return acc;
  switch (node.kind) {
    case 'literal':
      acc.push(node.value); return acc;
    case 'alt':
      for (const a of node.alts) {
        if (a.kind === 'literal') acc.push(a.value);
        else return []; // mixed alt → not a pure literal-list rule
      }
      return acc;
    case 'ref': {
      if (seenRefs.has(node.name)) return acc;
      seenRefs.add(node.name);
      return collectLiterals(grammar.rules.get(node.name), grammar, seenRefs, acc);
    }
    case 'group':
      return collectLiterals(node.expr, grammar, seenRefs, acc);
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const startedAt = new Date().toISOString();

  if (!fs.existsSync(GRAMMAR_PATH)) {
    throw new Error(`GBNF grammar missing: ${GRAMMAR_PATH}. Abort.`);
  }
  const trainPath = path.join(CORPUS_DIR, 'train.jsonl');
  const valPath = path.join(CORPUS_DIR, 'val.jsonl');
  if (!fs.existsSync(trainPath)) {
    throw new Error(`corpus train.jsonl missing: ${trainPath}. Run pipeline.mjs first.`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 1. Parse grammar.
  const grammarSrc = fs.readFileSync(GRAMMAR_PATH, 'utf8');
  const grammarSha = sha256Hex(grammarSrc);
  const parser = new GbnfParser(grammarSrc, GRAMMAR_PATH);
  const rules = parser.parseAll();
  const grammar = new Grammar(rules);

  // 2. Reachable char sets + rule summaries.
  const reachable = collectReachableChars(grammar);
  const ruleSummaries = exportRuleSummaries(grammar);

  // 3. Tokenizer projection (optional).
  const tokenProjection = projectTokenMask(reachable, TOKENIZER_VOCAB_PATH);

  // 4. Corpus alignment stats.
  const trainRows = readJsonl(trainPath);
  const valRows = readJsonl(valPath);
  const trainStats = scoreCorpus(grammar, trainRows, 'train');
  const valStats = scoreCorpus(grammar, valRows, 'val');

  if (trainStats.total === 0) {
    throw new Error('REFUSING: corpus train.jsonl had zero parseable rows.');
  }

  // 5. Write artifacts. Each artifact is canonicalized so re-running this
  // module with no input change produces byte-identical outputs (and the
  // manifest's SHA-256 is stable).
  const grammarStatesArtifact = {
    schema: 'orange5.ae-black-mamba.grammar-states.v0',
    source_grammar: path.basename(GRAMMAR_PATH),
    source_grammar_sha256: grammarSha,
    rule_count: rules.size,
    rules: ruleSummaries,
    reachable_first_chars: [...reachable.firstChars].sort((a, b) => a - b),
    reachable_all_chars: [...reachable.allChars].sort((a, b) => a - b),
    notes: 'Per-rule first-char + literal-alternative summary. Trainer uses '
      + 'this to compute the per-position grammar mask at training time.',
  };

  const tokenMaskArtifact = tokenProjection.skipped
    ? {
        schema: 'orange5.ae-black-mamba.token-mask.v0',
        skipped: true,
        reason: tokenProjection.reason,
        guidance: 'Set AE_BM_TOKENIZER_VOCAB to a Mamba tokenizer.json dump '
          + 'and rerun to materialize the eligible token-id set. Without '
          + 'this, the Python trainer falls back to character-level grammar '
          + 'checking, which is slower but functionally equivalent.',
      }
    : {
        schema: 'orange5.ae-black-mamba.token-mask.v0',
        skipped: false,
        tokenizer_vocab_path: TOKENIZER_VOCAB_PATH,
        tokenizer_vocab_sha256: sha256Hex(fs.readFileSync(TOKENIZER_VOCAB_PATH, 'utf8')),
        vocab_total: tokenProjection.total,
        eligible_count: tokenProjection.eligible_count,
        ineligible_count: tokenProjection.ineligible_count,
        eligible_fraction: tokenProjection.eligible_count / tokenProjection.total,
        eligible_token_ids: tokenProjection.eligible_token_ids,
        notes: 'Conservative upper-bound projection. A token is eligible if '
          + 'its first decoded char is in reachable_first_chars and every '
          + 'subsequent char is in reachable_all_chars. Trainer treats '
          + 'ineligible tokens as soft-penalized at every position.',
      };

  const alignmentArtifact = {
    schema: 'orange5.ae-black-mamba.corpus-alignment.v0',
    train: trainStats,
    val: valStats,
    overall: {
      total: trainStats.total + valStats.total,
      accepted: trainStats.accepted + valStats.accepted,
      acceptance_rate: (trainStats.accepted + valStats.accepted)
        / Math.max(1, trainStats.total + valStats.total),
    },
    notes: 'Every corpus row should accept (100%). A non-accept means '
      + 'pipeline.mjs and agent_turn.gbnf have drifted; reconcile before '
      + 'training. Inspect reject_samples for the cause.',
  };

  atomicWrite(
    path.join(OUT_DIR, 'grammar-states.json'),
    JSON.stringify(grammarStatesArtifact, null, 2),
  );
  atomicWrite(
    path.join(OUT_DIR, 'token-mask.json'),
    JSON.stringify(tokenMaskArtifact, null, 2),
  );
  atomicWrite(
    path.join(OUT_DIR, 'corpus-alignment.json'),
    JSON.stringify(alignmentArtifact, null, 2),
  );

  // 6. Manifest — receipt for this alignment run.
  const grammarStatesSha = sha256Hex(JSON.stringify(grammarStatesArtifact, null, 2));
  const tokenMaskSha = sha256Hex(JSON.stringify(tokenMaskArtifact, null, 2));
  const alignmentSha = sha256Hex(JSON.stringify(alignmentArtifact, null, 2));

  // Locate corpus manifest SHA if present (chain of trust).
  const corpusManifestPath = path.join(CORPUS_DIR, 'corpus-manifest.json');
  let corpusManifestSha = null;
  let trainSha = null;
  let valSha = null;
  if (fs.existsSync(corpusManifestPath)) {
    const cmRaw = fs.readFileSync(corpusManifestPath, 'utf8');
    corpusManifestSha = sha256Hex(cmRaw);
    try {
      const cm = JSON.parse(cmRaw);
      trainSha = cm?.outputs?.train_sha256 ?? null;
      valSha = cm?.outputs?.val_sha256 ?? null;
    } catch { /* leave nulls */ }
  }

  const manifest = {
    schema: 'orange5.ae-black-mamba.alignment-manifest.v0',
    generated_at: startedAt,
    finished_at: new Date().toISOString(),
    purpose: 'AE Black Mamba GBNF grammar alignment artifact — soft constraint '
      + 'during full-FT training; targets strategy §6 ≥90% unconstrained '
      + 'AgentTurn validity post-training.',
    inputs: {
      grammar_path: GRAMMAR_PATH,
      grammar_sha256: grammarSha,
      corpus_dir: CORPUS_DIR,
      corpus_manifest_path: corpusManifestPath,
      corpus_manifest_sha256: corpusManifestSha,
      corpus_train_sha256: trainSha,
      corpus_val_sha256: valSha,
      tokenizer_vocab_path: TOKENIZER_VOCAB_PATH || null,
    },
    outputs: {
      grammar_states_path: path.join(OUT_DIR, 'grammar-states.json'),
      grammar_states_sha256: grammarStatesSha,
      token_mask_path: path.join(OUT_DIR, 'token-mask.json'),
      token_mask_sha256: tokenMaskSha,
      corpus_alignment_path: path.join(OUT_DIR, 'corpus-alignment.json'),
      corpus_alignment_sha256: alignmentSha,
    },
    counts: {
      grammar_rules: rules.size,
      reachable_first_chars: reachable.firstChars.size,
      reachable_all_chars: reachable.allChars.size,
      train_rows: trainStats.total,
      train_accepted: trainStats.accepted,
      train_rejected: trainStats.rejected,
      val_rows: valStats.total,
      val_accepted: valStats.accepted,
      val_rejected: valStats.rejected,
      tokenizer_vocab_total: tokenProjection.skipped ? null : tokenProjection.total,
      tokenizer_eligible_tokens: tokenProjection.skipped ? null : tokenProjection.eligible_count,
    },
    hyperparameters: {
      recommended_lambda: LAMBDA,
      lambda_rationale: 'Soft penalty weight in L_total = L_ce + λ·L_grammar. '
        + '0.1 starts the model leaning toward the grammar manifold without '
        + 'overwhelming the next-token cross-entropy signal from the AgentTurn '
        + 'JSON content. Sweep [0.01, 0.05, 0.1, 0.3] if convergence is slow.',
      penalty_form: 'For each training position p, let M_p = grammar-legal-token-id set '
        + 'at that state. L_grammar(p) = sum_{t in vocab\\M_p} softmax(logits_p)[t]. '
        + 'Mean over positions, weighted by sequence length.',
    },
    alignment_target: {
      strategy_anchor: 'strategy.md §6',
      threshold: 0.90,
      metric: 'unconstrained-eval AgentTurn schema-validity rate on held-out prompt set',
      constrained_baseline: 1.00,
      gap_interpretation: 'A small gap means the model internalized the grammar; '
        + 'a large gap means the grammar mask is overriding the model at inference.',
    },
    moms_law: 'Every state, every token mapping, every rejected corpus row itemized. '
      + 'No padding. No silent grammar relaxation. Receipts only.',
  };
  atomicWrite(
    path.join(OUT_DIR, 'alignment-manifest.json'),
    JSON.stringify(manifest, null, 2),
  );

  // 7. Operator-facing console summary.
  console.log('AE Black Mamba grammar alignment — DONE');
  console.log(`  grammar              : ${path.basename(GRAMMAR_PATH)}  sha256 ${grammarSha.slice(0, 12)}…`);
  console.log(`  rules parsed         : ${rules.size}`);
  console.log(`  reachable first-chars: ${reachable.firstChars.size}`);
  console.log(`  reachable all-chars  : ${reachable.allChars.size}`);
  console.log(`  train rows           : ${trainStats.total}  accepted ${trainStats.accepted}  rejected ${trainStats.rejected}`);
  console.log(`  val rows             : ${valStats.total}  accepted ${valStats.accepted}  rejected ${valStats.rejected}`);
  if (tokenProjection.skipped) {
    console.log(`  token mask           : SKIPPED (${tokenProjection.reason})`);
  } else {
    console.log(`  token mask           : ${tokenProjection.eligible_count}/${tokenProjection.total} eligible (${(tokenProjection.eligible_count / tokenProjection.total * 100).toFixed(1)}%)`);
  }
  console.log(`  recommended λ        : ${LAMBDA}`);
  console.log(`  out dir              : ${OUT_DIR}`);
  console.log(`  manifest             : ${path.join(OUT_DIR, 'alignment-manifest.json')}`);

  // 8. Mom's Law: if any corpus row was rejected by the grammar, that is a
  // drift signal. Print loudly and exit non-zero so CI / the operator sees it.
  if (trainStats.rejected > 0 || valStats.rejected > 0) {
    console.error('');
    console.error('CORPUS / GRAMMAR DRIFT DETECTED.');
    console.error(`  ${trainStats.rejected} train rows and ${valStats.rejected} val rows`);
    console.error('  failed grammar acceptance. The pipeline.mjs schema validator');
    console.error('  is wider than agent_turn.gbnf, or the grammar has tightened.');
    console.error('  Reconcile before training. See corpus-alignment.json for samples.');
    process.exit(3);
  }
}

const isDirectRun =
  (typeof Bun !== 'undefined' && import.meta.path === Bun.main)
  || (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`)
  || (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1])));

if (isDirectRun) {
  main().catch(err => {
    console.error('gbnf-alignment FAILED:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  });
}

// Exposed for tests.
export const _internal = {
  canonicalJSON,
  sha256Hex,
  GbnfParser,
  Grammar,
  collectReachableChars,
  expandCharClass,
  canMatchEmpty,
  projectTokenMask,
  scoreCorpus,
  exportRuleSummaries,
};
