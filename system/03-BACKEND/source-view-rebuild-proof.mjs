#!/usr/bin/env bun
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeChainedJsonReceipt } from "../10-RECEIPTS/tools/json-receipt-chain.mjs";
import {
  AuthorityWideningError,
  SourceMutationError,
  SourceViewAuthorizationError,
  SourceViewStore,
  TRANSFORM_N,
  TRANSFORM_N_PLUS_ONE,
  canonicalJson,
  migrateProjection as migrateProjectionEnvelope,
  sha256,
} from "./source-view-store.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RECEIPT_FILE = "source-view-rebuild-alpha.json";
const SOURCE_FILES = [
  "03-BACKEND/source-view-store.mjs",
  "03-BACKEND/tests/source-view-store.test.mjs",
  "03-BACKEND/source-view-rebuild-proof.mjs",
];
const ACCESS = Object.freeze({ reader: "orange-operator", project: "orange5", purpose: "evidence-replay" });
const AUTHORITY = Object.freeze({
  readers: Object.freeze(["orange-operator", "orange-auditor"]),
  projects: Object.freeze(["orange5"]),
  purposes: Object.freeze(["evidence-replay"]),
});

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function fixture(index) {
  const sequence = String(index).padStart(3, "0");
  const id = `SOURCE-${sequence}`;
  const semanticKey = `uniquesignal${sequence}`;
  const recordVersion = index % 2 === 0 ? TRANSFORM_N : TRANSFORM_N_PLUS_ONE;
  const unknownKey = `futureField${index % 7}`;
  const record = {
    id,
    recordVersion,
    title: `Record ${sequence} - Caf\u00e9 - \u6771\u4eac`,
    body: `Evidence ${semanticKey}; Greek \u03a9; combining e\u0301; laboratory \ud83e\uddea.`,
    semanticKey,
    tags: ["alpha-five", recordVersion, `batch-${index % 5}`],
    acceptedAnswer: {
      disposition: "accepted",
      text: `Accepted answer ${sequence} - na\u00efve \u6f22\u5b57 \ud83d\udd10`,
    },
    [unknownKey]: {
      nested: [index, { futureEnum: `v${index % 4}`, untouched: true }],
      unicode: "\u0414\u0430\u043d\u043d\u044b\u0435 \u0645\u0631\u062d\u0628\u0627 e\u0301",
    },
  };
  const encoded = JSON.stringify(record, null, index % 3 === 0 ? 2 : 0);
  const text = index % 3 === 1 ? ` ${encoded}\r\n` : `${encoded}\n`;
  return {
    id,
    semanticKey,
    record,
    unknownKey,
    bytes: Buffer.from(text, "utf8"),
    authority: AUTHORITY,
    retention: {
      policy: index % 2 === 0 ? "retain" : "legal-hold",
      class: `source-${index % 4}`,
      minimumDays: 3650 + index,
    },
  };
}

function fileHashes() {
  return Object.fromEntries(SOURCE_FILES.map((relative) => {
    const full = path.join(ROOT, relative);
    return [relative, fs.existsSync(full) ? sha256(fs.readFileSync(full)) : null];
  }));
}

function treeDelta(before, after) {
  const beforeByPath = new Map(before.files.map((item) => [item.path, item]));
  const afterByPath = new Map(after.files.map((item) => [item.path, item]));
  return {
    removed: [...beforeByPath.keys()].filter((item) => !afterByPath.has(item)).sort(),
    added: [...afterByPath.keys()].filter((item) => !beforeByPath.has(item)).sort(),
    changed: [...beforeByPath.keys()].filter((item) => {
      const next = afterByPath.get(item);
      return next && !jsonEqual(beforeByPath.get(item), next);
    }).sort(),
  };
}

function jsonEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function replayMatchesExpected(replay) {
  return replay.exact.every((item) => item.result?.sourceId === item.expectedSourceId
      && item.result.authorization === "authorized"
      && item.result.evidencePointers.length === 1)
    && replay.semantic.every((item) => item.results.length === 1
      && item.results[0].sourceId === item.expectedSourceId
      && item.results[0].authorization === "authorized"
      && item.results[0].evidencePointers.length === 1);
}

function authorizedEvidenceAndAnswers(replay) {
  return {
    exact: replay.exact.map((item) => ({
      queryId: item.queryId,
      sourceId: item.result?.sourceId,
      acceptedAnswer: item.result?.acceptedAnswer,
      evidencePointers: item.result?.evidencePointers,
    })),
    semantic: replay.semantic.map((item) => ({
      queryId: item.queryId,
      sourceId: item.results[0]?.sourceId,
      acceptedAnswer: item.results[0]?.acceptedAnswer,
      evidencePointers: item.results[0]?.evidencePointers,
    })),
  };
}

function receiptPartChecks(receipt, chain) {
  if (!receipt || !chain) return { receipt_present: false };
  const { receipt_sha256: receiptHash, ...receiptBody } = receipt;
  const { chain_hash: chainHash, ...chainBody } = chain;
  const receiptFileBytes = `${JSON.stringify(receipt, null, 2)}\n`;
  return {
    receipt_present: true,
    receipt_self_hash_valid: receiptHash === sha256(JSON.stringify(receiptBody)),
    receipt_file_hash_valid: chain.file_sha256 === sha256(receiptFileBytes),
    receipt_predecessor_is_genesis: receipt.prior_receipt === null && receipt.prior_sha256 === "GENESIS",
    external_chain_hash_valid: chainHash === sha256(canonicalJson(chainBody)),
    external_chain_predecessor_is_genesis: chain.prior_chain_hash === "GENESIS",
    external_chain_targets_receipt: chain.file === RECEIPT_FILE,
    alpha_rank_is_five: receipt.scope?.alpha_rank === 5,
    alpha_only_claim: receipt.scope?.production_wired === false
      && receipt.scope?.production_promoted === false
      && receipt.claim_boundary?.production_path_proven === false,
  };
}

function createReceiptEmission(root, receiptBody) {
  const receiptPath = path.join(root, "receipt-emission", RECEIPT_FILE);
  const receipt = writeChainedJsonReceipt(receiptPath, receiptBody);
  const chainPath = path.join(path.dirname(receiptPath), "json-receipt-chain.jsonl");
  const chain = fs.readFileSync(chainPath, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse).at(-1);
  const base = {
    schema: "orange5.source-view-alpha-receipt-emission.v1",
    emission: "stdout",
    durableProductionReceiptWritten: false,
    receipt,
    canonicalChain: chain,
    verification: receiptPartChecks(receipt, chain),
  };
  return { ...base, emissionHash: sha256(canonicalJson(base)) };
}

export function verifyAlphaReceiptEmission(emission) {
  if (!emission || typeof emission !== "object") return { ok: false, checks: { emission_present: false } };
  const { emissionHash, ...base } = emission;
  const recomputedReceiptChecks = receiptPartChecks(emission.receipt, emission.canonicalChain);
  const checks = {
    emission_present: true,
    emission_hash_valid: emissionHash === sha256(canonicalJson(base)),
    recorded_verification_matches: jsonEqual(emission.verification, recomputedReceiptChecks),
    ...recomputedReceiptChecks,
  };
  return { ok: Object.values(checks).every(Boolean), checks };
}

function runScenario(root) {
  const store = new SourceViewStore(path.join(root, "store"));
  const fixtures = Array.from({ length: 100 }, (_, index) => fixture(index));
  const descriptors = fixtures.map((item) => store.putSource(item));
  const sourceAfterIngest = store.sourceSnapshot();
  const roundTrips = [];

  for (const [index, descriptor] of descriptors.entries()) {
    const original = fixtures[index];
    const n = store.createProjection(descriptor.sourceHash, TRANSFORM_N);
    const next = migrateProjectionEnvelope(n, TRANSFORM_N_PLUS_ONE);
    const back = migrateProjectionEnvelope(next, TRANSFORM_N);
    const backRecord = back.payload.record;
    const hydrated = store.hydrateSource(descriptor.sourceHash);
    roundTrips.push({
      sourceId: descriptor.sourceId,
      sourceBytesExact: hydrated.bytes.equals(original.bytes),
      sourceHashExact: sha256(hydrated.bytes) === descriptor.sourceHash,
      sourceAuthorityExact: jsonEqual(hydrated.descriptor.authority, original.authority),
      sourceRetentionExact: jsonEqual(hydrated.descriptor.retention, original.retention),
      projectionRoundTripExact: jsonEqual(n, back),
      unknownFieldExact: jsonEqual(backRecord[original.unknownKey], original.record[original.unknownKey]),
      unicodeExact: backRecord.title === original.record.title
        && backRecord.body === original.record.body
        && backRecord.acceptedAnswer.text === original.record.acceptedAnswer.text,
      sourceBindingsExact: n.source.sourceHash === descriptor.sourceHash
        && next.source.sourceHash === descriptor.sourceHash
        && back.source.sourceHash === descriptor.sourceHash,
      transformBindingsExact: n.transformVersion === TRANSFORM_N
        && next.transformVersion === TRANSFORM_N_PLUS_ONE
        && back.transformVersion === TRANSFORM_N,
    });
  }

  const versionForSource = (_descriptor, record) => record.recordVersion;
  const initialBuild = store.rebuildDerivedIndex({ transformVersionForSource: versionForSource });
  const initialIndexHash = initialBuild.index.indexHash;
  const versionCounts = Object.fromEntries([TRANSFORM_N, TRANSFORM_N_PLUS_ONE].map((version) => [
    version,
    initialBuild.index.entries.filter((entry) => entry.transformVersion === version).length,
  ]));

  const frozenQueries = deepFreeze({
    exact: fixtures.map((item, index) => ({
      queryId: `exact-${String(index).padStart(3, "0")}`,
      sourceId: item.id,
      expectedSourceId: item.id,
    })),
    semantic: fixtures.map((item, index) => ({
      queryId: `semantic-${String(index).padStart(3, "0")}`,
      text: item.semanticKey,
      expectedSourceId: item.id,
      limit: 1,
    })),
  });
  const beforeReplay = store.replayFrozenQueries(frozenQueries, ACCESS);
  const acceptedEvidenceBefore = authorizedEvidenceAndAnswers(beforeReplay);
  const beforeDeletion = store.storeSnapshot();
  const deletion = store.deleteDerivedIndex();
  const afterDeletion = store.storeSnapshot();
  const deletionDelta = treeDelta(beforeDeletion, afterDeletion);
  const rebuilt = store.rebuildDerivedIndex({
    transformVersionForSource: versionForSource,
    writeProjections: false,
  });
  const afterReplay = store.replayFrozenQueries(frozenQueries, ACCESS);
  const acceptedEvidenceAfter = authorizedEvidenceAndAnswers(afterReplay);
  const beforeRejectionProbes = store.storeSnapshot();

  let authorityWideningRejected = false;
  try {
    store.createProjection(descriptors[0].sourceHash, TRANSFORM_N_PLUS_ONE, {
      authority: {
        readers: [...AUTHORITY.readers, "public"],
        projects: [...AUTHORITY.projects],
        purposes: [...AUTHORITY.purposes],
      },
    });
  } catch (error) {
    authorityWideningRejected = error instanceof AuthorityWideningError;
  }

  let sourceMutationRejected = false;
  try {
    store.putSource({
      ...fixtures[0],
      bytes: Buffer.from(JSON.stringify({ ...fixtures[0].record, body: "mutated source" }), "utf8"),
    });
  } catch (error) {
    sourceMutationRejected = error instanceof SourceMutationError;
  }

  let retentionMutationRejected = false;
  try {
    store.putSource({
      ...fixtures[1],
      retention: { ...fixtures[1].retention, minimumDays: 1 },
    });
  } catch (error) {
    retentionMutationRejected = error instanceof SourceMutationError;
  }

  let unauthorizedQueryRejected = false;
  try {
    store.queryExactId(fixtures[0].id, { reader: "public", project: "orange5", purpose: "evidence-replay" });
  } catch (error) {
    unauthorizedQueryRejected = error instanceof SourceViewAuthorizationError;
  }
  const afterRejectionProbes = store.storeSnapshot();
  const sourceAtEnd = store.sourceSnapshot();

  const checks = {
    one_hundred_mixed_version_sources: descriptors.length === 100
      && versionCounts[TRANSFORM_N] === 50
      && versionCounts[TRANSFORM_N_PLUS_ONE] === 50,
    n_to_n_plus_one_to_n_exact: roundTrips.length === 100
      && roundTrips.every((item) => item.projectionRoundTripExact),
    immutable_source_bytes_hash_authority_retention: roundTrips.every((item) => item.sourceBytesExact
      && item.sourceHashExact && item.sourceAuthorityExact && item.sourceRetentionExact),
    unknown_fields_and_unicode_preserved: roundTrips.every((item) => item.unknownFieldExact && item.unicodeExact),
    every_projection_bound_to_source_and_transform: roundTrips.every((item) => item.sourceBindingsExact
      && item.transformBindingsExact),
    exact_id_queries_authorized_and_accepted: beforeReplay.exact.length === 100
      && replayMatchesExpected({ exact: beforeReplay.exact, semantic: [] }),
    semantic_queries_authorized_and_accepted: beforeReplay.semantic.length === 100
      && replayMatchesExpected({ exact: [], semantic: beforeReplay.semantic }),
    only_derived_index_deleted: deletion.deleted === true
      && jsonEqual(deletionDelta.removed, ["derived/index.json"])
      && deletionDelta.added.length === 0
      && deletionDelta.changed.length === 0,
    derived_index_rebuilt_from_source_only: rebuilt.evidence.sourceRecordsHydrated === 100
      && rebuilt.evidence.indexEntriesBuiltFromSource === 100
      && rebuilt.evidence.indexEntriesReadFromProjectionFiles === 0
      && rebuilt.evidence.projectionFilesWritten === 0,
    rebuilt_index_is_canonical_match: rebuilt.index.indexHash === initialIndexHash,
    frozen_query_set_unchanged: beforeReplay.querySetHash === afterReplay.querySetHash,
    exact_and_semantic_replay_match_expected: replayMatchesExpected(afterReplay),
    authorized_evidence_pointers_and_answers_identical: jsonEqual(acceptedEvidenceBefore, acceptedEvidenceAfter),
    source_tree_unchanged_after_projection_lifecycle: sourceAfterIngest.snapshotHash === sourceAtEnd.snapshotHash,
    authority_widening_rejected: authorityWideningRejected,
    source_mutation_rejected: sourceMutationRejected,
    retention_mutation_rejected: retentionMutationRejected,
    unauthorized_query_rejected: unauthorizedQueryRejected,
    rejection_probes_left_store_unchanged: beforeRejectionProbes.snapshotHash === afterRejectionProbes.snapshotHash,
  };

  return {
    checks,
    workload: {
      sourceRecords: fixtures.length,
      sourceRecordVersions: versionCounts,
      roundTrips: roundTrips.length,
      exactQueries: frozenQueries.exact.length,
      semanticQueries: frozenQueries.semantic.length,
      frozenQueries,
    },
    evidence: {
      sourceSnapshotHash: sourceAfterIngest.snapshotHash,
      sourceFiles: sourceAfterIngest.files.length,
      initialIndexHash,
      rebuiltIndexHash: rebuilt.index.indexHash,
      frozenQuerySetHash: beforeReplay.querySetHash,
      beforeAcceptedEvidenceHash: sha256(canonicalJson(acceptedEvidenceBefore)),
      afterAcceptedEvidenceHash: sha256(canonicalJson(acceptedEvidenceAfter)),
      deletion,
      deletionDelta,
      initialBuild: initialBuild.evidence,
      rebuild: rebuilt.evidence,
      rejectionProbeTreeHash: afterRejectionProbes.snapshotHash,
      replayCounts: {
        exactBefore: beforeReplay.exact.length,
        exactAfter: afterReplay.exact.length,
        semanticBefore: beforeReplay.semantic.length,
        semanticAfter: afterReplay.semantic.length,
      },
      acceptedEvidenceSamples: {
        firstExact: acceptedEvidenceAfter.exact[0],
        lastSemantic: acceptedEvidenceAfter.semantic.at(-1),
      },
    },
  };
}

export function runSourceViewRebuildProof({ generatedAt = new Date().toISOString() } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orange5-source-view-proof-"));
  let scenario;
  let errorEvidence = null;
  try {
    try {
      scenario = runScenario(root);
    } catch (error) {
      scenario = { checks: { proof_completed: false }, workload: {}, evidence: {} };
      errorEvidence = { name: error?.name || "Error", message: error?.message || String(error) };
    }
    const proven = Object.values(scenario.checks).length > 0 && Object.values(scenario.checks).every(Boolean);
    const receiptBody = {
      schema: "orange5.source-view-rebuild-alpha-proof.v1",
      state: proven ? "PROVEN" : "BLOCKED",
      status: proven ? "SOURCE_VIEW_ALPHA_5_PROVEN" : "SOURCE_VIEW_ALPHA_5_BLOCKED",
      generated_at: generatedAt,
      action: "prove.source-representation-separation",
      scope: {
        alpha_rank: 5,
        decision: "ADOPT_AS_ALPHA_INVARIANT",
        production_wired: false,
        production_promoted: false,
        runtime_root: "ephemeral-isolated-proof-root",
      },
      checks: scenario.checks,
      workload: scenario.workload,
      evidence: scenario.evidence,
      error: errorEvidence,
      source_files: fileHashes(),
      reproduction: {
        focused_tests: "bun test 03-BACKEND/tests/source-view-store.test.mjs",
        proof: "bun 03-BACKEND/source-view-rebuild-proof.mjs",
      },
      claim_boundary: {
        isolated_alpha_invariant_proven: proven,
        production_path_proven: false,
        production_state_mutated: false,
        durable_production_receipt_written: false,
        limitation: "Deterministic local lexical semantics and source hydration are proven; no production store or route is wired.",
      },
    };
    return createReceiptEmission(root, receiptBody);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const emission = runSourceViewRebuildProof();
  console.log(JSON.stringify(emission, null, 2));
  const verified = verifyAlphaReceiptEmission(emission);
  if (!verified.ok || emission.receipt.status !== "SOURCE_VIEW_ALPHA_5_PROVEN") process.exitCode = 1;
}
