import { id, paginate } from '@nexus/db-kit';
import {
  requirePermission, body, query, params, validate as v, notFound, badRequest, conflict,
} from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';

/** Contacts and companies: the records every other app eventually reads. */
export async function peopleRoutes(app) {
  const { db } = app;

  // ══════════════════════════════════════════════════════════════ COMPANIES
  app.get(
    '/crm/companies',
    {
      preHandler: [app.loadContext, requirePermission('crm.companies.view')],
      schema: { querystring: query({ is_customer: { type: 'boolean' }, owner: v.text(40), industry: v.text(60) }) },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const page = paginate({ ...request.query, allowedSorts: ['created_at', 'updated_at', 'name'] });

      const where = ['c.org_id = $1', 'c.archived_at IS NULL'];
      const values = [orgId];
      const { is_customer: isCustomer, owner, industry, q } = request.query;

      if (isCustomer !== undefined) { values.push(isCustomer); where.push(`c.is_customer = $${values.length}`); }
      if (owner) { values.push(owner); where.push(`c.owner_user_id = $${values.length}`); }
      if (industry) { values.push(industry); where.push(`c.industry = $${values.length}`); }
      if (q) {
        values.push(`%${q}%`);
        where.push(`(c.name ILIKE $${values.length} OR c.domain ILIKE $${values.length} OR c.email ILIKE $${values.length})`);
      }

      const clause = where.join(' AND ');

      const [rows, total] = await Promise.all([
        db.rows(
          `SELECT c.*,
                  (SELECT count(*)::int FROM contacts ct
                    WHERE ct.company_id = c.id AND ct.archived_at IS NULL) AS contact_count,
                  (SELECT count(*)::int FROM deals d
                    WHERE d.company_id = c.id AND d.status = 'open' AND d.archived_at IS NULL) AS open_deals,
                  (SELECT COALESCE(sum(d.value), 0)::text FROM deals d
                    WHERE d.company_id = c.id AND d.status = 'won' AND d.archived_at IS NULL) AS lifetime_value
             FROM companies c WHERE ${clause}
            ORDER BY c.${page.orderBy} LIMIT ${page.limit} OFFSET ${page.offset}`,
          values,
        ),
        db.one(`SELECT count(*)::int AS n FROM companies c WHERE ${clause}`, values),
      ]);

      return { data: rows, meta: page.meta(total.n) };
    },
  );

  app.get(
    '/crm/companies/:companyId',
    {
      preHandler: [app.loadContext, requirePermission('crm.companies.view')],
      schema: { params: params({ companyId: v.id('cmp') }) },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const company = await db.one(
        `SELECT * FROM companies WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
        [request.params.companyId, orgId],
      );
      if (!company) throw notFound('Company');

      const [contacts, deals, activities] = await Promise.all([
        db.rows(
          `SELECT * FROM contacts WHERE org_id = $1 AND company_id = $2 AND archived_at IS NULL
            ORDER BY is_primary DESC, created_at`,
          [orgId, company.id],
        ),
        db.rows(
          `SELECT d.*, s.name AS stage_name, s.colour AS stage_colour FROM deals d
             LEFT JOIN stages s ON s.id = d.stage_id
            WHERE d.org_id = $1 AND d.company_id = $2 AND d.archived_at IS NULL
            ORDER BY d.created_at DESC`,
          [orgId, company.id],
        ),
        db.rows(
          `SELECT * FROM activities WHERE org_id = $1 AND related_type = 'company' AND related_id = $2
            ORDER BY created_at DESC LIMIT 50`,
          [orgId, company.id],
        ),
      ]);

      return { data: { ...company, contacts, deals, activities } };
    },
  );

  app.post(
    '/crm/companies',
    {
      preHandler: [app.loadContext, requirePermission('crm.companies.create')],
      schema: {
        body: body(
          {
            name: v.text(160, 1),
            legal_name: v.text(160),
            domain: v.text(120),
            industry: v.text(60),
            size_band: v.text(20),
            phone: v.text(32),
            email: v.email,
            website: v.text(200),
            tax_id: v.text(40),
            owner_user_id: v.text(40),
            address: { type: 'object', additionalProperties: true },
            tags: { type: 'array', items: v.text(40), maxItems: 20 },
            notes: v.longText,
          },
          ['name'],
        ),
      },
    },
    async (request, reply) => {
      const { orgId, userId } = request.ctx;
      const b = request.body;
      const domain = b.domain?.toLowerCase().replace(/^https?:\/\//, '').split('/')[0] ?? null;

      if (domain) {
        const clash = await db.one(
          `SELECT id, name FROM companies WHERE org_id = $1 AND lower(domain) = $2 AND archived_at IS NULL`,
          [orgId, domain],
        );
        if (clash) {
          throw conflict(`${clash.name} already uses that domain.`, { company_id: clash.id });
        }
      }

      const company = await db.transaction(async (tx) => {
        const created = await tx.one(
          `INSERT INTO companies
             (id, org_id, name, legal_name, domain, industry, size_band, phone, email,
              website, tax_id, owner_user_id, address, tags, notes, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12,$13),$14,$15,$16,$13)
           RETURNING *`,
          [
            id('cmp'), orgId, b.name.trim(), b.legal_name ?? null, domain, b.industry ?? null,
            b.size_band ?? null, b.phone ?? null, b.email ?? null, b.website ?? null,
            b.tax_id ?? null, b.owner_user_id ?? null, userId,
            JSON.stringify(b.address ?? {}), b.tags ?? [], b.notes ?? null,
          ],
        );

        tx.emit({
          type: EVENTS.CUSTOMER_CREATED,
          org_id: orgId,
          actor_id: userId,
          data: { company_id: created.id, name: created.name, domain: created.domain, via: 'manual' },
        });

        return created;
      });

      return reply.status(201).send({ data: company });
    },
  );

  app.patch(
    '/crm/companies/:companyId',
    {
      preHandler: [app.loadContext, requirePermission('crm.companies.edit')],
      schema: {
        params: params({ companyId: v.id('cmp') }),
        body: body({
          name: v.text(160, 1), legal_name: v.text(160), domain: v.text(120),
          industry: v.text(60), size_band: v.text(20), phone: v.text(32), email: v.email,
          website: v.text(200), tax_id: v.text(40), owner_user_id: v.text(40),
          address: { type: 'object', additionalProperties: true },
          tags: { type: 'array', items: v.text(40), maxItems: 20 },
          notes: v.longText,
        }),
      },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const fields = [
        'name', 'legal_name', 'domain', 'industry', 'size_band', 'phone', 'email',
        'website', 'tax_id', 'owner_user_id', 'address', 'tags', 'notes',
      ].filter((f) => request.body[f] !== undefined);

      if (!fields.length) throw badRequest('Nothing to update.');

      const sets = fields.map((f, i) => `${f} = $${i + 3}`).join(', ');
      const values = fields.map((f) => (f === 'address' ? JSON.stringify(request.body[f]) : request.body[f]));

      const updated = await db.one(
        `UPDATE companies SET ${sets} WHERE id = $1 AND org_id = $2 AND archived_at IS NULL RETURNING *`,
        [request.params.companyId, orgId, ...values],
      );
      if (!updated) throw notFound('Company');

      await db.query(
        `INSERT INTO outbox (id, type, org_id, actor_id, data) VALUES ($1,$2,$3,$4,$5)`,
        [id('evt'), EVENTS.CUSTOMER_UPDATED, orgId, request.ctx.userId,
         JSON.stringify({ company_id: updated.id, changed: fields })],
      );

      return { data: updated };
    },
  );

  app.delete(
    '/crm/companies/:companyId',
    {
      preHandler: [app.loadContext, requirePermission('crm.companies.delete')],
      schema: { params: params({ companyId: v.id('cmp') }) },
    },
    async (request) => {
      const { orgId } = request.ctx;

      // Refuse to orphan live opportunities.
      const open = await db.one(
        `SELECT count(*)::int AS n FROM deals
          WHERE org_id = $1 AND company_id = $2 AND status = 'open' AND archived_at IS NULL`,
        [orgId, request.params.companyId],
      );
      if (open.n > 0) {
        throw badRequest(
          `This company still has ${open.n} open ${open.n === 1 ? 'deal' : 'deals'}. Close or move them first.`,
        );
      }

      const row = await db.one(
        `UPDATE companies SET archived_at = now()
          WHERE id = $1 AND org_id = $2 AND archived_at IS NULL RETURNING id`,
        [request.params.companyId, orgId],
      );
      if (!row) throw notFound('Company');
      return { data: { archived: true } };
    },
  );

  // ═══════════════════════════════════════════════════════════════ CONTACTS
  app.get(
    '/crm/contacts',
    {
      preHandler: [app.loadContext, requirePermission('crm.contacts.view')],
      schema: { querystring: query({ company_id: v.id('cmp'), owner: v.text(40) }) },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const page = paginate({ ...request.query, allowedSorts: ['created_at', 'updated_at', 'first_name'] });

      const where = ['ct.org_id = $1', 'ct.archived_at IS NULL'];
      const values = [orgId];
      const { company_id: companyId, owner, q } = request.query;

      if (companyId) { values.push(companyId); where.push(`ct.company_id = $${values.length}`); }
      if (owner) { values.push(owner); where.push(`ct.owner_user_id = $${values.length}`); }
      if (q) {
        values.push(`%${q}%`);
        where.push(
          `(ct.first_name ILIKE $${values.length} OR ct.last_name ILIKE $${values.length}
            OR ct.email ILIKE $${values.length} OR c.name ILIKE $${values.length})`,
        );
      }

      const clause = where.join(' AND ');
      const join = 'FROM contacts ct LEFT JOIN companies c ON c.id = ct.company_id';

      const [rows, total] = await Promise.all([
        db.rows(
          `SELECT ct.*, c.name AS company_name ${join} WHERE ${clause}
            ORDER BY ct.${page.orderBy} LIMIT ${page.limit} OFFSET ${page.offset}`,
          values,
        ),
        db.one(`SELECT count(*)::int AS n ${join} WHERE ${clause}`, values),
      ]);

      return { data: rows.map(shapeContact), meta: page.meta(total.n) };
    },
  );

  app.get(
    '/crm/contacts/:contactId',
    {
      preHandler: [app.loadContext, requirePermission('crm.contacts.view')],
      schema: { params: params({ contactId: v.id('con') }) },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const contact = await db.one(
        `SELECT ct.*, c.name AS company_name FROM contacts ct
           LEFT JOIN companies c ON c.id = ct.company_id
          WHERE ct.id = $1 AND ct.org_id = $2 AND ct.archived_at IS NULL`,
        [request.params.contactId, orgId],
      );
      if (!contact) throw notFound('Contact');

      const [deals, activities] = await Promise.all([
        db.rows(
          `SELECT d.*, s.name AS stage_name, s.colour AS stage_colour FROM deals d
             LEFT JOIN stages s ON s.id = d.stage_id
            WHERE d.org_id = $1 AND d.contact_id = $2 AND d.archived_at IS NULL
            ORDER BY d.created_at DESC`,
          [orgId, contact.id],
        ),
        db.rows(
          `SELECT * FROM activities WHERE org_id = $1 AND related_type = 'contact' AND related_id = $2
            ORDER BY created_at DESC LIMIT 50`,
          [orgId, contact.id],
        ),
      ]);

      return { data: { ...shapeContact(contact), deals, activities } };
    },
  );

  app.post(
    '/crm/contacts',
    {
      preHandler: [app.loadContext, requirePermission('crm.contacts.create')],
      schema: {
        body: body(
          {
            first_name: v.text(80, 1), last_name: v.text(80), company_id: v.id('cmp'),
            email: v.email, phone: v.text(32), mobile: v.text(32),
            job_title: v.text(120), department: v.text(80), linkedin: v.text(200),
            is_primary: { type: 'boolean' }, owner_user_id: v.text(40),
            tags: { type: 'array', items: v.text(40), maxItems: 20 }, notes: v.longText,
          },
          ['first_name'],
        ),
      },
    },
    async (request, reply) => {
      const { orgId, userId } = request.ctx;
      const b = request.body;

      const contact = await db.transaction(async (tx) => {
        // Only one primary contact per company.
        if (b.is_primary && b.company_id) {
          await tx.query(
            `UPDATE contacts SET is_primary = false WHERE org_id = $1 AND company_id = $2`,
            [orgId, b.company_id],
          );
        }

        return tx.one(
          `INSERT INTO contacts
             (id, org_id, company_id, first_name, last_name, email, phone, mobile,
              job_title, department, linkedin, is_primary, owner_user_id, tags, notes, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12,false),COALESCE($13,$14),$15,$16,$14)
           RETURNING *`,
          [
            id('con'), orgId, b.company_id ?? null, b.first_name.trim(), b.last_name ?? null,
            b.email ?? null, b.phone ?? null, b.mobile ?? null, b.job_title ?? null,
            b.department ?? null, b.linkedin ?? null, b.is_primary ?? null,
            b.owner_user_id ?? null, userId, b.tags ?? [], b.notes ?? null,
          ],
        );
      });

      return reply.status(201).send({ data: shapeContact(contact) });
    },
  );

  app.patch(
    '/crm/contacts/:contactId',
    {
      preHandler: [app.loadContext, requirePermission('crm.contacts.edit')],
      schema: {
        params: params({ contactId: v.id('con') }),
        body: body({
          first_name: v.text(80, 1), last_name: v.text(80), company_id: v.id('cmp'),
          email: v.email, phone: v.text(32), mobile: v.text(32), job_title: v.text(120),
          department: v.text(80), linkedin: v.text(200), is_primary: { type: 'boolean' },
          owner_user_id: v.text(40), tags: { type: 'array', items: v.text(40), maxItems: 20 },
          notes: v.longText,
        }),
      },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const fields = [
        'first_name', 'last_name', 'company_id', 'email', 'phone', 'mobile',
        'job_title', 'department', 'linkedin', 'is_primary', 'owner_user_id', 'tags', 'notes',
      ].filter((f) => request.body[f] !== undefined);

      if (!fields.length) throw badRequest('Nothing to update.');

      const updated = await db.transaction(async (tx) => {
        if (request.body.is_primary) {
          const current = await tx.one(
            `SELECT company_id FROM contacts WHERE id = $1 AND org_id = $2`,
            [request.params.contactId, orgId],
          );
          const companyId = request.body.company_id ?? current?.company_id;
          if (companyId) {
            await tx.query(
              `UPDATE contacts SET is_primary = false
                WHERE org_id = $1 AND company_id = $2 AND id <> $3`,
              [orgId, companyId, request.params.contactId],
            );
          }
        }

        const sets = fields.map((f, i) => `${f} = $${i + 3}`).join(', ');
        return tx.one(
          `UPDATE contacts SET ${sets} WHERE id = $1 AND org_id = $2 AND archived_at IS NULL RETURNING *`,
          [request.params.contactId, orgId, ...fields.map((f) => request.body[f])],
        );
      });

      if (!updated) throw notFound('Contact');
      return { data: shapeContact(updated) };
    },
  );

  app.delete(
    '/crm/contacts/:contactId',
    {
      preHandler: [app.loadContext, requirePermission('crm.contacts.delete')],
      schema: { params: params({ contactId: v.id('con') }) },
    },
    async (request) => {
      const row = await db.one(
        `UPDATE contacts SET archived_at = now()
          WHERE id = $1 AND org_id = $2 AND archived_at IS NULL RETURNING id`,
        [request.params.contactId, request.ctx.orgId],
      );
      if (!row) throw notFound('Contact');
      return { data: { archived: true } };
    },
  );
}

function shapeContact(contact) {
  return {
    ...contact,
    name: [contact.first_name, contact.last_name].filter(Boolean).join(' '),
  };
}
