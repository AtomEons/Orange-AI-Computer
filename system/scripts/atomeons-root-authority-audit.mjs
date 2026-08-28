import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = "C:\\AtomEons";
const ORANGE = join(ROOT, "Orange5");
const CLEAN = join(ROOT, "Orange5-clean-proof");
const RECEIPTS = join(ORANGE, "10-RECEIPTS", "orange5-build");
const full = process.argv.includes("--full");

function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: options.timeout ?? 120_000,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

async function probe(name, url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    return { name, url, ok: response.ok, status: response.status };
  } catch (error) {
    return { name, url, ok: false, error: error.message };
  }
}

const localHead = run("git", ["-C", ORANGE, "rev-parse", "HEAD"]);
const cleanHead = run("git", ["-C", CLEAN, "rev-parse", "HEAD"]);
const remote = run("git", ["ls-remote", "https://github.com/AtomEons/Atomic-Orange-Five.git", "refs/heads/main"]);
const remoteHead = remote.stdout.split(/\s+/)[0] ?? "";
const repo = run("gh", ["repo", "view", "AtomEons/Atomic-Orange-Five", "--json", "isPrivate,visibility,defaultBranchRef"]);
let repoInfo = {};
try { repoInfo = JSON.parse(repo.stdout); } catch {}

const task = run("powershell.exe", [
  "-NoProfile", "-NonInteractive", "-Command",
  "$t=Get-ScheduledTask -TaskName 'Orange5 Runtime Hidden' -ErrorAction Stop; [pscustomobject]@{enabled=$t.Settings.Enabled;state=[string]$t.State}|ConvertTo-Json -Compress",
]);
let taskInfo = {};
try { taskInfo = JSON.parse(task.stdout); } catch {}

const startupVbs = join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "Orange5 Runtime Hidden.vbs");
const hkcu = run("powershell.exe", [
  "-NoProfile", "-NonInteractive", "-Command",
  "(Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'OrangeFiveRuntime' -ErrorAction SilentlyContinue).OrangeFiveRuntime",
]);

const endpoints = await Promise.all([
  probe("ollama", "http://127.0.0.1:11434/api/tags"),
  probe("navigator_kernel", "http://127.0.0.1:1337/v1/models"),
  probe("orangebrain", "http://127.0.0.1:1337/healthz"),
  probe("cobra", "http://127.0.0.1:7419/healthz"),
  probe("hermes", "http://127.0.0.1:7430/healthz"),
  probe("ae_eyes", "http://127.0.0.1:7440/health"),
  probe("atomsmasher", "http://127.0.0.1:8901/health"),
]);

const rootIgnore = readFileSync(join(ROOT, ".gitignore"), "utf8");
const deltaShim = readFileSync(join(ROOT, "tools", "bin", "orangebox-delta-backend.ps1"), "utf8");
const strongarmShim = readFileSync(join(ROOT, "tools", "bin", "orangebox-strongarm.ps1"), "utf8");

let verifier = { requested: full, ok: null, green: null, red: null };
if (full) {
  const result = run("bun", ["run", "verify"], { cwd: CLEAN, timeout: 1_200_000 });
  const match = result.stdout.match(/Orange5 full verifier:\s+(\d+) green \/ (\d+) red/);
  verifier = {
    requested: true,
    ok: result.ok && match?.[2] === "0",
    green: match ? Number(match[1]) : null,
    red: match ? Number(match[2]) : null,
    exitCode: result.status,
  };
}

const checks = {
  local_remote_sha_match: localHead.ok && localHead.stdout === remoteHead,
  clean_remote_sha_match: cleanHead.ok && cleanHead.stdout === remoteHead,
  private_repo: repo.ok && repoInfo.isPrivate === true && repoInfo.defaultBranchRef?.name === "main",
  canonical_task_enabled: task.ok && taskInfo.enabled === true,
  duplicate_startup_vbs_absent: !existsSync(startupVbs),
  duplicate_hkcu_run_absent: hkcu.stdout === "",
  root_git_excludes_orange5: rootIgnore.includes("/Orange5/"),
  delta_helper_redirected: deltaShim.includes("OrangeFive runtime") && !deltaShim.includes("orangebox-command-server.mjs"),
  strongarm_helper_retired: strongarmShim.includes("standalone Delta STRONGARM sidecar is retired"),
  endpoints_green: endpoints.every((item) => item.ok),
  clean_clone_verifier: full ? verifier.ok === true : true,
};

const ok = Object.values(checks).every(Boolean);
const generatedAt = new Date().toISOString();
const receipt = {
  schema: "orange.receipt.atomeons_root_authority.v1",
  status: ok ? "VERIFIED" : "NEEDS_ATTENTION",
  generatedAt,
  authority: {
    localRoot: ORANGE,
    github: "https://github.com/AtomEons/Atomic-Orange-Five",
    localHead: localHead.stdout,
    remoteHead,
    cleanCloneHead: cleanHead.stdout,
    private: repoInfo.isPrivate ?? null,
  },
  boot: {
    authority: "Windows scheduled task: Orange5 Runtime Hidden",
    task: taskInfo,
    duplicateStartupVbsPresent: existsSync(startupVbs),
    duplicateHkcuRunPresent: hkcu.stdout !== "",
  },
  endpoints,
  verifier,
  checks,
};

const stable = JSON.stringify(receipt, null, 2);
receipt.receiptHash = createHash("sha256").update(stable).digest("hex");
mkdirSync(RECEIPTS, { recursive: true });
const stamp = generatedAt.replaceAll(":", "-").replace(".", "-");
const path = join(RECEIPTS, `${stamp}-atomeons-root-authority-audit.json`);
writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
writeFileSync(join(RECEIPTS, "atomeons-root-authority-latest.json"), `${JSON.stringify(receipt, null, 2)}\n`);

console.log(JSON.stringify({ status: receipt.status, checks, verifier, receiptPath: path }, null, 2));
process.exit(ok ? 0 : 1);
