import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService, startService } from '@nexus/service-kit';
import { createDb, runMigrations } from '@nexus/db-kit';
import { createBus, startOutboxRelay } from '@nexus/bus';
import { config } from './config.js';
import { createSettings } from './lib/settings.js';
import { registerConsumers } from './lib/consumers.js';
import { invoiceRoutes } from './routes/invoices.js';
import { paymentRoutes } from './routes/payments.js';
import { customerRoutes } from './routes/customers.js';
import { templateRoutes } from './routes/templates.js';
import { accountingRoutes } from './routes/accounting.js';
import { assetRoutes } from './routes/assets.js';
import { recurringRoutes } from './routes/recurring.js';
import { internalRoutes } from './routes/internal.js';
import { registerAccountingConsumers } from './lib/accounting-consumers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const NAME = 'invoicing';

const db = createDb({ url: config.databaseUrl, appName: NAME, max: 15 });
await runMigrations({ db, dir: path.join(here, '..', 'migrations'), logger: console });

const bus = await createBus({ servers: config.natsUrl, name: NAME, db }).catch((error) => {
  console.warn(`  ! event bus unavailable (${error.message}) — deal-won invoices will not be raised`);
  return null;
});

const app = await createService({ name: NAME, config, db, bus });

const settings = createSettings({
  tenancyUrl: config.tenancyUrl,
  serviceToken: config.serviceToken,
  logger: app.log,
});
app.decorate('settings', settings);

await app.register(invoiceRoutes);
await app.register(paymentRoutes);
await app.register(customerRoutes);
await app.register(templateRoutes);
// Finance lives with invoicing: the ledger posts from the invoices beside it.
await app.register(accountingRoutes);
await app.register(assetRoutes);
await app.register(recurringRoutes);
await app.register(internalRoutes);

if (bus) {
  registerConsumers({ bus, db, settings, logger: app.log });
  registerAccountingConsumers({ bus, db, logger: app.log });
  startOutboxRelay({ db, bus, logger: app.log });
}

await startService(app, { port: config.port, name: NAME });
