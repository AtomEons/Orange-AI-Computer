import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AuthorityWideningError,
  SourceMutationError,
  SourceViewAuthorizationError,
  SourceViewIntegrityError,
  SourceViewStore,
  TRANSFORM_N,
  TRANSFORM_N_PLUS_ONE,
  canonicalJson,
  sha256,
} from "../source-view-store.mjs";
import {
  runSourceViewRebuildProof,
  verifyAlphaReceiptEmission,
} from "../source-view-rebuild-proof.mjs";

const temporaryRoots = [];
const AUTHORITY = {
  readers: ["operator", "auditor"],
  projects: ["orange5"],
  purposes: ["evidence-replay"],
};
const ACCESS = { reader: "operator", project: "orange5", purpose: "evidence-replay" };

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orange-source-view-test-"));
  temporaryRoots.push(root);
  return new SourceViewStore(root);
}

function sourceFixture(index = 0, version = TRANSFORM_N) {
  const id = `record-${index}`;
  const semanticKey = `distinctsignal${index}`;
  const record = {
    id,
    recordVersion: version,
    title: `Caf\u00e9 \u6771\u4eac ${index}`,
    body: `Semantic ${semanticKey}; combining e\u0301; emoji \ud83e\uddea`,
    semanticKey,
    acceptedAnswer: { state: "accepted", text: `Answer \u03a9 ${index}` },
    futureExtension: {
      unknownEnum: `future-${index}`,
      nested: [true, { \u672a\u6765: "\u503c" }],
    },
  };
  const bytes = Buffer.from(` {\n  ${JSON.stringify("id")}: ${JSON.stringify(record.id)},\n  ${JSON.stringify("recordVersion")}: ${JSON.stringify(record.recordVersion)},\n  ${JSON.stringify("title")}: ${JSON.stringify(record.title)},\n  ${JSON.stringify("body")}: ${JSON.stringify(record.body)},\n  ${JSON.stringify("semanticKey")}: ${JSON.stringify(record.semanticKey)},\n  ${JSON.stringify("acceptedAnswer")}: ${JSON.stringify(record.acceptedAnswer)},\n  ${JSON.stringify("futureExtension")}: ${JSON.stringify(record.futureExtension)}\n}\r\n`, "utf8");
  return {
    record,
    bytes,
    authority: AUTHORITY,
    retention: { policy: "legal-hold", minimumDays: 3650 + index },
  };
}

function changedPaths(before, after) {
  const left = new Map(before.files.map((item) => [item.path, item]));
  const right = new Map(after.files.map((item) => [item.path, item]));
  return {
    removed: [...left.keys()].filter((key) => !right.has(key)).sort(),
    added: [...right.keys()].filter((key) => !left.has(key)).sort(),
    changed: [...left.keys()].filter((key) => right.has(key)
      && canonicalJson(left.get(key)) !== canonicalJson(right.get(key))).sort(),
  };
}

describe("source and representation separation", () => {
  test("preserves exact source bytes and reversibly carries unknown Unicode fields through N -> N+1 -> N", () => {
    const store = tempStore();
    const fixture = sourceFixture(7);
    const descriptor = store.putSource(fixture);
    const sourceSnapshot = store.sourceSnapshot();

    expect(descriptor.sourceHash).toBe(sha256(fixture.bytes));
    expect(descriptor.authority).toEqual(fixture.authority);
    expect(descriptor.retention).toEqual(fixture.retention);
    expect(store.hydrateSource(descriptor.sourceHash).bytes.equals(fixture.bytes)).toBe(true);

    const n = store.createProjection(descriptor.sourceHash, TRANSFORM_N);
    const next = store.migrateProjection(n, TRANSFORM_N_PLUS_ONE);
    const back = store.migrateProjection(next, TRANSFORM_N);

    expect(canonicalJson(back)).toBe(canonicalJson(n));
    expect(back.payload.record.futureExtension).toEqual(fixture.record.futureExtension);
    expect(back.payload.record.title).toBe(fixture.record.title);
    expect(back.payload.record.body).toBe(fixture.record.body);
    expect([n, next, back].every((view) => view.source.sourceHash === descriptor.sourceHash)).toBe(true);
    expect([n.transformVersion, next.transformVersion, back.transformVersion])
      .toEqual([TRANSFORM_N, TRANSFORM_N_PLUS_ONE, TRANSFORM_N]);
    expect(store.sourceSnapshot().snapshotHash).toBe(sourceSnapshot.snapshotHash);
  });

  test("rejects source replacement, metadata mutation, authority widening, unauthorized hydration, and byte tampering", () => {
    const store = tempStore();
    const fixture = sourceFixture(1);
    const descriptor = store.putSource(fixture);
    const sourceSnapshot = store.sourceSnapshot();

    const replacement = Buffer.from(JSON.stringify({ ...fixture.record, body: "replacement" }), "utf8");
    expect(() => store.putSource({ ...fixture, bytes: replacement })).toThrow(SourceMutationError);
    expect(() => store.putSource({
      ...fixture,
      retention: { ...fixture.retention, minimumDays: 1 },
    })).toThrow(SourceMutationError);
    expect(() => store.putSource({
      ...fixture,
      authority: { ...fixture.authority, readers: ["operator", "auditor", "public"] },
    })).toThrow(SourceMutationError);
    expect(() => store.createProjection(descriptor.sourceHash, TRANSFORM_N_PLUS_ONE, {
      authority: { ...fixture.authority, readers: ["operator", "auditor", "public"] },
    })).toThrow(AuthorityWideningError);
    expect(() => store.hydrateEvidence({ sourceHash: descriptor.sourceHash }, {
      reader: "public", project: "orange5", purpose: "evidence-replay",
    })).toThrow(SourceViewIntegrityError);
    expect(store.sourceSnapshot().snapshotHash).toBe(sourceSnapshot.snapshotHash);

    fs.writeFileSync(store.sourceObjectPath(descriptor.sourceHash), replacement);
    expect(() => store.hydrateSource(descriptor.sourceHash)).toThrow(SourceMutationError);
  });

  test("deletes only the derived index, rebuilds it from source, and replays identical authorized evidence", () => {
    const store = tempStore();
    const fixtures = Array.from({ length: 8 }, (_, index) => sourceFixture(
      index,
      index % 2 === 0 ? TRANSFORM_N : TRANSFORM_N_PLUS_ONE,
    ));
    fixtures.forEach((fixture) => store.putSource(fixture));
    const versionForSource = (_descriptor, record) => record.recordVersion;
    const initial = store.rebuildDerivedIndex({ transformVersionForSource: versionForSource });
    const queries = Object.freeze({
      exact: Object.freeze(fixtures.map((fixture, index) => Object.freeze({
        queryId: `exact-${index}`,
        sourceId: fixture.record.id,
        expectedSourceId: fixture.record.id,
      }))),
      semantic: Object.freeze(fixtures.map((fixture, index) => Object.freeze({
        queryId: `semantic-${index}`,
        text: fixture.record.semanticKey,
        expectedSourceId: fixture.record.id,
        limit: 1,
      }))),
    });
    const beforeReplay = store.replayFrozenQueries(queries, ACCESS);
    const sourceBefore = store.sourceSnapshot();
    const projectionsBefore = store.projectionSnapshot();
    const treeBefore = store.storeSnapshot();

    const deletion = store.deleteDerivedIndex();
    const treeAfter = store.storeSnapshot();
    expect(deletion).toMatchObject({ deleted: true, relativePath: "derived/index.json" });
    expect(changedPaths(treeBefore, treeAfter)).toEqual({
      removed: ["derived/index.json"], added: [], changed: [],
    });
    expect(store.sourceSnapshot().snapshotHash).toBe(sourceBefore.snapshotHash);
    expect(store.projectionSnapshot().snapshotHash).toBe(projectionsBefore.snapshotHash);
    expect(() => store.readDerivedIndex()).toThrow("derived index is missing");

    const rebuilt = store.rebuildDerivedIndex({
      transformVersionForSource: versionForSource,
      writeProjections: false,
    });
    const afterReplay = store.replayFrozenQueries(queries, ACCESS);
    expect(rebuilt.evidence).toEqual({
      sourceRecordsHydrated: 8,
      indexEntriesBuiltFromSource: 8,
      indexEntriesReadFromProjectionFiles: 0,
      projectionFilesWritten: 0,
    });
    expect(rebuilt.index.indexHash).toBe(initial.index.indexHash);
    expect(canonicalJson(afterReplay)).toBe(canonicalJson(beforeReplay));
    expect(() => store.queryExactId(fixtures[0].record.id, {
      reader: "public", project: "orange5", purpose: "evidence-replay",
    })).toThrow(SourceViewAuthorizationError);
  });

  test("proves the full 100-record workload and emits a verified alpha-only canonical receipt chain", () => {
    const emission = runSourceViewRebuildProof({ generatedAt: "2026-08-28T00:00:00.000Z" });
    const verification = verifyAlphaReceiptEmission(emission);

    expect(verification.ok).toBe(true);
    expect(emission.receipt.status).toBe("SOURCE_VIEW_ALPHA_5_PROVEN");
    expect(emission.receipt.state).toBe("PROVEN");
    expect(emission.receipt.workload).toMatchObject({
      sourceRecords: 100,
      sourceRecordVersions: { N: 50, "N+1": 50 },
      roundTrips: 100,
      exactQueries: 100,
      semanticQueries: 100,
    });
    expect(Object.values(emission.receipt.checks).every(Boolean)).toBe(true);
    expect(emission.canonicalChain.prior_chain_hash).toBe("GENESIS");
    expect(emission.durableProductionReceiptWritten).toBe(false);
    expect(emission.receipt.claim_boundary.production_path_proven).toBe(false);
  }, 60_000);
});
