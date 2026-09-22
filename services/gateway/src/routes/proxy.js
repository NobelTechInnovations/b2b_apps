import { ApiError, forbidden, unauthorized, notFound } from '@nexus/service-kit';

/** Namespaces whose writes change entitlements or installed apps. */
const COMMERCE_NAMESPACES = new Set(['subscriptions', 'apps']);

/**
 * The gate.
 *
 * Every request that is not /api/auth/* passes all three checks before a byte
 * reaches a service:
 *
 *   1. Authenticated  — a valid, unexpired platform token
 *   2. Entitled       — the workspace pays for the app this path belongs to
 *   3. Permitted      — this user holds a permission in that app
 *
 * The resolved context is then injected as headers, and the downstream service
 * checks it all over again from its own middleware.
 */
export async function proxyRoutes(app) {
  const { routingTable, upstreams, authz, config } = app;

  app.all('/api/*', async (request, reply) => {
    const path = request.params['*'] ?? '';
    const [prefix, ...rest] = path.split('/');

    const route = routingTable.get(prefix);
    if (!route) throw notFound(`API namespace "${prefix}"`);

    const upstream = upstreams[route.service];
    if (!upstream) {
      request.log.error({ service: route.service }, 'no upstream configured');
      throw app.httpErrors.badGateway(`The ${route.service} service is not available.`);
    }

    const target = `/${[prefix, ...rest].join('/')}`;
    const headers = {
      'x-request-id': request.id,
      'x-nexus-service-token': config.serviceToken,
      'x-forwarded-for': request.ip,
    };

    // ── public: sign-in, sign-up, price lists ──────────────────────────────
    if (route.public) {
      return reply.from(`${upstream}${target}`, {
        rewriteRequestHeaders: (req, original) => ({ ...stripInjected(original), ...headers }),
      });
    }

    // ── gate 1: authentication ─────────────────────────────────────────────
    await app.authenticate(request);
    const { userId, orgId, epoch, sessionId } = request.auth;

    headers['x-nexus-user'] = userId;
    headers['x-nexus-session'] = sessionId;

    if (!route.requiresOrg && !orgId) {
      return reply.from(`${upstream}${target}`, {
        rewriteRequestHeaders: (req, original) => ({ ...stripInjected(original), ...headers }),
      });
    }

    if (!orgId) {
      throw new ApiError(403, 'no_org_context', 'Choose a workspace before using this.');
    }

    // ── gate 2: live membership and resolved permissions ───────────────────
    const authorization = await authz.permissions({ orgId, userId, epoch });

    // A stale epoch means roles changed under this token. Ask for a refresh
    // rather than serving a decision the workspace has already revoked.
    if (authorization.epoch !== epoch) {
      reply.header('x-nexus-token-stale', '1');
      throw unauthorized('Your permissions have changed. Refreshing your session.');
    }

    // ── gate 3: entitlement ────────────────────────────────────────────────
    const entitlements = await authz.entitlements(orgId);

    if (route.app && !entitlements.apps.has(route.app)) {
      throw new ApiError(403, 'app_not_entitled', `This workspace does not have the ${route.app} app.`, {
        app: route.app,
        upgrade_url: `/settings/billing?add=${route.app}`,
      });
    }

    if (entitlements.status === 'canceled' || entitlements.status === 'none') {
      if (!['subscriptions', 'plans', 'organizations', 'account'].includes(prefix)) {
        throw new ApiError(403, 'subscription_inactive', 'This workspace has no active subscription.', {
          upgrade_url: '/settings/billing',
        });
      }
    }

    // Only permissions for entitled apps travel downstream — buying HR is what
    // makes HR permissions real, even if a role still lists them.
    const effective = [...authorization.permissions].filter((permission) => {
      const appSlug = permission.split('.')[0];
      return ['core', 'billing', 'catalog'].includes(appSlug) || entitlements.apps.has(appSlug);
    });

    // A write to billing or catalog changes the answer to gate 2 or 3. The bus
    // will tell us too, but that is milliseconds away and this request's caller
    // will read back immediately — so drop the cache synchronously here.
    if (COMMERCE_NAMESPACES.has(prefix) && request.method !== 'GET') {
      reply.raw.once('finish', () => {
        if (reply.raw.statusCode < 400) authz.invalidate(orgId);
      });
    }

    headers['x-nexus-org'] = orgId;
    headers['x-nexus-member'] = authorization.memberId;
    headers['x-nexus-roles'] = authorization.roles.join(',');
    headers['x-nexus-perms'] = effective.join(',');
    headers['x-nexus-apps'] = [...entitlements.apps].join(',');

    return reply.from(`${upstream}${target}`, {
      rewriteRequestHeaders: (req, original) => ({ ...stripInjected(original), ...headers }),
      onError: (rep, { error }) => {
        request.log.error({ err: error, service: route.service }, 'upstream request failed');
        rep.status(502).send({
          error: {
            code: 'upstream_unavailable',
            message: `The ${route.service} service is temporarily unavailable.`,
            request_id: request.id,
          },
        });
      },
    });
  });
}

/**
 * A client must never be able to hand us its own tenant or permission headers.
 * They are stripped here, before anything is injected.
 */
function stripInjected(headers) {
  const clean = { ...headers };
  for (const key of Object.keys(clean)) {
    if (key.toLowerCase().startsWith('x-nexus-')) delete clean[key];
  }
  return clean;
}
