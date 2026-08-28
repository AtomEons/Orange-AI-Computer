// AE OrangeLLM — AtomSmasher AIR Codec gateway routes
// Path: 06-ORANGELLM/server/routes/atomsmasher-air.mjs
//
// Doctrine:
//   - The AIR (Anti-Inflation Recursive) codec is the only sanctioned path
//     between verbose model prose and the structured AtomSmasher pipeline.
//     Downstream modules (Commitment Atoms, EquationStore, Compression Debt
//     Ledger, Pathwave Compressor) consume frames, not prose.
//   - Compression is lossy by design. The codec drops fluff/hedge/pleasantry/
//     self-reference/transition characters and lifts facts/claims/citations/
//     numbers/dates/identifiers/code/decisions/questions into typed slots.
//     Mom's Law: report what was dropped, don't pretend nothing was lost.
//   - frame_id is content-derived; identical input yields identical frame_id.
//     This lets the Compression Debt Ledger dedupe by frame_id and lets
//     callers detect when they're recompressing the same input twice.
//   - Decompression reconstructs a READABLE rendition; it is NOT byte-
//     identical to source. Receipts hash the frame, never the rendered prose.
//
// Routes registered (all under /v1/atomsmasher/air):
//   POST /v1/atomsmasher/air/compress
//        body: { input: string }
//        -> 200 { frame, summary, generated_at }
//
//   POST /v1/atomsmasher/air/decompress
//        body: { frame: <air-frame.v0> }
//        -> 200 { prose, frame_id, generated_at }
//
//   POST /v1/atomsmasher/air/validate
//        body: { frame: <air-frame.v0> }
//        -> 200 { valid, errors }
//
// Boundary note: these paths must also be added to the gateway allow-list
// (06-ORANGELLM/server/routes/atomsmasher-boundary.mjs) before they are
// reachable from outside.

import { URL } from 'node:url';

import {
  compress as airCompress,
  decompress as airDecompress,
  validate as airValidate,
} from '../../../12-ATOMSMASHER/air-codec/codec.mjs';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const MAX_INPUT_BYTES = 2 * 1024 * 1024;  // 2 MiB input cap
const MAX_BODY_BYTES = 4 * 1024 * 1024;   // 4 MiB total body cap (frame in/out)
const PATH_PREFIX = '/v1/atomsmasher/air';

// ---------------------------------------------------------------------------
// HTTP helpers (mirror atomsmasher.mjs conventions)
// ---------------------------------------------------------------------------

function jsonResponse(res, body, status = 200) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function errorResponse(res, message, status = 400, code = 'invalid_request_error', extra = {}) {
  jsonResponse(
    res,
    {
      error: {
        message,
        type: code,
        code: status,
        ...extra,
      },
    },
    status,
  );
}

async function readJsonBody(req, capBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > capBytes) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (!buf.length) return resolve({});
      try {
        resolve(JSON.parse(buf.toString('utf8')));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

function matchRoute(method, pathName) {
  if (!pathName.startsWith(PATH_PREFIX)) return null;
  const rest = pathName.slice(PATH_PREFIX.length);
  if (rest === '/compress') {
    if (method === 'POST') return { name: 'compress' };
    return { name: 'method_not_allowed', allowed: ['POST'] };
  }
  if (rest === '/decompress') {
    if (method === 'POST') return { name: 'decompress' };
    return { name: 'method_not_allowed', allowed: ['POST'] };
  }
  if (rest === '/validate') {
    if (method === 'POST') return { name: 'validate' };
    return { name: 'method_not_allowed', allowed: ['POST'] };
  }
  return { name: 'not_found' };
}

// ---------------------------------------------------------------------------
// Summary helper — surfaces the honest "what just happened" line per Mom's Law.
// ---------------------------------------------------------------------------

function buildSummary(frame) {
  const proseChars =
    frame.facts.join('').length +
    frame.claims.map((c) => c.text).join('').length +
    frame.decisions.join('').length +
    frame.questions.join('').length +
    frame.residue.join('').length;
  const droppedChars = frame.dropped.reduce((acc, d) => acc + d.chars, 0);
  return {
    original_chars: frame.original_chars,
    prose_chars_preserved: proseChars,
    filler_chars_dropped: droppedChars,
    filler_ratio: frame.original_chars === 0 ? 0 : droppedChars / frame.original_chars,
    wire_frame_chars: frame.compressed_chars,
    envelope_inflation: frame.compression_ratio,
    extracted: {
      facts: frame.facts.length,
      claims: frame.claims.length,
      citations: frame.citations.length,
      numbers: frame.numbers.length,
      dates: frame.dates.length,
      identifiers: frame.identifiers.length,
      code_spans: frame.code_spans.length,
      decisions: frame.decisions.length,
      questions: frame.questions.length,
      residue: frame.residue.length,
    },
    dropped_by_tag: Object.fromEntries(frame.dropped.map((d) => [d.tag, d.chars])),
  };
}

// ---------------------------------------------------------------------------
// Handlers — accept already-parsed input, return {status, body}
// ---------------------------------------------------------------------------

async function handleCompress(rawBody, cfg) {
  const src = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody) ? rawBody : null;
  if (!src) {
    return {
      status: 400,
      body: {
        error: {
          message: 'request body must be a JSON object with an "input" string',
          type: 'invalid_request_error',
          code: 400,
        },
      },
    };
  }

  const { input } = src;
  if (typeof input !== 'string') {
    return {
      status: 400,
      body: {
        error: {
          message: '"input" must be a string',
          type: 'invalid_request_error',
          code: 400,
        },
      },
    };
  }
  // Use Buffer.byteLength for honest UTF-8 byte cap rather than string length.
  if (Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) {
    return {
      status: 413,
      body: {
        error: {
          message: `input exceeds ${MAX_INPUT_BYTES} bytes; chunk before compressing`,
          type: 'input_too_large',
          code: 413,
        },
      },
    };
  }

  let frame;
  try {
    frame = airCompress(input);
  } catch (err) {
    cfg.log(`[air] compress failed: ${err.message}`);
    return {
      status: 500,
      body: {
        error: {
          message: `air compress failed: ${err.message}`,
          type: 'air_internal_error',
          code: 500,
        },
      },
    };
  }

  // Defence-in-depth: revalidate the frame we just produced.
  const v = airValidate(frame);
  if (!v.valid) {
    return {
      status: 500,
      body: {
        error: {
          message: 'codec produced a frame that fails its own validator',
          type: 'air_internal_error',
          code: 500,
          errors: v.errors,
        },
      },
    };
  }

  return {
    status: 200,
    body: {
      frame,
      summary: buildSummary(frame),
      generated_at: nowIso(),
    },
  };
}

async function handleDecompress(rawBody, cfg) {
  const src = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody) ? rawBody : null;
  if (!src || !src.frame) {
    return {
      status: 400,
      body: {
        error: {
          message: 'request body must be a JSON object with a "frame" field',
          type: 'invalid_request_error',
          code: 400,
        },
      },
    };
  }

  const v = airValidate(src.frame);
  if (!v.valid) {
    return {
      status: 422,
      body: {
        error: {
          message: 'frame failed schema or integrity validation',
          type: 'frame_validation_error',
          code: 422,
          errors: v.errors,
        },
      },
    };
  }

  let prose;
  try {
    prose = airDecompress(src.frame);
  } catch (err) {
    cfg.log(`[air] decompress failed: ${err.message}`);
    return {
      status: 500,
      body: {
        error: {
          message: `air decompress failed: ${err.message}`,
          type: 'air_internal_error',
          code: 500,
        },
      },
    };
  }

  return {
    status: 200,
    body: {
      prose,
      frame_id: src.frame.frame_id,
      // Honesty: tell the caller this is NOT byte-identical to the source.
      note: 'decompress yields a readable rendition, not the original prose. Receipts MUST hash the frame, not this output.',
      generated_at: nowIso(),
    },
  };
}

async function handleValidate(rawBody) {
  const src = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody) ? rawBody : null;
  if (!src || !src.frame) {
    return {
      status: 400,
      body: {
        error: {
          message: 'request body must be a JSON object with a "frame" field',
          type: 'invalid_request_error',
          code: 400,
        },
      },
    };
  }
  const v = airValidate(src.frame);
  return {
    status: 200,
    body: {
      valid: v.valid,
      errors: v.errors,
      generated_at: nowIso(),
    },
  };
}

// ---------------------------------------------------------------------------
// Public: registerAirCodecRoutes(server, opts)
// ---------------------------------------------------------------------------

export function registerAirCodecRoutes(server, opts = {}) {
  if (!server || typeof server.on !== 'function') {
    throw new TypeError('registerAirCodecRoutes: server must be a node:http Server');
  }

  const cfg = {
    log:
      typeof opts.log === 'function'
        ? opts.log
        : (line) => {
            // eslint-disable-next-line no-console
            console.log(line);
          },
  };

  server.prependListener('request', async (req, res) => {
    if (res.writableEnded) return;

    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      return;
    }
    const method = (req.method || 'GET').toUpperCase();
    const pathName = url.pathname;

    if (!pathName.startsWith(PATH_PREFIX)) return;

    const route = matchRoute(method, pathName);
    if (!route) return;

    if (route.name === 'not_found') {
      return errorResponse(
        res,
        `air route not found: ${method} ${pathName}`,
        404,
        'air_route_not_found',
      );
    }
    if (route.name === 'method_not_allowed') {
      res.setHeader('Allow', route.allowed.join(', '));
      return errorResponse(
        res,
        `method ${method} not allowed on ${pathName}`,
        405,
        'method_not_allowed',
        { allowed: route.allowed },
      );
    }

    try {
      let raw;
      try {
        raw = await readJsonBody(req);
      } catch (err) {
        return errorResponse(res, err.message || 'bad request body', 400, 'invalid_request_body');
      }

      if (route.name === 'compress') {
        const { status, body } = await handleCompress(raw, cfg);
        return jsonResponse(res, body, status);
      }
      if (route.name === 'decompress') {
        const { status, body } = await handleDecompress(raw, cfg);
        return jsonResponse(res, body, status);
      }
      if (route.name === 'validate') {
        const { status, body } = await handleValidate(raw);
        return jsonResponse(res, body, status);
      }

      return errorResponse(res, 'unreachable router state', 500, 'air_internal_error');
    } catch (err) {
      cfg.log(`[air] handler error on ${method} ${pathName}: ${err.message}`);
      return errorResponse(res, err.message || 'air internal error', 500, 'air_internal_error');
    }
  });

  return {
    cfg,
    prefix: PATH_PREFIX,
    routes: [
      { method: 'POST', path: `${PATH_PREFIX}/compress` },
      { method: 'POST', path: `${PATH_PREFIX}/decompress` },
      { method: 'POST', path: `${PATH_PREFIX}/validate` },
    ],
  };
}

// Re-export handlers for direct wiring + unit tests.
export const __airHandlers = {
  handleCompress,
  handleDecompress,
  handleValidate,
  matchRoute,
  buildSummary,
};
