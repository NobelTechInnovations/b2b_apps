import { APPS } from '@nexus/contracts';

/**
 * Plans are the commercial packaging. Apps are not priced one by one: a plan
 * buys the workspace, a number of seats and a number of apps. Seats and apps
 * beyond that are flat monthly add-ons. Every period is paid in advance.
 *
 *   Basic      ₹1,599 / month · 10 seats · any 5 apps
 *   Business   ₹2,599 / month · 20 seats · any 5 apps
 *   Add-ons    ₹259 per extra seat · ₹99 per app beyond the fifth (monthly)
 *
 * Annual terms charge `annual_months` (10) months for twelve.
 */
const EXTRA_SEAT = 259;
const EXTRA_APP = 99;

export const PLANS = [
  {
    slug: 'basic',
    name: 'Basic',
    tagline: 'For small teams getting organised',
    description: '10 seats and any 5 apps. Add seats or apps whenever you need them.',
    base_price_monthly: 1599,
    included_users: 10,
    extra_user_price: EXTRA_SEAT,
    included_app_count: 5,
    extra_app_price: EXTRA_APP,
    max_users: null,
    storage_gb: 25,
    trial_days: 14,
    features: [
      '10 seats included',
      'Any 5 apps included',
      `₹${EXTRA_SEAT} per extra seat / month`,
      `₹${EXTRA_APP} per extra app / month`,
      '25 GB storage',
      'Email support',
    ],
    included_apps: [],
    sort_order: 1,
  },
  {
    slug: 'business',
    name: 'Business',
    tagline: 'For growing teams that run on Nexus',
    description: '20 seats and any 5 apps, at a lower price per seat.',
    base_price_monthly: 2599,
    included_users: 20,
    extra_user_price: EXTRA_SEAT,
    included_app_count: 5,
    extra_app_price: EXTRA_APP,
    max_users: null,
    storage_gb: 100,
    trial_days: 14,
    features: [
      '20 seats included',
      'Any 5 apps included',
      `₹${EXTRA_SEAT} per extra seat / month`,
      `₹${EXTRA_APP} per extra app / month`,
      '100 GB storage',
      'Priority support',
    ],
    included_apps: [],
    sort_order: 2,
  },
];

/** Earlier packaging. Kept so old subscriptions still resolve; never offered. */
const RETIRED = ['starter', 'growth', 'scale'];

/** Seed plans and per-app prices. App prices default to the registry. */
export async function seedPlans(db, logger) {
  for (const plan of PLANS) {
    const annualMonths = plan.annual_months ?? 10;
    // TRIAL_DAYS overrides every plan: 0 means "pay before you start".
    const trialDays = process.env.TRIAL_DAYS !== undefined && process.env.TRIAL_DAYS !== ''
      ? Math.max(0, Number(process.env.TRIAL_DAYS) || 0)
      : plan.trial_days;
    await db.query(
      `INSERT INTO plans (slug, name, tagline, description, base_price_monthly, base_price_annual,
                          included_users, extra_user_price, max_users, storage_gb, trial_days,
                          features, sort_order, included_app_count, extra_app_price, annual_months,
                          is_public, is_retired)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,true,false)
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name, tagline = EXCLUDED.tagline, description = EXCLUDED.description,
         base_price_monthly = EXCLUDED.base_price_monthly,
         base_price_annual = EXCLUDED.base_price_annual,
         included_users = EXCLUDED.included_users, extra_user_price = EXCLUDED.extra_user_price,
         max_users = EXCLUDED.max_users, storage_gb = EXCLUDED.storage_gb,
         trial_days = EXCLUDED.trial_days, features = EXCLUDED.features,
         sort_order = EXCLUDED.sort_order, included_app_count = EXCLUDED.included_app_count,
         extra_app_price = EXCLUDED.extra_app_price, annual_months = EXCLUDED.annual_months,
         is_public = true, is_retired = false`,
      [
        plan.slug, plan.name, plan.tagline, plan.description,
        plan.base_price_monthly, plan.base_price_monthly * annualMonths, plan.included_users,
        plan.extra_user_price, plan.max_users, plan.storage_gb, trialDays,
        JSON.stringify(plan.features), plan.sort_order, plan.included_app_count,
        plan.extra_app_price, annualMonths,
      ],
    );

    await db.query(`DELETE FROM plan_apps WHERE plan_slug = $1`, [plan.slug]);
    for (const appSlug of plan.included_apps) {
      await db.query(
        `INSERT INTO plan_apps (plan_slug, app_slug) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [plan.slug, appSlug],
      );
    }
  }

  await db.query(
    `UPDATE plans SET is_public = false, is_retired = true WHERE slug = ANY($1)`,
    [RETIRED],
  );

  for (const app of APPS) {
    if (app.core) continue;
    await db.query(
      `INSERT INTO app_prices (app_slug, price_monthly, price_annual, currency, billing_unit)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (app_slug) DO UPDATE SET
         price_monthly = EXCLUDED.price_monthly, price_annual = EXCLUDED.price_annual,
         currency = EXCLUDED.currency, billing_unit = EXCLUDED.billing_unit, updated_at = now()`,
      [app.slug, app.price.monthly, app.price.annual, app.price.currency, app.price.per],
    );
  }

  logger.info({ plans: PLANS.length, apps: APPS.length - 1 }, 'pricing seeded');
}
