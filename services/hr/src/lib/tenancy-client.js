/**
 * Portal invitations.
 *
 * Tenancy owns memberships and invitations; HR must not invent its own. So
 * inviting an employee to the portal is HR asking tenancy to send the same
 * invitation it would send anybody, with the `employee` role attached.
 *
 * HR then learns the invitation was accepted from the `tenancy.member.joined`
 * event rather than by polling — see `lib/consumers.js`.
 */
export function createTenancyClient({ baseUrl, serviceToken, logger, timeoutMs = 10_000 }) {
  async function call(path, { method = 'GET', body, orgId, userId } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(new URL(path, baseUrl), {
        method,
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-nexus-service-token': serviceToken,
          ...(orgId ? { 'x-nexus-org': orgId } : {}),
          ...(userId ? { 'x-nexus-actor': userId } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      const text = await response.text();
      const payload = text ? JSON.parse(text) : null;

      if (!response.ok) {
        const error = new Error(payload?.error?.message ?? `tenancy responded ${response.status}`);
        error.status = response.status;
        error.code = payload?.error?.code;
        throw error;
      }

      return payload?.data ?? payload;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /** The workspace's `employee` role, which portal invitations carry. */
    async employeeRole(orgId) {
      const roles = await call(`/internal/orgs/${orgId}/roles`, { orgId });
      return (roles ?? []).find((role) => role.slug === 'employee') ?? null;
    },

    invite(orgId, { email, roleIds, title, message, userId }) {
      return call('/internal/invitations', {
        method: 'POST',
        orgId,
        userId,
        body: { org_id: orgId, email, role_ids: roleIds, title, message, invited_by: userId },
      });
    },

    revoke(orgId, invitationId, { userId } = {}) {
      return call(`/internal/invitations/${invitationId}/revoke`, {
        method: 'POST',
        orgId,
        userId,
        body: { org_id: orgId },
      });
    },
  };
}
