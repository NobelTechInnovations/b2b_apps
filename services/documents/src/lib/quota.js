/**
 * Storage allowance, enforced against the plan the workspace pays for.
 *
 * Usage counts UNIQUE bytes — the deduplicated blob total — so a customer is
 * never billed twice for the same file stored in two folders.
 */
export function createQuota({ db, billingUrl, serviceToken, logger }) {
  const cache = new Map();
  const TTL = 60_000;
  const FALLBACK_GB = 5;

  async function limitFor(orgId) {
    const hit = cache.get(orgId);
    if (hit && hit.expires > Date.now()) return hit.value;

    let gigabytes = FALLBACK_GB;
    try {
      const response = await fetch(`${billingUrl}/internal/entitlements/${orgId}`, {
        headers: { 'x-nexus-service-token': serviceToken },
        signal: AbortSignal.timeout(3_000),
      });
      if (response.ok) {
        const payload = await response.json();
        // The plan's storage allowance rides along with the subscription.
        gigabytes = payload?.data?.subscription?.storage_gb ?? FALLBACK_GB;
      }
    } catch (error) {
      logger.warn({ err: error, orgId }, 'could not read storage allowance; using the starter limit');
    }

    const value = gigabytes * 1024 * 1024 * 1024;
    cache.set(orgId, { value, expires: Date.now() + TTL });
    return value;
  }

  async function used(orgId) {
    const row = await db.one(
      `SELECT COALESCE(sum(byte_size), 0)::bigint AS bytes,
              count(*)::int AS blobs
         FROM blobs WHERE org_id = $1 AND ref_count > 0`,
      [orgId],
    );
    return { bytes: Number(row.bytes), blobs: row.blobs };
  }

  return {
    async usage(orgId) {
      const [limit, current] = await Promise.all([limitFor(orgId), used(orgId)]);
      return {
        used: current.bytes,
        limit,
        blobs: current.blobs,
        percent: limit > 0 ? Math.min(100, Math.round((current.bytes / limit) * 100)) : 0,
      };
    },

    async check(orgId, incomingBytes) {
      const [limit, current] = await Promise.all([limitFor(orgId), used(orgId)]);
      return {
        ok: current.bytes + incomingBytes <= limit,
        used: current.bytes,
        limit,
      };
    },

    invalidate: (orgId) => cache.delete(orgId),
  };
}
