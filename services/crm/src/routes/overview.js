import { requirePermission } from '@nexus/service-kit';
import { ensureDefaultPipeline } from '../lib/pipeline.js';

/**
 * Everything the CRM landing page and the platform dashboard widgets need, in
 * one round trip. Deliberately a single endpoint: six separate widget calls
 * would mean six authorization round trips for one screen.
 */
export async function overviewRoutes(app) {
  const { db } = app;

  app.get(
    '/crm/overview',
    { preHandler: [app.loadContext, requirePermission('crm.deals.view')] },
    async (request) => {
      const { orgId, userId } = request.ctx;
      await ensureDefaultPipeline(db, orgId);

      const [pipeline, leads, won, funnel, upcoming, recentDeals] = await Promise.all([
        db.one(
          `SELECT
             count(*) FILTER (WHERE status = 'open')::int AS open_count,
             COALESCE(sum(value) FILTER (WHERE status = 'open'), 0)::text AS open_value,
             COALESCE(sum(value * probability / 100.0) FILTER (WHERE status = 'open'), 0)::text AS weighted_value,
             COALESCE(sum(value) FILTER (WHERE status = 'won'
               AND closed_at >= date_trunc('month', now())), 0)::text AS won_this_month,
             count(*) FILTER (WHERE status = 'won'
               AND closed_at >= date_trunc('month', now()))::int AS won_count_month
           FROM deals WHERE org_id = $1 AND archived_at IS NULL`,
          [orgId],
        ),
        db.one(
          `SELECT
             count(*)::int AS total,
             count(*) FILTER (WHERE status = 'new')::int AS new,
             count(*) FILTER (WHERE status = 'converted')::int AS converted,
             count(*) FILTER (WHERE created_at >= date_trunc('month', now()))::int AS this_month
           FROM leads WHERE org_id = $1 AND archived_at IS NULL`,
          [orgId],
        ),
        db.rows(
          `SELECT to_char(date_trunc('month', closed_at), 'Mon') AS label,
                  date_trunc('month', closed_at) AS bucket,
                  COALESCE(sum(value), 0)::text AS value,
                  count(*)::int AS count
             FROM deals
            WHERE org_id = $1 AND status = 'won' AND archived_at IS NULL
              AND closed_at >= date_trunc('month', now()) - interval '5 months'
            GROUP BY bucket ORDER BY bucket`,
          [orgId],
        ),
        db.rows(
          `SELECT s.id, s.name, s.colour, s.position, s.probability,
                  count(d.id)::int AS count,
                  COALESCE(sum(d.value), 0)::text AS value
             FROM stages s
             LEFT JOIN deals d ON d.stage_id = s.id AND d.archived_at IS NULL AND d.status = 'open'
            WHERE s.org_id = $1 AND s.kind = 'open'
            GROUP BY s.id ORDER BY s.position`,
          [orgId],
        ),
        db.rows(
          `SELECT * FROM activities
            WHERE org_id = $1 AND completed_at IS NULL
              AND (assigned_to = $2 OR assigned_to IS NULL)
              AND due_at IS NOT NULL
            ORDER BY due_at LIMIT 8`,
          [orgId, userId],
        ),
        db.rows(
          `SELECT d.id, d.title, d.value, d.currency, d.status, d.updated_at,
                  c.name AS company_name, s.name AS stage_name, s.colour AS stage_colour
             FROM deals d
             LEFT JOIN companies c ON c.id = d.company_id
             LEFT JOIN stages s ON s.id = d.stage_id
            WHERE d.org_id = $1 AND d.archived_at IS NULL
            ORDER BY d.updated_at DESC LIMIT 6`,
          [orgId],
        ),
      ]);

      const conversion = leads.total > 0 ? Math.round((leads.converted / leads.total) * 100) : 0;

      return {
        data: {
          pipeline,
          leads: { ...leads, conversion_rate: conversion },
          revenue_trend: won,
          funnel,
          upcoming_activities: upcoming,
          recent_deals: recentDeals,
        },
      };
    },
  );

  /** Feeds the platform dashboard's CRM widgets. */
  app.get(
    '/crm/widgets',
    { preHandler: [app.loadContext, requirePermission('crm.deals.view')] },
    async (request) => {
      const { orgId } = request.ctx;

      const row = await db.one(
        `SELECT
           COALESCE((SELECT sum(value) FROM deals
                      WHERE org_id = $1 AND status = 'open' AND archived_at IS NULL), 0)::text AS pipeline_value,
           COALESCE((SELECT sum(value) FROM deals
                      WHERE org_id = $1 AND status = 'won' AND archived_at IS NULL
                        AND closed_at >= date_trunc('month', now())), 0)::text AS deals_won,
           (SELECT count(*) FROM leads WHERE org_id = $1 AND archived_at IS NULL)::int AS lead_total,
           (SELECT count(*) FROM leads WHERE org_id = $1 AND status = 'converted' AND archived_at IS NULL)::int AS lead_converted`,
        [orgId],
      );

      return {
        data: {
          'crm.pipeline_value': { value: row.pipeline_value, format: 'money' },
          'crm.deals_won': { value: row.deals_won, format: 'money' },
          'crm.conversion': {
            value: row.lead_total > 0 ? Math.round((row.lead_converted / row.lead_total) * 100) : 0,
            format: 'percent',
          },
        },
      };
    },
  );
}
