import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService, startService } from '@nexus/service-kit';
import { createDb, runMigrations } from '@nexus/db-kit';
import { createBus, startOutboxRelay } from '@nexus/bus';
import { config } from './config.js';
import { inventoryRoutes } from './routes/inventory.js';
import { manufacturingRoutes } from './routes/manufacturing.js';
import { qualityRoutes } from './routes/quality.js';
import { maintenanceRoutes } from './routes/maintenance.js';
import { posRoutes } from './routes/pos.js';
import { storeRoutes } from './routes/store.js';

/**
 * Operations and commerce: Inventory & Purchasing, Manufacturing, Quality,
 * Maintenance, Point of Sale and Online Store. Six apps, one service, because
 * all six move stock and stock must move in one transaction.
 */
const NAME = 'erp';
const here = path.dirname(fileURLToPath(import.meta.url));

const db = createDb({ url: config.databaseUrl, appName: NAME, logger: console });
await runMigrations({ db, dir: path.join(here, '..', 'migrations'), logger: console });

const bus = await createBus({ servers: config.natsUrl, name: NAME, db }).catch((error) => {
  console.warn(`  ! event bus unavailable (${error.message}) — events will queue in the outbox`);
  return null;
});

const app = await createService({ name: NAME, config, db, bus });
await app.register(inventoryRoutes);
await app.register(manufacturingRoutes);
await app.register(qualityRoutes);
await app.register(maintenanceRoutes);
await app.register(posRoutes);
await app.register(storeRoutes);

if (bus) {
  const relay = startOutboxRelay({ db, bus, logger: app.log });
  app.addHook('onClose', async () => relay.stop());
}

await startService(app, { port: config.port, name: NAME });
