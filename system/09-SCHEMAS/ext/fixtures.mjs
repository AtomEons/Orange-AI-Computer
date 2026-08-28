#!/usr/bin/env bun
/**
 * fixtures.mjs — canonical valid + invalid example documents per schema.
 *
 * ADDITIVE LANE LAW: pure data + tiny helpers. Imports nothing that writes to
 * disk. These fixtures are the shared truth used by every ext/ test so that
 * "what a valid order looks like" lives in exactly one place.
 *
 * Shape:
 *   FIXTURES.order_v1  = { valid: [ {name, doc} ... ], invalid: [ {name, doc, expect:{path?, rule?}} ... ] }
 *   FIXTURES.order_v2  = { valid: [...], invalid: [...] }
 *   FIXTURES.report_v1 = { valid: [...], invalid: [...] }
 *
 * Each invalid fixture documents WHY it is invalid via `expect` (a path and/or
 * rule the validator should report). Tests assert both that the doc is rejected
 * AND that the failure names the expected field — so a fixture can't silently
 * rot into "rejected for the wrong reason".
 *
 * Every valid v1 order fixture is also a legal v1 document under the frozen
 * schema; test-fixtures.mjs cross-checks each fixture against BOTH the
 * hand-rolled hot-path validator and the generic schema-compiled validator.
 */

import { ORDER_V1_ID, ORDER_V2_ID, REPORT_V1_ID } from "./envelope-validate.mjs";

/** A minimal, canonical valid v1 order — the golden reference. */
export function goldenOrderV1() {
  return {
    schema: ORDER_V1_ID,
    orderId: "ord-0001",
    action: "compress.receipts",
    intent: "compress the receipt corpus",
    scope: "10-RECEIPTS/**",
    allowedActions: ["read", "compress", "write-receipt"],
    forbiddenActions: ["delete", "network"],
    targetProject: "orange5",
    riskLevel: "low",
    requiresReceipt: true,
    operatorApproved: false,
    createdAt: "2026-07-04T12:00:00Z",
  };
}

/** A canonical valid v1 report. */
export function goldenReportV1() {
  return {
    schema: REPORT_V1_ID,
    orderId: "ord-0001",
    status: "ok",
    confidence: 0.92,
    actionsTaken: ["read 6211 receipts", "compressed to 1 artifact"],
    evidence: [{ kind: "ratio", value: "50.24x" }, { kind: "tests", value: "35/35" }],
    blockers: [],
    nextAction: "await operator promotion",
    receiptPath: "10-RECEIPTS/orange5-build/ord-0001.json",
    ae_lane: "compression",
    ae_host: "local",
  };
}

/** A canonical valid v2 order (v1 golden + explicit v2 additions). */
export function goldenOrderV2() {
  return {
    ...goldenOrderV1(),
    schema: ORDER_V2_ID,
    seed: 42,
    dry_run: false,
    budget: { max_tokens: 100000, max_seconds: 120, max_usd: 5, max_subagents: 8 },
    egress_declared: ["api.anthropic.com", "*.githubusercontent.com:443"],
  };
}

export const FIXTURES = {
  order_v1: {
    valid: [
      { name: "golden", doc: goldenOrderV1() },
      {
        name: "minimal-required-only",
        doc: {
          schema: ORDER_V1_ID,
          orderId: "abc",
          action: "read.status",
          intent: "x",
          scope: "y",
          allowedActions: [],
          forbiddenActions: [],
          targetProject: "orange5",
          riskLevel: "read_only",
          requiresReceipt: false,
        },
      },
      {
        // v1 is additionalProperties:true — carrying a v2-shaped field is legal v1.
        name: "carries-extra-field-allowed",
        doc: { ...goldenOrderV1(), some_future_field: { nested: true }, seed: 7 },
      },
      {
        name: "risk-production",
        doc: { ...goldenOrderV1(), riskLevel: "production", operatorApproved: true },
      },
    ],
    invalid: [
      {
        name: "wrong-schema-const",
        doc: { ...goldenOrderV1(), schema: "orange.order.v9" },
        expect: { path: "/schema", rule: "const" },
      },
      {
        name: "missing-orderId",
        doc: (() => { const d = goldenOrderV1(); delete d.orderId; return d; })(),
        expect: { path: "/orderId" },
      },
      {
        name: "missing-action",
        doc: (() => { const d = goldenOrderV1(); delete d.action; return d; })(),
        expect: { path: "/action" },
      },
      {
        name: "orderId-too-short",
        doc: { ...goldenOrderV1(), orderId: "xy" },
        expect: { path: "/orderId", rule: "minLength" },
      },
      {
        name: "bad-risk-level",
        doc: { ...goldenOrderV1(), riskLevel: "catastrophic" },
        expect: { path: "/riskLevel", rule: "enum" },
      },
      {
        name: "requiresReceipt-not-boolean",
        doc: { ...goldenOrderV1(), requiresReceipt: "yes" },
        expect: { path: "/requiresReceipt", rule: "type" },
      },
      {
        name: "allowedActions-not-string-array",
        doc: { ...goldenOrderV1(), allowedActions: [1, 2, 3] },
        expect: { path: "/allowedActions", rule: "type" },
      },
      {
        name: "empty-intent",
        doc: { ...goldenOrderV1(), intent: "" },
        expect: { path: "/intent", rule: "minLength" },
      },
    ],
  },

  order_v2: {
    valid: [
      { name: "golden-v2", doc: goldenOrderV2() },
      {
        name: "all-additions-absent",
        doc: { ...goldenOrderV1(), schema: ORDER_V2_ID },
      },
      {
        name: "seed-null",
        doc: { ...goldenOrderV2(), seed: null },
      },
      {
        name: "budget-null-and-empty-egress",
        doc: { ...goldenOrderV2(), budget: null, egress_declared: [] },
      },
      {
        name: "single-budget-key",
        doc: { ...goldenOrderV2(), budget: { max_usd: 1 } },
      },
      {
        name: "with-x-migration-marker",
        doc: {
          ...goldenOrderV1(),
          schema: ORDER_V2_ID,
          seed: null,
          dry_run: false,
          budget: null,
          egress_declared: [],
          x_migration: { from: ORDER_V1_ID, to: ORDER_V2_ID, added: ["seed", "dry_run", "budget", "egress_declared"], tool: "migrate-v1-v2.mjs" },
        },
      },
    ],
    invalid: [
      {
        name: "seed-negative",
        doc: { ...goldenOrderV2(), seed: -1 },
        expect: { path: "/seed", rule: "type" },
      },
      {
        name: "seed-fractional",
        doc: { ...goldenOrderV2(), seed: 3.5 },
        expect: { path: "/seed", rule: "type" },
      },
      {
        name: "dry_run-not-boolean",
        doc: { ...goldenOrderV2(), dry_run: 1 },
        expect: { path: "/dry_run", rule: "type" },
      },
      {
        name: "budget-unknown-key",
        doc: { ...goldenOrderV2(), budget: { max_credits: 5 } },
        expect: { path: "/budget/max_credits", rule: "additionalProperties" },
      },
      {
        name: "budget-negative-value",
        doc: { ...goldenOrderV2(), budget: { max_tokens: -10 } },
        expect: { path: "/budget/max_tokens", rule: "type" },
      },
      {
        name: "budget-empty-object",
        doc: { ...goldenOrderV2(), budget: {} },
        expect: { path: "/budget", rule: "minProperties" },
      },
      {
        name: "egress-bad-host",
        doc: { ...goldenOrderV2(), egress_declared: ["NOT A HOST"] },
        expect: { path: "/egress_declared/0", rule: "pattern" },
      },
      {
        name: "egress-duplicate",
        doc: { ...goldenOrderV2(), egress_declared: ["a.com", "a.com"] },
        expect: { path: "/egress_declared/1", rule: "uniqueItems" },
      },
      {
        // v1 required contract still holds under v2
        name: "missing-required-scope",
        doc: (() => { const d = goldenOrderV2(); delete d.scope; return d; })(),
        expect: { path: "/scope" },
      },
    ],
  },

  report_v1: {
    valid: [
      { name: "golden", doc: goldenReportV1() },
      {
        name: "minimal-required-only",
        doc: {
          schema: REPORT_V1_ID,
          orderId: "abc",
          status: "ok",
          confidence: 0,
          actionsTaken: [],
          evidence: [],
          blockers: [],
          nextAction: "",
          receiptPath: "x",
        },
      },
      {
        name: "confidence-one-with-blockers",
        doc: { ...goldenReportV1(), confidence: 1, status: "blocked", blockers: ["needs approval"] },
      },
    ],
    invalid: [
      {
        name: "wrong-schema-const",
        doc: { ...goldenReportV1(), schema: "orange.report.v2" },
        expect: { path: "/schema", rule: "const" },
      },
      {
        name: "confidence-above-one",
        doc: { ...goldenReportV1(), confidence: 1.5 },
        expect: { path: "/confidence" },
      },
      {
        name: "confidence-not-number",
        doc: { ...goldenReportV1(), confidence: "high" },
        expect: { path: "/confidence" },
      },
      {
        name: "evidence-not-object-array",
        doc: { ...goldenReportV1(), evidence: ["a string"] },
        expect: { path: "/evidence", rule: "type" },
      },
      {
        name: "missing-receiptPath",
        doc: (() => { const d = goldenReportV1(); delete d.receiptPath; return d; })(),
        expect: { path: "/receiptPath" },
      },
      {
        name: "status-too-short",
        doc: { ...goldenReportV1(), status: "x" },
        expect: { path: "/status", rule: "minLength" },
      },
      {
        name: "blockers-not-string-array",
        doc: { ...goldenReportV1(), blockers: [{ not: "a string" }] },
        expect: { path: "/blockers", rule: "type" },
      },
    ],
  },
};

/** Flat iterator over every fixture, tagged with its schema key + validity. */
export function* allFixtures() {
  for (const [schemaKey, group] of Object.entries(FIXTURES)) {
    for (const f of group.valid) yield { schemaKey, valid: true, ...f };
    for (const f of group.invalid) yield { schemaKey, valid: false, ...f };
  }
}

// ---------------------------------------------------------------------------
// CLI: bun fixtures.mjs  -> prints a compact census of the fixture corpus.
// ---------------------------------------------------------------------------
if (import.meta.main) {
  const rows = [];
  for (const [k, g] of Object.entries(FIXTURES)) {
    rows.push(`${k}: ${g.valid.length} valid, ${g.invalid.length} invalid`);
  }
  console.log(rows.join("\n"));
}
