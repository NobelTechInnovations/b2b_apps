import { id } from '@nexus/db-kit';
import { requirePermission, body, validate as v, notFound, badRequest, forbidden } from '@nexus/service-kit';
import { APP_CATEGORIES, resolveDependencies } from '@nexus/contracts';
import { EVENTS } from '@nexus/contracts/events';

export async function marketplaceRoutes(app) {
  const { db, billing } = app;

  async function installedSet(orgId) {
    const rows = await db.rows(
      `SELECT app_slug FROM organization_apps WHERE org_id = $1 AND status = 'installed'`,
      [orgId],
    );
    return new Set(rows.map((r) => r.app_slug));
  }

  // ═══════════════════════════════════════════════════════════ THE STOREFRONT
  app.get('/apps', { preHandler: app.loadContext }, async (request) => {
    const { orgId } = request.ctx;

    const apps = await db.rows(`SELECT * FROM apps ORDER BY sort_order`);
    const installed = await installedSet(orgId);
    const entitlements = await billing.entitlements(orgId);
    const entitled = new Set(entitlements.apps.map((a) => a.app_slug));

    const data = apps
      .filter((a) => !a.is_core)
      .map((a) => ({
        slug: a.slug,
        name: a.name,
        tagline: a.tagline,
        description: a.description,
        category: a.category,
        icon: a.icon,
        color: a.color,
        status: a.status,
        price: a.price,
        highlights: a.highlights,
        features: a.features,
        dependencies: a.dependencies,
        installed: installed.has(a.slug),
        entitled: entitled.has(a.slug),
        // Everything you'd also have to add to get this one working.
        requires: (a.dependencies ?? []).filter((d) => !installed.has(d)),
      }));

    return {
      data,
      meta: {
        categories: APP_CATEGORIES.map((c) => ({
          ...c,
          count: data.filter((a) => a.category === c.slug).length,
        })),
        installed_count: installed.size,
        currency: entitlements.currency ?? 'INR',
      },
    };
  });

  app.get(
    '/apps/:slug',
    { preHandler: app.loadContext, schema: { params: { type: 'object', properties: { slug: v.slug }, required: ['slug'] } } },
    async (request) => {
      const record = await db.one(`SELECT * FROM apps WHERE slug = $1`, [request.params.slug]);
      if (!record) throw notFound('App');

      const install = await db.one(
        `SELECT * FROM organization_apps WHERE org_id = $1 AND app_slug = $2`,
        [request.ctx.orgId, record.slug],
      );
      const entitlements = await billing.entitlements(request.ctx.orgId);

      return {
        data: {
          ...record,
          installed: install?.status === 'installed',
          install_reason: install?.install_reason,
          installed_at: install?.installed_at,
          settings: install?.settings ?? {},
          entitled: entitlements.apps.some((a) => a.app_slug === record.slug),
        },
      };
    },
  );

  // ══════════════════════════════════════════════════════════════════ INSTALL
  app.post(
    '/apps/:slug/install',
    {
      preHandler: [app.loadContext, requirePermission('catalog.apps.manage')],
      schema: { params: { type: 'object', properties: { slug: v.slug }, required: ['slug'] } },
    },
    async (request) => {
      const { orgId, userId } = request.ctx;
      const slug = request.params.slug;

      const record = await db.one(`SELECT * FROM apps WHERE slug = $1`, [slug]);
      if (!record) throw notFound('App');
      if (record.status === 'coming_soon') {
        throw badRequest(`${record.name} is not available yet. We will let you know when it ships.`);
      }

      // Gate one: you must be paying for it. Billing is the authority.
      let entitlements = await billing.entitlements(orgId);
      let entitled = new Set(entitlements.apps.map((a) => a.app_slug));

      // A workspace that just bought this app may not be in our cache yet.
      // Refusing on a stale read would be wrong, so confirm with billing
      // directly before turning anyone away.
      if (!entitled.has(slug)) {
        billing.invalidate(orgId);
        entitlements = await billing.entitlements(orgId);
        entitled = new Set(entitlements.apps.map((a) => a.app_slug));
      }

      if (!entitled.has(slug)) {
        throw forbidden(`Add ${record.name} to your subscription before installing it.`, {
          code: 'not_entitled',
          app: slug,
          price: record.price,
        });
      }

      // Gate two: its dependencies must come with it.
      const chain = resolveDependencies([slug]);
      const missing = chain.filter((dep) => dep !== slug && !entitled.has(dep));
      if (missing.length) {
        throw badRequest(
          `${record.name} needs ${missing.join(', ')} to work. Add ${
            missing.length === 1 ? 'it' : 'them'
          } to your subscription first.`,
          { missing_dependencies: missing },
        );
      }

      const installed = await db.transaction(async (tx) => {
        const results = [];
        for (const depSlug of chain) {
          const row = await tx.one(
            `INSERT INTO organization_apps (id, org_id, app_slug, status, install_reason, installed_by)
             VALUES ($1, $2, $3, 'installed', $4, $5)
             ON CONFLICT (org_id, app_slug) DO UPDATE
               SET status = 'installed', uninstalled_at = NULL,
                   install_reason = CASE WHEN organization_apps.status = 'installed'
                                         THEN organization_apps.install_reason
                                         ELSE EXCLUDED.install_reason END
             RETURNING *`,
            [id('oap'), orgId, depSlug, depSlug === slug ? 'purchased' : 'dependency', userId],
          );

          if (depSlug !== slug) {
            await tx.query(
              `INSERT INTO app_dependency_links (org_id, app_slug, required_by)
               VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
              [orgId, depSlug, slug],
            );
          }
          results.push(row);
        }

        tx.emit({
          type: EVENTS.APP_INSTALLED,
          org_id: orgId,
          actor_id: userId,
          data: { app_slug: slug, with_dependencies: chain.filter((c) => c !== slug) },
        });

        return results;
      });

      return {
        data: {
          installed: installed.map((r) => r.app_slug),
          app: slug,
          dependencies_installed: chain.filter((c) => c !== slug),
        },
      };
    },
  );

  // ════════════════════════════════════════════════════════════════ UNINSTALL
  app.post(
    '/apps/:slug/uninstall',
    {
      preHandler: [app.loadContext, requirePermission('catalog.apps.manage')],
      schema: {
        params: { type: 'object', properties: { slug: v.slug }, required: ['slug'] },
        body: body({ keep_data: { type: 'boolean', default: true } }),
      },
    },
    async (request) => {
      const { orgId, userId } = request.ctx;
      const slug = request.params.slug;

      const record = await db.one(`SELECT * FROM apps WHERE slug = $1`, [slug]);
      if (!record) throw notFound('App');
      if (record.is_core) throw badRequest('Core workspace features cannot be removed.');

      // Refuse to break something else that is still installed.
      const dependents = await db.rows(
        `SELECT DISTINCT l.required_by FROM app_dependency_links l
           JOIN organization_apps oa ON oa.org_id = l.org_id AND oa.app_slug = l.required_by
          WHERE l.org_id = $1 AND l.app_slug = $2 AND oa.status = 'installed'`,
        [orgId, slug],
      );
      if (dependents.length) {
        const names = dependents.map((d) => d.required_by).join(', ');
        throw badRequest(`${names} depend${dependents.length === 1 ? 's' : ''} on ${record.name}. Remove ${dependents.length === 1 ? 'it' : 'them'} first.`, {
          blocked_by: dependents.map((d) => d.required_by),
        });
      }

      await db.transaction(async (tx) => {
        await tx.query(
          `UPDATE organization_apps SET status = 'uninstalled', uninstalled_at = now()
            WHERE org_id = $1 AND app_slug = $2`,
          [orgId, slug],
        );
        await tx.query(`DELETE FROM app_dependency_links WHERE org_id = $1 AND required_by = $2`, [orgId, slug]);

        // Dependencies nothing else needs any more come out too.
        const orphans = await tx.rows(
          `SELECT oa.app_slug FROM organization_apps oa
            WHERE oa.org_id = $1 AND oa.status = 'installed' AND oa.install_reason = 'dependency'
              AND NOT EXISTS (SELECT 1 FROM app_dependency_links l
                               WHERE l.org_id = $1 AND l.app_slug = oa.app_slug)`,
          [orgId],
        );
        for (const orphan of orphans) {
          await tx.query(
            `UPDATE organization_apps SET status = 'uninstalled', uninstalled_at = now()
              WHERE org_id = $1 AND app_slug = $2`,
            [orgId, orphan.app_slug],
          );
        }

        tx.emit({
          type: EVENTS.APP_UNINSTALLED,
          org_id: orgId,
          actor_id: userId,
          data: {
            app_slug: slug,
            keep_data: request.body?.keep_data ?? true,
            orphans_removed: orphans.map((o) => o.app_slug),
          },
        });
      });

      // Data is retained for 30 days so an accidental uninstall is recoverable;
      // the owning service handles its own purge on the retention event.
      return { data: { uninstalled: true, data_retained_days: 30 } };
    },
  );

  // ════════════════════════════════════════════════════════════ APP SETTINGS
  app.patch(
    '/apps/:slug/settings',
    {
      preHandler: [app.loadContext, requirePermission('catalog.apps.manage')],
      schema: {
        params: { type: 'object', properties: { slug: v.slug }, required: ['slug'] },
        body: { type: 'object', additionalProperties: true },
      },
    },
    async (request) => {
      const row = await db.one(
        `UPDATE organization_apps SET settings = settings || $3::jsonb
          WHERE org_id = $1 AND app_slug = $2 AND status = 'installed'
        RETURNING app_slug, settings`,
        [request.ctx.orgId, request.params.slug, JSON.stringify(request.body ?? {})],
      );
      if (!row) throw notFound('Installed app');
      return { data: row };
    },
  );

  // ═══════════════════════════════════════════════════ WHAT THIS WORKSPACE HAS
  app.get('/apps/installed', { preHandler: app.loadContext }, async (request) => {
    const rows = await db.rows(
      `SELECT a.*, oa.status AS install_status, oa.install_reason, oa.installed_at, oa.settings
         FROM organization_apps oa JOIN apps a ON a.slug = oa.app_slug
        WHERE oa.org_id = $1 AND oa.status = 'installed'
        ORDER BY a.sort_order`,
      [request.ctx.orgId],
    );
    return { data: rows };
  });
}
