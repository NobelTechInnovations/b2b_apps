import path from 'node:path';
import { fileURLToPath } from 'node:url';
import rateLimit from '@fastify/rate-limit';
import { createService, startService } from '@nexus/service-kit';
import { createDb, runMigrations } from '@nexus/db-kit';
import { createBus, startOutboxRelay } from '@nexus/bus';
import { config } from './config.js';
import { loadKeys } from './lib/keys.js';
import { createMailer } from './lib/mailer.js';
import { createTenancyClient } from './lib/tenancy-client.js';
import { authRoutes } from './routes/auth.js';
import { accountRoutes } from './routes/account.js';
import { internalRoutes } from './routes/internal.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const NAME = 'identity';

const db = createDb({ url: config.databaseUrl, appName: NAME, max: 20 });

await runMigrations({ db, dir: path.join(here, '..', 'migrations'), logger: console });

const bus = await createBus({ servers: config.natsUrl, name: NAME }).catch((error) => {
  console.warn(`  ! event bus unavailable (${error.message}) — events will queue in the outbox`);
  return null;
});

const app = await createService({ name: NAME, config, db, bus, publicService: true });

// Identity is the one service exposed semi-directly, so it rate limits itself.
await app.register(rateLimit, {
  global: false,
  max: 300,
  timeWindow: '1 minute',
  keyGenerator: (request) => request.ip,
  errorResponseBuilder: (request, context) => ({
    error: {
      code: 'rate_limited',
      message: `Too many attempts. Try again in ${Math.ceil(context.ttl / 1000)}s.`,
      request_id: request.id,
    },
  }),
});

app.decorate('keys', await loadKeys(db, app.log));
app.decorate('mailer', createMailer({ db, logger: app.log, isDev: config.nodeEnv !== 'production' }));
app.decorate(
  'tenancy',
  createTenancyClient({
    baseUrl: config.tenancyUrl,
    serviceToken: config.serviceToken,
    logger: app.log,
  }),
);

// ── public key material, cached hard: every service verifies against this ──
app.get('/.well-known/jwks.json', { logLevel: 'silent' }, async (request, reply) => {
  reply.header('cache-control', 'public, max-age=600, stale-while-revalidate=3600');
  return app.keys.jwks;
});

app.get('/.well-known/openid-configuration', async () => ({
  issuer: config.tokenIssuer,
  jwks_uri: config.jwksUrl,
  token_endpoint: `${config.tokenIssuer}/auth/login`,
  id_token_signing_alg_values_supported: ['RS256'],
}));

await app.register(authRoutes);
await app.register(accountRoutes);
await app.register(internalRoutes);

if (bus) startOutboxRelay({ db, bus, logger: app.log });

await startService(app, { port: config.port, name: NAME });
