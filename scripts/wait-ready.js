const ports = [4000, 4001, 4002, 4003, 4004, 4006, 4008, 4010, 4022, 4030, 4031, 4034, 4036];
const deadline = Date.now() + 120000;
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
