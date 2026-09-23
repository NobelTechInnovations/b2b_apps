/**
 * The selling entity's own details — needed on every invoice.
 *
 * Tenancy owns the organization record; this reads it and caches briefly.
 * The seller's GST state code decides CGST/SGST versus IGST, so getting it
 * wrong would mis-tax every invoice — hence the explicit, conservative
 * fallback rather than a guess.
 */
export function createSettings({ tenancyUrl, serviceToken, logger, ttlMs = 60_000 }) {
  const cache = new Map();

  const DEFAULTS = {
    name: null,
    address: {},
    currency: 'INR',
    state_code: null,
    fiscal_year_start: 4,
    default_tax_rate: 18,
    default_terms_days: 30,
    default_terms: 'Payment due within 30 days of invoice date.',
  };

  return {
    async forOrg(orgId) {
      const hit = cache.get(orgId);
      if (hit && hit.expires > Date.now()) return hit.value;

      let value = { ...DEFAULTS };

      try {
        const response = await fetch(`${tenancyUrl}/internal/orgs/${orgId}/stats`, {
          headers: { 'x-nexus-service-token': serviceToken },
          signal: AbortSignal.timeout(3_000),
        });

        if (response.ok) {
          const payload = await response.json();
          const org = payload?.data ?? {};
          value = {
            ...DEFAULTS,
            // The seller's own name, for a document whose template does not
            // override it with a trading name.
            name: org.name ?? null,
            address: org.address ?? {},
            currency: org.currency ?? DEFAULTS.currency,
            // First two digits of the workspace GSTIN.
            state_code: org.tax_id ? String(org.tax_id).trim().slice(0, 2) : null,
            fiscal_year_start: org.fiscal_year_start ?? DEFAULTS.fiscal_year_start,
          };
        }
      } catch (error) {
        logger.warn({ err: error, orgId }, 'could not read workspace settings; using defaults');
      }

      cache.set(orgId, { value, expires: Date.now() + ttlMs });
      return value;
    },

    invalidate: (orgId) => cache.delete(orgId),
  };
}
