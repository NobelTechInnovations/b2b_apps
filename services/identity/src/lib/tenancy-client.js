/**
 * Identity needs to know which organizations a user belongs to in order to
 * mint an org-scoped token — but it must not own that data. So it asks the
 * tenancy service, over the internal network, with a service token.
 *
 * Fails closed: if tenancy is unreachable, the user gets a session with no org
 * context rather than an unverified one.
 */
export function createTenancyClient({ baseUrl, serviceToken, logger, timeoutMs = Number(process.env.INTERNAL_TIMEOUT_MS) || 8_000 }) {
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
        const error = new Error(payload?.error?.message ?? `tenancy ${response.status}`);
        error.status = response.status;
        error.code = payload?.error?.code;
        throw error;
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /** All orgs this user is an active member of. */
    async memberships(userId) {
      try {
        const res = await call(`/internal/users/${userId}/memberships`);
        return res?.data ?? [];
      } catch (error) {
        logger.error({ err: error, userId }, 'could not load memberships — issuing token without org');
        return [];
      }
    },

    /** One membership, used when switching workspace. Null if not a member. */
    async membership(userId, orgId) {
      try {
        const res = await call(`/internal/users/${userId}/memberships/${orgId}`);
        return res?.data ?? null;
      } catch (error) {
        if (error.status === 404) return null;
        logger.error({ err: error, userId, orgId }, 'membership lookup failed');
        return null;
      }
    },

    /** Consume an invitation once the invitee has an account. */
    async acceptInvitation(token, userId) {
      return call('/internal/invitations/accept', {
        method: 'POST',
        body: JSON.stringify({ token, user_id: userId }),
      });
    },

    async invitationByToken(token) {
      try {
        const res = await call(`/internal/invitations/${encodeURIComponent(token)}`);
        return res?.data ?? null;
      } catch (error) {
        if (error.status === 404) return null;
        throw error;
      }
    },
  };
}
