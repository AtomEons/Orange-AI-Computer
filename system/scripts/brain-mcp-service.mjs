#!/usr/bin/env bun
import path from "node:path";

// Compatibility command only. The canonical runtime controller performs exact
// executable-and-entry ownership checks before any process can be terminated.
const root = path.resolve(import.meta.dir, "..");
const action = process.argv[2] || "status";
if (!["status", "start", "restart", "stop"].includes(action)) {
  process.stderr.write('{"schema":"orange5.service-control.v1","ok":false,"error":"usage: status|start|restart|stop"}\n');
  process.exit(1);
}
const result = Bun.spawnSync([process.execPath, path.join(root, "scripts", "orange5-runtime-services.mjs"), action, "brain-mcp"], {
  cwd: root, env: process.env, stdout: "pipe", stderr: "pipe", windowsHide: true,
});
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.exitCode);
