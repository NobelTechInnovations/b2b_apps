import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService, startService } from '@nexus/service-kit';
import { createDb, runMigrations } from '@nexus/db-kit';
import { createBus } from '@nexus/bus';
import { config } from './config.js';
import { registerConsumer, createTenancyClient, createIdentityClient } from './lib/consumer.js';
import { createEmailSender } from './lib/email.js';
import { notificationRoutes } from './routes/notifications.js';
import { emailRoutes } from './routes/emails.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const NAME = 'notifier';

const db = createDb({ url: config.databaseUrl, appName: NAME, max: 10, logger: console });
await runMigrations({ db, dir: path.join(here, '..', 'migrations'), logger: console });

// Without the bus there is nothing to notify about, so this service refuses
// to start rather than running as an inbox that never fills.
const bus = await createBus({ servers: config.natsUrl, name: NAME, db });

const app = await createService({ name: NAME, config, db, bus });
const sender = createEmailSender({ config, db, logger: app.log });
await app.register(notificationRoutes);
await app.register(emailRoutes, { sender });

await registerConsumer({
  bus,
  db,
  tenancy: createTenancyClient({ baseUrl: config.tenancyUrl, serviceToken: config.serviceToken, logger: app.log }),
  identity: createIdentityClient({ baseUrl: config.identityUrl, serviceToken: config.serviceToken }),
  sender,
  appUrl: config.appUrl,
  logger: app.log,
});
await sender.register(bus);

await startService(app, { port: config.port, name: NAME });
