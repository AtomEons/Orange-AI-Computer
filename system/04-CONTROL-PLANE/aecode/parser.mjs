// AECode Source parser — Markdown + YAML-front-matter → AST → validated AECode object.
//
// Pipeline contract:
//   intent → AECode Source → mission contract → target plan → patch → gauntlet → receipt → approval
//
// Source format (canonical):
//   1. Optional YAML front matter delimited by `---` lines. Front matter populates `identity`
//      (and may seed other top-level fields by exact key).
//   2. Body is a sequence of H2 sections. Each H2 heading is one of the 13 required sections,
//      case-insensitive, with `-` / `_` / spaces interchangeable. Aliases are documented below.
//   3. Section body is parsed by section type:
//        - product_intent           → string (joined paragraph text)
//        - operator_laws            → list (Markdown bullets; each item one law)
//        - scope                    → object (`include:` / `exclude:` lists, or sub-bullets)
//        - target_matrix            → object (Markdown table or `key: value` lines)
//        - artifact_contracts       → array of objects (`- name: ...` blocks)
//        - data_contracts           → array of objects (same block shape)
//        - behavior_graph           → object (nodes / edges; bullets or fenced YAML)
//        - permissions              → object (`allow:` / `deny:` lists)
//        - model_roles              → object (key: role lines)
//        - gauntlets                → array (bullets, each gauntlet step)
//        - receipts                 → object (key: value lines)
//        - rollback                 → object (key: value lines)
//
// The parser is intentionally tolerant: it accepts fenced ```yaml blocks inside sections,
// raw bullet lists, or simple `key: value` lines. The AST records which form was used so
// the compiler can replay deterministic transforms downstream.
//
// Output:
//   { ast, source, errors, validate() }
//   - `ast.aecode` is the validated object suitable for the schema at
//     09-SCHEMAS/aecode-final-format.schema.json.
//   - `ast.sections` is the raw section graph (for tooling).
//   - `errors` is an array of { severity, code, message, line } entries.
//
// No external deps. Pure Node ESM. Mom's Law: every branch earns its place.

const REQUIRED_SECTIONS = [
  "identity",
  "product_intent",
  "operator_laws",
  "scope",
  "target_matrix",
  "artifact_contracts",
  "data_contracts",
  "behavior_graph",
  "permissions",
  "model_roles",
  "gauntlets",
  "receipts",
  "rollback",
];

const SECTION_ALIASES = {
  "identity": "identity",
  "product intent": "product_intent",
  "product-intent": "product_intent",
  "product_intent": "product_intent",
  "operator laws": "operator_laws",
  "operator-laws": "operator_laws",
  "operator_laws": "operator_laws",
  "laws": "operator_laws",
  "scope": "scope",
  "target matrix": "target_matrix",
  "target-matrix": "target_matrix",
  "target_matrix": "target_matrix",
  "targets": "target_matrix",
  "artifact contracts": "artifact_contracts",
  "artifact-contracts": "artifact_contracts",
  "artifact_contracts": "artifact_contracts",
  "artifacts": "artifact_contracts",
  "data contracts": "data_contracts",
  "data-contracts": "data_contracts",
  "data_contracts": "data_contracts",
  "data": "data_contracts",
  "behavior graph": "behavior_graph",
  "behavior-graph": "behavior_graph",
  "behavior_graph": "behavior_graph",
  "graph": "behavior_graph",
  "permissions": "permissions",
  "model roles": "model_roles",
  "model-roles": "model_roles",
  "model_roles": "model_roles",
  "models": "model_roles",
  "gauntlets": "gauntlets",
  "gauntlet": "gauntlets",
  "receipts": "receipts",
  "receipt": "receipts",
  "rollback": "rollback",
};

const ARRAY_SECTIONS = new Set([
  "operator_laws",
  "artifact_contracts",
  "data_contracts",
  "gauntlets",
]);

const OBJECT_SECTIONS = new Set([
  "identity",
  "scope",
  "target_matrix",
  "behavior_graph",
  "permissions",
  "model_roles",
  "receipts",
  "rollback",
]);

const STRING_SECTIONS = new Set(["product_intent"]);

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

/**
 * Parse AECode Source text into an AST + validated AECode object.
 *
 * @param {string} source - Raw AECode source (Markdown + optional YAML front matter).
 * @param {{ strict?: boolean, sourcePath?: string }} [opts]
 * @returns {{
 *   ok: boolean,
 *   ast: { aecode: object, sections: object, frontMatter: object|null, sourcePath: string|null },
 *   errors: Array<{ severity: 'error'|'warn', code: string, message: string, line?: number }>,
 *   validate: () => { ok: boolean, errors: Array<object> }
 * }}
 */
export function parseAECode(source, opts = {}) {
  if (typeof source !== "string") {
    return _fail("E_SOURCE_TYPE", "source must be a string");
  }

  const errors = [];
  const lines = source.split(/\r?\n/);

  const { frontMatter, bodyStart } = _extractFrontMatter(lines, errors);
  const sections = _splitSections(lines, bodyStart, errors);

  const aecode = _buildAECodeObject(frontMatter, sections, errors);

  _enforceRequiredSections(aecode, errors);

  const ast = {
    aecode,
    sections,
    frontMatter,
    sourcePath: opts.sourcePath || null,
  };

  const result = {
    ok: errors.every(e => e.severity !== "error"),
    ast,
    errors,
    validate: () => validateAECode(aecode),
  };

  if (opts.strict && !result.ok) {
    const first = errors.find(e => e.severity === "error");
    const err = new Error(`AECode parse failed: ${first?.code} ${first?.message}`);
    err.errors = errors;
    throw err;
  }

  return result;
}

/**
 * Validate an in-memory AECode object against the v0 schema contract.
 * Implements the rules in 09-SCHEMAS/aecode-final-format.schema.json without
 * pulling a JSON Schema engine — the schema is small and fixed.
 *
 * @param {object} aecode
 * @returns {{ ok: boolean, errors: Array<{ code: string, message: string, path: string }> }}
 */
export function validateAECode(aecode) {
  const errs = [];

  if (!aecode || typeof aecode !== "object" || Array.isArray(aecode)) {
    return { ok: false, errors: [{ code: "E_ROOT_TYPE", message: "aecode root must be object", path: "$" }] };
  }

  for (const key of REQUIRED_SECTIONS) {
    if (!(key in aecode)) {
      errs.push({ code: "E_MISSING_SECTION", message: `missing required section "${key}"`, path: `$.${key}` });
    }
  }

  _checkType(aecode, "identity", "object", errs);
  _checkType(aecode, "product_intent", "string", errs);
  _checkType(aecode, "operator_laws", "array", errs);
  _checkType(aecode, "scope", "object", errs);
  _checkType(aecode, "target_matrix", "object", errs);
  _checkType(aecode, "artifact_contracts", "array", errs);
  _checkType(aecode, "data_contracts", "array", errs);
  _checkType(aecode, "behavior_graph", "object", errs);
  _checkType(aecode, "permissions", "object", errs);
  _checkType(aecode, "model_roles", "object", errs);
  _checkType(aecode, "gauntlets", "array", errs);
  _checkType(aecode, "receipts", "object", errs);
  _checkType(aecode, "rollback", "object", errs);

  if (typeof aecode.product_intent === "string" && aecode.product_intent.trim().length === 0) {
    errs.push({ code: "E_EMPTY_INTENT", message: "product_intent must not be empty", path: "$.product_intent" });
  }
  if (Array.isArray(aecode.operator_laws) && aecode.operator_laws.length === 0) {
    errs.push({ code: "E_EMPTY_LAWS", message: "operator_laws must have at least one law", path: "$.operator_laws" });
  }

  return { ok: errs.length === 0, errors: errs };
}

export const AECODE_SECTIONS = REQUIRED_SECTIONS.slice();

// --------------------------------------------------------------------------
// Front matter
// --------------------------------------------------------------------------

function _extractFrontMatter(lines, errors) {
  if (lines.length === 0 || lines[0].trim() !== "---") {
    return { frontMatter: null, bodyStart: 0 };
  }
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") { close = i; break; }
  }
  if (close === -1) {
    errors.push({ severity: "error", code: "E_FRONT_MATTER_UNCLOSED",
      message: "front matter opened with --- but never closed", line: 1 });
    return { frontMatter: null, bodyStart: 0 };
  }
  const fmLines = lines.slice(1, close);
  const obj = _parseSimpleYaml(fmLines, 1, errors);
  return { frontMatter: obj, bodyStart: close + 1 };
}

// --------------------------------------------------------------------------
// Section split
// --------------------------------------------------------------------------

function _splitSections(lines, start, errors) {
  /** @type {Record<string, { canonical: string, raw: string, startLine: number, lines: string[] }>} */
  const sections = {};
  let current = null;
  let inFence = false;
  let fenceLang = null;

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^```(\S*)\s*$/);
    if (fenceMatch) {
      if (!inFence) { inFence = true; fenceLang = fenceMatch[1] || ""; }
      else { inFence = false; fenceLang = null; }
      if (current) current.lines.push(line);
      continue;
    }
    if (!inFence && /^##\s+/.test(line)) {
      const raw = line.replace(/^##\s+/, "").trim();
      const norm = raw.toLowerCase().replace(/[_\-]/g, " ").replace(/\s+/g, " ").trim();
      const canonical = SECTION_ALIASES[norm] || SECTION_ALIASES[raw.toLowerCase()] || null;
      if (!canonical) {
        errors.push({ severity: "warn", code: "W_UNKNOWN_SECTION",
          message: `unknown section heading "${raw}" — ignored`, line: i + 1 });
        current = null;
        continue;
      }
      if (sections[canonical]) {
        errors.push({ severity: "warn", code: "W_DUPLICATE_SECTION",
          message: `duplicate section "${canonical}" — later one wins`, line: i + 1 });
      }
      current = { canonical, raw, startLine: i + 1, lines: [] };
      sections[canonical] = current;
      continue;
    }
    if (current) current.lines.push(line);
  }

  if (inFence) {
    errors.push({ severity: "error", code: "E_FENCE_UNCLOSED",
      message: "code fence opened but never closed" });
  }

  return sections;
}

// --------------------------------------------------------------------------
// Section body parsers
// --------------------------------------------------------------------------

function _buildAECodeObject(frontMatter, sections, errors) {
  const aecode = {};

  // identity seeds from front matter; section body, if present, overlays.
  if (frontMatter && typeof frontMatter === "object") {
    if (frontMatter.identity && typeof frontMatter.identity === "object") {
      aecode.identity = { ...frontMatter.identity };
    } else {
      const { identity, ...rest } = frontMatter;
      if (Object.keys(rest).length > 0) aecode.identity = rest;
    }
  }

  for (const key of REQUIRED_SECTIONS) {
    const sec = sections[key];
    if (!sec) continue;

    const trimmedBody = _trimBlank(sec.lines);
    let parsed;
    try {
      if (STRING_SECTIONS.has(key)) {
        parsed = _parseStringSection(trimmedBody);
      } else if (ARRAY_SECTIONS.has(key)) {
        parsed = _parseArraySection(trimmedBody, sec.startLine, errors);
      } else if (OBJECT_SECTIONS.has(key)) {
        parsed = _parseObjectSection(trimmedBody, sec.startLine, errors);
      } else {
        parsed = _parseStringSection(trimmedBody);
      }
    } catch (e) {
      errors.push({ severity: "error", code: "E_SECTION_PARSE",
        message: `failed to parse section "${key}": ${e.message}`, line: sec.startLine });
      continue;
    }

    if (key === "identity" && aecode.identity && parsed && typeof parsed === "object") {
      aecode.identity = { ...aecode.identity, ...parsed };
    } else {
      aecode[key] = parsed;
    }
  }

  return aecode;
}

function _parseStringSection(lines) {
  return lines.join("\n").trim();
}

function _parseArraySection(lines, startLine, errors) {
  // 1) fenced ```yaml / ```json block wins if present.
  const fenced = _extractFenced(lines);
  if (fenced) {
    if (fenced.lang === "json") {
      return _safeJson(fenced.body, startLine, errors) ?? [];
    }
    const parsed = _parseSimpleYaml(fenced.body.split(/\r?\n/), startLine, errors);
    return Array.isArray(parsed) ? parsed : _coerceToArray(parsed);
  }

  // 2) Markdown bullet list. Each `-` item may have a nested key-value block.
  const items = _parseBulletList(lines, startLine, errors);
  return items;
}

function _parseObjectSection(lines, startLine, errors) {
  const fenced = _extractFenced(lines);
  if (fenced) {
    if (fenced.lang === "json") {
      return _safeJson(fenced.body, startLine, errors) ?? {};
    }
    const parsed = _parseSimpleYaml(fenced.body.split(/\r?\n/), startLine, errors);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  }

  // Markdown table? (target_matrix in particular.)
  const table = _parseMarkdownTable(lines);
  if (table) return table;

  // Otherwise: simple yaml-style key:value plus nested bullets.
  return _parseSimpleYaml(lines, startLine, errors) || {};
}

// --------------------------------------------------------------------------
// Bullet list → array of strings or objects
// --------------------------------------------------------------------------

function _parseBulletList(lines, startLine, errors) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (!m) { i++; continue; }
    const indent = m[1].length;
    const head = m[2];

    // Collect nested lines belonging to this bullet (deeper indent, non-bullet at same indent).
    const nested = [];
    let j = i + 1;
    while (j < lines.length) {
      const nl = lines[j];
      if (nl.trim() === "") { nested.push(nl); j++; continue; }
      const nm = nl.match(/^(\s*)[-*+]\s+/);
      if (nm && nm[1].length <= indent) break;
      if (!nm && nl.match(/^\s*\S/) && _leadingSpaces(nl) <= indent) break;
      nested.push(nl);
      j++;
    }
    i = j;

    // If head is "key: value" (REQUIRES whitespace after colon — see _yamlList for why)
    // or nested has yaml-style keys → object item.
    const headKv = head.match(/^([A-Za-z_][\w\-]*)\s*:(?:\s+(.*)|$)/);
    if (headKv || nested.some(n => /^\s*[A-Za-z_][\w\-]*\s*:(?:\s+|\s*$)/.test(n))) {
      const obj = {};
      if (headKv) {
        const val = (headKv[2] !== undefined ? headKv[2] : "").trim();
        if (val) obj[headKv[1]] = _scalar(val);
      } else {
        // bare head text — keep as `_text` for traceability
        if (head.trim()) obj._text = head.trim();
      }
      const dedented = _dedent(nested);
      const sub = _parseSimpleYaml(dedented, startLine, errors);
      if (sub && typeof sub === "object" && !Array.isArray(sub)) Object.assign(obj, sub);
      out.push(obj);
    } else {
      out.push(head.trim());
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// Simple YAML (sufficient for AECode bodies — not a full YAML 1.2 engine).
// Supports:
//   key: value (scalar — string/number/bool/null)
//   key:           (followed by indented block: nested map or bullet list)
//     subkey: ...
//   - listitem
//   - key: value (list of maps via consecutive `-` blocks)
// Quoted strings: "..." and '...'.
// --------------------------------------------------------------------------

function _parseSimpleYaml(lines, startLine, errors) {
  const cleaned = lines.filter(l => !/^\s*#/.test(l));
  const { value } = _yamlBlock(cleaned, 0, -1, startLine, errors);
  return value;
}

function _yamlBlock(lines, start, parentIndent, startLine, errors) {
  // Detect: is this block a list (starts with `-`) or a map?
  let i = start;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i >= lines.length) return { value: null, next: i };

  const firstIndent = _leadingSpaces(lines[i]);
  if (firstIndent <= parentIndent) return { value: null, next: start };

  const isList = /^\s*[-*+]\s/.test(lines[i]);
  if (isList) return _yamlList(lines, i, firstIndent, startLine, errors);
  return _yamlMap(lines, i, firstIndent, startLine, errors);
}

function _yamlMap(lines, start, indent, startLine, errors) {
  const map = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    const li = _leadingSpaces(line);
    if (li < indent) break;
    if (li > indent) { i++; continue; } // belongs to previous key — handled by recursion below

    const m = line.slice(indent).match(/^([^:\s][^:]*?)\s*:\s*(.*)$/);
    if (!m) {
      // Not a key:value at this indent — bail out so caller can decide.
      break;
    }
    const key = m[1].trim();
    const rawVal = m[2];
    i++;

    if (rawVal !== "" && rawVal !== undefined) {
      map[key] = _scalar(rawVal);
      continue;
    }

    // Block value follows.
    const { value, next } = _yamlBlock(lines, i, indent, startLine, errors);
    map[key] = value !== null ? value : "";
    i = next;
  }
  return { value: map, next: i };
}

function _yamlList(lines, start, indent, startLine, errors) {
  const list = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    const li = _leadingSpaces(line);
    if (li < indent) break;
    if (li > indent) { i++; continue; }

    const m = line.slice(indent).match(/^[-*+]\s+(.*)$/);
    if (!m) break;
    const itemHead = m[1];
    i++;

    // If itemHead has `key: value` (REQUIRES whitespace after the colon to disambiguate
    // from scoped identifiers like `read:04-CONTROL-PLANE` which are intended as strings).
    // A trailing colon with no value (`key:`) also qualifies (block follows).
    const kvMatch = itemHead.match(/^([A-Za-z_][\w\-]*)\s*:(?:\s+(.*)|$)/);
    if (kvMatch) {
      const obj = {};
      const inlineVal = kvMatch[2] !== undefined ? kvMatch[2] : "";
      if (inlineVal.trim() !== "") obj[kvMatch[1]] = _scalar(inlineVal);
      else {
        const sub = _yamlBlock(lines, i, indent + 2, startLine, errors);
        if (sub.value && typeof sub.value === "object") obj[kvMatch[1]] = sub.value;
        i = sub.next;
      }
      // Continue gathering keys at indent + 2 for this list item.
      while (i < lines.length) {
        const nl = lines[i];
        if (nl.trim() === "") { i++; continue; }
        const nli = _leadingSpaces(nl);
        if (nli <= indent) break;
        const km = nl.slice(nli).match(/^([A-Za-z_][\w\-]*)\s*:\s*(.*)$/);
        if (!km) break;
        if (km[2].trim() !== "") {
          obj[km[1]] = _scalar(km[2]);
          i++;
        } else {
          i++;
          const sub2 = _yamlBlock(lines, i, nli, startLine, errors);
          obj[km[1]] = sub2.value;
          i = sub2.next;
        }
      }
      list.push(obj);
    } else if (itemHead.trim() === "") {
      // bare `-` followed by indented block
      const sub = _yamlBlock(lines, i, indent, startLine, errors);
      list.push(sub.value);
      i = sub.next;
    } else {
      list.push(_scalar(itemHead.trim()));
    }
  }
  return { value: list, next: i };
}

// --------------------------------------------------------------------------
// Markdown table → object
//   | key | value |
//   |-----|-------|
//   | foo | bar   |
// --------------------------------------------------------------------------

function _parseMarkdownTable(lines) {
  const nonBlank = lines.filter(l => l.trim() !== "");
  if (nonBlank.length < 2) return null;
  if (!/^\s*\|/.test(nonBlank[0])) return null;
  if (!/^\s*\|?\s*:?-+/.test(nonBlank[1])) return null;

  const cells = (row) => row.trim().replace(/^\|/, "").replace(/\|$/, "")
    .split("|").map(c => c.trim());
  const header = cells(nonBlank[0]);
  const rows = nonBlank.slice(2).map(cells);

  // Always key by the first column. 2-column tables nest the value under the second
  // header name so consumers can do `target_matrix[key].lane` — preserves header semantics
  // and stays consistent with wider tables.
  const out = {};
  for (const r of rows) {
    if (!r[0]) continue;
    const row = {};
    for (let c = 1; c < header.length; c++) row[header[c]] = _scalar(r[c] ?? "");
    out[r[0]] = row;
  }
  return out;
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function _extractFenced(lines) {
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  const open = lines[i]?.match(/^```(\S*)\s*$/);
  if (!open) return null;
  const lang = (open[1] || "").toLowerCase();
  const body = [];
  let j = i + 1;
  while (j < lines.length) {
    if (/^```\s*$/.test(lines[j])) break;
    body.push(lines[j]);
    j++;
  }
  if (j >= lines.length) return null;
  return { lang, body: body.join("\n") };
}

function _safeJson(text, startLine, errors) {
  try { return JSON.parse(text); }
  catch (e) {
    errors.push({ severity: "error", code: "E_BAD_JSON",
      message: `embedded JSON failed to parse: ${e.message}`, line: startLine });
    return null;
  }
}

function _scalar(raw) {
  const s = raw.trim();
  if (s === "") return "";
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  // inline list: [a, b, c]
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map(p => _scalar(p));
  }
  return s;
}

function _leadingSpaces(line) {
  const m = line.match(/^(\s*)/);
  return m ? m[1].length : 0;
}

function _dedent(lines) {
  const min = lines
    .filter(l => l.trim() !== "")
    .map(l => _leadingSpaces(l))
    .reduce((a, b) => Math.min(a, b), Infinity);
  if (!isFinite(min) || min === 0) return lines.slice();
  return lines.map(l => l.slice(min));
}

function _trimBlank(lines) {
  let s = 0, e = lines.length;
  while (s < e && lines[s].trim() === "") s++;
  while (e > s && lines[e - 1].trim() === "") e--;
  return lines.slice(s, e);
}

function _coerceToArray(v) {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === "object") return Object.entries(v).map(([k, val]) => ({ [k]: val }));
  return [v];
}

function _checkType(obj, key, kind, errs) {
  if (!(key in obj)) return; // missing-section error reported elsewhere
  const v = obj[key];
  const path = `$.${key}`;
  if (kind === "array") {
    if (!Array.isArray(v)) errs.push({ code: "E_TYPE", message: `${key} must be array`, path });
  } else if (kind === "object") {
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      errs.push({ code: "E_TYPE", message: `${key} must be object`, path });
    }
  } else if (kind === "string") {
    if (typeof v !== "string") errs.push({ code: "E_TYPE", message: `${key} must be string`, path });
  }
}

function _enforceRequiredSections(aecode, errors) {
  for (const key of REQUIRED_SECTIONS) {
    if (!(key in aecode)) {
      errors.push({ severity: "error", code: "E_MISSING_SECTION",
        message: `missing required section "${key}"` });
    }
  }
}

function _fail(code, message) {
  return {
    ok: false,
    ast: { aecode: {}, sections: {}, frontMatter: null, sourcePath: null },
    errors: [{ severity: "error", code, message }],
    validate: () => ({ ok: false, errors: [{ code, message, path: "$" }] }),
  };
}

// --------------------------------------------------------------------------
// CLI: node parser.mjs <path> → prints AST + validation summary.
// --------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  const fs = await import("node:fs");
  const path = process.argv[2];
  if (!path) {
    console.error("usage: node parser.mjs <aecode-source.md>");
    process.exit(2);
  }
  const src = fs.readFileSync(path, "utf8");
  const parsed = parseAECode(src, { sourcePath: path });
  const v = parsed.validate();
  const out = {
    ok: parsed.ok && v.ok,
    parse_errors: parsed.errors,
    validate_errors: v.errors,
    aecode: parsed.ast.aecode,
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
}
