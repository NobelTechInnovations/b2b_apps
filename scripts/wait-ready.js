import { SERVICES } from './lib/services.js';

// Every service the runner starts, so a new one is waited for without editing this file.
const ports = SERVICES.map((service) => service.port);
const deadline = Date.now() + Number(process.env.READY_TIMEOUT_MS ?? 240000);
const pending = new Set(ports);
while (pending.size && Date.now() < deadline) {
  await Promise.all([...pending].map(async (port) => {
    try {
      const response = await fetch(`http://localhost:${port}/readyz`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) pending.delete(port);
    } catch { /* Services can take a few seconds to migrate and start. */ }
  }));
  if (pending.size) await new Promise(resolve => setTimeout(resolve, 1000));
}
if (pending.size) throw new Error(`Services did not become ready on ports: ${[...pending]}`);
console.log('All Nexus services are ready.');
