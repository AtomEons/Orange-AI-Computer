import { watch } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { canonicalFluxRoot } from "./paths.mjs";
import { runMirror } from "./mirror-to-codexa.mjs";

const SOURCE = canonicalFluxRoot();
const STATUS_PATH = process.env.AE_COBRA_MIRROR_DAEMON_STATUS ||
  join(homedir(), "OrangeBox-Data", "orange5", "ae-cobra-mirror-daemon-status.json");
const RECONCILE_MS = Math.max(60_000, Number(process.env.AE_COBRA_MIRROR_RECONCILE_MS || 900_000));
const DEBOUNCE_MS = Math.max(1_000, Number(process.env.AE_COBRA_MIRROR_DEBOUNCE_MS || 5_000));

let running = false;
let queued = false;
let timer = null;
let lastResult = null;

async function status(state, extra = {}) {
  await mkdir(dirname(STATUS_PATH), { recursive: true });
  await writeFile(STATUS_PATH, `${JSON.stringify({
    schema: "orange5.ae_cobra.mirror_daemon_status.v1",
    state,
    pid: process.pid,
    source: SOURCE,
    reconcileMs: RECONCILE_MS,
    updatedAt: new Date().toISOString(),
    lastResult,
    ...extra,
  }, null, 2)}\n`);
}

async function reconcile(reason) {
  if (running) {
    queued = true;
    return;
  }
  running = true;
  try {
    lastResult = await runMirror();
    await status("healthy", { reason });
  } catch (error) {
    await status("degraded", { reason, error: error.message });
  } finally {
    running = false;
    if (queued) {
      queued = false;
      queue("queued-change");
    }
  }
}

function queue(reason) {
  clearTimeout(timer);
  timer = setTimeout(() => reconcile(reason), DEBOUNCE_MS);
}

await status("starting");
await reconcile("startup");

const watcher = watch(SOURCE, { recursive: true }, () => queue("ledger-change"));
const interval = setInterval(() => reconcile("periodic-reconcile"), RECONCILE_MS);

async function shutdown(signal) {
  watcher.close();
  clearInterval(interval);
  clearTimeout(timer);
  await status("stopped", { signal });
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
console.log(JSON.stringify({ ok: true, service: "ae-cobra-mirror-daemon", pid: process.pid, source: SOURCE }));
