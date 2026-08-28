#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeChainedJsonReceipt } from '../../10-RECEIPTS/tools/json-receipt-chain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CATALOG_PATH = path.join(ROOT, '00-CHARTER', 'LLM-DEPLOY', 'model-acquisition-catalog.json');
const SOURCE_CATALOG_PATH = path.join(ROOT, '14-SUPERSTACK', 'captain-planet-stack.json');
const RECEIPT_ROOT = path.join(ROOT, '10-RECEIPTS', 'orange5-build');

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function parseHuggingFaceResolveUrl(value) {
  const match = String(value || '').match(/^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/([a-f0-9]{40,64})\/(.+)$/i);
  if (!match) throw new Error(`unpinned or unsupported acquisition URL: ${value}`);
  return { repository: match[1], revision: match[2].toLowerCase(), file: decodeURIComponent(match[3]) };
}

export async function verifyModelProvenance({ catalog, sourceCatalogBytes, fetchFn = fetch } = {}) {
  if (!catalog || catalog.schema !== 'orange.deploy.model-acquisition-catalog.v1') throw new Error('invalid acquisition catalog');
  const sourceCatalogSha256 = sha256(sourceCatalogBytes);
  const sourceCatalogBound = sourceCatalogSha256 === catalog.sourceCatalogSha256;
  const roles = [];

  for (const role of catalog.roles || []) {
    if (role.provenanceStatus !== 'verified-local-artifact') continue;
    const files = role.acquisition?.files || [];
    const checks = {
      no_provenance_blockers: Array.isArray(role.provenanceBlockers) && role.provenanceBlockers.length === 0,
      license_declared: typeof role.license === 'string' && role.license.length > 0,
      upstream_download_only: role.redistribution === 'upstream-download-only',
      acquisition_files_present: files.length > 0,
    };
    const remote = [];
    const metadataCache = new Map();

    for (const file of files) {
      const parsed = parseHuggingFaceResolveUrl(file.url);
      const expectedRevision = String(file.sourceRevision || role.acquisition.revision || '').toLowerCase();
      const expectedRepository = String(file.sourceRepository || role.acquisition.repository || '');
      const cacheKey = `${expectedRepository}@${expectedRevision}`;
      if (parsed.repository.toLowerCase() !== expectedRepository.toLowerCase() || parsed.revision !== expectedRevision) {
        remote.push({ relativePath: file.relativePath, ok: false, reason: 'source binding mismatch' });
        continue;
      }
      if (!metadataCache.has(cacheKey)) {
        const response = await fetchFn(`https://huggingface.co/api/models/${expectedRepository}/revision/${expectedRevision}?blobs=true`, {
          headers: { accept: 'application/json', 'user-agent': 'OrangeFive-Provenance/1.0' },
        });
        if (!response.ok) throw new Error(`metadata fetch failed for ${cacheKey}: HTTP ${response.status}`);
        metadataCache.set(cacheKey, await response.json());
      }
      const metadata = metadataCache.get(cacheKey);
      const sibling = (metadata.siblings || []).find((item) => item.rfilename === parsed.file);
      if (!sibling) {
        remote.push({ relativePath: file.relativePath, repository: expectedRepository, revision: expectedRevision, ok: false, reason: 'file absent at pinned revision' });
        continue;
      }
      let remoteBytes = Number(sibling.size || 0);
      let remoteSha256 = String(sibling.lfs?.sha256 || '').toLowerCase();
      if (!remoteSha256) {
        const response = await fetchFn(file.url, { headers: { 'user-agent': 'OrangeFive-Provenance/1.0' } });
        if (!response.ok) throw new Error(`artifact fetch failed for ${file.relativePath}: HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        remoteBytes = bytes.length;
        remoteSha256 = sha256(bytes);
      }
      remote.push({
        relativePath: file.relativePath,
        repository: expectedRepository,
        revision: expectedRevision,
        upstreamFile: parsed.file,
        expectedBytes: file.bytes,
        remoteBytes,
        expectedSha256: String(file.sha256 || '').toLowerCase(),
        remoteSha256,
        ok: remoteBytes === file.bytes && remoteSha256 === String(file.sha256 || '').toLowerCase(),
      });
    }

    const acquisitionIdentities = new Set(files.map((file) => `${file.bytes}:${String(file.sha256 || '').toLowerCase()}`));
    const observed = (role.observedArtifacts || []).map((artifact) => ({
      path: artifact.path,
      bytes: artifact.bytes,
      sha256: String(artifact.sha256 || '').toLowerCase(),
      upstreamMatched: acquisitionIdentities.has(`${artifact.bytes}:${String(artifact.sha256 || '').toLowerCase()}`),
    }));
    checks.local_evidence_receipt_bound = typeof role.evidence?.receipt === 'string'
      && /^[a-f0-9]{64}$/i.test(String(role.evidence?.receiptSha256 || ''))
      && typeof role.evidence?.observedHost === 'string';
    checks.every_remote_file_matches = remote.length === files.length && remote.every((item) => item.ok);
    checks.every_observed_artifact_matches_upstream = observed.length > 0
      ? observed.every((item) => item.upstreamMatched)
      : checks.local_evidence_receipt_bound;
    roles.push({ role: role.role, ok: Object.values(checks).every(Boolean), checks, remote, observed });
  }

  const ok = sourceCatalogBound && roles.length > 0 && roles.every((role) => role.ok);
  return {
    schema: 'orangefive.model-provenance-proof.v1',
    status: ok ? 'ORANGEFIVE_MODEL_PROVENANCE_GREEN' : 'ORANGEFIVE_MODEL_PROVENANCE_NEEDS_WORK',
    generated_at: new Date().toISOString(),
    ok,
    source_catalog_bound: sourceCatalogBound,
    source_catalog_sha256: sourceCatalogSha256,
    verified_role_count: roles.length,
    roles,
    policy: {
      model_weights_in_payload: false,
      acquisition: 'pinned-upstream-download-only',
      studio_quality_claimed: false,
    },
  };
}

async function main() {
  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const proof = await verifyModelProvenance({ catalog, sourceCatalogBytes: fs.readFileSync(SOURCE_CATALOG_PATH) });
  const stamp = proof.generated_at.replace(/[:.]/g, '-');
  const receiptPath = path.join(RECEIPT_ROOT, `${stamp}-model-provenance-proof.json`);
  const written = writeChainedJsonReceipt(receiptPath, proof);
  process.stdout.write(`${JSON.stringify({ status: written.status, ok: written.ok, verified_roles: written.verified_role_count, receipt_path: receiptPath, receipt_sha256: written.receipt_sha256 }, null, 2)}\n`);
  if (!proof.ok) process.exitCode = 1;
}

if (import.meta.main) main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ status: 'ORANGEFIVE_MODEL_PROVENANCE_FAILED', error: error.message }, null, 2)}\n`);
  process.exitCode = 1;
});
