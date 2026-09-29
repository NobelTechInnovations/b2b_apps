import { timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import fp from 'fastify-plugin';
import { unauthorized, forbidden } from './errors.js';

/**
 * Verifies the platform access token locally against the identity service's
 * published JWKS, then checks the live session so logout/revocation takes
 * effect immediately. Identity availability is required for authenticated traffic.
 *
 * Decorates every request with:
 *   request.auth = { userId, email, orgId, memberId, roles, sessionId, epoch }
 */
export function authPlugin({ jwksUrl, issuer, audience = 'nexus', serviceToken, sessionDb, sessionCacheMs = Number(process.env.SESSION_CACHE_MS) || 0 }) {
  const jwks = createRemoteJWKSet(new URL(jwksUrl), {
    cooldownDuration: 30_000,
    cacheMaxAge: 600_000,
  });

  // fastify-plugin, so these decorators live on the root instance and every
  // route registered afterwards can reach them. Without it they would be
  // trapped in this plugin's own encapsulated context.
  const INTERNAL_TIMEOUT_MS = Number(process.env.INTERNAL_TIMEOUT_MS) || 8_000;

  /**
   * Optional, short-lived memory of "this session is live" (the gateway turns
   * it on). Only positive answers are kept, and they are dropped the moment
   * identity announces a revocation — or at logout, by the gateway itself —
   * so a signed-out token stops working immediately, not after the TTL.
   */
  const liveSessions = new Map();
  if (sessionCacheMs > 0) {
    setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of liveSessions) if (entry.expires < now) liveSessions.delete(key);
    }, 60_000).unref();
  }
  const expected = serviceToken ? Buffer.from(serviceToken) : null;

  /**
   * True when the request came through the gateway, which has already checked
   * this very session moments ago: it carries our shared service token (a
   * secret no browser holds — the gateway strips client x-nexus-* headers)
   * and names the same session the token does. Re-checking it downstream
   * doubled the load on identity for no added safety.
   */
  function vouchedByGateway(request, sessionId) {
    if (!expected || !sessionId) return false;
    const presented = Buffer.from(String(request.headers['x-nexus-service-token'] ?? ''));
    return presented.length === expected.length
      && timingSafeEqual(presented, expected)
      && request.headers['x-nexus-session'] === sessionId;
  }

  return fp(async function plugin(app) {
    app.decorateRequest('auth', null);

    async function verifyToken(token) {
      try {
        const { payload } = await jwtVerify(token, jwks, { issuer, audience });
        return payload;
      } catch (error) {
        app.log.debug({ err: error }, 'token verification failed');
        throw unauthorized('Your session is not valid. Please sign in again.');
      }
    }

    /** Requires a signed-in user. Org context is optional here. */
    app.decorate('authenticate', async (request) => {
      const header = request.headers.authorization;
      const token = header?.startsWith('Bearer ') ? header.slice(7) : request.cookies?.nx_at;
      if (!token) throw unauthorized();

      const claims = await verifyToken(token);
      // Check the session on every authenticated request: clearing browser cookies
      // alone does not revoke a copied JWT. Identity failure must fail closed.
      let active;
      if (!claims.sid || !claims.sub) throw unauthorized();
      const cached = sessionCacheMs > 0 ? liveSessions.get(claims.sid) : null;
      if (vouchedByGateway(request, claims.sid)) {
        active = true;
      } else if (cached && cached.expires > Date.now() && cached.userId === claims.sub) {
        active = true;
      } else if (sessionDb) {
        active = await sessionDb.one(
          `SELECT s.id FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL
             AND s.expires_at > now() AND u.status = 'active'`, [claims.sid, claims.sub]);
      } else {
        const endpoint = new URL(`/internal/sessions/${encodeURIComponent(claims.sid)}`, jwksUrl);
        endpoint.searchParams.set('user_id', claims.sub);
        try {
          const response = await fetch(endpoint, {
            headers: { 'x-nexus-service-token': serviceToken }, signal: AbortSignal.timeout(INTERNAL_TIMEOUT_MS),
          });
          if (!response.ok) throw new Error(`Session lookup returned ${response.status}`);
          active = (await response.json()).data?.active;
        } catch (error) {
          request.log.warn({ err: error }, 'session verification unavailable');
          throw app.httpErrors.serviceUnavailable('Session verification is unavailable.');
        }
      }
      if (!active) throw unauthorized('Your session has ended. Please sign in again.');
      if (sessionCacheMs > 0 && !cached) {
        liveSessions.set(claims.sid, { userId: claims.sub, expires: Date.now() + sessionCacheMs });
      }
      request.auth = {
        userId: claims.sub,
        email: claims.email,
        name: claims.name,
        orgId: claims.org ?? null,
        memberId: claims.mem ?? null,
        roles: claims.roles ?? [],
        sessionId: claims.sid,
        epoch: claims.ver ?? 0,
        isOwner: (claims.roles ?? []).includes('owner'),
      };
      return request.auth;
    });

    /** Forget cached session checks: one session, or every session of a user. */
    app.decorate('forgetSessions', ({ sessionId, userId } = {}) => {
      if (sessionId) liveSessions.delete(sessionId);
      if (userId) for (const [key, entry] of liveSessions) if (entry.userId === userId) liveSessions.delete(key);
    });

    /** Verify a token's signature only (no session check), e.g. to learn who is signing out. */
    app.decorate('peekToken', async (token) => verifyToken(token).catch(() => null));

    /** Requires a signed-in user WITH an active organization context. */
    app.decorate('authenticateOrg', async (request) => {
      await app.authenticate(request);
      if (!request.auth.orgId) {
        throw forbidden('Select a workspace before continuing.', { code: 'no_org_context' });
      }
      // Downstream services are handed the tenant by the gateway. Anything a
      // client sends in these headers is discarded.
      request.orgId = request.auth.orgId;
      return request.auth;
    });

    /** Service-to-service calls carry a shared secret, never a user token. */
    app.decorate('verifyInternal', async (request) => {
      if (!serviceToken) throw forbidden('Internal calls are not configured');
      const presented = Buffer.from(String(request.headers['x-nexus-service-token'] ?? ''));
      if (!expected || presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
        throw forbidden('Invalid internal service token');
      }
    });
  }, { name: 'nexus-auth' });
}
