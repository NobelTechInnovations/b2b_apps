import { id, paginate } from '@nexus/db-kit';
import {
  requirePermission, body, query, params, validate as v, notFound, badRequest,
} from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';
import { ensureDefaultPipeline, loadPipeline, positionBetween, renumberStage } from '../lib/pipeline.js';

const SORTS = ['created_at', 'updated_at', 'value', 'expected_close_date', 'probability'];

export async function dealRoutes(app) {
  const { db } = app;

  // ═══════════════════════════════════════════════════════ THE PIPELINE BOARD
  app.get(
    '/crm/pipeline',
    {
      preHandler: [app.loadContext, requirePermission('crm.pipeline.view')],
      schema: { querystring: query({ pipeline_id: v.id('pip'), owner: v.text(40), mine: { type: 'boolean' } }) },
    },
    async (request) => {
      const { orgId, userId } = request.ctx;

      const pipeline = await loadPipeline(db, orgId, request.query.pipeline_id);
      if (!pipeline) throw notFound('Pipeline');

      const where = ['d.org_id = $1', 'd.pipeline_id = $2', 'd.archived_at IS NULL'];
      const values = [orgId, pipeline.id];

      if (request.query.mine) { values.push(userId); where.push(`d.owner_user_id = $${values.length}`); }
      else if (request.query.owner) { values.push(request.query.owner); where.push(`d.owner_user_id = $${values.length}`); }

      const deals = await db.rows(
        `SELECT d.*, c.name AS company_name,
                ct.first_name AS contact_first_name, ct.last_name AS contact_last_name
           FROM deals d
           LEFT JOIN companies c ON c.id = d.company_id
           LEFT JOIN contacts ct ON ct.id = d.contact_id
          WHERE ${where.join(' AND ')}
          ORDER BY d.board_position, d.created_at`,
        values,
      );

      // Group in one pass so the client receives a board, not a flat list.
      const byStage = new Map(pipeline.stages.map((s) => [s.id, []]));
      for (const deal of deals) {
        byStage.get(deal.stage_id)?.push(shape(deal));
      }

      const columns = pipeline.stages.map((stage) => {
        const items = byStage.get(stage.id) ?? [];
        const total = items.reduce((sum, d) => sum + Number(d.value), 0);
        return {
          ...stage,
          deals: items,
          count: items.length,
          total_value: total.toFixed(2),
          weighted_value: ((total * stage.probability) / 100).toFixed(2),
        };
      });

      const open = deals.filter((d) => d.status === 'open');
      const openValue = open.reduce((sum, d) => sum + Number(d.value), 0);
      const weighted = open.reduce((sum, d) => sum + (Number(d.value) * d.probability) / 100, 0);

      return {
        data: {
          pipeline: { id: pipeline.id, name: pipeline.name },
          columns,
          summary: {
            open_count: open.length,
            open_value: openValue.toFixed(2),
            weighted_value: weighted.toFixed(2),
            currency: deals[0]?.currency ?? 'INR',
          },
        },
      };
    },
  );

  app.get(
    '/crm/pipelines',
    { preHandler: [app.loadContext, requirePermission('crm.pipeline.view')] },
    async (request) => {
      await ensureDefaultPipeline(db, request.ctx.orgId);
      const rows = await db.rows(
        `SELECT p.*, COALESCE(json_agg(s.* ORDER BY s.position) FILTER (WHERE s.id IS NOT NULL), '[]') AS stages
           FROM pipelines p LEFT JOIN stages s ON s.pipeline_id = p.id
          WHERE p.org_id = $1 GROUP BY p.id ORDER BY p.position`,
        [request.ctx.orgId],
      );
      return { data: rows };
    },
  );

  // ═══════════════════════════════════════════════════════════════════ LIST
  app.get(
    '/crm/deals',
    {
      preHandler: [app.loadContext, requirePermission('crm.deals.view')],
      schema: {
        querystring: query({
          status: v.enum(['open', 'won', 'lost']),
          stage_id: v.id('stg'),
          company_id: v.id('cmp'),
          owner: v.text(40),
          mine: { type: 'boolean' },
        }),
      },
    },
    async (request) => {
      const { orgId, userId } = request.ctx;
      const page = paginate({ ...request.query, allowedSorts: SORTS });

      const where = ['d.org_id = $1', 'd.archived_at IS NULL'];
      const values = [orgId];
      const { status, stage_id: stageId, company_id: companyId, owner, mine, q } = request.query;

      if (status)    { values.push(status);    where.push(`d.status = $${values.length}`); }
      if (stageId)   { values.push(stageId);   where.push(`d.stage_id = $${values.length}`); }
      if (companyId) { values.push(companyId); where.push(`d.company_id = $${values.length}`); }
      if (owner)     { values.push(owner);     where.push(`d.owner_user_id = $${values.length}`); }
      if (mine)      { values.push(userId);    where.push(`d.owner_user_id = $${values.length}`); }
      if (q) {
        values.push(`%${q}%`);
        where.push(`(d.title ILIKE $${values.length} OR c.name ILIKE $${values.length})`);
      }

      const clause = where.join(' AND ');
      const join = `FROM deals d LEFT JOIN companies c ON c.id = d.company_id
                    LEFT JOIN stages s ON s.id = d.stage_id`;

      const [rows, total, summary] = await Promise.all([
        db.rows(
          `SELECT d.*, c.name AS company_name, s.name AS stage_name, s.colour AS stage_colour
             ${join} WHERE ${clause}
            ORDER BY d.${page.orderBy} LIMIT ${page.limit} OFFSET ${page.offset}`,
          values,
        ),
        db.one(`SELECT count(*)::int AS n ${join} WHERE ${clause}`, values),
        db.one(
          `SELECT
             count(*) FILTER (WHERE status = 'open')::int AS open_count,
             count(*) FILTER (WHERE status = 'won')::int  AS won_count,
             COALESCE(sum(value) FILTER (WHERE status = 'open'), 0)::text AS open_value,
             COALESCE(sum(value) FILTER (WHERE status = 'won'
               AND closed_at >= date_trunc('month', now())), 0)::text     AS won_this_month
           FROM deals WHERE org_id = $1 AND archived_at IS NULL`,
          [orgId],
        ),
      ]);

      return { data: rows.map(shape), meta: { ...page.meta(total.n), summary } };
    },
  );

  // ═══════════════════════════════════════════════════════════════════ READ
  app.get(
    '/crm/deals/:dealId',
    {
      preHandler: [app.loadContext, requirePermission('crm.deals.view')],
      schema: { params: params({ dealId: v.id('dea') }) },
    },
    async (request) => {
      const { orgId } = request.ctx;

      const deal = await db.one(
        `SELECT d.*, c.name AS company_name, s.name AS stage_name, s.colour AS stage_colour,
                ct.first_name AS contact_first_name, ct.last_name AS contact_last_name,
                ct.email AS contact_email, ct.phone AS contact_phone
           FROM deals d
           LEFT JOIN companies c ON c.id = d.company_id
           LEFT JOIN stages s ON s.id = d.stage_id
           LEFT JOIN contacts ct ON ct.id = d.contact_id
          WHERE d.id = $1 AND d.org_id = $2 AND d.archived_at IS NULL`,
        [request.params.dealId, orgId],
      );
      if (!deal) throw notFound('Deal');

      const [activities, history] = await Promise.all([
        db.rows(
          `SELECT * FROM activities WHERE org_id = $1 AND related_type = 'deal' AND related_id = $2
            ORDER BY created_at DESC LIMIT 50`,
          [orgId, deal.id],
        ),
        db.rows(
          `SELECT h.*, sf.name AS from_stage_name, st.name AS to_stage_name
             FROM deal_stage_history h
             LEFT JOIN stages sf ON sf.id = h.from_stage_id
             LEFT JOIN stages st ON st.id = h.to_stage_id
            WHERE h.org_id = $1 AND h.deal_id = $2 ORDER BY h.moved_at DESC`,
          [orgId, deal.id],
        ),
      ]);

      return { data: { ...shape(deal), activities, stage_history: history } };
    },
  );

  // ═════════════════════════════════════════════════════════════════ CREATE
  app.post(
    '/crm/deals',
    {
      preHandler: [app.loadContext, requirePermission('crm.deals.create')],
      schema: {
        body: body(
          {
            title: v.text(160, 1),
            value: v.money,
            company_id: v.id('cmp'),
            contact_id: v.id('con'),
            stage_id: v.id('stg'),
            pipeline_id: v.id('pip'),
            expected_close_date: v.date,
            owner_user_id: v.text(40),
            description: v.longText,
            tags: { type: 'array', items: v.text(40), maxItems: 20 },
          },
          ['title'],
        ),
      },
    },
    async (request, reply) => {
      const { orgId, userId } = request.ctx;
      const b = request.body;

      const pipelineId = b.pipeline_id ?? (await ensureDefaultPipeline(db, orgId));

      const stage = b.stage_id
        ? await db.one(`SELECT * FROM stages WHERE id = $1 AND org_id = $2 AND pipeline_id = $3`,
            [b.stage_id, orgId, pipelineId])
        : await db.one(
            `SELECT * FROM stages WHERE org_id = $1 AND pipeline_id = $2 AND kind = 'open'
              ORDER BY position LIMIT 1`, [orgId, pipelineId]);

      if (!stage) throw badRequest('That stage does not belong to this pipeline.');

      const deal = await db.transaction(async (tx) => {
        const created = await tx.one(
          `INSERT INTO deals
             (id, org_id, pipeline_id, stage_id, company_id, contact_id, title, value,
              probability, expected_close_date, owner_user_id, description, tags, created_by,
              board_position)
           VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::numeric,0),$9,$10,COALESCE($11,$12),$13,$14,$12,
                   COALESCE((SELECT max(board_position) + 1000 FROM deals
                              WHERE org_id = $2 AND stage_id = $4 AND archived_at IS NULL), 1000))
           RETURNING *`,
          [
            id('dea'), orgId, pipelineId, stage.id, b.company_id ?? null, b.contact_id ?? null,
            b.title.trim(), b.value ?? null, stage.probability, b.expected_close_date ?? null,
            b.owner_user_id ?? null, userId, b.description ?? null, b.tags ?? [],
          ],
        );

        await tx.query(
          `INSERT INTO deal_stage_history (org_id, deal_id, from_stage_id, to_stage_id, moved_by)
           VALUES ($1,$2,NULL,$3,$4)`,
          [orgId, created.id, stage.id, userId],
        );

        tx.emit({
          type: EVENTS.DEAL_CREATED,
          org_id: orgId,
          actor_id: userId,
          data: { deal_id: created.id, title: created.title, value: created.value, company_id: created.company_id },
        });

        return created;
      });

      return reply.status(201).send({ data: shape(deal) });
    },
  );

  // ══════════════════════════════════════════════════════ MOVE ON THE BOARD
  /**
   * A drag-and-drop on the kanban. Writes one row in the normal case by
   * placing the card at the midpoint of its new neighbours; only renumbers
   * the column when float precision runs out.
   */
  app.post(
    '/crm/deals/:dealId/move',
    {
      preHandler: [app.loadContext, requirePermission('crm.deals.edit')],
      schema: {
        params: params({ dealId: v.id('dea') }),
        body: body(
          { stage_id: v.id('stg'), before_id: v.id('dea'), after_id: v.id('dea') },
          ['stage_id'],
        ),
      },
    },
    async (request) => {
      const { orgId, userId } = request.ctx;
      const { stage_id: stageId, before_id: beforeId, after_id: afterId } = request.body;

      const deal = await db.one(
        `SELECT * FROM deals WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
        [request.params.dealId, orgId],
      );
      if (!deal) throw notFound('Deal');

      const stage = await db.one(
        `SELECT * FROM stages WHERE id = $1 AND org_id = $2 AND pipeline_id = $3`,
        [stageId, orgId, deal.pipeline_id],
      );
      if (!stage) throw badRequest('That stage does not belong to this deal’s pipeline.');

      const updated = await db.transaction(async (tx) => {
        const neighbours = await tx.rows(
          `SELECT id, board_position FROM deals
            WHERE org_id = $1 AND id = ANY($2) AND archived_at IS NULL`,
          [orgId, [beforeId, afterId].filter(Boolean)],
        );
        const positionOf = (target) =>
          target ? neighbours.find((n) => n.id === target)?.board_position ?? null : null;

        let position = positionBetween(positionOf(beforeId), positionOf(afterId));

        if (position === null) {
          await renumberStage(tx, orgId, stageId);
          const refreshed = await tx.rows(
            `SELECT id, board_position FROM deals
              WHERE org_id = $1 AND id = ANY($2) AND archived_at IS NULL`,
            [orgId, [beforeId, afterId].filter(Boolean)],
          );
          const after = (target) =>
            target ? refreshed.find((n) => n.id === target)?.board_position ?? null : null;
          position = positionBetween(after(beforeId), after(afterId)) ?? 1000;
        }

        const movedStage = stageId !== deal.stage_id;

        // Landing in a won/lost stage closes the deal — the board is the
        // interface people actually use, so it must drive status too.
        const status = stage.kind === 'open' ? 'open' : stage.kind;

        const row = await tx.one(
          `UPDATE deals
              SET stage_id = $3, board_position = $4, probability = $5, status = $6,
                  closed_at = CASE WHEN $6 <> 'open' THEN COALESCE(closed_at, now()) ELSE NULL END
            WHERE id = $1 AND org_id = $2 RETURNING *`,
          [deal.id, orgId, stageId, position, stage.probability, status],
        );

        if (movedStage) {
          await tx.query(
            `INSERT INTO deal_stage_history (org_id, deal_id, from_stage_id, to_stage_id, moved_by)
             VALUES ($1,$2,$3,$4,$5)`,
            [orgId, deal.id, deal.stage_id, stageId, userId],
          );

          tx.emit({
            type: EVENTS.DEAL_STAGE_CHANGED,
            org_id: orgId,
            actor_id: userId,
            data: { deal_id: deal.id, from_stage: deal.stage_id, to_stage: stageId, value: row.value },
          });

          if (status === 'won') {
            if (row.company_id) {
              await tx.query(
                `UPDATE companies SET is_customer = true,
                        customer_since = COALESCE(customer_since, now())
                  WHERE id = $1 AND org_id = $2`,
                [row.company_id, orgId],
              );
            }
            tx.emit({
              type: EVENTS.DEAL_WON,
              org_id: orgId,
              actor_id: userId,
              data: {
                deal_id: row.id, title: row.title, value: row.value, currency: row.currency,
                company_id: row.company_id, contact_id: row.contact_id,
                owner_user_id: row.owner_user_id,
              },
            });
          }

          if (status === 'lost') {
            tx.emit({
              type: EVENTS.DEAL_LOST,
              org_id: orgId,
              actor_id: userId,
              data: { deal_id: row.id, title: row.title, value: row.value, reason: row.lost_reason },
            });
          }
        }

        return row;
      });

      return { data: shape(updated) };
    },
  );

  // ═════════════════════════════════════════════════════════════════ UPDATE
  app.patch(
    '/crm/deals/:dealId',
    {
      preHandler: [app.loadContext, requirePermission('crm.deals.edit')],
      schema: {
        params: params({ dealId: v.id('dea') }),
        body: body({
          title: v.text(160, 1),
          value: v.money,
          company_id: v.id('cmp'),
          contact_id: v.id('con'),
          expected_close_date: v.date,
          owner_user_id: v.text(40),
          description: v.longText,
          lost_reason: v.text(240),
          probability: v.int(0, 100),
          tags: { type: 'array', items: v.text(40), maxItems: 20 },
        }),
      },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const existing = await db.one(
        `SELECT id FROM deals WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
        [request.params.dealId, orgId],
      );
      if (!existing) throw notFound('Deal');

      const fields = [
        'title', 'value', 'company_id', 'contact_id', 'expected_close_date',
        'owner_user_id', 'description', 'lost_reason', 'probability', 'tags',
      ].filter((f) => request.body[f] !== undefined);

      if (!fields.length) throw badRequest('Nothing to update.');

      const sets = fields.map((f, i) => `${f} = $${i + 3}`).join(', ');
      const updated = await db.one(
        `UPDATE deals SET ${sets} WHERE id = $1 AND org_id = $2 RETURNING *`,
        [existing.id, orgId, ...fields.map((f) => request.body[f])],
      );

      return { data: shape(updated) };
    },
  );

  app.delete(
    '/crm/deals/:dealId',
    {
      preHandler: [app.loadContext, requirePermission('crm.deals.delete')],
      schema: { params: params({ dealId: v.id('dea') }) },
    },
    async (request) => {
      const row = await db.one(
        `UPDATE deals SET archived_at = now()
          WHERE id = $1 AND org_id = $2 AND archived_at IS NULL RETURNING id`,
        [request.params.dealId, request.ctx.orgId],
      );
      if (!row) throw notFound('Deal');
      return { data: { archived: true } };
    },
  );
}

function shape(deal) {
  return {
    ...deal,
    contact_name: [deal.contact_first_name, deal.contact_last_name].filter(Boolean).join(' ') || null,
    weighted_value: (Number(deal.value) * (deal.probability ?? 0) / 100).toFixed(2),
  };
}
