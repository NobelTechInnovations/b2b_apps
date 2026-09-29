import { id } from '@nexus/db-kit';
import { requirePermission, body, validate as v, notFound, badRequest } from '@nexus/service-kit';
import { appBySlug, resolveDependencies } from '@nexus/contracts';
import { EVENTS } from '@nexus/contracts/events';
import { quote } from '../lib/pricing.js';
import { recomputeEntitlements } from '../lib/entitlements.js';
import {
  issueTermInvoice, issueAdjustment, priceSubscription, subscribedApps, shapeInvoice,
} from '../lib/invoices.js';

export async function subscriptionRoutes(app) {
  const { db, catalog, config, razorpay } = app;

  /** A plan a customer may choose today. Retired plans only live on as history. */
  async function offeredPlan(slug) {
    const plan = await db.one(`SELECT * FROM plans WHERE slug = $1 AND is_public AND NOT is_retired`, [slug]);
    if (!plan) throw badRequest(`Unknown plan: ${slug}`, { code: 'unknown_plan' });
    return plan;
  }

  /** Released, non-core apps with their names, in the order given. */
  function releasedApps(slugs) {
    return slugs
      .filter((slug) => slug !== 'core')
      .map((slug) => {
        const definition = appBySlug(slug);
        if (!definition) throw badRequest(`Unknown app: ${slug}`);
        if (definition.status === 'coming_soon') throw badRequest(`${definition.name} is not available yet.`);
        return { slug, name: definition.name };
      });
  }

  /** A plan's seats are a floor: 5 people on Basic still get its 10 seats. */
  const seatsFor = (plan, requested) => Math.max(Number(plan.included_users), requested ?? 0);

  async function current(orgId, store = db, lock = false) {
    return store.one(
      `SELECT * FROM subscriptions WHERE org_id = $1 AND status <> 'canceled'${lock ? ' FOR UPDATE' : ''}`,
      [orgId],
    );
  }

  async function seatUsage(orgId) {
    const response = await fetch(`${config.tenancyUrl}/internal/orgs/${orgId}/stats`, {
      headers: { 'x-nexus-service-token': config.serviceToken },
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) throw app.httpErrors.serviceUnavailable('Could not check how many seats are in use.');
    const stats = (await response.json()).data;
    return Number(stats.active_members ?? 0) + Number(stats.pending_invitations ?? 0);
  }

  /**
   * After any change to plan, seats or apps: a paid term is charged the
   * prorated difference now; an unpaid term's invoice is re-issued at the new
   * price. The upcoming renewal, if already raised, is re-priced too.
   */
  async function afterChange(tx, subscriptionId, before, reason) {
    const fresh = await tx.one(`SELECT * FROM subscriptions WHERE id = $1`, [subscriptionId]);
    if (fresh.status === 'active') {
      // The paid term keeps the cycle it was bought on; a cycle change only
      // applies from the next term. So the mid-term difference is priced on
      // the term's own cycle, the same one `before` was priced on.
      const after = await priceSubscription(tx, fresh, { cycle: before.cycle });
      const adjustment = await issueAdjustment(tx, fresh, { before, after, reason });
      const renewal = await tx.one(
        `SELECT 1 FROM invoices WHERE subscription_id = $1 AND status = 'open' AND kind = 'renewal'`,
        [fresh.id],
      );
      if (renewal) await issueTermInvoice(tx, fresh);
      return adjustment;
    }
    await issueTermInvoice(tx, fresh);
    return null;
  }

  // ═══════════════════════════════════════════════════════ PLANS + PRICE QUOTE
  app.get('/plans', async () => {
    const plans = await db.rows(
      `SELECT * FROM plans WHERE is_public AND NOT is_retired ORDER BY sort_order`,
    );
    return {
      data: plans.map((p) => ({ ...p, included_apps: [] })),
      meta: { app_prices: [], currency: 'INR', gst_rate: Number(process.env.BILLING_GST_RATE ?? 0.18) },
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
            app_slugs: { type: 'array', items: v.slug, maxItems: 40, default: [] },
            seats: v.int(1, 100000),
            cycle: v.enum(['monthly', 'annual']),
          },
          ['plan'],
        ),
      },
    },
    async (request) => {
      const plan = await offeredPlan(request.body.plan);
      const seats = seatsFor(plan, request.body.seats);
      const cycle = request.body.cycle ?? 'monthly';
      const requested = resolveDependencies(request.body.app_slugs ?? []);
      const apps = releasedApps(requested);

      const monthly = quote({ plan, apps, seats, cycle: 'monthly' });
      const annual = quote({ plan, apps, seats, cycle: 'annual' });
      const saving = (Number(monthly.total) * 12 - Number(annual.total)).toFixed(2);
      const chosen = cycle === 'annual' ? annual : monthly;

      return {
        data: {
          ...chosen,
          plan: {
            slug: plan.slug,
            name: plan.name,
            included_users: plan.included_users,
            included_app_count: plan.included_app_count,
            extra_user_price: plan.extra_user_price,
            extra_app_price: plan.extra_app_price,
            trial_days: plan.trial_days,
          },
          apps: requested.filter((slug) => slug !== 'core'),
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
      preHandler: [app.loadContext, requirePermission('billing.subscription.manage')],
      schema: {
        body: body(
          {
            plan: v.slug,
            app_slugs: { type: 'array', items: v.slug, maxItems: 40, default: [] },
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

      const plan = await offeredPlan(request.body.plan);
      const seats = seatsFor(plan, request.body.seats);
      const cycle = request.body.cycle ?? 'monthly';
      const requested = resolveDependencies(request.body.app_slugs ?? []);
      const apps = releasedApps(requested);
      const priced = quote({ plan, apps, seats, cycle });

      const { subscription, invoice } = await db.transaction(async (tx) => {
        // Serialise per workspace so two tabs cannot both subscribe.
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`billing:${orgId}`]);
        if (await current(orgId, tx)) {
          throw badRequest('This workspace already has a subscription. Change it instead.', {
            code: 'already_subscribed',
          });
        }

        const now = new Date();
        const trial = Number(plan.trial_days) > 0;
        const trialEnds = trial ? new Date(now.getTime() + plan.trial_days * 86_400_000) : null;

        // Until the first invoice is paid, the "current period" is the trial
        // (or nothing at all), never a paid month that nobody paid for.
        const created = await tx.one(
          `INSERT INTO subscriptions
             (id, org_id, plan_slug, status, billing_cycle, currency, seats,
              trial_ends_at, current_period_start, current_period_end)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING *`,
          [
            id('sub'), orgId, plan.slug, trial ? 'trialing' : 'incomplete', cycle, plan.currency, seats,
            trialEnds, now, trialEnds ?? now,
          ],
        );

        for (const appItem of apps) {
          await tx.query(
            `INSERT INTO subscription_items
               (id, org_id, subscription_id, app_slug, quantity, unit_price, billing_unit, source)
             VALUES ($1, $2, $3, $4, 1, 0, 'org', 'addon')`,
            [id('sit'), orgId, created.id, appItem.slug],
          );
        }

        await recomputeEntitlements(tx, orgId, { actorId });
        const firstInvoice = await issueTermInvoice(tx, created);

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

        return { subscription: created, invoice: firstInvoice };
      });

      // Turn the purchase into a working workspace right away.
      await catalog.provision(orgId, requested, actorId);

      return reply.status(201).send({
        data: {
          subscription: shape(subscription),
          apps: requested,
          quote: priced,
          invoice: invoice ? shapeInvoice(invoice) : null,
          payment_required_now: subscription.status === 'incomplete',
        },
      });
    },
  );

  // ══════════════════════════════════════════════════════════════════ CURRENT
  app.get('/subscriptions/current', { preHandler: [app.loadContext, requirePermission('billing.subscription.view')] }, async (request) => {
    const orgId = request.auth.orgId;

    const subscription = await db.one(
      `SELECT s.*, p.name AS plan_name, p.included_users, p.storage_gb, p.extra_user_price,
              p.included_app_count, p.extra_app_price, p.features, p.base_price_monthly, p.annual_months,
              p.is_retired
         FROM subscriptions s JOIN plans p ON p.slug = s.plan_slug
        WHERE s.org_id = $1 AND s.status <> 'canceled'`,
      [orgId],
    );
    if (!subscription) return { data: null };

    const items = await db.rows(
      `SELECT * FROM subscription_items
        WHERE subscription_id = $1 AND removed_at IS NULL
        ORDER BY added_at, app_slug`,
      [subscription.id],
    );

    const invoices = await db.rows(
      `SELECT * FROM invoices WHERE org_id = $1 AND status <> 'void' ORDER BY created_at DESC LIMIT 24`,
      [orgId],
    );

    const term = await priceSubscription(db, subscription);
    const daysLeft = subscription.trial_ends_at
      ? Math.ceil((new Date(subscription.trial_ends_at) - Date.now()) / 86_400_000)
      : null;
    const open = invoices.filter((i) => i.status === 'open');

    return {
      data: {
        ...shape(subscription),
        plan_name: subscription.plan_name,
        plan_retired: subscription.is_retired,
        included_users: subscription.included_users,
        included_app_count: subscription.included_app_count,
        extra_user_price: subscription.extra_user_price,
        extra_app_price: subscription.extra_app_price,
        base_price_monthly: subscription.base_price_monthly,
        storage_gb: subscription.storage_gb,
        plan_features: subscription.features,
        trial_days_left: daysLeft !== null && daysLeft > 0 ? daysLeft : 0,
        term_quote: term,
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
        invoices: invoices.map(shapeInvoice),
        amount_due: open.reduce((sum, i) => sum + Number(i.total), 0).toFixed(2),
        next_due_invoice: open.length
          ? shapeInvoice([...open].sort((a, b) => new Date(a.due_at) - new Date(b.due_at))[0])
          : null,
        payments: {
          provider: razorpay.configured ? 'razorpay' : config.billingTestMode ? 'test' : null,
          razorpay_key_id: razorpay.configured ? razorpay.keyId : null,
        },
      },
    };
  });

  // ══════════════════════════════════════════════════════ ADD / REMOVE AN APP
  app.post(
    '/subscriptions/current/apps',
    {
      preHandler: [app.loadContext, requirePermission('billing.subscription.manage')],
      schema: { body: body({ app_slug: v.slug }, ['app_slug']) },
    },
    async (request) => {
      const orgId = request.auth.orgId;
      const actorId = request.auth.userId;
      const slug = request.body.app_slug;

      const definition = appBySlug(slug);
      if (!definition || definition.core) throw notFound('App');
      if (definition.status === 'coming_soon') {
        throw badRequest(`${definition.name} is not available yet.`);
      }

      const result = await db.transaction(async (tx) => {
        const subscription = await current(orgId, tx, true);
        if (!subscription) throw badRequest('This workspace has no active subscription.');

        const existing = new Set((await subscribedApps(tx, subscription.id)).map((a) => a.slug));
        const toAdd = resolveDependencies([slug]).filter((s) => s !== 'core' && !existing.has(s));
        if (!toAdd.length) throw badRequest(`${definition.name} is already on your subscription.`);
        releasedApps(toAdd);

        const before = await priceSubscription(tx, subscription);
        for (const appSlug of toAdd) {
          await tx.query(
            `INSERT INTO subscription_items
               (id, org_id, subscription_id, app_slug, quantity, unit_price, billing_unit, source)
             VALUES ($1, $2, $3, $4, 1, 0, 'org', 'addon')`,
            [id('sit'), orgId, subscription.id, appSlug],
          );
        }

        await recomputeEntitlements(tx, orgId, { actorId });
        const adjustment = await afterChange(tx, subscription.id, before, `Added ${toAdd.map((s) => appBySlug(s)?.name ?? s).join(', ')}`);

        tx.emit({
          type: EVENTS.SUBSCRIPTION_UPDATED,
          org_id: orgId,
          actor_id: actorId,
          data: { action: 'app_added', app_slug: slug, also_added: toAdd.filter((s) => s !== slug) },
        });

        const after = await priceSubscription(tx, { ...subscription });
        return { toAdd, existing, adjustment, after };
      });

      await catalog.provision(orgId, [...result.existing, ...result.toAdd], actorId);

      return {
        data: {
          added: result.toAdd,
          effective: 'immediately',
          app_count: result.after.app_count,
          extra_app_count: result.after.extra_app_count,
          term_total: result.after.total,
          adjustment_invoice: result.adjustment ? shapeInvoice(result.adjustment) : null,
        },
      };
    },
  );

  app.delete(
    '/subscriptions/current/apps/:slug',
    {
      preHandler: [app.loadContext, requirePermission('billing.subscription.manage')],
      schema: { params: { type: 'object', properties: { slug: v.slug }, required: ['slug'] } },
    },
    async (request) => {
      const orgId = request.auth.orgId;
      const actorId = request.auth.userId;
      const slug = request.params.slug;

      const remaining = await db.transaction(async (tx) => {
        const subscription = await current(orgId, tx, true);
        if (!subscription) throw badRequest('This workspace has no active subscription.');

        const slugs = (await subscribedApps(tx, subscription.id)).map((a) => a.slug);
        if (!slugs.includes(slug)) throw notFound('Subscription item');

        // Do not strand an app that still needs this one.
        const dependents = slugs.filter((other) => (appBySlug(other)?.dependencies ?? []).includes(slug));
        if (dependents.length) {
          throw badRequest(
            `${dependents.map((d) => appBySlug(d)?.name ?? d).join(', ')} still ${
              dependents.length === 1 ? 'needs' : 'need'
            } this app. Remove ${dependents.length === 1 ? 'it' : 'them'} first.`,
            { blocked_by: dependents },
          );
        }

        const before = await priceSubscription(tx, subscription);
        await tx.query(
          `UPDATE subscription_items SET removed_at = now()
            WHERE subscription_id = $1 AND app_slug = $2 AND removed_at IS NULL`,
          [subscription.id, slug],
        );
        await recomputeEntitlements(tx, orgId, { actorId });
        await afterChange(tx, subscription.id, before, 'App removed');
        tx.emit({
          type: EVENTS.SUBSCRIPTION_UPDATED,
          org_id: orgId,
          actor_id: actorId,
          data: { action: 'app_removed', app_slug: slug },
        });
        return slugs.filter((s) => s !== slug);
      });

      await catalog.provision(orgId, remaining, actorId);

      return { data: { removed: slug, data_retained_days: 30 } };
    },
  );

  // ══════════════════════════════════════════════════════ CHANGE PLAN / SEATS
  app.patch(
    '/subscriptions/current',
    {
      preHandler: [app.loadContext, requirePermission('billing.subscription.manage')],
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
      const existing = await current(orgId);
      if (!existing) throw badRequest('This workspace has no active subscription.');

      const plan = request.body.plan && request.body.plan !== existing.plan_slug
        ? await offeredPlan(request.body.plan)
        : await db.one(`SELECT * FROM plans WHERE slug = $1`, [existing.plan_slug]);
      const seats = seatsFor(plan, request.body.seats ?? existing.seats);

      // Fewer seats than people is not a saving, it is a lock-out.
      if (seats < existing.seats) {
        const used = await seatUsage(orgId);
        if (seats < used) {
          throw badRequest(
            `${used} seats are in use (members and pending invitations). Remove people before reducing seats below that.`,
            { code: 'seats_in_use', in_use: used },
          );
        }
      }

      const { row, adjustment } = await db.transaction(async (tx) => {
        const subscription = await current(orgId, tx, true);
        const before = await priceSubscription(tx, subscription);
        const updated = await tx.one(
          `UPDATE subscriptions
              SET plan_slug = $2, seats = $3, billing_cycle = $4,
                  cancel_at_period_end = COALESCE($5, cancel_at_period_end)
            WHERE id = $1 RETURNING *`,
          [
            subscription.id, plan.slug, seats,
            request.body.cycle ?? subscription.billing_cycle,
            request.body.cancel_at_period_end ?? null,
          ],
        );

        await recomputeEntitlements(tx, orgId, { actorId });

        const charge = await afterChange(
          tx,
          subscription.id,
          before,
          plan.slug !== subscription.plan_slug ? `Changed to the ${plan.name} plan` : `Seats changed to ${seats}`,
        );

        tx.emit({
          type: EVENTS.SUBSCRIPTION_UPDATED,
          org_id: orgId,
          actor_id: actorId,
          data: {
            action: 'plan_changed',
            from: subscription.plan_slug,
            to: plan.slug,
            seats,
            cycle: updated.billing_cycle,
          },
        });

        return { row: updated, adjustment: charge };
      });

      return { data: { ...shape(row), adjustment_invoice: adjustment ? shapeInvoice(adjustment) : null } };
    },
  );

  app.post(
    '/subscriptions/current/cancel',
    {
      preHandler: [app.loadContext, requirePermission('billing.subscription.manage')],
      schema: { body: body({ reason: v.text(500), immediate: { type: 'boolean', default: false } }) },
    },
    async (request) => {
      const orgId = request.auth.orgId;
      const actorId = request.auth.userId;

      const subscription = await current(orgId);
      if (!subscription) throw badRequest('This workspace has no active subscription.');

      // Nothing was paid for yet, so there is nothing to run out: end it now.
      const immediate = (request.body?.immediate ?? false) || ['trialing', 'incomplete'].includes(subscription.status);

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

        // No renewal will be needed; an unpaid first term never will be either.
        await tx.query(
          `UPDATE invoices SET status = 'void', voided_at = now(), updated_at = now()
            WHERE subscription_id = $1 AND status = 'open' AND kind IN ('subscription', 'renewal')`,
          [subscription.id],
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

  /** Undo a scheduled cancellation while the paid term is still running. */
  app.post(
    '/subscriptions/current/resume',
    { preHandler: [app.loadContext, requirePermission('billing.subscription.manage')] },
    async (request) => {
      const orgId = request.auth.orgId;
      const row = await db.transaction(async (tx) => {
        const subscription = await current(orgId, tx, true);
        if (!subscription?.cancel_at_period_end) throw badRequest('Nothing to resume.');
        const updated = await tx.one(
          `UPDATE subscriptions SET cancel_at_period_end = false, canceled_at = NULL, cancellation_reason = NULL
            WHERE id = $1 RETURNING *`,
          [subscription.id],
        );
        return updated;
      });
      return { data: shape(row) };
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
