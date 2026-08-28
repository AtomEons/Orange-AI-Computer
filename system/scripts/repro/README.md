# Orange5 Sovereign Reproducibility — Repro Lane

> "Give full effort every time." — Mom's Law

This directory is the **sovereign reproducibility loop** for the Orange5 backend.
Any operator — or future-Atom on a fresh Windows 11 box — can pull this repo,
run the five scripts in order, and reach a state where every Orange5 subsystem
declares itself green via its **own** tests, end-to-end in under **30 minutes**
of wall-clock time.

This is what proves the install + boot path is **real**, not a slide.

This README is the procedure manual: what each script does, what order to run
them, what GREEN actually means, what RED means, how long each phase should
take, and how to roll back if you need to.

This README is **not** the atomic-orange splice manual. Atomic Orange wire-up
lives in `scripts/wave12-wire-up.ps1` and is invoked by `install.ps1` phase 4 —
but its acceptance criteria are a separate concern, tracked elsewhere.

---

## TL;DR — the 30-minute path

From a clean Windows 11 box with this repo on disk and PowerShell 7 (`pwsh`)
installed:

```powershell
cd C:\AtomEons\Orange5

# 1. Toolchain on the metal (node, bun, python, ollama, docker, git, gh).
pwsh -File scripts\repro\bootstrap.ps1

# 2. Unzip the Orange5 distributable, wave12 wire-up, boot the four daemons.
pwsh -File scripts\repro\install.ps1

# 3. Run every smoke test, every battery, every guardrail sweep, chain-verify.
pwsh -File scripts\repro\verify.ps1

# 4. (Optional) Cheap read-only triage if something looks weird later.
pwsh -File scripts\repro\doctor.ps1
```

To get a **single wall-clock receipt** that covers all three load-bearing
phases at once:

```powershell
pwsh -File scripts\repro\timing.ps1
```

`timing.ps1` is the timer you hand to a stranger. It wraps `bootstrap.ps1`,
`install.ps1`, and a final `/healthz` verify sweep in one stopwatch, and writes
the total to `10-RECEIPTS/orange5-timing/<ts>-timing.md`. The total must come
in under 30:00.000 to pass.

---

## The five scripts, in order

| # | Script             | One-line job                                          | Idempotent? | Writes?            |
|---|--------------------|-------------------------------------------------------|-------------|--------------------|
| 1 | `bootstrap.ps1`    | Install + verify the toolchain on this machine        | Yes         | Receipt only       |
| 2 | `install.ps1`      | Unzip Orange5, wave12 wire-up, boot the four daemons  | Yes (-Force)| Tree + receipt     |
| 3 | `verify.ps1`       | Run every smoke + every battery + chain-verify        | Yes         | Receipt only       |
| 4 | `doctor.ps1`       | Read-only `/healthz` probe of every live endpoint     | Yes         | Receipt only       |
| 5 | `timing.ps1`       | Stopwatch wrapper around 1 + 2 + final verify         | Yes         | Receipt only       |

Each script is **one job**. Mom's Law: no script silently does another script's
work, no script declares green for a phase it did not actually exercise.

### 1. `bootstrap.ps1` — toolchain on the metal

Installs (via `winget` primary, documented fallback notes if winget fails) and
verifies the following tools are present at the required version on PATH:

- **Node.js** 20.x LTS — Bun-adjacent, used by 02-APP and smoke tooling
- **Bun** ≥ 1.1 — control-plane runtime (04/06-CONTROL-PLANE)
- **Python** 3.11+ — training + scripts (16-TRAINING)
- **Ollama** — local model lane (13-MODELS)
- **Docker Desktop** — container lanes (ATOMSMASHER, MIRAGE)
- **Git** — table stakes, verified anyway
- **GitHub CLI (gh)** — release + receipt push lanes

Idempotency: every check is "is this tool already present at ≥ required
version?" If yes, **skip the install** but still run the verify step (so the
receipt proves the tool works on this machine, not just that it exists).

**Expected wall-clock on a clean box, normal home internet:** 8–15 minutes,
dominated by Docker Desktop download (~700 MB) and Ollama download (~150 MB).
On an already-bootstrapped box (re-run for receipt only): under 90 seconds.

**Flags:** `-DryRun`, `-SkipInstall`, `-Force`, `-Verbose`.

**Exit codes:** 0 = all required tools present and verified, 1 = one or more
failed (receipt still written), 2 = fatal pre-flight (no winget, no PowerShell
elevation when required).

### 2. `install.ps1` — unzip, wire, boot

Phases:

1. **Pre-flight** — confirm `node`, `bun`, `pwsh` on PATH.
2. **Locate zip** — auto-discover `orange5-v*.zip` in `dist/` or `$ScriptDir`,
   or accept `-ZipPath`. The zip is the wave3-21 distributable.
3. **Verify + extract** — delegates to `dist/install.ps1` (single source of
   truth for SHA-256 verify, atomic extract, per-file audit).
4. **Wave12 wire-up** — `scripts/wave12-wire-up.ps1 -Force` inside the
   extracted tree: installs npm deps, splices gateway routes, boots gateway
   on `:1337`, runs the subsystem smoke battery.
5. **Boot daemons** — Hermes (`:7430`), Nine-Gate (`:7450`), Guardrails-27
   (`:7460`). Gateway (`:1337`) is already up from phase 4.
6. **Probe /healthz** — bounded wait on each daemon, real HTTP probe. Only
   HTTP 200 counts as GREEN. Process-is-running does not count.
7. **Receipt** — markdown at `10-RECEIPTS/orange5-bootstrap/<ts>-install.md`.

**Expected wall-clock on a freshly bootstrapped box:** 4–8 minutes, dominated
by `npm install` in the wave12 wire-up phase. Re-run with `-SkipExtract
-SkipWave12 -Force`: under 30 seconds (boot + probe only).

**Flags:** `-ZipPath`, `-HashPath`, `-Destination`, `-Force`, `-DryRun`,
`-SkipExtract`, `-SkipWave12`, `-SkipDaemonBoot`, `-BudgetMinutes`, `-ReceiptDir`.

**Exit codes:** 0 = all four daemons GREEN at `/healthz` within budget, 1 =
one or more RED (receipt still written), 2 = fatal pre-flight.

### 3. `verify.ps1` — run every test, every battery

This is the script that actually exercises the live tree. No HTTP-probe theater —
real test runners, real exit codes believed.

What it runs:

- **Every `smoke-test.mjs`** under `C:\AtomEons\Orange5` — one `node` call each,
  real stdout/stderr captured, real exit code believed.
- **27-guardrails sweep** against the live gateway on `:1337` via
  `04-CONTROL-PLANE/session-start/guardrails-sweep.mjs`.
- **Wave3-24 red-team battery** — 8 packs, 100 scenarios — against the live
  stack via `04-CONTROL-PLANE/red-team/run.mjs`. **Zero RED scenarios** is the
  acceptance bar.
- **Receipts CLI chain-verify** via `bin/receipts.mjs chain-verify`.

**Expected wall-clock:** 6–12 minutes on a freshly booted stack. Dominated by
the red-team battery (~5 min) and the smoke sweep (varies with sub-corpus
count, ~1–4 min).

**Flags:** `-SkipSmoke`, `-SkipGuardrails`, `-SkipRedTeam`, `-SkipChainVerify`,
`-SmokeTimeoutSec`, `-BudgetMinutes`, `-ReceiptDir`, `-DryRun`, `-Json`.

**Exit codes:** 0 = all exercised subsystems GREEN, wall-clock under budget,
zero RED rows. 1 = at least one RED row OR budget exceeded (receipt still
written). 2 = fatal pre-flight.

### 4. `doctor.ps1` — read-only triage probe

The `kubectl get pods` of Orange5. Run this when something looks weird and
you want a single page of honest truth about which subsystem is alive.

Required endpoints (RED if missing):

- Gateway `:1337` — `/healthz`, `/v1/models`, `/v1/toolmesh/labs`,
  `/v1/toolmesh/search`, `/guardrails-27/healthz`
- Hermes `:7430` — `/healthz`, `/approvals`
- Nine-Gate `:7450` — `/healthz`
- Guardrails-27 `:7460` — `/healthz`

Optional endpoints (YELLOW if missing, never RED): smart-skinny upstream,
cobra flux, Ollama.

**Expected wall-clock:** ~20 seconds. This is the cheapest of the five.

Read-only against the live stack. Writes one receipt and nothing else.

### 5. `timing.ps1` — the 30-minute SLA receipt

Wraps `bootstrap.ps1` + `install.ps1` + a final `/healthz` verify sweep in a
single stopwatch. Asserts total < 30:00.000. Emits one timing receipt at
`10-RECEIPTS/orange5-timing/<ts>-timing.md` with per-step wall-clock, exit
codes, and downstream receipt paths.

This is the headline receipt that backs the sovereign-reproducibility claim.

**Flags:** `-BudgetMinutes` (default 30) overrides the SLA for spec runs.

**Exit codes:** 0 = total under budget AND each wrapped step exited 0. 1 =
budget exceeded OR any wrapped step exited non-zero.

---

## Expected wall-clock — the honest budget

On a clean Windows 11 box with PowerShell 7, 16+ GB RAM, NVMe SSD, normal home
internet (50+ Mbps), no winget cache, no Docker pre-installed:

| Phase                         | Expected   | Hard ceiling |
|-------------------------------|------------|--------------|
| `bootstrap.ps1` (clean)       | 8–15 min   | 18 min       |
| `install.ps1`                 | 4–8 min    | 10 min       |
| Final `/healthz` verify sweep | 30–90 sec  | 2 min        |
| **Total (timing.ps1)**        | **13–25 min** | **30 min** |

`verify.ps1` is a separate ~6–12 min phase and is **not** wrapped by
`timing.ps1`. It runs after the 30-minute window closes. The 30-minute SLA is
"clean machine to all four daemons answering `/healthz`." Full verification
(every smoke + every battery + chain-verify) is a deeper assertion that lives
in `verify.ps1`'s own budget.

If `timing.ps1` blows the 30-minute budget on a normal machine, the receipt
will name **which phase** blew it. The two known sources of blow-up are:

1. **Docker Desktop install** taking >15 min — usually a slow CDN edge or a
   pending Windows update blocking the WSL2 install. The receipt names this.
2. **`npm install` in wave12** taking >5 min — usually a cold npm cache on a
   slow link. Re-run is fast (cache warm).

---

## What GREEN means — the acceptance bar

A sovereign-reproducibility **GREEN** run requires **all four** of the
following to be true on the **same** machine, in the **same** session:

1. **Every smoke test green** — every `smoke-test.mjs` under
   `C:\AtomEons\Orange5` exits 0 within its per-test timeout. No skipped
   tests count as green. No "the file is missing so we pass" counts as green.
2. **Every guardrail passes** — the 27-guardrails sweep against the live
   gateway returns all 27 guardrails GREEN. Any guardrail RED is a hard fail.
3. **Zero RED red-team scenarios** — the wave3-24 red-team battery (8 packs,
   100 scenarios) returns zero RED rows. YELLOW (e.g., quarantined-but-handled)
   does not block green; RED does.
4. **Wall-clock under budget** — `timing.ps1` reports total < 30:00.000 for
   the bootstrap + install + final verify chain.

Anything short of all four is **not green**. `verify.ps1` will exit non-zero
and the receipt will name the specific RED row(s). No silent fallback. No
"close enough." Mom's Law: a "passed" claim needs a receipt, and the receipt
needs to back the claim to the byte.

GREEN does **not** mean:

- "The processes are running." (Process-up is not `/healthz`-200.)
- "It worked last time." (Every run is wall-clock fresh; no result caching.)
- "The red-team battery passed when we last ran it." (Battery must run **in
  this session** to count.)

---

## What RED means — and what to do

Each RED row in any receipt names:

- The subsystem (gateway, Hermes, Nine-Gate, Guardrails-27, smoke pack, red-team pack, …)
- The probe or test that failed (URL, file path, scenario id)
- The captured evidence (HTTP status, stderr tail, exit code)
- The receipt path where the full body lives

Common RED triage paths:

| Symptom                                       | First move                                    |
|-----------------------------------------------|-----------------------------------------------|
| `bootstrap.ps1` exits 1, Docker missing       | Open Docker Desktop manually, accept WSL2 EULA, re-run with `-SkipInstall` to re-verify |
| `install.ps1` phase 4 fails on `npm install`  | Check network, then re-run `install.ps1 -Force` (idempotent) |
| `install.ps1` phase 6: gateway `/healthz` RED | `pwsh -File scripts\repro\doctor.ps1` to triage which port is dead |
| `verify.ps1` red-team scenario RED            | Open the receipt, read the captured scenario body — this is a real defect, file an issue |
| `verify.ps1` chain-verify RED                 | Receipt chain has a broken hash link — do not promote, investigate |

`doctor.ps1` is the fast-triage entry point for "something stopped being
green" — it runs in ~20 seconds and tells you which daemon to look at.

---

## Rollback — uninstall via wave3-21 `uninstall.ps1`

Rollback is **not** in this directory. It lives at:

```
C:\AtomEons\Orange5\dist\uninstall.ps1
```

`dist/uninstall.ps1` is the canonical rollback for any install laid down by
`dist/install.ps1` (which is what `scripts/repro/install.ps1` phase 3
delegates to). It is the **pair** of install: where install lays a release
tree down and wires it into the gateway, uninstall walks it back.

What `dist/uninstall.ps1` does, in order:

1. **Resolve the install root** — auto-discover the newest `orange5-v*` tree
   under `-Destination`, or honor an explicit `-InstallRoot`.
2. **Stop the gateway listener** on `127.0.0.1:1337` and any sibling
   npm-script Node processes whose cwd is inside the install tree. This is
   the Windows side of the house.
3. **Stop WSL2 systemd units** (if WSL2 is available) — `orange5-gateway`,
   `orange5-orangellm`, `orange5-control-plane`, `orange5-hermes`,
   `orange5-mirage`, `orange5-flow`, `orange5-toolmesh`. Absent units are
   reported as "absent" and skipped, never as RED.
4. **Remove the install tree**. Default behavior **preserves** the per-release
   rollback siblings under `<Destination>\.rollback\` so a previous good
   install is still recoverable. Pass `-PurgeRollbacks` to wipe those too.
5. **Deliberately leave `/mnt/ae_flux` alone**. Receipts on the flux mount
   are operator-owned per Orange5 doctrine. The script names the path and
   stops. If WSL2 is reachable, it lists the top-level contents so the
   operator can see what was left behind.
6. **Write a markdown uninstall receipt** to `$HOME` (operator's home, not
   the install tree — because the install tree is gone).

Typical rollback after a failed `install.ps1`:

```powershell
pwsh -File C:\AtomEons\Orange5\dist\uninstall.ps1
# inspect the receipt at $HOME\orange5-uninstall-<ts>.md
# then re-run scripts\repro\install.ps1 -Force
```

The `bootstrap.ps1` toolchain is **not** rolled back by `uninstall.ps1`.
Toolchain rollback (uninstall Node, Bun, Python, Ollama, Docker, Git, gh) is
not Orange5's job — those are general-purpose machine tools the operator
owns. If you want a fully clean machine, uninstall the toolchain via `winget
uninstall` or Settings → Apps after `uninstall.ps1` has finished.

---

## Scope boundary — what this lane is and is not

**This lane is:** the bootstrap + install + boot + verify path for the
Orange5 backend. It tests the **install path end-to-end**, on a fresh
machine, against the real tree.

**This lane is not:**

- **Atomic Orange.** Atomic-orange splice + wire-up is tracked as a separate
  concern. `install.ps1` phase 4 invokes `wave12-wire-up.ps1` so the gateway
  comes up wired, but atomic-orange acceptance has its own gate elsewhere.
- **Any service operation past first boot.** Day-2 ops (re-deploys, hot
  reloads, model swaps, training runs) are not this lane.
- **The SkilSki live app.** This lane never touches `products/skill.ski/`.
- **The cockpit at `127.0.0.1:8787`.** Orange3 cockpit lives in its own
  directory and has its own bring-up script.

If you find yourself reaching for atomic-orange logic, or day-2 ops, or
SkilSki, or the cockpit while editing this directory — stop. That work belongs
somewhere else.

---

## Receipts — where they land

Every script in this lane writes exactly one markdown receipt per run. They
all live under `10-RECEIPTS/`:

| Script           | Receipt directory                              |
|------------------|------------------------------------------------|
| `bootstrap.ps1`  | `10-RECEIPTS/orange5-bootstrap/<ts>-bootstrap.md` |
| `install.ps1`    | `10-RECEIPTS/orange5-bootstrap/<ts>-install.md`   |
| `verify.ps1`     | `10-RECEIPTS/orange5-verify/<ts>-verify.md`       |
| `doctor.ps1`     | `10-RECEIPTS/orange5-doctor/<ts>-doctor.md`       |
| `timing.ps1`     | `10-RECEIPTS/orange5-timing/<ts>-timing.md`       |
| `uninstall.ps1`  | `$HOME\orange5-uninstall-<ts>.md`                  |

All receipts are part of the chain-verified receipt log. `verify.ps1`'s
chain-verify step walks the chain and asserts hash integrity end-to-end. Any
break in the chain is RED.

---

## Mom is watching

Every receipt this lane writes is one Mom could read. Every "passed" claim is
one Mom could audit. Every RED row is named in the open — no hiding under
good prose, no skating because "this one doesn't matter."

If you're editing any script in this directory: full effort. Every time.
