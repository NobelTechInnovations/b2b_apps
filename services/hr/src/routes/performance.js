import { id, paginate } from '@nexus/db-kit';
import {
  requirePermission, body, params, query, validate as v, notFound, badRequest, conflict,
} from '@nexus/service-kit';

/**
 * Performance reviews.
 *
 * A cycle moves forward only: draft → self review → manager review →
 * calibration → shared → closed. Reopening a shared cycle would let a rating
 * change after the person has already read it, which is the one thing a
 * performance record must never allow.
 */
const NEXT_STATUS = {
  draft: ['self_review', 'manager_review'],
  self_review: ['manager_review'],
  manager_review: ['calibration', 'self_review'],
  calibration: ['shared', 'manager_review'],
  shared: ['closed'],
  closed: [],
};

const DEFAULT_COMPETENCIES = [
  'Quality of work',
  'Ownership',
  'Collaboration',
  'Communication',
  'Dependability',
];

export async function performanceRoutes(app) {
  const { db } = app;

  // ══════════════════════════════════════════════════════════════ CYCLES
  app.get(
    '/hr/performance/cycles',
    { preHandler: [app.loadContext, requirePermission('hr.performance.view')] },
    async (request) => {
      const rows = await db.rows(
        `SELECT c.*,
                (SELECT count(*)::int FROM reviews r WHERE r.cycle_id = c.id) AS review_count,
                (SELECT count(*)::int FROM reviews r WHERE r.cycle_id = c.id
                  AND r.self_submitted_at IS NOT NULL) AS self_submitted,
                (SELECT count(*)::int FROM reviews r WHERE r.cycle_id = c.id
                  AND r.manager_submitted_at IS NOT NULL) AS manager_submitted,
                (SELECT count(*)::int FROM reviews r WHERE r.cycle_id = c.id
                  AND r.acknowledged_at IS NOT NULL) AS acknowledged,
                (SELECT round(avg(r.overall_rating), 2) FROM reviews r
                  WHERE r.cycle_id = c.id AND r.overall_rating IS NOT NULL) AS average_rating
           FROM review_cycles c
          WHERE c.org_id = $1 AND c.archived_at IS NULL
          ORDER BY c.period_end DESC`,
        [request.ctx.orgId],
      );

      return {
        data: rows.map((row) => ({
          ...row,
          next_statuses: NEXT_STATUS[row.status] ?? [],
        })),
      };
    },
  );

  app.post(
    '/hr/performance/cycles',
    {
      preHandler: [app.loadContext, requirePermission('hr.performance.manage')],
      schema: {
        body: body(
          {
            name: v.text(120, 1),
            period_start: v.date,
            period_end: v.date,
            self_review_due: v.date,
            manager_review_due: v.date,
            rating_scale: v.int(3, 10),
            competencies: { type: 'array', items: v.text(80), maxItems: 20 },
            instructions: v.text(2000),
          },
          ['name', 'period_start', 'period_end'],
        ),
      },
    },
    async (request, reply) => {
      const { orgId, userId } = request.ctx;
      const b = request.body;

      if (b.period_end < b.period_start) throw badRequest('The period ends before it starts.');

      const clash = await db.one(
        `SELECT id FROM review_cycles WHERE org_id = $1 AND lower(name) = lower($2) AND archived_at IS NULL`,
        [orgId, b.name.trim()],
      );
      if (clash) throw conflict('A cycle with that name already exists.');

      const row = await db.one(
        `INSERT INTO review_cycles
           (id, org_id, name, period_start, period_end, self_review_due, manager_review_due,
            rating_scale, competencies, instructions, created_by)
         VALUES ($1,$2,$3,$4::date,$5::date,$6::date,$7::date,$8,$9::jsonb,$10,$11)
         RETURNING *`,
        [
          id('cyc'), orgId, b.name.trim(), b.period_start, b.period_end,
          b.self_review_due ?? null, b.manager_review_due ?? null,
          b.rating_scale ?? 5,
          JSON.stringify(b.competencies?.length ? b.competencies : DEFAULT_COMPETENCIES),
          b.instructions ?? null, userId,
        ],
      );

      return reply.status(201).send({ data: { ...row, review_count: 0, next_statuses: NEXT_STATUS.draft } });
    },
  );

  /**
   * Enrol people into a cycle.
   *
   * Each review is created with its reviewer resolved from the reporting line
   * at enrolment time and the name snapshotted — a manager who leaves halfway
   * through a cycle should not erase who wrote the review.
   */
  app.post(
    '/hr/performance/cycles/:cycleId/enrol',
    {
      preHandler: [app.loadContext, requirePermission('hr.performance.manage')],
      schema: {
        params: params({ cycleId: v.id('cyc') }),
        body: body(
          {
            employee_ids: { type: 'array', items: v.id('emp'), maxItems: 1000 },
            department_id: v.id('dep'),
            everyone: v.bool,
          },
          [],
        ),
      },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const b = request.body;

      const cycle = await db.one(
        `SELECT * FROM review_cycles WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
        [request.params.cycleId, orgId],
      );
      if (!cycle) throw notFound('Cycle');
      if (['shared', 'closed'].includes(cycle.status)) {
        throw badRequest('This cycle has already been shared. Enrol people before sharing.');
      }

      const values = [orgId];
      let filter = '';
      if (b.employee_ids?.length) {
        values.push(b.employee_ids);
        filter += ` AND e.id = ANY($${values.length}::text[])`;
      } else if (b.department_id) {
        values.push(b.department_id);
        filter += ` AND e.department_id = $${values.length}`;
      } else if (!b.everyone) {
        throw badRequest('Choose people, a department, or everyone.');
      }

      const people = await db.rows(
        `SELECT e.id, e.manager_id,
                m.first_name AS manager_first_name, m.last_name AS manager_last_name
           FROM employees e
           LEFT JOIN employees m ON m.id = e.manager_id
          WHERE e.org_id = $1 AND e.archived_at IS NULL AND e.status <> 'exited' ${filter}`,
        values,
      );
      if (!people.length) throw badRequest('Nobody matched that selection.');

      let added = 0;
      let unmanaged = 0;

      await db.transaction(async (tx) => {
        for (const person of people) {
          const reviewerName = person.manager_first_name
            ? [person.manager_first_name, person.manager_last_name].filter(Boolean).join(' ')
            : null;
          if (!person.manager_id) unmanaged += 1;

          const created = await tx.one(
            `INSERT INTO reviews (id, org_id, cycle_id, employee_id, reviewer_id, reviewer_name)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (cycle_id, employee_id) DO NOTHING
             RETURNING id`,
            [id('rev'), orgId, cycle.id, person.id, person.manager_id, reviewerName],
          );
          if (created) added += 1;
        }
      });

      return {
        data: { enrolled: added, already_enrolled: people.length - added },
        meta: {
          // Named rather than silently left reviewer-less: somebody has to
          // write these, and HR needs to know who is missing a manager.
          without_a_manager: unmanaged,
        },
      };
    },
  );

  app.post(
    '/hr/performance/cycles/:cycleId/status',
    {
      preHandler: [app.loadContext, requirePermission('hr.performance.manage')],
      schema: {
        params: params({ cycleId: v.id('cyc') }),
        body: body({
          status: v.enum(['self_review', 'manager_review', 'calibration', 'shared', 'closed']),
        }, ['status']),
      },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const target = request.body.status;

      const cycle = await db.one(
        `SELECT * FROM review_cycles WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
        [request.params.cycleId, orgId],
      );
      if (!cycle) throw notFound('Cycle');

      const allowed = NEXT_STATUS[cycle.status] ?? [];
      if (!allowed.includes(target)) {
        throw badRequest(
          allowed.length
            ? `A cycle in ${cycle.status.replace('_', ' ')} can only move to: ${allowed.join(', ')}.`
            : 'A closed cycle cannot be changed.',
          { from: cycle.status, allowed },
        );
      }

      if (target === 'shared') {
        const unrated = await db.one(
          `SELECT count(*)::int AS n FROM reviews
            WHERE cycle_id = $1 AND org_id = $2 AND overall_rating IS NULL`,
          [cycle.id, orgId],
        );
        if (unrated.n > 0) {
          throw badRequest(
            `${unrated.n} review${unrated.n === 1 ? ' has' : 's have'} no overall rating yet. Sharing a blank review helps nobody.`,
            { unrated: unrated.n },
          );
        }
      }

      const updated = await db.transaction(async (tx) => {
        const row = await tx.one(
          `UPDATE review_cycles SET status = $3 WHERE id = $1 AND org_id = $2 RETURNING *`,
          [cycle.id, orgId, target],
        );

        // Sharing is the moment the employee can see the manager's words.
        if (target === 'shared') {
          await tx.query(
            `UPDATE reviews SET status = 'shared', shared_at = now()
              WHERE cycle_id = $1 AND org_id = $2 AND status <> 'acknowledged'`,
            [cycle.id, orgId],
          );
        }

        return row;
      });

      return { data: { ...updated, next_statuses: NEXT_STATUS[updated.status] ?? [] } };
    },
  );

  // ══════════════════════════════════════════════════════════════ REVIEWS
  app.get(
    '/hr/performance/reviews',
    {
      preHandler: [app.loadContext, requirePermission('hr.performance.view')],
      schema: {
        querystring: query({
          cycle_id: v.id('cyc'),
          employee_id: v.id('emp'),
          reviewer_id: v.id('emp'),
          status: v.enum(['pending', 'self_submitted', 'manager_submitted', 'shared', 'acknowledged']),
        }),
      },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const page = paginate({ ...request.query, allowedSorts: ['created_at', 'overall_rating'] });
      const qs = request.query;

      const where = ['r.org_id = $1'];
      const values = [orgId];
      if (qs.cycle_id) { values.push(qs.cycle_id); where.push(`r.cycle_id = $${values.length}`); }
      if (qs.employee_id) { values.push(qs.employee_id); where.push(`r.employee_id = $${values.length}`); }
      if (qs.reviewer_id) { values.push(qs.reviewer_id); where.push(`r.reviewer_id = $${values.length}`); }
      if (qs.status) { values.push(qs.status); where.push(`r.status = $${values.length}`); }

      const clause = where.join(' AND ');
      const join = `FROM reviews r
                    JOIN review_cycles c ON c.id = r.cycle_id
                    JOIN employees e ON e.id = r.employee_id
                    LEFT JOIN departments d ON d.id = e.department_id`;

      const [rows, total] = await Promise.all([
        db.rows(
          `SELECT r.*, c.name AS cycle_name, c.status AS cycle_status, c.rating_scale, c.competencies,
                  e.first_name, e.last_name, e.employee_code, e.designation,
                  d.name AS department_name ${join}
            WHERE ${clause} ORDER BY r.${page.orderBy} LIMIT ${page.limit} OFFSET ${page.offset}`,
          values,
        ),
        db.one(`SELECT count(*)::int AS n ${join} WHERE ${clause}`, values),
      ]);

      return {
        data: rows.map((r) => ({
          ...r,
          name: [r.first_name, r.last_name].filter(Boolean).join(' '),
        })),
        meta: page.meta(total.n),
      };
    },
  );

  /** The manager's half of a review, plus the calibrated rating. */
  app.patch(
    '/hr/performance/reviews/:reviewId',
    {
      preHandler: [app.loadContext, requirePermission('hr.performance.review')],
      schema: {
        params: params({ reviewId: v.id('rev') }),
        body: body({
          manager_scores: { type: 'object', additionalProperties: true },
          manager_comments: v.text(4000),
          strengths: v.text(2000),
          improvements: v.text(2000),
          overall_rating: { type: 'number', minimum: 0, maximum: 10 },
          recommendation: v.enum(['exceeds', 'meets', 'below', 'promote', 'improve', 'exit']),
          submit: v.bool,
        }),
      },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const b = request.body;

      const review = await db.one(
        `SELECT r.*, c.status AS cycle_status, c.rating_scale
           FROM reviews r JOIN review_cycles c ON c.id = r.cycle_id
          WHERE r.id = $1 AND r.org_id = $2`,
        [request.params.reviewId, orgId],
      );
      if (!review) throw notFound('Review');
      if (['shared', 'closed'].includes(review.cycle_status)) {
        throw badRequest('This cycle has been shared. A rating cannot change after the employee has read it.');
      }
      if (b.overall_rating !== undefined && b.overall_rating > review.rating_scale) {
        throw badRequest(`This cycle is rated out of ${review.rating_scale}.`);
      }

      const fields = ['manager_comments', 'strengths', 'improvements', 'overall_rating', 'recommendation']
        .filter((f) => b[f] !== undefined);
      const submit = b.submit ?? false;

      if (!fields.length && b.manager_scores === undefined && !submit) {
        throw badRequest('Nothing to update.');
      }

      const sets = fields.map((f, i) => `${f} = $${i + 3}`);
      const values = [review.id, orgId, ...fields.map((f) => b[f])];

      if (b.manager_scores !== undefined) {
        values.push(JSON.stringify(b.manager_scores));
        sets.push(`manager_scores = $${values.length}::jsonb`);
      }
      if (submit) {
        sets.push(`status = 'manager_submitted'`, `manager_submitted_at = now()`);
      }

      const updated = await db.one(
        `UPDATE reviews SET ${sets.join(', ')} WHERE id = $1 AND org_id = $2 RETURNING *`,
        values,
      );

      return { data: updated };
    },
  );

  // ═══════════════════════════════════════════════════════════════ GOALS
  app.get(
    '/hr/performance/goals',
    {
      preHandler: [app.loadContext, requirePermission('hr.performance.view')],
      schema: { querystring: query({ employee_id: v.id('emp'), cycle_id: v.id('cyc'), status: v.enum(['draft', 'active', 'achieved', 'missed', 'dropped']) }) },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const qs = request.query;

      const where = ['g.org_id = $1'];
      const values = [orgId];
      if (qs.employee_id) { values.push(qs.employee_id); where.push(`g.employee_id = $${values.length}`); }
      if (qs.cycle_id) { values.push(qs.cycle_id); where.push(`g.cycle_id = $${values.length}`); }
      if (qs.status) { values.push(qs.status); where.push(`g.status = $${values.length}`); }

      const rows = await db.rows(
        `SELECT g.*, e.first_name, e.last_name, e.employee_code
           FROM goals g JOIN employees e ON e.id = g.employee_id
          WHERE ${where.join(' AND ')}
          ORDER BY g.status, g.due_on NULLS LAST, g.created_at DESC`,
        values,
      );

      return {
        data: rows.map((r) => ({
          ...r,
          name: [r.first_name, r.last_name].filter(Boolean).join(' '),
        })),
      };
    },
  );

  app.post(
    '/hr/performance/goals',
    {
      preHandler: [app.loadContext, requirePermission('hr.performance.manage')],
      schema: {
        body: body(
          {
            employee_id: v.id('emp'),
            cycle_id: v.id('cyc'),
            title: v.text(200, 1),
            description: v.text(2000),
            metric: v.text(120),
            target_value: v.money,
            unit: v.text(40),
            weight: v.int(1, 10),
            due_on: v.date,
            status: v.enum(['draft', 'active']),
          },
          ['employee_id', 'title'],
        ),
      },
    },
    async (request, reply) => {
      const { orgId, userId } = request.ctx;
      const b = request.body;

      const employee = await db.one(
        `SELECT id FROM employees WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
        [b.employee_id, orgId],
      );
      if (!employee) throw notFound('Employee');

      const row = await db.one(
        `INSERT INTO goals
           (id, org_id, employee_id, cycle_id, title, description, metric,
            target_value, unit, weight, due_on, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::date,$12,$13) RETURNING *`,
        [
          id('gol'), orgId, b.employee_id, b.cycle_id ?? null, b.title.trim(),
          b.description ?? null, b.metric ?? null, b.target_value ?? null,
          b.unit ?? null, b.weight ?? 1, b.due_on ?? null, b.status ?? 'active', userId,
        ],
      );

      return reply.status(201).send({ data: row });
    },
  );

  app.patch(
    '/hr/performance/goals/:goalId',
    {
      preHandler: [app.loadContext, requirePermission('hr.performance.manage')],
      schema: {
        params: params({ goalId: v.id('gol') }),
        body: body({
          title: v.text(200, 1), description: v.text(2000), metric: v.text(120),
          target_value: v.money, current_value: v.money, unit: v.text(40),
          weight: v.int(1, 10), progress: v.int(0, 100), due_on: v.date,
          status: v.enum(['draft', 'active', 'achieved', 'missed', 'dropped']),
        }),
      },
    },
    async (request) => {
      const fields = Object.keys(request.body);
      if (!fields.length) throw badRequest('Nothing to update.');

      const sets = fields.map((f, i) => `${f} = $${i + 3}`).join(', ');
      const row = await db.one(
        `UPDATE goals SET ${sets} WHERE id = $1 AND org_id = $2 RETURNING *`,
        [request.params.goalId, request.ctx.orgId, ...fields.map((f) => request.body[f])],
      );
      if (!row) throw notFound('Goal');

      return { data: row };
    },
  );

  // ══════════════════════════════════════════════════════════════ REPORT
  /**
   * The performance report.
   *
   * One row per person with their rating, how it moved, and whether their
   * goals were met — the sheet a promotion or increment conversation actually
   * runs off.
   */
  app.get(
    '/hr/performance/report',
    {
      preHandler: [app.loadContext, requirePermission('hr.performance.view')],
      schema: { querystring: query({ cycle_id: v.id('cyc'), department_id: v.id('dep') }) },
    },
    async (request) => {
      const { orgId } = request.ctx;

      const cycle = request.query.cycle_id
        ? await db.one(`SELECT * FROM review_cycles WHERE id = $1 AND org_id = $2`, [request.query.cycle_id, orgId])
        : await db.one(
            `SELECT * FROM review_cycles WHERE org_id = $1 AND archived_at IS NULL
              ORDER BY period_end DESC LIMIT 1`,
            [orgId],
          );

      if (!cycle) return { data: [], meta: { cycle: null, distribution: {}, headcount: 0 } };

      const values = [orgId, cycle.id];
      let filter = '';
      if (request.query.department_id) {
        values.push(request.query.department_id);
        filter = ` AND e.department_id = $${values.length}`;
      }

      const rows = await db.rows(
        `SELECT r.id AS review_id, r.employee_id, r.status, r.overall_rating, r.recommendation,
                r.reviewer_name, r.acknowledged_at, r.strengths, r.improvements,
                e.first_name, e.last_name, e.employee_code, e.designation, e.joined_on,
                d.name AS department_name,
                -- The previous cycle's rating, so movement is visible without
                -- anybody opening two screens side by side.
                (SELECT pr.overall_rating FROM reviews pr
                   JOIN review_cycles pc ON pc.id = pr.cycle_id
                  WHERE pr.employee_id = r.employee_id AND pc.period_end < $3::date
                    AND pr.overall_rating IS NOT NULL
                  ORDER BY pc.period_end DESC LIMIT 1) AS previous_rating,
                (SELECT count(*)::int FROM goals g
                  WHERE g.employee_id = r.employee_id AND g.cycle_id = r.cycle_id) AS goals_total,
                (SELECT count(*)::int FROM goals g
                  WHERE g.employee_id = r.employee_id AND g.cycle_id = r.cycle_id
                    AND g.status = 'achieved') AS goals_achieved
           FROM reviews r
           JOIN employees e ON e.id = r.employee_id
           LEFT JOIN departments d ON d.id = e.department_id
          WHERE r.org_id = $1 AND r.cycle_id = $2 ${filter}
          ORDER BY r.overall_rating DESC NULLS LAST, e.first_name`,
        [...values.slice(0, 2), cycle.period_end, ...values.slice(2)],
      );

      const data = rows.map((r) => ({
        ...r,
        name: [r.first_name, r.last_name].filter(Boolean).join(' '),
        rating_change: r.overall_rating != null && r.previous_rating != null
          ? Math.round((Number(r.overall_rating) - Number(r.previous_rating)) * 100) / 100
          : null,
        goal_completion: r.goals_total
          ? Math.round((r.goals_achieved / r.goals_total) * 100)
          : null,
      }));

      // The distribution is what a calibration meeting argues about.
      const distribution = {};
      for (const row of data) {
        if (row.overall_rating == null) continue;
        const band = Math.round(Number(row.overall_rating));
        distribution[band] = (distribution[band] ?? 0) + 1;
      }

      const rated = data.filter((r) => r.overall_rating != null);
      const average = rated.length
        ? Math.round((rated.reduce((sum, r) => sum + Number(r.overall_rating), 0) / rated.length) * 100) / 100
        : null;

      return {
        data,
        meta: {
          cycle: {
            id: cycle.id, name: cycle.name, status: cycle.status,
            period_start: cycle.period_start, period_end: cycle.period_end,
            rating_scale: cycle.rating_scale, competencies: cycle.competencies,
          },
          headcount: data.length,
          rated: rated.length,
          average_rating: average,
          distribution,
          acknowledged: data.filter((r) => r.acknowledged_at).length,
          by_recommendation: data.reduce((acc, r) => {
            if (r.recommendation) acc[r.recommendation] = (acc[r.recommendation] ?? 0) + 1;
            return acc;
          }, {}),
        },
      };
    },
  );
}
