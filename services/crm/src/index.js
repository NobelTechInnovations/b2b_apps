import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService, startService } from '@nexus/service-kit';
import { createDb, runMigrations } from '@nexus/db-kit';
import { createBus, startOutboxRelay } from '@nexus/bus';
import { config } from './config.js';
import { leadRoutes } from './routes/leads.js';
import { dealRoutes } from './routes/deals.js';
import { peopleRoutes } from './routes/people.js';
import { activityRoutes } from './routes/activities.js';
import { overviewRoutes } from './routes/overview.js';
import { internalImportRoutes } from './routes/internal-import.js';
import { formRoutes } from './routes/forms.js';
import { quoteRoutes } from './routes/quotes.js';
import { partnerRoutes } from './routes/partners.js';
import { marketingRoutes } from './routes/marketing.js';
import { socialRoutes } from './routes/social.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const NAME = 'crm';

const db = createDb({ url: config.databaseUrl, appName: NAME, max: 15 });
await runMigrations({ db, dir: path.join(here, '..', 'migrations'), logger: console });

const bus = await createBus({ servers: config.natsUrl, name: NAME, db }).catch((error) => {
  console.warn(`  ! event bus unavailable (${error.message}) — events will queue in the outbox`);
  return null;
});

const app = await createService({ name: NAME, config, db, bus });

await app.register(overviewRoutes);
await app.register(leadRoutes);
await app.register(dealRoutes);
await app.register(peopleRoutes);
await app.register(activityRoutes);
await app.register(internalImportRoutes);
await app.register(formRoutes);
// Sales & marketing apps start from, and end in, CRM records.
await app.register(quoteRoutes);
await app.register(partnerRoutes);
await app.register(marketingRoutes);
await app.register(socialRoutes);

if (bus) startOutboxRelay({ db, bus, logger: app.log });

await startService(app, { port: config.port, name: NAME });
