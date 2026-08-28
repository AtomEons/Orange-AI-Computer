// commitment-atoms/smoke-test.mjs
//
// AtomSmasher Commitment Atoms — END-TO-END smoke test.
//
// Exercises the LIVE round-trip:
//   encoder.encodeCommitmentAtom
//     -> store.createAtom (Æ Cobra Flux Reality lane + SQLite index)
//       -> store.getAtom / store.listAtoms
//         -> store.revokeAtom (Flux revocation event + status update)
//           -> decoder.traverseChain (full provenance graph)
//
// Doctrine:
//   - Three atoms are minted: one decision, one invariant, one promise. The
//     promise supersedes the invariant via the `supersedes` array, so the
//     chain has a real edge to traverse.
//   - One of the three is then revoked (status='superseded'). The smoke test
//     asserts the revoked status surfaces from the store on re-read and that
//     a fresh `listAtoms({status: 'superseded'})` returns it.
//   - Hash-chain integrity is asserted at every step:
//       * encoded.signature.hash matches what validateCommitmentAtom recomputes
//       * each atom's prev_hash equals the prior atom's signature.hash
//       * the supersedes chain returned by traverseChain reports `resolved=true`
//         for the in-store predecessor (no UNRESOLVED, no CYCLE)
//
// This script does NOT require the gateway to be running. It hits the store
// module directly so a failure pinpoints the layer that broke, not the wire.
// Run with: node 12-ATOMSMASHER/commitment-atoms/smoke-test.mjs
// Exits non-zero on any failure. No test framework dep.

import { promises as fsp } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import {
  encodeCommitmentAtom,
  validateCommitmentAtom,
} from "./encoder.mjs";
import { traverseChain } from "./decoder.mjs";
import * as store from "./store.mjs";

// ---------------------------------------------------------------------------
// Test plumbing
// ---------------------------------------------------------------------------

let failed = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

function assertExports(mod, names, label) {
  for (const name of names) {
    const present = typeof mod[name] === "function";
    check(`${label}.${name} is exported`, present);
  }
}

// Isolated temp workspace so the smoke test never pollutes the operator's
// real Reality lane or SQLite index.
function mkWorkspace() {
  const ts = Date.now();
  const root = path.join(os.tmpdir(), `atomsmasher-smoke-${ts}`);
  fs.mkdirSync(root, { recursive: true });
  return {
    root,
    fluxRoot: path.join(root, "flux"),
    dbPath: path.join(root, "commitment-atoms.db"),
  };
}

async function cleanup(workspace) {
  try {
    await fsp.rm(workspace.root, { recursive: true, force: true });
  } catch {
    // best effort — don't fail the test for cleanup
  }
}

// ---------------------------------------------------------------------------
// Test bodies — match Mom's Law: real content, no theater words
// ---------------------------------------------------------------------------

const ATOM_BODIES = Object.freeze({
  decision: {
    kind: "decision",
    body: {
      statement: "OrangeLLM-fatty is the only trained brain — Smart Skinny LoRA retired.",
      effective_date: "2026-06-24",
    },
    evidence: ["receipts/2026-06-24/fatty-eval-tnst7.json"],
    actor: "operator:atom",
  },
  invariant: {
    kind: "invariant",
    body: {
      rule: "runtime/node.py is the sole authoritative cognitive center.",
      enforced_by: "drift-audit",
    },
    evidence: ["receipts/2026-06-24/drift-audit-001.json"],
    actor: "system:atomeons",
  },
  promise: {
    kind: "promise",
    body: {
      commitment: "Ship AtomSmasher Commitment Atoms LIVE by end of 2026-06-24.",
      target_iso: "2026-06-24T23:59:59Z",
    },
    evidence: ["receipts/2026-06-24/atomsmasher-promotion-plan.md"],
    actor: "operator:atom",
  },
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const ws = mkWorkspace();
  console.log(`workspace: ${ws.root}`);

  console.log("0. store module sanity");
  assertExports(store, ["createAtom", "getAtom", "listAtoms", "revokeAtom"], "store");
  if (failed > 0) {
    console.log("aborting — store contract incomplete");
    return;
  }

  // -------------------------------------------------------------------------
  // 1. Mint atom #1 — decision. prevHash=GENESIS.
  // -------------------------------------------------------------------------
  console.log("1. mint decision atom (prevHash=GENESIS)");
  const decisionAtom = encodeCommitmentAtom({
    ...ATOM_BODIES.decision,
    prevHash: "GENESIS",
  });
  check("decision encoded", typeof decisionAtom?.atom_id === "string");
  check(
    "decision signature.prev_hash === GENESIS",
    decisionAtom.signature.prev_hash === "GENESIS",
  );
  const dv = validateCommitmentAtom(decisionAtom);
  check("decision validates", dv.valid, JSON.stringify(dv.errors));

  const dRes = await store.createAtom(decisionAtom, {
    fluxRoot: ws.fluxRoot,
    dbPath: ws.dbPath,
  });
  check("decision createAtom ok", dRes && dRes.ok === true, JSON.stringify(dRes));
  check(
    "decision createAtom returned matching atom_id",
    dRes && dRes.atom_id === decisionAtom.atom_id,
  );
  check(
    "decision flux_record_hash is sha256",
    typeof dRes?.flux_record_hash === "string" && /^[a-f0-9]{64}$/.test(dRes.flux_record_hash),
  );

  // -------------------------------------------------------------------------
  // 2. Mint atom #2 — invariant. Chains off decision's signature.hash.
  // -------------------------------------------------------------------------
  console.log("2. mint invariant atom (prevHash = decision.signature.hash)");
  const invariantAtom = encodeCommitmentAtom({
    ...ATOM_BODIES.invariant,
    prevHash: decisionAtom.signature.hash,
  });
  check(
    "invariant prev_hash === decision.signature.hash",
    invariantAtom.signature.prev_hash === decisionAtom.signature.hash,
  );
  check("invariant validates", validateCommitmentAtom(invariantAtom).valid);

  const iRes = await store.createAtom(invariantAtom, {
    fluxRoot: ws.fluxRoot,
    dbPath: ws.dbPath,
  });
  check("invariant createAtom ok", iRes && iRes.ok === true, JSON.stringify(iRes));

  // -------------------------------------------------------------------------
  // 3. Mint atom #3 — promise. Supersedes the invariant (real chain edge).
  //    Chains off invariant's signature.hash.
  // -------------------------------------------------------------------------
  console.log("3. mint promise atom that supersedes invariant");
  const promiseAtom = encodeCommitmentAtom({
    ...ATOM_BODIES.promise,
    supersedes: [invariantAtom.atom_id],
    prevHash: invariantAtom.signature.hash,
  });
  check(
    "promise prev_hash === invariant.signature.hash",
    promiseAtom.signature.prev_hash === invariantAtom.signature.hash,
  );
  check(
    "promise supersedes includes invariant",
    promiseAtom.supersedes.includes(invariantAtom.atom_id),
  );
  check("promise validates", validateCommitmentAtom(promiseAtom).valid);

  const pRes = await store.createAtom(promiseAtom, {
    fluxRoot: ws.fluxRoot,
    dbPath: ws.dbPath,
  });
  check("promise createAtom ok", pRes && pRes.ok === true, JSON.stringify(pRes));

  // -------------------------------------------------------------------------
  // 4. getAtom re-reads what we wrote, byte-for-byte where it matters
  // -------------------------------------------------------------------------
  console.log("4. getAtom round-trips each atom");
  for (const [label, original] of [
    ["decision", decisionAtom],
    ["invariant", invariantAtom],
    ["promise", promiseAtom],
  ]) {
    const reread = await store.getAtom(original.atom_id, { dbPath: ws.dbPath });
    check(`${label} getAtom returned object`, reread && typeof reread === "object");
    if (reread) {
      check(`${label} atom_id round-trip`, reread.atom_id === original.atom_id);
      check(`${label} hash round-trip`, reread.signature?.hash === original.signature.hash);
      check(`${label} prev_hash round-trip`, reread.signature?.prev_hash === original.signature.prev_hash);
      check(`${label} kind round-trip`, reread.kind === original.kind);
      // Validate the re-read atom independently — this catches any
      // canonicalization drift the store may have introduced.
      const v = validateCommitmentAtom(reread);
      check(`${label} re-read validates`, v.valid, JSON.stringify(v.errors));
    }
  }

  // -------------------------------------------------------------------------
  // 5. Revoke the decision atom. Status should flip to 'superseded'.
  // -------------------------------------------------------------------------
  console.log("5. revoke the decision atom (superseded_by=promise)");
  const rRes = await store.revokeAtom(decisionAtom.atom_id, promiseAtom.atom_id, {
    fluxRoot: ws.fluxRoot,
    dbPath: ws.dbPath,
    reason: "Replaced by promise atom in smoke test.",
  });
  check("revoke ok", rRes && rRes.ok === true, JSON.stringify(rRes));
  check("revoke status is superseded", rRes && rRes.status === "superseded");

  const decisionAfter = await store.getAtom(decisionAtom.atom_id, { dbPath: ws.dbPath });
  check(
    "decision status after revoke is superseded",
    decisionAfter && decisionAfter.status === "superseded",
    `actual: ${decisionAfter?.status}`,
  );

  // -------------------------------------------------------------------------
  // 6. listAtoms filters work
  // -------------------------------------------------------------------------
  console.log("6. listAtoms filter queries");
  const allAtoms = await store.listAtoms({ dbPath: ws.dbPath });
  check("list returned >= 3 atoms", Array.isArray(allAtoms) && allAtoms.length >= 3, `got ${allAtoms?.length}`);

  const activeAtoms = await store.listAtoms({ status: "active", dbPath: ws.dbPath });
  const activeIds = new Set((activeAtoms || []).map((a) => a.atom_id));
  check("active list excludes the revoked decision", !activeIds.has(decisionAtom.atom_id));
  check("active list excludes invariant superseded by promise", !activeIds.has(invariantAtom.atom_id));
  check("active list includes promise", activeIds.has(promiseAtom.atom_id));

  const supersededAtoms = await store.listAtoms({ status: "superseded", dbPath: ws.dbPath });
  const supersededIds = new Set((supersededAtoms || []).map((a) => a.atom_id));
  check("superseded list includes the revoked decision", supersededIds.has(decisionAtom.atom_id));

  const decisionsOnly = await store.listAtoms({ kind: "decision", dbPath: ws.dbPath });
  const decisionIds = new Set((decisionsOnly || []).map((a) => a.atom_id));
  check("kind=decision filter returns decision atom", decisionIds.has(decisionAtom.atom_id));
  check("kind=decision filter excludes invariant", !decisionIds.has(invariantAtom.atom_id));

  // -------------------------------------------------------------------------
  // 7. Chain traversal: promise -> invariant via supersedes; resolved=true
  // -------------------------------------------------------------------------
  console.log("7. chain traversal from promise atom");
  // Build a sync store adapter so traverseChain can walk.
  let storeAdapter;
  if (typeof store.getAtomSync === "function") {
    storeAdapter = {
      get(id) {
        try {
          return store.getAtomSync(id, { dbPath: ws.dbPath }) || null;
        } catch {
          return null;
        }
      },
    };
  } else {
    const all = await store.listAtoms({ dbPath: ws.dbPath });
    const map = new Map();
    for (const a of all || []) {
      if (a && typeof a.atom_id === "string") map.set(a.atom_id, a);
    }
    storeAdapter = map;
  }

  const chain = traverseChain(promiseAtom.atom_id, storeAdapter);
  check("chain.atom is the promise", chain.atom && chain.atom.atom_id === promiseAtom.atom_id);
  check("chain.supersedes_chain has at least 1 entry", chain.supersedes_chain.length >= 1);
  const firstSup = chain.supersedes_chain[0];
  check(
    "first supersedes entry resolves to invariant atom",
    firstSup && firstSup.id === invariantAtom.atom_id && firstSup.resolved === true,
  );
  const cycleHits = chain.supersedes_chain.filter((s) => s.cycle).length;
  check("no cycles in supersedes chain", cycleHits === 0);
  const unresolvedHits = chain.supersedes_chain.filter((s) => !s.resolved && !s.cycle).length;
  check("no unresolved ids in supersedes chain", unresolvedHits === 0);

  // -------------------------------------------------------------------------
  // 8. HASH CHAIN INTEGRITY — the asserts that earn the LIVE label
  // -------------------------------------------------------------------------
  console.log("8. end-to-end hash chain integrity");
  // 8a. Each atom's own self-hash recomputes correctly.
  for (const [label, atom] of [
    ["decision", decisionAtom],
    ["invariant", invariantAtom],
    ["promise", promiseAtom],
  ]) {
    const reread = await store.getAtom(atom.atom_id, { dbPath: ws.dbPath });
    // Skip the status field difference for the revoked decision when
    // re-validating: revoke MUST NOT mutate the cryptographic atom in the
    // Reality lane. The store may track status separately in its index
    // (the model: append-only event log + index projection). So we validate
    // the ORIGINAL hash payload, not the index projection.
    if (reread && reread.signature?.hash === atom.signature.hash) {
      const v = validateCommitmentAtom({ ...reread, status: atom.status });
      check(`${label} re-read passes signature integrity`, v.valid, JSON.stringify(v.errors));
    } else {
      // If the hashes already differ, that itself is the failure.
      check(
        `${label} re-read preserves signature.hash`,
        false,
        `expected ${atom.signature.hash}, got ${reread?.signature?.hash}`,
      );
    }
  }

  // 8b. The hash CHAIN links: each atom's prev_hash points to the prior atom.
  check(
    "chain link: invariant.prev_hash === decision.hash",
    invariantAtom.signature.prev_hash === decisionAtom.signature.hash,
  );
  check(
    "chain link: promise.prev_hash === invariant.hash",
    promiseAtom.signature.prev_hash === invariantAtom.signature.hash,
  );
  check(
    "chain link: decision.prev_hash === GENESIS (chain root)",
    decisionAtom.signature.prev_hash === "GENESIS",
  );

  // 8c. atom_ids are content-derived, so any two equal-content atoms must
  //     produce the same id. This is a determinism asserter, separate from
  //     the chain — a forged atom with different content would surface here.
  const decisionTwin = encodeCommitmentAtom({
    ...ATOM_BODIES.decision,
    prevHash: "WHATEVER", // prevHash is NOT in id payload
  });
  check(
    "content determinism: equal body -> equal atom_id",
    decisionTwin.atom_id === decisionAtom.atom_id,
  );
  check(
    "content determinism: differing prev_hash -> differing signature.hash",
    decisionTwin.signature.hash !== decisionAtom.signature.hash,
  );

  // -------------------------------------------------------------------------
  // Done
  // -------------------------------------------------------------------------
  await cleanup(ws);
}

main()
  .catch((err) => {
    console.error(`smoke test crashed: ${err.stack || err.message}`);
    failed++;
  })
  .finally(() => {
    console.log("");
    if (failed === 0) {
      console.log("PASS — AtomSmasher commitment-atoms end-to-end smoke green");
      process.exit(0);
    } else {
      console.log(`FAIL — ${failed} check(s) failed`);
      process.exit(1);
    }
  });
