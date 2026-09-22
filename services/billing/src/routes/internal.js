import { requireInternal } from '@nexus/service-kit';
import { readEntitlements } from '../lib/entitlements.js';

export async function internalRoutes(app) {
  const { db } = app;

  /** The authority every gate consults. Called by the gateway and catalog. */
  app.get('/internal/entitlements/:orgId', { preHandler: requireInternal() }, async (request) => {
    const data = await readEntitlements(db, request.params.orgId);
    return { data };
  });

  /** Seat enforcement: tenancy asks before letting another invitation out. */
  app.get('/internal/orgs/:orgId/seats', { preHandler: requireInternal() }, async (request) => {
    const subscription = await db.one(
      `SELECT s.seats, s.status, p.max_users, p.included_users
         FROM subscriptions s JOIN plans p ON p.slug = s.plan_slug
        WHERE s.org_id = $1 AND s.status <> 'canceled'`,
      [request.params.orgId],
    );
    return {
      data: subscription ?? { seats: 0, status: 'none', max_users: 0, included_users: 0 },
    };
  });
}
