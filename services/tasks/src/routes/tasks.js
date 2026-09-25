import { id } from '@nexus/db-kit';
import { body, params, query, validate as v, requireApp, requirePermission, notFound, badRequest } from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts';

const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const taskFields = {
  title: v.text(200), description: v.longText,
  project_id: nullable(v.id('prj')), milestone_id: nullable(v.id('mil')),
  assignee_id: nullable(v.id('usr')), due_date: nullable(v.date),
  status: v.enum(['todo', 'in_progress', 'blocked', 'done']),
  priority: v.enum(['low', 'medium', 'high', 'urgent']),
};
const sourcePaths = { 'crm.lead': 'crm/leads', 'crm.deal': 'crm/deals', 'hr.employee': 'hr/employees' };

export async function taskRoutes(app) {
  const { db, config } = app;
  const guard = (permission) => [app.loadContext, requireApp('tasks'), requirePermission(permission)];
  const lockWorkspace = (tx, orgId) => tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`tasks:${orgId}`]);
  const routeId = { params: params({ taskId: v.id('tsk') }) };
  async function task(store, orgId, taskId, lock = false) {
    const row = await store.one(`SELECT * FROM tasks WHERE org_id = $1 AND id = $2 AND archived_at IS NULL${lock ? ' FOR UPDATE' : ''}`, [orgId, taskId]);
    if (!row) throw notFound('Task');
    return row;
  }
  async function project(store, orgId, projectId) {
    const row = await store.one('SELECT * FROM projects WHERE org_id = $1 AND id = $2', [orgId, projectId]);
    if (!row) throw notFound('Project');
    return row;
  }
  async function references(store, request, data, previous = {}) {
    const { orgId, userId } = request.ctx;
    const merged = { ...previous, ...data };
    if (merged.project_id) {
      const p = await project(store, orgId, merged.project_id);
      if (p.status !== 'active') throw badRequest('Reopen the project before changing its tasks.');
    }
    if (merged.milestone_id) {
      const milestone = await store.one('SELECT * FROM milestones WHERE org_id = $1 AND id = $2', [orgId, merged.milestone_id]);
      if (!milestone || milestone.project_id !== merged.project_id) throw badRequest('Milestone must belong to the task project.');
    }
    if (data.assignee_id && data.assignee_id !== previous.assignee_id) {
      if (data.assignee_id !== userId) request.ctx.assert('tasks.tasks.assign');
      const response = await fetch(`${config.tenancyUrl}/internal/authz/${orgId}/${data.assignee_id}`, {
        headers: { 'x-nexus-service-token': config.serviceToken }, signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw app.httpErrors.serviceUnavailable('Membership lookup unavailable.');
      const auth = (await response.json()).data;
      if (!auth?.allowed || (!auth.is_owner && !auth.permissions.includes('tasks.tasks.view'))) {
        throw badRequest('Choose an active workspace member with task access.');
      }
    }
    if (data.assignee_id === null && previous.assignee_id && previous.assignee_id !== userId) request.ctx.assert('tasks.tasks.assign');
    if (merged.title && !merged.title.trim()) throw badRequest('A title is required.');
  }
  async function readExternal(request, path) {
    // Read through the gateway using the caller's session, so source records and
    // attachments retain their own app entitlement and permission boundaries.
    const response = await fetch(`${config.gatewayUrl}/api/${path}`, {
      headers: { cookie: request.headers.cookie ?? '', ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}) },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw badRequest('The linked record is unavailable or you do not have permission to read it.');
    return (await response.json()).data;
  }
  const emit = (tx, request, type, row) => tx.emit({ type, org_id: request.ctx.orgId, actor_id: request.ctx.userId, data: { task_id: row.id, title: row.title, project_id: row.project_id, assignee_id: row.assignee_id, status: row.status, due_date: row.due_date, created_by: row.created_by, source_app: row.source_app, source_id: row.source_id } });

  app.get('/tasks/projects', { preHandler: guard('tasks.projects.view') }, async (r) => ({ data: await db.rows(
    `SELECT p.*, CASE WHEN $2::boolean THEN (SELECT COALESCE(sum(e.minutes),0)::int FROM time_entries e JOIN tasks linked ON linked.org_id=e.org_id AND linked.id=e.task_id WHERE linked.org_id=p.org_id AND linked.project_id=p.id) ELSE NULL END AS logged_minutes, count(t.id)::int AS task_count, count(t.id) FILTER(WHERE t.status = 'done')::int AS completed_count
     FROM projects p LEFT JOIN tasks t ON t.org_id = p.org_id AND t.project_id = p.id AND t.archived_at IS NULL
     WHERE p.org_id = $1 GROUP BY p.id ORDER BY p.created_at DESC`, [r.ctx.orgId, r.ctx.can('tasks.time.view')]) }));
  app.post('/tasks/projects', { preHandler: guard('tasks.projects.create'), schema: { body: body({ name: v.text(160), description: v.longText, due_date: nullable(v.date) }, ['name']) } }, async (r, reply) => {
    if (!r.body.name.trim()) throw badRequest('A project name is required.');
    const row = await db.one(`INSERT INTO projects(id,org_id,name,description,due_date,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [id('prj'), r.ctx.orgId, r.body.name.trim(), r.body.description ?? '', r.body.due_date ?? null, r.ctx.userId]);
    return reply.code(201).send({ data: row });
  });
  app.patch('/tasks/projects/:projectId', { preHandler: guard('tasks.projects.edit'), schema: {
    params: params({ projectId: v.id('prj') }), body: body({ name: v.text(160), description: v.longText, status: v.enum(['active', 'completed', 'archived']), due_date: nullable(v.date) }),
  } }, async (r) => {
    if (r.body.name !== undefined && !r.body.name.trim()) throw badRequest('A project name is required.');
    const row = await db.transaction(async (tx) => {
      await lockWorkspace(tx, r.ctx.orgId);
      const old = await project(tx, r.ctx.orgId, r.params.projectId);
      if (r.body.status === 'completed') {
        const open = await tx.one(`SELECT id FROM tasks WHERE org_id = $1 AND project_id = $2 AND status <> 'done' AND archived_at IS NULL LIMIT 1`, [r.ctx.orgId, old.id]);
        if (open) throw badRequest('Complete the open tasks before completing the project.');
      }
      const next = { ...old, ...r.body };
      return tx.one(`UPDATE projects SET name=$3,description=$4,status=$5,due_date=$6,updated_at=now() WHERE org_id=$1 AND id=$2 RETURNING *`,
        [r.ctx.orgId, old.id, next.name.trim(), next.description, next.status, next.due_date]);
    });
    return { data: row };
  });
  app.get('/tasks/projects/:projectId/milestones', { preHandler: guard('tasks.projects.view'), schema: { params: params({ projectId: v.id('prj') }) } }, async (r) => {
    await project(db, r.ctx.orgId, r.params.projectId);
    return { data: await db.rows('SELECT * FROM milestones WHERE org_id=$1 AND project_id=$2 ORDER BY due_date NULLS LAST,created_at', [r.ctx.orgId, r.params.projectId]) };
  });
  app.post('/tasks/projects/:projectId/milestones', { preHandler: guard('tasks.projects.edit'), schema: {
    params: params({ projectId: v.id('prj') }), body: body({ title: v.text(160), due_date: nullable(v.date) }, ['title']),
  } }, async (r, reply) => {
    const p = await project(db, r.ctx.orgId, r.params.projectId);
    if (p.status !== 'active' || !r.body.title.trim()) throw badRequest('An active project and milestone title are required.');
    return reply.code(201).send({ data: await db.one(`INSERT INTO milestones(id,org_id,project_id,title,due_date) VALUES($1,$2,$3,$4,$5) RETURNING *`, [id('mil'), r.ctx.orgId, p.id, r.body.title.trim(), r.body.due_date ?? null]) });
  });
  app.patch('/tasks/milestones/:milestoneId', { preHandler: guard('tasks.projects.edit'), schema: {
    params: params({ milestoneId: v.id('mil') }), body: body({ completed: v.bool }, ['completed']),
  } }, async (r) => {
    const row = await db.one('UPDATE milestones SET completed=$3 WHERE org_id=$1 AND id=$2 RETURNING *', [r.ctx.orgId, r.params.milestoneId, r.body.completed]);
    if (!row) throw notFound('Milestone');
    return { data: row };
  });

  app.get('/tasks', { preHandler: guard('tasks.tasks.view'), schema: { querystring: query({ project_id: v.id('prj'), mine: v.bool, status: taskFields.status, parent_id: v.id('tsk'), source_app: v.slug, source_id: v.text(40), due_from: v.date, due_to: v.date }) } }, async (r) => {
    const values = [r.ctx.orgId], clauses = ['t.org_id=$1', 't.archived_at IS NULL'];
    for (const field of ['project_id', 'status', 'parent_id', 'source_app', 'source_id']) if (r.query[field]) { values.push(r.query[field]); clauses.push(`t.${field}=$${values.length}`); }
    if (r.query.mine) { values.push(r.ctx.userId); clauses.push(`t.assignee_id=$${values.length}`); }
    if (r.query.q) { values.push(`%${r.query.q}%`); clauses.push(`t.title ILIKE $${values.length}`); }
    if (r.query.due_from) { values.push(r.query.due_from); clauses.push(`t.due_date >= $${values.length}`); }
    if (r.query.due_to) { values.push(r.query.due_to); clauses.push(`t.due_date <= $${values.length}`); }
    const clause = clauses.join(' AND '), { page, limit } = r.query;
    const total = await db.one(`SELECT count(*)::int AS n, count(*) FILTER(WHERE status<>'done')::int AS open, count(*) FILTER(WHERE status='in_progress')::int AS in_progress, count(*) FILTER(WHERE status='done')::int AS done, count(*) FILTER(WHERE status<>'done' AND due_date<current_date)::int AS overdue FROM tasks t WHERE ${clause}`, values);
    values.push(limit, (page - 1) * limit);
    return { data: await db.rows(`SELECT t.*,p.name AS project_name FROM tasks t LEFT JOIN projects p ON p.org_id=t.org_id AND p.id=t.project_id
      WHERE ${clause} ORDER BY t.due_date NULLS LAST,t.created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values), meta: { total: total.n, page, limit, stats: total } };
  });
  app.post('/tasks', { preHandler: guard('tasks.tasks.create'), schema: { body: body({ ...taskFields, parent_id: v.id('tsk'), source_app: v.enum(['crm', 'hr']), source_type: v.enum(['lead', 'deal', 'employee']), source_id: v.text(40) }, ['title']) } }, async (r, reply) => {
    const b = { ...r.body };
    if (b.source_app || b.source_type || b.source_id) {
      const path = sourcePaths[`${b.source_app}.${b.source_type}`];
      if (!path || !/^[a-z]+_[0-9a-hjkmnp-tv-z]{26}$/.test(b.source_id ?? '')) throw badRequest('Choose a valid source record.');
      await readExternal(r, `${path}/${b.source_id}`);
    }
    const row = await db.transaction(async (tx) => {
      await lockWorkspace(tx, r.ctx.orgId);
      if (b.parent_id) {
        const parent = await task(tx, r.ctx.orgId, b.parent_id, true);
        if (parent.status === 'done') throw badRequest('Reopen the parent task before adding subtasks.');
        if (b.project_id && b.project_id !== parent.project_id) throw badRequest('Subtasks must use the parent project.');
        b.project_id = parent.project_id;
      }
      await references(tx, r, b);
      const created = await tx.one(`INSERT INTO tasks(id,org_id,project_id,parent_id,milestone_id,title,description,status,priority,assignee_id,due_date,source_app,source_type,source_id,created_by,completed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,CASE WHEN $8='done' THEN now() ELSE NULL END) RETURNING *`,
      [id('tsk'), r.ctx.orgId, b.project_id ?? null, b.parent_id ?? null, b.milestone_id ?? null, b.title.trim(), b.description ?? '', b.status ?? 'todo', b.priority ?? 'medium', b.assignee_id ?? null, b.due_date ?? null, b.source_app ?? null, b.source_type ?? null, b.source_id ?? null, r.ctx.userId]);
      emit(tx, r, EVENTS.TASK_CREATED, created);
      if (created.assignee_id) emit(tx, r, EVENTS.TASK_ASSIGNED, created);
      // Creating a task with somebody's name on it is assigning it to them.
      if (created.assignee_id) emit(tx, r, EVENTS.TASK_ASSIGNED, created);
      return created;
    });
    return reply.code(201).send({ data: row });
  });
  app.get('/tasks/widgets', { preHandler: guard('tasks.tasks.view') }, async (r) => {
    const counts = await db.one(`SELECT count(*) FILTER(WHERE assignee_id=$2 AND status<>'done')::int AS mine,
      count(*) FILTER(WHERE due_date<current_date AND status<>'done')::int AS overdue FROM tasks WHERE org_id=$1 AND archived_at IS NULL`, [r.ctx.orgId, r.ctx.userId]);
    return { data: { 'tasks.my_open': counts.mine, 'tasks.overdue': counts.overdue } };
  });
  app.get('/tasks/time', { preHandler: guard('tasks.time.view'), schema: { querystring: query({ from: v.date, to: v.date, project_id: v.id('prj'), mine: v.bool }) } }, async (r) => {
    const values = [r.ctx.orgId, r.query.from ?? null, r.query.to ?? null, r.query.project_id ?? null, r.query.mine ? r.ctx.userId : null];
    const clause = `e.org_id=$1 AND ($2::date IS NULL OR e.worked_on >= $2) AND ($3::date IS NULL OR e.worked_on <= $3) AND ($4::text IS NULL OR t.project_id=$4) AND ($5::text IS NULL OR e.user_id=$5)`;
    const total = await db.one(`SELECT count(*)::int AS count,COALESCE(sum(minutes),0)::int AS minutes FROM time_entries e JOIN tasks t ON t.org_id=e.org_id AND t.id=e.task_id WHERE ${clause}`, values);
    values.push(r.query.limit, (r.query.page - 1) * r.query.limit);
    return { data: await db.rows(`SELECT e.*,t.title,t.project_id,p.name AS project_name FROM time_entries e JOIN tasks t ON t.org_id=e.org_id AND t.id=e.task_id LEFT JOIN projects p ON p.org_id=t.org_id AND p.id=t.project_id
      WHERE ${clause} ORDER BY e.worked_on DESC,e.created_at DESC LIMIT $6 OFFSET $7`, values), meta: { total: total.count, minutes: total.minutes, page: r.query.page, limit: r.query.limit } };
  });
  app.get('/tasks/:taskId', { preHandler: guard('tasks.tasks.view'), schema: routeId }, async (r) => {
    const row = await task(db, r.ctx.orgId, r.params.taskId);
    const args = [r.ctx.orgId, row.id];
    const [comments, time, attachments, subtasks] = await Promise.all([
      db.rows('SELECT * FROM comments WHERE org_id=$1 AND task_id=$2 ORDER BY created_at', args),
      r.ctx.can('tasks.time.view') ? db.rows('SELECT * FROM time_entries WHERE org_id=$1 AND task_id=$2 ORDER BY worked_on DESC', args) : [],
      db.rows('SELECT * FROM attachments WHERE org_id=$1 AND task_id=$2 ORDER BY created_at', args),
      db.rows('SELECT * FROM tasks WHERE org_id=$1 AND parent_id=$2 AND archived_at IS NULL ORDER BY created_at', args),
    ]);
    return { data: { ...row, comments, time_entries: time, attachments, subtasks } };
  });
  app.patch('/tasks/:taskId', { preHandler: guard('tasks.tasks.edit'), schema: { ...routeId, body: body(taskFields) } }, async (r) => ({ data: await db.transaction(async (tx) => {
    await lockWorkspace(tx, r.ctx.orgId);
    const old = await task(tx, r.ctx.orgId, r.params.taskId, true);
    const b = r.body, next = { ...old, ...b };
    if (b.project_id !== undefined && b.project_id !== old.project_id) {
      const child = await tx.one('SELECT id FROM tasks WHERE org_id=$1 AND parent_id=$2 AND archived_at IS NULL LIMIT 1', [r.ctx.orgId, old.id]);
      if (old.parent_id || child) throw badRequest('A task with a parent or subtasks cannot move between projects.');
    }
    if (b.status === 'done') {
      const child = await tx.one(`SELECT id FROM tasks WHERE org_id=$1 AND parent_id=$2 AND status<>'done' AND archived_at IS NULL LIMIT 1`, [r.ctx.orgId, old.id]);
      if (child) throw badRequest('Complete the subtasks first.');
    }
    if (old.parent_id && b.status && b.status !== 'done') {
      const parent = await task(tx, r.ctx.orgId, old.parent_id);
      if (parent.status === 'done') throw badRequest('Reopen the parent task first.');
    }
    await references(tx, r, b, old);
    const row = await tx.one(`UPDATE tasks SET title=$3,description=$4,project_id=$5,milestone_id=$6,status=$7,priority=$8,
      assignee_id=$9,due_date=$10,completed_at=CASE WHEN $7='done' THEN COALESCE(completed_at,now()) ELSE NULL END,updated_at=now()
      WHERE org_id=$1 AND id=$2 RETURNING *`, [r.ctx.orgId, old.id, next.title.trim(), next.description, next.project_id, next.milestone_id, next.status, next.priority, next.assignee_id, next.due_date]);
    if (row.assignee_id !== old.assignee_id) emit(tx, r, EVENTS.TASK_ASSIGNED, row);
    if (row.status === 'done' && old.status !== 'done') emit(tx, r, EVENTS.TASK_COMPLETED, row);
    return row;
  }) }));
  app.delete('/tasks/:taskId', { preHandler: guard('tasks.tasks.delete'), schema: routeId }, async (r) => {
    await db.transaction(async (tx) => {
      await lockWorkspace(tx, r.ctx.orgId);
      await task(tx, r.ctx.orgId, r.params.taskId, true);
      const child = await tx.one('SELECT id FROM tasks WHERE org_id=$1 AND parent_id=$2 AND archived_at IS NULL LIMIT 1', [r.ctx.orgId, r.params.taskId]);
      if (child) throw badRequest('Archive the subtasks first.');
      await tx.query('UPDATE tasks SET archived_at=now() WHERE org_id=$1 AND id=$2', [r.ctx.orgId, r.params.taskId]);
    });
    return { data: { archived: true } };
  });
  app.post('/tasks/:taskId/comments', { preHandler: guard('tasks.tasks.edit'), schema: { ...routeId, body: body({ body: v.text(10000) }, ['body']) } }, async (r, reply) => {
    await task(db, r.ctx.orgId, r.params.taskId);
    if (!r.body.body.trim()) throw badRequest('Write a comment first.');
    return reply.code(201).send({ data: await db.one('INSERT INTO comments(id,org_id,task_id,body,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *', [id('cmt'), r.ctx.orgId, r.params.taskId, r.body.body.trim(), r.ctx.userId]) });
  });
  app.post('/tasks/:taskId/time', { preHandler: guard('tasks.time.log'), schema: { ...routeId, body: body({ minutes: v.int(1, 1440), worked_on: v.date, note: v.text(1000, 0) }, ['minutes', 'worked_on']) } }, async (r, reply) => {
    await task(db, r.ctx.orgId, r.params.taskId);
    return reply.code(201).send({ data: await db.one('INSERT INTO time_entries(id,org_id,task_id,user_id,minutes,worked_on,note) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *', [id('tim'), r.ctx.orgId, r.params.taskId, r.ctx.userId, r.body.minutes, r.body.worked_on, r.body.note ?? '']) });
  });
  app.post('/tasks/:taskId/attachments', { preHandler: guard('tasks.tasks.edit'), schema: { ...routeId, body: body({ document_id: v.id('doc') }, ['document_id']) } }, async (r, reply) => {
    await task(db, r.ctx.orgId, r.params.taskId);
    const doc = await readExternal(r, `documents/${r.body.document_id}`);
    const row = await db.one(`INSERT INTO attachments(id,org_id,task_id,document_id,name,created_by) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(org_id,task_id,document_id) DO UPDATE SET name=EXCLUDED.name RETURNING *`, [id('att'), r.ctx.orgId, r.params.taskId, doc.id, doc.name, r.ctx.userId]);
    return reply.code(201).send({ data: row });
  });
  app.delete('/tasks/:taskId/attachments/:attachmentId', { preHandler: guard('tasks.tasks.edit'), schema: { params: params({ taskId: v.id('tsk'), attachmentId: v.id('att') }) } }, async (r) => {
    await task(db, r.ctx.orgId, r.params.taskId);
    const row = await db.one('DELETE FROM attachments WHERE org_id=$1 AND task_id=$2 AND id=$3 RETURNING id', [r.ctx.orgId, r.params.taskId, r.params.attachmentId]);
    if (!row) throw notFound('Attachment');
    return { data: row };
  });
}
