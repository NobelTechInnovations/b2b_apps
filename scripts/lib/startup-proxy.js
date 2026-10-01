import http from 'node:http';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function forwardedHeaders(headers) {
  const excluded = new Set(HOP_BY_HOP);
  for (const name of (headers.connection ?? '').split(',')) excluded.add(name.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.has(name.toLowerCase())));
}

/** The hosting entry process must listen before the service processes finish booting. */
export function createStartupProxy({ gatewayPort }) {
  const server = http.createServer((request, response) => {
    const upstream = http.request({
      hostname: '127.0.0.1',
      port: gatewayPort,
      method: request.method,
      path: request.url,
      headers: forwardedHeaders(request.headers),
    }, (incoming) => {
      response.writeHead(incoming.statusCode, forwardedHeaders(incoming.headers));
      incoming.on('error', () => response.destroy());
      response.on('close', () => incoming.destroy());
      incoming.pipe(response);
    });

    upstream.on('error', () => {
      if (response.destroyed) return;
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(503, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'retry-after': '3',
      });
      response.end(JSON.stringify({
        error: {
          code: 'api_unavailable',
          message: 'The API is starting or unavailable. Please try again shortly.',
        },
      }));
    });
    upstream.setTimeout(120_000, () => upstream.destroy(new Error('Gateway request timed out')));
    request.on('error', () => upstream.destroy());
    request.on('aborted', () => upstream.destroy());
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  });
  return server;
}
