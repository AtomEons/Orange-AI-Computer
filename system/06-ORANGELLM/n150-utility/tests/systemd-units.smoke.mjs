#!/usr/bin/env node
// n150-utility/tests/systemd-units.smoke.mjs
// ----------------------------------------------------------------------------
// Smoke test for the 4 N150 utility systemd units. No daemon required; this
// only parses the unit files and verifies the doctrine invariants:
//
//   - All 4 units present at the expected path.
//   - MemoryMax matches the Wave-1 envelope (classifier 1G, embedder 2G,
//     fallback 4G, monitor 256M).
//   - Loopback-only ingress (IPAddressDeny=any + IPAddressAllow 127/::1).
//     fallback-chat is allowed to ALSO permit 10.0.99.0/24 for the Codexa
//     probe; nothing else.
//   - Hardening minimums (NoNewPrivileges, ProtectSystem=strict, etc).
//   - Ports match the daemon source of truth (7480 / 8798 / 7481 / 7482).
//   - SyslogIdentifier present.
//   - WantedBy=multi-user.target present.
//   - ExecStart points at the right runtime (node for 3 of 4, bun for fallback).
//
// Exit code 0 = all green; nonzero = at least one invariant failed. Each
// failure prints { unit, check, expected, got } so the operator can fix one
// thing at a time. Mom's Law: receipts only, no silent pass.
// ----------------------------------------------------------------------------

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SYSTEMD_DIR = resolve(__dirname, "..", "systemd");

// -- Unit specifications -----------------------------------------------------

const UNITS = [
  {
    file: "n150-classifier.service",
    memoryMax: "1G",
    port: "7480",
    portEnv: "N150_CLASSIFIER_PORT",
    syslogId: "n150-classifier",
    runtime: "/usr/bin/node",
    daemonPath: "/opt/atomeons/orange5/n150-utility/classifier/daemon.mjs",
    extraIpAllow: [],
    requireMDWX: true, // MemoryDenyWriteExecute
  },
  {
    file: "n150-embedder.service",
    memoryMax: "2G",
    port: "8798",
    portEnv: "N150_EMBEDDER_PORT",
    syslogId: "n150-embedder",
    runtime: "/usr/bin/node",
    daemonPath: "/opt/atomeons/orange5/n150-utility/embedder/server.mjs",
    extraIpAllow: [],
    requireMDWX: true,
  },
  {
    file: "n150-fallback-chat.service",
    memoryMax: "4G",
    port: "7481",
    portEnv: "N150_FALLBACK_PORT",
    syslogId: "n150-fallback-chat",
    runtime: "/usr/local/bin/bun",
    daemonPath: "/opt/atomeons/orange5/n150-utility/fallback-chat/server.mjs",
    // Codexa rail probe — single /24 only, anchored at the doctrine address.
    extraIpAllow: ["10.0.99.0/24"],
    requireMDWX: false, // Bun JIT needs W+X mappings
  },
  {
    file: "n150-health-monitor.service",
    memoryMax: "256M",
    port: "7482",
    portEnv: "N150_HEALTH_PORT",
    syslogId: "n150-health-monitor",
    runtime: "/usr/bin/node",
    daemonPath: "/opt/atomeons/orange5/n150-utility/health-monitor.mjs",
    extraIpAllow: [],
    requireMDWX: true,
  },
];

// -- Minimal INI-ish reader --------------------------------------------------

/**
 * Parse a systemd unit file. Returns { sections: Map<section, Map<key, string[]>> }.
 * Lines starting with `#` are comments. Keys may repeat (e.g. Environment=);
 * we store them as arrays. Whitespace around `=` is preserved as systemd does.
 */
function parseUnit(text) {
  const sections = new Map();
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      current = line.slice(1, -1);
      if (!sections.has(current)) sections.set(current, new Map());
      continue;
    }
    if (current == null) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1); // keep trailing semantics
    const bucket = sections.get(current);
    if (!bucket.has(key)) bucket.set(key, []);
    bucket.get(key).push(value);
  }
  return sections;
}

// -- Assertions --------------------------------------------------------------

const failures = [];
function fail(unit, check, expected, got) {
  failures.push({ unit, check, expected, got });
}

function getOne(sections, section, key) {
  const sec = sections.get(section);
  if (!sec) return undefined;
  const arr = sec.get(key);
  return arr ? arr[arr.length - 1] : undefined; // systemd: last wins
}
function getAll(sections, section, key) {
  const sec = sections.get(section);
  if (!sec) return [];
  return sec.get(key) || [];
}

function checkUnit(spec) {
  const path = resolve(SYSTEMD_DIR, spec.file);
  if (!existsSync(path)) {
    fail(spec.file, "exists", true, false);
    return;
  }
  const text = readFileSync(path, "utf8");
  const s = parseUnit(text);

  // [Unit] presence
  if (!s.has("Unit")) fail(spec.file, "section[Unit]", true, false);
  if (!s.has("Service")) fail(spec.file, "section[Service]", true, false);
  if (!s.has("Install")) fail(spec.file, "section[Install]", true, false);

  // ExecStart points at the right runtime AND daemon path.
  const execStart = getOne(s, "Service", "ExecStart") || "";
  if (!execStart.startsWith(spec.runtime)) {
    fail(spec.file, "ExecStart runtime", spec.runtime, execStart);
  }
  if (!execStart.includes(spec.daemonPath)) {
    fail(spec.file, "ExecStart daemon path", spec.daemonPath, execStart);
  }

  // MemoryMax envelope.
  const memMax = getOne(s, "Service", "MemoryMax");
  if (memMax !== spec.memoryMax) {
    fail(spec.file, "MemoryMax", spec.memoryMax, memMax);
  }

  // Port environment binding.
  const envs = getAll(s, "Service", "Environment");
  const portLine = envs.find((e) => e.startsWith(`${spec.portEnv}=`));
  if (!portLine || portLine.split("=")[1] !== spec.port) {
    fail(spec.file, `${spec.portEnv}`, spec.port, portLine);
  }

  // Loopback-only ingress: IPAddressDeny=any + IPAddressAllow includes 127/8 + ::1.
  const ipDeny = getAll(s, "Service", "IPAddressDeny");
  if (!ipDeny.includes("any")) {
    fail(spec.file, "IPAddressDeny=any", true, ipDeny);
  }
  const ipAllow = getAll(s, "Service", "IPAddressAllow");
  const expectedAllow = new Set([
    "127.0.0.1/32",
    "::1/128",
    ...spec.extraIpAllow,
  ]);
  const gotAllow = new Set(ipAllow.map((v) => v.trim()));
  for (const must of expectedAllow) {
    if (!gotAllow.has(must)) {
      fail(spec.file, "IPAddressAllow missing", must, [...gotAllow]);
    }
  }
  // No EXTRA allows beyond the expected set (loopback discipline).
  for (const got of gotAllow) {
    if (!expectedAllow.has(got)) {
      fail(spec.file, "IPAddressAllow unexpected", [...expectedAllow], got);
    }
  }

  // Hardening minimums.
  const hard = [
    ["NoNewPrivileges", "yes"],
    ["ProtectSystem", "strict"],
    ["ProtectHome", "yes"],
    ["PrivateTmp", "yes"],
    ["PrivateDevices", "yes"],
    ["ProtectKernelTunables", "yes"],
    ["ProtectKernelModules", "yes"],
    ["ProtectControlGroups", "yes"],
    ["RestrictNamespaces", "yes"],
    ["LockPersonality", "yes"],
    ["RestrictRealtime", "yes"],
    ["SystemCallArchitectures", "native"],
  ];
  for (const [k, v] of hard) {
    const got = getOne(s, "Service", k);
    if (got !== v) fail(spec.file, k, v, got);
  }
  if (spec.requireMDWX) {
    const got = getOne(s, "Service", "MemoryDenyWriteExecute");
    if (got !== "yes") fail(spec.file, "MemoryDenyWriteExecute", "yes", got);
  }

  // SystemCallFilter must include @system-service + deny @privileged/@resources.
  const scf = getAll(s, "Service", "SystemCallFilter");
  if (!scf.some((v) => v.includes("@system-service"))) {
    fail(spec.file, "SystemCallFilter @system-service", true, scf);
  }
  if (!scf.some((v) => v.includes("~@privileged"))) {
    fail(spec.file, "SystemCallFilter ~@privileged", true, scf);
  }

  // SyslogIdentifier.
  const sid = getOne(s, "Service", "SyslogIdentifier");
  if (sid !== spec.syslogId) {
    fail(spec.file, "SyslogIdentifier", spec.syslogId, sid);
  }

  // WantedBy=multi-user.target.
  const wantedBy = getOne(s, "Install", "WantedBy");
  if (wantedBy !== "multi-user.target") {
    fail(spec.file, "Install WantedBy", "multi-user.target", wantedBy);
  }

  // Restart policy.
  const restart = getOne(s, "Service", "Restart");
  if (restart !== "on-failure") {
    fail(spec.file, "Restart", "on-failure", restart);
  }

  // ReadWritePaths under the n150-utility tree (receipts carve-out).
  const rwp = getAll(s, "Service", "ReadWritePaths").join(" ");
  if (!rwp.includes("/opt/atomeons/orange5/n150-utility/")) {
    fail(spec.file, "ReadWritePaths", "n150-utility subtree", rwp);
  }
}

// -- Run ---------------------------------------------------------------------

for (const spec of UNITS) checkUnit(spec);

if (failures.length === 0) {
  // Receipts-only success line; tests/CI can grep for "smoke=ok".
  const summary = {
    smoke: "ok",
    suite: "n150-utility-systemd",
    units: UNITS.map((u) => u.file),
    checked_at: new Date().toISOString(),
  };
  process.stdout.write(JSON.stringify(summary) + "\n");
  process.exit(0);
}

const report = {
  smoke: "fail",
  suite: "n150-utility-systemd",
  failures,
  checked_at: new Date().toISOString(),
};
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
process.exit(1);
