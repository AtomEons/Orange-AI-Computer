import gate, {
  GATE_ID,
  GATE_INDEX,
  MIN_PROTOCOL_VERSION,
  SUPPORTED_TRANSPORTS,
  declaresMcpUse,
} from "../src/loom-gates/07-mcp-default.mjs";

let fails = 0;
function ok(name, cond, detail) {
  if (!cond) { fails++; console.log("FAIL", name, detail ?? ""); }
  else console.log("ok  ", name);
}

ok("gate id", GATE_ID === "mcp_default");
ok("gate index", GATE_INDEX === 7);
ok("min proto", MIN_PROTOCOL_VERSION === "2024-11-05");
ok("transports has stdio", SUPPORTED_TRANSPORTS.includes("stdio"));

// non-mcp action — no-op pass
const r1 = await gate({ id: "a1", kind: "fs.read" });
ok("non-mcp action no-op pass", r1.pass === true && r1.reasons.length === 0);

// mcp action with no evidence
const r2 = await gate({ id: "a2", kind: "mcp.tool", tool: "browser_navigate" });
ok("mcp declared no evidence fails", r2.pass === false && r2.reasons[0] === "evidence_missing");

const happy = {
  id: "a3",
  kind: "mcp.tool",
  tool: "browser_navigate",
  evidence: {
    mcp: {
      server: { transport: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"] },
      handshake: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "playwright-mcp", version: "0.6.1" }
      },
      tool: "browser_navigate",
      tools: [
        { name: "browser_navigate", description: "go", inputSchema: { type: "object", properties: { url: { type: "string" } } } }
      ]
    }
  }
};
const r3 = await gate(happy);
ok("happy path pass", r3.pass === true && r3.tool === "browser_navigate" && r3.card?.name === "browser_navigate", JSON.stringify(r3));

const old = JSON.parse(JSON.stringify(happy));
old.evidence.mcp.handshake.protocolVersion = "2023-01-01";
const r4 = await gate(old);
ok("old protocolVersion fails", r4.pass === false && /protocol_version_bad/.test(r4.reasons[0]));

const empty = JSON.parse(JSON.stringify(happy));
empty.evidence.mcp.tools[0].inputSchema = {};
const r5 = await gate(empty);
ok("empty inputSchema fails", r5.pass === false && /tool_card_invalid/.test(r5.reasons[0]));

const missing = JSON.parse(JSON.stringify(happy));
missing.tool = "browser_click";
missing.evidence.mcp.tool = "browser_click";
const r6 = await gate(missing);
ok("missing tool card fails", r6.pass === false && /tool_card_missing/.test(r6.reasons[0]));

const badtr = JSON.parse(JSON.stringify(happy));
badtr.evidence.mcp.server = { transport: "carrier-pigeon" };
const r7 = await gate(badtr);
ok("unsupported transport fails", r7.pass === false && /transport_unsupported/.test(r7.reasons[0]));

const http = JSON.parse(JSON.stringify(happy));
http.evidence.mcp.server = { transport: "http", url: "http://127.0.0.1:9000" };
const r8 = await gate(http);
ok("http transport happy pass", r8.pass === true);

const ws = JSON.parse(JSON.stringify(happy));
ws.evidence.mcp.server = { transport: "ws", url: "ws://localhost:9001/mcp" };
const r9 = await gate(ws);
ok("ws transport happy pass", r9.pass === true);

const badUrl = JSON.parse(JSON.stringify(happy));
badUrl.evidence.mcp.server = { transport: "http", url: "not a url" };
const r10 = await gate(badUrl);
ok("bad url fails", r10.pass === false && /server_unreachable/.test(r10.reasons[0]));

// declaresMcpUse via evidence only
ok("declaresMcpUse evidence-only", declaresMcpUse({ kind: "random", evidence: { mcp: {} } }) === true);
ok("declaresMcpUse none", declaresMcpUse({ kind: "fs.read" }) === false);

// action invalid
const ri = await gate(null);
ok("null action invalid", ri.pass === false && ri.reasons[0] === "action_invalid");

const ri2 = await gate([]);
ok("array action invalid", ri2.pass === false && ri2.reasons[0] === "action_invalid");

// missing serverInfo.name
const noName = JSON.parse(JSON.stringify(happy));
noName.evidence.mcp.handshake.serverInfo = { version: "1" };
const r11 = await gate(noName);
ok("missing serverInfo.name fails", r11.pass === false && /server_info_missing/.test(r11.reasons[0]));

// toolCard singular form
const single = JSON.parse(JSON.stringify(happy));
delete single.evidence.mcp.tools;
single.evidence.mcp.toolCard = { name: "browser_navigate", inputSchema: { type: "object" } };
const r12 = await gate(single);
ok("singular toolCard happy", r12.pass === true, JSON.stringify(r12));

// stdio without command
const noCmd = JSON.parse(JSON.stringify(happy));
noCmd.evidence.mcp.server = { transport: "stdio" };
const r13 = await gate(noCmd);
ok("stdio without command fails", r13.pass === false && /server_unreachable/.test(r13.reasons[0]));

// capabilities missing
const noCaps = JSON.parse(JSON.stringify(happy));
delete noCaps.evidence.mcp.handshake.capabilities;
const r14 = await gate(noCaps);
ok("capabilities missing fails", r14.pass === false && /capabilities_missing/.test(r14.reasons[0]));

// tool unspecified
const noTool = JSON.parse(JSON.stringify(happy));
delete noTool.tool;
delete noTool.evidence.mcp.tool;
const r15 = await gate(noTool);
ok("tool unspecified fails", r15.pass === false && r15.reasons[0] === "tool_unspecified");

console.log(fails === 0 ? "\nALL GREEN" : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
