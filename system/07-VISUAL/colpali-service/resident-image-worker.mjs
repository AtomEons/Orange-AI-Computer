import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export class ResidentImageWorker {
  constructor({ command, script, env = process.env, startupTimeoutMs = 180_000, requestTimeoutMs = 180_000 } = {}) {
    if (!command || !script) throw new Error("resident worker requires command and script");
    this.command = command;
    this.script = script;
    this.env = env;
    this.startupTimeoutMs = startupTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.child = null;
    this.state = "stopped";
    this.detail = null;
    this.startedAt = null;
    this.completed = 0;
    this.failures = 0;
    this._buffer = "";
    this._ready = null;
    this._pending = new Map();
    this._tail = Promise.resolve();
  }

  status() {
    return {
      state: this.state,
      detail: this.detail,
      pid: this.child?.pid ?? null,
      started_at: this.startedAt,
      completed: this.completed,
      failures: this.failures,
      pending: this._pending.size,
    };
  }

  async start() {
    if (this.state === "ready" || this.state === "busy") return;
    if (this._ready) return this._ready;
    this.state = "starting";
    this.detail = null;
    this.startedAt = new Date().toISOString();

    this._ready = new Promise((resolve, reject) => {
      const child = spawn(this.command, [this.script], {
        stdio: ["pipe", "pipe", "pipe"],
        env: this.env,
      });
      this.child = child;
      let stderr = "";
      const timer = setTimeout(() => {
        this.detail = `startup timeout after ${this.startupTimeoutMs}ms`;
        this._terminate();
        reject(new Error(this.detail));
      }, this.startupTimeoutMs);

      const failStart = (error) => {
        clearTimeout(timer);
        this.state = "error";
        this.detail = `${error.message}${stderr ? `; ${stderr.slice(-1000)}` : ""}`;
        this._ready = null;
        reject(new Error(this.detail));
      };

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
        if (stderr.length > 16_000) stderr = stderr.slice(-16_000);
      });
      child.stdout.on("data", (chunk) => this._consume(chunk, (message) => {
        if (message.type === "ready") {
          clearTimeout(timer);
          this.state = "ready";
          this.detail = message.backend ?? null;
          resolve();
          return;
        }
        this._resolveMessage(message);
      }));
      child.once("error", failStart);
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        const error = new Error(`resident worker exited code=${code} signal=${signal}`);
        for (const pending of this._pending.values()) pending.reject(error);
        this._pending.clear();
        this.child = null;
        if (this.state === "starting") failStart(error);
        else {
          this.state = "error";
          this.detail = `${error.message}${stderr ? `; ${stderr.slice(-1000)}` : ""}`;
          this._ready = null;
        }
      });
    });
    return this._ready;
  }

  request(bytes) {
    const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const job = this._tail.then(() => this._requestNow(input));
    this._tail = job.catch(() => {});
    return job;
  }

  async _requestNow(bytes) {
    await this.start();
    if (!this.child?.stdin?.writable) throw new Error("resident worker stdin unavailable");
    const id = randomUUID();
    this.state = "busy";
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        this.failures += 1;
        this.detail = `request timeout after ${this.requestTimeoutMs}ms`;
        this._terminate();
        reject(new Error(this.detail));
      }, this.requestTimeoutMs);
      this._pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
    this.child.stdin.write(`${JSON.stringify({ id, bytes: bytes.length })}\n`);
    this.child.stdin.write(bytes);
    return response;
  }

  async stop() {
    if (!this.child) return;
    const child = this.child;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try { child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`); } catch {}
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    if (this.child) this._terminate();
  }

  _consume(chunk, onMessage) {
    this._buffer += chunk.toString("utf8");
    while (true) {
      const newline = this._buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this._buffer.slice(0, newline);
      this._buffer = this._buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try { onMessage(JSON.parse(line)); }
      catch (error) {
        this.state = "error";
        this.detail = `invalid resident worker JSON: ${error.message}`;
        this._terminate();
      }
    }
  }

  _resolveMessage(message) {
    const pending = this._pending.get(message.id);
    if (!pending) return;
    this._pending.delete(message.id);
    this.state = "ready";
    if (message.ok) {
      this.completed += 1;
      pending.resolve(message.result);
    } else {
      this.failures += 1;
      pending.reject(new Error(message.error || "resident worker failed"));
    }
  }

  _terminate() {
    try { this.child?.kill("SIGKILL"); } catch {}
  }
}
