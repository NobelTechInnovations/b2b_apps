import { EVENTS } from '@nexus/contracts/events';
import { appBySlug } from '@nexus/contracts';

/**
 * Rebuild the entitlement read-model for one workspace from its subscription.
 *
 * This is the single function that decides what a customer may use. Everything
 * downstream — the gateway, the catalog, the sidebar — is a projection of it.
 */
export async function recomputeEntitlements(tx, orgId, { actorId } = {}) {
  const subscription = await tx.one(
    `SELECT * FROM subscriptions WHERE org_id = $1 AND status <> 'canceled'`,
    [orgId],
  );

  if (!subscription) {
    await tx.query(`UPDATE app_entitlements SET status = 'expired' WHERE org_id = $1`, [orgId]);
    tx.emit({
      type: EVENTS.ENTITLEMENTS_CHANGED,
      org_id: orgId,
      actor_id: actorId,
      data: { apps: [], reason: 'no_subscription' },
    });
    return { apps: [], features: [] };
  }

  const items = await tx.rows(
    `SELECT * FROM subscription_items WHERE subscription_id = $1 AND removed_at IS NULL`,
    [subscription.id],
  );

  // A canceled-but-not-yet-expired subscription keeps working to period end.
  // A past-due one gets a grace window rather than an abrupt cut-off.
  const status =
    subscription.status === 'trialing' ? 'trialing'
    : subscription.status === 'past_due' ? 'grace'
    : subscription.status === 'active' ? 'active'
    : 'expired';

  const expiresAt =
    subscription.status === 'trialing' ? subscription.trial_ends_at : subscription.current_period_end;

  const slugs = ['core', ...items.map((i) => i.app_slug)];

  for (const slug of slugs) {
    const item = items.find((i) => i.app_slug === slug);
    await tx.query(
      `INSERT INTO app_entitlements (org_id, app_slug, status, seats, source, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (org_id, app_slug) DO UPDATE SET
         status = EXCLUDED.status, seats = EXCLUDED.seats,
         source = EXCLUDED.source, expires_at = EXCLUDED.expires_at`,
      [
        orgId,
        slug,
        slug === 'core' ? status : status,
        item?.quantity ?? subscription.seats,
        item?.source ?? 'plan',
        slug === 'core' ? null : expiresAt,
      ],
    );
  }

  // Anything no longer on the subscription expires.
  await tx.query(
    `UPDATE app_entitlements SET status = 'expired' WHERE org_id = $1 AND app_slug <> ALL($2)`,
    [orgId, slugs],
  );

  // Feature-level entitlements come from each entitled app's declared features.
  const features = slugs.flatMap((slug) => appBySlug(slug)?.features ?? []);
  await tx.query(`DELETE FROM feature_entitlements WHERE org_id = $1`, [orgId]);
  if (features.length) {
    const values = features.map((_, i) => `($1, $${i + 2}, true)`).join(', ');
    await tx.query(
      `INSERT INTO feature_entitlements (org_id, feature, enabled) VALUES ${values}
       ON CONFLICT DO NOTHING`,
      [orgId, ...features],
    );
  }

  tx.emit({
    type: EVENTS.ENTITLEMENTS_CHANGED,
    org_id: orgId,
    actor_id: actorId,
    data: {
      apps: slugs,
      features,
      status,
      seats: subscription.seats,
      expires_at: expiresAt,
    },
  });

  return { apps: slugs, features, status };
}

/** The read side, used by the gateway on every cache miss. */
export async function readEntitlements(db, orgId) {
  const rows = await db.rows(
    `SELECT app_slug, status, seats, expires_at FROM app_entitlements
      WHERE org_id = $1 AND status <> 'expired'`,
    [orgId],
  );

  const features = await db.rows(
    `SELECT feature FROM feature_entitlements WHERE org_id = $1 AND enabled = true`,
    [orgId],
  );

  const subscription = await db.one(
    `SELECT id, plan_slug, status, billing_cycle, currency, seats,
            trial_ends_at, current_period_end, cancel_at_period_end
       FROM subscriptions WHERE org_id = $1 AND status <> 'canceled'`,
    [orgId],
  );

  // An expiry that has quietly passed must not keep granting access.
  const now = Date.now();
  const live = rows.filter((r) => !r.expires_at || new Date(r.expires_at).getTime() > now);

  return {
    apps: live,
    features: features.map((f) => f.feature),
    subscription,
    currency: subscription?.currency ?? 'INR',
  };
}
