import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService, startService } from '@nexus/service-kit';
import { createDb, runMigrations } from '@nexus/db-kit';
import { createBus, startOutboxRelay } from '@nexus/bus';
import { EVENTS } from '@nexus/contracts/events';
import { config } from './config.js';
import { syncAppRegistry } from './lib/sync.js';
import { createBillingClient } from './lib/billing-client.js';
import { marketplaceRoutes } from './routes/marketplace.js';
import { internalRoutes } from './routes/internal.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const NAME = 'catalog';

const db = createDb({ url: config.databaseUrl, appName: NAME });
await runMigrations({ db, dir: path.join(here, '..', 'migrations'), logger: console });

const bus = await createBus({ servers: config.natsUrl, name: NAME }).catch((error) => {
  console.warn(`  ! event bus unavailable (${error.message})`);
  return null;
});

const app = await createService({ name: NAME, config, db, bus });

await syncAppRegistry(db, app.log);

const billing = createBillingClient({
  baseUrl: config.billingUrl,
  serviceToken: config.serviceToken,
  logger: app.log,
});
app.decorate('billing', billing);

await app.register(marketplaceRoutes);
await app.register(internalRoutes);

// When what a workspace pays for changes, its installed apps follow.
if (bus) {
  await bus.subscribe(NAME, 'billing.entitlements.changed', async (event) => {
    billing.invalidate(event.org_id);
    app.log.info({ org: event.org_id }, 'entitlements changed — reconciling installed apps');
  });

  startOutboxRelay({ db, bus, logger: app.log });
}

await startService(app, { port: config.port, name: NAME });
