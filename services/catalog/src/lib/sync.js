import { APPS } from '@nexus/contracts';

/**
 * The app registry in code is the source of truth; this table is a queryable
 * projection of it. Syncing on boot means publishing a new app to the
 * marketplace is a deploy, not a data migration.
 */
export async function syncAppRegistry(db, logger) {
  let synced = 0;

  for (const [index, app] of APPS.entries()) {
    await db.query(
      `INSERT INTO apps (slug, name, tagline, description, category, icon, color, service,
                         is_core, status, price, highlights, features, permissions, nav,
                         widgets, dependencies, sort_order, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, now())
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name, tagline = EXCLUDED.tagline, description = EXCLUDED.description,
         category = EXCLUDED.category, icon = EXCLUDED.icon, color = EXCLUDED.color,
         service = EXCLUDED.service, is_core = EXCLUDED.is_core, status = EXCLUDED.status,
         price = EXCLUDED.price, highlights = EXCLUDED.highlights, features = EXCLUDED.features,
         permissions = EXCLUDED.permissions, nav = EXCLUDED.nav, widgets = EXCLUDED.widgets,
         dependencies = EXCLUDED.dependencies, sort_order = EXCLUDED.sort_order,
         synced_at = now()`,
      [
        app.slug, app.name, app.tagline ?? null, app.description ?? null, app.category,
        app.icon ?? null, app.color ?? null, app.service, app.core ?? false,
        app.status ?? 'available',
        JSON.stringify(app.price ?? {}), JSON.stringify(app.highlights ?? []),
        JSON.stringify(app.features ?? []), JSON.stringify(app.permissions ?? []),
        JSON.stringify(app.nav ?? []), JSON.stringify(app.widgets ?? []),
        JSON.stringify(app.dependencies ?? []), index,
      ],
    );
    synced += 1;
  }

  logger.info({ synced }, 'app registry synced');
  return synced;
}
