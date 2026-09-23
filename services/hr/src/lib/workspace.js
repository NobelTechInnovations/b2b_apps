/**
 * The workspace's own details, for the letterhead.
 *
 * Tenancy owns the organization record; HR reads it and caches it briefly.
 * Every employment letter carries the company's name and address at the top,
 * and retyping those into each template is how they end up out of date.
 */
export function createWorkspace({ tenancyUrl, serviceToken, logger, ttlMs = 60_000 }) {
  const cache = new Map();

  return {
    async forOrg(orgId) {
      const hit = cache.get(orgId);
      if (hit && hit.expires > Date.now()) return hit.value;

      let value = { name: null, address: {}, currency: 'INR', country: 'IN' };

      try {
        const response = await fetch(`${tenancyUrl}/internal/orgs/${orgId}/stats`, {
          headers: { 'x-nexus-service-token': serviceToken },
          signal: AbortSignal.timeout(3_000),
        });

        if (response.ok) {
          const payload = await response.json();
          const org = payload?.data ?? {};
          value = {
            name: org.name ?? null,
            address: org.address ?? {},
            currency: org.currency ?? 'INR',
            country: org.country ?? 'IN',
          };
        }
      } catch (error) {
        // A letter without the address still says the right things.
        logger?.warn({ err: error, orgId }, 'could not read workspace details for a letter');
      }

      cache.set(orgId, { value, expires: Date.now() + ttlMs });
      return value;
    },

    invalidate: (orgId) => cache.delete(orgId),
  };
}
