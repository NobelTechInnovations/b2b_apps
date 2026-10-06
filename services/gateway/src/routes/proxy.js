import { ApiError, forbidden, unauthorized, notFound } from '@nexus/service-kit';
import { appBySlug } from '@nexus/contracts';
import { memberApps } from '../lib/authz.js';

/** Namespaces whose writes change entitlements, installed apps, or who may open what. */
const COMMERCE_NAMESPACES = new Set(['subscriptions', 'apps', 'members', 'roles']);

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

    // Signing out through us: forget the session the moment it succeeds, so
    // the cached "session is live" answer cannot outlast the logout.
    if (prefix === 'auth' && request.method === 'POST' && ['logout', 'logout-all', 'change-password'].includes(rest[0])) {
      const token = request.headers.authorization?.startsWith('Bearer ')
        ? request.headers.authorization.slice(7)
        : request.cookies?.nx_at;
      const claims = token ? await app.peekToken(token) : null;
      if (claims) {
        reply.raw.once('finish', () => {
          if (reply.raw.statusCode < 400) {
            app.forgetSessions({ sessionId: claims.sid, userId: rest[0] === 'logout' ? null : claims.sub });
          }
        });
      }
    }

    // ── public: sign-in, sign-up, price lists ──────────────────────────────
    if (route.public) {
      if (prefix === 'mcp') {
        const hosts = (process.env.MCP_ALLOWED_HOSTS ?? 'localhost,127.0.0.1,[::1]').split(',').map((s) => s.trim());
        const origins = (process.env.MCP_ALLOWED_ORIGINS ?? 'http://localhost:3100,http://localhost:3000').split(',').map((s) => s.trim());
        let hostname;
        try { hostname = new URL(`http://${request.headers.host}`).hostname; } catch { throw forbidden('Invalid MCP host.'); }
        if (!hosts.includes(hostname) || (request.headers.origin && !origins.includes(request.headers.origin))) throw forbidden('MCP host or origin is not allowed.');
        // No session-cookie fallback on the agent endpoint.
        if (!request.headers.authorization?.startsWith('Bearer nx_mcp_')) throw unauthorized('Use a Nexus MCP connection token.');
      }
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

    // A stale epoch means something about access changed in this workspace.
    // The permissions above are already fresh; the token only matters if it
    // now names the wrong roles (services read those from it). So only the
    // person whose roles changed is sent to refresh — changing one person's
    // apps or another person's role no longer bounces everybody.
    if (authorization.epoch !== epoch && !sameRoles(authorization, request.auth)) {
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
      // The inbox stays reachable: a lapsed workspace is exactly the one that
      // needs to read "your trial has ended".
      if (!['subscriptions', 'plans', 'organizations', 'account', 'notifications'].includes(prefix)) {
        throw new ApiError(403, 'subscription_inactive', 'This workspace has no active subscription.', {
          upgrade_url: '/settings/billing',
        });
      }
    }

    const installed = await authz.installed(orgId);
    const activeApps = new Set([...entitlements.apps].filter((slug) => installed.has(slug)));
    if (route.app && !activeApps.has(route.app)) {
      throw new ApiError(403, 'app_not_installed', `Install ${route.app} before using it.`, { app: route.app });
    }

    // The company has the app; has this person been given it?
    const yourApps = memberApps(activeApps, authorization);
    if (route.app && !yourApps.has(route.app)) {
      const name = appBySlug(route.app)?.name ?? route.app;
      throw new ApiError(403, 'app_not_assigned', `You don't have access to ${name}. Ask a workspace owner or admin to give it to you.`, { app: route.app });
    }

    // Only permissions for entitled apps travel downstream — buying HR is what
    // makes HR permissions real, even if a role still lists them.
    const effective = [...authorization.permissions].filter((permission) => {
      const appSlug = permission.split('.')[0];
      return ['core', 'billing', 'catalog'].includes(appSlug) || yourApps.has(appSlug);
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
    headers['x-nexus-apps'] = [...yourApps].join(',');

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

/** Does the token still name exactly the roles this person holds now? */
function sameRoles(authorization, auth) {
  const now = new Set(authorization.roles);
  const claimed = new Set(auth.roles ?? []);
  return authorization.isOwner === auth.isOwner && now.size === claimed.size && [...now].every((role) => claimed.has(role));
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
