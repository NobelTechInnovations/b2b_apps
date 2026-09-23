import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import multipart from '@fastify/multipart';
import { createService, startService } from '@nexus/service-kit';
import { createDb, runMigrations } from '@nexus/db-kit';
import { createBus, startOutboxRelay } from '@nexus/bus';
import { resolveUpstreams } from '../../gateway/src/lib/routing.js';
import { config } from './config.js';
import { createLocalStorage } from './lib/storage.js';
import { createQuota } from './lib/quota.js';
import { createTargetClient } from './lib/target-client.js';
import { fileRoutes } from './routes/files.js';
import { importRoutes } from './routes/import.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const NAME = 'documents';

const db = createDb({ url: config.databaseUrl, appName: NAME, max: 15 });
await runMigrations({ db, dir: path.join(here, '..', 'migrations'), logger: console });

await mkdir(config.storageRoot, { recursive: true });

const bus = await createBus({ servers: config.natsUrl, name: NAME }).catch((error) => {
  console.warn(`  ! event bus unavailable (${error.message}) — events will queue in the outbox`);
  return null;
});

const app = await createService({ name: NAME, config, db, bus });

await app.register(multipart, {
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1, fields: 10 },
});

app.decorate('storage', createLocalStorage({ root: config.storageRoot }));
app.decorate('quota', createQuota({
  db, billingUrl: config.billingUrl, serviceToken: config.serviceToken, logger: app.log,
}));
app.decorate('targets', createTargetClient({
  upstreams: resolveUpstreams(),
  serviceToken: config.serviceToken,
  logger: app.log,
}));

await app.register(fileRoutes);
await app.register(importRoutes);

if (bus) startOutboxRelay({ db, bus, logger: app.log });

app.log.info({ storage: config.storageRoot, maxUploadMb: config.maxUploadMb }, 'document storage ready');

await startService(app, { port: config.port, name: NAME });
