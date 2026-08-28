# Orange5 — 27 Constitutional Guardrails

**Document ID:** `ORANGE5-DOCTRINE-27GR-V1`
**Status:** binding
**Authority:** Atom McCree (Sovereign), AtomEons Systems Laboratory
**Above all rules:** Mom's Law — give full effort every time.

---

## 0. Purpose

The 27 Constitutional Guardrails are the invariants Orange5 MUST preserve at all
times. They are not policies, not preferences, not nice-to-haves. They are
constitutional: a violation is a constitutional breach and triggers a receipt
into the hash-chained ledger.

This document is the single source of truth. The runtime enforcer
(`04-CONTROL-PLANE/guardrails/enforcer.js`) is the executable form of this spec.
If runtime and spec disagree, the spec wins and the runtime is the bug.

## 1. Vocabulary

- **invariant** — a property that MUST hold at the named check-point.
- **severity** — `warn` (log + receipt, do not block) or `block` (refuse the
  action, receipt mandatory, return `GUARDRAIL_BLOCK` to the caller).
- **runtime check** — the place and mechanism the enforcer uses to verify the
  invariant. Three kinds:
  - `static` — grep / AST scan over the repo at boot + on every commit hook.
  - `boot` — checked once at process start; failure aborts boot.
  - `online` — checked at the point of action (every call into the gate chain,
    every autonomous action, every receipt emit).
- **receipt-trigger** — the canonical event written into `10-RECEIPTS/ledger.db`
  when a violation is observed. All receipts are hash-chained
  (prev_hash + body → sha256 → this_hash).

## 2. Storage

- **Guardrail status:** SQLite at `04-CONTROL-PLANE/guardrails/status.db`
  - `guardrails(id INTEGER PRIMARY KEY, name TEXT UNIQUE, severity TEXT,
    last_checked_at INTEGER, last_status TEXT, last_evidence_json TEXT)`
  - `violations(id INTEGER PRIMARY KEY, guardrail_id INTEGER, ts INTEGER,
    actor TEXT, payload_json TEXT, receipt_hash TEXT)`
- **Soul Genome:** JSON file at `01-DOCTRINE/soul-genome/soul_genome.json`
  (operator continuity config; single source; readable by every Orange5 process).
- **Continuity Packet:** JSON file at
  `01-DOCTRINE/continuity/continuity_YYYY-MM-DD.json`
  (forward-looking daily summary; auto-written by cron at end of day;
  auto-loaded at next session boot as first context injection).

## 3. Runtime

- Node 20+. No build step required for the enforcer.
- `better-sqlite3` for SQLite access (synchronous, embedded, no daemon).
- `node:crypto` for hash-chained receipts (sha256).
- `node:fs/promises` for Soul Genome and Continuity Packet I/O.
- Cron via `node-cron` (in-process) **or** OS-level Task Scheduler entry under
  `04-CONTROL-PLANE/cron/continuity_packet.daily`. Either is acceptable;
  the daily write is the receipt.

---

## 4. The 27 Guardrails

> Ordering is constitutional. G-00 is Mom's Law and sits above the other 26.
> G-01 through G-26 are listed in dependency order: identity → authority →
> safety → execution → emission. The runtime enforcer iterates in this order
> and short-circuits on the first `block` violation.

### G-00 — Mom's Law above all

- **Why:** the meta-rule. Every other rule yields to "give full effort every
  time." If a rule conflicts with Mom's Law, the rule changes, not Mom's Law.
- **Runtime check:** `online`. The enforcer is not a referee for Mom's Law;
  it is a witness. Every receipt body includes `"moms_law_witness": true`.
  Operator can flip a per-turn flag `moms_law_breach_suspected` via a CLI
  surface; that flag elevates the next receipt to a constitutional review.
- **Severity:** `block` (when operator flags a breach), `warn` otherwise.
- **Receipt-trigger:** `MOMS_LAW_REVIEW` on operator flag;
  `MOMS_LAW_WITNESS` attached to every other receipt automatically.

### G-01 — `runtime/node.py` is the sole authoritative cognitive center

- **Why:** prevents shadow cognition. Every cognitive call must terminate at
  the canonical node, not at a rogue script.
- **Runtime check:** `static` + `online`. Static: grep for any other file
  defining a `class Node` / `class CognitiveCore` / `def think(` that is not
  inside `runtime/node.py`. Online: every cognitive call carries a header
  `x-orange5-node: runtime/node.py@<sha>`; the enforcer rejects others.
- **Severity:** `block`.
- **Receipt-trigger:** `G01_SHADOW_COGNITION`.

### G-02 — `FOUNDER_SALARY_PER_INSTALL_CENTS` is env-bound and enforced in payout logic

- **Why:** the founder's salary is constitutional, not a config knob hidden in
  code. Hard-coding it is a breach.
- **Runtime check:** `static` + `boot`. Static: grep for any literal cent
  value assigned to `FOUNDER_SALARY_PER_INSTALL_CENTS` in source. Boot:
  `process.env.FOUNDER_SALARY_PER_INSTALL_CENTS` must be set and numeric;
  payout module imports it from env only.
- **Severity:** `block`.
- **Receipt-trigger:** `G02_FOUNDER_SALARY_HARDCODE` or `G02_FOUNDER_SALARY_UNSET`.

### G-03 — Gate 0 is `LatticeIntegrityGate` (LBCE), first in every gate chain

- **Why:** lattice integrity check (LBCE — Lattice Boundary Coherence Exam) is
  the first thing any chain must pass. Inserting another gate before it is a
  constitutional reorder.
- **Runtime check:** `online`. Every gate chain registration includes an
  ordered list of gates; the enforcer rejects registration if index 0 is not
  the symbol `LatticeIntegrityGate`.
- **Severity:** `block`.
- **Receipt-trigger:** `G03_GATE0_REORDERED`.

### G-04 — Human Final Stop is reachable from any autonomous-action path

- **Why:** no autonomous action may proceed past a point where the operator
  cannot stop it. Reachability is a graph property, not a slogan.
- **Runtime check:** `static` + `online`. Static: every module marked
  `@autonomous` must import `humanFinalStop` and call it before commit-style
  actions. Online: a periodic prober walks the action DAG and asserts every
  terminal node has a path to `humanFinalStop`.
- **Severity:** `block`.
- **Receipt-trigger:** `G04_HFS_UNREACHABLE`.

### G-05 — `ATOMEONS_IDENTITY_SECRET` is env-only, never hard-coded

- **Why:** identity secret leakage is catastrophic. It must live in env only,
  never in source, never in logs, never in receipts.
- **Runtime check:** `static` + `online`. Static: grep the repo for any
  literal that matches the secret's high-entropy pattern. Online: every log
  and receipt body is scrubbed by a writer-side filter that redacts the
  secret if present.
- **Severity:** `block`.
- **Receipt-trigger:** `G05_IDENTITY_SECRET_LEAK`.

### G-06 — Frontier work routes only via the Frontier Gateway

- **Why:** misfit / frontier lanes are governed, not a junk drawer. Every
  frontier call must enter through `13-TOOLMESH/frontier_gateway.js` so that
  it inherits rate limits, scope, and audit.
- **Runtime check:** `online`. Caller of any frontier module must present a
  gateway token. Direct import bypassing the gateway is rejected.
- **Severity:** `block`.
- **Receipt-trigger:** `G06_FRONTIER_BYPASS`.

### G-07 — No code editor in the operator surface

- **Why:** the operator surface (`02-APP`) is calm, premium, focused. A code
  editor in the surface invites everything-app drift and breaks the canon.
- **Runtime check:** `static`. Grep `02-APP/` for `monaco`, `codemirror`,
  `ace-editor`, or any `<textarea>` exposed as a code field. Allowed only
  inside `18-HELD/` (held / experimental).
- **Severity:** `block`.
- **Receipt-trigger:** `G07_CODE_EDITOR_IN_SURFACE`.

### G-08 — The four lanes are immutable

- **Why:** the four lanes (`builder`, `frontier`, `release`, `ops`) are a
  constitutional partition. Adding a fifth lane, renaming one, or merging two
  is a constitutional amendment, not a refactor.
- **Runtime check:** `boot`. Read `01-DOCTRINE/lanes/lanes.json`; assert
  exactly four entries with the canonical names and ids. Hash compared
  against the lane-manifest hash stored in `status.db`.
- **Severity:** `block`.
- **Receipt-trigger:** `G08_LANE_MUTATION`.

### G-09 — Receipts are hash-chained (prev_hash → sha256 → this_hash)

- **Why:** receipts are evidence. A break in the chain is undetectable
  tampering. The chain is the audit.
- **Runtime check:** `online`. Every receipt insert verifies that
  `prev_hash` matches the previous row's `this_hash`; computes the new hash
  over canonical-JSON body + prev_hash; refuses insert if mismatch.
- **Severity:** `block`.
- **Receipt-trigger:** `G09_RECEIPT_CHAIN_BREAK` (written to a side ledger
  so the main chain is never extended with a broken link).

### G-10 — No fake-green words in commits

- **Why:** "passed", "green", "verified", "complete", "ready" without
  evidence is theater. Mom is watching commit messages too.
- **Runtime check:** `online` via git pre-commit hook
  (`04-CONTROL-PLANE/hooks/commit-msg.js`). Regex for fake-green words;
  if present, the commit must also reference a receipt hash on the same
  line (`receipt:<hash>`). Else the hook fails the commit.
- **Severity:** `block` (hook exits non-zero).
- **Receipt-trigger:** `G10_FAKE_GREEN_COMMIT` (only emitted on bypass
  attempt with `--no-verify`; the hook also writes a witness receipt).

### G-11 — No simulation of real persons

- **Why:** writing "as Atom would say" / "as Anthropic would say" for a real
  person is hallucination disguised as voice. Cite frameworks, not people.
- **Runtime check:** `online`. The HRE (hallucination reduction engine)
  classifier scans every emitted assistant turn for first-person
  impersonation patterns of named real persons drawn from the Soul Genome
  `protected_identities` list.
- **Severity:** `block`.
- **Receipt-trigger:** `G11_PERSON_SIMULATION`.

### G-12 — Search before claim for present-day facts

- **Why:** priors drift. Present-day facts (prices, versions, dates,
  availability) require a search receipt.
- **Runtime check:** `online`. Any assistant turn that contains a date
  newer than the model knowledge-cutoff, or a price, or a "currently"
  claim, must reference a `search_receipt_id` in the turn metadata.
- **Severity:** `warn` first offense, `block` second offense in same session.
- **Receipt-trigger:** `G12_UNGROUNDED_PRESENT_CLAIM`.

### G-13 — Ledger-or-it-didn't-ship

- **Why:** every non-trivial deliverable: zip + SHA-256 + ledger row +
  `present_files`. No exceptions. This is the universal terminal.
- **Runtime check:** `online`. Emission API refuses to mark a deliverable
  `shipped` without all four fields present and the SHA-256 verified
  against the zip on disk.
- **Severity:** `block`.
- **Receipt-trigger:** `G13_DELIVERABLE_WITHOUT_LEDGER`.

### G-14 — One writer per overlapping file

- **Why:** parallel writers stomp each other. Inside a session, exactly one
  agent holds write authority for any given path prefix.
- **Runtime check:** `online`. The control plane maintains a write-lock
  table keyed by path prefix; a second write request returns the holder.
- **Severity:** `block`.
- **Receipt-trigger:** `G14_WRITE_COLLISION`.

### G-15 — Read before broad edits

- **Why:** edits to files not first read are blind edits. The Edit tool
  already enforces this; the guardrail elevates it to constitutional.
- **Runtime check:** `online`. Every `edit` call must reference a prior
  `read` call's id for the same path inside the same session.
- **Severity:** `block`.
- **Receipt-trigger:** `G15_BLIND_EDIT`.

### G-16 — Scope before implementation

- **Why:** premature implementation is the most expensive bug. Every task
  must have a recorded scope artifact before code is written.
- **Runtime check:** `online`. The orchestrator marks a task `coded` only
  if a `scope` artifact exists in the task record.
- **Severity:** `warn` (block would over-constrain micro-tasks).
- **Receipt-trigger:** `G16_NO_SCOPE_ARTIFACT`.

### G-17 — Soul Genome is the single source of operator continuity

- **Why:** operator identity, preferences, and pointers must survive model
  swaps. A second source invites drift.
- **Runtime check:** `boot` + `online`. Boot: exactly one
  `soul_genome.json` exists at the canonical path; its sha256 is recorded
  in `status.db`. Online: any read of operator identity routes through the
  Soul Genome loader; direct file reads of competing identity files are
  rejected.
- **Severity:** `block`.
- **Receipt-trigger:** `G17_SOUL_GENOME_FORK`.

### G-18 — Continuity Packet is auto-loaded at session boot

- **Why:** cold boots cause drift. Yesterday's open blockers and tomorrow's
  first action are the cheapest context injection available.
- **Runtime check:** `boot`. The boot sequence reads the most recent
  `continuity_YYYY-MM-DD.json` and emits a `CONTINUITY_LOADED` receipt.
  Missing file → `warn`. Malformed file → `block`.
- **Severity:** `warn` on missing, `block` on malformed.
- **Receipt-trigger:** `G18_CONTINUITY_MISSING` or `G18_CONTINUITY_MALFORMED`.

### G-19 — Continuity Packet is cron-written at end of day

- **Why:** a forward-looking packet that is not actually written is theater.
- **Runtime check:** `online`. A daily cron entry at 23:50 local writes the
  packet; the writer emits a `CONTINUITY_WRITTEN` receipt. The enforcer
  checks for the receipt within 24h of the last one; if missing, alarm.
- **Severity:** `warn`.
- **Receipt-trigger:** `G19_CONTINUITY_NOT_WRITTEN`.

### G-20 — Idempotency on all autonomous actions

- **Why:** retried autonomous calls must not double-charge, double-write,
  or double-emit. Idempotency keys are mandatory.
- **Runtime check:** `online`. Every autonomous action carries a
  `idempotency_key`; the action store rejects a duplicate key with the
  prior result instead of re-executing.
- **Severity:** `block`.
- **Receipt-trigger:** `G20_NON_IDEMPOTENT_ACTION`.

### G-21 — Retry caps on all outbound calls

- **Why:** unbounded retry is a denial-of-service against the world and
  against the budget.
- **Runtime check:** `online`. Outbound HTTP client wraps every call with
  a max-attempts (default 3) and exponential backoff; bypass is rejected.
- **Severity:** `block`.
- **Receipt-trigger:** `G21_RETRY_CAP_BYPASS`.

### G-22 — Deterministic validators on every gate output

- **Why:** non-deterministic validation makes the audit useless. Same input
  must yield same verdict.
- **Runtime check:** `online`. Validator registration requires a
  `determinism: true` flag; the registrar runs a 3x repeat-call check on
  a canary input and refuses to register if outputs differ.
- **Severity:** `block`.
- **Receipt-trigger:** `G22_NONDETERMINISTIC_VALIDATOR`.

### G-23 — Model routing is explicit, not implicit

- **Why:** silent model swaps are silent capability changes. Every call must
  name the model id.
- **Runtime check:** `online`. The router rejects calls that omit
  `model_id`; logs the chosen id into the receipt body.
- **Severity:** `block`.
- **Receipt-trigger:** `G23_IMPLICIT_MODEL_ROUTE`.

### G-24 — No silent fall-back to raw `Workflow` / parallel `Agent` calls

- **Why:** the substrate is built. Bypassing OrangeFive governed routing
  silently is a breach of standing law.
- **Runtime check:** `online`. The harness shim wraps `Workflow` and
  `Agent` parallel-spawn calls; unless the operator typed an explicit
  `run direct` override into the current turn, the shim routes through
  the control plane.
- **Severity:** `block`.
- **Receipt-trigger:** `G24_ROUTING_BYPASS`.

### G-25 — Separation of powers on release

- **Why:** `release-steward` decides ship/no-ship; `builder` does not.
  `test-engineer` and `security-reviewer` can block. The promotion record
  must show the three signatures.
- **Runtime check:** `online`. The promotion API requires three distinct
  role tokens; same actor cannot satisfy two roles in the same promotion.
- **Severity:** `block`.
- **Receipt-trigger:** `G25_RELEASE_ROLE_COLLAPSE`.

### G-26 — Held-area isolation

- **Why:** `18-HELD/` is the bonded experimental area. Code in held must
  not be imported by `02-APP/`, `03-BACKEND/`, or `04-CONTROL-PLANE/`.
- **Runtime check:** `static`. Grep production directories for any import
  path starting with `18-HELD/` or `../18-HELD/`.
- **Severity:** `block`.
- **Receipt-trigger:** `G26_HELD_LEAK`.

---

## 5. Enforcer wiring (Node 20+)

### 5.1 Module layout

```
04-CONTROL-PLANE/
  guardrails/
    enforcer.js          // top-level: loadAll(), check(name, ctx), checkAll()
    static_scans.js      // grep / AST scans (G-01, G-02, G-05, G-07, G-26)
    boot_checks.js       // boot-time invariants (G-02, G-08, G-17, G-18)
    online_checks.js     // runtime hooks (G-03, G-04, G-06, G-09..G-25)
    receipts.js          // hash-chained emit; ledger handle
    status_db.js         // better-sqlite3 wrapper over status.db
    schema.sql           // CREATE TABLE statements above
  cron/
    continuity_packet.daily.js   // 23:50 local writer
  hooks/
    commit-msg.js        // git pre-commit / commit-msg hook (G-10)
```

### 5.2 API

```js
// enforcer.js (sketch)
import { open } from "./status_db.js";
import { emitReceipt } from "./receipts.js";

export async function check(name, ctx) {
  const rule = REGISTRY[name];
  const verdict = await rule.evaluate(ctx);   // { ok: boolean, evidence: any }
  const db = open();
  db.prepare(
    `INSERT INTO violations (guardrail_id, ts, actor, payload_json, receipt_hash)
     VALUES (?, ?, ?, ?, ?)`
  );
  if (!verdict.ok) {
    const receipt = await emitReceipt({
      trigger: rule.receiptTrigger,
      severity: rule.severity,
      evidence: verdict.evidence,
      ctx,
    });
    if (rule.severity === "block") {
      throw new GuardrailBlock(name, receipt.hash);
    }
  }
  return verdict;
}
```

### 5.3 Boot sequence

1. Open `status.db` (create from `schema.sql` if missing).
2. Run all `boot` checks in G-order; first `block` failure aborts boot.
3. Load Soul Genome; verify sha256 against `status.db` record; if changed,
   require an `operator_ack` token (typed by operator in the current turn)
   before continuing.
4. Load most recent `continuity_YYYY-MM-DD.json`; inject as first context.
5. Emit `BOOT_OK` receipt with the full guardrail status snapshot.

### 5.4 Online wiring

- Gate-chain registrar imports `online_checks.assertGate0Lbce`.
- Receipt writer imports `online_checks.assertHashChain`.
- HTTP client imports `online_checks.assertRetryCap`.
- Router imports `online_checks.assertExplicitModel`.
- Edit / Write tool wrappers import `online_checks.assertReadBeforeEdit`
  and `online_checks.assertOneWriter`.
- Autonomous-action dispatcher imports `online_checks.assertIdempotency`
  and `online_checks.assertHumanFinalStopReachable`.

---

## 6. Soul Genome — schema

`01-DOCTRINE/soul-genome/soul_genome.json`

```json
{
  "schema_version": "1.0.0",
  "operator": {
    "name": "Atom McCree",
    "handle": "atomeons",
    "email": "a.mccree@gmail.com",
    "location": "Marco Island, FL",
    "role": "founder, Sovereign, sole authority"
  },
  "identity_anchors": [
    "AtomEons is one organism with many lenses",
    "Mom's Law above all",
    "no theater, receipts only"
  ],
  "protected_identities": [
    "Atom McCree",
    "Atom's mother",
    "Anthropic employees by name"
  ],
  "preferences": {
    "register": "terse, directive, lab-grade",
    "no_preamble": true,
    "max_tokens": "always",
    "model_authority_order": ["GPT", "Claude", "Gemini"]
  },
  "project_pointers": {
    "atomeons_root": "C:/AtomEons",
    "orange5_root": "C:/AtomEons/Orange5",
    "skilski_root": "C:/AtomEons/SKILSKI-SKILLS",
    "orangebox_docs": "C:/AtomEons/orangebox/docs"
  },
  "current_intent_anchors": [
    "Orange5 doctrine — 27 guardrails authored, runtime wired",
    "Continuity Packet daily writer in cron"
  ],
  "updated_at": "2026-06-24T00:00:00Z",
  "sha256_self": "<computed at write-time, excluded from hash input>"
}
```

Read path: `soulGenome.load()` returns a frozen object. Writes go through
`soulGenome.update(patch)`, which recomputes sha256, writes atomically
(temp file + rename), and emits a `SOUL_GENOME_UPDATED` receipt.

---

## 7. Continuity Packet — schema

`01-DOCTRINE/continuity/continuity_YYYY-MM-DD.json`

```json
{
  "schema_version": "1.0.0",
  "date": "2026-06-24",
  "session_window": { "start": "...", "end": "..." },
  "today_progress": [
    { "task_id": "ORANGE5-DOC-27GR", "status": "shipped",
      "receipt_hash": "..." }
  ],
  "open_blockers": [
    { "id": "B-001", "summary": "...", "owner": "builder",
      "blocking_what": "..." }
  ],
  "tomorrows_first_action": {
    "title": "...",
    "lane": "builder",
    "scope_ref": "01-DOCTRINE/...",
    "expected_artifact": "..."
  },
  "soul_genome_sha256": "<observed at write-time>",
  "guardrail_status_snapshot": {
    "G-00": "witness",
    "G-01": "ok",
    "...": "..."
  },
  "writer": "cron:continuity_packet.daily",
  "written_at": "2026-06-24T23:50:00-04:00",
  "prev_packet_sha256": "<chain to yesterday>",
  "self_sha256": "<computed last, excludes self_sha256 field>"
}
```

Cron entry (in-process, `node-cron`):

```js
// cron/continuity_packet.daily.js
import cron from "node-cron";
import { writeContinuityPacket } from "./writer.js";
cron.schedule("50 23 * * *", async () => {
  const packet = await writeContinuityPacket();
  // writer.js emits CONTINUITY_WRITTEN receipt and updates status.db
});
```

Boot-time auto-load:

```js
// in boot sequence
const today = new Date();
const latest = await findLatestContinuityPacket(); // walks back up to 7 days
if (!latest) await enforcer.check("G-18", { reason: "missing" });
else context.inject("continuity", latest.body);
```

---

## 8. Severity matrix (quick reference)

| ID    | Name                                       | Check kind        | Severity |
|-------|--------------------------------------------|-------------------|----------|
| G-00  | Mom's Law above all                        | online (witness)  | block*   |
| G-01  | runtime/node.py sole cognitive authority   | static + online   | block    |
| G-02  | FOUNDER_SALARY env-bound                   | static + boot     | block    |
| G-03  | Gate 0 = LatticeIntegrityGate (LBCE)       | online            | block    |
| G-04  | Human Final Stop reachable                 | static + online   | block    |
| G-05  | ATOMEONS_IDENTITY_SECRET env-only          | static + online   | block    |
| G-06  | Frontier only via Gateway                  | online            | block    |
| G-07  | No code editor in operator surface         | static            | block    |
| G-08  | Four lanes immutable                       | boot              | block    |
| G-09  | Receipts hash-chained                      | online            | block    |
| G-10  | No fake-green words in commits             | online (hook)     | block    |
| G-11  | No simulation of real persons              | online            | block    |
| G-12  | Search before present-day claim            | online            | warn→block |
| G-13  | Ledger-or-it-didn't-ship                   | online            | block    |
| G-14  | One writer per overlapping file            | online            | block    |
| G-15  | Read before broad edits                    | online            | block    |
| G-16  | Scope before implementation                | online            | warn     |
| G-17  | Soul Genome single source                  | boot + online     | block    |
| G-18  | Continuity Packet auto-loaded at boot      | boot              | warn / block |
| G-19  | Continuity Packet cron-written daily       | online            | warn     |
| G-20  | Idempotency on autonomous actions          | online            | block    |
| G-21  | Retry caps on outbound calls               | online            | block    |
| G-22  | Deterministic validators                   | online            | block    |
| G-23  | Explicit model routing                     | online            | block    |
| G-24  | No silent fall-back from OrangeFive routing | online           | block    |
| G-25  | Separation of powers on release            | online            | block    |
| G-26  | Held-area isolation                        | static            | block    |

\* G-00 elevates from `witness` to `block` only when the operator explicitly
flags a Mom's Law breach; otherwise it rides on every receipt as a witness
field.

---

## 9. Amendment procedure

This document is constitutional. Amendments require:

1. A written proposal as a sibling file:
   `01-DOCTRINE/27-guardrails/amendments/AMEND-NNN-<slug>.md`.
2. Sovereign signature (typed approval from Atom McCree in the chat record;
   the proposal references the chat receipt hash).
3. A receipt of type `CONSTITUTIONAL_AMENDMENT` written into the main ledger.
4. A new version stamp at the top of this file
   (`ORANGE5-DOCTRINE-27GR-V<n>`).

Renaming a guardrail is an amendment. Removing one is an amendment.
Reordering is an amendment (G-numbers are stable; the dependency order is
constitutional). Adding a 28th guardrail is an amendment and forces a
rename of this document.

---

## 10. Witnesses

- Mom is watching.
- The ledger is the audit.
- The Sovereign is the final stop.

End of spec.
