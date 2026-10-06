import Fastify from 'fastify';
import addFormats from 'ajv-formats';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import { createLogger } from './logger.js';
import { errorHandler } from './errors.js';
import { authPlugin } from './auth.js';
import { platformContext } from './guards.js';
import { registerCapabilities } from './capabilities.js';

/**
 * Every Nexus service is created here. Identical middleware, identical error
 * shape, identical health probes, identical observability — so fifteen
 * services behave like one product.
 */
export async function createService({
  name,
  version = '0.1.0',
  config,
  db,
  bus,
  cors: corsOptions,
  publicService = false,
}) {
  const logger = createLogger({ name });

  const app = Fastify({
    loggerInstance: logger,
    trustProxy: true,
    disableRequestLogging: true,
    bodyLimit: 5 * 1024 * 1024,
    genReqId: (req) => req.headers['x-request-id'] ?? randomUUID(),
    ajv: {
      customOptions: {
        coerceTypes: 'array',
        // `true`, not `'all'`. With `'all'` ajv strips every additional
        // property even where the schema says `additionalProperties: true`,
        // which silently empties free-form objects — an import mapping, an
        // address, a settings blob. `true` still strips unknown fields
        // wherever `additionalProperties: false`, which is what body() and
        // query() declare, so nothing is loosened at the request boundary.
        removeAdditional: true,
        useDefaults: true,
      },
      plugins: [addFormats],
    },
  });

  app.decorate('config', config);
  if (db) app.decorate('db', db);
  if (bus) app.decorate('bus', bus);

  // A POST with `content-type: application/json` and no body is a perfectly
  // ordinary request (sign out, resend, trigger). Fastify rejects it by
  // default; treat it as an empty object instead of a 400.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (request, body, done) => {
      if (!body || body.trim() === '') return done(null, {});
      try {
        done(null, JSON.parse(body));
      } catch (error) {
        error.statusCode = 400;
        done(error, undefined);
      }
    },
  );

  await app.register(sensible);
  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: false });
  await app.register(cookie, { secret: config.cookieSecret, hook: 'onRequest' });

  if (publicService) {
    await app.register(cors, {
      origin: corsOptions?.origin ?? config.webOrigin ?? true,
      credentials: true,
      exposedHeaders: ['x-request-id'],
      ...corsOptions,
    });
  }

  await app.register(
    authPlugin({
      jwksUrl: config.jwksUrl,
      issuer: config.tokenIssuer,
      audience: 'nexus',
      serviceToken: config.serviceToken,
      sessionDb: name === 'identity' ? db : undefined,
    }),
  );

  platformContext(app);
  registerCapabilities(app, name);

  app.setErrorHandler(errorHandler);

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: {
        code: 'route_not_found',
        message: `No route for ${request.method} ${request.url}`,
        request_id: request.id,
      },
    }),
  );

  // ── request logging: one line per request, with tenant and timing ────────
  app.addHook('onRequest', async (request) => {
    request.startedAt = process.hrtime.bigint();
    request.headers['x-request-id'] = request.id;
  });

  app.addHook('onResponse', async (request, reply) => {
    if (request.url === '/healthz' || request.url === '/readyz') return;
    const ms = Number(process.hrtime.bigint() - request.startedAt) / 1e6;
    request.log.info(
      {
        method: request.method,
        url: request.url,
        status: reply.statusCode,
        ms: Math.round(ms * 10) / 10,
        org: request.ctx?.orgId ?? request.auth?.orgId,
        user: request.auth?.userId,
        req_id: request.id,
      },
      'request',
    );
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.id);
    return payload;
  });

  // ── health probes ────────────────────────────────────────────────────────
  app.get('/healthz', { logLevel: 'silent' }, async () => ({
    status: 'ok',
    service: name,
    version,
    uptime_s: Math.round(process.uptime()),
  }));

  app.get('/readyz', { logLevel: 'silent' }, async (request, reply) => {
    const checks = {};
    if (db) {
      checks.database = await db.healthy().then(() => 'ok').catch((e) => `fail: ${e.message}`);
    }
    if (bus) {
      checks.bus = bus.healthy() ? 'ok' : 'fail';
    }
    const ready = Object.values(checks).every((v) => v === 'ok');
    return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'degraded', checks });
  });

  return app;
}

/** Boot with graceful shutdown wired up. */
export async function startService(app, { port, host = process.env.SERVICE_BIND_HOST ?? '0.0.0.0', name }) {
  let closing = false;

  const close = async (signal) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');

    // A shutdown that hangs is worse than an abrupt one: a stuck process blocks
    // deploys and blocks `node --watch` from restarting during development.
    const deadline = setTimeout(() => {
      app.log.warn('graceful shutdown timed out — exiting');
      process.exit(0);
    }, 5_000);
    deadline.unref();

    try {
      await app.close();
      if (app.bus) await app.bus.close();
      if (app.db) await app.db.close();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => close('SIGTERM'));
  process.on('SIGINT', () => close('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'unhandled rejection');
  });

  await app.listen({ port, host });
  app.log.info(`${name} listening on http://localhost:${port}`);
  return app;
}
