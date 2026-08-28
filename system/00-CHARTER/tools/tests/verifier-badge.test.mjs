#!/usr/bin/env bun
// Standalone test harness for verifier-badge.mjs (no framework import).
// Verifies the pure reducers without spawning the real (multi-minute) verifier.
// Run:  bun 00-CHARTER/tools/tests/verifier-badge.test.mjs

import { badgeFromVerifierJson, toShield, extractJson } from '../verifier-badge.mjs';

let pass = 0, fail = 0;
const T = (name, cond) => {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
};

const FIXED = new Date('2026-07-04T12:00:00.000Z');

// --- badgeFromVerifierJson ---
const allGreen = badgeFromVerifierJson({ total: 58, green: 58, red: 0, reds: [] }, FIXED);
T('all-green pct = 100', allGreen.pct === 100);
T('all-green flag true', allGreen.allGreen === true);
T('all-green green count', allGreen.green === 58);
T('all-green red count', allGreen.red === 0);
T('timestamp is fixed ISO', allGreen.timestamp === '2026-07-04T12:00:00.000Z');

const someRed = badgeFromVerifierJson({ total: 58, green: 52, red: 6, reds: [] }, FIXED);
T('some-red pct = 89.7', someRed.pct === 89.7);
T('some-red flag false', someRed.allGreen === false);
T('some-red red = 6', someRed.red === 6);

// red derived when missing
const derived = badgeFromVerifierJson({ total: 10, green: 7 }, FIXED);
T('derived red = total - green', derived.red === 3);
T('derived pct = 70', derived.pct === 70);

// zero-tests edge — pct honest 0, not NaN, not green
const empty = badgeFromVerifierJson({ total: 0, green: 0, red: 0 }, FIXED);
T('zero-total pct = 0 (not NaN)', empty.pct === 0);
T('zero-total not allGreen', empty.allGreen === false);

// non-object input rejected
let threw = false;
try { badgeFromVerifierJson(null); } catch { threw = true; }
T('null input throws', threw === true);

// --- toShield ---
const shieldGreen = toShield(allGreen);
T('shield green color brightgreen', shieldGreen.color === 'brightgreen');
T('shield message has count', shieldGreen.message === '58/58 (100%)');
T('shield schemaVersion 1', shieldGreen.schemaVersion === 1);
const shieldRed = toShield(someRed);
T('shield red color red', shieldRed.color === 'red');

// --- extractJson ---
const parsed = extractJson('WARNING: something\n{"total":3,"green":3,"red":0}\n');
T('extractJson pulls object past prefix', parsed.total === 3 && parsed.green === 3);
let exThrew = false;
try { extractJson('no json here'); } catch { exThrew = true; }
T('extractJson throws on no-json', exThrew === true);

// round-trip: extract then reduce
const rt = badgeFromVerifierJson(extractJson('{"total":4,"green":2,"red":2}'), FIXED);
T('round-trip pct = 50', rt.pct === 50);

const total = pass + fail;
console.log(`Summary: ${pass} pass / ${fail} fail of ${total}`);
process.exit(fail === 0 ? 0 : 1);
