import { id, paginate } from '@nexus/db-kit';
import {
  requirePermission, body, query, params, validate as v, notFound, badRequest,
} from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';
import { ensureDefaultPipeline } from '../lib/pipeline.js';

const SORTS = ['created_at', 'updated_at', 'score', 'estimated_value', 'last_contacted_at'];

export async function leadRoutes(app) {
  const { db } = app;

  // ═══════════════════════════════════════════════════════════════════ LIST
  app.get(
    '/crm/leads',
    {
      preHandler: [app.loadContext, requirePermission('crm.leads.view')],
      schema: {
        querystring: query({
          status: v.enum(['new', 'contacted', 'qualified', 'unqualified', 'converted']),
          rating: v.enum(['hot', 'warm', 'cold']),
          source: v.text(40),
          owner: v.text(40),
          mine: { type: 'boolean' },
        }),
      },
    },
    async (request) => {
      const { orgId, userId } = request.ctx;
      const { status, rating, source, owner, mine, q } = request.query;
      const page = paginate({ ...request.query, allowedSorts: SORTS });

      const where = ['l.org_id = $1', 'l.archived_at IS NULL'];
      const values = [orgId];

      if (status) { values.push(status); where.push(`l.status = $${values.length}`); }
      if (rating) { values.push(rating); where.push(`l.rating = $${values.length}`); }
      if (source) { values.push(source); where.push(`l.source = $${values.length}`); }
      if (owner)  { values.push(owner);  where.push(`l.owner_user_id = $${values.length}`); }
      if (mine)   { values.push(userId); where.push(`l.owner_user_id = $${values.length}`); }

      if (q) {
        values.push(`%${q}%`);
        where.push(
          `(l.first_name ILIKE $${values.length} OR l.last_name ILIKE $${values.length}
            OR l.company_name ILIKE $${values.length} OR l.email ILIKE $${values.length})`,
        );
      }

      const clause = where.join(' AND ');

      const [rows, total, stats] = await Promise.all([
        db.rows(
          `SELECT l.* FROM leads l WHERE ${clause}
            ORDER BY l.${page.orderBy} LIMIT ${page.limit} OFFSET ${page.offset}`,
          values,
        ),
        db.one(`SELECT count(*)::int AS n FROM leads l WHERE ${clause}`, values),
        db.one(
          `SELECT
             count(*) FILTER (WHERE status = 'new')::int         AS new,
             count(*) FILTER (WHERE status = 'contacted')::int   AS contacted,
             count(*) FILTER (WHERE status = 'qualified')::int   AS qualified,
             count(*) FILTER (WHERE status = 'converted')::int   AS converted,
             COALESCE(sum(estimated_value) FILTER (WHERE status <> 'unqualified'), 0)::text AS open_value
           FROM leads WHERE org_id = $1 AND archived_at IS NULL`,
          [orgId],
        ),
      ]);

      return { data: rows.map(shape), meta: { ...page.meta(total.n), stats } };
    },
  );

  // ═══════════════════════════════════════════════════════════════════ READ
  app.get(
    '/crm/leads/:leadId',
    {
      preHandler: [app.loadContext, requirePermission('crm.leads.view')],
      schema: { params: params({ leadId: v.id('led') }) },
    },
    async (request) => {
      const lead = await db.one(
        `SELECT * FROM leads WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
        [request.params.leadId, request.ctx.orgId],
      );
      if (!lead) throw notFound('Lead');

      const activities = await db.rows(
        `SELECT * FROM activities
          WHERE org_id = $1 AND related_type = 'lead' AND related_id = $2
          ORDER BY created_at DESC LIMIT 50`,
        [request.ctx.orgId, lead.id],
      );

      return { data: { ...shape(lead), activities } };
    },
  );

  // ═════════════════════════════════════════════════════════════════ CREATE
  app.post(
    '/crm/leads',
    {
      preHandler: [app.loadContext, requirePermission('crm.leads.create')],
      schema: {
        body: body(
          {
            first_name: v.text(80, 1),
            last_name: v.text(80),
            company_name: v.text(160),
            email: v.email,
            phone: v.text(32),
            job_title: v.text(120),
            source: v.enum(['manual', 'website', 'referral', 'campaign', 'event', 'cold_call', 'import', 'api', 'partner']),
            rating: v.enum(['hot', 'warm', 'cold']),
            estimated_value: v.money,
            owner_user_id: v.text(40),
            tags: { type: 'array', items: v.text(40), maxItems: 20 },
            notes: v.longText,
          },
          ['first_name'],
        ),
      },
    },
    async (request, reply) => {
      const { orgId, userId } = request.ctx;
      const b = request.body;

      const lead = await db.transaction(async (tx) => {
        const created = await tx.one(
          `INSERT INTO leads
             (id, org_id, first_name, last_name, company_name, email, phone, job_title,
              source, rating, score, estimated_value, owner_user_id, tags, notes, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,'manual'),$10,$11,$12,COALESCE($13,$14),$15,$16,$14)
           RETURNING *`,
          [
            id('led'), orgId, b.first_name.trim(), b.last_name ?? null, b.company_name ?? null,
            b.email ?? null, b.phone ?? null, b.job_title ?? null, b.source ?? null,
            b.rating ?? null, scoreFor(b), b.estimated_value ?? null,
            b.owner_user_id ?? null, userId, b.tags ?? [], b.notes ?? null,
          ],
        );

        tx.emit({
          type: EVENTS.LEAD_CREATED,
          org_id: orgId,
          actor_id: userId,
          data: {
            lead_id: created.id,
            name: [created.first_name, created.last_name].filter(Boolean).join(' '),
            company_name: created.company_name,
            email: created.email,
            source: created.source,
            owner_user_id: created.owner_user_id,
          },
        });

        return created;
      });

      return reply.status(201).send({ data: shape(lead) });
    },
  );

  // ═════════════════════════════════════════════════════════════════ UPDATE
  app.patch(
    '/crm/leads/:leadId',
    {
      preHandler: [app.loadContext, requirePermission('crm.leads.edit')],
      schema: {
        params: params({ leadId: v.id('led') }),
        body: body({
          first_name: v.text(80, 1),
          last_name: v.text(80),
          company_name: v.text(160),
          email: v.email,
          phone: v.text(32),
          job_title: v.text(120),
          status: v.enum(['new', 'contacted', 'qualified', 'unqualified']),
          rating: v.enum(['hot', 'warm', 'cold']),
          estimated_value: v.money,
          owner_user_id: v.text(40),
          tags: { type: 'array', items: v.text(40), maxItems: 20 },
          notes: v.longText,
          unqualified_reason: v.text(240),
        }),
      },
    },
    async (request) => {
      const { orgId } = request.ctx;

      const existing = await db.one(
        `SELECT * FROM leads WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
        [request.params.leadId, orgId],
      );
      if (!existing) throw notFound('Lead');
      if (existing.status === 'converted') {
        throw badRequest('This lead has already been converted and cannot be edited.');
      }

      const fields = [
        'first_name', 'last_name', 'company_name', 'email', 'phone', 'job_title',
        'status', 'rating', 'estimated_value', 'owner_user_id', 'tags', 'notes',
        'unqualified_reason',
      ].filter((f) => request.body[f] !== undefined);

      if (!fields.length) return { data: shape(existing) };

      const sets = fields.map((f, i) => `${f} = $${i + 3}`);
      const values = fields.map((f) => request.body[f]);

      // Touching a lead's status is the signal that someone worked it.
      if (request.body.status && request.body.status !== existing.status) {
        sets.push('last_contacted_at = now()');
      }

      const updated = await db.one(
        `UPDATE leads SET ${sets.join(', ')} WHERE id = $1 AND org_id = $2 RETURNING *`,
        [existing.id, orgId, ...values],
      );

      return { data: shape(updated) };
    },
  );

  // ════════════════════════════════════════════════════════════════ CONVERT
  /**
   * Turns an enquiry into real customer records: a company, a contact, and
   * optionally an open deal — all in one transaction, so a half-converted
   * lead can never exist.
   */
  app.post(
    '/crm/leads/:leadId/convert',
    {
      preHandler: [app.loadContext, requirePermission('crm.leads.edit')],
      schema: {
        params: params({ leadId: v.id('led') }),
        body: body({
          create_deal: { type: 'boolean', default: true },
          deal_title: v.text(160),
          deal_value: v.money,
          expected_close_date: v.date,
          company_id: v.id('cmp'),
        }),
      },
    },
    async (request) => {
      const { orgId, userId } = request.ctx;
      const b = request.body ?? {};

      const lead = await db.one(
        `SELECT * FROM leads WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
        [request.params.leadId, orgId],
      );
      if (!lead) throw notFound('Lead');
      if (lead.status === 'converted') {
        throw badRequest('This lead has already been converted.', {
          contact_id: lead.converted_contact_id,
          deal_id: lead.converted_deal_id,
        });
      }

      const pipelineId = await ensureDefaultPipeline(db, orgId);
      const firstStage = await db.one(
        `SELECT id, probability FROM stages
          WHERE org_id = $1 AND pipeline_id = $2 AND kind = 'open'
          ORDER BY position LIMIT 1`,
        [orgId, pipelineId],
      );
      if (!firstStage) throw badRequest('This pipeline has no open stages to place a deal in.');

      const result = await db.transaction(async (tx) => {
        // ── company: reuse the one they chose, else match on domain, else new
        let companyId = b.company_id ?? null;

        if (!companyId && lead.company_name) {
          const domain = lead.email?.split('@')[1]?.toLowerCase() ?? null;

          if (domain) {
            const match = await tx.one(
              `SELECT id FROM companies WHERE org_id = $1 AND lower(domain) = $2 AND archived_at IS NULL`,
              [orgId, domain],
            );
            companyId = match?.id ?? null;
          }

          if (!companyId) {
            const company = await tx.one(
              `INSERT INTO companies (id, org_id, name, domain, phone, email, owner_user_id, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
              [
                id('cmp'), orgId, lead.company_name, domain,
                lead.phone ?? null, lead.email ?? null,
                lead.owner_user_id ?? userId, userId,
              ],
            );
            companyId = company.id;
          }
        }

        // ── contact
        const contact = await tx.one(
          `INSERT INTO contacts
             (id, org_id, company_id, first_name, last_name, email, phone, job_title,
              is_primary, owner_user_id, tags, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10,$11) RETURNING *`,
          [
            id('con'), orgId, companyId, lead.first_name, lead.last_name,
            lead.email, lead.phone, lead.job_title,
            lead.owner_user_id ?? userId, lead.tags, userId,
          ],
        );

        // ── deal
        let deal = null;
        if (b.create_deal !== false) {
          deal = await tx.one(
            `INSERT INTO deals
               (id, org_id, pipeline_id, stage_id, company_id, contact_id, title, value,
                probability, expected_close_date, source, owner_user_id, created_by,
                board_position)
             VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::numeric,0),$9,$10,$11,$12,$13,
                     COALESCE((SELECT max(board_position) + 1000 FROM deals
                                WHERE org_id = $2 AND stage_id = $4), 1000))
             RETURNING *`,
            [
              id('dea'), orgId, pipelineId, firstStage.id, companyId, contact.id,
              b.deal_title ?? `${lead.company_name ?? lead.first_name} opportunity`,
              b.deal_value ?? lead.estimated_value,
              firstStage.probability, b.expected_close_date ?? null,
              lead.source, lead.owner_user_id ?? userId, userId,
            ],
          );

          await tx.query(
            `INSERT INTO deal_stage_history (org_id, deal_id, from_stage_id, to_stage_id, moved_by)
             VALUES ($1, $2, NULL, $3, $4)`,
            [orgId, deal.id, firstStage.id, userId],
          );
        }

        await tx.query(
          `UPDATE leads SET status = 'converted', converted_at = now(),
                  converted_contact_id = $3, converted_company_id = $4, converted_deal_id = $5
            WHERE id = $1 AND org_id = $2`,
          [lead.id, orgId, contact.id, companyId, deal?.id ?? null],
        );

        // Carry the lead's history onto the contact so nothing is orphaned.
        await tx.query(
          `UPDATE activities SET related_type = 'contact', related_id = $3
            WHERE org_id = $1 AND related_type = 'lead' AND related_id = $2`,
          [orgId, lead.id, contact.id],
        );

        tx.emit({
          type: EVENTS.LEAD_CONVERTED,
          org_id: orgId,
          actor_id: userId,
          data: {
            lead_id: lead.id,
            contact_id: contact.id,
            company_id: companyId,
            deal_id: deal?.id ?? null,
            value: deal?.value ?? null,
          },
        });

        if (companyId) {
          tx.emit({
            type: EVENTS.CUSTOMER_CREATED,
            org_id: orgId,
            actor_id: userId,
            data: { company_id: companyId, name: lead.company_name, via: 'lead_conversion' },
          });
        }

        if (deal) {
          tx.emit({
            type: EVENTS.DEAL_CREATED,
            org_id: orgId,
            actor_id: userId,
            data: { deal_id: deal.id, title: deal.title, value: deal.value, company_id: companyId },
          });
        }

        return { contact, companyId, deal };
      });

      return {
        data: {
          converted: true,
          contact_id: result.contact.id,
          company_id: result.companyId,
          deal_id: result.deal?.id ?? null,
        },
      };
    },
  );

  // ════════════════════════════════════════════════════════════════ ARCHIVE
  app.delete(
    '/crm/leads/:leadId',
    {
      preHandler: [app.loadContext, requirePermission('crm.leads.delete')],
      schema: { params: params({ leadId: v.id('led') }) },
    },
    async (request) => {
      const row = await db.one(
        `UPDATE leads SET archived_at = now()
          WHERE id = $1 AND org_id = $2 AND archived_at IS NULL RETURNING id`,
        [request.params.leadId, request.ctx.orgId],
      );
      if (!row) throw notFound('Lead');
      return { data: { archived: true } };
    },
  );
}

/** A crude but honest score: completeness of the record plus explicit rating. */
function scoreFor(lead) {
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

function shape(lead) {
  return {
    ...lead,
    name: [lead.first_name, lead.last_name].filter(Boolean).join(' '),
  };
}
