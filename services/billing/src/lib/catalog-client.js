/** Billing tells catalog what the workspace is now allowed to run. */
export function createCatalogClient({ baseUrl, serviceToken, logger, timeoutMs = 5_000 }) {
  return {
    async provision(orgId, appSlugs, actorId) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`${baseUrl}/internal/orgs/${orgId}/provision`, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'content-type': 'application/json', 'x-nexus-service-token': serviceToken },
          body: JSON.stringify({ app_slugs: [...new Set(appSlugs)], actor_id: actorId }),
        });
        if (!response.ok) throw new Error(`catalog ${response.status}`);
        return await response.json();
      } catch (error) {
        // Not fatal: the entitlements are already correct, and catalog will
        // reconcile when it receives billing.entitlements.changed.
        logger.error({ err: error, orgId }, 'catalog provisioning call failed — will reconcile via bus');
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
