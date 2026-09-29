import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService, startService } from '@nexus/service-kit';
import { createDb, runMigrations } from '@nexus/db-kit';
import { createBus, startOutboxRelay } from '@nexus/bus';
import { config } from './config.js';
import { ticketRoutes } from './routes/tickets.js';
import { knowledgeRoutes } from './routes/knowledge.js';

/**
 * Helpdesk and Knowledge Base: two apps, one service. Articles are what
 * answer tickets, and a small workspace should not pay for two processes.
 */
const NAME = 'helpdesk';
const here = path.dirname(fileURLToPath(import.meta.url));

const db = createDb({ url: config.databaseUrl, appName: NAME, logger: console });
await runMigrations({ db, dir: path.join(here, '..', 'migrations'), logger: console });

const bus = await createBus({ servers: config.natsUrl, name: NAME, db }).catch((error) => {
  console.warn(`  ! event bus unavailable (${error.message}) — events will queue in the outbox`);
  return null;
});

const app = await createService({ name: NAME, config, db, bus });
await app.register(ticketRoutes);
await app.register(knowledgeRoutes);

if (bus) {
  const relay = startOutboxRelay({ db, bus, logger: app.log });
  app.addHook('onClose', async () => relay.stop());
}

await startService(app, { port: config.port, name: NAME });
