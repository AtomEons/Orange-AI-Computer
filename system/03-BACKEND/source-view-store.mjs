import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SOURCE_DESCRIPTOR_SCHEMA = "orange.source-view.source-descriptor.v1";
export const PROJECTION_SCHEMA = "orange.source-view.projection.v1";
export const DERIVED_INDEX_SCHEMA = "orange.source-view.derived-index.v1";
export const TRANSFORM_N = "N";
export const TRANSFORM_N_PLUS_ONE = "N+1";

const TRANSFORM_VERSIONS = new Set([TRANSFORM_N, TRANSFORM_N_PLUS_ONE]);
const SOURCE_HASH = /^[a-f0-9]{64}$/;
const AUTHORITY_DIMENSIONS = ["projects", "purposes", "readers"];
const SEARCH_ALGORITHM = "unicode-token-overlap.v1";
const utf8 = new TextDecoder("utf-8", { fatal: true });

export class SourceViewIntegrityError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "SourceViewIntegrityError";
  }
}

export class SourceMutationError extends SourceViewIntegrityError {
  constructor(message, options) {
    super(message, options);
    this.name = "SourceMutationError";
  }
}

export class AuthorityWideningError extends SourceViewIntegrityError {
  constructor(message, options) {
    super(message, options);
    this.name = "AuthorityWideningError";
  }
}

export class SourceViewAuthorizationError extends Error {
  constructor(message) {
    super(message);
    this.name = "SourceViewAuthorizationError";
  }
}

export class DerivedViewConflictError extends SourceViewIntegrityError {
  constructor(message, options) {
    super(message, options);
    this.name = "DerivedViewConflictError";
  }
}

function assertJsonValue(value, location = "$", seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${location} must contain only finite JSON numbers`);
    return;
  }
  if (typeof value !== "object") throw new TypeError(`${location} is not JSON data`);
  if (seen.has(value)) throw new TypeError(`${location} contains a cycle`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${location}[${index}]`, seen));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${location} must be a plain JSON object`);
    }
    for (const key of Object.keys(value)) assertJsonValue(value[key], `${location}.${key}`, seen);
  }
  seen.delete(value);
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

export function canonicalJson(value) {
  assertJsonValue(value);
  return stableJson(value);
}

export function sha256(value) {
  const bytes = value instanceof Uint8Array ? value : String(value);
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function cloneJson(value) {
  assertJsonValue(value);
  return JSON.parse(JSON.stringify(value));
}

function jsonEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function requireSourceHash(value) {
  if (typeof value !== "string" || !SOURCE_HASH.test(value)) {
    throw new TypeError("sourceHash must be a lowercase SHA-256 value");
  }
  return value;
}

function requireTransformVersion(value) {
  if (!TRANSFORM_VERSIONS.has(value)) throw new TypeError(`unsupported transform version: ${value}`);
  return value;
}

function normalizeAuthority(value) {
  const authority = cloneJson(value);
  if (!authority || Array.isArray(authority) || typeof authority !== "object") {
    throw new TypeError("authority must be an object");
  }
  const keys = Object.keys(authority).sort();
  if (!jsonEqual(keys, AUTHORITY_DIMENSIONS)) {
    throw new TypeError(`authority must contain exactly: ${AUTHORITY_DIMENSIONS.join(", ")}`);
  }
  for (const dimension of AUTHORITY_DIMENSIONS) {
    const grants = authority[dimension];
    if (!Array.isArray(grants) || grants.length === 0
      || grants.some((grant) => typeof grant !== "string" || grant.length === 0)
      || new Set(grants).size !== grants.length) {
      throw new TypeError(`authority.${dimension} must be a non-empty array of unique strings`);
    }
  }
  return authority;
}

function normalizeRetention(value) {
  const retention = cloneJson(value);
  if (!retention || Array.isArray(retention) || typeof retention !== "object") {
    throw new TypeError("retention must be an object");
  }
  return retention;
}

export function assertAuthorityNotWidened(sourceAuthority, candidateAuthority) {
  const source = normalizeAuthority(sourceAuthority);
  const candidate = normalizeAuthority(candidateAuthority);
  for (const dimension of AUTHORITY_DIMENSIONS) {
    const allowed = new Set(source[dimension]);
    const widened = candidate[dimension].filter((grant) => !allowed.has(grant));
    if (widened.length > 0) {
      throw new AuthorityWideningError(`authority.${dimension} widens source grants: ${widened.join(", ")}`);
    }
  }
  return true;
}

export function isAccessAuthorized(authorityValue, access) {
  const authority = normalizeAuthority(authorityValue);
  if (!access || typeof access !== "object" || Array.isArray(access)) return false;
  return authority.readers.includes(access.reader)
    && authority.projects.includes(access.project)
    && authority.purposes.includes(access.purpose);
}

function parseSourceBytes(value) {
  const bytes = typeof value === "string"
    ? Buffer.from(value, "utf8")
    : value instanceof Uint8Array
      ? Buffer.from(value)
      : null;
  if (!bytes || bytes.byteLength === 0) throw new TypeError("source bytes must be a non-empty string or Uint8Array");
  let text;
  try {
    text = utf8.decode(bytes);
  } catch (error) {
    throw new SourceViewIntegrityError("source bytes are not valid UTF-8", { cause: error });
  }
  let record;
  try {
    record = JSON.parse(text);
  } catch (error) {
    throw new SourceViewIntegrityError("source bytes are not valid JSON", { cause: error });
  }
  if (!record || Array.isArray(record) || typeof record !== "object") {
    throw new SourceViewIntegrityError("source JSON must be an object");
  }
  if (typeof record.id !== "string" || record.id.length === 0) {
    throw new SourceViewIntegrityError("source JSON must contain a non-empty string id");
  }
  assertJsonValue(record);
  return { bytes, record };
}

function searchText(record) {
  const values = [record.id, record.title, record.body, record.semanticKey];
  if (Array.isArray(record.tags)) values.push(...record.tags);
  return values.filter((value) => typeof value === "string").join("\n");
}

export function tokenize(value) {
  return (String(value).normalize("NFKC").toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) || [])
    .filter(Boolean);
}

function searchRepresentation(record) {
  const text = searchText(record);
  const tokens = tokenize(text);
  const termFrequencies = {};
  for (const token of tokens) termFrequencies[token] = (termFrequencies[token] || 0) + 1;
  return {
    algorithm: SEARCH_ALGORITHM,
    textHash: sha256(text),
    terms: Object.keys(termFrequencies).sort(),
    termFrequencies,
  };
}

function descriptorBody({ sourceId, sourceHash, sourceByteLength, sourceRecordHash, authority, retention }) {
  return {
    schema: SOURCE_DESCRIPTOR_SCHEMA,
    sourceId,
    sourceHash,
    sourceByteLength,
    sourceRecordHash,
    authority: cloneJson(authority),
    authorityHash: sha256(canonicalJson(authority)),
    retention: cloneJson(retention),
    retentionHash: sha256(canonicalJson(retention)),
  };
}

function chainDescriptor(body) {
  return { ...body, descriptorHash: sha256(canonicalJson(body)) };
}

function verifyDescriptor(descriptor) {
  if (!descriptor || descriptor.schema !== SOURCE_DESCRIPTOR_SCHEMA) {
    throw new SourceViewIntegrityError("source descriptor schema mismatch");
  }
  const { descriptorHash, ...body } = descriptor;
  if (descriptorHash !== sha256(canonicalJson(body))) {
    throw new SourceViewIntegrityError(`source descriptor hash mismatch for ${descriptor.sourceId || "unknown"}`);
  }
  requireSourceHash(descriptor.sourceHash);
  if (!Number.isSafeInteger(descriptor.sourceByteLength) || descriptor.sourceByteLength < 1) {
    throw new SourceViewIntegrityError("source descriptor byte length is invalid");
  }
  if (!SOURCE_HASH.test(descriptor.sourceRecordHash || "")) {
    throw new SourceViewIntegrityError("source descriptor record hash is invalid");
  }
  const authority = normalizeAuthority(descriptor.authority);
  const retention = normalizeRetention(descriptor.retention);
  if (descriptor.authorityHash !== sha256(canonicalJson(authority))) {
    throw new SourceViewIntegrityError("source authority hash mismatch");
  }
  if (descriptor.retentionHash !== sha256(canonicalJson(retention))) {
    throw new SourceViewIntegrityError("source retention hash mismatch");
  }
  return descriptor;
}

function sourceBinding(descriptor) {
  return {
    sourceId: descriptor.sourceId,
    sourceHash: descriptor.sourceHash,
    sourceByteLength: descriptor.sourceByteLength,
    sourceRecordHash: descriptor.sourceRecordHash,
    sourceAuthorityHash: descriptor.authorityHash,
    sourceRetentionHash: descriptor.retentionHash,
  };
}

function evidencePointer(descriptor) {
  return {
    kind: "orange.immutable-source-json.v1",
    sourceId: descriptor.sourceId,
    sourceHash: descriptor.sourceHash,
    relativePath: `sources/objects/${descriptor.sourceHash}.bin`,
    byteRange: { start: 0, endExclusive: descriptor.sourceByteLength },
    jsonPointer: "/acceptedAnswer",
    authorityHash: descriptor.authorityHash,
    retentionHash: descriptor.retentionHash,
  };
}

function projectionRecord(projection) {
  if (projection.transformVersion === TRANSFORM_N) return projection.payload?.record;
  if (projection.transformVersion === TRANSFORM_N_PLUS_ONE) return projection.payload?.document;
  return undefined;
}

function projectionSearch(projection) {
  const value = projection.transformVersion === TRANSFORM_N
    ? projection.payload?.search
    : projection.payload?.retrieval;
  if (!value) return value;
  return projection.transformVersion === TRANSFORM_N
    ? value
    : {
        algorithm: value.algorithm,
        textHash: value.contentHash,
        terms: value.lexemes,
        termFrequencies: value.termFrequencies,
      };
}

function makeProjection(recordValue, descriptor, transformVersion, authorityValue = descriptor.authority) {
  const record = cloneJson(recordValue);
  const version = requireTransformVersion(transformVersion);
  const authority = normalizeAuthority(authorityValue);
  assertAuthorityNotWidened(descriptor.authority, authority);
  const search = searchRepresentation(record);
  const payload = version === TRANSFORM_N
    ? { record, search }
    : {
        document: record,
        retrieval: {
          algorithm: search.algorithm,
          contentHash: search.textHash,
          lexemes: search.terms,
          termFrequencies: search.termFrequencies,
        },
      };
  const body = {
    schema: PROJECTION_SCHEMA,
    transformVersion: version,
    source: sourceBinding(descriptor),
    authority,
    retention: cloneJson(descriptor.retention),
    payload,
  };
  return { ...body, projectionHash: sha256(canonicalJson(body)) };
}

export function validateProjection(projection, { descriptor = null, sourceRecord = null } = {}) {
  if (!projection || projection.schema !== PROJECTION_SCHEMA) {
    throw new SourceViewIntegrityError("projection schema mismatch");
  }
  requireTransformVersion(projection.transformVersion);
  const { projectionHash, ...body } = projection;
  if (projectionHash !== sha256(canonicalJson(body))) {
    throw new SourceViewIntegrityError("projection hash mismatch");
  }
  const record = projectionRecord(projection);
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new SourceViewIntegrityError("projection record is missing");
  }
  if (record.id !== projection.source?.sourceId) {
    throw new SourceViewIntegrityError("projection source id does not match its record");
  }
  if (sha256(canonicalJson(record)) !== projection.source?.sourceRecordHash) {
    throw new SourceViewIntegrityError("projection record mutated relative to its source binding");
  }
  const expectedSearch = searchRepresentation(record);
  if (!jsonEqual(projectionSearch(projection), expectedSearch)) {
    throw new SourceViewIntegrityError("projection search representation is not reproducible from its record");
  }
  normalizeAuthority(projection.authority);
  normalizeRetention(projection.retention);
  if (descriptor) {
    verifyDescriptor(descriptor);
    if (!jsonEqual(projection.source, sourceBinding(descriptor))) {
      throw new SourceViewIntegrityError("projection source binding does not match the immutable descriptor");
    }
    if (!jsonEqual(projection.retention, descriptor.retention)) {
      throw new SourceViewIntegrityError("projection retention differs from source retention");
    }
    assertAuthorityNotWidened(descriptor.authority, projection.authority);
  }
  if (sourceRecord && !jsonEqual(record, sourceRecord)) {
    throw new SourceViewIntegrityError("projection record differs from hydrated source JSON");
  }
  return true;
}

export function migrateProjection(projection, targetTransformVersion) {
  validateProjection(projection);
  const descriptor = {
    sourceId: projection.source.sourceId,
    sourceHash: projection.source.sourceHash,
    sourceByteLength: projection.source.sourceByteLength,
    sourceRecordHash: projection.source.sourceRecordHash,
    authority: cloneJson(projection.authority),
    authorityHash: projection.source.sourceAuthorityHash,
    retention: cloneJson(projection.retention),
    retentionHash: projection.source.sourceRetentionHash,
  };
  return makeProjection(projectionRecord(projection), descriptor, targetTransformVersion, projection.authority);
}

function snapshotFiles(root) {
  const files = [];
  const visit = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new SourceViewIntegrityError(`symbolic link is not allowed in store: ${full}`);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) {
        const bytes = fs.readFileSync(full);
        files.push({
          path: path.relative(root, full).replace(/\\/g, "/"),
          byteLength: bytes.byteLength,
          sha256: sha256(bytes),
        });
      }
    }
  };
  visit(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { files, snapshotHash: sha256(canonicalJson(files)) };
}

function writeExclusiveOrVerify(file, bytes, ErrorType, message) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = fs.readFileSync(file);
    const expected = bytes instanceof Uint8Array ? Buffer.from(bytes) : Buffer.from(String(bytes));
    if (!existing.equals(expected)) throw new ErrorType(message, { cause: error });
  }
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function indexEntry(projection, descriptor) {
  const search = projectionSearch(projection);
  return {
    sourceId: descriptor.sourceId,
    sourceHash: descriptor.sourceHash,
    transformVersion: projection.transformVersion,
    projectionHash: projection.projectionHash,
    authority: cloneJson(projection.authority),
    authorityHash: sha256(canonicalJson(projection.authority)),
    retentionHash: descriptor.retentionHash,
    terms: cloneJson(search.terms),
    termFrequencies: cloneJson(search.termFrequencies),
    evidencePointer: evidencePointer(descriptor),
  };
}

function indexBody(entries) {
  const sorted = [...entries].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  return {
    schema: DERIVED_INDEX_SCHEMA,
    builtFrom: "immutable-source-bytes",
    sourceDescriptorSchema: SOURCE_DESCRIPTOR_SCHEMA,
    projectionSchema: PROJECTION_SCHEMA,
    recordCount: sorted.length,
    entries: sorted,
  };
}

function semanticScore(entry, queryTerms) {
  let score = 0;
  for (const term of queryTerms) score += Number(entry.termFrequencies[term] || 0);
  return score;
}

function score01(value, fallback = 0) {
  const score = Number(value);
  return Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : fallback;
}

function answerText(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.summary === "string") return value.summary;
  return canonicalJson(value);
}

function workbenchMetadata(record) {
  return record?.workbench && typeof record.workbench === "object" && !Array.isArray(record.workbench)
    ? record.workbench
    : {};
}

export class SourceViewStore {
  constructor(root) {
    if (typeof root !== "string" || root.length === 0) throw new TypeError("store root is required");
    this.root = path.resolve(root);
    this.sourcesRoot = path.join(this.root, "sources");
    this.sourceObjectsRoot = path.join(this.sourcesRoot, "objects");
    this.sourceDescriptorsRoot = path.join(this.sourcesRoot, "descriptors");
    this.derivedRoot = path.join(this.root, "derived");
    this.projectionsRoot = path.join(this.derivedRoot, "projections");
    this.indexPath = path.join(this.derivedRoot, "index.json");
    this.descriptorsById = null;
    fs.mkdirSync(this.sourceObjectsRoot, { recursive: true });
    fs.mkdirSync(this.sourceDescriptorsRoot, { recursive: true });
    fs.mkdirSync(this.projectionsRoot, { recursive: true });
  }

  sourceObjectPath(sourceHash) {
    return path.join(this.sourceObjectsRoot, `${requireSourceHash(sourceHash)}.bin`);
  }

  sourceDescriptorPath(sourceHash) {
    return path.join(this.sourceDescriptorsRoot, `${requireSourceHash(sourceHash)}.json`);
  }

  projectionPath(sourceHash, transformVersion) {
    return path.join(this.projectionsRoot, requireSourceHash(sourceHash), `${requireTransformVersion(transformVersion)}.json`);
  }

  putSource({ bytes: sourceValue, authority: authorityValue, retention: retentionValue }) {
    const { bytes, record } = parseSourceBytes(sourceValue);
    const authority = normalizeAuthority(authorityValue);
    const retention = normalizeRetention(retentionValue);
    const sourceHash = sha256(bytes);
    if (this.descriptorsById === null) {
      this.descriptorsById = new Map(this.listSourceDescriptors().map((item) => [item.sourceId, item]));
    }
    const priorById = this.descriptorsById.get(record.id);
    if (priorById && priorById.sourceHash !== sourceHash) {
      throw new SourceMutationError(`source ${record.id} is immutable; replacement bytes were rejected`);
    }
    if (priorById) {
      const hydrated = this.hydrateSource(sourceHash);
      if (!hydrated.bytes.equals(bytes)) throw new SourceMutationError(`source bytes changed for ${record.id}`);
      if (!jsonEqual(priorById.authority, authority)) throw new SourceMutationError(`source authority changed for ${record.id}`);
      if (!jsonEqual(priorById.retention, retention)) throw new SourceMutationError(`source retention changed for ${record.id}`);
      return cloneJson(priorById);
    }

    const body = descriptorBody({
      sourceId: record.id,
      sourceHash,
      sourceByteLength: bytes.byteLength,
      sourceRecordHash: sha256(canonicalJson(record)),
      authority,
      retention,
    });
    const descriptor = chainDescriptor(body);
    writeExclusiveOrVerify(
      this.sourceObjectPath(sourceHash), bytes, SourceMutationError,
      `content-addressed source object changed for ${record.id}`,
    );
    writeExclusiveOrVerify(
      this.sourceDescriptorPath(sourceHash), `${canonicalJson(descriptor)}\n`, SourceMutationError,
      `immutable source descriptor changed for ${record.id}`,
    );
    this.descriptorsById.set(record.id, descriptor);
    return cloneJson(descriptor);
  }

  listSourceDescriptors() {
    if (!fs.existsSync(this.sourceDescriptorsRoot)) return [];
    const descriptors = fs.readdirSync(this.sourceDescriptorsRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => {
        const descriptor = JSON.parse(fs.readFileSync(path.join(this.sourceDescriptorsRoot, entry.name), "utf8"));
        verifyDescriptor(descriptor);
        if (entry.name !== `${descriptor.sourceHash}.json`) {
          throw new SourceViewIntegrityError(`source descriptor filename does not match hash: ${entry.name}`);
        }
        return descriptor;
      });
    this.descriptorsById = new Map(descriptors.map((item) => [item.sourceId, item]));
    return descriptors;
  }

  hydrateSource(sourceHash) {
    const hash = requireSourceHash(sourceHash);
    let descriptor;
    try {
      descriptor = JSON.parse(fs.readFileSync(this.sourceDescriptorPath(hash), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") throw new SourceViewIntegrityError(`source descriptor is missing: ${hash}`);
      throw error;
    }
    verifyDescriptor(descriptor);
    if (descriptor.sourceHash !== hash) throw new SourceViewIntegrityError("source descriptor address mismatch");
    const bytes = fs.readFileSync(this.sourceObjectPath(hash));
    if (bytes.byteLength !== descriptor.sourceByteLength || sha256(bytes) !== hash) {
      throw new SourceMutationError(`immutable source bytes failed verification for ${descriptor.sourceId}`);
    }
    const parsed = parseSourceBytes(bytes);
    if (parsed.record.id !== descriptor.sourceId) throw new SourceMutationError("source id changed inside immutable bytes");
    if (sha256(canonicalJson(parsed.record)) !== descriptor.sourceRecordHash) {
      throw new SourceMutationError("source JSON changed relative to its immutable descriptor");
    }
    return { bytes, record: parsed.record, descriptor: cloneJson(descriptor) };
  }

  sourceSnapshot() {
    return snapshotFiles(this.sourcesRoot);
  }

  projectionSnapshot() {
    return snapshotFiles(this.projectionsRoot);
  }

  storeSnapshot() {
    return snapshotFiles(this.root);
  }

  createProjection(sourceHash, transformVersion, { authority = null } = {}) {
    const hydrated = this.hydrateSource(sourceHash);
    const projection = makeProjection(
      hydrated.record,
      hydrated.descriptor,
      transformVersion,
      authority == null ? hydrated.descriptor.authority : authority,
    );
    validateProjection(projection, { descriptor: hydrated.descriptor, sourceRecord: hydrated.record });
    return projection;
  }

  migrateProjection(projection, targetTransformVersion) {
    const migrated = migrateProjection(projection, targetTransformVersion);
    const hydrated = this.hydrateSource(migrated.source.sourceHash);
    validateProjection(migrated, { descriptor: hydrated.descriptor, sourceRecord: hydrated.record });
    return migrated;
  }

  writeProjection(projection) {
    const hydrated = this.hydrateSource(projection?.source?.sourceHash);
    validateProjection(projection, { descriptor: hydrated.descriptor, sourceRecord: hydrated.record });
    return this.#writeVerifiedProjection(projection);
  }

  #writeVerifiedProjection(projection) {
    const file = this.projectionPath(projection.source.sourceHash, projection.transformVersion);
    writeExclusiveOrVerify(
      file, `${canonicalJson(projection)}\n`, DerivedViewConflictError,
      `versioned projection conflicts with ${projection.source.sourceId}@${projection.transformVersion}`,
    );
    return file;
  }

  readProjection(sourceHash, transformVersion) {
    const projection = JSON.parse(fs.readFileSync(this.projectionPath(sourceHash, transformVersion), "utf8"));
    const hydrated = this.hydrateSource(sourceHash);
    validateProjection(projection, { descriptor: hydrated.descriptor, sourceRecord: hydrated.record });
    return projection;
  }

  rebuildDerivedIndex({
    transformVersionForSource = () => TRANSFORM_N,
    writeProjections = true,
  } = {}) {
    if (typeof transformVersionForSource !== "function") throw new TypeError("transformVersionForSource must be a function");
    const entries = [];
    const descriptors = this.listSourceDescriptors();
    for (const descriptor of descriptors) {
      const hydrated = this.hydrateSource(descriptor.sourceHash);
      const transformVersion = requireTransformVersion(transformVersionForSource(
        cloneJson(descriptor), cloneJson(hydrated.record),
      ));
      const projection = makeProjection(hydrated.record, descriptor, transformVersion);
      validateProjection(projection, { descriptor, sourceRecord: hydrated.record });
      if (writeProjections) this.#writeVerifiedProjection(projection);
      entries.push(indexEntry(projection, descriptor));
    }
    const body = indexBody(entries);
    const index = { ...body, indexHash: sha256(canonicalJson(body)) };
    atomicWrite(this.indexPath, `${canonicalJson(index)}\n`);
    return {
      index,
      evidence: {
        sourceRecordsHydrated: descriptors.length,
        indexEntriesBuiltFromSource: entries.length,
        indexEntriesReadFromProjectionFiles: 0,
        projectionFilesWritten: writeProjections ? entries.length : 0,
      },
    };
  }

  verifyDerivedIndex(index) {
    if (!index || index.schema !== DERIVED_INDEX_SCHEMA) throw new SourceViewIntegrityError("derived index schema mismatch");
    const { indexHash, ...body } = index;
    if (indexHash !== sha256(canonicalJson(body))) throw new SourceViewIntegrityError("derived index hash mismatch");
    if (index.builtFrom !== "immutable-source-bytes" || index.recordCount !== index.entries?.length) {
      throw new SourceViewIntegrityError("derived index source or record count is invalid");
    }
    const descriptors = this.listSourceDescriptors();
    if (descriptors.length !== index.entries.length) throw new SourceViewIntegrityError("derived index does not cover every source");
    const seen = new Set();
    for (const entry of index.entries) {
      if (seen.has(entry.sourceId)) throw new SourceViewIntegrityError(`duplicate derived index id: ${entry.sourceId}`);
      seen.add(entry.sourceId);
      const descriptor = descriptors.find((item) => item.sourceId === entry.sourceId);
      if (!descriptor || descriptor.sourceHash !== entry.sourceHash) {
        throw new SourceViewIntegrityError(`derived index source binding mismatch for ${entry.sourceId}`);
      }
      const hydrated = this.hydrateSource(entry.sourceHash);
      const expectedProjection = makeProjection(hydrated.record, descriptor, entry.transformVersion, entry.authority);
      const expectedEntry = indexEntry(expectedProjection, descriptor);
      if (!jsonEqual(entry, expectedEntry)) {
        throw new SourceViewIntegrityError(`derived index entry is not reproducible from source: ${entry.sourceId}`);
      }
    }
    return { ok: true, records: index.entries.length, indexHash };
  }

  readDerivedIndex() {
    let index;
    try {
      index = JSON.parse(fs.readFileSync(this.indexPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") throw new SourceViewIntegrityError("derived index is missing and must be rebuilt from source");
      throw error;
    }
    this.verifyDerivedIndex(index);
    return index;
  }

  deleteDerivedIndex() {
    const sourceBefore = this.sourceSnapshot();
    const projectionsBefore = this.projectionSnapshot();
    if (!fs.existsSync(this.indexPath)) throw new SourceViewIntegrityError("derived index does not exist");
    fs.unlinkSync(this.indexPath);
    const sourceAfter = this.sourceSnapshot();
    const projectionsAfter = this.projectionSnapshot();
    if (sourceBefore.snapshotHash !== sourceAfter.snapshotHash) {
      throw new SourceMutationError("source changed while deleting derived index");
    }
    if (projectionsBefore.snapshotHash !== projectionsAfter.snapshotHash) {
      throw new DerivedViewConflictError("a projection changed while deleting only the derived index");
    }
    return {
      deleted: true,
      relativePath: "derived/index.json",
      sourceSnapshotHash: sourceAfter.snapshotHash,
      projectionSnapshotHash: projectionsAfter.snapshotHash,
    };
  }

  hydrateEvidence(pointer, access) {
    if (!pointer || typeof pointer !== "object") throw new SourceViewIntegrityError("evidence pointer is required");
    const hydrated = this.hydrateSource(pointer.sourceHash);
    const expected = evidencePointer(hydrated.descriptor);
    if (!jsonEqual(pointer, expected)) throw new SourceViewIntegrityError("evidence pointer does not match immutable source");
    if (!isAccessAuthorized(hydrated.descriptor.authority, access)) {
      throw new SourceViewAuthorizationError(`access is not authorized for ${hydrated.descriptor.sourceId}`);
    }
    return hydrated;
  }

  #resultForEntry(entry, access) {
    if (!isAccessAuthorized(entry.authority, access)) {
      throw new SourceViewAuthorizationError(`projection access is not authorized for ${entry.sourceId}`);
    }
    const hydrated = this.hydrateEvidence(entry.evidencePointer, access);
    if (!Object.hasOwn(hydrated.record, "acceptedAnswer")) {
      throw new SourceViewIntegrityError(`accepted answer is missing from exact source: ${entry.sourceId}`);
    }
    return {
      sourceId: entry.sourceId,
      acceptedAnswer: cloneJson(hydrated.record.acceptedAnswer),
      authorization: "authorized",
      evidencePointers: [cloneJson(entry.evidencePointer)],
      projectionBinding: {
        sourceHash: entry.sourceHash,
        transformVersion: entry.transformVersion,
        projectionHash: entry.projectionHash,
      },
    };
  }

  #queryExact(index, sourceId, access) {
    const entry = index.entries.find((item) => item.sourceId === sourceId);
    if (!entry) return null;
    return this.#resultForEntry(entry, access);
  }

  #querySemantic(index, query, access, limit) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("semantic query limit must be a positive integer");
    const queryTerms = tokenize(query);
    if (queryTerms.length === 0) return [];
    return index.entries
      .filter((entry) => isAccessAuthorized(entry.authority, access))
      .map((entry) => ({ entry, score: semanticScore(entry, queryTerms) }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score || left.entry.sourceId.localeCompare(right.entry.sourceId))
      .slice(0, limit)
      .map(({ entry, score }) => ({ ...this.#resultForEntry(entry, access), score }));
  }

  queryExactId(sourceId, access) {
    return this.#queryExact(this.readDerivedIndex(), sourceId, access);
  }

  querySemantic(query, access, { limit = 5 } = {}) {
    return this.#querySemantic(this.readDerivedIndex(), query, access, limit);
  }

  queryWorkbenchCandidates(query, access, { limit = 12 } = {}) {
    return this.querySemantic(query, access, { limit }).map((result) => {
      const pointer = result.evidencePointers[0];
      const hydrated = this.hydrateEvidence(pointer, access);
      const record = hydrated.record;
      const metadata = workbenchMetadata(record);
      const accepted = answerText(record.acceptedAnswer);
      const semanticValue = metadata.semantic_score ?? record.semanticScore;
      const authorityValue = metadata.authority_score ?? record.authorityScore;
      const claim = metadata.claim ?? record.claim ?? accepted;
      const content = [record.title, record.body, accepted]
        .filter((value) => typeof value === "string" && value.trim())
        .join("\n");
      return {
        id: result.sourceId,
        content,
        project: metadata.project ?? record.project ?? null,
        semantic_score: semanticValue == null ? undefined : score01(semanticValue, 0),
        semantic_provider: metadata.semantic_provider ?? record.semanticProvider ?? null,
        authority_score: authorityValue == null ? undefined : score01(authorityValue, 0.5),
        authority_basis: metadata.authority_basis ?? record.evidenceType ?? "immutable-source",
        observed_at: metadata.observed_at ?? record.observedAt ?? record.updatedAt ?? null,
        claim_key: metadata.claim_key ?? record.claimKey ?? null,
        claim: claim === '' ? content : claim,
        supersedes: Array.isArray(metadata.supersedes ?? record.supersedes)
          ? [...(metadata.supersedes ?? record.supersedes)].map(String)
          : [],
        source: {
          kind: pointer.kind,
          path: path.join(this.root, pointer.relativePath),
          sha256: pointer.sourceHash,
          offset: pointer.byteRange.start,
          bytes: pointer.byteRange.endExclusive - pointer.byteRange.start,
          source_id: pointer.sourceId,
          json_pointer: pointer.jsonPointer,
          authority_hash: pointer.authorityHash,
          retention_hash: pointer.retentionHash,
          authorized: true,
          verified: true,
        },
        retrieval: {
          provider: "source-view-store",
          lexical_frequency: result.score,
          projection: result.projectionBinding,
        },
      };
    });
  }

  replayFrozenQueries({ exact = [], semantic = [] }, access) {
    assertJsonValue(exact);
    assertJsonValue(semantic);
    const index = this.readDerivedIndex();
    const exactResults = exact.map((query) => ({
      queryId: query.queryId,
      expectedSourceId: query.expectedSourceId,
      result: this.#queryExact(index, query.sourceId, access),
    }));
    const semanticResults = semantic.map((query) => ({
      queryId: query.queryId,
      expectedSourceId: query.expectedSourceId,
      results: this.#querySemantic(index, query.text, access, query.limit ?? 1),
    }));
    return {
      querySetHash: sha256(canonicalJson({ exact, semantic })),
      exact: exactResults,
      semantic: semanticResults,
    };
  }
}

export const __sourceViewInternals = Object.freeze({
  evidencePointer,
  indexEntry,
  parseSourceBytes,
  projectionRecord,
  projectionSearch,
  searchRepresentation,
  snapshotFiles,
});
