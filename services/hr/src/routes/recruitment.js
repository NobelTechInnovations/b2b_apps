import { createHash } from 'node:crypto';
import { id, paginate } from '@nexus/db-kit';
import {
  body, params, query, validate as v, requireApp, requirePermission, notFound, badRequest, conflict, ApiError, peopleDirectory,
} from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';
import { ensureLeaveTypes } from '../lib/setup.js';
import { insertEmployee } from '../lib/employees.js';

const STAGES = ['applied', 'screening', 'interview', 'offer', 'hired', 'rejected'];
const STAGE_LABEL = { applied: 'Applied', screening: 'Screening', interview: 'Interview', offer: 'Offer', hired: 'Hired', rejected: 'Rejected' };
const SOURCES = ['manual', 'careers_page', 'referral', 'linkedin', 'naukri', 'walk_in', 'agency', 'other'];
const EMPLOYMENT = ['full_time', 'part_time', 'contract', 'intern', 'consultant'];
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const fullName = (c) => [c.first_name, c.last_name].filter(Boolean).join(' ');

/**
 * Recruitment: openings, a pipeline of candidates, interviews and offers.
 *
 * Stages move forward and back freely except into `hired`, which only the
 * hire action reaches — because hiring creates the employee, in HR, in the
 * same transaction, and nobody should be "hired" without one.
 */
export async function recruitmentRoutes(app) {
  const { db, config } = app;
  const people = peopleDirectory(config);
  const guard = (permission) => [app.loadContext, requireApp('recruitment'), requirePermission(permission)];
  const jobParams = { params: params({ jobId: v.id('job') }) };
  const candidateParams = { params: params({ candidateId: v.id('cand') }) };

  /** Interviewers and hiring managers: everyone who can see the pipeline. */
  app.get('/recruitment/people', { preHandler: guard('recruitment.candidates.view') }, async (request) => ({
    data: await people.withPermission(request.ctx.orgId, 'recruitment.candidates.view'),
  }));

  async function job(store, orgId, jobId) {
    const row = await store.one(`SELECT * FROM jobs WHERE org_id = $1 AND id = $2`, [orgId, jobId]);
    if (!row) throw notFound('Job');
    return row;
  }
  async function candidate(store, orgId, candidateId, lock = false) {
    const row = await store.one(
      `SELECT c.*, j.title AS job_title, j.department_id AS job_department_id, j.employment_type AS job_employment_type,
              j.location AS job_location
         FROM candidates c JOIN jobs j ON j.org_id = c.org_id AND j.id = c.job_id
        WHERE c.org_id = $1 AND c.id = $2${lock ? ' FOR UPDATE OF c' : ''}`,
      [orgId, candidateId],
    );
    if (!row) throw notFound('Candidate');
    return row;
  }
  async function assertDepartment(orgId, departmentId) {
    if (!departmentId) return;
    const row = await db.one(`SELECT 1 FROM departments WHERE org_id = $1 AND id = $2`, [orgId, departmentId]);
    if (!row) throw badRequest('Choose one of this workspace’s departments.');
  }
  async function assertMember(orgId, userId, permission) {
    const response = await fetch(`${config.tenancyUrl}/internal/authz/${orgId}/${userId}`, {
      headers: { 'x-nexus-service-token': config.serviceToken },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw app.httpErrors.serviceUnavailable('Membership lookup unavailable.');
    const auth = (await response.json()).data;
    if (!auth?.allowed || (!auth.is_owner && !auth.permissions.includes(permission))) {
      throw badRequest('Choose an active member with access to Recruitment.');
    }
  }
  const timeline = (tx, c, userId, bodyText, kind = 'event') =>
    tx.query(
      `INSERT INTO candidate_notes (id, org_id, candidate_id, kind, body, author_id) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id('cnote'), c.org_id, c.id, kind, bodyText, userId],
    );

  // ═════════════════════════════════════════════════════════════════════ JOBS
  const jobFields = {
    title: v.text(160, 1),
    department_id: nullable(v.id('dep')),
    location: nullable(v.text(120)),
    employment_type: v.enum(EMPLOYMENT),
    openings: v.int(1, 500),
    status: v.enum(['draft', 'open', 'on_hold', 'closed']),
    is_public: v.bool,
    description: { type: 'string', maxLength: 20_000 },
    salary_range: nullable(v.text(80)),
    closes_on: nullable(v.date),
    hiring_manager_id: nullable(v.id('usr')),
  };

  app.get('/recruitment/jobs', { preHandler: guard('recruitment.jobs.view'), schema: { querystring: query({ status: v.enum(['draft', 'open', 'on_hold', 'closed']) }) } }, async (request) => {
    const values = [request.ctx.orgId];
    let where = 'j.org_id = $1';
    if (request.query.status) { values.push(request.query.status); where += ` AND j.status = $${values.length}`; }
    if (request.query.q) { values.push(`%${request.query.q}%`); where += ` AND j.title ILIKE $${values.length}`; }
    const rows = await db.rows(
      `SELECT j.*, d.name AS department_name,
              count(c.id)::int AS candidate_count,
              count(c.id) FILTER (WHERE c.stage NOT IN ('hired', 'rejected'))::int AS active_count,
              count(c.id) FILTER (WHERE c.stage = 'hired')::int AS hired_count,
              count(c.id) FILTER (WHERE c.created_at >= now() - interval '7 days')::int AS new_count
         FROM jobs j
         LEFT JOIN departments d ON d.id = j.department_id
         LEFT JOIN candidates c ON c.org_id = j.org_id AND c.job_id = j.id
        WHERE ${where}
        GROUP BY j.id, d.name
        ORDER BY CASE j.status WHEN 'open' THEN 0 WHEN 'on_hold' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END, j.created_at DESC`,
      values,
    );
    return { data: rows };
  });

  app.post('/recruitment/jobs', { preHandler: guard('recruitment.jobs.manage'), schema: { body: body(jobFields, ['title']) } }, async (request, reply) => {
    const { orgId, userId } = request.ctx;
    const b = request.body;
    if (!b.title.trim()) throw badRequest('Give the opening a title.');
    await assertDepartment(orgId, b.department_id);
    if (b.hiring_manager_id) await assertMember(orgId, b.hiring_manager_id, 'recruitment.candidates.view');
    const row = await db.one(
      `INSERT INTO jobs (id, org_id, title, department_id, location, employment_type, openings, status, is_public,
                         description, salary_range, closes_on, hiring_manager_id, created_by)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,'full_time'),COALESCE($7,1),COALESCE($8,'draft'),COALESCE($9,true),$10,$11,$12,$13,$14) RETURNING *`,
      [id('job'), orgId, b.title.trim(), b.department_id ?? null, b.location ?? null, b.employment_type ?? null,
        b.openings ?? null, b.status ?? null, b.is_public ?? null, b.description ?? '', b.salary_range ?? null,
        b.closes_on ?? null, b.hiring_manager_id ?? null, userId],
    );
    return reply.status(201).send({ data: row });
  });

  app.patch('/recruitment/jobs/:jobId', { preHandler: guard('recruitment.jobs.manage'), schema: { ...jobParams, body: body(jobFields) } }, async (request) => {
    const { orgId } = request.ctx;
    const old = await job(db, orgId, request.params.jobId);
    const b = request.body;
    if (b.title !== undefined && !b.title.trim()) throw badRequest('Give the opening a title.');
    if (b.department_id) await assertDepartment(orgId, b.department_id);
    if (b.hiring_manager_id) await assertMember(orgId, b.hiring_manager_id, 'recruitment.candidates.view');
    const next = { ...old, ...b };
    const row = await db.one(
      `UPDATE jobs SET title = $3, department_id = $4, location = $5, employment_type = $6, openings = $7, status = $8,
              is_public = $9, description = $10, salary_range = $11, closes_on = $12, hiring_manager_id = $13, updated_at = now()
        WHERE org_id = $1 AND id = $2 RETURNING *`,
      [orgId, old.id, next.title.trim(), next.department_id, next.location, next.employment_type, next.openings, next.status,
        next.is_public, next.description, next.salary_range, next.closes_on, next.hiring_manager_id],
    );
    return { data: row };
  });

  app.delete('/recruitment/jobs/:jobId', { preHandler: guard('recruitment.jobs.manage'), schema: jobParams }, async (request) => {
    const { orgId } = request.ctx;
    const hired = await db.one(`SELECT 1 FROM candidates WHERE org_id = $1 AND job_id = $2 AND stage = 'hired' LIMIT 1`, [orgId, request.params.jobId]);
    if (hired) throw badRequest('Someone was hired through this opening. Close it instead of deleting it.');
    const row = await db.one(`DELETE FROM jobs WHERE org_id = $1 AND id = $2 RETURNING id`, [orgId, request.params.jobId]);
    if (!row) throw notFound('Job');
    return { data: { deleted: true } };
  });

  // ═══════════════════════════════════════════════════════════════ CANDIDATES
  app.get(
    '/recruitment/candidates',
    { preHandler: guard('recruitment.candidates.view'), schema: { querystring: query({ job_id: v.id('job'), stage: v.enum(STAGES), source: v.enum(SOURCES) }) } },
    async (request) => {
      const qs = request.query;
      const page = paginate({ ...qs, limit: qs.limit ?? 100, allowedSorts: ['created_at', 'stage_changed_at', 'rating'] });
      const values = [request.ctx.orgId];
      const where = ['c.org_id = $1'];
      for (const key of ['job_id', 'stage', 'source']) {
        if (qs[key]) { values.push(qs[key]); where.push(`c.${key} = $${values.length}`); }
      }
      if (qs.q) {
        values.push(`%${qs.q}%`);
        where.push(`(c.first_name ILIKE $${values.length} OR c.last_name ILIKE $${values.length} OR c.email ILIKE $${values.length} OR c.phone ILIKE $${values.length})`);
      }
      const clause = where.join(' AND ');
      const [rows, total, counts] = await Promise.all([
        db.rows(
          `SELECT c.id, c.job_id, j.title AS job_title, c.first_name, c.last_name, c.email, c.phone, c.source, c.stage,
                  c.rating, c.current_company, c.experience_years, c.owner_id, c.offer_status, c.employee_id,
                  c.stage_changed_at, c.created_at,
                  (SELECT min(i.scheduled_at) FROM interviews i WHERE i.org_id = c.org_id AND i.candidate_id = c.id
                     AND i.status = 'scheduled' AND i.scheduled_at >= now()) AS next_interview_at
             FROM candidates c JOIN jobs j ON j.org_id = c.org_id AND j.id = c.job_id
            WHERE ${clause} ORDER BY c.${page.orderBy} LIMIT ${page.limit} OFFSET ${page.offset}`,
          values,
        ),
        db.one(`SELECT count(*)::int AS n FROM candidates c WHERE ${clause}`, values),
        db.rows(`SELECT stage, count(*)::int AS n FROM candidates c WHERE ${clause} GROUP BY stage`, values),
      ]);
      return { data: rows, meta: { ...page.meta(total.n), stages: Object.fromEntries(counts.map((r) => [r.stage, r.n])) } };
    },
  );

  const candidateFields = {
    job_id: v.id('job'),
    first_name: v.text(80, 1),
    last_name: nullable(v.text(80)),
    email: nullable(v.email),
    phone: nullable(v.text(32)),
    source: v.enum(SOURCES),
    rating: nullable(v.int(1, 5)),
    current_company: nullable(v.text(120)),
    experience_years: nullable({ type: 'number', minimum: 0, maximum: 60 }),
    resume_url: nullable({ type: 'string', format: 'uri', maxLength: 1000 }),
    cover_note: nullable(v.text(5000)),
    owner_id: nullable(v.id('usr')),
  };

  app.post('/recruitment/candidates', { preHandler: guard('recruitment.candidates.edit'), schema: { body: body(candidateFields, ['job_id', 'first_name']) } }, async (request, reply) => {
    const { orgId, userId } = request.ctx;
    const b = request.body;
    const opening = await job(db, orgId, b.job_id);
    if (opening.status === 'closed') throw badRequest('That opening is closed.');
    if (b.owner_id) await assertMember(orgId, b.owner_id, 'recruitment.candidates.view');
    try {
      const row = await db.transaction(async (tx) => {
        const created = await tx.one(
          `INSERT INTO candidates (id, org_id, job_id, first_name, last_name, email, phone, source, rating, current_company,
                                   experience_years, resume_url, cover_note, owner_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,'manual'),$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
          [id('cand'), orgId, opening.id, b.first_name.trim(), b.last_name ?? null, b.email?.toLowerCase() ?? null, b.phone ?? null,
            b.source ?? null, b.rating ?? null, b.current_company ?? null, b.experience_years ?? null, b.resume_url ?? null,
            b.cover_note ?? null, b.owner_id ?? null, userId],
        );
        await timeline(tx, created, userId, `Added to ${opening.title}`);
        tx.emit({ type: EVENTS.CANDIDATE_APPLIED, org_id: orgId, actor_id: userId, data: { candidate_id: created.id, name: fullName(created), job_id: opening.id, job_title: opening.title, source: created.source } });
        return created;
      });
      return reply.status(201).send({ data: row });
    } catch (error) {
      if (error.name === 'UniqueViolation') throw conflict('This person has already applied for that opening.');
      throw error;
    }
  });

  app.get('/recruitment/candidates/:candidateId', { preHandler: guard('recruitment.candidates.view'), schema: candidateParams }, async (request) => {
    const c = await candidate(db, request.ctx.orgId, request.params.candidateId);
    const [interviews, notes] = await Promise.all([
      db.rows(`SELECT * FROM interviews WHERE org_id = $1 AND candidate_id = $2 ORDER BY scheduled_at DESC`, [c.org_id, c.id]),
      db.rows(`SELECT * FROM candidate_notes WHERE org_id = $1 AND candidate_id = $2 ORDER BY created_at DESC`, [c.org_id, c.id]),
    ]);
    // Offer money is for people who handle offers.
    const offer = request.ctx.can('recruitment.offers.view')
      ? { offer_ctc_paise: c.offer_ctc_paise, offer_joining_on: c.offer_joining_on, offer_status: c.offer_status }
      : { offer_ctc_paise: null, offer_joining_on: null, offer_status: c.offer_status };
    return { data: { ...c, ...offer, interviews, notes } };
  });

  app.patch(
    '/recruitment/candidates/:candidateId',
    { preHandler: guard('recruitment.candidates.edit'), schema: { ...candidateParams, body: body({ ...candidateFields }) } },
    async (request) => {
      const { orgId, userId } = request.ctx;
      const b = request.body;
      if (b.owner_id) await assertMember(orgId, b.owner_id, 'recruitment.candidates.view');
      if (b.job_id) await job(db, orgId, b.job_id);
      try {
        const row = await db.transaction(async (tx) => {
          const old = await candidate(tx, orgId, request.params.candidateId, true);
          const next = { ...old, ...b };
          const updated = await tx.one(
            `UPDATE candidates SET job_id = $3, first_name = $4, last_name = $5, email = $6, phone = $7, source = $8, rating = $9,
                    current_company = $10, experience_years = $11, resume_url = $12, cover_note = $13, owner_id = $14, updated_at = now()
              WHERE org_id = $1 AND id = $2 RETURNING *`,
            [orgId, old.id, next.job_id, next.first_name.trim(), next.last_name, next.email?.toLowerCase() ?? null, next.phone, next.source,
              next.rating, next.current_company, next.experience_years, next.resume_url, next.cover_note, next.owner_id],
          );
          if (updated.job_id !== old.job_id) await timeline(tx, updated, userId, 'Moved to another opening');
          return updated;
        });
        return { data: row };
      } catch (error) {
        if (error.name === 'UniqueViolation') throw conflict('This person has already applied for that opening.');
        throw error;
      }
    },
  );

  app.post(
    '/recruitment/candidates/:candidateId/stage',
    {
      preHandler: guard('recruitment.candidates.advance'),
      schema: { ...candidateParams, body: body({ stage: v.enum(STAGES.filter((s) => s !== 'hired')), reason: v.text(500) }, ['stage']) },
    },
    async (request) => {
      const { orgId, userId } = request.ctx;
      const row = await db.transaction(async (tx) => {
        const old = await candidate(tx, orgId, request.params.candidateId, true);
        if (old.stage === 'hired') throw badRequest('This candidate has already been hired.');
        if (request.body.stage === 'rejected' && !request.body.reason?.trim()) throw badRequest('Say why the candidate is being rejected.');
        if (old.stage === request.body.stage) return old;
        const updated = await tx.one(
          `UPDATE candidates SET stage = $3, stage_changed_at = now(), updated_at = now(),
                  rejected_reason = CASE WHEN $3 = 'rejected' THEN $4 ELSE NULL END
            WHERE org_id = $1 AND id = $2 RETURNING *`,
          [orgId, old.id, request.body.stage, request.body.reason?.trim() ?? null],
        );
        await timeline(tx, updated, userId, `${STAGE_LABEL[old.stage]} → ${STAGE_LABEL[updated.stage]}${updated.rejected_reason ? `: ${updated.rejected_reason}` : ''}`);
        tx.emit({ type: EVENTS.CANDIDATE_STAGE_CHANGED, org_id: orgId, actor_id: userId, data: { candidate_id: updated.id, name: fullName(updated), from: old.stage, to: updated.stage, owner_id: updated.owner_id, job_title: old.job_title } });
        return updated;
      });
      return { data: row };
    },
  );

  app.post(
    '/recruitment/candidates/:candidateId/notes',
    { preHandler: guard('recruitment.candidates.edit'), schema: { ...candidateParams, body: body({ body: v.text(5000, 1) }, ['body']) } },
    async (request, reply) => {
      const c = await candidate(db, request.ctx.orgId, request.params.candidateId);
      if (!request.body.body.trim()) throw badRequest('Write a note first.');
      const row = await db.one(
        `INSERT INTO candidate_notes (id, org_id, candidate_id, kind, body, author_id) VALUES ($1, $2, $3, 'note', $4, $5) RETURNING *`,
        [id('cnote'), c.org_id, c.id, request.body.body.trim(), request.ctx.userId],
      );
      return reply.status(201).send({ data: row });
    },
  );

  app.delete('/recruitment/candidates/:candidateId', { preHandler: guard('recruitment.candidates.edit'), schema: candidateParams }, async (request) => {
    const c = await candidate(db, request.ctx.orgId, request.params.candidateId);
    if (c.stage === 'hired') throw badRequest('A hired candidate is part of the employee record and cannot be deleted.');
    await db.query(`DELETE FROM candidates WHERE org_id = $1 AND id = $2`, [c.org_id, c.id]);
    return { data: { deleted: true } };
  });

  // ═══════════════════════════════════════════════════════════════ INTERVIEWS
  const interviewFields = {
    scheduled_at: v.datetime,
    duration_minutes: v.int(5, 480),
    mode: v.enum(['in_person', 'phone', 'video']),
    location: nullable(v.text(500)),
    interviewer_id: v.id('usr'),
  };

  app.get(
    '/recruitment/interviews',
    { preHandler: guard('recruitment.candidates.view'), schema: { querystring: query({ mine: v.bool, status: v.enum(['scheduled', 'completed', 'cancelled', 'no_show']), from: v.date }) } },
    async (request) => {
      const values = [request.ctx.orgId];
      const where = ['i.org_id = $1'];
      if (request.query.mine) { values.push(request.ctx.userId); where.push(`i.interviewer_id = $${values.length}`); }
      if (request.query.status) { values.push(request.query.status); where.push(`i.status = $${values.length}`); }
      if (request.query.from) { values.push(request.query.from); where.push(`i.scheduled_at >= $${values.length}::date`); }
      const rows = await db.rows(
        `SELECT i.*, c.first_name, c.last_name, c.stage, j.title AS job_title
           FROM interviews i JOIN candidates c ON c.org_id = i.org_id AND c.id = i.candidate_id
           JOIN jobs j ON j.org_id = c.org_id AND j.id = c.job_id
          WHERE ${where.join(' AND ')} ORDER BY i.scheduled_at LIMIT 200`,
        values,
      );
      return { data: rows };
    },
  );

  app.post(
    '/recruitment/candidates/:candidateId/interviews',
    { preHandler: guard('recruitment.candidates.edit'), schema: { ...candidateParams, body: body(interviewFields, ['scheduled_at', 'interviewer_id']) } },
    async (request, reply) => {
      const { orgId, userId } = request.ctx;
      const b = request.body;
      await assertMember(orgId, b.interviewer_id, 'recruitment.candidates.view');
      const row = await db.transaction(async (tx) => {
        const c = await candidate(tx, orgId, request.params.candidateId, true);
        if (['hired', 'rejected'].includes(c.stage)) throw badRequest(`This candidate is ${c.stage}.`);
        const created = await tx.one(
          `INSERT INTO interviews (id, org_id, candidate_id, scheduled_at, duration_minutes, mode, location, interviewer_id, created_by)
           VALUES ($1,$2,$3,$4,COALESCE($5,30),COALESCE($6,'video'),$7,$8,$9) RETURNING *`,
          [id('intv'), orgId, c.id, b.scheduled_at, b.duration_minutes ?? null, b.mode ?? null, b.location ?? null, b.interviewer_id, userId],
        );
        // Scheduling an interview is what moves someone into the interview stage.
        if (['applied', 'screening'].includes(c.stage)) {
          await tx.query(`UPDATE candidates SET stage = 'interview', stage_changed_at = now(), updated_at = now() WHERE org_id = $1 AND id = $2`, [orgId, c.id]);
          await timeline(tx, c, userId, `${STAGE_LABEL[c.stage]} → Interview`);
        }
        await timeline(tx, c, userId, `Interview scheduled for ${new Date(created.scheduled_at).toISOString()}`);
        tx.emit({ type: EVENTS.INTERVIEW_SCHEDULED, org_id: orgId, actor_id: userId, data: { interview_id: created.id, candidate_id: c.id, name: fullName(c), job_title: c.job_title, interviewer_id: created.interviewer_id, scheduled_at: created.scheduled_at, mode: created.mode } });
        return created;
      });
      return reply.status(201).send({ data: row });
    },
  );

  app.patch(
    '/recruitment/interviews/:interviewId',
    {
      preHandler: guard('recruitment.candidates.view'),
      schema: {
        params: params({ interviewId: v.id('intv') }),
        body: body({
          ...interviewFields, status: v.enum(['scheduled', 'completed', 'cancelled', 'no_show']),
          rating: nullable(v.int(1, 5)), recommendation: nullable(v.enum(['strong_yes', 'yes', 'no', 'strong_no'])), feedback: nullable(v.text(10_000)),
        }),
      },
    },
    async (request) => {
      const { orgId, userId } = request.ctx;
      const old = await db.one(`SELECT * FROM interviews WHERE org_id = $1 AND id = $2`, [orgId, request.params.interviewId]);
      if (!old) throw notFound('Interview');
      // The interviewer records their own feedback; rescheduling needs edit rights.
      const isInterviewer = old.interviewer_id === userId;
      const touchesSchedule = ['scheduled_at', 'duration_minutes', 'mode', 'location', 'interviewer_id'].some((k) => request.body[k] !== undefined);
      if (!isInterviewer || touchesSchedule) request.ctx.assert('recruitment.candidates.edit');
      if (request.body.interviewer_id) await assertMember(orgId, request.body.interviewer_id, 'recruitment.candidates.view');
      const next = { ...old, ...request.body };
      if (next.status === 'completed' && !next.feedback?.trim()) throw badRequest('Add feedback to complete the interview.');
      const row = await db.one(
        `UPDATE interviews SET scheduled_at = $3, duration_minutes = $4, mode = $5, location = $6, interviewer_id = $7,
                status = $8, rating = $9, recommendation = $10, feedback = $11, updated_at = now()
          WHERE org_id = $1 AND id = $2 RETURNING *`,
        [orgId, old.id, next.scheduled_at, next.duration_minutes, next.mode, next.location, next.interviewer_id,
          next.status, next.rating, next.recommendation, next.feedback],
      );
      return { data: row };
    },
  );

  // ═══════════════════════════════════════════════════════════════════ OFFERS
  app.put(
    '/recruitment/candidates/:candidateId/offer',
    {
      preHandler: guard('recruitment.offers.view'),
      schema: {
        ...candidateParams,
        body: body({ ctc_annual: { type: 'number', exclusiveMinimum: 0, maximum: 1e9 }, joining_on: v.date, status: v.enum(['proposed', 'approved', 'accepted', 'declined']) }, ['status']),
      },
    },
    async (request) => {
      const { orgId, userId } = request.ctx;
      const b = request.body;
      // Anyone who handles offers may propose one and record the answer;
      // approving the money is its own permission.
      if (b.status === 'approved') request.ctx.assert('recruitment.offers.approve');
      const row = await db.transaction(async (tx) => {
        const c = await candidate(tx, orgId, request.params.candidateId, true);
        if (['hired', 'rejected'].includes(c.stage)) throw badRequest(`This candidate is ${c.stage}.`);
        const ctc = b.ctc_annual !== undefined ? Math.round(b.ctc_annual * 100) : c.offer_ctc_paise;
        if (!ctc) throw badRequest('Enter the annual CTC for the offer.');
        if (b.status === 'accepted' && !['approved', 'accepted'].includes(c.offer_status)) {
          throw badRequest('The offer must be approved before it can be accepted.');
        }
        const changedTerms = c.offer_status && ((b.ctc_annual !== undefined && ctc !== Number(c.offer_ctc_paise))
          || (b.joining_on && b.joining_on !== c.offer_joining_on));
        // New pay or a new joining date goes back through approval.
        if (changedTerms && !['proposed', 'approved'].includes(b.status)) {
          throw badRequest('The offer terms changed. Propose them again, or approve them, before recording an answer.');
        }
        const status = b.status;
        const updated = await tx.one(
          `UPDATE candidates SET offer_ctc_paise = $3, offer_joining_on = COALESCE($4::date, offer_joining_on), offer_status = $5,
                  offer_approved_by = CASE WHEN $5 = 'approved' THEN $6 ELSE offer_approved_by END,
                  stage = CASE WHEN stage IN ('applied','screening','interview') THEN 'offer' ELSE stage END,
                  stage_changed_at = CASE WHEN stage IN ('applied','screening','interview') THEN now() ELSE stage_changed_at END,
                  updated_at = now()
            WHERE org_id = $1 AND id = $2 RETURNING *`,
          [orgId, c.id, ctc, b.joining_on ?? null, status, userId],
        );
        await timeline(tx, updated, userId, `Offer ${status}${b.joining_on ? ` · joining ${b.joining_on}` : ''}`);
        return updated;
      });
      return { data: row };
    },
  );

  // ═════════════════════════════════════════════════════════════════════ HIRE
  app.post(
    '/recruitment/candidates/:candidateId/hire',
    {
      preHandler: [...guard('recruitment.candidates.advance'), requirePermission('hr.employees.create')],
      schema: {
        ...candidateParams,
        body: body({
          joined_on: v.date, department_id: nullable(v.id('dep')), designation: nullable(v.text(120)),
          email: nullable(v.email), employment_type: v.enum(EMPLOYMENT), status: v.enum(['active', 'on_probation']),
        }),
      },
    },
    async (request) => {
      const { orgId, userId } = request.ctx;
      const b = request.body;
      if (b.department_id) await assertDepartment(orgId, b.department_id);
      await ensureLeaveTypes(db, orgId);
      const result = await db.transaction(async (tx) => {
        const c = await candidate(tx, orgId, request.params.candidateId, true);
        if (c.stage === 'hired') throw conflict('This candidate has already been hired.', { employee_id: c.employee_id });
        if (c.offer_status === 'declined') throw badRequest('The offer was declined.');
        if (c.offer_status && c.offer_status !== 'accepted') throw badRequest('Record the offer as accepted before hiring.');
        const workEmail = b.email ?? null;
        if (workEmail) {
          const clash = await tx.one(`SELECT id FROM employees WHERE org_id = $1 AND lower(email) = lower($2) AND archived_at IS NULL`, [orgId, workEmail]);
          if (clash) throw conflict('An employee already uses that work email.', { employee_id: clash.id });
        }
        const employee = await insertEmployee(tx, {
          orgId,
          userId,
          fields: {
            first_name: c.first_name,
            last_name: c.last_name,
            email: workEmail,
            personal_email: c.email,
            phone: c.phone,
            department_id: b.department_id ?? c.job_department_id,
            designation: b.designation ?? c.job_title,
            employment_type: b.employment_type ?? c.job_employment_type,
            status: b.status ?? 'on_probation',
            work_location: c.job_location,
            joined_on: b.joined_on ?? c.offer_joining_on ?? null,
            notes: `Hired through Recruitment for “${c.job_title}”.`,
          },
        });
        const hired = await tx.one(
          `UPDATE candidates SET stage = 'hired', employee_id = $3, stage_changed_at = now(), updated_at = now()
            WHERE org_id = $1 AND id = $2 RETURNING *`,
          [orgId, c.id, employee.id],
        );
        await timeline(tx, hired, userId, `Hired — employee ${employee.employee_code}`);
        tx.emit({ type: EVENTS.CANDIDATE_HIRED, org_id: orgId, actor_id: userId, data: { candidate_id: c.id, employee_id: employee.id, name: fullName(c), job_title: c.job_title } });
        // Enough hires fill the opening.
        await tx.query(
          `UPDATE jobs SET status = 'closed', updated_at = now()
            WHERE org_id = $1 AND id = $2 AND status = 'open'
              AND (SELECT count(*) FROM candidates WHERE org_id = $1 AND job_id = $2 AND stage = 'hired') >= openings`,
          [orgId, c.job_id],
        );
        return { candidate: hired, employee };
      });
      return { data: { candidate: result.candidate, employee: { id: result.employee.id, employee_code: result.employee.employee_code } } };
    },
  );

  // ═══════════════════════════════════════════════════════════ OVERVIEW/WIDGET
  app.get('/recruitment/widgets', { preHandler: guard('recruitment.jobs.view') }, async (request) => {
    const row = await db.one(
      `SELECT (SELECT count(*) FROM jobs WHERE org_id = $1 AND status = 'open')::int AS open_roles,
              (SELECT count(*) FROM candidates WHERE org_id = $1 AND created_at >= now() - interval '7 days')::int AS new_candidates`,
      [request.ctx.orgId],
    );
    return { data: { 'recruitment.open_roles': row.open_roles, 'recruitment.new_candidates': row.new_candidates } };
  });

  // ═══════════════════════════════════════════════════════ PUBLIC CAREERS PAGE
  /**
   * No account, no token: anyone can read a workspace's open, public roles
   * and apply. The workspace is named by its address (slug), resolved through
   * tenancy; only open + public jobs exist here, and applying is throttled.
   */
  async function workspaceBySlug(slug) {
    const response = await fetch(`${config.tenancyUrl}/workspace-lookup/${encodeURIComponent(slug)}`, { signal: AbortSignal.timeout(8000) });
    if (response.status === 404) throw notFound('Careers page');
    if (!response.ok) throw app.httpErrors.serviceUnavailable('Try again in a moment.');
    return (await response.json()).data;
  }
  const slugParam = { type: 'string', pattern: '^[a-z0-9-]{1,64}$' };

  app.get('/careers/:slug', { schema: { params: { type: 'object', properties: { slug: slugParam }, required: ['slug'] } } }, async (request) => {
    const org = await workspaceBySlug(request.params.slug);
    const jobs = await db.rows(
      `SELECT j.id, j.title, j.location, j.employment_type, j.openings, j.salary_range, j.closes_on,
              left(j.description, 400) AS summary, d.name AS department_name, j.created_at
         FROM jobs j LEFT JOIN departments d ON d.id = j.department_id
        WHERE j.org_id = $1 AND j.status = 'open' AND j.is_public AND (j.closes_on IS NULL OR j.closes_on >= current_date)
        ORDER BY j.created_at DESC`,
      [org.id],
    );
    return { data: { organization: { name: org.name, slug: org.slug, logo_url: org.logo_url }, jobs } };
  });

  app.get('/careers/:slug/jobs/:jobId', { schema: { params: { type: 'object', properties: { slug: slugParam, jobId: v.id('job') }, required: ['slug', 'jobId'] } } }, async (request) => {
    const org = await workspaceBySlug(request.params.slug);
    const row = await db.one(
      `SELECT j.id, j.title, j.location, j.employment_type, j.openings, j.salary_range, j.closes_on, j.description,
              d.name AS department_name
         FROM jobs j LEFT JOIN departments d ON d.id = j.department_id
        WHERE j.org_id = $1 AND j.id = $2 AND j.status = 'open' AND j.is_public`,
      [org.id, request.params.jobId],
    );
    if (!row) throw notFound('Job');
    return { data: { organization: { name: org.name, slug: org.slug, logo_url: org.logo_url }, job: row } };
  });

  app.post(
    '/careers/:slug/jobs/:jobId/apply',
    {
      schema: {
        params: { type: 'object', properties: { slug: slugParam, jobId: v.id('job') }, required: ['slug', 'jobId'] },
        body: body({
          first_name: v.text(80, 1), last_name: v.text(80, 0), email: v.email, phone: v.text(32, 6),
          current_company: v.text(120, 0), experience_years: { type: 'number', minimum: 0, maximum: 60 },
          resume_url: { type: 'string', format: 'uri', maxLength: 1000 }, cover_note: v.text(5000, 0),
          // A field people never see: anything that fills it is a bot.
          website: v.text(200, 0),
        }, ['first_name', 'email', 'phone']),
      },
    },
    async (request, reply) => {
      const b = request.body;
      if (b.website) return reply.status(201).send({ data: { received: true } });
      const org = await workspaceBySlug(request.params.slug);
      const opening = await db.one(
        `SELECT * FROM jobs WHERE org_id = $1 AND id = $2 AND status = 'open' AND is_public AND (closes_on IS NULL OR closes_on >= current_date)`,
        [org.id, request.params.jobId],
      );
      if (!opening) throw notFound('Job');

      const ipHash = createHash('sha256').update(`${request.ip}:${config.serviceToken}`).digest('hex').slice(0, 32);
      const recent = await db.one(
        `SELECT count(*)::int AS n FROM candidates WHERE org_id = $1 AND applied_ip_hash = $2 AND created_at > now() - interval '10 minutes'`,
        [org.id, ipHash],
      );
      if (recent.n >= 5) throw new ApiError(429, 'rate_limited', 'Too many applications from this connection. Try again later.');

      const existing = await db.one(
        `SELECT id FROM candidates WHERE org_id = $1 AND job_id = $2 AND lower(email) = lower($3)`,
        [org.id, opening.id, b.email],
      );
      // Applying twice is not an error for the applicant; it is simply already done.
      if (existing) return reply.status(201).send({ data: { received: true } });

      await db.transaction(async (tx) => {
        const created = await tx.one(
          `INSERT INTO candidates (id, org_id, job_id, first_name, last_name, email, phone, source, current_company,
                                   experience_years, resume_url, cover_note, applied_ip_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'careers_page',$8,$9,$10,$11,$12) RETURNING *`,
          [id('cand'), org.id, opening.id, b.first_name.trim(), b.last_name?.trim() || null, b.email.toLowerCase(), b.phone.trim(),
            b.current_company?.trim() || null, b.experience_years ?? null, b.resume_url ?? null, b.cover_note?.trim() || null, ipHash],
        );
        await timeline(tx, created, null, `Applied through the careers page for ${opening.title}`);
        tx.emit({ type: EVENTS.CANDIDATE_APPLIED, org_id: org.id, actor_id: null, data: { candidate_id: created.id, name: fullName(created), job_id: opening.id, job_title: opening.title, source: 'careers_page', hiring_manager_id: opening.hiring_manager_id } });
      });
      return reply.status(201).send({ data: { received: true } });
    },
  );
}
