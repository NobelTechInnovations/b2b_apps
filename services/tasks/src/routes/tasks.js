import { id } from '@nexus/db-kit';
import { body, params, query, validate as v, requireApp, requirePermission, notFound, badRequest, forbidden } from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts';

const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const taskFields = {
  title: v.text(200), description: v.longText,
  project_id: nullable(v.id('prj')), milestone_id: nullable(v.id('mil')),
  assignee_id: nullable(v.id('usr')), due_date: nullable(v.date),
  status: v.enum(['todo', 'in_progress', 'blocked', 'done']),
  priority: v.enum(['low', 'medium', 'high', 'urgent']),
  // A board's own column ("Pending", "Review"); it decides the status.
  column_id: nullable(v.id('col')),
};
const STATES = ['todo', 'in_progress', 'blocked', 'done'];
const DEFAULT_COLUMNS = [['To do', 'todo'], ['Working on it', 'in_progress'], ['Stuck', 'blocked'], ['Done', 'done']];
const boardFields = {
  name: v.text(160), description: v.longText, due_date: nullable(v.date),
  visibility: v.enum(['workspace', 'private']),
  color: v.enum(['violet', 'indigo', 'blue', 'cyan', 'emerald', 'amber', 'orange', 'rose', 'slate']),
};
const BOARD_ROLES = ['owner', 'editor', 'viewer'];
const sourcePaths = { 'crm.lead': 'crm/leads', 'crm.deal': 'crm/deals', 'hr.employee': 'hr/employees', 'helpdesk.ticket': 'helpdesk/tickets', 'recruitment.candidate': 'recruitment/candidates' };

/**
 * Boards and tasks.
 *
 * Two gates, both required. The workspace permission (tasks.tasks.view…) says
 * what someone may do in Tasks at all; the board says where. A private board
 * is invisible — 404, not 403 — to anyone who is not on it, and so are its
 * tasks, their comments, time and attachments. A task on no board belongs to
 * whoever created it and whoever it is assigned to.
 *
 * `tasks.boards.manage` (owners and admins) sees and manages every board.
 */
export async function taskRoutes(app) {
  const { db, config } = app;
  const guard = (permission) => [app.loadContext, requireApp('tasks'), requirePermission(permission)];
  const lockWorkspace = (tx, orgId) => tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`tasks:${orgId}`]);
  const routeId = { params: params({ taskId: v.id('tsk') }) };
  const boardId = { params: params({ projectId: v.id('prj') }) };
  const manageAll = (r) => r.ctx.can('tasks.boards.manage');

  // ── visibility, as SQL, for list queries ──────────────────────────────────
  function visibleBoardSql(r, values, alias = 'p') {
    if (manageAll(r)) return 'TRUE';
    values.push(r.ctx.userId);
    const me = `$${values.length}`;
    return `(${alias}.visibility = 'workspace' OR EXISTS (
      SELECT 1 FROM project_members bm WHERE bm.org_id = ${alias}.org_id AND bm.project_id = ${alias}.id AND bm.user_id = ${me}))`;
  }
  function visibleTaskSql(r, values, alias = 't') {
    if (manageAll(r)) return 'TRUE';
    values.push(r.ctx.userId);
    const me = `$${values.length}`;
    return `((${alias}.project_id IS NULL AND (${alias}.created_by = ${me} OR ${alias}.assignee_id = ${me}))
      OR EXISTS (SELECT 1 FROM projects vp WHERE vp.org_id = ${alias}.org_id AND vp.id = ${alias}.project_id
        AND (vp.visibility = 'workspace' OR EXISTS (
          SELECT 1 FROM project_members vm WHERE vm.org_id = vp.org_id AND vm.project_id = vp.id AND vm.user_id = ${me}))))`;
  }

  // ── one board, one task, with the caller's access checked ─────────────────
  async function project(store, orgId, projectId) {
    const row = await store.one('SELECT * FROM projects WHERE org_id = $1 AND id = $2', [orgId, projectId]);
    if (!row) throw notFound('Board');
    return row;
  }

  /**
   * The board, if the caller may `need` it: 'view', 'edit' (its tasks) or
   * 'manage' (its settings and members). `my_role` rides along for the UI.
   */
  async function board(store, r, projectId, need = 'view') {
    const p = await project(store, r.ctx.orgId, projectId);
    if (manageAll(r)) return { ...p, my_role: 'admin' };
    const member = await store.one(
      'SELECT role FROM project_members WHERE org_id = $1 AND project_id = $2 AND user_id = $3',
      [r.ctx.orgId, p.id, r.ctx.userId],
    );
    const role = member?.role ?? (p.visibility === 'workspace' ? 'workspace' : null);
    // Never confirm a private board exists to someone who is not on it.
    if (!role) throw notFound('Board');
    if (need === 'edit' && !(['owner', 'editor'].includes(role) || (role === 'workspace' && r.ctx.can('tasks.tasks.edit')))) {
      throw forbidden('You can view this board but not change its tasks.');
    }
    if (need === 'manage' && role !== 'owner') {
      throw forbidden('Only the board owner can change its settings and members.');
    }
    return { ...p, my_role: role };
  }

  async function task(store, r, taskId, { lock = false, need = 'view' } = {}) {
    const row = await store.one(
      `SELECT * FROM tasks WHERE org_id = $1 AND id = $2 AND archived_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
      [r.ctx.orgId, taskId],
    );
    if (!row) throw notFound('Task');
    if (row.project_id) {
      await board(store, r, row.project_id, need).catch((error) => {
        throw error.statusCode === 404 ? notFound('Task') : error;
      });
    } else if (!manageAll(r) && row.created_by !== r.ctx.userId && row.assignee_id !== r.ctx.userId) {
      throw notFound('Task');
    }
    return row;
  }

  /** A board's columns, created from the four task states the first time they are needed. */
  async function columns(store, orgId, projectId) {
    const rows = await store.rows('SELECT * FROM board_columns WHERE org_id = $1 AND project_id = $2 ORDER BY position, created_at', [orgId, projectId]);
    if (rows.length) return rows;
    await store.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`columns:${projectId}`]).catch(() => {});
    const again = await store.rows('SELECT * FROM board_columns WHERE org_id = $1 AND project_id = $2 ORDER BY position, created_at', [orgId, projectId]);
    if (again.length) return again;
    const created = [];
    for (const [index, [name, status]] of DEFAULT_COLUMNS.entries()) {
      created.push(await store.one(
        'INSERT INTO board_columns (id, org_id, project_id, name, status, position) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
        [id('col'), orgId, projectId, name, status, index],
      ));
    }
    return created;
  }

  /** The column a task is being put in, which must be on the task's board. */
  async function columnFor(store, orgId, projectId, columnId) {
    if (!columnId) return null;
    if (!projectId) throw badRequest('Only tasks on a board go in a board column.');
    const column = await store.one('SELECT * FROM board_columns WHERE org_id = $1 AND id = $2 AND project_id = $3', [orgId, columnId, projectId]);
    if (!column) throw badRequest('That column is not on this board.');
    return column;
  }

  /** What tenancy says about a workspace member: active? which permissions? */
  async function memberAccess(orgId, userId) {
    const response = await fetch(`${config.tenancyUrl}/internal/authz/${orgId}/${userId}`, {
      headers: { 'x-nexus-service-token': config.serviceToken }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw app.httpErrors.serviceUnavailable('Membership lookup unavailable.');
    const auth = (await response.json()).data;
    return {
      active: Boolean(auth?.allowed),
      canUseTasks: Boolean(auth?.allowed && (auth.is_owner || auth.permissions.includes('tasks.tasks.view'))),
      seesAllBoards: Boolean(auth?.allowed && (auth.is_owner || auth.permissions.includes('tasks.boards.manage'))),
    };
  }

  async function references(store, request, data, previous = {}) {
    const { orgId, userId } = request.ctx;
    const merged = { ...previous, ...data };
    let target = null;
    if (merged.project_id) {
      target = await board(store, request, merged.project_id, 'edit');
      if (target.status !== 'active') throw badRequest('Reopen the board before changing its tasks.');
    }
    if (merged.milestone_id) {
      const milestone = await store.one('SELECT * FROM milestones WHERE org_id = $1 AND id = $2', [orgId, merged.milestone_id]);
      if (!milestone || milestone.project_id !== merged.project_id) throw badRequest('Milestone must belong to the task board.');
    }
    const assignee = data.assignee_id !== undefined ? data.assignee_id : (data.project_id !== undefined ? previous.assignee_id : undefined);
    if (assignee && (assignee !== previous.assignee_id || data.project_id !== undefined)) {
      if (assignee !== userId && assignee !== previous.assignee_id) request.ctx.assert('tasks.tasks.assign');
      const access = await memberAccess(orgId, assignee);
      if (!access.canUseTasks) throw badRequest('Choose an active workspace member with task access.');
      // Someone cannot be handed work on a board they cannot open.
      if (target?.visibility === 'private' && !access.seesAllBoards) {
        const onBoard = await store.one(
          'SELECT 1 FROM project_members WHERE org_id = $1 AND project_id = $2 AND user_id = $3',
          [orgId, target.id, assignee],
        );
        if (!onBoard) throw badRequest('Add this person to the board before assigning them its tasks.', { code: 'not_on_board' });
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
  const emit = (tx, request, type, row, extra = {}) => tx.emit({ type, org_id: request.ctx.orgId, actor_id: request.ctx.userId, data: { task_id: row.id, title: row.title, project_id: row.project_id, assignee_id: row.assignee_id, status: row.status, due_date: row.due_date, created_by: row.created_by, source_app: row.source_app, source_id: row.source_id, ...extra } });
  // The assignee is also emailed, so the event carries what the email says.
  const emitAssigned = async (tx, request, row) => {
    const p = row.project_id ? await tx.one('SELECT name FROM projects WHERE org_id=$1 AND id=$2', [request.ctx.orgId, row.project_id]) : null;
    emit(tx, request, EVENTS.TASK_ASSIGNED, row, { board_name: p?.name ?? null, priority: row.priority, description: (row.description ?? '').trim().slice(0, 500) || null });
  };

  // ═══════════════════════════════════════════════════════════════════ BOARDS
  app.get('/tasks/projects', { preHandler: guard('tasks.projects.view') }, async (r) => {
    const values = [r.ctx.orgId, r.ctx.can('tasks.time.view'), r.ctx.userId];
    const visible = visibleBoardSql(r, values);
    const rows = await db.rows(
      `SELECT p.*,
              CASE WHEN $2::boolean THEN (SELECT COALESCE(sum(e.minutes),0)::int FROM time_entries e JOIN tasks linked ON linked.org_id=e.org_id AND linked.id=e.task_id WHERE linked.org_id=p.org_id AND linked.project_id=p.id) ELSE NULL END AS logged_minutes,
              (SELECT count(*)::int FROM tasks t WHERE t.org_id = p.org_id AND t.project_id = p.id AND t.archived_at IS NULL) AS task_count,
              (SELECT count(*)::int FROM tasks t WHERE t.org_id = p.org_id AND t.project_id = p.id AND t.archived_at IS NULL AND t.status = 'done') AS completed_count,
              (SELECT count(*)::int FROM tasks t WHERE t.org_id = p.org_id AND t.project_id = p.id AND t.archived_at IS NULL AND t.status <> 'done' AND t.due_date < current_date) AS overdue_count,
              COALESCE((SELECT json_agg(json_build_object('user_id', m.user_id, 'role', m.role) ORDER BY m.added_at)
                          FROM project_members m WHERE m.org_id = p.org_id AND m.project_id = p.id), '[]') AS members,
              (SELECT m.role FROM project_members m WHERE m.org_id = p.org_id AND m.project_id = p.id AND m.user_id = $3) AS member_role
         FROM projects p
        WHERE p.org_id = $1 AND ${visible}
        ORDER BY p.status = 'active' DESC, p.created_at DESC`,
      values,
    );
    const all = manageAll(r);
    return {
      data: rows.map((p) => ({
        ...p,
        my_role: all ? 'admin' : p.member_role ?? 'workspace',
        can_manage: all || p.member_role === 'owner',
        can_edit: all || ['owner', 'editor'].includes(p.member_role) || (p.visibility === 'workspace' && !p.member_role && r.ctx.can('tasks.tasks.edit')),
      })),
      meta: { manage_all: all },
    };
  });

  app.post('/tasks/projects', { preHandler: guard('tasks.projects.create'), schema: {
    body: body({ ...boardFields, members: { type: 'array', maxItems: 100, items: body({ user_id: v.id('usr'), role: v.enum(BOARD_ROLES) }, ['user_id']) } }, ['name']),
  } }, async (r, reply) => {
    if (!r.body.name.trim()) throw badRequest('A board name is required.');
    const invited = (r.body.members ?? []).filter((m) => m.user_id !== r.ctx.userId);
    for (const member of invited) {
      if (!(await memberAccess(r.ctx.orgId, member.user_id)).canUseTasks) {
        throw badRequest('Everyone added to a board must be an active workspace member with task access.');
      }
    }
    const row = await db.transaction(async (tx) => {
      // New boards are private unless the creator opens them to everyone.
      const created = await tx.one(
        `INSERT INTO projects(id, org_id, name, description, due_date, visibility, color, created_by)
         VALUES($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [id('prj'), r.ctx.orgId, r.body.name.trim(), r.body.description ?? '', r.body.due_date ?? null,
          r.body.visibility ?? 'private', r.body.color ?? 'violet', r.ctx.userId],
      );
      await tx.query(
        `INSERT INTO project_members(org_id, project_id, user_id, role, added_by) VALUES($1, $2, $3, 'owner', $3)`,
        [r.ctx.orgId, created.id, r.ctx.userId],
      );
      for (const member of invited) {
        await tx.query(
          `INSERT INTO project_members(org_id, project_id, user_id, role, added_by) VALUES($1, $2, $3, $4, $5)
           ON CONFLICT DO NOTHING`,
          [r.ctx.orgId, created.id, member.user_id, member.role ?? 'editor', r.ctx.userId],
        );
        tx.emit({ type: EVENTS.BOARD_MEMBER_ADDED, org_id: r.ctx.orgId, actor_id: r.ctx.userId,
          data: { project_id: created.id, name: created.name, user_id: member.user_id, role: member.role ?? 'editor' } });
      }
      return created;
    });
    return reply.code(201).send({ data: { ...row, my_role: 'owner' } });
  });

  app.get('/tasks/projects/:projectId', { preHandler: guard('tasks.projects.view'), schema: boardId }, async (r) => {
    const p = await board(db, r, r.params.projectId);
    const members = await db.rows(
      'SELECT user_id, role, added_at FROM project_members WHERE org_id = $1 AND project_id = $2 ORDER BY added_at',
      [r.ctx.orgId, p.id],
    );
    return { data: { ...p, members, can_manage: p.my_role === 'admin' || p.my_role === 'owner' } };
  });

  app.patch('/tasks/projects/:projectId', { preHandler: guard('tasks.projects.edit'), schema: {
    ...boardId, body: body({ ...boardFields, status: v.enum(['active', 'completed', 'archived']) }),
  } }, async (r) => {
    if (r.body.name !== undefined && !r.body.name.trim()) throw badRequest('A board name is required.');
    const row = await db.transaction(async (tx) => {
      await lockWorkspace(tx, r.ctx.orgId);
      const old = await board(tx, r, r.params.projectId, 'manage');
      if (r.body.status === 'completed') {
        const open = await tx.one(`SELECT id FROM tasks WHERE org_id = $1 AND project_id = $2 AND status <> 'done' AND archived_at IS NULL LIMIT 1`, [r.ctx.orgId, old.id]);
        if (open) throw badRequest('Complete the open tasks before completing the board.');
      }
      const next = { ...old, ...r.body };
      return tx.one(`UPDATE projects SET name=$3, description=$4, status=$5, due_date=$6, visibility=$7, color=$8, updated_at=now()
        WHERE org_id=$1 AND id=$2 RETURNING *`,
      [r.ctx.orgId, old.id, next.name.trim(), next.description, next.status, next.due_date, next.visibility, next.color]);
    });
    return { data: row };
  });

  // ── board members ─────────────────────────────────────────────────────────
  app.get('/tasks/projects/:projectId/members', { preHandler: guard('tasks.projects.view'), schema: boardId }, async (r) => {
    const p = await board(db, r, r.params.projectId);
    return { data: await db.rows('SELECT user_id, role, added_by, added_at FROM project_members WHERE org_id = $1 AND project_id = $2 ORDER BY added_at', [r.ctx.orgId, p.id]) };
  });

  app.put('/tasks/projects/:projectId/members/:userId', { preHandler: guard('tasks.projects.view'), schema: {
    params: params({ projectId: v.id('prj'), userId: v.id('usr') }), body: body({ role: v.enum(BOARD_ROLES) }, ['role']),
  } }, async (r) => {
    const row = await db.transaction(async (tx) => {
      await lockWorkspace(tx, r.ctx.orgId);
      const p = await board(tx, r, r.params.projectId, 'manage');
      if (!(await memberAccess(r.ctx.orgId, r.params.userId)).canUseTasks) {
        throw badRequest('Only active workspace members with task access can be added to a board.');
      }
      const before = await tx.one('SELECT role FROM project_members WHERE org_id=$1 AND project_id=$2 AND user_id=$3', [r.ctx.orgId, p.id, r.params.userId]);
      if (before?.role === 'owner' && r.body.role !== 'owner') {
        const owners = await tx.one(`SELECT count(*)::int AS n FROM project_members WHERE org_id=$1 AND project_id=$2 AND role='owner'`, [r.ctx.orgId, p.id]);
        if (owners.n <= 1) throw badRequest('A board needs at least one owner. Make someone else an owner first.');
      }
      const saved = await tx.one(
        `INSERT INTO project_members(org_id, project_id, user_id, role, added_by) VALUES($1, $2, $3, $4, $5)
         ON CONFLICT (org_id, project_id, user_id) DO UPDATE SET role = EXCLUDED.role RETURNING *`,
        [r.ctx.orgId, p.id, r.params.userId, r.body.role, r.ctx.userId],
      );
      if (!before && r.params.userId !== r.ctx.userId) {
        tx.emit({ type: EVENTS.BOARD_MEMBER_ADDED, org_id: r.ctx.orgId, actor_id: r.ctx.userId,
          data: { project_id: p.id, name: p.name, user_id: r.params.userId, role: r.body.role } });
      }
      return saved;
    });
    return { data: row };
  });

  app.delete('/tasks/projects/:projectId/members/:userId', { preHandler: guard('tasks.projects.view'), schema: {
    params: params({ projectId: v.id('prj'), userId: v.id('usr') }),
  } }, async (r) => {
    await db.transaction(async (tx) => {
      await lockWorkspace(tx, r.ctx.orgId);
      // Anyone may leave a board; only an owner may remove somebody else.
      const p = await board(tx, r, r.params.projectId, r.params.userId === r.ctx.userId ? 'view' : 'manage');
      const row = await tx.one('SELECT role FROM project_members WHERE org_id=$1 AND project_id=$2 AND user_id=$3', [r.ctx.orgId, p.id, r.params.userId]);
      if (!row) throw notFound('Board member');
      if (row.role === 'owner') {
        const owners = await tx.one(`SELECT count(*)::int AS n FROM project_members WHERE org_id=$1 AND project_id=$2 AND role='owner'`, [r.ctx.orgId, p.id]);
        if (owners.n <= 1) throw badRequest('A board needs at least one owner.');
      }
      await tx.query('DELETE FROM project_members WHERE org_id=$1 AND project_id=$2 AND user_id=$3', [r.ctx.orgId, p.id, r.params.userId]);
    });
    return { data: { removed: true } };
  });

  /**
   * Names for the people on the caller's boards. Employees cannot read the
   * workspace member list, but they should see who they share a board with —
   * and nobody else.
   */
  app.get('/tasks/people', { preHandler: guard('tasks.tasks.view') }, async (r) => {
    const values = [r.ctx.orgId];
    const visible = visibleBoardSql(r, values);
    const rows = await db.rows(
      `SELECT DISTINCT m.user_id FROM project_members m
         JOIN projects p ON p.org_id = m.org_id AND p.id = m.project_id
        WHERE m.org_id = $1 AND ${visible}`,
      values,
    );
    const ids = [...new Set([r.ctx.userId, ...rows.map((row) => row.user_id)])].slice(0, 500);
    const response = await fetch(`${config.identityUrl}/internal/users/lookup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-nexus-service-token': config.serviceToken },
      body: JSON.stringify({ ids }),
      signal: AbortSignal.timeout(8000),
    }).catch(() => null);
    const users = response?.ok ? (await response.json()).data ?? [] : [];
    return { data: users.map((u) => ({ user_id: u.id, name: u.name, email: u.email, avatar_url: u.avatar_url ?? null })) };
  });

  // ── Kanban columns ────────────────────────────────────────────────────────
  const columnParams = { params: params({ projectId: v.id('prj'), columnId: v.id('col') }) };
  const columnBody = { name: v.text(40), status: v.enum(STATES) };

  app.get('/tasks/projects/:projectId/columns', { preHandler: guard('tasks.projects.view'), schema: boardId }, async (r) => {
    const p = await board(db, r, r.params.projectId);
    return { data: await db.transaction((tx) => columns(tx, r.ctx.orgId, p.id)) };
  });

  // Anyone who can change the board's tasks can add, rename and reorder its columns.
  app.post('/tasks/projects/:projectId/columns', { preHandler: guard('tasks.projects.view'), schema: { ...boardId, body: body(columnBody, ['name']) } }, async (r, reply) => {
    if (!r.body.name.trim()) throw badRequest('Name the column.');
    const row = await db.transaction(async (tx) => {
      const p = await board(tx, r, r.params.projectId, 'edit');
      const existing = await columns(tx, r.ctx.orgId, p.id);
      if (existing.length >= 20) throw badRequest('A board can have up to 20 columns.');
      return tx.one(
        `INSERT INTO board_columns (id, org_id, project_id, name, status, position, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [id('col'), r.ctx.orgId, p.id, r.body.name.trim(), r.body.status ?? 'todo', Math.max(...existing.map((c) => c.position)) + 1, r.ctx.userId],
      );
    });
    return reply.code(201).send({ data: row });
  });

  app.patch('/tasks/projects/:projectId/columns/:columnId', { preHandler: guard('tasks.projects.view'), schema: { ...columnParams, body: body(columnBody) } }, async (r) => {
    if (r.body.name !== undefined && !r.body.name.trim()) throw badRequest('Name the column.');
    const row = await db.transaction(async (tx) => {
      const p = await board(tx, r, r.params.projectId, 'edit');
      const old = await columnFor(tx, r.ctx.orgId, p.id, r.params.columnId);
      const updated = await tx.one(
        'UPDATE board_columns SET name = COALESCE($3, name), status = COALESCE($4, status) WHERE org_id = $1 AND id = $2 RETURNING *',
        [r.ctx.orgId, old.id, r.body.name?.trim() ?? null, r.body.status ?? null],
      );
      // Its tasks follow what the column now counts as.
      if (updated.status !== old.status) {
        await tx.query(
          `UPDATE tasks SET status = $3, completed_at = CASE WHEN $3 = 'done' THEN COALESCE(completed_at, now()) ELSE NULL END, updated_at = now()
            WHERE org_id = $1 AND column_id = $2 AND archived_at IS NULL`,
          [r.ctx.orgId, old.id, updated.status],
        );
      }
      return updated;
    });
    return { data: row };
  });

  app.put('/tasks/projects/:projectId/columns', { preHandler: guard('tasks.projects.view'), schema: { ...boardId, body: body({ ids: { type: 'array', items: v.id('col'), minItems: 1, maxItems: 20 } }, ['ids']) } }, async (r) => {
    const p = await board(db, r, r.params.projectId, 'edit');
    await db.query(
      `UPDATE board_columns c SET position = o.n - 1 FROM unnest($3::text[]) WITH ORDINALITY AS o(id, n)
        WHERE c.org_id = $1 AND c.project_id = $2 AND c.id = o.id`,
      [r.ctx.orgId, p.id, r.body.ids],
    );
    return { data: await db.transaction((tx) => columns(tx, r.ctx.orgId, p.id)) };
  });

  // Removing a column is the board owner's call; its tasks move to another column.
  app.delete('/tasks/projects/:projectId/columns/:columnId', { preHandler: guard('tasks.projects.view'), schema: { ...columnParams, body: body({ move_to: v.id('col') }, ['move_to']) } }, async (r) => {
    await db.transaction(async (tx) => {
      const p = await board(tx, r, r.params.projectId, 'manage');
      const all = await columns(tx, r.ctx.orgId, p.id);
      const gone = all.find((c) => c.id === r.params.columnId);
      const target = all.find((c) => c.id === r.body.move_to);
      if (!gone) throw notFound('Column');
      if (!target || target.id === gone.id) throw badRequest('Choose another column for its tasks.');
      const firstOfState = all.find((c) => c.status === gone.status)?.id === gone.id;
      await tx.query(
        `UPDATE tasks SET column_id = $4, status = $5,
                completed_at = CASE WHEN $5 = 'done' THEN COALESCE(completed_at, now()) ELSE NULL END, updated_at = now()
          WHERE org_id = $1 AND project_id = $2 AND archived_at IS NULL
            AND (column_id = $3 OR ($6 AND column_id IS NULL AND status = $7))`,
        [r.ctx.orgId, p.id, gone.id, target.id, target.status, firstOfState, gone.status],
      );
      await tx.query('DELETE FROM board_columns WHERE org_id = $1 AND id = $2', [r.ctx.orgId, gone.id]);
    });
    return { data: { deleted: true } };
  });

  // ── milestones ────────────────────────────────────────────────────────────
  app.get('/tasks/projects/:projectId/milestones', { preHandler: guard('tasks.projects.view'), schema: boardId }, async (r) => {
    await board(db, r, r.params.projectId);
    return { data: await db.rows('SELECT * FROM milestones WHERE org_id=$1 AND project_id=$2 ORDER BY due_date NULLS LAST,created_at', [r.ctx.orgId, r.params.projectId]) };
  });
  app.post('/tasks/projects/:projectId/milestones', { preHandler: guard('tasks.projects.edit'), schema: {
    ...boardId, body: body({ title: v.text(160), due_date: nullable(v.date) }, ['title']),
  } }, async (r, reply) => {
    const p = await board(db, r, r.params.projectId, 'edit');
    if (p.status !== 'active' || !r.body.title.trim()) throw badRequest('An active board and milestone title are required.');
    return reply.code(201).send({ data: await db.one(`INSERT INTO milestones(id,org_id,project_id,title,due_date) VALUES($1,$2,$3,$4,$5) RETURNING *`, [id('mil'), r.ctx.orgId, p.id, r.body.title.trim(), r.body.due_date ?? null]) });
  });
  app.patch('/tasks/milestones/:milestoneId', { preHandler: guard('tasks.projects.edit'), schema: {
    params: params({ milestoneId: v.id('mil') }), body: body({ completed: v.bool }, ['completed']),
  } }, async (r) => {
    const milestone = await db.one('SELECT * FROM milestones WHERE org_id=$1 AND id=$2', [r.ctx.orgId, r.params.milestoneId]);
    if (!milestone) throw notFound('Milestone');
    await board(db, r, milestone.project_id, 'edit');
    const row = await db.one('UPDATE milestones SET completed=$3 WHERE org_id=$1 AND id=$2 RETURNING *', [r.ctx.orgId, r.params.milestoneId, r.body.completed]);
    return { data: row };
  });

  // ════════════════════════════════════════════════════════════════════ TASKS
  app.get('/tasks', { preHandler: guard('tasks.tasks.view'), schema: { querystring: query({ project_id: v.id('prj'), mine: v.bool, status: taskFields.status, parent_id: v.id('tsk'), source_app: v.slug, source_id: v.text(40), due_from: v.date, due_to: v.date, unfiled: v.bool }) } }, async (r) => {
    const values = [r.ctx.orgId], clauses = ['t.org_id=$1', 't.archived_at IS NULL'];
    if (r.query.project_id) await board(db, r, r.query.project_id);
    for (const field of ['project_id', 'status', 'parent_id', 'source_app', 'source_id']) if (r.query[field]) { values.push(r.query[field]); clauses.push(`t.${field}=$${values.length}`); }
    if (r.query.unfiled) clauses.push('t.project_id IS NULL');
    if (r.query.mine) { values.push(r.ctx.userId); clauses.push(`t.assignee_id=$${values.length}`); }
    if (r.query.q) { values.push(`%${r.query.q}%`); clauses.push(`t.title ILIKE $${values.length}`); }
    if (r.query.due_from) { values.push(r.query.due_from); clauses.push(`t.due_date >= $${values.length}`); }
    if (r.query.due_to) { values.push(r.query.due_to); clauses.push(`t.due_date <= $${values.length}`); }
    clauses.push(visibleTaskSql(r, values));
    const clause = clauses.join(' AND '), { page, limit } = r.query;
    const total = await db.one(`SELECT count(*)::int AS n, count(*) FILTER(WHERE status<>'done')::int AS open, count(*) FILTER(WHERE status='in_progress')::int AS in_progress, count(*) FILTER(WHERE status='done')::int AS done, count(*) FILTER(WHERE status<>'done' AND due_date<current_date)::int AS overdue FROM tasks t WHERE ${clause}`, values);
    values.push(limit, (page - 1) * limit);
    return { data: await db.rows(`SELECT t.*,p.name AS project_name,p.color AS project_color,c.name AS column_name,
      (SELECT count(*) FROM attachments a WHERE a.org_id=t.org_id AND a.task_id=t.id)::int AS attachment_count,
      (SELECT count(*) FROM attachments a WHERE a.org_id=t.org_id AND a.task_id=t.id AND a.name ~* '\\.(png|jpe?g|gif|webp|heic|heif|svg|bmp|avif)$')::int AS image_count
      FROM tasks t LEFT JOIN projects p ON p.org_id=t.org_id AND p.id=t.project_id LEFT JOIN board_columns c ON c.org_id=t.org_id AND c.id=t.column_id
      WHERE ${clause} ORDER BY t.due_date NULLS LAST,t.created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values), meta: { total: total.n, page, limit, stats: total } };
  });
  app.post('/tasks', { preHandler: guard('tasks.tasks.create'), schema: { body: body({ ...taskFields, parent_id: v.id('tsk'), source_app: v.enum(['crm', 'hr', 'helpdesk', 'recruitment']), source_type: v.enum(['lead', 'deal', 'employee', 'ticket', 'candidate']), source_id: v.text(40) }, ['title']) } }, async (r, reply) => {
    const b = { ...r.body };
    if (b.source_app || b.source_type || b.source_id) {
      const path = sourcePaths[`${b.source_app}.${b.source_type}`];
      if (!path || !/^[a-z]+_[0-9a-hjkmnp-tv-z]{26}$/.test(b.source_id ?? '')) throw badRequest('Choose a valid source record.');
      await readExternal(r, `${path}/${b.source_id}`);
    }
    const row = await db.transaction(async (tx) => {
      await lockWorkspace(tx, r.ctx.orgId);
      if (b.parent_id) {
        const parent = await task(tx, r, b.parent_id, { lock: true, need: 'edit' });
        if (parent.status === 'done') throw badRequest('Reopen the parent task before adding subtasks.');
        if (b.project_id && b.project_id !== parent.project_id) throw badRequest('Subtasks must use the parent board.');
        b.project_id = parent.project_id;
      }
      await references(tx, r, b);
      const column = await columnFor(tx, r.ctx.orgId, b.project_id, b.column_id);
      if (column) b.status = column.status;
      const created = await tx.one(`INSERT INTO tasks(id,org_id,project_id,parent_id,milestone_id,title,description,status,priority,assignee_id,due_date,source_app,source_type,source_id,created_by,completed_at,column_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,CASE WHEN $8='done' THEN now() ELSE NULL END,$16) RETURNING *`,
      [id('tsk'), r.ctx.orgId, b.project_id ?? null, b.parent_id ?? null, b.milestone_id ?? null, b.title.trim(), b.description ?? '', b.status ?? 'todo', b.priority ?? 'medium', b.assignee_id ?? null, b.due_date ?? null, b.source_app ?? null, b.source_type ?? null, b.source_id ?? null, r.ctx.userId, column?.id ?? null]);
      emit(tx, r, EVENTS.TASK_CREATED, created);
      // Creating a task with somebody's name on it is assigning it to them.
      if (created.assignee_id) await emitAssigned(tx, r, created);
      return created;
    });
    return reply.code(201).send({ data: row });
  });
  app.get('/tasks/widgets', { preHandler: guard('tasks.tasks.view') }, async (r) => {
    const values = [r.ctx.orgId, r.ctx.userId];
    const visible = visibleTaskSql(r, values, 'tasks');
    const counts = await db.one(`SELECT count(*) FILTER(WHERE assignee_id=$2 AND status<>'done')::int AS mine,
      count(*) FILTER(WHERE due_date<current_date AND status<>'done')::int AS overdue FROM tasks WHERE org_id=$1 AND archived_at IS NULL AND ${visible}`, values);
    return { data: { 'tasks.my_open': counts.mine, 'tasks.overdue': counts.overdue } };
  });
  app.get('/tasks/time', { preHandler: guard('tasks.time.view'), schema: { querystring: query({ from: v.date, to: v.date, project_id: v.id('prj'), mine: v.bool }) } }, async (r) => {
    if (r.query.project_id) await board(db, r, r.query.project_id);
    const values = [r.ctx.orgId, r.query.from ?? null, r.query.to ?? null, r.query.project_id ?? null, r.query.mine ? r.ctx.userId : null];
    const visible = visibleTaskSql(r, values);
    const clause = `e.org_id=$1 AND ($2::date IS NULL OR e.worked_on >= $2) AND ($3::date IS NULL OR e.worked_on <= $3) AND ($4::text IS NULL OR t.project_id=$4) AND ($5::text IS NULL OR e.user_id=$5) AND ${visible}`;
    const total = await db.one(`SELECT count(*)::int AS count,COALESCE(sum(minutes),0)::int AS minutes FROM time_entries e JOIN tasks t ON t.org_id=e.org_id AND t.id=e.task_id WHERE ${clause}`, values);
    values.push(r.query.limit, (r.query.page - 1) * r.query.limit);
    return { data: await db.rows(`SELECT e.*,t.title,t.project_id,p.name AS project_name FROM time_entries e JOIN tasks t ON t.org_id=e.org_id AND t.id=e.task_id LEFT JOIN projects p ON p.org_id=t.org_id AND p.id=t.project_id
      WHERE ${clause} ORDER BY e.worked_on DESC,e.created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values), meta: { total: total.count, minutes: total.minutes, page: r.query.page, limit: r.query.limit } };
  });
  app.get('/tasks/:taskId', { preHandler: guard('tasks.tasks.view'), schema: routeId }, async (r) => {
    const row = await task(db, r, r.params.taskId);
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
    const old = await task(tx, r, r.params.taskId, { lock: true, need: 'edit' });
    const b = { ...r.body };
    // Moving to a column sets the status; a new status alone (or another board)
    // drops the task into the first column for that status. Sent together and
    // disagreeing (the edit form changed the status), the status wins.
    const boardChanged = b.project_id !== undefined && b.project_id !== old.project_id;
    let column = boardChanged
      ? await columnFor(tx, r.ctx.orgId, b.project_id, b.column_id).catch(() => null)
      : await columnFor(tx, r.ctx.orgId, old.project_id, b.column_id);
    if (column && b.status !== undefined && b.status !== column.status) column = null;
    if (column) b.status = column.status;
    else if (b.column_id !== undefined || b.status !== undefined || boardChanged) b.column_id = null;
    const next = { ...old, ...b };
    if (b.project_id !== undefined && b.project_id !== old.project_id) {
      const child = await tx.one('SELECT id FROM tasks WHERE org_id=$1 AND parent_id=$2 AND archived_at IS NULL LIMIT 1', [r.ctx.orgId, old.id]);
      if (old.parent_id || child) throw badRequest('A task with a parent or subtasks cannot move between boards.');
    }
    if (b.status === 'done') {
      const child = await tx.one(`SELECT id FROM tasks WHERE org_id=$1 AND parent_id=$2 AND status<>'done' AND archived_at IS NULL LIMIT 1`, [r.ctx.orgId, old.id]);
      if (child) throw badRequest('Complete the subtasks first.');
    }
    if (old.parent_id && b.status && b.status !== 'done') {
      const parent = await task(tx, r, old.parent_id);
      if (parent.status === 'done') throw badRequest('Reopen the parent task first.');
    }
    await references(tx, r, b, old);
    const row = await tx.one(`UPDATE tasks SET title=$3,description=$4,project_id=$5,milestone_id=$6,status=$7,priority=$8,
      assignee_id=$9,due_date=$10,completed_at=CASE WHEN $7='done' THEN COALESCE(completed_at,now()) ELSE NULL END,column_id=$11,updated_at=now(),
      reminded_at=CASE WHEN due_date IS DISTINCT FROM $10::date OR assignee_id IS DISTINCT FROM $9 THEN NULL ELSE reminded_at END
      WHERE org_id=$1 AND id=$2 RETURNING *`, [r.ctx.orgId, old.id, next.title.trim(), next.description, next.project_id, next.milestone_id, next.status, next.priority, next.assignee_id, next.due_date, next.column_id ?? null]);
    if (row.assignee_id && row.assignee_id !== old.assignee_id) await emitAssigned(tx, r, row);
    if (row.status === 'done' && old.status !== 'done') emit(tx, r, EVENTS.TASK_COMPLETED, row);
    return row;
  }) }));
  // Whoever created a task may delete it; deleting other people's needs tasks.tasks.delete.
  app.delete('/tasks/:taskId', { preHandler: guard('tasks.tasks.view'), schema: routeId }, async (r) => {
    await db.transaction(async (tx) => {
      await lockWorkspace(tx, r.ctx.orgId);
      const row = await task(tx, r, r.params.taskId, { lock: true });
      if (row.created_by !== r.ctx.userId) {
        if (!r.ctx.can('tasks.tasks.delete')) throw forbidden('You can delete the tasks you created. Ask the board owner to remove this one.');
        await task(tx, r, r.params.taskId, { need: 'edit' });
      }
      const child = await tx.one('SELECT id FROM tasks WHERE org_id=$1 AND parent_id=$2 AND archived_at IS NULL LIMIT 1', [r.ctx.orgId, r.params.taskId]);
      if (child) throw badRequest('Archive the subtasks first.');
      await tx.query('UPDATE tasks SET archived_at=now() WHERE org_id=$1 AND id=$2', [r.ctx.orgId, r.params.taskId]);
    });
    return { data: { archived: true } };
  });
  app.post('/tasks/:taskId/comments', { preHandler: guard('tasks.tasks.edit'), schema: { ...routeId, body: body({ body: v.text(10000) }, ['body']) } }, async (r, reply) => {
    await task(db, r, r.params.taskId);
    if (!r.body.body.trim()) throw badRequest('Write a comment first.');
    return reply.code(201).send({ data: await db.one('INSERT INTO comments(id,org_id,task_id,body,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *', [id('cmt'), r.ctx.orgId, r.params.taskId, r.body.body.trim(), r.ctx.userId]) });
  });
  app.post('/tasks/:taskId/time', { preHandler: guard('tasks.time.log'), schema: { ...routeId, body: body({ minutes: v.int(1, 1440), worked_on: v.date, note: v.text(1000, 0) }, ['minutes', 'worked_on']) } }, async (r, reply) => {
    await task(db, r, r.params.taskId);
    return reply.code(201).send({ data: await db.one('INSERT INTO time_entries(id,org_id,task_id,user_id,minutes,worked_on,note) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *', [id('tim'), r.ctx.orgId, r.params.taskId, r.ctx.userId, r.body.minutes, r.body.worked_on, r.body.note ?? '']) });
  });
  app.post('/tasks/:taskId/attachments', { preHandler: guard('tasks.tasks.edit'), schema: { ...routeId, body: body({ document_id: v.id('doc') }, ['document_id']) } }, async (r, reply) => {
    await task(db, r, r.params.taskId, { need: 'edit' });
    const doc = await readExternal(r, `documents/${r.body.document_id}`);
    const row = await db.one(`INSERT INTO attachments(id,org_id,task_id,document_id,name,created_by) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(org_id,task_id,document_id) DO UPDATE SET name=EXCLUDED.name RETURNING *`, [id('att'), r.ctx.orgId, r.params.taskId, doc.id, doc.name, r.ctx.userId]);
    return reply.code(201).send({ data: row });
  });
  app.delete('/tasks/:taskId/attachments/:attachmentId', { preHandler: guard('tasks.tasks.edit'), schema: { params: params({ taskId: v.id('tsk'), attachmentId: v.id('att') }) } }, async (r) => {
    await task(db, r, r.params.taskId, { need: 'edit' });
    const row = await db.one('DELETE FROM attachments WHERE org_id=$1 AND task_id=$2 AND id=$3 RETURNING id', [r.ctx.orgId, r.params.taskId, r.params.attachmentId]);
    if (!row) throw notFound('Attachment');
    return { data: row };
  });

  // ═══════════════════════════════════════════════════════════════ REMINDERS
  // Every minute: open tasks due today (from 9 am India time) or overdue by up
  // to a week remind their assignee — or, unassigned, whoever created them —
  // once, by notification and email.
  const timer = setInterval(async () => {
    try {
      const due = await db.rows(
        `UPDATE tasks t SET reminded_at = now()
          WHERE t.id IN (
            SELECT id FROM tasks
             WHERE reminded_at IS NULL AND archived_at IS NULL AND status <> 'done' AND due_date IS NOT NULL
               AND due_date > (now() AT TIME ZONE 'Asia/Kolkata')::date - 7
               AND (due_date < (now() AT TIME ZONE 'Asia/Kolkata')::date
                    OR (due_date = (now() AT TIME ZONE 'Asia/Kolkata')::date AND extract(hour FROM now() AT TIME ZONE 'Asia/Kolkata') >= 9))
             ORDER BY due_date LIMIT 200 FOR UPDATE SKIP LOCKED)
          RETURNING t.id, t.org_id, t.title, t.description, t.priority, t.status, t.due_date, t.assignee_id, t.created_by, t.project_id`,
      );
      if (!due.length) return;
      const boards = await db.rows('SELECT id, name FROM projects WHERE id = ANY($1)', [[...new Set(due.map((t) => t.project_id).filter(Boolean))]]);
      const boardName = new Map(boards.map((b) => [b.id, b.name]));
      for (const t of due) {
        await db.transaction(async (tx) => {
          tx.emit({
            type: EVENTS.TASK_DUE, org_id: t.org_id, actor_id: null,
            data: {
              task_id: t.id, title: t.title, due_date: t.due_date, status: t.status, priority: t.priority,
              user_id: t.assignee_id ?? t.created_by, board_name: boardName.get(t.project_id) ?? null,
              description: (t.description ?? '').trim().slice(0, 500) || null,
            },
          });
        });
      }
    } catch (error) {
      app.log.error({ err: error }, 'task reminders failed');
    }
  }, 60_000);
  timer.unref?.();
  app.addHook('onClose', async () => clearInterval(timer));
}
