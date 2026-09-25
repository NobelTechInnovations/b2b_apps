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
export function authPlugin({ jwksUrl, issuer, audience = 'nexus', serviceToken, sessionDb }) {
  const jwks = createRemoteJWKSet(new URL(jwksUrl), {
    cooldownDuration: 30_000,
    cacheMaxAge: 600_000,
  });

  // fastify-plugin, so these decorators live on the root instance and every
  // route registered afterwards can reach them. Without it they would be
  // trapped in this plugin's own encapsulated context.
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
      if (sessionDb) {
        active = await sessionDb.one(
          `SELECT s.id FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL
             AND s.expires_at > now() AND u.status = 'active'`, [claims.sid, claims.sub]);
      } else {
        const endpoint = new URL(`/internal/sessions/${encodeURIComponent(claims.sid)}`, jwksUrl);
        endpoint.searchParams.set('user_id', claims.sub);
        try {
          const response = await fetch(endpoint, {
            headers: { 'x-nexus-service-token': serviceToken }, signal: AbortSignal.timeout(3000),
          });
          if (!response.ok) throw new Error(`Session lookup returned ${response.status}`);
          active = (await response.json()).data?.active;
        } catch (error) {
          request.log.warn({ err: error }, 'session verification unavailable');
          throw app.httpErrors.serviceUnavailable('Session verification is unavailable.');
        }
      }
      if (!active) throw unauthorized('Your session has ended. Please sign in again.');
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
      const presented = request.headers['x-nexus-service-token'];
      if (!presented || presented !== serviceToken) {
        throw forbidden('Invalid internal service token');
      }
    });
  }, { name: 'nexus-auth' });
}
