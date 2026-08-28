// LOOM 8 gates — Hermes pre-flight chain.

export const LOOM_GATES = [
  "order_schema",
  "report_schema",
  "receipt_spine",
  "human_approval",
  "codexa_lease",
  "openai_gateway",
  "mcp_default",
  "false_green_guard",
];

/**
 * @param {Object} ctx — { order, lease, report, receipt_path, has_human_approval, has_openai_gateway, has_mcp_default, status }
 * @returns {{ pass: boolean, gates: {gate: string, pass: boolean, reason?: string}[] }}
 */
export function runLoom(ctx) {
  const results = [];

  results.push({ gate: "order_schema", pass: ctx.order?.schema === "orange.order.v1" });
  results.push({ gate: "report_schema", pass: ctx.report?.schema === "orange.report.v1" });
  results.push({ gate: "receipt_spine", pass: Boolean(ctx.receipt_path) });
  results.push({ gate: "human_approval", pass: ctx.lease?.requires_approval ? Boolean(ctx.has_human_approval) : true });
  results.push({ gate: "codexa_lease", pass: Boolean(ctx.lease) });
  results.push({ gate: "openai_gateway", pass: Boolean(ctx.has_openai_gateway ?? true) });
  results.push({ gate: "mcp_default", pass: Boolean(ctx.has_mcp_default ?? true) });

  const fakeWords = ["green_assumed", "looks_ok", "probably", "should_work", "fake_green"];
  const status = (ctx.status || "").toLowerCase();
  const fakeHit = fakeWords.some(w => status.includes(w));
  results.push({ gate: "false_green_guard", pass: !fakeHit, reason: fakeHit ? "fake-green word in status" : undefined });

  for (const r of results) {
    if (!r.pass && !r.reason) r.reason = `${r.gate} not satisfied`;
  }

  return { pass: results.every(r => r.pass), gates: results };
}
