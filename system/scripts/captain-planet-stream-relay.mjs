import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const file = path.resolve(process.env.ORANGE5_RELAY_FILE || '');
const name = path.basename(file);
const port = Number(process.env.ORANGE5_RELAY_PORT || 8768);
const token = String(process.env.ORANGE5_RELAY_TOKEN || 'orange5-direct-cat8');
const stat = fs.statSync(file);

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (url.pathname === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, file: name, bytes: stat.size }));
    return;
  }
  if (url.pathname !== `/files/${encodeURIComponent(name)}` || url.searchParams.get('token') !== token) {
    response.writeHead(404).end('not found');
    return;
  }
  const match = /^bytes=(\d+)-$/i.exec(request.headers.range || '');
  const start = match ? Number(match[1]) : 0;
  if (!Number.isSafeInteger(start) || start < 0 || start >= stat.size) {
    response.writeHead(416, { 'content-range': `bytes */${stat.size}` }).end();
    return;
  }
  response.writeHead(start ? 206 : 200, {
    'content-type': 'application/octet-stream',
    'content-length': stat.size - start,
    'content-range': `bytes ${start}-${stat.size - 1}/${stat.size}`,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  });
  const stream = fs.createReadStream(file, { start, highWaterMark: 1024 * 1024 });
  stream.on('error', (error) => response.destroy(error));
  request.on('close', () => stream.destroy());
  stream.pipe(response);
});

server.keepAliveTimeout = 0;
server.headersTimeout = 0;
server.requestTimeout = 0;
server.listen(port, '0.0.0.0', () => {
  process.stdout.write(`${JSON.stringify({ status: 'ORANGE5_STREAM_RELAY_READY', port, file: name, bytes: stat.size })}\n`);
});
