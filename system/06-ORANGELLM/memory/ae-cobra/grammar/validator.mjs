// validator.mjs — AgentTurn JSON validator for Æ Cobra daemon output.
//
// Source of truth (in this order):
//   1. grammar/agent_turn.gbnf  — llama.cpp logit-layer constraint
//   2. schemas/agent-turn.schema.json — JSON Schema (Draft 2020-12)
//
// This file is the parser-layer "belt-and-suspenders" validator referenced
// in README §"What the daemon does" step 3. It runs after JSON.parse on the
// llama.cpp /completion response and BEFORE Flux append, so any drift past
// the grammar (truncation, unicode edge cases, future grammar relaxation)
// is caught before contaminating the hash-chained ledger.
//
// Zero deps. Pure ESM. Safe to import from flow-direct/server.mjs and the
// smoke-test harness without dragging in ajv.
//
// NOTE on the task prompt: the spawning prompt described AgentTurn as
// {intent, action, evidence, refusal_reason?, lease_id}. That shape is NOT
// what the existing GBNF + JSON Schema enforce. The scaffolding in this
// directory is the source of truth; this validator implements the canonical
// shape: {lane, event_type, summary, entities, files, commands, risk,
// next_action, confidence}. If the prompt's shape is the intended future
// schema, the GBNF and JSON Schema must be updated first — drift here would
// silently break the daemon. See notes in StructuredOutput.

const LANES = new Set(["reality", "thought", "merge"]);
const EVENT_TYPES = new Set([
  "observation",
  "decision",
  "error",
  "checkpoint",
  "recall",
  "receipt",
  "risk",
]);
const RISKS = new Set(["low", "medium", "high"]);

const SHORT_MAX = 240;
const ENTITY_MAX = 80;
const ARRAY_MAX = 20;

const REQUIRED_KEYS = [
  "lane",
  "event_type",
  "summary",
  "entities",
  "files",
  "commands",
  "risk",
  "next_action",
  "confidence",
];

/**
 * Validate an AgentTurn object (already JSON.parse'd).
 *
 * @param {unknown} obj - parsed JSON value (typically from llama.cpp /completion)
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateAgentTurn(obj) {
  const errors = [];

  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return { valid: false, errors: ["root: not a JSON object"] };
  }

  // additionalProperties: false — reject unknown keys (matches JSON Schema)
  const allowed = new Set(REQUIRED_KEYS);
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) errors.push(`unknown property: ${k}`);
  }

  // required keys present
  for (const k of REQUIRED_KEYS) {
    if (!(k in obj)) errors.push(`missing required: ${k}`);
  }

  // lane
  if ("lane" in obj) {
    if (typeof obj.lane !== "string") {
      errors.push("lane: not a string");
    } else if (!LANES.has(obj.lane)) {
      errors.push(`lane: must be one of reality|thought|merge, got "${obj.lane}"`);
    }
  }

  // event_type
  if ("event_type" in obj) {
    if (typeof obj.event_type !== "string") {
      errors.push("event_type: not a string");
    } else if (!EVENT_TYPES.has(obj.event_type)) {
      errors.push(
        `event_type: must be one of observation|decision|error|checkpoint|recall|receipt|risk, got "${obj.event_type}"`
      );
    }
  }

  // summary
  validateShortString(obj, "summary", SHORT_MAX, errors, { allowEmpty: false });

  // next_action
  validateShortString(obj, "next_action", SHORT_MAX, errors, { allowEmpty: false });

  // entities — array of strings, each ≤ 80
  validateStringArray(obj, "entities", ENTITY_MAX, ARRAY_MAX, errors);

  // files — array of strings, each ≤ 240
  validateStringArray(obj, "files", SHORT_MAX, ARRAY_MAX, errors);

  // commands — array of strings, each ≤ 240
  validateStringArray(obj, "commands", SHORT_MAX, ARRAY_MAX, errors);

  // risk
  if ("risk" in obj) {
    if (typeof obj.risk !== "string") {
      errors.push("risk: not a string");
    } else if (!RISKS.has(obj.risk)) {
      errors.push(`risk: must be one of low|medium|high, got "${obj.risk}"`);
    }
  }

  // confidence — number in [0, 1]
  if ("confidence" in obj) {
    const c = obj.confidence;
    if (typeof c !== "number" || Number.isNaN(c)) {
      errors.push("confidence: not a number");
    } else if (c < 0 || c > 1) {
      errors.push(`confidence: out of range [0,1], got ${c}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

function validateShortString(obj, key, max, errors, { allowEmpty }) {
  if (!(key in obj)) return; // missing already reported
  const v = obj[key];
  if (typeof v !== "string") {
    errors.push(`${key}: not a string`);
    return;
  }
  if (!allowEmpty && v.length === 0) {
    errors.push(`${key}: empty string not allowed`);
  }
  if (v.length > max) {
    errors.push(`${key}: length ${v.length} exceeds max ${max}`);
  }
  if (/[\r\n]/.test(v)) {
    errors.push(`${key}: contains newline (GBNF short_string forbids \\n\\r)`);
  }
}

function validateStringArray(obj, key, itemMax, arrayMax, errors) {
  if (!(key in obj)) return; // missing already reported
  const v = obj[key];
  if (!Array.isArray(v)) {
    errors.push(`${key}: not an array`);
    return;
  }
  if (v.length > arrayMax) {
    errors.push(`${key}: ${v.length} items exceeds max ${arrayMax}`);
  }
  for (let i = 0; i < v.length; i++) {
    const item = v[i];
    if (typeof item !== "string") {
      errors.push(`${key}[${i}]: not a string`);
      continue;
    }
    if (item.length > itemMax) {
      errors.push(`${key}[${i}]: length ${item.length} exceeds max ${itemMax}`);
    }
    if (/[\r\n]/.test(item)) {
      errors.push(`${key}[${i}]: contains newline`);
    }
  }
}

/**
 * Parse-and-validate convenience wrapper. Use this when handed the raw
 * llama.cpp response string. JSON.parse failures are returned as errors
 * rather than thrown, so callers can drop the row into thought.flux as a
 * rejection without try/catch ceremony.
 *
 * @param {string} jsonText
 * @returns {{ valid: boolean, errors: string[], value: object | null }}
 */
export function parseAndValidate(jsonText) {
  if (typeof jsonText !== "string") {
    return { valid: false, errors: ["input: not a string"], value: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    return {
      valid: false,
      errors: [`json parse: ${e instanceof Error ? e.message : String(e)}`],
      value: null,
    };
  }
  const { valid, errors } = validateAgentTurn(parsed);
  return { valid, errors, value: valid ? parsed : null };
}

export default validateAgentTurn;
