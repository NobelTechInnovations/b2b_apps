import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService, startService } from '@nexus/service-kit';
import { createDb, runMigrations } from '@nexus/db-kit';
import { createBus, startOutboxRelay } from '@nexus/bus';
import { config } from './config.js';
import { seedPlans } from './lib/plans.js';
import { createCatalogClient } from './lib/catalog-client.js';
import { subscriptionRoutes } from './routes/subscriptions.js';
import { internalRoutes } from './routes/internal.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const NAME = 'billing';

const db = createDb({ url: config.databaseUrl, appName: NAME });
await runMigrations({ db, dir: path.join(here, '..', 'migrations'), logger: console });

const bus = await createBus({ servers: config.natsUrl, name: NAME }).catch((error) => {
  console.warn(`  ! event bus unavailable (${error.message})`);
  return null;
});

const app = await createService({ name: NAME, config, db, bus });

await seedPlans(db, app.log);

app.decorate(
  'catalog',
  createCatalogClient({ baseUrl: config.catalogUrl, serviceToken: config.serviceToken, logger: app.log }),
);

await app.register(subscriptionRoutes);
await app.register(internalRoutes);

if (bus) startOutboxRelay({ db, bus, logger: app.log });

await startService(app, { port: config.port, name: NAME });
