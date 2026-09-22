import { id } from '@nexus/db-kit';
import { body, validate as v, notFound, badRequest, forbidden } from '@nexus/service-kit';
import { appBySlug, resolveDependencies } from '@nexus/contracts';
import { EVENTS } from '@nexus/contracts/events';
import { quote, periodEnd } from '../lib/pricing.js';
import { recomputeEntitlements } from '../lib/entitlements.js';

export async function subscriptionRoutes(app) {
  const { db, catalog } = app;

  async function loadPricing(planSlug, appSlugs) {
    const plan = await db.one(`SELECT * FROM plans WHERE slug = $1`, [planSlug]);
    if (!plan) throw badRequest(`Unknown plan: ${planSlug}`);

    const included = new Set(
      (await db.rows(`SELECT app_slug FROM plan_apps WHERE plan_slug = $1`, [planSlug])).map(
        (r) => r.app_slug,
      ),
    );

    const prices = await db.rows(`SELECT * FROM app_prices WHERE app_slug = ANY($1)`, [appSlugs]);
    const byslug = new Map(prices.map((p) => [p.app_slug, p]));

    const apps = appSlugs.map((slug) => {
      const price = byslug.get(slug);
      const definition = appBySlug(slug);
      if (!price || !definition) throw badRequest(`Unknown app: ${slug}`);
      return {
        slug,
        name: definition.name,
        price_monthly: price.price_monthly,
        price_annual: price.price_annual,
        billing_unit: price.billing_unit,
        included_in_plan: included.has(slug),
      };
    });

    return { plan, apps, included };
  }

  // ═══════════════════════════════════════════════════════ PLANS + PRICE QUOTE
  app.get('/plans', async () => {
    const plans = await db.rows(`SELECT * FROM plans WHERE is_public = true ORDER BY sort_order`);
    const planApps = await db.rows(`SELECT * FROM plan_apps`);
    const prices = await db.rows(`SELECT * FROM app_prices ORDER BY app_slug`);

    return {
      data: plans.map((p) => ({
        ...p,
        included_apps: planApps.filter((pa) => pa.plan_slug === p.slug).map((pa) => pa.app_slug),
      })),
      meta: { app_prices: prices },
    };
  });

  /** Live price preview for the onboarding and marketplace screens. */
  app.post(
    '/subscriptions/quote',
    {
      schema: {
        body: body(
          {
            plan: v.slug,
            app_slugs: { type: 'array', items: v.slug, maxItems: 30, default: [] },
            seats: v.int(1, 100000),
            cycle: v.enum(['monthly', 'annual']),
          },
          ['plan'],
        ),
      },
    },
    async (request) => {
      const seats = request.body.seats ?? 5;
      const cycle = request.body.cycle ?? 'monthly';
      const requested = resolveDependencies(request.body.app_slugs ?? []);

      const { plan, apps } = await loadPricing(request.body.plan, requested);

      if (plan.max_users && seats > plan.max_users) {
        throw badRequest(`The ${plan.name} plan supports up to ${plan.max_users} users.`, {
          code: 'seat_limit',
          max_users: plan.max_users,
        });
      }

      const monthly = quote({ plan, apps, seats, cycle: 'monthly' });
      const annual = quote({ plan, apps, seats, cycle: 'annual' });
      const saving = (Number(monthly.total) * 12 - Number(annual.total)).toFixed(2);

      const chosen = cycle === 'annual' ? annual : monthly;

      return {
        data: {
          ...chosen,
          plan: { slug: plan.slug, name: plan.name, included_users: plan.included_users },
          apps: requested,
          auto_added: requested.filter((s) => !(request.body.app_slugs ?? []).includes(s)),
          compare: {
            monthly_total: monthly.total,
            annual_total: annual.total,
            annual_saving: saving,
            annual_saving_percent: Math.round((Number(saving) / (Number(monthly.total) * 12)) * 100) || 0,
          },
        },
      };
    },
  );

  // ════════════════════════════════════════════════════════════════ SUBSCRIBE
  app.post(
    '/subscriptions',
    {
      preHandler: app.authenticateOrg,
      schema: {
        body: body(
          {
            plan: v.slug,
            app_slugs: { type: 'array', items: v.slug, maxItems: 30, default: [] },
            seats: v.int(1, 100000),
            cycle: v.enum(['monthly', 'annual']),
          },
          ['plan'],
        ),
      },
    },
    async (request, reply) => {
      const orgId = request.auth.orgId;
      const actorId = request.auth.userId;

      const existing = await db.one(
        `SELECT id FROM subscriptions WHERE org_id = $1 AND status <> 'canceled'`,
        [orgId],
      );
      if (existing) {
        throw badRequest('This workspace already has a subscription. Change it instead.', {
          code: 'already_subscribed',
        });
      }

      const seats = request.body.seats ?? 5;
      const cycle = request.body.cycle ?? 'monthly';
      const requested = resolveDependencies(request.body.app_slugs ?? []);
      const { plan, apps, included } = await loadPricing(request.body.plan, requested);

      if (plan.max_users && seats > plan.max_users) {
        throw badRequest(`The ${plan.name} plan supports up to ${plan.max_users} users.`);
      }

      const priced = quote({ plan, apps, seats, cycle });

      const subscription = await db.transaction(async (tx) => {
        const now = new Date();
        const trialEnds = new Date(now.getTime() + plan.trial_days * 86_400_000);

        const created = await tx.one(
          `INSERT INTO subscriptions
             (id, org_id, plan_slug, status, billing_cycle, currency, seats,
              trial_ends_at, current_period_start, current_period_end)
           VALUES ($1, $2, $3, 'trialing', $4, $5, $6, $7, $8, $9)
           RETURNING *`,
          [
            id('sub'), orgId, plan.slug, cycle, plan.currency, seats,
            trialEnds, now, periodEnd(now, cycle),
          ],
        );

        for (const appItem of apps) {
          await tx.query(
            `INSERT INTO subscription_items
               (id, org_id, subscription_id, app_slug, quantity, unit_price, billing_unit, source)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              id('sit'), orgId, created.id, appItem.slug,
              appItem.billing_unit === 'user' ? seats : 1,
              included.has(appItem.slug)
                ? 0
                : cycle === 'annual' ? appItem.price_annual : appItem.price_monthly,
              appItem.billing_unit,
              included.has(appItem.slug) ? 'plan' : 'addon',
            ],
          );
        }

        await recomputeEntitlements(tx, orgId, { actorId });

        tx.emit({
          type: EVENTS.SUBSCRIPTION_CREATED,
          org_id: orgId,
          actor_id: actorId,
          data: {
            subscription_id: created.id,
            plan: plan.slug,
            apps: requested,
            seats,
            cycle,
            trial_ends_at: trialEnds,
            total: priced.total,
          },
        });

        return created;
      });

      // Turn the purchase into a working workspace right away.
      await catalog.provision(orgId, requested, actorId);

      return reply.status(201).send({
        data: { subscription: shape(subscription), apps: requested, quote: priced },
      });
    },
  );

  // ══════════════════════════════════════════════════════════════════ CURRENT
  app.get('/subscriptions/current', { preHandler: app.authenticateOrg }, async (request) => {
    const orgId = request.auth.orgId;

    const subscription = await db.one(
      `SELECT s.*, p.name AS plan_name, p.included_users, p.storage_gb, p.extra_user_price, p.features
         FROM subscriptions s JOIN plans p ON p.slug = s.plan_slug
        WHERE s.org_id = $1 AND s.status <> 'canceled'`,
      [orgId],
    );
    if (!subscription) return { data: null };

    const items = await db.rows(
      `SELECT si.*, a.price_monthly, a.price_annual
         FROM subscription_items si
         LEFT JOIN app_prices a ON a.app_slug = si.app_slug
        WHERE si.subscription_id = $1 AND si.removed_at IS NULL
        ORDER BY si.added_at`,
      [subscription.id],
    );

    const invoices = await db.rows(
      `SELECT id, number, status, total, currency, period_start, period_end, due_at, paid_at, created_at
         FROM invoices WHERE org_id = $1 ORDER BY created_at DESC LIMIT 12`,
      [orgId],
    );

    const daysLeft = subscription.trial_ends_at
      ? Math.ceil((new Date(subscription.trial_ends_at) - Date.now()) / 86_400_000)
      : null;

    return {
      data: {
        ...shape(subscription),
        plan_name: subscription.plan_name,
        included_users: subscription.included_users,
        storage_gb: subscription.storage_gb,
        plan_features: subscription.features,
        trial_days_left: daysLeft !== null && daysLeft > 0 ? daysLeft : 0,
        items: items.map((i) => ({
          id: i.id,
          app_slug: i.app_slug,
          name: appBySlug(i.app_slug)?.name ?? i.app_slug,
          quantity: i.quantity,
          unit_price: i.unit_price,
          billing_unit: i.billing_unit,
          source: i.source,
          added_at: i.added_at,
        })),
        invoices,
      },
    };
  });

  // ══════════════════════════════════════════════════════ ADD / REMOVE AN APP
  app.post(
    '/subscriptions/current/apps',
    {
      preHandler: app.authenticateOrg,
      schema: { body: body({ app_slug: v.slug }, ['app_slug']) },
    },
    async (request) => {
      const orgId = request.auth.orgId;
      const actorId = request.auth.userId;
      const slug = request.body.app_slug;

      const subscription = await db.one(
        `SELECT * FROM subscriptions WHERE org_id = $1 AND status <> 'canceled'`,
        [orgId],
      );
      if (!subscription) throw badRequest('This workspace has no active subscription.');

      const definition = appBySlug(slug);
      if (!definition) throw notFound('App');
      if (definition.status === 'coming_soon') {
        throw badRequest(`${definition.name} is not available yet.`);
      }

      const chain = resolveDependencies([slug]);
      const existing = new Set(
        (
          await db.rows(
            `SELECT app_slug FROM subscription_items WHERE subscription_id = $1 AND removed_at IS NULL`,
            [subscription.id],
          )
        ).map((r) => r.app_slug),
      );

      const toAdd = chain.filter((s) => !existing.has(s));
      if (!toAdd.length) throw badRequest(`${definition.name} is already on your subscription.`);

      const { plan, apps, included } = await loadPricing(subscription.plan_slug, toAdd);
      const priced = quote({ plan, apps, seats: subscription.seats, cycle: subscription.billing_cycle });

      await db.transaction(async (tx) => {
        for (const appItem of apps) {
          await tx.query(
            `INSERT INTO subscription_items
               (id, org_id, subscription_id, app_slug, quantity, unit_price, billing_unit, source)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              id('sit'), orgId, subscription.id, appItem.slug,
              appItem.billing_unit === 'user' ? subscription.seats : 1,
              included.has(appItem.slug)
                ? 0
                : subscription.billing_cycle === 'annual' ? appItem.price_annual : appItem.price_monthly,
              appItem.billing_unit,
              included.has(appItem.slug) ? 'plan' : 'addon',
            ],
          );
        }

        await recomputeEntitlements(tx, orgId, { actorId });

        tx.emit({
          type: EVENTS.SUBSCRIPTION_UPDATED,
          org_id: orgId,
          actor_id: actorId,
          data: { action: 'app_added', app_slug: slug, also_added: toAdd.filter((s) => s !== slug) },
        });
      });

      await catalog.provision(orgId, [...existing, ...toAdd], actorId);

      return {
        data: {
          added: toAdd,
          // Charged from the next invoice; nothing is taken today.
          added_to_next_invoice: priced.total,
          effective: 'immediately',
        },
      };
    },
  );

  app.delete(
    '/subscriptions/current/apps/:slug',
    {
      preHandler: app.authenticateOrg,
      schema: { params: { type: 'object', properties: { slug: v.slug }, required: ['slug'] } },
    },
    async (request) => {
      const orgId = request.auth.orgId;
      const actorId = request.auth.userId;
      const slug = request.params.slug;

      const subscription = await db.one(
        `SELECT * FROM subscriptions WHERE org_id = $1 AND status <> 'canceled'`,
        [orgId],
      );
      if (!subscription) throw badRequest('This workspace has no active subscription.');

      const remaining = (
        await db.rows(
          `SELECT app_slug FROM subscription_items WHERE subscription_id = $1 AND removed_at IS NULL`,
          [subscription.id],
        )
      ).map((r) => r.app_slug);

      if (!remaining.includes(slug)) throw notFound('Subscription item');

      // Do not strand an app that still needs this one.
      const dependents = remaining.filter((other) =>
        (appBySlug(other)?.dependencies ?? []).includes(slug),
      );
      if (dependents.length) {
        throw badRequest(
          `${dependents.map((d) => appBySlug(d)?.name ?? d).join(', ')} still ${
            dependents.length === 1 ? 'needs' : 'need'
          } this app. Remove ${dependents.length === 1 ? 'it' : 'them'} first.`,
          { blocked_by: dependents },
        );
      }

      await db.transaction(async (tx) => {
        await tx.query(
          `UPDATE subscription_items SET removed_at = now()
            WHERE subscription_id = $1 AND app_slug = $2 AND removed_at IS NULL`,
          [subscription.id, slug],
        );
        await recomputeEntitlements(tx, orgId, { actorId });
        tx.emit({
          type: EVENTS.SUBSCRIPTION_UPDATED,
          org_id: orgId,
          actor_id: actorId,
          data: { action: 'app_removed', app_slug: slug },
        });
      });

      await catalog.provision(orgId, remaining.filter((s) => s !== slug), actorId);

      return { data: { removed: slug, data_retained_days: 30 } };
    },
  );

  // ══════════════════════════════════════════════════════ CHANGE PLAN / SEATS
  app.patch(
    '/subscriptions/current',
    {
      preHandler: app.authenticateOrg,
      schema: {
        body: body({
          plan: v.slug,
          seats: v.int(1, 100000),
          cycle: v.enum(['monthly', 'annual']),
          cancel_at_period_end: { type: 'boolean' },
        }),
      },
    },
    async (request) => {
      const orgId = request.auth.orgId;
      const actorId = request.auth.userId;

      const subscription = await db.one(
        `SELECT * FROM subscriptions WHERE org_id = $1 AND status <> 'canceled'`,
        [orgId],
      );
      if (!subscription) throw badRequest('This workspace has no active subscription.');

      const nextPlanSlug = request.body.plan ?? subscription.plan_slug;
      const plan = await db.one(`SELECT * FROM plans WHERE slug = $1`, [nextPlanSlug]);
      if (!plan) throw badRequest(`Unknown plan: ${nextPlanSlug}`);

      const seats = request.body.seats ?? subscription.seats;
      if (plan.max_users && seats > plan.max_users) {
        throw badRequest(`The ${plan.name} plan supports up to ${plan.max_users} users.`);
      }

      const updated = await db.transaction(async (tx) => {
        const row = await tx.one(
          `UPDATE subscriptions
              SET plan_slug = $2, seats = $3, billing_cycle = $4,
                  cancel_at_period_end = COALESCE($5, cancel_at_period_end)
            WHERE id = $1 RETURNING *`,
          [
            subscription.id, nextPlanSlug, seats,
            request.body.cycle ?? subscription.billing_cycle,
            request.body.cancel_at_period_end ?? null,
          ],
        );

        // Per-user lines follow the seat count.
        await tx.query(
          `UPDATE subscription_items SET quantity = $2
            WHERE subscription_id = $1 AND billing_unit = 'user' AND removed_at IS NULL`,
          [subscription.id, seats],
        );

        await recomputeEntitlements(tx, orgId, { actorId });

        tx.emit({
          type: EVENTS.SUBSCRIPTION_UPDATED,
          org_id: orgId,
          actor_id: actorId,
          data: {
            action: 'plan_changed',
            from: subscription.plan_slug,
            to: nextPlanSlug,
            seats,
            cycle: row.billing_cycle,
          },
        });

        return row;
      });

      return { data: shape(updated) };
    },
  );

  app.post(
    '/subscriptions/current/cancel',
    {
      preHandler: app.authenticateOrg,
      schema: { body: body({ reason: v.text(500), immediate: { type: 'boolean', default: false } }) },
    },
    async (request) => {
      const orgId = request.auth.orgId;
      const actorId = request.auth.userId;

      const subscription = await db.one(
        `SELECT * FROM subscriptions WHERE org_id = $1 AND status <> 'canceled'`,
        [orgId],
      );
      if (!subscription) throw badRequest('This workspace has no active subscription.');

      const immediate = request.body?.immediate ?? false;

      const updated = await db.transaction(async (tx) => {
        const row = await tx.one(
          `UPDATE subscriptions
              SET status = CASE WHEN $2 THEN 'canceled' ELSE status END,
                  cancel_at_period_end = true,
                  canceled_at = now(),
                  cancellation_reason = $3
            WHERE id = $1 RETURNING *`,
          [subscription.id, immediate, request.body?.reason ?? null],
        );

        if (immediate) await recomputeEntitlements(tx, orgId, { actorId });

        tx.emit({
          type: EVENTS.SUBSCRIPTION_CANCELED,
          org_id: orgId,
          actor_id: actorId,
          data: {
            subscription_id: subscription.id,
            immediate,
            access_until: immediate ? new Date().toISOString() : subscription.current_period_end,
            reason: request.body?.reason,
          },
        });

        return row;
      });

      return {
        data: {
          canceled: true,
          // Cancelling never deletes data — that would be hostile.
          access_until: immediate ? new Date().toISOString() : updated.current_period_end,
          data_retained_days: 90,
        },
      };
    },
  );
}

function shape(s) {
  return {
    id: s.id,
    plan: s.plan_slug,
    status: s.status,
    cycle: s.billing_cycle,
    currency: s.currency,
    seats: s.seats,
    trial_ends_at: s.trial_ends_at,
    current_period_start: s.current_period_start,
    current_period_end: s.current_period_end,
    cancel_at_period_end: s.cancel_at_period_end,
    created_at: s.created_at,
  };
}
