import { describe, expect, test } from "bun:test";
import { StdioMcpClient } from "../mcp-stdio-client.mjs";

describe("stdio MCP client", () => {
  test("initializes, lists tools, calls a tool, and closes", async () => {
    const script = `
      const rl=require('readline').createInterface({input:process.stdin});
      rl.on('line',line=>{const m=JSON.parse(line);if(m.id==null)return;
        const result=m.method==='initialize'?{serverInfo:{name:'fake'}}:m.method==='tools/list'?{tools:[{name:'echo'}]}:{content:[{type:'text',text:m.params.arguments.value}]};
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`;
    const client = new StdioMcpClient({ command: process.execPath, args: ["-e", script], timeoutMs: 5_000 });
    expect((await client.start()).serverInfo.name).toBe("fake");
    expect((await client.listTools()).tools[0].name).toBe("echo");
    expect((await client.callTool("echo", { value: "orange" })).content[0].text).toBe("orange");
    await client.close();
  });

  test("fails immediately when the server emits malformed JSON", async () => {
    const script = `
      const rl=require('readline').createInterface({input:process.stdin});
      rl.once('line',()=>process.stdout.write('not-json\\n'));`;
    const client = new StdioMcpClient({ command: process.execPath, args: ["-e", script], timeoutMs: 5_000 });
    const started = Date.now();
    await expect(client.start()).rejects.toThrow("Malformed MCP stdio output");
    // Process creation on the four-core N150 can exceed one second while the
    // native linker is active. The client must still reject from protocol
    // output, well before its 5 s request timeout.
    expect(Date.now() - started).toBeLessThan(3_000);
    await client.close();
  });
});
