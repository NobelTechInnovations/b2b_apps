/**
 * Calls the app that owns the records being imported.
 *
 * Documents knows nothing about CRM's or HR's schema — it reads the endpoint
 * from the import-target registry and posts validated rows there. The owning
 * service applies its own rules, which is why an imported employee still gets
 * leave balances and an imported lead still gets scored.
 */
export function createTargetClient({ upstreams, serviceToken, logger, timeoutMs = 30_000 }) {
  async function call(service, path, { method = 'POST', body, orgId, userId } = {}) {
    const base = upstreams[service];
    if (!base) throw new Error(`no upstream configured for ${service}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${base}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-nexus-service-token': serviceToken,
          'x-nexus-org': orgId,
          'x-nexus-actor': userId ?? '',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      const text = await response.text();
      const payload = text ? JSON.parse(text) : null;

      if (!response.ok) {
        const error = new Error(payload?.error?.message ?? `${service} responded ${response.status}`);
        error.status = response.status;
        throw error;
      }

      return payload?.data ?? payload;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /** Existing dedupe keys, so the dry run can say "will update" not "will create". */
    async existingKeys(target, { orgId, values }) {
      if (!target.dedupeOn || !values.length) return new Set();
      try {
        const data = await call(target.service, `${target.endpoint}/existing`, {
          orgId,
          body: { field: target.dedupeOn, values },
        });
        return new Set((data?.keys ?? []).map((k) => String(k).toLowerCase()));
      } catch (error) {
        // Not fatal — the import still works, it just cannot predict updates.
        logger.warn({ err: error, target: target.key }, 'dedupe lookup failed; treating all rows as new');
        return new Set();
      }
    },

    /** Write a batch. The target decides create vs update per row. */
    async importBatch(target, { orgId, userId, jobId, rows }) {
      return call(target.service, target.endpoint, {
        orgId,
        userId,
        body: { job_id: jobId, rows },
      });
    },
  };
}
