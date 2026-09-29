import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService, startService } from '@nexus/service-kit';
import { createDb, runMigrations } from '@nexus/db-kit';
import { createBus, startOutboxRelay } from '@nexus/bus';
import { config } from './config.js';
import { createHrClient } from './lib/hr-client.js';
import { createWorkspace } from './lib/workspace.js';
import { structureRoutes } from './routes/structures.js';
import { salaryRoutes } from './routes/salaries.js';
import { runRoutes } from './routes/runs.js';
import { payslipRoutes } from './routes/payslips.js';
import { expenseRoutes } from './routes/expenses.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const NAME = 'payroll';

const db = createDb({ url: config.databaseUrl, appName: NAME, max: 10 });
await runMigrations({ db, dir: path.join(here, '..', 'migrations'), logger: console });

const bus = await createBus({ servers: config.natsUrl, name: NAME, db }).catch((error) => {
  console.warn(`  ! event bus unavailable (${error.message}) — events will queue in the outbox`);
  return null;
});

const app = await createService({ name: NAME, config, db, bus });

// Payroll reads HR over HTTP and stores nothing of HR's but a snapshot.
app.decorate(
  'hr',
  createHrClient({ baseUrl: config.hrUrl, serviceToken: config.serviceToken, logger: app.log }),
);

app.decorate(
  'workspace',
  createWorkspace({ tenancyUrl: config.tenancyUrl, serviceToken: config.serviceToken, logger: app.log }),
);

await app.register(structureRoutes);
await app.register(salaryRoutes);
await app.register(runRoutes);
await app.register(payslipRoutes);
await app.register(expenseRoutes);

if (bus) startOutboxRelay({ db, bus, logger: app.log });

await startService(app, { port: config.port, name: NAME });
