import {
  PARTY_LINE_DETAIL_LEVELS,
  appendPartyLineEvent,
  hydratePartyLine,
  readPartyLine,
} from '../../../04-CONTROL-PLANE/party-line/ledger.mjs';

export const PARTY_LINE_PATH = '/v1/party-line';
export const PARTY_LINE_STREAM_PATH = '/v1/party-line/stream';
export const PARTY_LINE_HYDRATE_PATH = '/v1/party-line/hydrate';

const asString = (value, max = 256) => typeof value === 'string' ? value.slice(0, max) : '';
const asBool = (value, fallback = false) => value == null ? fallback : /^(1|true|yes)$/i.test(String(value));

function queryOptions(url) {
  const detail = asString(url.searchParams.get('detail'));
  return {
    cursor: url.searchParams.has('cursor') ? Number(url.searchParams.get('cursor')) : undefined,
    limit: Number(url.searchParams.get('limit') || 100),
    detail: PARTY_LINE_DETAIL_LEVELS.includes(detail) ? detail : 'normal',
    tail: asBool(url.searchParams.get('tail'), !url.searchParams.has('cursor')),
    filters: {
      projectId: asString(url.searchParams.get('project')) || undefined,
      topic: asString(url.searchParams.get('topic')) || undefined,
      actor: asString(url.searchParams.get('actor')) || undefined,
      eventType: asString(url.searchParams.get('type')) || undefined,
      correlationId: asString(url.searchParams.get('correlation')) || undefined,
    },
  };
}

export async function handlePartyLineGet(url, options = {}) {
  return { status: 200, body: await readPartyLine({ ...queryOptions(url), ...options }) };
}

export async function handlePartyLinePost(body, options = {}) {
  try {
    const written = await appendPartyLineEvent(body, options);
    return {
      status: 201,
      body: {
        schema: 'orange.party-line.append.v1',
        ok: true,
        event: written.event,
        cursor: written.cursor,
      },
    };
  } catch (error) {
    return {
      status: 400,
      body: { error: { code: 'party_line_event_invalid', message: error.message } },
    };
  }
}

export async function handlePartyLineHydrate(body, options = {}) {
  if (!body || typeof body.query !== 'string') {
    return {
      status: 400,
      body: { error: { code: 'party_line_query_required', message: 'query is required' } },
    };
  }
  return {
    status: 200,
    body: await hydratePartyLine({
      query: body.query,
      projectId: asString(body.projectId) || undefined,
      limit: body.limit,
      ...options,
    }),
  };
}

export function handlePartyLineStream(req, res, url) {
  const options = queryOptions(url);
  let cursor = options.cursor;
  let closed = false;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': orange-party-line\n\n');

  const pump = async () => {
    if (closed) return;
    try {
      const page = await readPartyLine({ ...options, cursor, tail: cursor == null });
      cursor = page.cursor;
      for (const event of page.events) {
        res.write(`id: ${event.id}\n`);
        res.write('event: party-line\n');
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (error) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: error.message })}\n\n`);
    }
  };

  void pump();
  const timer = setInterval(() => void pump(), 1_250);
  req.on('close', () => {
    closed = true;
    clearInterval(timer);
  });
}
