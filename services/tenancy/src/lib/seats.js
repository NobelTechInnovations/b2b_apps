import { ApiError } from '@nexus/service-kit';

/**
 * A seat is a person who can sign in: an active member or someone holding a
 * pending invitation. Billing says how many the workspace has paid for;
 * nobody else gets in once they are all taken.
 *
 * Fails closed — if billing cannot answer, the invitation waits.
 */
export async function assertSeatAvailable({ db, config, orgId, email }) {
  let seats;
  try {
    const response = await fetch(`${config.billingUrl}/internal/orgs/${orgId}/seats`, {
      headers: { 'x-nexus-service-token': config.serviceToken },
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) throw new Error(`billing responded ${response.status}`);
    seats = (await response.json()).data;
  } catch {
    throw new ApiError(503, 'seat_check_unavailable', 'Could not check your available seats. Try again shortly.');
  }

  if (!seats || seats.status === 'none' || seats.status === 'canceled') {
    throw new ApiError(402, 'no_subscription', 'Choose a plan before inviting people.', {
      upgrade_url: '/settings/billing',
    });
  }

  // Re-inviting the same address replaces its pending invitation, so it does
  // not need a second seat.
  const usage = await db.one(
    `SELECT
       (SELECT count(*)::int FROM members WHERE org_id = $1 AND status = 'active') AS members,
       (SELECT count(*)::int FROM invitations
         WHERE org_id = $1 AND status = 'pending' AND expires_at > now() AND lower(email) <> $2) AS pending`,
    [orgId, email.toLowerCase()],
  );
  const used = usage.members + usage.pending;
  if (used >= Number(seats.seats)) {
    throw new ApiError(
      402,
      'seat_limit',
      `All ${seats.seats} seats are in use (${usage.members} members, ${usage.pending} pending invitations). Add seats in Billing to invite more people.`,
      { seats: Number(seats.seats), used, upgrade_url: '/settings/billing' },
    );
  }
  return { seats: Number(seats.seats), used };
}
