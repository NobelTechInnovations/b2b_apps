import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService, startService } from '@nexus/service-kit';
import { createDb, runMigrations } from '@nexus/db-kit';
import { createBus, startOutboxRelay } from '@nexus/bus';
import { config } from './config.js';
import { createIdentityClient } from './lib/identity-client.js';
import { organizationRoutes } from './routes/organizations.js';
import { memberRoutes } from './routes/members.js';
import { roleRoutes } from './routes/roles.js';
import { invitationRoutes } from './routes/invitations.js';
import { internalRoutes } from './routes/internal.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const NAME = 'tenancy';

const db = createDb({ url: config.databaseUrl, appName: NAME, max: 20 });
await runMigrations({ db, dir: path.join(here, '..', 'migrations'), logger: console });

const bus = await createBus({ servers: config.natsUrl, name: NAME, db }).catch((error) => {
  console.warn(`  ! event bus unavailable (${error.message}) — events will queue in the outbox`);
  return null;
});

const app = await createService({ name: NAME, config, db, bus, publicService: true });

app.decorate(
  'identity',
  createIdentityClient({
    baseUrl: config.identityUrl,
    serviceToken: config.serviceToken,
    logger: app.log,
  }),
);

await app.register(organizationRoutes);
await app.register(memberRoutes);
await app.register(roleRoutes);
await app.register(invitationRoutes);
await app.register(internalRoutes);

if (bus) startOutboxRelay({ db, bus, logger: app.log });

await startService(app, { port: config.port, name: NAME });
