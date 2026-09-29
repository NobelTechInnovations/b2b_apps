import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService, startService } from '@nexus/service-kit';
import { createDb, runMigrations } from '@nexus/db-kit';
import { createBus, startOutboxRelay } from '@nexus/bus';
import { config } from './config.js';
import { overviewRoutes } from './routes/overview.js';
import { employeeRoutes } from './routes/employees.js';
import { departmentRoutes } from './routes/departments.js';
import { attendanceRoutes } from './routes/attendance.js';
import { leaveRoutes } from './routes/leave.js';
import { internalImportRoutes } from './routes/internal-import.js';
import { shiftRoutes } from './routes/shifts.js';
import { deviceRoutes } from './routes/devices.js';
import { internalPeopleRoutes } from './routes/internal-people.js';
import { portalRoutes } from './routes/portal.js';
import { performanceRoutes } from './routes/performance.js';
import { employeeDocumentRoutes } from './routes/documents.js';
import { createWorkspace } from './lib/workspace.js';
import { createTenancyClient } from './lib/tenancy-client.js';
import { registerConsumers } from './lib/consumers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const NAME = 'hr';

const db = createDb({ url: config.databaseUrl, appName: NAME, max: 15 });
await runMigrations({ db, dir: path.join(here, '..', 'migrations'), logger: console });

// Portal linking and approval workflows require the consumers to be running.
const bus = await createBus({ servers: config.natsUrl, name: NAME, db });

const app = await createService({ name: NAME, config, db, bus });

app.decorate(
  'workspace',
  createWorkspace({ tenancyUrl: config.tenancyUrl, serviceToken: config.serviceToken, logger: app.log }),
);
app.decorate(
  'tenancy',
  createTenancyClient({ baseUrl: config.tenancyUrl, serviceToken: config.serviceToken, logger: app.log }),
);

await app.register(overviewRoutes);
await app.register(employeeRoutes);
await app.register(departmentRoutes);
await app.register(attendanceRoutes);
await app.register(leaveRoutes);
await app.register(shiftRoutes);
await app.register(deviceRoutes);
await app.register(internalImportRoutes);
await app.register(internalPeopleRoutes);
await app.register(portalRoutes);
await app.register(performanceRoutes);
await app.register(employeeDocumentRoutes);

if (bus) {
  await registerConsumers({ bus, db, logger: app.log });
  startOutboxRelay({ db, bus, logger: app.log });
}

await startService(app, { port: config.port, name: NAME });
