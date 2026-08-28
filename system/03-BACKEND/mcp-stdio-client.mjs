import { spawn } from "node:child_process";

export class StdioMcpClient {
  constructor({ command, args = [], cwd = process.cwd(), env = {}, timeoutMs = 120_000, spawnFn = spawn }) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.spawnFn = spawnFn;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.protocolError = null;
  }

  async start() {
    this.child = this.spawnFn(this.command, this.args, {
      cwd: this.cwd, env: { ...process.env, ...this.env }, windowsHide: true,
      shell: false, stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    this.child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); }
        catch {
          const preview = line.length > 240 ? `${line.slice(0, 240)}...` : line;
          const error = new Error(`Malformed MCP stdio output: ${preview}`);
          this.protocolError = error;
          this.#rejectAll(error);
          this.child.kill();
          return;
        }
        if (message.id != null && this.pending.has(message.id)) {
          const pending = this.pending.get(message.id);
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) pending.reject(new Error(`MCP ${message.error.code}: ${message.error.message}`));
          else pending.resolve(message.result);
        }
      }
    });
    this.child.stderr.on("data", (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-32_768); });
    this.child.on("error", (error) => this.#rejectAll(error));
    this.child.on("close", (code) => this.#rejectAll(new Error(`MCP server exited ${code}: ${this.stderr.slice(-1000)}`)));
    const initialized = await this.request("initialize", {
      protocolVersion: "2025-06-18", capabilities: {},
      clientInfo: { name: "orangefive-brain", version: "1.0.0" },
    });
    this.notify("notifications/initialized", {});
    return initialized;
  }

  request(method, params = {}) {
    if (this.protocolError) return Promise.reject(this.protocolError);
    if (!this.child?.stdin?.writable) return Promise.reject(new Error("MCP process is not writable"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async listTools() { return this.request("tools/list", {}); }
  async callTool(name, args = {}) { return this.request("tools/call", { name, arguments: args }); }

  async close() {
    if (!this.child) return;
    try { this.child.stdin.end(); } catch {}
    await Promise.race([
      new Promise((resolve) => this.child.once("close", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (this.child.exitCode == null) this.child.kill();
  }

  #rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
