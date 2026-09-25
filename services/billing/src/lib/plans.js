import { APPS } from '@nexus/contracts';

/**
 * Plans are the commercial packaging. The platform fee buys the workspace,
 * users, storage and support; apps are bought on top. A customer does not buy
 * "an ERP" — they assemble the workspace they need.
 */
export const PLANS = [
  {
    slug: 'starter',
    name: 'Starter',
    tagline: 'For small teams getting organised',
    description: 'The workspace, five users and Projects & Tasks. Add other apps as needed.',
    base_price_monthly: 0,
    base_price_annual: 0,
    included_users: 5,
    extra_user_price: 0,
    max_users: 5,
    storage_gb: 5,
    trial_days: 14,
    features: ['Up to 5 users', '5 GB storage', 'Email support', 'Mobile + web'],
    included_apps: ['tasks'],
    sort_order: 1,
  },
  {
    slug: 'growth',
    name: 'Growth',
    tagline: 'For businesses running on more than spreadsheets',
    description: 'Everything in Starter, plus more users, more storage and priority support.',
    base_price_monthly: 1499,
    base_price_annual: 14990,
    included_users: 25,
    extra_user_price: 99,
    max_users: null,
    storage_gb: 100,
    trial_days: 14,
    features: [
      '25 users included', '100 GB storage', 'Priority support',
      'Custom roles & permissions', 'API access', 'Projects & Documents',
    ],
    included_apps: ['tasks', 'documents'],
    sort_order: 2,
  },
  {
    slug: 'scale',
    name: 'Scale',
    tagline: 'For companies running the whole business here',
    description: 'Unlimited users, the highest limits, and support that answers fast.',
    base_price_monthly: 4999,
    base_price_annual: 49990,
    included_users: 100,
    extra_user_price: 79,
    max_users: null,
    storage_gb: 1000,
    trial_days: 14,
    features: [
      '100 users included', '1 TB storage', 'Dedicated success manager',
      'Shared sign-in', 'Custom roles & permissions', 'API access',
      'Projects & Documents',
    ],
    included_apps: ['tasks', 'documents'],
    sort_order: 3,
  },
];

/** Seed plans and per-app prices. App prices default to the registry. */
export async function seedPlans(db, logger) {
  for (const plan of PLANS) {
    await db.query(
      `INSERT INTO plans (slug, name, tagline, description, base_price_monthly, base_price_annual,
                          included_users, extra_user_price, max_users, storage_gb, trial_days,
                          features, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name, tagline = EXCLUDED.tagline, description = EXCLUDED.description,
         base_price_monthly = EXCLUDED.base_price_monthly,
         base_price_annual = EXCLUDED.base_price_annual,
         included_users = EXCLUDED.included_users, extra_user_price = EXCLUDED.extra_user_price,
         max_users = EXCLUDED.max_users, storage_gb = EXCLUDED.storage_gb,
         trial_days = EXCLUDED.trial_days, features = EXCLUDED.features,
         sort_order = EXCLUDED.sort_order`,
      [
        plan.slug, plan.name, plan.tagline, plan.description,
        plan.base_price_monthly, plan.base_price_annual, plan.included_users,
        plan.extra_user_price, plan.max_users, plan.storage_gb, plan.trial_days,
        JSON.stringify(plan.features), plan.sort_order,
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
