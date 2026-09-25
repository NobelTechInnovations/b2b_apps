import { id, paginate } from '@nexus/db-kit';
import { EVENTS } from '@nexus/contracts/events';
import {
  requirePermission, body, params, query, validate as v, notFound, badRequest, conflict,
} from '@nexus/service-kit';
import {
  ensureLetterTemplates, renderLetter, letterContext, nextLetterReference,
} from '../lib/letters.js';

const KINDS = [
  'offer', 'appointment', 'confirmation', 'increment', 'promotion',
  'experience', 'relieving', 'warning', 'noc', 'id_proof', 'certificate',
  'contract', 'custom',
];

export async function employeeDocumentRoutes(app) {
  const { db, workspace } = app;

  // ═════════════════════════════════════════════════════════════ TEMPLATES
  app.get(
    '/hr/letter-templates',
    { preHandler: [app.loadContext, requirePermission('hr.documents.view')] },
    async (request) => {
      const { orgId } = request.ctx;
      await ensureLetterTemplates(db, orgId);

      const rows = await db.rows(
        `SELECT t.*,
                (SELECT count(*)::int FROM employee_documents d WHERE d.template_id = t.id) AS issued_count
           FROM letter_templates t
          WHERE t.org_id = $1 AND t.archived_at IS NULL
          ORDER BY t.kind, t.name`,
        [orgId],
      );

      return { data: rows };
    },
  );

  app.post(
    '/hr/letter-templates',
    {
      preHandler: [app.loadContext, requirePermission('hr.documents.manage')],
      schema: {
        body: body(
          {
            name: v.text(120, 1),
            kind: v.enum(KINDS),
            subject: v.text(200),
            body: { type: 'string', minLength: 1, maxLength: 40_000 },
            is_default: v.bool,
          },
          ['name', 'body'],
        ),
      },
    },
    async (request, reply) => {
      const { orgId, userId } = request.ctx;
      const b = request.body;
      await ensureLetterTemplates(db, orgId);

      const clash = await db.one(
        `SELECT id FROM letter_templates WHERE org_id = $1 AND lower(name) = lower($2) AND archived_at IS NULL`,
        [orgId, b.name.trim()],
      );
      if (clash) throw conflict('A template with that name already exists.');

      const kind = b.kind ?? 'custom';

      const row = await db.transaction(async (tx) => {
        if (b.is_default) {
          await tx.query(
            `UPDATE letter_templates SET is_default = false
              WHERE org_id = $1 AND kind = $2 AND is_default`,
            [orgId, kind],
          );
        }
        return tx.one(
          `INSERT INTO letter_templates (id, org_id, name, kind, subject, body, is_default, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [id('ltp'), orgId, b.name.trim(), kind, b.subject ?? null, b.body, b.is_default ?? false, userId],
        );
      });

      return reply.status(201).send({ data: { ...row, issued_count: 0 } });
    },
  );

  app.patch(
    '/hr/letter-templates/:templateId',
    {
      preHandler: [app.loadContext, requirePermission('hr.documents.manage')],
      schema: {
        params: params({ templateId: v.id('ltp') }),
        body: body({
          name: v.text(120, 1), subject: v.text(200),
          body: { type: 'string', minLength: 1, maxLength: 40_000 },
          is_default: v.bool,
        }),
      },
    },
    async (request) => {
      const fields = Object.keys(request.body);
      if (!fields.length) throw badRequest('Nothing to update.');

      const sets = fields.map((f, i) => `${f} = $${i + 3}`).join(', ');
      const row = await db.one(
        `UPDATE letter_templates SET ${sets}
          WHERE id = $1 AND org_id = $2 AND archived_at IS NULL RETURNING *`,
        [request.params.templateId, request.ctx.orgId, ...fields.map((f) => request.body[f])],
      );
      if (!row) throw notFound('Template');

      // Already-issued letters keep the words they were issued with; only the
      // next one uses the new wording.
      return { data: row };
    },
  );

  app.delete(
    '/hr/letter-templates/:templateId',
    {
      preHandler: [app.loadContext, requirePermission('hr.documents.manage')],
      schema: { params: params({ templateId: v.id('ltp') }) },
    },
    async (request) => {
      const row = await db.one(
        `UPDATE letter_templates SET archived_at = now()
          WHERE id = $1 AND org_id = $2 AND archived_at IS NULL RETURNING id`,
        [request.params.templateId, request.ctx.orgId],
      );
      if (!row) throw notFound('Template');
      return { data: { archived: true } };
    },
  );

  // ═══════════════════════════════════════════════════════════════ PREVIEW
  /**
   * What the letter would say, without creating anything.
   *
   * Filled from the employee record and their salary, so the figures in an
   * offer letter are the figures payroll will actually pay.
   */
  app.post(
    '/hr/employee-documents/preview',
    {
      preHandler: [app.loadContext, requirePermission('hr.documents.view')],
      schema: {
        body: body(
          {
            employee_id: v.id('emp'),
            template_id: v.id('ltp'),
            body: { type: 'string', maxLength: 40_000 },
            valid_until: v.date,
          },
          ['employee_id'],
        ),
      },
    },
    async (request) => {
      const { orgId, email } = request.ctx;
      const context = await buildContext(db, {
        orgId, employeeId: request.body.employee_id,
        issuedBy: email, validUntil: request.body.valid_until, workspace,
      });

      const template = request.body.template_id
        ? await db.one(
            `SELECT * FROM letter_templates WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
            [request.body.template_id, orgId],
          )
        : null;

      const source = request.body.body ?? template?.body;
      if (!source) throw badRequest('Give a template or a body to render.');

      return {
        data: {
          subject: template?.subject ? renderLetter(template.subject, context) : null,
          body: renderLetter(source, context),
          // Returned so the editor can show what a placeholder resolves to.
          context,
        },
      };
    },
  );

  // ═══════════════════════════════════════════════════════════════ ISSUE
  app.get(
    '/hr/employee-documents',
    {
      preHandler: [app.loadContext, requirePermission('hr.documents.view')],
      schema: {
        querystring: query({
          employee_id: v.id('emp'),
          kind: v.enum(KINDS),
          status: v.enum(['draft', 'issued', 'acknowledged', 'revoked']),
        }),
      },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const page = paginate({ ...request.query, allowedSorts: ['created_at', 'issued_on'] });
      const qs = request.query;

      const where = ['d.org_id = $1'];
      const values = [orgId];
      if (qs.employee_id) { values.push(qs.employee_id); where.push(`d.employee_id = $${values.length}`); }
      if (qs.kind) { values.push(qs.kind); where.push(`d.kind = $${values.length}`); }
      if (qs.status) { values.push(qs.status); where.push(`d.status = $${values.length}`); }
      if (qs.q) {
        values.push(`%${qs.q}%`);
        where.push(`(d.title ILIKE $${values.length} OR d.reference ILIKE $${values.length}
                     OR e.first_name ILIKE $${values.length} OR e.employee_code ILIKE $${values.length})`);
      }

      const clause = where.join(' AND ');
      const join = `FROM employee_documents d JOIN employees e ON e.id = d.employee_id`;

      const [rows, total] = await Promise.all([
        db.rows(
          `SELECT d.id, d.employee_id, d.kind, d.title, d.reference, d.status,
                  d.issued_on, d.valid_until, d.visible_to_employee,
                  d.requires_acknowledgement, d.acknowledged_at, d.file_name,
                  (d.body IS NOT NULL) AS has_letter,
                  e.first_name, e.last_name, e.employee_code, e.designation ${join}
            WHERE ${clause} ORDER BY d.${page.orderBy} LIMIT ${page.limit} OFFSET ${page.offset}`,
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

  app.get(
    '/hr/employee-documents/:documentId',
    {
      preHandler: [app.loadContext, requirePermission('hr.documents.view')],
      schema: { params: params({ documentId: v.id('edo') }) },
    },
    async (request) => {
      const row = await db.one(
        `SELECT d.*, e.first_name, e.last_name, e.employee_code, e.designation,
                dep.name AS department_name
           FROM employee_documents d
           JOIN employees e ON e.id = d.employee_id
           LEFT JOIN departments dep ON dep.id = e.department_id
          WHERE d.id = $1 AND d.org_id = $2`,
        [request.params.documentId, request.ctx.orgId],
      );
      if (!row) throw notFound('Document');

      const org = await workspace.forOrg(request.ctx.orgId);

      return {
        data: {
          ...row,
          name: [row.first_name, row.last_name].filter(Boolean).join(' '),
          employer: { name: org.name, address: org.address },
        },
      };
    },
  );

  /**
   * Issue a letter.
   *
   * The rendered body is stored, not the template reference alone — editing
   * the template afterwards must not silently rewrite a letter somebody has
   * already signed.
   */
  app.post(
    '/hr/employee-documents',
    {
      preHandler: [app.loadContext, requirePermission('hr.documents.manage')],
      schema: {
        body: body(
          {
            employee_id: v.id('emp'),
            template_id: v.id('ltp'),
            kind: v.enum(KINDS),
            title: v.text(200),
            body: { type: 'string', maxLength: 40_000 },
            document_id: { type: 'string', maxLength: 64 },
            file_name: v.text(255),
            issue: v.bool,
            visible_to_employee: v.bool,
            requires_acknowledgement: v.bool,
            issued_on: v.date,
            valid_until: v.date,
            notes: v.text(1000),
          },
          ['employee_id'],
        ),
      },
    },
    async (request, reply) => {
      const { orgId, userId, email } = request.ctx;
      const b = request.body;
      await ensureLetterTemplates(db, orgId);

      const template = b.template_id
        ? await db.one(
            `SELECT * FROM letter_templates WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
            [b.template_id, orgId],
          )
        : null;
      if (b.template_id && !template) throw notFound('Template');

      const kind = b.kind ?? template?.kind ?? 'custom';

      // An uploaded scan has no body to render; a letter must have one.
      const source = b.body ?? template?.body ?? null;
      let rendered = null;
      let title = b.title?.trim() ?? null;

      if (source) {
        const context = await buildContext(db, {
          orgId, employeeId: b.employee_id, issuedBy: email,
          validUntil: b.valid_until, workspace,
        });
        rendered = renderLetter(source, context);
        title ??= template?.subject ? renderLetter(template.subject, context) : template?.name;
      }

      if (!rendered && !b.document_id) {
        throw badRequest('A document needs either a letter body or an attached file.');
      }
      if (!title) throw badRequest('Give the document a title.');

      const issue = b.issue ?? false;

      const row = await db.transaction(async (tx) => {
        const employee = await tx.one(
          `SELECT id FROM employees WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
          [b.employee_id, orgId],
        );
        if (!employee) throw notFound('Employee');

        // Only issued documents are numbered — a draft that is never sent
        // should not consume a reference.
        const reference = issue ? await nextLetterReference(tx, orgId, kind) : null;

        const inserted = await tx.one(
          `INSERT INTO employee_documents
             (id, org_id, employee_id, template_id, kind, title, reference, body,
              document_id, file_name, status, visible_to_employee,
              requires_acknowledgement, issued_on, valid_until, issued_by, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::date,$15::date,$16,$17)
           RETURNING *`,
          [
            id('edo'), orgId, b.employee_id, template?.id ?? null, kind, title,
            reference, rendered, b.document_id ?? null, b.file_name ?? null,
            issue ? 'issued' : 'draft',
            b.visible_to_employee ?? true,
            b.requires_acknowledgement ?? false,
            issue ? (b.issued_on ?? new Date().toISOString().slice(0, 10)) : (b.issued_on ?? null),
            b.valid_until ?? null,
            issue ? userId : null,
            b.notes ?? null,
          ],
        );

        await announceIssued(tx, { orgId, actorId: userId, document: inserted });
        return inserted;
      });

      return reply.status(201).send({ data: row });
    },
  );

  app.post(
    '/hr/employee-documents/:documentId/issue',
    {
      preHandler: [app.loadContext, requirePermission('hr.documents.manage')],
      schema: {
        params: params({ documentId: v.id('edo') }),
        body: body({ issued_on: v.date }, []),
      },
    },
    async (request) => {
      const { orgId, userId } = request.ctx;

      const document = await db.one(
        `SELECT * FROM employee_documents WHERE id = $1 AND org_id = $2`,
        [request.params.documentId, orgId],
      );
      if (!document) throw notFound('Document');
      if (document.status !== 'draft') {
        throw badRequest(`This document was already issued as ${document.reference}.`);
      }

      const updated = await db.transaction(async (tx) => {
        const reference = await nextLetterReference(tx, orgId, document.kind);
        const issued = await tx.one(
          `UPDATE employee_documents
              SET status = 'issued', reference = $3,
                  issued_on = COALESCE($4::date, current_date), issued_by = $5
            WHERE id = $1 AND org_id = $2 RETURNING *`,
          [document.id, orgId, reference, request.body.issued_on ?? null, userId],
        );
        await announceIssued(tx, { orgId, actorId: userId, document: issued });
        return issued;
      });

      return { data: updated };
    },
  );

  app.patch(
    '/hr/employee-documents/:documentId',
    {
      preHandler: [app.loadContext, requirePermission('hr.documents.manage')],
      schema: {
        params: params({ documentId: v.id('edo') }),
        body: body({
          title: v.text(200), body: { type: 'string', maxLength: 40_000 },
          visible_to_employee: v.bool, requires_acknowledgement: v.bool,
          valid_until: v.date, notes: v.text(1000),
        }),
      },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const b = request.body;

      const document = await db.one(
        `SELECT status FROM employee_documents WHERE id = $1 AND org_id = $2`,
        [request.params.documentId, orgId],
      );
      if (!document) throw notFound('Document');

      // The words of an issued letter are frozen. Its visibility is not —
      // showing or hiding it changes nothing about what it says.
      if (document.status !== 'draft' && b.body !== undefined) {
        throw badRequest('An issued letter cannot be reworded. Revoke it and issue a new one.');
      }

      const fields = Object.keys(b);
      if (!fields.length) throw badRequest('Nothing to update.');

      const sets = fields.map((f, i) => `${f} = $${i + 3}`).join(', ');
      const row = await db.one(
        `UPDATE employee_documents SET ${sets} WHERE id = $1 AND org_id = $2 RETURNING *`,
        [request.params.documentId, orgId, ...fields.map((f) => b[f])],
      );

      return { data: row };
    },
  );

  app.post(
    '/hr/employee-documents/:documentId/revoke',
    {
      preHandler: [app.loadContext, requirePermission('hr.documents.manage')],
      schema: {
        params: params({ documentId: v.id('edo') }),
        body: body({ reason: v.text(500) }, ['reason']),
      },
    },
    async (request) => {
      const updated = await db.one(
        `UPDATE employee_documents
            SET status = 'revoked', revoked_at = now(), revoke_reason = $3,
                visible_to_employee = false
          WHERE id = $1 AND org_id = $2 AND status <> 'revoked'
          RETURNING *`,
        [request.params.documentId, request.ctx.orgId, request.body.reason],
      );
      if (!updated) throw notFound('Document');

      // The row survives: a revoked offer letter is part of the record.
      return { data: updated };
    },
  );

  app.delete(
    '/hr/employee-documents/:documentId',
    {
      preHandler: [app.loadContext, requirePermission('hr.documents.manage')],
      schema: { params: params({ documentId: v.id('edo') }) },
    },
    async (request) => {
      const row = await db.one(
        `DELETE FROM employee_documents
          WHERE id = $1 AND org_id = $2 AND status = 'draft' RETURNING id`,
        [request.params.documentId, request.ctx.orgId],
      );
      // Only a draft can be deleted outright; anything issued is revoked.
      if (!row) throw badRequest('Only an unissued draft can be deleted. Revoke an issued document instead.');

      return { data: { deleted: true } };
    },
  );
}

/** Employee + salary + employer, ready for a template. */
async function buildContext(db, { orgId, employeeId, issuedBy, validUntil, workspace }) {
  const employee = await db.one(
    `SELECT e.*, d.name AS department_name,
            m.first_name AS manager_first_name, m.last_name AS manager_last_name
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN employees m ON m.id = e.manager_id
      WHERE e.id = $1 AND e.org_id = $2 AND e.archived_at IS NULL`,
    [employeeId, orgId],
  );
  if (!employee) throw notFound('Employee');

  const [org, salary] = await Promise.all([
    workspace.forOrg(orgId),
    // Payroll owns salary and pushes it here on every revision. Reading the
    // projection rather than calling payroll keeps the dependency one-way —
    // payroll already reads HR. A workspace without payroll simply has no
    // snapshot, and the letter says "as discussed" instead of failing.
    db.one(
      `SELECT annual_ctc, monthly_gross, currency, effective_from
         FROM employee_salary_snapshot WHERE org_id = $1 AND employee_id = $2`,
      [orgId, employeeId],
    ),
  ]);

  return letterContext({
    employee: {
      ...employee,
      manager_name: employee.manager_first_name
        ? [employee.manager_first_name, employee.manager_last_name].filter(Boolean).join(' ')
        : null,
    },
    org,
    salary,
    issuedBy,
    validUntil,
  });
}

/** Tell the employee — only if the document is theirs to see. */
async function announceIssued(tx, { orgId, actorId, document }) {
  if (!document?.visible_to_employee || document.status !== 'issued') return;
  const employee = await tx.one(
    `SELECT user_id, first_name, last_name FROM employees WHERE id = $1`,
    [document.employee_id],
  );
  tx.emit({
    type: EVENTS.DOCUMENT_ISSUED,
    org_id: orgId,
    actor_id: actorId,
    data: {
      document_id: document.id,
      employee_id: document.employee_id,
      employee_user_id: employee?.user_id ?? null,
      employee_name: [employee?.first_name, employee?.last_name].filter(Boolean).join(' '),
      title: document.title,
      reference: document.reference,
      requires_acknowledgement: document.requires_acknowledgement,
    },
  });
}
