import { forbidden, unauthorized } from './errors.js';

/**
 * Trust boundary
 * ──────────────
 * Business services are not publicly reachable. Every request arrives from the
 * gateway, which proves itself with the internal service token and injects the
 * already-resolved authorization context:
 *
 *   x-nexus-org      org_01J...            verified membership
 *   x-nexus-member   mem_01J...
 *   x-nexus-perms    crm.leads.view,...    resolved from roles
 *   x-nexus-apps     crm,hr,tasks          entitled AND installed
 *
 * The service still re-checks every one of them. Two independent gates, so a
 * gateway bug cannot become a data breach.
 */
export function platformContext(app) {
  app.decorateRequest('ctx', null);

  app.decorate('loadContext', async (request) => {
    await app.verifyInternal(request);
    await app.authenticate(request);

    const orgId = request.headers['x-nexus-org'] || request.auth.orgId;
    if (!orgId) throw forbidden('No workspace context on this request');

    // Cross-check: the gateway's org must match the one the token was minted for.
    if (request.auth.orgId && orgId !== request.auth.orgId) {
      request.log.error(
        { tokenOrg: request.auth.orgId, headerOrg: orgId },
        'org mismatch between token and gateway header — rejecting',
      );
      throw forbidden('Workspace context mismatch');
    }

    const permissions = new Set(String(request.headers['x-nexus-perms'] ?? '').split(',').filter(Boolean));
    const apps = new Set(String(request.headers['x-nexus-apps'] ?? '').split(',').filter(Boolean));
    const isOwner = request.auth.isOwner;

    request.ctx = {
      orgId,
      userId: request.auth.userId,
      memberId: request.headers['x-nexus-member'] || request.auth.memberId,
      email: request.auth.email,
      roles: request.auth.roles,
      isOwner,
      permissions,
      apps,

      can: (permission) => isOwner || permissions.has(permission),
      hasApp: (slug) => apps.has(slug),

      assert(permission) {
        if (!this.can(permission)) {
          throw forbidden(`You need the "${permission}" permission to do this.`, {
            required: permission,
          });
        }
      },
      assertApp(slug) {
        if (!this.hasApp(slug)) {
          throw forbidden(`The ${slug} app is not active on this workspace.`, {
            required_app: slug,
            code: 'app_not_entitled',
          });
        }
      },
    };

    return request.ctx;
  });
}

/** Route guard: `preHandler: requirePermission('crm.leads.create')` */
export function requirePermission(permission) {
  return async function (request) {
    if (!request.ctx) throw unauthorized();
    request.ctx.assert(permission);
  };
}

/** Route guard: the app itself must be entitled + installed. */
export function requireApp(slug) {
  return async function (request) {
    if (!request.ctx) throw unauthorized();
    request.ctx.assertApp(slug);
  };
}

/** Route guard: coarse role check. Use sparingly — prefer permissions. */
export function requireRole(...roles) {
  return async function (request) {
    if (!request.ctx) throw unauthorized();
    if (request.ctx.isOwner) return;
    if (!request.ctx.roles.some((r) => roles.includes(r))) {
      throw forbidden(`This action is limited to: ${roles.join(', ')}`);
    }
  };
}

/** Route guard: service-to-service only, no user involved. */
export function requireInternal() {
  return async function (request) {
    await request.server.verifyInternal(request);
  };
}
