import { query, validate as v, requireApp, requirePermission, peopleDirectory } from '@nexus/service-kit';

const TIMEZONES = new Set([...Intl.supportedValuesOf('timeZone'), 'UTC']);
// A call where someone actually spoke to the lead.
const REACHED = ['interested', 'call_back', 'not_interested', 'connected'];

/**
 * How the calling team is doing: any date range against the one just before
 * it (today vs yesterday, this week vs last), per person, per source, and
 * the log of who called which lead.
 *
 * People without "see everyone's leads" see their own work only.
 */
export async function leadsReportRoutes(app) {
  const { db, config } = app;
  const people = peopleDirectory({ tenancyUrl: config.tenancyUrl, serviceToken: config.serviceToken });
  const guard = (permission) => [app.loadContext, requireApp('leads'), requirePermission(permission)];
  const seesAll = (ctx) => ctx.can('leads.team.manage');

  const rangeQuery = {
    from: v.date,
    to: v.date,
    tz: v.text(64),
    user_id: { type: 'string', pattern: '^usr_[0-9a-hjkmnp-tv-z]{26}$' },
  };

  /** [org, tz, from, to, person?] — the period is whole days in the viewer's time zone. */
  function bounds(request) {
    const tz = TIMEZONES.has(request.query.tz) ? request.query.tz : 'Asia/Kolkata';
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
    let from = request.query.from ?? today;
    let to = request.query.to ?? from;
    if (to < from) [from, to] = [to, from];
    // One person's numbers: anyone's for managers, only your own otherwise.
    const person = seesAll(request.ctx) ? request.query.user_id ?? null : request.ctx.userId;
    return { tz, from, to, person, values: [request.ctx.orgId, tz, from, to, person] };
  }
  const RANGE = `(SELECT ($3::date::timestamp AT TIME ZONE $2) AS s, (($4::date + 1)::timestamp AT TIME ZONE $2) AS e) r`;

  app.get('/leads/reports', { preHandler: guard('leads.leads.view'), schema: { querystring: query(rangeQuery) } }, async (request) => {
    const { tz, from, to, person, values } = bounds(request);
    const mine = `($5::text IS NULL OR a.created_by = $5 OR a.assigned_to = $5)`;
    const ownLead = `($5::text IS NULL OR l.owner_user_id = $5)`;

    const [work, leads, won, overdue, days, team, sources, outcomes] = await Promise.all([
      // Calls and follow-ups, this period and the one before it.
      db.one(
        `SELECT
           count(*) FILTER (WHERE call AND at >= s AND at < e)::int AS calls,
           count(*) FILTER (WHERE call AND at >= s - (e - s) AND at < s)::int AS calls_prev,
           count(DISTINCT related_id) FILTER (WHERE call AND at >= s AND at < e)::int AS leads_called,
           count(DISTINCT related_id) FILTER (WHERE call AND at >= s - (e - s) AND at < s)::int AS leads_called_prev,
           count(*) FILTER (WHERE call AND reached AND at >= s AND at < e)::int AS connected,
           count(*) FILTER (WHERE call AND reached AND at >= s - (e - s) AND at < s)::int AS connected_prev,
           count(*) FILTER (WHERE call AND outcome = 'interested' AND at >= s AND at < e)::int AS interested,
           count(*) FILTER (WHERE call AND outcome = 'interested' AND at >= s - (e - s) AND at < s)::int AS interested_prev,
           count(*) FILTER (WHERE followup AND at >= s AND at < e)::int AS followups_done,
           count(*) FILTER (WHERE followup AND at >= s - (e - s) AND at < s)::int AS followups_done_prev,
           count(*) FILTER (WHERE booked AND created_at >= s AND created_at < e)::int AS followups_booked,
           count(*) FILTER (WHERE booked AND created_at >= s - (e - s) AND created_at < s)::int AS followups_booked_prev
         FROM (
           SELECT a.related_id, a.completed_at AS at, a.created_at, a.outcome,
                  a.kind = 'call' AND a.due_at IS NULL AND a.completed_at IS NOT NULL AS call,
                  a.outcome = ANY($6) AS reached,
                  a.due_at IS NOT NULL AND a.completed_at IS NOT NULL AND a.canceled_at IS NULL AS followup,
                  a.due_at IS NOT NULL AS booked
             FROM activities a
            WHERE a.org_id = $1 AND a.related_type = 'lead' AND ${mine}
              AND (a.completed_at >= ($3::date::timestamp AT TIME ZONE $2) - ((($4::date + 1) - $3::date) * interval '1 day')
                   OR a.created_at >= ($3::date::timestamp AT TIME ZONE $2) - ((($4::date + 1) - $3::date) * interval '1 day'))
         ) x, ${RANGE}`,
        [...values, REACHED],
      ),
      db.one(
        `SELECT count(*) FILTER (WHERE l.created_at >= s AND l.created_at < e)::int AS new_leads,
                count(*) FILTER (WHERE l.created_at >= s - (e - s) AND l.created_at < s)::int AS new_leads_prev
           FROM leads l, ${RANGE}
          WHERE l.org_id = $1 AND l.archived_at IS NULL AND ${ownLead} AND l.created_at >= s - (e - s)`,
        values,
      ),
      // Leads moved into a won or lost stage, from the timeline's "Moved to …" entries.
      db.one(
        `SELECT count(DISTINCT a.related_id) FILTER (WHERE st.kind = 'won' AND a.created_at >= s AND a.created_at < e)::int AS won,
                count(DISTINCT a.related_id) FILTER (WHERE st.kind = 'won' AND a.created_at >= s - (e - s) AND a.created_at < s)::int AS won_prev,
                count(DISTINCT a.related_id) FILTER (WHERE st.kind = 'lost' AND a.created_at >= s AND a.created_at < e)::int AS lost,
                count(DISTINCT a.related_id) FILTER (WHERE st.kind = 'lost' AND a.created_at >= s - (e - s) AND a.created_at < s)::int AS lost_prev
           FROM activities a JOIN lead_stages st ON st.org_id = a.org_id AND st.kind IN ('won', 'lost')
                AND a.subject LIKE 'Moved to ' || st.name || '%', ${RANGE}
          WHERE a.org_id = $1 AND a.related_type = 'lead' AND a.kind = 'update' AND ${mine} AND a.created_at >= s - (e - s)`,
        values,
      ),
      db.one(
        `SELECT count(*)::int AS n FROM activities a
          WHERE a.org_id = $1 AND a.related_type = 'lead' AND a.completed_at IS NULL AND a.due_at < now()
            AND ($5::text IS NULL OR a.assigned_to = $5) AND $2::text IS NOT NULL AND $3::date IS NOT NULL AND $4::date IS NOT NULL`,
        values,
      ),
      // Day by day, for the chart (at most 92 days).
      db.rows(
        `SELECT d::date::text AS day,
                (SELECT count(*) FROM leads l WHERE l.org_id = $1 AND l.archived_at IS NULL AND ${ownLead}
                   AND l.created_at >= (d::timestamp AT TIME ZONE $2) AND l.created_at < ((d + interval '1 day')::timestamp AT TIME ZONE $2))::int AS new_leads,
                (SELECT count(*) FROM activities a WHERE a.org_id = $1 AND a.related_type = 'lead' AND ${mine} AND a.kind = 'call' AND a.due_at IS NULL
                   AND a.completed_at >= (d::timestamp AT TIME ZONE $2) AND a.completed_at < ((d + interval '1 day')::timestamp AT TIME ZONE $2))::int AS calls,
                (SELECT count(*) FROM activities a WHERE a.org_id = $1 AND a.related_type = 'lead' AND ${mine} AND a.due_at IS NOT NULL AND a.canceled_at IS NULL
                   AND a.completed_at >= (d::timestamp AT TIME ZONE $2) AND a.completed_at < ((d + interval '1 day')::timestamp AT TIME ZONE $2))::int AS followups_done
           FROM generate_series($3::date, LEAST($4::date, $3::date + 91), interval '1 day') d`,
        values,
      ),
      // Per person: calls, leads called, reached, interested, follow-ups done.
      db.rows(
        `SELECT a.created_by AS user_id,
                count(*) FILTER (WHERE a.kind = 'call' AND a.due_at IS NULL)::int AS calls,
                count(DISTINCT a.related_id) FILTER (WHERE a.kind = 'call' AND a.due_at IS NULL)::int AS leads_called,
                count(*) FILTER (WHERE a.kind = 'call' AND a.due_at IS NULL AND a.outcome = ANY($6))::int AS connected,
                count(*) FILTER (WHERE a.kind = 'call' AND a.due_at IS NULL AND a.outcome = 'interested')::int AS interested,
                count(*) FILTER (WHERE a.due_at IS NOT NULL AND a.canceled_at IS NULL)::int AS followups_done,
                max(a.completed_at) AS last_activity
           FROM activities a, ${RANGE}
          WHERE a.org_id = $1 AND a.related_type = 'lead' AND a.created_by IS NOT NULL AND ${mine}
            AND a.completed_at >= s AND a.completed_at < e AND (a.kind = 'call' OR a.due_at IS NOT NULL)
          GROUP BY a.created_by ORDER BY calls DESC`,
        [...values, REACHED],
      ),
      db.rows(
        `SELECT COALESCE(l.source_detail, l.source) AS key, min(l.source) AS source, bool_or(l.source_detail IS NOT NULL) AS named,
                count(*) FILTER (WHERE l.created_at >= s AND l.created_at < e)::int AS count,
                count(*) FILTER (WHERE l.created_at >= s - (e - s) AND l.created_at < s)::int AS prev
           FROM leads l, ${RANGE}
          WHERE l.org_id = $1 AND l.archived_at IS NULL AND ${ownLead} AND l.created_at >= s - (e - s)
          GROUP BY 1 ORDER BY count DESC, prev DESC LIMIT 30`,
        values,
      ),
      db.rows(
        `SELECT a.outcome, count(*)::int AS count FROM activities a, ${RANGE}
          WHERE a.org_id = $1 AND a.related_type = 'lead' AND ${mine} AND a.kind = 'call' AND a.due_at IS NULL
            AND a.completed_at >= s AND a.completed_at < e
          GROUP BY a.outcome ORDER BY count DESC`,
        values,
      ),
    ]);

    // New leads per owner, merged into the people table.
    const assigned = await db.rows(
      `SELECT l.owner_user_id AS user_id, count(*)::int AS new_leads FROM leads l, ${RANGE}
        WHERE l.org_id = $1 AND l.archived_at IS NULL AND ${ownLead} AND l.owner_user_id IS NOT NULL
          AND l.created_at >= s AND l.created_at < e GROUP BY 1`,
      values,
    );
    const byUser = new Map(team.map((t) => [t.user_id, { ...t, new_leads: 0 }]));
    for (const row of assigned) {
      const entry = byUser.get(row.user_id) ?? { user_id: row.user_id, calls: 0, leads_called: 0, connected: 0, interested: 0, followups_done: 0, last_activity: null };
      byUser.set(row.user_id, { ...entry, new_leads: row.new_leads });
    }
    const names = await people.lookup([...byUser.keys()]);
    const pair = (now, prev) => ({ value: now, previous: prev });
    return {
      data: {
        range: { from, to, tz, days: days.length },
        summary: {
          new_leads: pair(leads.new_leads, leads.new_leads_prev),
          calls: pair(work.calls, work.calls_prev),
          leads_called: pair(work.leads_called, work.leads_called_prev),
          connected: pair(work.connected, work.connected_prev),
          interested: pair(work.interested, work.interested_prev),
          followups_done: pair(work.followups_done, work.followups_done_prev),
          followups_booked: pair(work.followups_booked, work.followups_booked_prev),
          won: pair(won.won, won.won_prev),
          lost: pair(won.lost, won.lost_prev),
          overdue_now: overdue.n,
        },
        days,
        people: [...byUser.values()].map((p) => ({ ...p, name: names.get(p.user_id)?.name ?? 'Former member' }))
          .sort((a, b) => b.calls - a.calls || b.new_leads - a.new_leads),
        sources,
        outcomes,
        scope: person ? (seesAll(request.ctx) ? 'person' : 'mine') : 'everyone',
      },
    };
  });

  /** Who did what to which lead: every call and follow-up in the period, newest first. */
  app.get('/leads/reports/activity', {
    preHandler: guard('leads.leads.view'),
    schema: { querystring: query({ ...rangeQuery, type: v.enum(['call', 'followup', 'all']) }) },
  }, async (request) => {
    const { values } = bounds(request);
    const type = request.query.type ?? 'all';
    const kind = type === 'call' ? `a.kind = 'call' AND a.due_at IS NULL`
      : type === 'followup' ? 'a.due_at IS NOT NULL AND a.canceled_at IS NULL'
        : `((a.kind = 'call' AND a.due_at IS NULL) OR (a.due_at IS NOT NULL AND a.canceled_at IS NULL) OR a.kind IN ('whatsapp', 'email', 'meeting', 'visit'))`;
    const limit = request.query.limit ?? 50;
    const offset = ((request.query.page ?? 1) - 1) * limit;
    const where = `a.org_id = $1 AND a.related_type = 'lead' AND a.completed_at >= r.s AND a.completed_at < r.e AND ${kind}
                   AND ($5::text IS NULL OR a.created_by = $5 OR a.assigned_to = $5)`;
    const [rows, total] = await Promise.all([
      db.rows(
        `SELECT a.id, a.kind, a.subject, a.body, a.outcome, a.completed_at, a.due_at, a.created_by,
                l.id AS lead_id, concat_ws(' ', l.first_name, l.last_name) AS lead_name, l.phone, l.company_name,
                st.name AS stage_name, st.color AS stage_color
           FROM activities a JOIN leads l ON l.org_id = a.org_id AND l.id = a.related_id
           LEFT JOIN lead_stages st ON st.id = l.stage_id, ${RANGE}
          WHERE ${where} ORDER BY a.completed_at DESC LIMIT ${limit} OFFSET ${offset}`,
        values,
      ),
      db.one(`SELECT count(*)::int AS n FROM activities a, ${RANGE} WHERE ${where}`, values),
    ]);
    const names = await people.lookup(rows.map((r) => r.created_by));
    return {
      data: rows.map((r) => ({ ...r, by: names.get(r.created_by)?.name ?? (r.created_by ? 'Former member' : null) })),
      meta: { total: total.n, page: request.query.page ?? 1, limit, pages: Math.ceil(total.n / limit) || 1 },
    };
  });
}
