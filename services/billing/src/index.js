import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService, startService } from '@nexus/service-kit';
import { createDb, runMigrations } from '@nexus/db-kit';
import { createBus, startOutboxRelay } from '@nexus/bus';
import { config } from './config.js';
import { seedPlans } from './lib/plans.js';
import { createCatalogClient } from './lib/catalog-client.js';
import { createRazorpay } from './lib/razorpay.js';
import { startBillingClock } from './lib/scheduler.js';
import { subscriptionRoutes } from './routes/subscriptions.js';
import { paymentRoutes } from './routes/payments.js';
import { internalRoutes } from './routes/internal.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const NAME = 'billing';

const db = createDb({ url: config.databaseUrl, appName: NAME });
await runMigrations({ db, dir: path.join(here, '..', 'migrations'), logger: console });

const bus = await createBus({ servers: config.natsUrl, name: NAME, db }).catch((error) => {
  console.warn(`  ! event bus unavailable (${error.message})`);
  return null;
});

const app = await createService({ name: NAME, config, db, bus });

await seedPlans(db, app.log);

app.decorate(
  'catalog',
  createCatalogClient({ baseUrl: config.catalogUrl, serviceToken: config.serviceToken, logger: app.log }),
);

app.decorate(
  'razorpay',
  createRazorpay({
    keyId: config.razorpayKeyId,
    keySecret: config.razorpayKeySecret,
    webhookSecret: config.razorpayWebhookSecret,
    logger: app.log,
  }),
);

if (config.nodeEnv === 'production' && config.billingTestMode) {
  app.log.warn('BILLING_TEST_MODE is on in production — test payments are refused once Razorpay keys are set');
}

await app.register(subscriptionRoutes);
await app.register(paymentRoutes);
await app.register(internalRoutes);

if (bus) startOutboxRelay({ db, bus, logger: app.log });
const clock = startBillingClock({ db, logger: app.log });
app.addHook('onClose', async () => clock.stop());

await startService(app, { port: config.port, name: NAME });
