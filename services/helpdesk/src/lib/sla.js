/**
 * Service levels. Minutes are calendar minutes, not business hours: simple to
 * explain to a customer and to check by hand.
 */
export const DEFAULT_SLA = {
  urgent: { first_response_minutes: 60, resolution_minutes: 4 * 60 },
  high: { first_response_minutes: 4 * 60, resolution_minutes: 24 * 60 },
  normal: { first_response_minutes: 8 * 60, resolution_minutes: 2 * 24 * 60 },
  low: { first_response_minutes: 24 * 60, resolution_minutes: 4 * 24 * 60 },
};

/** The workspace's policy, seeded with the defaults the first time it is read. */
export async function slaPolicies(store, orgId) {
  await store.query(
    `INSERT INTO sla_policies (org_id, priority, first_response_minutes, resolution_minutes)
     SELECT $1, p.priority, p.first_response, p.resolution
       FROM (VALUES ${Object.entries(DEFAULT_SLA)
         .map(([priority, v]) => `('${priority}', ${v.first_response_minutes}, ${v.resolution_minutes})`)
         .join(', ')}) AS p(priority, first_response, resolution)
     ON CONFLICT DO NOTHING`,
    [orgId],
  );
  const rows = await store.rows(`SELECT * FROM sla_policies WHERE org_id = $1`, [orgId]);
  return Object.fromEntries(rows.map((r) => [r.priority, r]));
}

/** The two deadlines a ticket opened at `openedAt` with `priority` must meet. */
export function deadlines(policy, openedAt) {
  const start = new Date(openedAt).getTime();
  return {
    first_response_due: new Date(start + policy.first_response_minutes * 60_000),
    resolution_due: new Date(start + policy.resolution_minutes * 60_000),
  };
}

/**
 * Where a ticket stands against its SLA right now.
 *   met       resolved in time           breached  a deadline has passed
 *   at_risk   under 25% of the window left (or under an hour)
 *   ok        on track                   none      no SLA (closed without one)
 */
export function slaState(ticket, now = Date.now()) {
  const done = ['resolved', 'closed'].includes(ticket.status);
  const due = ticket.resolution_due ? new Date(ticket.resolution_due).getTime() : null;
  if (!due) return 'none';
  if (done) {
    const at = new Date(ticket.resolved_at ?? ticket.closed_at ?? now).getTime();
    return at <= due ? 'met' : 'breached';
  }
  const responseDue = ticket.first_response_due ? new Date(ticket.first_response_due).getTime() : null;
  if (due < now || (responseDue && !ticket.first_response_at && responseDue < now)) return 'breached';
  const window = due - new Date(ticket.created_at).getTime();
  const left = due - now;
  return left < Math.max(window * 0.25, 0) || left < 3_600_000 ? 'at_risk' : 'ok';
}
