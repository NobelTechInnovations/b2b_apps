/** Tenancy stores user IDs, not user profiles. It asks identity for the rest. */
export function createIdentityClient({ baseUrl, serviceToken, logger, timeoutMs = 3_000 }) {
  async function call(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        ...options,
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-nexus-service-token': serviceToken,
          ...options.headers,
        },
      });
      const text = await response.text();
      const payload = text ? JSON.parse(text) : null;
      if (!response.ok) {
        const error = new Error(payload?.error?.message ?? `identity ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /** Hydrate a member list with names, emails and avatars. */
    async users({ ids = [], emails = [] }) {
      if (!ids.length && !emails.length) return new Map();
      try {
        const res = await call('/internal/users/lookup', {
          method: 'POST',
          body: JSON.stringify({ ids, emails }),
        });
        return new Map((res?.data ?? []).map((u) => [u.id, u]));
      } catch (error) {
        logger.error({ err: error }, 'user hydration failed — returning ids only');
        return new Map();
      }
    },

    async userByEmail(email) {
      const map = await this.users({ emails: [email.toLowerCase()] });
      return [...map.values()][0] ?? null;
    },

    /** Cut a removed member's live sessions immediately. */
    async revokeSessions(userId, orgId, reason) {
      try {
        await call('/internal/sessions/revoke', {
          method: 'POST',
          body: JSON.stringify({ user_id: userId, org_id: orgId, reason }),
        });
      } catch (error) {
        logger.error({ err: error, userId, orgId }, 'session revocation failed');
      }
    },
  };
}
