/**
 * The workspace's own details, for the top of a payslip.
 *
 * Tenancy owns the organization record. Payroll reads it, briefly caches it,
 * and only ever uses it as a fallback — an employer name typed into payroll
 * settings always wins, because that is how one company bills and pays under
 * a trading name different from its registered one.
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
        // A payslip without the employer's name is still a correct payslip.
        logger?.warn({ err: error, orgId }, 'could not read workspace details');
      }

      cache.set(orgId, { value, expires: Date.now() + ttlMs });
      return value;
    },

    invalidate: (orgId) => cache.delete(orgId),
  };
}
