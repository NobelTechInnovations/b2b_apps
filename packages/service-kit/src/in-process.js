/**
 * Services talking to each other without network ports.
 *
 * Some hosts (Hostinger's managed Node.js) let an app open exactly one port,
 * and loopback connections between its own servers are refused. When every
 * service runs in one process there, NEXUS_IN_PROCESS=1 makes them call each
 * other in memory instead: a request to http://localhost:<service port> is
 * handed to that service's Fastify app with inject(), the same code path a
 * real request takes. Everything else (fetches to the outside world) is
 * untouched.
 */
const apps = new Map();
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'content-length']);

export const inProcess = () => process.env.NEXUS_IN_PROCESS === '1';

export function registerLocalApp(port, app) {
  apps.set(Number(port), app);
}

/** The in-process app a URL points at, or null. */
export function localApp(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'http:' || !LOCAL.has(parsed.hostname)) return null;
  return apps.get(Number(parsed.port || 80)) ?? null;
}

/** Headers from inject() as a Fetch Headers object, without hop-by-hop ones. */
function responseHeaders(raw) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
    for (const one of [].concat(value)) headers.append(name, String(one));
  }
  return headers;
}

/** fetch(), but calls to an in-process service never touch the network. */
export function installLocalFetch() {
  if (globalThis.__nexusLocalFetch) return;
  const realFetch = globalThis.fetch;
  globalThis.__nexusLocalFetch = true;
  globalThis.fetch = async function localFetch(input, init) {
    const target = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    const app = target ? localApp(target) : null;
    if (!app) return realFetch(input, init);
    const request = new Request(input, init);
    const url = new URL(request.url);
    const payload = ['GET', 'HEAD'].includes(request.method) ? undefined : Buffer.from(await request.arrayBuffer());
    const response = await app.inject({
      method: request.method,
      url: url.pathname + url.search,
      headers: Object.fromEntries(request.headers),
      ...(payload?.length ? { payload } : {}),
    });
    const empty = request.method === 'HEAD' || [204, 205, 304].includes(response.statusCode);
    return new Response(empty ? null : response.rawPayload, { status: response.statusCode, headers: responseHeaders(response.headers) });
  };
}

/**
 * Forward a gateway request to an in-process service and send its answer.
 * Returns false when the target is not in this process (use the network).
 */
export async function forwardLocal(request, reply, url, headers) {
  const app = localApp(url);
  if (!app) return false;
  const parsed = new URL(url);
  const forwarded = { ...headers };
  delete forwarded.host;
  delete forwarded.connection;
  const hasBody = request.body !== undefined && request.body !== null && !['GET', 'HEAD'].includes(request.method);
  let response;
  try {
    response = await app.inject({
      method: request.method,
      url: parsed.pathname + parsed.search,
      headers: forwarded,
      ...(hasBody ? { payload: request.body } : {}),
      remoteAddress: request.ip,
    });
  } catch (error) {
    request.log.error({ err: error, url: parsed.pathname }, 'in-process request failed');
    reply.code(502).send({ error: { code: 'upstream_unavailable', message: 'That service is temporarily unavailable.', request_id: request.id } });
    return true;
  }
  reply.code(response.statusCode);
  for (const [name, value] of Object.entries(response.headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name.toLowerCase())) reply.header(name, value);
  }
  reply.send(response.rawPayload);
  return true;
}
