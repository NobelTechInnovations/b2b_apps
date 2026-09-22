import { id } from '@nexus/db-kit';
import { requireInternal } from '@nexus/service-kit';
import { resolveDependencies } from '@nexus/contracts';
import { EVENTS } from '@nexus/contracts/events';

export async function internalRoutes(app) {
  const { db } = app;

  /** The gateway's per-request lookup of what this workspace can reach. */
  app.get('/internal/orgs/:orgId/apps', { preHandler: requireInternal() }, async (request) => {
    const rows = await db.rows(
      `SELECT oa.app_slug, oa.status, oa.install_reason, a.service, a.nav, a.widgets, a.name, a.icon, a.color
         FROM organization_apps oa JOIN apps a ON a.slug = oa.app_slug
        WHERE oa.org_id = $1 AND oa.status = 'installed'`,
      [request.params.orgId],
    );
    return { data: rows };
  });

  /**
   * Called during onboarding and whenever entitlements change: make the
   * installed set match what the workspace is actually paying for.
   */
  app.post('/internal/orgs/:orgId/provision', { preHandler: requireInternal() }, async (request) => {
    const { orgId } = request.params;
    const { app_slugs: requested = [], actor_id: actorId = null, reason = 'purchased' } = request.body ?? {};

    const chain = resolveDependencies(requested.filter((s) => s !== 'core'));
    const target = ['core', ...chain];

    const result = await db.transaction(async (tx) => {
      const installed = [];

      for (const slug of target) {
        const row = await tx.one(
          `INSERT INTO organization_apps (id, org_id, app_slug, status, install_reason, installed_by)
           VALUES ($1, $2, $3, 'installed', $4, $5)
           ON CONFLICT (org_id, app_slug) DO UPDATE
             SET status = 'installed', uninstalled_at = NULL
           RETURNING app_slug, install_reason`,
          [
            id('oap'),
            orgId,
            slug,
            slug === 'core' ? 'included' : requested.includes(slug) ? reason : 'dependency',
            actorId,
          ],
        );
        installed.push(row.app_slug);
      }

      // Record dependency links so uninstall can clean up later.
      for (const slug of requested) {
        for (const dep of resolveDependencies([slug]).filter((d) => d !== slug)) {
          await tx.query(
            `INSERT INTO app_dependency_links (org_id, app_slug, required_by)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [orgId, dep, slug],
          );
        }
      }

      // Anything no longer paid for is suspended, not deleted — re-subscribing
      // must bring the workspace back exactly as it was.
      const removed = await tx.rows(
        `UPDATE organization_apps SET status = 'suspended'
          WHERE org_id = $1 AND status = 'installed' AND app_slug <> ALL($2)
        RETURNING app_slug`,
        [orgId, target],
      );

      tx.emit({
        type: EVENTS.APP_INSTALLED,
        org_id: orgId,
        actor_id: actorId,
        data: { provisioned: installed, suspended: removed.map((r) => r.app_slug) },
      });

      return { installed, suspended: removed.map((r) => r.app_slug) };
    });

    request.log.info({ orgId, ...result }, 'workspace apps provisioned');
    return { data: result };
  });
}
