import { id, paginate } from '@nexus/db-kit';
import {
  body, params, query, validate as v, requireApp, requirePermission, notFound, badRequest, peopleDirectory,
} from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';
import { slaPolicies, deadlines, slaState } from '../lib/sla.js';

const STATUSES = ['open', 'pending', 'on_hold', 'resolved', 'closed'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const CHANNELS = ['email', 'phone', 'whatsapp', 'web', 'walk_in', 'social', 'other'];
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const SORTS = ['created_at', 'updated_at', 'resolution_due', 'number', 'priority'];

const ticketFields = {
  subject: v.text(200, 1),
  description: v.longText,
  priority: v.enum(PRIORITIES),
  channel: v.enum(CHANNELS),
  category: nullable(v.text(80)),
  tags: { type: 'array', items: v.text(40), maxItems: 20 },
  requester_name: nullable(v.text(120)),
  requester_email: nullable(v.email),
  requester_phone: nullable(v.text(32)),
  assignee_id: nullable(v.id('usr')),
};

const LABEL = { open: 'Open', pending: 'Pending', on_hold: 'On hold', resolved: 'Resolved', closed: 'Closed' };

/**
 * Tickets: a queue with owners, a conversation per ticket (replies and
 * internal notes), and SLA clocks. Every change worth auditing is written as
 * an `event` message on the ticket itself, so its history reads top to bottom.
 */
export async function ticketRoutes(app) {
  const { db, config } = app;
  const people = peopleDirectory(config);
  const guard = (permission) => [app.loadContext, requireApp('helpdesk'), requirePermission(permission)];
  const ticketParams = { params: params({ ticketId: v.id('tkt') }) };

  const shape = (t) => ({ ...t, sla_state: slaState(t) });

  async function load(store, orgId, ticketId, lock = false) {
    const row = await store.one(
      `SELECT * FROM tickets WHERE org_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`,
      [orgId, ticketId],
    );
    if (!row) throw notFound('Ticket');
    return row;
  }

  /** An assignee must be an active member who can see tickets. */
  async function assertAssignable(orgId, userId) {
    const response = await fetch(`${config.tenancyUrl}/internal/authz/${orgId}/${userId}`, {
      headers: { 'x-nexus-service-token': config.serviceToken },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw app.httpErrors.serviceUnavailable('Membership lookup unavailable.');
    const auth = (await response.json()).data;
    if (!auth?.allowed || (!auth.is_owner && !auth.permissions.includes('helpdesk.tickets.view'))) {
      throw badRequest('Assign the ticket to an active member with Helpdesk access.');
    }
  }

  const note = (tx, ticket, userId, body) =>
    tx.query(
      `INSERT INTO ticket_messages (id, org_id, ticket_id, kind, body, author_id) VALUES ($1, $2, $3, 'event', $4, $5)`,
      [id('tmsg'), ticket.org_id, ticket.id, body, userId],
    );

  const eventData = (t) => ({
    ticket_id: t.id, number: t.number, subject: t.subject, priority: t.priority,
    status: t.status, assignee_id: t.assignee_id, created_by: t.created_by,
  });

  /** Who a ticket can be assigned to: everyone with Helpdesk access. */
  app.get('/helpdesk/agents', { preHandler: guard('helpdesk.tickets.view') }, async (request) => ({
    data: await people.withPermission(request.ctx.orgId, 'helpdesk.tickets.view'),
  }));

  // ═══════════════════════════════════════════════════════════════════ LIST
  app.get(
    '/helpdesk/tickets',
    {
      preHandler: guard('helpdesk.tickets.view'),
      schema: {
        querystring: query({
          status: { type: 'string', pattern: '^(open|pending|on_hold|resolved|closed|active)$' },
          priority: v.enum(PRIORITIES),
          channel: v.enum(CHANNELS),
          assignee: { type: 'string', pattern: '^(me|unassigned|usr_[0-9a-hjkmnp-tv-z]{26})$' },
          sla: v.enum(['breached', 'at_risk']),
        }),
      },
    },
    async (request) => {
      const { orgId, userId } = request.ctx;
      const qs = request.query;
      const page = paginate({ ...qs, allowedSorts: SORTS });
      const values = [orgId];
      const where = ['org_id = $1'];

      if (qs.status === 'active') where.push(`status IN ('open', 'pending', 'on_hold')`);
      else if (qs.status) { values.push(qs.status); where.push(`status = $${values.length}`); }
      if (qs.priority) { values.push(qs.priority); where.push(`priority = $${values.length}`); }
      if (qs.channel) { values.push(qs.channel); where.push(`channel = $${values.length}`); }
      if (qs.assignee === 'me') { values.push(userId); where.push(`assignee_id = $${values.length}`); }
      else if (qs.assignee === 'unassigned') where.push('assignee_id IS NULL');
      else if (qs.assignee) { values.push(qs.assignee); where.push(`assignee_id = $${values.length}`); }
      if (qs.sla === 'breached') {
        where.push(`status NOT IN ('resolved', 'closed') AND (resolution_due < now()
          OR (first_response_at IS NULL AND first_response_due < now()))`);
      }
      if (qs.sla === 'at_risk') {
        where.push(`status NOT IN ('resolved', 'closed') AND resolution_due >= now()
          AND resolution_due < now() + GREATEST(interval '1 hour', (resolution_due - created_at) * 0.25)`);
      }
      if (qs.q) {
        values.push(`%${qs.q}%`);
        const like = `$${values.length}`;
        values.push(qs.q.trim().replace(/^#/, ''));
        const exact = `$${values.length}`;
        where.push(`(subject ILIKE ${like} OR requester_name ILIKE ${like} OR requester_email ILIKE ${like}
          OR requester_phone ILIKE ${like} OR number::text = ${exact})`);
      }

      const clause = where.join(' AND ');
      // Most urgent first by default: breached and soonest-due at the top.
      const order = request.query.sort ? page.orderBy
        : `CASE WHEN status IN ('resolved','closed') THEN 1 ELSE 0 END, resolution_due NULLS LAST, created_at DESC`;
      const [rows, total] = await Promise.all([
        db.rows(`SELECT * FROM tickets WHERE ${clause} ORDER BY ${order} LIMIT ${page.limit} OFFSET ${page.offset}`, values),
        db.one(`SELECT count(*)::int AS n FROM tickets WHERE ${clause}`, values),
      ]);
      return { data: rows.map(shape), meta: page.meta(total.n) };
    },
  );

  // ═════════════════════════════════════════════════════════════════ CREATE
  app.post(
    '/helpdesk/tickets',
    { preHandler: guard('helpdesk.tickets.create'), schema: { body: body(ticketFields, ['subject']) } },
    async (request, reply) => {
      const { orgId, userId } = request.ctx;
      const b = request.body;
      if (!b.subject.trim()) throw badRequest('A subject is required.');
      if (b.assignee_id && b.assignee_id !== userId) {
        request.ctx.assert('helpdesk.tickets.assign');
        await assertAssignable(orgId, b.assignee_id);
      }

      const ticket = await db.transaction(async (tx) => {
        const counter = await tx.one(
          `INSERT INTO ticket_counters (org_id, last_value) VALUES ($1, 1)
           ON CONFLICT (org_id) DO UPDATE SET last_value = ticket_counters.last_value + 1
           RETURNING last_value`,
          [orgId],
        );
        const policies = await slaPolicies(tx, orgId);
        const now = new Date();
        const due = deadlines(policies[b.priority ?? 'normal'], now);
        const created = await tx.one(
          `INSERT INTO tickets
             (id, org_id, number, subject, description, priority, channel, category, tags,
              requester_name, requester_email, requester_phone, assignee_id, created_by,
              first_response_due, resolution_due, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
          [
            id('tkt'), orgId, counter.last_value, b.subject.trim(), b.description ?? '',
            b.priority ?? 'normal', b.channel ?? 'web', b.category ?? null, b.tags ?? [],
            b.requester_name ?? null, b.requester_email?.toLowerCase() ?? null, b.requester_phone ?? null,
            b.assignee_id ?? null, userId, due.first_response_due, due.resolution_due, now,
          ],
        );
        tx.emit({ type: EVENTS.TICKET_CREATED, org_id: orgId, actor_id: userId, data: eventData(created) });
        if (created.assignee_id) {
          tx.emit({ type: EVENTS.TICKET_ASSIGNED, org_id: orgId, actor_id: userId, data: eventData(created) });
        }
        return created;
      });
      return reply.status(201).send({ data: shape(ticket) });
    },
  );

  // ═══════════════════════════════════════════════════════════════════ READ
  app.get('/helpdesk/tickets/:ticketId', { preHandler: guard('helpdesk.tickets.view'), schema: ticketParams }, async (request) => {
    const ticket = await load(db, request.ctx.orgId, request.params.ticketId);
    const messages = await db.rows(
      `SELECT * FROM ticket_messages WHERE org_id = $1 AND ticket_id = $2 ORDER BY created_at`,
      [ticket.org_id, ticket.id],
    );
    // The requester's other tickets, so an agent sees the whole story.
    const history = ticket.requester_email || ticket.requester_phone
      ? await db.rows(
        `SELECT id, number, subject, status, created_at FROM tickets
          WHERE org_id = $1 AND id <> $2
            AND ((requester_email IS NOT NULL AND lower(requester_email) = lower($3))
              OR (requester_phone IS NOT NULL AND requester_phone = $4))
          ORDER BY created_at DESC LIMIT 10`,
        [ticket.org_id, ticket.id, ticket.requester_email, ticket.requester_phone],
      )
      : [];
    return { data: { ...shape(ticket), messages, requester_history: history } };
  });

  // ═════════════════════════════════════════════════════════════════ UPDATE
  app.patch(
    '/helpdesk/tickets/:ticketId',
    {
      preHandler: guard('helpdesk.tickets.edit'),
      schema: { ...ticketParams, body: body({ ...ticketFields, status: v.enum(STATUSES) }) },
    },
    async (request) => {
      const { orgId, userId } = request.ctx;
      const b = request.body;
      if (b.subject !== undefined && !b.subject.trim()) throw badRequest('A subject is required.');
      if (b.assignee_id !== undefined) {
        request.ctx.assert('helpdesk.tickets.assign');
        if (b.assignee_id) await assertAssignable(orgId, b.assignee_id);
      }

      const updated = await db.transaction(async (tx) => {
        const old = await load(tx, orgId, request.params.ticketId, true);
        const next = { ...old, ...b, tags: b.tags ?? old.tags };

        let dues = { first_response_due: old.first_response_due, resolution_due: old.resolution_due };
        if (b.priority && b.priority !== old.priority) {
          // A new priority means a new promise, measured from when it was opened.
          const policies = await slaPolicies(tx, orgId);
          dues = deadlines(policies[b.priority], old.created_at);
        }

        const status = next.status;
        const resolvedAt = status === 'resolved' ? (old.resolved_at ?? new Date())
          : status === 'closed' ? (old.resolved_at ?? new Date()) : null;
        const closedAt = status === 'closed' ? (old.closed_at ?? new Date()) : null;

        const row = await tx.one(
          `UPDATE tickets SET subject = $3, description = $4, priority = $5, channel = $6, category = $7,
                  tags = $8, requester_name = $9, requester_email = $10, requester_phone = $11,
                  assignee_id = $12, status = $13, first_response_due = $14, resolution_due = $15,
                  resolved_at = $16, closed_at = $17, updated_at = now()
            WHERE org_id = $1 AND id = $2 RETURNING *`,
          [
            orgId, old.id, next.subject.trim(), next.description, next.priority, next.channel, next.category,
            next.tags, next.requester_name, next.requester_email?.toLowerCase() ?? null, next.requester_phone,
            next.assignee_id, status, dues.first_response_due, dues.resolution_due, resolvedAt, closedAt,
          ],
        );

        if (row.status !== old.status) await note(tx, row, userId, `Status: ${LABEL[old.status]} → ${LABEL[row.status]}`);
        if (row.priority !== old.priority) await note(tx, row, userId, `Priority: ${old.priority} → ${row.priority}`);
        if (row.assignee_id !== old.assignee_id) {
          await note(tx, row, userId, row.assignee_id ? 'Assigned' : 'Unassigned');
          if (row.assignee_id) tx.emit({ type: EVENTS.TICKET_ASSIGNED, org_id: orgId, actor_id: userId, data: eventData(row) });
        }
        if (row.status === 'resolved' && old.status !== 'resolved') {
          tx.emit({ type: EVENTS.TICKET_RESOLVED, org_id: orgId, actor_id: userId, data: eventData(row) });
        }
        return row;
      });
      return { data: shape(updated) };
    },
  );

  app.delete('/helpdesk/tickets/:ticketId', { preHandler: guard('helpdesk.tickets.delete'), schema: ticketParams }, async (request) => {
    const row = await db.one(`DELETE FROM tickets WHERE org_id = $1 AND id = $2 RETURNING id`, [request.ctx.orgId, request.params.ticketId]);
    if (!row) throw notFound('Ticket');
    return { data: { deleted: true } };
  });

  // ═══════════════════════════════════════════════════════════ CONVERSATION
  app.post(
    '/helpdesk/tickets/:ticketId/messages',
    {
      preHandler: guard('helpdesk.tickets.edit'),
      schema: { ...ticketParams, body: body({ kind: v.enum(['reply', 'note']), body: v.text(20_000, 1), status: v.enum(STATUSES) }, ['kind', 'body']) },
    },
    async (request, reply) => {
      const { orgId, userId } = request.ctx;
      if (!request.body.body.trim()) throw badRequest('Write something first.');
      const result = await db.transaction(async (tx) => {
        const ticket = await load(tx, orgId, request.params.ticketId, true);
        if (ticket.status === 'closed') throw badRequest('This ticket is closed. Reopen it to reply.');
        const message = await tx.one(
          `INSERT INTO ticket_messages (id, org_id, ticket_id, kind, body, author_id)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [id('tmsg'), orgId, ticket.id, request.body.kind, request.body.body.trim(), userId],
        );
        // The first reply to the requester stops the first-response clock; a
        // reply can also move the ticket on ("reply and mark pending").
        const nextStatus = request.body.status ?? ticket.status;
        const updated = await tx.one(
          `UPDATE tickets SET first_response_at = CASE WHEN $3 = 'reply' THEN COALESCE(first_response_at, now()) ELSE first_response_at END,
                  status = $4,
                  resolved_at = CASE WHEN $4 IN ('resolved','closed') THEN COALESCE(resolved_at, now()) ELSE NULL END,
                  closed_at = CASE WHEN $4 = 'closed' THEN COALESCE(closed_at, now()) ELSE NULL END,
                  updated_at = now()
            WHERE org_id = $1 AND id = $2 RETURNING *`,
          [orgId, ticket.id, request.body.kind, nextStatus],
        );
        if (updated.status !== ticket.status) await note(tx, updated, userId, `Status: ${LABEL[ticket.status]} → ${LABEL[updated.status]}`);
        tx.emit({ type: EVENTS.TICKET_REPLIED, org_id: orgId, actor_id: userId, data: { ...eventData(updated), kind: message.kind } });
        if (updated.status === 'resolved' && ticket.status !== 'resolved') {
          tx.emit({ type: EVENTS.TICKET_RESOLVED, org_id: orgId, actor_id: userId, data: eventData(updated) });
        }
        return { message, ticket: updated };
      });
      return reply.status(201).send({ data: { message: result.message, ticket: shape(result.ticket) } });
    },
  );

  // ═════════════════════════════════════════════════════════════ OVERVIEW
  app.get('/helpdesk/overview', { preHandler: guard('helpdesk.tickets.view') }, async (request) => {
    const { orgId, userId } = request.ctx;
    const stats = await db.one(
      `SELECT
         count(*) FILTER (WHERE status IN ('open','pending','on_hold'))::int AS active,
         count(*) FILTER (WHERE status = 'open')::int AS open,
         count(*) FILTER (WHERE status = 'pending')::int AS pending,
         count(*) FILTER (WHERE status = 'on_hold')::int AS on_hold,
         count(*) FILTER (WHERE status IN ('open','pending','on_hold') AND assignee_id IS NULL)::int AS unassigned,
         count(*) FILTER (WHERE status IN ('open','pending','on_hold') AND assignee_id = $2)::int AS mine,
         count(*) FILTER (WHERE status IN ('open','pending','on_hold') AND (resolution_due < now()
           OR (first_response_at IS NULL AND first_response_due < now())))::int AS breached,
         count(*) FILTER (WHERE resolved_at >= now() - interval '7 days')::int AS resolved_7d,
         count(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS created_7d,
         round(avg(extract(epoch FROM first_response_at - created_at) / 60)
           FILTER (WHERE first_response_at >= now() - interval '30 days'))::int AS avg_first_response_minutes,
         round(100.0 * count(*) FILTER (WHERE resolved_at >= now() - interval '30 days' AND resolved_at <= resolution_due)
           / NULLIF(count(*) FILTER (WHERE resolved_at >= now() - interval '30 days'), 0))::int AS sla_met_percent
       FROM tickets WHERE org_id = $1`,
      [orgId, userId],
    );
    const byPriority = await db.rows(
      `SELECT priority, count(*)::int AS n FROM tickets
        WHERE org_id = $1 AND status IN ('open','pending','on_hold') GROUP BY priority`,
      [orgId],
    );
    const byChannel = await db.rows(
      `SELECT channel, count(*)::int AS n FROM tickets
        WHERE org_id = $1 AND created_at >= now() - interval '30 days' GROUP BY channel ORDER BY n DESC`,
      [orgId],
    );
    return { data: { ...stats, by_priority: byPriority, by_channel: byChannel } };
  });

  app.get('/helpdesk/widgets', { preHandler: guard('helpdesk.tickets.view') }, async (request) => {
    const row = await db.one(
      `SELECT count(*) FILTER (WHERE status IN ('open','pending','on_hold'))::int AS open,
              count(*) FILTER (WHERE status IN ('open','pending','on_hold') AND resolution_due >= now()
                AND resolution_due < now() + GREATEST(interval '1 hour', (resolution_due - created_at) * 0.25))::int AS risk
         FROM tickets WHERE org_id = $1`,
      [request.ctx.orgId],
    );
    return { data: { 'helpdesk.open_tickets': row.open, 'helpdesk.sla_risk': row.risk } };
  });

  // ═════════════════════════════════════════════════════════════════════ SLA
  app.get('/helpdesk/sla', { preHandler: guard('helpdesk.tickets.view') }, async (request) => {
    const policies = await slaPolicies(db, request.ctx.orgId);
    return { data: PRIORITIES.map((priority) => policies[priority]) };
  });

  app.put(
    '/helpdesk/sla',
    {
      preHandler: guard('helpdesk.sla.manage'),
      schema: {
        body: body({
          policies: {
            type: 'array', minItems: 1, maxItems: 4,
            items: body({ priority: v.enum(PRIORITIES), first_response_minutes: v.int(5, 43200), resolution_minutes: v.int(15, 129600) },
              ['priority', 'first_response_minutes', 'resolution_minutes']),
          },
        }, ['policies']),
      },
    },
    async (request) => {
      const { orgId, userId } = request.ctx;
      for (const p of request.body.policies) {
        if (p.resolution_minutes < p.first_response_minutes) {
          throw badRequest(`For ${p.priority}, resolution time must be at least the first-response time.`);
        }
      }
      await db.transaction(async (tx) => {
        await slaPolicies(tx, orgId);
        for (const p of request.body.policies) {
          await tx.query(
            `UPDATE sla_policies SET first_response_minutes = $3, resolution_minutes = $4, updated_by = $5, updated_at = now()
              WHERE org_id = $1 AND priority = $2`,
            [orgId, p.priority, p.first_response_minutes, p.resolution_minutes, userId],
          );
        }
      });
      const policies = await slaPolicies(db, orgId);
      return { data: PRIORITIES.map((priority) => policies[priority]) };
    },
  );
}
