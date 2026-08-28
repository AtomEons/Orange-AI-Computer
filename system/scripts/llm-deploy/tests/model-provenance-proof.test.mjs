import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { parseHuggingFaceResolveUrl, verifyModelProvenance } from '../model-provenance-proof.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

describe('OrangeFive model provenance proof', () => {
  test('parses only immutable Hugging Face resolve URLs', () => {
    expect(parseHuggingFaceResolveUrl(`https://huggingface.co/acme/model/resolve/${'a'.repeat(40)}/weights.bin`)).toEqual({
      repository: 'acme/model', revision: 'a'.repeat(40), file: 'weights.bin',
    });
    expect(() => parseHuggingFaceResolveUrl('https://huggingface.co/acme/model/resolve/main/weights.bin')).toThrow('unpinned');
  });

  test('binds observed artifacts to exact upstream bytes and hashes', async () => {
    const source = Buffer.from('{"source":true}');
    const license = Buffer.from('license text');
    const revision = 'b'.repeat(40);
    const modelSha = 'c'.repeat(64);
    const catalog = {
      schema: 'orange.deploy.model-acquisition-catalog.v1',
      sourceCatalogSha256: sha256(source),
      roles: [{
        role: 'fixture', provenanceStatus: 'verified-local-artifact', license: 'MIT', redistribution: 'upstream-download-only', provenanceBlockers: [],
        evidence: { receipt: 'fixture.json', receiptSha256: 'd'.repeat(64), observedHost: 'CODEXA' },
        observedArtifacts: [{ path: 'model.bin', bytes: 10, sha256: modelSha }],
        acquisition: { repository: 'acme/model', revision, files: [
          { url: `https://huggingface.co/acme/model/resolve/${revision}/model.bin`, relativePath: 'fixture/model.bin', bytes: 10, sha256: modelSha },
          { url: `https://huggingface.co/acme/model/resolve/${revision}/LICENSE`, relativePath: 'fixture/LICENSE', bytes: license.length, sha256: sha256(license) },
        ] },
      }],
    };
    const fetchFn = async (url) => {
      if (String(url).includes('/api/models/')) return new Response(JSON.stringify({ siblings: [
        { rfilename: 'model.bin', size: 10, lfs: { sha256: modelSha } },
        { rfilename: 'LICENSE', size: license.length },
      ] }), { status: 200 });
      return new Response(license, { status: 200 });
    };
    const result = await verifyModelProvenance({ catalog, sourceCatalogBytes: source, fetchFn });
    expect(result.status).toBe('ORANGEFIVE_MODEL_PROVENANCE_GREEN');
    expect(result.roles[0].checks.every_observed_artifact_matches_upstream).toBe(true);
  });
});
