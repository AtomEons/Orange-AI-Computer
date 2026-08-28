// 01-gguf-integrity.mjs — verify the Mamba 2.8B Q5_K_M GGUF on disk:
//   (a) file exists, is regular, non-zero size
//   (b) first 4 bytes are the GGUF magic ('GGUF')
//   (c) SHA-256 matches AE_COBRA_MODEL_SHA256 (when provided)
//
// Local on N150 only meaningful if you've mirrored the GGUF locally. By default
// the model lives on Codexa at /opt/atomeons/ae-cobra/models/...; if that path
// isn't reachable from where this gate runs, we honestly return pass:null with a
// remote_recipe instead of fake-greening.

import { run, defaultEnv, detectHost, remoteOnly, now, ms } from './_lib.mjs';
import { createHash } from 'node:crypto';
import { stat, open } from 'node:fs/promises';

const GATE = '01-gguf-integrity';
const GGUF_MAGIC = Buffer.from('GGUF', 'ascii'); // 0x47 0x47 0x55 0x46

export async function check(env = {}, opts = {}) {
  const E = { ...defaultEnv(), ...env };
  return run(GATE, E, opts, async () => {
    const path = opts.model_path || E.model_path;
    const expectedSha = opts.expected_sha256 || E.model_sha256_expected;

    // Exists?
    let st;
    try {
      st = await stat(path);
    } catch {
      // If we're on N150 and the file is on Codexa, this is the honest gap.
      const host = await detectHost(E);
      if (host !== 'codexa-wsl2') {
        return remoteOnly(GATE,
`# On Codexa WSL2:
sha256sum ${path}
# Expected: ${expectedSha || '<set AE_COBRA_MODEL_SHA256>'}`,
          { model_path: path, expected_sha256: expectedSha });
      }
      return { pass: false, details: { reason: 'model file missing', model_path: path } };
    }

    if (!st.isFile() || st.size === 0) {
      return { pass: false, details: { reason: 'not a regular file or empty', model_path: path, size: st.size } };
    }

    // Magic bytes
    const fh = await open(path, 'r');
    let magic;
    try {
      magic = Buffer.alloc(4);
      await fh.read(magic, 0, 4, 0);
    } finally {
      await fh.close();
    }
    if (!magic.equals(GGUF_MAGIC)) {
      return { pass: false, details: { reason: 'GGUF magic mismatch', got_hex: magic.toString('hex'), model_path: path } };
    }

    // SHA-256 (streamed)
    const t0 = now();
    const hash = createHash('sha256');
    const fh2 = await open(path, 'r');
    try {
      const buf = Buffer.alloc(1024 * 1024);
      let pos = 0;
      while (true) {
        const { bytesRead } = await fh2.read(buf, 0, buf.length, pos);
        if (bytesRead === 0) break;
        hash.update(buf.subarray(0, bytesRead));
        pos += bytesRead;
      }
    } finally {
      await fh2.close();
    }
    const sha = hash.digest('hex');
    const hash_ms = ms(t0);

    if (!expectedSha) {
      // We can't certify identity without a baseline. Honest: not green, but not red either.
      return {
        pass: null,
        details: {
          reason: 'no expected SHA-256 baseline configured — cannot certify identity',
          model_path: path,
          observed_sha256: sha,
          size_bytes: st.size,
          hash_ms,
          remote_recipe: `export AE_COBRA_MODEL_SHA256=${sha}  # set this once you trust the artifact`,
        },
      };
    }

    const match = sha.toLowerCase() === String(expectedSha).toLowerCase();
    return {
      pass: match,
      details: {
        reason: match ? 'sha256 matches' : 'sha256 mismatch',
        model_path: path,
        size_bytes: st.size,
        observed_sha256: sha,
        expected_sha256: expectedSha,
        hash_ms,
      },
    };
  });
}
