#!/usr/bin/env bun
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const action = process.argv[2] || "status";
const home = os.homedir();
const stateRoot = process.env.ORANGE5_DATA_ROOT || path.join(home, "OrangeBox-Data", "orange5");
const pidFile = path.join(stateRoot, "codexa-orange-tunnel.pid");
const key = process.env.ORANGE5_CODEXA_SSH_KEY || path.join(home, ".ssh", "orange_codexa_automation_ed25519");
const host = process.env.ORANGE5_CODEXA_HOST || "CODEXA";
const user = process.env.ORANGE5_CODEXA_USER || "Atom";
const expectedMarkers = [
  "-R 11337:127.0.0.1:1337", "-R 17431:127.0.0.1:7431",
  "-L 11437:127.0.0.1:11434", "-L 18097:127.0.0.1:8097",
  "-L 18643:127.0.0.1:8643",
  `${user}@${host}`,
];

if (!["start", "stop", "restart", "status"].includes(action)) fail("usage: start|stop|restart|status");
let pid = readPid();
let stalePid = null;
if (pid) {
  const owner = inspectProcess(pid);
  if (!isExactTunnelProcess(owner, { key, expectedMarkers })) {
    // PIDs are reusable. A stale pid file must never grant authority over the
    // unrelated process that inherited the number, but it must not prevent
    // the governed tunnel from recovering either.
    stalePid = pid;
    fs.rmSync(pidFile, { force: true });
    pid = null;
  }
}
if ((action === "stop" || action === "restart") && pid) {
  const result = Bun.spawnSync(["taskkill.exe", "/PID", String(pid), "/T", "/F"], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  if (result.exitCode !== 0 && !result.stderr.toString().includes("not found")) fail(result.stderr.toString().trim());
  fs.rmSync(pidFile, { force: true });
  pid = null;
}

if (action === "start" || action === "restart") {
  if (pid) {
    process.stdout.write(`${JSON.stringify({ schema: "orange5.codexa-tunnel-service.v1", action, ok: true, pid, pidFile, host, alreadyRunning: true })}\n`);
    process.exit(0);
  }
  if (!fs.existsSync(key)) fail(`SSH key missing: ${key}`);
  fs.mkdirSync(stateRoot, { recursive: true });
  const args = [
    "-N", "-T", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=20", "-o", "ServerAliveCountMax=3",
    "-o", "ConnectTimeout=8", "-i", key,
    "-R", "11337:127.0.0.1:1337", "-R", "17431:127.0.0.1:7431",
    "-L", "11437:127.0.0.1:11434",
    "-L", "11436:127.0.0.1:8642",
    "-L", "18643:127.0.0.1:8643",
    "-L", "18097:127.0.0.1:8097",
    "-L", "7440:127.0.0.1:7440",
    "-L", "6333:127.0.0.1:6333",
    `${user}@${host}`,
  ];
  const child = Bun.spawn(["ssh.exe", ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true, detached: true });
  fs.writeFileSync(pidFile, `${child.pid}\n`, { mode: 0o600 });
  child.unref();
  pid = child.pid;
  await Bun.sleep(1_000);
}

process.stdout.write(`${JSON.stringify({ schema: "orange5.codexa-tunnel-service.v1", action, ok: Boolean(pid), pid, stalePid, pidFile, host, reversePorts: [11337, 17431], localPorts: [6333, 7440, 11436, 11437, 18097, 18643] })}\n`);

function readPid() {
  try { const n = Number(fs.readFileSync(pidFile, "utf8").trim()); return Number.isInteger(n) && n > 0 ? n : null; }
  catch { return null; }
}
export function isExactTunnelProcess(candidate, { key: expectedKey = key, expectedMarkers: markers = expectedMarkers } = {}) {
  if (!candidate || !Number.isInteger(Number(candidate.ProcessId))) return false;
  const executable = String(candidate.ExecutablePath || "").replace(/\\/g, "/").toLowerCase();
  const command = String(candidate.CommandLine || "").replace(/\\/g, "/");
  if (!executable.endsWith("/ssh.exe")) return false;
  if (!command.toLowerCase().includes(String(expectedKey).replace(/\\/g, "/").toLowerCase())) return false;
  return markers.every((marker) => command.includes(marker));
}
function inspectProcess(processId) {
  const script = `$p = Get-CimInstance Win32_Process -Filter \"ProcessId = ${Number(processId)}\" | Select-Object ProcessId,ExecutablePath,CommandLine; ConvertTo-Json -Compress -InputObject $p`;
  const result = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], {
    stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  if (result.exitCode !== 0) fail(`process ownership query failed: ${result.stderr.toString().trim()}`);
  const raw = result.stdout.toString().trim();
  return raw ? JSON.parse(raw) : null;
}
function fail(error) { process.stderr.write(`${JSON.stringify({ schema: "orange5.codexa-tunnel-service.v1", ok: false, error })}\n`); process.exit(1); }
