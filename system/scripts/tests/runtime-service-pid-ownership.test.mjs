#!/usr/bin/env bun
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isExactServiceProcess,
  operate,
  parseWindowsCommandLine,
  resolveServiceOwnership,
} from "../orange5-runtime-services.mjs";

const root = "C:\\AtomEons\\Orange5";
const bunExecutable = "C:\\Tools\\bun.exe";
const service = {
  name: "memory",
  entry: "06-ORANGELLM/memory/ae-cobra/flow-direct/server.mjs",
  health: "http://127.0.0.1:7419/healthz",
};
const entry = path.win32.join(root, service.entry);
const temporaryRoots = [];

afterEach(() => {
  for (const temporaryRoot of temporaryRoots.splice(0)) fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

function processRecord(pid, executablePath = bunExecutable, script = entry) {
  return { pid, executablePath, commandLine: `"${executablePath}" "${script}"` };
}

function stateWithPid(pid) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "orange5-runtime-owner-"));
  temporaryRoots.push(state);
  fs.writeFileSync(path.join(state, `${service.name}.pid`), `${pid}\n`);
  return state;
}

describe("OrangeFive runtime service PID ownership", () => {
  test("matches only the exact Bun executable and exact service entry argument", () => {
    expect(parseWindowsCommandLine(`"${bunExecutable}" "${entry}"`)).toEqual([bunExecutable, entry]);
    expect(isExactServiceProcess(processRecord(101), service, { root, bunExecutable })).toBe(true);
    expect(isExactServiceProcess(processRecord(102, "C:\\Tools\\bun-copy.exe"), service, { root, bunExecutable })).toBe(false);
    expect(isExactServiceProcess(processRecord(103, bunExecutable, `${entry}.old`), service, { root, bunExecutable })).toBe(false);
  });

  test("keeps an exact PID-file owner even when another matching process exists", () => {
    const ownership = resolveServiceOwnership({
      service,
      pidFilePid: 201,
      processes: [processRecord(201), processRecord(202)],
      root,
      bunExecutable,
    });
    expect(ownership).toMatchObject({ ok: true, pid: 201, source: "pid-file" });
  });

  test.each([
    ["stale", []],
    ["unrelated", [processRecord(301, "C:\\Program Files\\nodejs\\node.exe")]],
  ])("adopts the sole exact process when the PID file is %s", async (_label, priorPidRecords) => {
    const state = stateWithPid(301);
    let terminatedPid = null;
    const report = await operate(service, {
      action: "stop",
      state,
      root,
      bunExecutable,
      inspectProcesses: async () => [...priorPidRecords, processRecord(302)],
      terminateProcess: (pid) => { terminatedPid = pid; return { ok: true }; },
      healthProbe: async () => ({ ok: false, body: {} }),
      waitUntil: async (predicate) => predicate(),
    });
    expect(report.ok).toBe(true);
    expect(terminatedPid).toBe(302);
    expect(fs.existsSync(path.join(state, `${service.name}.pid`))).toBe(false);
  });

  test.each([
    ["zero", []],
    ["multiple", [processRecord(402), processRecord(403)]],
  ])("blocks and terminates nothing when stale ownership has %s exact matches", async (_label, processes) => {
    const state = stateWithPid(401);
    let terminationCalls = 0;
    const report = await operate(service, {
      action: "restart",
      state,
      root,
      bunExecutable,
      inspectProcesses: async () => processes,
      terminateProcess: () => { terminationCalls += 1; return { ok: true }; },
      healthProbe: async () => ({ ok: true, body: {} }),
      waitUntil: async () => true,
    });
    expect(report.ok).toBe(false);
    expect(report.blocker).toContain(`found-${processes.length}`);
    expect(terminationCalls).toBe(0);
    expect(fs.readFileSync(path.join(state, `${service.name}.pid`), "utf8").trim()).toBe("401");
  });

  test("treats an already-stopped service with only a stale PID marker as stopped", async () => {
    const state = stateWithPid(501);
    let terminationCalls = 0;
    const report = await operate(service, {
      action: "stop",
      state,
      root,
      bunExecutable,
      inspectProcesses: async () => [],
      terminateProcess: () => { terminationCalls += 1; return { ok: true }; },
      healthProbe: async () => ({ ok: false, body: {} }),
      waitUntil: async () => true,
    });
    expect(report).toMatchObject({ ok: true, pid: null });
    expect(terminationCalls).toBe(0);
    expect(fs.existsSync(path.join(state, `${service.name}.pid`))).toBe(false);
  });

  test.each(["status", "start"])("%s adopts a sole exact process started by the boot authority", async (action) => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "orange5-runtime-owner-"));
    temporaryRoots.push(state);
    const report = await operate(service, {
      action,
      state,
      root,
      bunExecutable,
      inspectProcesses: async () => [processRecord(601)],
      healthProbe: async () => ({ ok: true, body: { status: "ok" } }),
    });
    expect(report).toMatchObject({ ok: true, pid: 601, observed: { status: "ok" } });
    expect(fs.readFileSync(path.join(state, `${service.name}.pid`), "utf8").trim()).toBe("601");
  });

  test("status refuses a healthy endpoint without an exact process owner", async () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "orange5-runtime-owner-"));
    temporaryRoots.push(state);
    const report = await operate(service, {
      action: "status",
      state,
      root,
      bunExecutable,
      inspectProcesses: async () => [],
      healthProbe: async () => ({ ok: true, body: { status: "ok" } }),
    });
    expect(report.ok).toBe(false);
    expect(report.blocker).toBe("pid-ownership-missing:expected-exactly-one-service-process:found-0");
    expect(fs.existsSync(path.join(state, `${service.name}.pid`))).toBe(false);
  });
});
