#!/usr/bin/env bun
import { chat, executeDelegation, executeOrder, healthSnapshot, readReceipts } from "./orange5-headless-core.mjs";
import { discoverComputeFabric, configureComputeNode } from "./compute-fabric.mjs";
import { activateProject, clearProjectLock, readProjectLock } from "./project-lock.mjs";

const args = process.argv.slice(2);
const command = args[0] || "status";
const json = args.includes("--json") || !process.stdout.isTTY;

let result;
if (command === "status" || command === "health") result = await healthSnapshot();
else if (command === "fabric") result = await fabricCommand();
else if (command === "project") result = projectCommand();
else if (command === "ask") result = await chat(valueAfter("ask") || valueAfter("--message"), { model: valueAfter("--model") || "orange-auto" });
else if (command === "order") result = await executeOrder(parseOrder(valueAfter("order")), { learn: !args.includes("--no-learn") });
else if (command === "route") result = await executeOrder(parseOrder(valueAfter("route")), { dryRun: true });
else if (command === "delegate") result = await executeDelegation({ order: parseOrderWithIntent(valueAfter("delegate")), execute: !args.includes("--plan-only"), maxAgents: Number(valueAfter("--max-agents")) || undefined });
else if (command === "receipts") result = readReceipts(Number(valueAfter("receipts")) || 10);
else usage(2);

if (json) console.log(JSON.stringify(result, null, 2));
else render(result, command);
if (result?.ok === false || result?.operational === false) process.exitCode = 1;

function valueAfter(token) {
  const index = args.indexOf(token);
  return index >= 0 ? args[index + 1] : undefined;
}
function parseOrder(value) {
  if (!value) usage(2);
  try { return JSON.parse(value); }
  catch { return { action: value, payload: {} }; }
}
function parseOrderWithIntent(value) {
  const order = parseOrder(value);
  const intent = valueAfter("--intent");
  return intent ? { ...order, intent } : order;
}
function render(value, kind) {
  const orange = "\x1b[38;5;208m";
  const dim = "\x1b[2m";
  const reset = "\x1b[0m";
  console.log(`${orange}ORANGE${reset} ${dim}/ ORANGEFIVE HEADLESS${reset}`);
  console.log("----------------------------------------");
  if (kind === "status" || kind === "health") {
    row("STATE", value.status);
    row("GATEWAY", `${flag(value.gateway?.ready)} ${value.gateway?.url}  ${value.gateway?.latencyMs ?? "-"}ms`);
    row("BRAIN", `${flag(value.activeBrain?.live)} ${value.activeBrain?.model ?? "unresolved"}  ${value.activeBrain?.host ?? "-"}`);
    row("REFLEX", `${flag(value.reflex?.ready)} ${value.reflex?.runtime ?? "-"}  no model`);
    row("CODEXA", `${flag(value.codexa?.reachable)} ${value.codexa?.host}:${value.codexa?.railPort}`);
    row("FABRIC", `${value.fabric?.mode ?? "unknown"}  ${value.fabric?.nodes?.filter((node) => node.online).length ?? 0} online`);
    row("PROJECT", value.activeProject ? `${value.activeProject.name}  ${value.activeProject.root}` : "not mounted");
    row("RECEIPTS", `${value.receipts?.persisted ?? 0} persisted`);
    if (value.blockers?.length) { console.log("\nBLOCKERS"); value.blockers.forEach((item) => console.log(`  - ${item}`)); }
  } else if (kind === "ask") {
    row("STATE", value.ok ? "COMPLETE" : "FAILED");
    row("MODEL", value.model || "-"); row("LANE", value.lane || "-"); row("HOST", value.host || "-"); row("LATENCY", `${value.latencyMs}ms`);
    console.log("\nOUTPUT\n" + (value.content || JSON.stringify(value.error, null, 2)));
  } else if (kind === "fabric") {
    row("STATE", value.status || "-"); row("MODE", value.mode || "-");
    row("INFERENCE", value.selections?.inference ? `${value.selections.inference.nodeId} ${value.selections.inference.url}` : "none");
    row("RAIL", value.selections?.rail ? `${value.selections.rail.nodeId} ${value.selections.rail.url}` : "none");
    row("EYES", value.selections?.eyes ? `${value.selections.eyes.nodeId} ${value.selections.eyes.url}` : "none");
    if (value.operatorDecisionRequired) console.log(`\nACTION\n  ${value.decisionReason}`);
  } else if (kind === "project") {
    row("STATE", value.active ? "LOCKED" : (value.status || "NOT MOUNTED"));
    if (value.project) { row("PROJECT", value.project.name); row("ROOT", value.project.root); row("LOCK", value.sha256); }
    if (value.goal) row("GOAL", value.goal);
  } else {
    row("STATE", value.ok ? "COMPLETE" : "ATTENTION");
    row("EXIT", String(value.exitCode ?? 0));
    console.log("\nREPORT\n" + JSON.stringify(value.result ?? value, null, 2));
  }
}
function row(label, value) { console.log(`${label.padEnd(10)} ${value}`); }
function flag(ok) { return ok ? "ONLINE" : "OFFLINE"; }
function usage(code = 0) {
  console.log("orange status [--json]");
  console.log("orange ask \"message\" [--model orange-auto] [--json]");
  console.log("orange route ACTION|JSON [--json]");
  console.log("orange order ACTION|JSON [--no-learn] [--json]");
  console.log("orange delegate ACTION|JSON [--intent TEXT] [--max-agents N] [--plan-only] [--json]");
  console.log("orange receipts [COUNT] [--json]");
  console.log("orange fabric [discover|status] [--json]");
  console.log("orange fabric add NAME HOST [--trust] [--priority N]");
  console.log("orange project activate PATH [--goal TEXT] [--name NAME]");
  console.log("orange project status|refresh|clear [--json]");
  process.exit(code);
}

async function fabricCommand() {
  const subcommand = args[1] || "discover";
  if (subcommand === "add") {
    const name = args[2]; const host = args[3];
    if (!name || !host) usage(2);
    const node = configureComputeNode({ id: name, name, host, trusted: args.includes("--trust"), priority: Number(valueAfter("--priority")) || 0 });
    return { status: "CONFIGURED", node, ...(await discoverComputeFabric({ timeoutMs: 900 })) };
  }
  if (subcommand !== "discover" && subcommand !== "status") usage(2);
  return await discoverComputeFabric({ timeoutMs: 900 });
}

function projectCommand() {
  const subcommand = args[1] || "status";
  if (subcommand === "activate") {
    const root = args[2];
    if (!root) usage(2);
    return activateProject({ root, goal: valueAfter("--goal"), name: valueAfter("--name") });
  }
  if (subcommand === "refresh") return readProjectLock({ refresh: true });
  if (subcommand === "clear") return clearProjectLock();
  if (subcommand === "status") return readProjectLock();
  usage(2);
}
