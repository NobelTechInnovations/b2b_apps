import { id } from '@nexus/db-kit';
import {
  body, params, query, validate as v, requireApp, requirePermission, badRequest, notFound, forbidden, conflict,
  nullable, peopleDirectory,
} from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';
import { insertLead, scoreFor } from '../lib/leads.js';
import { activeFields, cleanCustom, ensureStages, statusForStage } from '../lib/lead-fields.js';
import { phoneKey } from '../lib/lead-intake.js';

export const OUTCOMES = {
  interested: 'Interested',
  call_back: 'Asked to call back',
  not_interested: 'Not interested',
  no_answer: 'No answer',
  busy: 'Busy',
  switched_off: 'Switched off / unreachable',
  wrong_number: 'Wrong number',
  connected: 'Spoke to them',
};
const FOLLOWUP_KINDS = ['call', 'whatsapp', 'email', 'meeting', 'visit', 'task'];
export const LEAD_SOURCES = ['manual', 'website', 'referral', 'campaign', 'event', 'cold_call', 'import', 'api', 'partner',
  'meta', 'google_sheet', 'survey', 'webhook', 'whatsapp', 'walk_in'];
const TIMEZONES = new Set([...Intl.supportedValuesOf('timeZone'), 'UTC']);
const SORTS = {
  recent: 'l.created_at DESC',
  followup: 'l.next_followup_at ASC NULLS LAST, l.created_at DESC',
  last_call: 'l.last_call_at DESC NULLS LAST',
  updated: 'l.updated_at DESC',
  name: 'l.first_name ASC, l.last_name ASC NULLS FIRST',
  score: 'l.score DESC, l.created_at DESC',
};

const leadFields = {
  full_name: v.text(160),
  first_name: v.text(80),
  last_name: nullable(v.text(80, 0)),
  phone: nullable({ type: 'string', maxLength: 32 }),
  email: nullable({ type: 'string', maxLength: 254 }),
  company_name: nullable(v.text(160, 0)),
  job_title: nullable(v.text(120, 0)),
  city: nullable(v.text(80, 0)),
  source: v.enum(LEAD_SOURCES),
  rating: nullable(v.enum(['hot', 'warm', 'cold'])),
  estimated_value: nullable(v.money),
  owner_user_id: nullable(v.id('usr')),
  stage_id: v.id('lstg'),
  tags: { type: 'array', items: v.text(40), maxItems: 20 },
  notes: nullable(v.longText),
  lost_reason: nullable(v.text(240, 0)),
  custom: { type: 'object', additionalProperties: true, maxProperties: 100 },
};
const followupBody = {
  due_at: v.datetime,
  kind: v.enum(FOLLOWUP_KINDS),
  note: nullable(v.text(2000, 0)),
  assigned_to: nullable(v.id('usr')),
};

/**
 * The Leads app: a calling team's view of the leads table.
 *
 * People see the leads they own; `leads.team.manage` (owners, admins) sees
 * everyone's. A follow-up is an activity with a due time, so the same history
 * carries over when a lead becomes a CRM customer.
 */
export async function leadsAppRoutes(app) {
  const { db, config } = app;
  const people = peopleDirectory({ tenancyUrl: config.tenancyUrl, serviceToken: config.serviceToken });
  const guard = (permission) => [app.loadContext, requireApp('leads'), requirePermission(permission)];
  const leadParams = { params: params({ id: v.id('led') }) };
  const followupParams = { params: params({ id: v.id('act') }) };
  const seesAll = (ctx) => ctx.can('leads.team.manage');

  function scope(ctx, values, alias = 'l') {
    if (seesAll(ctx)) return null;
    values.push(ctx.userId);
    return `${alias}.owner_user_id = $${values.length}`;
  }

  async function loadLead(store, ctx, leadId, { lock = false } = {}) {
    const row = await store.one(
      `SELECT * FROM leads WHERE org_id = $1 AND id = $2 AND archived_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
      [ctx.orgId, leadId],
    );
    // Someone else's lead is "not found", not "forbidden": its existence is not theirs to learn.
    if (!row || (!seesAll(ctx) && row.owner_user_id !== ctx.userId)) throw notFound('Lead');
    return row;
  }

  /** The people leads can go to: anyone in the workspace who can open Leads. */
  const team = (orgId) => people.withPermission(orgId, 'leads.leads.view');

  async function assertTeammate(orgId, userId) {
    if (!(await team(orgId)).some((p) => p.user_id === userId)) throw badRequest('Choose someone who has access to Leads.');
  }

  async function assertOwner(ctx, ownerId) {
    if (!ownerId || ownerId === ctx.userId) return;
    if (!ctx.can('leads.leads.assign')) throw forbidden('Only people who can assign leads can give one to someone else.');
    await assertTeammate(ctx.orgId, ownerId);
  }

  /**
   * Changing a lead's owner. Managers (`leads.leads.assign`) assign anyone's
   * lead to anyone, or leave it unassigned. Everyone else can hand their own
   * lead over to a teammate, after which it leaves their list.
   */
  async function assertHandover(ctx, lead, ownerId) {
    if (ctx.can('leads.leads.assign')) return assertOwner(ctx, ownerId);
    if (lead.owner_user_id !== ctx.userId) throw forbidden('You can only hand over leads that are yours.');
    if (!ownerId) throw badRequest('Choose who to hand it to.');
    return assertTeammate(ctx.orgId, ownerId);
  }

  async function handedOver(tx, ctx, lead, ownerId, known = null) {
    const names = known ?? await people.lookup([ownerId, ctx.userId]);
    const to = ownerId ? names.get(ownerId)?.name ?? 'a teammate' : null;
    const managed = ctx.can('leads.leads.assign');
    await log(tx, ctx, lead.id, !ownerId ? 'Unassigned' : managed ? `Assigned to ${to}` : `Handed over to ${to}`);
    // Their open follow-ups go with the lead.
    await tx.query(
      `UPDATE activities SET assigned_to = $3 WHERE org_id = $1 AND related_type = 'lead' AND related_id = $2
          AND completed_at IS NULL AND assigned_to IS NOT DISTINCT FROM $4`,
      [ctx.orgId, lead.id, ownerId, lead.owner_user_id],
    );
    return managed ? null : `Handed over by ${names.get(ctx.userId)?.name ?? 'a teammate'}`;
  }

  async function stageById(store, orgId, stageId) {
    const stage = await store.one(`SELECT * FROM lead_stages WHERE org_id = $1 AND id = $2`, [orgId, stageId]);
    if (!stage) throw badRequest('That stage does not exist.');
    return stage;
  }

  async function log(tx, ctx, leadId, subject, extra = {}) {
    await tx.query(
      `INSERT INTO activities (id, org_id, kind, subject, body, related_type, related_id, completed_at, outcome,
                               duration_minutes, assigned_to, created_by)
       VALUES ($1,$2,$3,$4,$5,'lead',$6,now(),$7,$8,$9,$9)`,
      [id('act'), ctx.orgId, extra.kind ?? 'update', subject.slice(0, 300), extra.body ?? null, leadId,
        extra.outcome ?? null, extra.duration ?? null, ctx.userId],
    );
  }

  /** Keep the lead's "next follow-up" in step with its open follow-ups. */
  const syncNext = (tx, orgId, leadId) => tx.query(
    `UPDATE leads SET next_followup_at = (
       SELECT min(due_at) FROM activities
        WHERE org_id = $1 AND related_type = 'lead' AND related_id = $2 AND completed_at IS NULL AND due_at IS NOT NULL),
       updated_at = now()
      WHERE org_id = $1 AND id = $2`,
    [orgId, leadId],
  );

  async function addFollowup(tx, ctx, lead, f) {
    const assignee = f.assigned_to ?? lead.owner_user_id ?? ctx.userId;
    if (assignee !== ctx.userId && assignee !== lead.owner_user_id) await assertOwner(ctx, assignee);
    const row = await tx.one(
      `INSERT INTO activities (id, org_id, kind, subject, body, related_type, related_id, due_at, assigned_to, created_by)
       VALUES ($1,$2,$3,$4,$5,'lead',$6,$7,$8,$9) RETURNING *`,
      [id('act'), ctx.orgId, f.kind ?? 'call', `${kindLabel(f.kind ?? 'call')} ${leadName(lead)}`.slice(0, 300),
        f.note?.trim() || null, lead.id, f.due_at, assignee, ctx.userId],
    );
    await syncNext(tx, ctx.orgId, lead.id);
    return row;
  }

  async function changeStage(tx, ctx, lead, stageId) {
    if (!stageId || stageId === lead.stage_id) return;
    const [from, to] = await Promise.all([
      lead.stage_id ? tx.one(`SELECT name FROM lead_stages WHERE org_id = $1 AND id = $2`, [ctx.orgId, lead.stage_id]) : null,
      stageById(tx, ctx.orgId, stageId),
    ]);
    await tx.query(
      `UPDATE leads SET stage_id = $3, status = $4, updated_at = now() WHERE org_id = $1 AND id = $2`,
      [ctx.orgId, lead.id, to.id, statusForStage(to, lead.status)],
    );
    await log(tx, ctx, lead.id, `Moved to ${to.name}${from ? ` from ${from.name}` : ''}`);
  }

  async function hydrate(rows) {
    const names = await people.lookup(rows.map((r) => r.owner_user_id));
    return rows.map((r) => ({ ...shape(r), owner: r.owner_user_id ? names.get(r.owner_user_id) ?? { user_id: r.owner_user_id, name: 'Former member' } : null }));
  }

  const tzOf = (request) => (TIMEZONES.has(request.query?.tz) ? request.query.tz : 'Asia/Kolkata');

  // ═══════════════════════════════════════════════════════════ SETUP / META
  app.get('/leads/meta', { preHandler: guard('leads.leads.view') }, async (request) => {
    const { orgId } = request.ctx;
    const [stages, fields, members] = await Promise.all([ensureStages(db, orgId), activeFields(db, orgId), team(orgId)]);
    return {
      data: {
        stages, fields, team: members,
        outcomes: Object.entries(OUTCOMES).map(([value, label]) => ({ value, label })),
        sources: LEAD_SOURCES,
        sees_all: seesAll(request.ctx),
      },
    };
  });

  // ═══════════════════════════════════════════════════════════════════ LIST
  const listQuery = {
    stage_id: v.id('lstg'),
    stage_kind: v.enum(['open', 'won', 'lost']),
    owner: { type: 'string', pattern: '^(me|unassigned|usr_[0-9a-hjkmnp-tv-z]{26})$' },
    source: v.enum(LEAD_SOURCES),
    source_id: v.id('lsrc'),
    followup: v.enum(['overdue', 'today', 'upcoming', 'none']),
    outcome: v.enum(Object.keys(OUTCOMES)),
    fresh: v.bool,
    rating: v.enum(['hot', 'warm', 'cold']),
    created: v.enum(['today', 'week', 'month']),
    tag: v.text(40),
    // A group's own leads: a city by name, or `none` for leads without one.
    city: v.text(80),
    view: v.enum(['recent', 'followup', 'last_call', 'updated', 'name', 'score']),
    tz: v.text(64),
  };
  const FROM = 'leads l LEFT JOIN lead_stages s ON s.id = l.stage_id';
  const TODAY = '(now() AT TIME ZONE $2)::date';

  /** WHERE clause for a lead list from its query string; shared by the list and its groups. */
  async function listFilter(request) {
    const { orgId, userId } = request.ctx;
    const qs = request.query;
    const stages = await ensureStages(db, orgId);
    // A lead with no stage yet (from an older importer) sits in the first open stage.
    const first = (stages.find((s) => s.kind === 'open') ?? stages[0])?.id ?? null;
    const values = [orgId, tzOf(request), first];
    // $2 (the viewer's time zone) and $3 are always referenced, so their types are known.
    const where = ['l.org_id = $1', 'l.archived_at IS NULL', '$2::text IS NOT NULL', '$3::text IS NOT DISTINCT FROM $3::text'];
    const own = scope(request.ctx, values);
    if (own) where.push(own);
    const add = (sql, value) => { values.push(value); where.push(sql.replaceAll('?', `$${values.length}`)); };

    if (qs.stage_id) add('COALESCE(l.stage_id, $3) = ?', qs.stage_id);
    if (qs.stage_kind) add(`COALESCE(s.kind, 'open') = ?`, qs.stage_kind);
    if (qs.owner === 'me') add('l.owner_user_id = ?', userId);
    else if (qs.owner === 'unassigned') where.push('l.owner_user_id IS NULL');
    else if (qs.owner) add('l.owner_user_id = ?', qs.owner);
    if (qs.source) add('l.source = ?', qs.source);
    if (qs.source_id) add('l.source_id = ?', qs.source_id);
    if (qs.outcome) add('l.last_call_outcome = ?', qs.outcome);
    if (qs.fresh) where.push('l.call_count = 0');
    if (qs.rating) add('l.rating = ?', qs.rating);
    if (qs.tag) add('? = ANY(l.tags)', qs.tag);
    if (qs.city === 'none') where.push(`NULLIF(trim(l.city), '') IS NULL`);
    else if (qs.city) add('lower(trim(l.city)) = lower(trim(?))', qs.city);
    if (qs.followup === 'overdue') where.push(`l.next_followup_at < now() AND (l.next_followup_at AT TIME ZONE $2)::date < ${TODAY}`);
    if (qs.followup === 'today') where.push(`(l.next_followup_at AT TIME ZONE $2)::date = ${TODAY}`);
    if (qs.followup === 'upcoming') where.push(`(l.next_followup_at AT TIME ZONE $2)::date > ${TODAY}`);
    if (qs.followup === 'none') where.push('l.next_followup_at IS NULL');
    if (qs.created === 'today') where.push(`(l.created_at AT TIME ZONE $2)::date = ${TODAY}`);
    if (qs.created === 'week') where.push(`l.created_at > now() - interval '7 days'`);
    if (qs.created === 'month') where.push(`l.created_at > now() - interval '30 days'`);
    if (qs.q?.trim()) {
      const needle = qs.q.trim();
      const digits = needle.replace(/[^0-9]/g, '');
      values.push(`%${needle}%`);
      const n = values.length;
      const phone = digits.length >= 4 ? (values.push(`%${digits.slice(-10)}%`), ` OR l.phone_key LIKE $${values.length}`) : '';
      where.push(`(concat_ws(' ', l.first_name, l.last_name) ILIKE $${n} OR l.company_name ILIKE $${n} OR l.email ILIKE $${n}
                   OR l.city ILIKE $${n} OR l.custom::text ILIKE $${n}${phone})`);
    }
    return { values, clause: where.join(' AND '), stages, first };
  }

  app.get('/leads/leads', { preHandler: guard('leads.leads.view'), schema: { querystring: query(listQuery) } }, async (request) => {
    const qs = request.query;
    const { values, clause } = await listFilter(request);
    const limit = qs.limit ?? 25;
    const offset = ((qs.page ?? 1) - 1) * limit;
    const countValues = [request.ctx.orgId, tzOf(request)];
    const countScope = scope(request.ctx, countValues);

    const [rows, total, counts] = await Promise.all([
      db.rows(
        `SELECT l.*, s.name AS stage_name, s.color AS stage_color, s.kind AS stage_kind FROM ${FROM}
          WHERE ${clause} ORDER BY ${SORTS[qs.view ?? 'recent']} LIMIT ${limit} OFFSET ${offset}`,
        values,
      ),
      db.one(`SELECT count(*)::int AS n FROM ${FROM} WHERE ${clause}`, values),
      db.one(
        `SELECT count(*)::int AS all,
                count(*) FILTER (WHERE COALESCE(s.kind, 'open') = 'open')::int AS open,
                count(*) FILTER (WHERE l.next_followup_at < now() AND (l.next_followup_at AT TIME ZONE $2)::date < ${TODAY})::int AS overdue,
                count(*) FILTER (WHERE (l.next_followup_at AT TIME ZONE $2)::date = ${TODAY})::int AS today,
                count(*) FILTER (WHERE l.call_count = 0 AND COALESCE(s.kind, 'open') = 'open')::int AS fresh,
                count(*) FILTER (WHERE (l.created_at AT TIME ZONE $2)::date = ${TODAY})::int AS new_today
           FROM ${FROM} WHERE l.org_id = $1 AND l.archived_at IS NULL${countScope ? ` AND ${countScope}` : ''}`,
        countValues,
      ),
    ]);
    return { data: await hydrate(rows), meta: { total: total.n, page: qs.page ?? 1, limit, pages: Math.ceil(total.n / limit) || 1, counts } };
  });

  /**
   * The same list, grouped: how many leads in each stage, with each person,
   * from each source, per last call result, city, tag or follow-up. Each
   * group's key is the filter that opens just that group.
   */
  const GROUPS = ['stage', 'owner', 'source', 'outcome', 'followup', 'city', 'tag'];
  app.get('/leads/groups', {
    preHandler: guard('leads.leads.view'),
    schema: { querystring: query({ ...listQuery, by: v.enum(GROUPS) }) },
  }, async (request) => {
    const by = request.query.by ?? 'stage';
    const { values, clause, stages } = await listFilter(request);
    const key = {
      stage: 'COALESCE(l.stage_id, $3)',
      owner: 'l.owner_user_id',
      source: 'l.source',
      outcome: 'l.last_call_outcome',
      city: `NULLIF(initcap(lower(trim(l.city))), '')`,
      followup: `CASE WHEN l.next_followup_at IS NULL THEN 'none'
                      WHEN (l.next_followup_at AT TIME ZONE $2)::date < ${TODAY} THEN 'overdue'
                      WHEN (l.next_followup_at AT TIME ZONE $2)::date = ${TODAY} THEN 'today' ELSE 'upcoming' END`,
    }[by];
    const rows = by === 'tag'
      ? await db.rows(
        `SELECT t.tag AS key, count(*)::int AS count FROM ${FROM} CROSS JOIN LATERAL unnest(l.tags) AS t(tag)
          WHERE ${clause} GROUP BY t.tag ORDER BY count DESC, t.tag LIMIT 60`,
        values,
      )
      : await db.rows(`SELECT ${key} AS key, count(*)::int AS count FROM ${FROM} WHERE ${clause} GROUP BY 1 ORDER BY count DESC LIMIT 60`, values);

    const names = by === 'owner' ? await people.lookup(rows.map((r) => r.key)) : null;
    const FOLLOW = { overdue: 'Overdue', today: 'Today', upcoming: 'Upcoming', none: 'No follow-up booked' };
    const groups = rows.map((r) => {
      switch (by) {
        case 'stage': {
          const stage = stages.find((s) => s.id === r.key);
          return { key: r.key, label: stage?.name ?? 'No stage', color: stage?.color ?? 'slate', count: r.count, filter: { stage_id: r.key }, order: stage?.position ?? 99 };
        }
        case 'owner':
          return { key: r.key ?? 'unassigned', label: r.key ? names.get(r.key)?.name ?? 'Former member' : 'Unassigned', count: r.count, filter: { owner: r.key ?? 'unassigned' } };
        case 'source':
          return { key: r.key, label: r.key, count: r.count, filter: { source: r.key } };
        case 'outcome':
          return { key: r.key ?? 'none', label: r.key ? OUTCOMES[r.key] : 'Not called yet', count: r.count, filter: r.key ? { outcome: r.key } : { fresh: true } };
        case 'followup':
          return { key: r.key, label: FOLLOW[r.key], count: r.count, filter: { followup: r.key }, order: ['overdue', 'today', 'upcoming', 'none'].indexOf(r.key) };
        case 'city':
          return { key: r.key ?? 'none', label: r.key ?? 'No city', count: r.count, filter: { city: r.key ?? 'none' } };
        default:
          return { key: r.key, label: r.key, count: r.count, filter: { tag: r.key } };
      }
    });
    if (by === 'stage' || by === 'followup') groups.sort((a, b) => a.order - b.order);
    return { data: groups.map(({ order: _order, ...g }) => g), meta: { by } };
  });

  // ═══════════════════════════════════════════════════════════════════ READ
  app.get('/leads/leads/:id', { preHandler: guard('leads.leads.view'), schema: leadParams }, async (request) => {
    const lead = await loadLead(db, request.ctx, request.params.id);
    const [stage, timeline] = await Promise.all([
      lead.stage_id ? db.one(`SELECT id, name, color, kind FROM lead_stages WHERE id = $1`, [lead.stage_id]) : null,
      db.rows(
        `SELECT * FROM activities WHERE org_id = $1 AND related_type = 'lead' AND related_id = $2
          ORDER BY COALESCE(completed_at, created_at) DESC LIMIT 200`,
        [request.ctx.orgId, lead.id],
      ),
    ]);
    const names = await people.lookup([lead.owner_user_id, ...timeline.flatMap((a) => [a.created_by, a.assigned_to])]);
    const person = (userId) => (userId ? names.get(userId) ?? { user_id: userId, name: 'Former member' } : null);
    const entries = timeline.map((a) => ({ ...a, by: person(a.created_by), for: person(a.assigned_to) }));
    return {
      data: {
        ...shape(lead), stage, owner: person(lead.owner_user_id),
        followups: entries.filter((a) => a.due_at && !a.completed_at).sort((a, b) => new Date(a.due_at) - new Date(b.due_at)),
        timeline: entries.filter((a) => a.completed_at || !a.due_at),
      },
    };
  });

  // ═════════════════════════════════════════════════════════════════ CREATE
  app.post('/leads/leads', {
    preHandler: guard('leads.leads.create'),
    schema: { body: body({ ...leadFields, allow_duplicate: v.bool, followup: body(followupBody, ['due_at']) }) },
  }, async (request, reply) => {
    const { orgId, userId } = request.ctx;
    const b = request.body;
    let first = b.first_name?.trim();
    let last = b.last_name?.trim() || null;
    if (!first && b.full_name?.trim()) {
      [first, ...last] = b.full_name.trim().split(/\s+/);
      last = last.join(' ') || null;
    }
    const phone = b.phone?.trim() || null;
    const email = b.email?.trim().toLowerCase() || null;
    if (!first && !phone) throw badRequest('Give the lead a name or a phone number.', [{ field: 'full_name', message: 'Enter a name or a phone number.' }]);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('Enter a valid email address.', [{ field: 'email', message: 'Enter a valid email address.' }]);
    if (phone && phone.replace(/[^0-9]/g, '').length < 6) throw badRequest('Enter a valid phone number.', [{ field: 'phone', message: 'Enter a valid phone number.' }]);

    const owner = b.owner_user_id === undefined ? userId : b.owner_user_id;
    await assertOwner(request.ctx, owner);
    const fields = await activeFields(db, orgId);
    const { values: custom } = cleanCustom(fields, b.custom ?? {});
    const stages = await ensureStages(db, orgId);
    if (b.stage_id && !stages.some((s) => s.id === b.stage_id)) throw badRequest('That stage does not exist.');

    if (!b.allow_duplicate && (email || phone)) {
      const twin = await db.one(
        `SELECT id, first_name, last_name, owner_user_id FROM leads
          WHERE org_id = $1 AND archived_at IS NULL AND (lower(email) = $2 OR phone_key = $3) LIMIT 1`,
        [orgId, email, phoneKey(phone)],
      );
      if (twin) {
        const visible = seesAll(request.ctx) || twin.owner_user_id === userId;
        throw conflict('A lead with this phone or email already exists.', {
          code: 'duplicate_lead', lead_id: visible ? twin.id : null, name: visible ? leadName(twin) : null,
        });
      }
    }

    const lead = await db.transaction(async (tx) => {
      const created = await insertLead(tx, {
        orgId, actorId: userId,
        fields: {
          first_name: (first ?? phone).slice(0, 80), last_name: last, email, phone,
          company_name: b.company_name?.trim() || null, job_title: b.job_title?.trim() || null, city: b.city?.trim() || null,
          source: b.source ?? 'manual', rating: b.rating ?? null, estimated_value: b.estimated_value ?? null,
          owner_user_id: owner, tags: b.tags ?? [], notes: b.notes?.trim() || null, custom, stage_id: b.stage_id ?? null,
        },
      });
      if (b.followup) await addFollowup(tx, request.ctx, created, b.followup);
      return created;
    });
    return reply.status(201).send({ data: (await hydrate([await loadLead(db, request.ctx, lead.id)]))[0] });
  });

  // ═════════════════════════════════════════════════════════════════ UPDATE
  app.patch('/leads/leads/:id', {
    preHandler: guard('leads.leads.edit'),
    schema: { ...leadParams, body: body(leadFields) },
  }, async (request) => {
    const { orgId, userId } = request.ctx;
    const b = request.body;
    await db.transaction(async (tx) => {
      const lead = await loadLead(tx, request.ctx, request.params.id, { lock: true });
      const sets = [];
      const values = [orgId, lead.id];
      const set = (column, value) => { values.push(value); sets.push(`${column} = $${values.length}`); };

      if (b.full_name !== undefined && b.first_name === undefined) {
        const [first, ...rest] = b.full_name.trim().split(/\s+/);
        if (!first) throw badRequest('A lead needs a name.');
        set('first_name', first.slice(0, 80));
        set('last_name', rest.join(' ') || null);
      }
      if (b.first_name !== undefined) {
        if (!b.first_name.trim()) throw badRequest('A lead needs a name.');
        set('first_name', b.first_name.trim());
      }
      if (b.last_name !== undefined && b.full_name === undefined) set('last_name', b.last_name?.trim() || null);
      if (b.email !== undefined) {
        const email = b.email?.trim().toLowerCase() || null;
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('Enter a valid email address.', [{ field: 'email', message: 'Enter a valid email address.' }]);
        set('email', email);
      }
      if (b.phone !== undefined) {
        const phone = b.phone?.trim() || null;
        if (phone && phone.replace(/[^0-9]/g, '').length < 6) throw badRequest('Enter a valid phone number.', [{ field: 'phone', message: 'Enter a valid phone number.' }]);
        set('phone', phone);
      }
      for (const column of ['company_name', 'job_title', 'city', 'notes', 'lost_reason']) {
        if (b[column] !== undefined) set(column, b[column]?.trim() || null);
      }
      for (const column of ['source', 'rating', 'estimated_value', 'tags']) {
        if (b[column] !== undefined) set(column, b[column]);
      }
      if (b.custom !== undefined) {
        const fields = await activeFields(tx, orgId);
        const { values: custom } = cleanCustom(fields, b.custom, { partial: true });
        const merged = { ...lead.custom, ...custom };
        for (const [key, value] of Object.entries(merged)) if (value === null) delete merged[key];
        set('custom', JSON.stringify(merged));
      }
      if (b.owner_user_id !== undefined && b.owner_user_id !== lead.owner_user_id) {
        await assertHandover(request.ctx, lead, b.owner_user_id);
        set('owner_user_id', b.owner_user_id);
        const via = await handedOver(tx, request.ctx, lead, b.owner_user_id);
        if (b.owner_user_id && b.owner_user_id !== userId) {
          tx.emit({ type: EVENTS.LEAD_ASSIGNED, org_id: orgId, actor_id: userId, data: { owner_user_id: b.owner_user_id, count: 1, lead_id: lead.id, name: leadName(lead), via } });
        }
      }
      if (sets.length) {
        const next = { ...lead, ...b };
        set('score', scoreFor(next));
        await tx.query(`UPDATE leads SET ${sets.join(', ')}, updated_at = now() WHERE org_id = $1 AND id = $2`, values);
      }
      if (b.stage_id) await changeStage(tx, request.ctx, lead, b.stage_id);
    });
    // Handed over: it is the teammate's now, so say so rather than show it.
    if (!seesAll(request.ctx) && b.owner_user_id !== undefined && b.owner_user_id !== userId) {
      return { data: { id: request.params.id, owner_user_id: b.owner_user_id, handed_over: true } };
    }
    return { data: (await hydrate([await loadLead(db, request.ctx, request.params.id)]))[0] };
  });

  // ═══════════════════════════════════════════════════════════════ ARCHIVE
  app.delete('/leads/leads/:id', { preHandler: guard('leads.leads.delete'), schema: leadParams }, async (request) => {
    await loadLead(db, request.ctx, request.params.id);
    await db.query(`UPDATE leads SET archived_at = now() WHERE org_id = $1 AND id = $2`, [request.ctx.orgId, request.params.id]);
    // Its reminders stop with it.
    await db.query(
      `UPDATE activities SET completed_at = now(), canceled_at = now() WHERE org_id = $1 AND related_type = 'lead' AND related_id = $2 AND completed_at IS NULL`,
      [request.ctx.orgId, request.params.id],
    );
    return { data: { archived: true } };
  });

  // ═══════════════════════════════════════════════════════════════════ BULK
  app.post('/leads/leads/bulk', {
    preHandler: guard('leads.leads.edit'),
    schema: {
      body: body({
        ids: { type: 'array', items: v.id('led'), minItems: 1, maxItems: 500 },
        action: v.enum(['assign', 'stage', 'tag', 'delete']),
        owner_user_id: nullable(v.id('usr')),
        stage_id: v.id('lstg'),
        tag: v.text(40),
      }, ['ids', 'action']),
    },
  }, async (request) => {
    const { orgId, userId } = request.ctx;
    const b = request.body;
    if (b.action === 'delete' && !request.ctx.can('leads.leads.delete')) throw forbidden('You cannot delete leads.');
    // Managers assign anyone's leads; everyone else hands over their own (the scope below keeps it to theirs).
    if (b.action === 'assign') {
      if (request.ctx.can('leads.leads.assign')) await assertOwner(request.ctx, b.owner_user_id ?? null);
      else if (!b.owner_user_id) throw badRequest('Choose who to hand them to.');
      else await assertTeammate(orgId, b.owner_user_id);
    }
    const stage = b.action === 'stage' ? await stageById(db, orgId, b.stage_id ?? '') : null;
    if (b.action === 'tag' && !b.tag?.trim()) throw badRequest('Name the tag.');

    const changed = await db.transaction(async (tx) => {
      const values = [orgId, b.ids];
      const own = scope(request.ctx, values);
      const leads = await tx.rows(
        `SELECT * FROM leads l WHERE l.org_id = $1 AND l.id = ANY($2) AND l.archived_at IS NULL${own ? ` AND ${own}` : ''} FOR UPDATE`,
        values,
      );
      const ids = leads.map((l) => l.id);
      if (!ids.length) return 0;
      if (b.action === 'assign') {
        const owner = b.owner_user_id ?? null;
        let via = null;
        const names = await people.lookup([owner, userId]);
        for (const lead of leads) via = await handedOver(tx, request.ctx, lead, owner, names);
        await tx.query(`UPDATE leads SET owner_user_id = $3, updated_at = now() WHERE org_id = $1 AND id = ANY($2)`, [orgId, ids, owner]);
        if (owner && owner !== userId) {
          tx.emit({ type: EVENTS.LEAD_ASSIGNED, org_id: orgId, actor_id: userId, data: { owner_user_id: owner, count: ids.length, ...(ids.length === 1 ? { lead_id: ids[0], name: leadName(leads[0]) } : {}), via } });
        }
      } else if (b.action === 'stage') {
        for (const lead of leads) await changeStage(tx, request.ctx, lead, stage.id);
      } else if (b.action === 'tag') {
        await tx.query(
          `UPDATE leads SET tags = array_append(tags, $3), updated_at = now() WHERE org_id = $1 AND id = ANY($2) AND NOT ($3 = ANY(tags))`,
          [orgId, ids, b.tag.trim()],
        );
      } else {
        await tx.query(`UPDATE leads SET archived_at = now() WHERE org_id = $1 AND id = ANY($2)`, [orgId, ids]);
        await tx.query(
          `UPDATE activities SET completed_at = now(), canceled_at = now() WHERE org_id = $1 AND related_type = 'lead' AND related_id = ANY($2) AND completed_at IS NULL`,
          [orgId, ids],
        );
      }
      return ids.length;
    });
    return { data: { changed } };
  });

  // ═════════════════════════════════════════════════════════════════ CALLS
  /**
   * "Call update": what happened, a note, maybe a new stage, and when to
   * try next — one tap after hanging up. Follow-ups that were due by now
   * count as done, since this call was them.
   */
  app.post('/leads/leads/:id/calls', {
    preHandler: guard('leads.calls.log'),
    schema: {
      ...leadParams,
      body: body({
        outcome: v.enum(Object.keys(OUTCOMES)),
        note: nullable(v.text(5000, 0)),
        duration_minutes: nullable(v.int(0, 600)),
        stage_id: v.id('lstg'),
        followup: body(followupBody, ['due_at']),
      }, ['outcome']),
    },
  }, async (request) => {
    const { orgId, userId } = request.ctx;
    const b = request.body;
    await db.transaction(async (tx) => {
      const lead = await loadLead(tx, request.ctx, request.params.id, { lock: true });
      await tx.query(
        `UPDATE activities SET completed_at = now(), outcome = COALESCE(outcome, 'done')
          WHERE org_id = $1 AND related_type = 'lead' AND related_id = $2 AND completed_at IS NULL
            AND due_at <= now() + interval '1 hour'`,
        [orgId, lead.id],
      );
      await log(tx, request.ctx, lead.id, `Call · ${OUTCOMES[b.outcome]}`, {
        kind: 'call', body: b.note?.trim() || null, outcome: b.outcome, duration: b.duration_minutes ?? null,
      });
      await tx.query(
        `UPDATE leads SET call_count = call_count + 1, last_call_at = now(), last_call_outcome = $3, last_contacted_at = now(),
                status = CASE WHEN status = 'new' THEN 'contacted' ELSE status END,
                owner_user_id = COALESCE(owner_user_id, $4), updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [orgId, lead.id, b.outcome, userId],
      );
      if (b.stage_id) await changeStage(tx, request.ctx, { ...lead, status: lead.status === 'new' ? 'contacted' : lead.status }, b.stage_id);
      if (b.followup) await addFollowup(tx, request.ctx, { ...lead, owner_user_id: lead.owner_user_id ?? userId }, b.followup);
      await syncNext(tx, orgId, lead.id);
    });
    return { data: (await hydrate([await loadLead(db, request.ctx, request.params.id)]))[0] };
  });

  app.post('/leads/leads/:id/notes', {
    preHandler: guard('leads.leads.edit'),
    schema: { ...leadParams, body: body({ body: v.text(5000, 1), kind: v.enum(['note', 'whatsapp', 'email', 'meeting', 'visit']) }, ['body']) },
  }, async (request, reply) => {
    await db.transaction(async (tx) => {
      const lead = await loadLead(tx, request.ctx, request.params.id, { lock: true });
      const kind = request.body.kind ?? 'note';
      const subject = { note: 'Note', whatsapp: 'WhatsApp message', email: 'Email', meeting: 'Meeting', visit: 'Visit' }[kind];
      await log(tx, request.ctx, lead.id, subject, { kind, body: request.body.body.trim() });
      if (kind !== 'note') await tx.query(`UPDATE leads SET last_contacted_at = now(), status = CASE WHEN status = 'new' THEN 'contacted' ELSE status END WHERE org_id = $1 AND id = $2`, [request.ctx.orgId, lead.id]);
      await tx.query(`UPDATE leads SET updated_at = now() WHERE org_id = $1 AND id = $2`, [request.ctx.orgId, lead.id]);
    });
    return reply.status(201).send({ data: { logged: true } });
  });

  // ═════════════════════════════════════════════════════════════ FOLLOW-UPS
  app.post('/leads/leads/:id/followups', {
    preHandler: guard('leads.followups.create'),
    schema: { ...leadParams, body: body(followupBody, ['due_at']) },
  }, async (request, reply) => {
    const row = await db.transaction(async (tx) => {
      const lead = await loadLead(tx, request.ctx, request.params.id, { lock: true });
      return addFollowup(tx, request.ctx, lead, request.body);
    });
    return reply.status(201).send({ data: row });
  });

  app.get('/leads/followups', {
    preHandler: guard('leads.followups.view'),
    schema: {
      querystring: query({
        bucket: v.enum(['overdue', 'today', 'upcoming', 'done']),
        owner: { type: 'string', pattern: '^(me|all|usr_[0-9a-hjkmnp-tv-z]{26})$' },
        tz: v.text(64),
      }),
    },
  }, async (request) => {
    const { orgId, userId } = request.ctx;
    const qs = request.query;
    const values = [orgId, tzOf(request)];
    const where = [`a.org_id = $1`, `$2::text IS NOT NULL`, `a.related_type = 'lead'`, `a.due_at IS NOT NULL`, `l.archived_at IS NULL`];
    const owner = seesAll(request.ctx) ? (qs.owner ?? 'me') : 'me';
    if (owner === 'me') { values.push(userId); where.push(`a.assigned_to = $${values.length}`); }
    else if (owner !== 'all') { values.push(owner); where.push(`a.assigned_to = $${values.length}`); }
    const today = `(now() AT TIME ZONE $2)::date`;
    const day = `(a.due_at AT TIME ZONE $2)::date`;
    const buckets = {
      overdue: `a.completed_at IS NULL AND ${day} < ${today}`,
      today: `a.completed_at IS NULL AND ${day} = ${today}`,
      upcoming: `a.completed_at IS NULL AND ${day} > ${today}`,
      done: `a.completed_at IS NOT NULL AND a.canceled_at IS NULL AND a.completed_at > now() - interval '7 days'`,
    };
    const bucket = qs.bucket ?? 'today';
    const base = where.join(' AND ');
    const from = 'activities a JOIN leads l ON l.org_id = a.org_id AND l.id = a.related_id LEFT JOIN lead_stages s ON s.id = l.stage_id';
    const limit = qs.limit ?? 50;
    const [rows, counts] = await Promise.all([
      db.rows(
        `SELECT a.*, l.first_name, l.last_name, l.phone, l.email, l.company_name, l.city, l.owner_user_id, l.last_call_outcome,
                l.call_count, s.name AS stage_name, s.color AS stage_color
           FROM ${from} WHERE ${base} AND ${buckets[bucket]}
          ORDER BY ${bucket === 'done' ? 'a.completed_at DESC' : 'a.due_at ASC'} LIMIT ${limit} OFFSET ${((qs.page ?? 1) - 1) * limit}`,
        values,
      ),
      db.one(
        `SELECT count(*) FILTER (WHERE ${buckets.overdue})::int AS overdue,
                count(*) FILTER (WHERE ${buckets.today})::int AS today,
                count(*) FILTER (WHERE ${buckets.upcoming})::int AS upcoming,
                count(*) FILTER (WHERE ${buckets.done})::int AS done
           FROM ${from} WHERE ${base}`,
        values,
      ),
    ]);
    const names = await people.lookup(rows.map((r) => r.assigned_to));
    return {
      data: rows.map((r) => ({ ...r, lead_name: leadName(r), assignee: r.assigned_to ? names.get(r.assigned_to) ?? null : null })),
      meta: { counts, bucket, owner },
    };
  });

  async function loadFollowup(tx, ctx, followupId) {
    const row = await tx.one(
      `SELECT a.*, l.owner_user_id FROM activities a JOIN leads l ON l.org_id = a.org_id AND l.id = a.related_id
        WHERE a.org_id = $1 AND a.id = $2 AND a.related_type = 'lead' AND a.due_at IS NOT NULL FOR UPDATE OF a`,
      [ctx.orgId, followupId],
    );
    if (!row || (!seesAll(ctx) && row.assigned_to !== ctx.userId && row.owner_user_id !== ctx.userId)) throw notFound('Follow-up');
    return row;
  }

  app.patch('/leads/followups/:id', {
    preHandler: guard('leads.followups.edit'),
    schema: { ...followupParams, body: body({ due_at: v.datetime, kind: v.enum(FOLLOWUP_KINDS), note: nullable(v.text(2000, 0)) }) },
  }, async (request) => {
    const row = await db.transaction(async (tx) => {
      const f = await loadFollowup(tx, request.ctx, request.params.id);
      if (f.completed_at) throw badRequest('This follow-up is already closed.');
      const updated = await tx.one(
        `UPDATE activities SET due_at = COALESCE($3, due_at), kind = COALESCE($4, kind), body = CASE WHEN $6 THEN $5 ELSE body END,
                reminded_at = CASE WHEN $3::timestamptz IS NULL THEN reminded_at ELSE NULL END, updated_at = now()
          WHERE org_id = $1 AND id = $2 RETURNING *`,
        [request.ctx.orgId, f.id, request.body.due_at ?? null, request.body.kind ?? null, request.body.note?.trim() || null, request.body.note !== undefined],
      );
      await syncNext(tx, request.ctx.orgId, f.related_id);
      return updated;
    });
    return { data: row };
  });

  const close = (path, canceled) => app.post(`/leads/followups/:id/${path}`, {
    preHandler: guard('leads.followups.edit'),
    schema: { ...followupParams, body: body({ note: nullable(v.text(2000, 0)) }) },
  }, async (request) => {
    const row = await db.transaction(async (tx) => {
      const f = await loadFollowup(tx, request.ctx, request.params.id);
      if (f.completed_at) throw badRequest('This follow-up is already closed.');
      const note = request.body?.note?.trim();
      const updated = await tx.one(
        `UPDATE activities SET completed_at = now(), canceled_at = ${canceled ? 'now()' : 'NULL'}, outcome = $3,
                body = CASE WHEN $4::text IS NULL THEN body ELSE concat_ws(E'\\n\\n', body, $4::text) END, updated_at = now()
          WHERE org_id = $1 AND id = $2 RETURNING *`,
        [request.ctx.orgId, f.id, canceled ? 'canceled' : 'done', note || null],
      );
      if (!canceled) await tx.query(`UPDATE leads SET last_contacted_at = now() WHERE org_id = $1 AND id = $2`, [request.ctx.orgId, f.related_id]);
      await syncNext(tx, request.ctx.orgId, f.related_id);
      return updated;
    });
    return { data: row };
  });
  close('done', false);
  close('cancel', true);

  // ═══════════════════════════════════════════════════════════════ WIDGETS
  app.get('/leads/widgets', { preHandler: guard('leads.leads.view') }, async (request) => {
    const { orgId, userId } = request.ctx;
    const values = [orgId];
    const own = scope(request.ctx, values);
    values.push(userId);
    const me = values.length;
    const row = await db.one(
      `SELECT
         (SELECT count(*)::int FROM activities a WHERE a.org_id = $1 AND a.related_type = 'lead' AND a.completed_at IS NULL
             AND a.assigned_to = $${me} AND (a.due_at AT TIME ZONE 'Asia/Kolkata')::date <= (now() AT TIME ZONE 'Asia/Kolkata')::date) AS due,
         (SELECT count(*)::int FROM leads l WHERE l.org_id = $1 AND l.archived_at IS NULL${own ? ` AND ${own}` : ''}
             AND (l.created_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date) AS fresh`,
      values,
    );
    return { data: { 'leads.followups_today': row.due, 'leads.new_today': row.fresh } };
  });

  // ═══════════════════════════════════════════════════════════════ REMINDERS
  // A follow-up due within ten minutes reminds the person it is assigned to,
  // once. Ones that were already hours late when this started stay quiet.
  const timer = setInterval(async () => {
    try {
      const due = await db.rows(
        `UPDATE activities a SET reminded_at = now()
          WHERE a.id IN (
            SELECT id FROM activities
             WHERE completed_at IS NULL AND reminded_at IS NULL AND due_at IS NOT NULL AND related_type = 'lead'
               AND due_at <= now() + interval '10 minutes' AND due_at > now() - interval '6 hours'
             ORDER BY due_at LIMIT 200 FOR UPDATE SKIP LOCKED)
          RETURNING a.id, a.org_id, a.kind, a.body, a.due_at, a.assigned_to, a.related_id`,
      );
      if (!due.length) return;
      const leads = await db.rows(`SELECT id, first_name, last_name, phone, company_name FROM leads WHERE id = ANY($1)`, [due.map((d) => d.related_id)]);
      const byId = new Map(leads.map((l) => [l.id, l]));
      for (const f of due) {
        const lead = byId.get(f.related_id);
        if (!lead || !f.assigned_to) continue;
        await db.transaction(async (tx) => {
          tx.emit({
            type: EVENTS.LEAD_FOLLOWUP_DUE, org_id: f.org_id, actor_id: null,
            data: { followup_id: f.id, lead_id: lead.id, name: leadName(lead), phone: lead.phone, company_name: lead.company_name, kind: f.kind, note: f.body, due_at: f.due_at, assigned_to: f.assigned_to },
          });
        });
      }
    } catch (error) {
      app.log.error({ err: error }, 'lead follow-up reminders failed');
    }
  }, 60_000);
  timer.unref?.();
  app.addHook('onClose', async () => clearInterval(timer));
}

export const leadName = (l) => [l.first_name, l.last_name].filter(Boolean).join(' ') || l.phone || 'Lead';
const kindLabel = (kind) => ({ call: 'Call', whatsapp: 'WhatsApp', email: 'Email', meeting: 'Meet', visit: 'Visit', task: 'Follow up with' }[kind] ?? 'Follow up with');

function shape(lead) {
  const { phone_key: _phoneKey, ...rest } = lead;
  return { ...rest, name: leadName(lead) };
}
