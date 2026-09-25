import { forbidden } from '@nexus/service-kit';

/**
 * Authorization resolver with a short-lived cache.
 *
 * The cache key includes the organization's epoch, so any change to membership
 * or role grants invalidates every cached decision for that workspace the
 * moment the new epoch reaches a token — no cache stampede, no stale access.
 */
export function createAuthz({ tenancyUrl, billingUrl, catalogUrl, serviceToken, logger, ttlMs = 30_000 }) {
  const permissionCache = new Map();
  const entitlementCache = new Map();

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of permissionCache) if (entry.expires < now) permissionCache.delete(key);
    for (const [key, entry] of entitlementCache) if (entry.expires < now) entitlementCache.delete(key);
  }, 60_000).unref();

  async function fetchJson(url, label) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'x-nexus-service-token': serviceToken },
      });
      if (!response.ok) throw new Error(`${label} responded ${response.status}`);
      return (await response.json())?.data ?? null;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async installed(orgId) {
      const data = await fetchJson(`${catalogUrl}/internal/orgs/${orgId}/apps`, 'catalog');
      return new Set((data ?? []).map((row) => row.app_slug));
    },

    /** Who is this person in this workspace, and what may they do? */
    async permissions({ orgId, userId, epoch }) {
      const key = `${orgId}:${userId}:${epoch}`;
      const hit = permissionCache.get(key);
      if (hit && hit.expires > Date.now()) return hit.value;

      const data = await fetchJson(`${tenancyUrl}/internal/authz/${orgId}/${userId}`, 'tenancy');

      if (!data?.allowed) {
        throw forbidden(
          data?.reason === 'not_a_member'
            ? 'You are not a member of this workspace.'
            : 'Your access to this workspace is not active.',
          { code: data?.reason ?? 'not_allowed' },
        );
      }

      const value = {
        memberId: data.member_id,
        roles: data.roles,
        isOwner: data.is_owner,
        permissions: new Set(data.permissions),
        epoch: data.epoch,
      };

      permissionCache.set(key, { value, expires: Date.now() + ttlMs });
      return value;
    },

    /** What has this workspace actually bought? */
    async entitlements(orgId) {
      const hit = entitlementCache.get(orgId);
      if (hit && hit.expires > Date.now()) return hit.value;

      const data = await fetchJson(`${billingUrl}/internal/entitlements/${orgId}`, 'billing');

      const value = {
        apps: new Set((data?.apps ?? []).map((a) => a.app_slug)),
        features: new Set(data?.features ?? []),
        subscription: data?.subscription ?? null,
        status: data?.subscription?.status ?? 'none',
      };

      entitlementCache.set(orgId, { value, expires: Date.now() + ttlMs });
      return value;
    },

    invalidate(orgId) {
      entitlementCache.delete(orgId);
      for (const key of permissionCache.keys()) {
        if (key.startsWith(`${orgId}:`)) permissionCache.delete(key);
      }
      logger.debug({ orgId }, 'authorization cache invalidated');
    },

    stats: () => ({ permissions: permissionCache.size, entitlements: entitlementCache.size }),
  };
}
