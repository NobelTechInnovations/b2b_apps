import { id } from '@nexus/db-kit';
import { EVENTS } from '@nexus/contracts/events';

/** A crude but honest score: completeness of the record plus explicit rating. */
export function scoreFor(lead) {
  let score = 10;
  if (lead.email) score += 25;
  if (lead.phone) score += 20;
  if (lead.company_name) score += 15;
  if (lead.job_title) score += 10;
  if (lead.estimated_value) score += 10;
  if (lead.rating === 'hot') score += 20;
  else if (lead.rating === 'warm') score += 10;
  return Math.min(score, 100);
}

/**
 * Create one lead inside the caller's transaction, with its event. Used by
 * the Leads screen and by form submissions, so a lead is a lead however it
 * arrives.
 */
export async function insertLead(tx, { orgId, actorId, fields: b, notifyOwner = true }) {
  // No stage named: the workspace's first open stage, if it has set them up.
  const created = await tx.one(
    `INSERT INTO leads
       (id, org_id, first_name, last_name, company_name, email, phone, job_title,
        source, rating, score, estimated_value, owner_user_id, tags, notes, created_by,
        custom, city, stage_id, source_id, source_detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,'manual'),$10,$11,$12,$13,$14,$15,$16,
             COALESCE($17::jsonb, '{}'), $18,
             COALESCE($19, (SELECT id FROM lead_stages WHERE org_id = $2 AND kind = 'open' ORDER BY position, created_at LIMIT 1)),
             $20, $21)
     RETURNING *`,
    [
      id('led'), orgId, b.first_name.trim(), b.last_name ?? null, b.company_name ?? null,
      b.email ?? null, b.phone ?? null, b.job_title ?? null, b.source ?? null,
      b.rating ?? null, scoreFor(b), b.estimated_value ?? null,
      b.owner_user_id ?? null, b.tags ?? [], b.notes ?? null, actorId ?? null,
      b.custom ? JSON.stringify(b.custom) : null, b.city ?? null, b.stage_id ?? null,
      b.source_id ?? null, b.source_detail ?? null,
    ],
  );

  tx.emit({
    type: EVENTS.LEAD_CREATED,
    org_id: orgId,
    actor_id: actorId ?? null,
    data: {
      lead_id: created.id,
      name: [created.first_name, created.last_name].filter(Boolean).join(' '),
      company_name: created.company_name,
      email: created.email,
      source: created.source,
      owner_user_id: created.owner_user_id,
    },
  });

  if (notifyOwner && created.owner_user_id && created.owner_user_id !== actorId) {
    tx.emit({
      type: EVENTS.LEAD_ASSIGNED,
      org_id: orgId,
      actor_id: actorId ?? null,
      data: { owner_user_id: created.owner_user_id, count: 1, lead_id: created.id, name: [created.first_name, created.last_name].filter(Boolean).join(' '), via: created.source_detail ?? created.source },
    });
  }

  return created;
}
