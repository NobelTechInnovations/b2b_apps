/**
 * Catalog never decides what a workspace is allowed to have — billing does.
 * This client is the only place that question is asked.
 */
export function createBillingClient({ baseUrl, serviceToken, logger, timeoutMs = 3_000 }) {
  const cache = new Map();
  const TTL = 15_000;

  async function call(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        signal: controller.signal,
        headers: { 'x-nexus-service-token': serviceToken },
      });
      if (!response.ok) throw new Error(`billing ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async entitlements(orgId) {
      const hit = cache.get(orgId);
      if (hit && hit.expires > Date.now()) return hit.value;

      try {
        const res = await call(`/internal/entitlements/${orgId}`);
        const value = res?.data ?? { apps: [], features: [] };
        cache.set(orgId, { value, expires: Date.now() + TTL });
        return value;
      } catch (error) {
        logger.error({ err: error, orgId }, 'entitlement lookup failed — failing closed');
        // Fail closed: no entitlements rather than accidental access.
        return { apps: [], features: [], degraded: true };
      }
    },

    invalidate(orgId) {
      cache.delete(orgId);
    },
  };
}
