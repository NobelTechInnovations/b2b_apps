import replyFrom from '@fastify/reply-from';
import rateLimit from '@fastify/rate-limit';
import { createService, startService } from '@nexus/service-kit';
import { createBus } from '@nexus/bus';
import { config } from './config.js';
import { buildRoutingTable, resolveUpstreams } from './lib/routing.js';
import { createAuthz } from './lib/authz.js';
import { proxyRoutes } from './routes/proxy.js';
import { workspaceRoutes } from './routes/workspace.js';

const NAME = 'gateway';

const app = await createService({ name: NAME, config, publicService: true });

app.decorate('routingTable', buildRoutingTable());
app.decorate('upstreams', resolveUpstreams());

const authz = createAuthz({
  tenancyUrl: config.tenancyUrl,
  billingUrl: config.billingUrl,
  serviceToken: config.serviceToken,
  logger: app.log,
});
app.decorate('authz', authz);

await app.register(replyFrom, {
  undici: { connections: 128, pipelining: 1, keepAliveTimeout: 60_000 },
});

// The gateway forwards bodies untouched. Parsing them here would double the
// memory cost, re-serialize payloads the upstream already understands, and
// reject legitimate requests such as a POST with no body at all.
app.removeAllContentTypeParsers();
app.addContentTypeParser('*', (request, payload, done) => done(null, payload));

// Per-user when we know who they are, per-IP otherwise.
await app.register(rateLimit, {
  max: config.rateLimitMax,
  timeWindow: '1 minute',
  keyGenerator: (request) => request.auth?.userId ?? request.ip,
  errorResponseBuilder: (request, context) => ({
    error: {
      code: 'rate_limited',
      message: `Too many requests. Try again in ${Math.ceil(context.ttl / 1000)}s.`,
      request_id: request.id,
    },
  }),
});

await app.register(workspaceRoutes);
await app.register(proxyRoutes);

app.get('/', async () => ({
  service: 'nexus-gateway',
  status: 'ok',
  namespaces: [...app.routingTable.keys()].sort(),
}));

// Entitlement and permission changes reach the cache in milliseconds.
const bus = await createBus({ servers: config.natsUrl, name: NAME }).catch((error) => {
  app.log.warn({ err: error }, 'event bus unavailable — authorization cache will rely on TTL only');
  return null;
});

if (bus) {
  app.decorate('bus', bus);
  for (const pattern of [
    'billing.entitlements.changed',
    'tenancy.member.*',
    'tenancy.role.*',
    'catalog.app.*',
  ]) {
    await bus.subscribe(NAME, pattern, async (event) => {
      if (event.org_id) authz.invalidate(event.org_id);
    });
  }
}

app.get('/internal/cache-stats', { logLevel: 'silent' }, async () => authz.stats());

await startService(app, { port: config.port, name: NAME });
