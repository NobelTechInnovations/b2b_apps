import { createHash, randomBytes } from 'node:crypto';
import { id } from '@nexus/db-kit';
import {
  body, params, query, validate as v, requireApp, requirePermission, notFound, badRequest, ApiError,
} from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';
import { insertLead } from '../lib/leads.js';
import { activeFields, cleanCustom } from '../lib/lead-fields.js';
import { phoneKey } from '../lib/lead-intake.js';

const FIELD_TYPES = ['short_text', 'long_text', 'email', 'phone', 'number', 'date', 'select', 'multi_select', 'checkbox'];
// A lead's own columns, or one of the workspace's lead fields (`custom.budget`).
const MAPS_TO = { type: 'string', pattern: '^(full_name|first_name|last_name|email|phone|company_name|job_title|city|notes|custom\\.[a-z][a-z0-9_]{0,39})$' };
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const newToken = () => randomBytes(12).toString('base64url');

const fieldSchema = body({
  key: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,39}$' },
  label: v.text(200, 1),
  type: v.enum(FIELD_TYPES),
  required: v.bool,
  options: { type: 'array', items: v.text(120, 1), maxItems: 50 },
  maps_to: nullable(MAPS_TO),
  help: v.text(300, 0),
}, ['key', 'label', 'type']);

/** Check a form's field list: unique keys, options where needed, one field per mapping. */
function validateFields(fields) {
  const keys = new Set();
  const mapped = new Set();
  for (const f of fields) {
    if (keys.has(f.key)) throw badRequest(`Two fields share the key “${f.key}”.`);
    keys.add(f.key);
    if (['select', 'multi_select'].includes(f.type) && !(f.options?.length >= 1)) {
      throw badRequest(`“${f.label}” needs at least one option.`);
    }
    if (f.maps_to) {
      if (mapped.has(f.maps_to)) throw badRequest(`Only one field can fill the lead’s ${f.maps_to.replace('custom.', '').replace('_', ' ')}.`);
      mapped.add(f.maps_to);
    }
  }
}

/** Validate and normalise one submission against the form's fields. */
export function cleanAnswers(fields, raw) {
  const answers = {};
  const problems = [];
  for (const f of fields) {
    let value = raw?.[f.key];
    if (typeof value === 'string') value = value.trim();
    const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length) || (f.type === 'checkbox' && value !== true && f.required);
    if (empty) {
      if (f.required) problems.push({ field: f.key, message: `${f.label} is required.` });
      continue;
    }
    switch (f.type) {
      case 'email':
        if (typeof value !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 254) problems.push({ field: f.key, message: 'Enter a valid email address.' });
        else answers[f.key] = value.toLowerCase();
        break;
      case 'phone':
        if (typeof value !== 'string' || !/^[+0-9 ()-]{6,20}$/.test(value)) problems.push({ field: f.key, message: 'Enter a valid phone number.' });
        else answers[f.key] = value;
        break;
      case 'number': {
        const n = Number(value);
        if (!Number.isFinite(n)) problems.push({ field: f.key, message: `${f.label} must be a number.` });
        else answers[f.key] = n;
        break;
      }
      case 'date':
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) problems.push({ field: f.key, message: 'Choose a date.' });
        else answers[f.key] = value;
        break;
      case 'select':
        if (!f.options.includes(value)) problems.push({ field: f.key, message: `Choose one of the options for ${f.label}.` });
        else answers[f.key] = value;
        break;
      case 'multi_select': {
        const list = Array.isArray(value) ? value : [value];
        if (!list.every((x) => f.options.includes(x))) problems.push({ field: f.key, message: `Choose from the options for ${f.label}.` });
        else answers[f.key] = [...new Set(list)];
        break;
      }
      case 'checkbox':
        answers[f.key] = value === true || value === 'true';
        break;
      default:
        if (typeof value !== 'string') problems.push({ field: f.key, message: `${f.label} must be text.` });
        else answers[f.key] = value.slice(0, f.type === 'long_text' ? 5000 : 500);
    }
  }
  return { answers, problems };
}

/**
 * Surveys & Forms.
 *
 * A published form is reachable by its token alone — no account — and every
 * submission is validated against the form's own field list. With "create
 * lead" on, the submission becomes a CRM lead (or joins the open lead that
 * already has that email) in the same transaction.
 */
export async function formRoutes(app) {
  const { db, config } = app;
  const guard = (permission) => [app.loadContext, requireApp('surveys'), requirePermission(permission)];
  const formParams = { params: params({ formId: v.id('form') }) };

  async function form(store, orgId, formId, lock = false) {
    const row = await store.one(`SELECT * FROM forms WHERE org_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`, [orgId, formId]);
    if (!row) throw notFound('Form');
    return row;
  }

  const formFields = {
    name: v.text(160, 1),
    description: v.text(2000, 0),
    fields: { type: 'array', items: fieldSchema, maxItems: 40 },
    create_lead: v.bool,
    lead_source: v.enum(['website', 'referral', 'campaign', 'event', 'partner']),
    lead_owner_id: nullable(v.id('usr')),
    thank_you_message: v.text(500, 1),
  };

  async function assertLeadOptions(request, b) {
    if (!b.create_lead) return;
    // Leads land in the Leads app (or CRM: the same records), so the author
    // needs one of them and the right to create leads there.
    const canLeads = request.ctx.hasApp('leads') && request.ctx.can('leads.leads.create');
    const canCrm = request.ctx.hasApp('crm') && request.ctx.can('crm.leads.create');
    if (!canLeads && !canCrm) {
      if (!request.ctx.hasApp('leads') && !request.ctx.hasApp('crm')) throw badRequest('Turn on the Leads or CRM app to create leads from this form.');
      request.ctx.assert(request.ctx.hasApp('leads') ? 'leads.leads.create' : 'crm.leads.create');
    }
    if (b.lead_owner_id) {
      const response = await fetch(`${config.tenancyUrl}/internal/authz/${request.ctx.orgId}/${b.lead_owner_id}`, {
        headers: { 'x-nexus-service-token': config.serviceToken }, signal: AbortSignal.timeout(8000),
      });
      const auth = response.ok ? (await response.json()).data : null;
      if (!auth?.allowed) throw badRequest('Choose an active member to own the leads.');
    }
  }

  // ═══════════════════════════════════════════════════════════════════ FORMS
  app.get('/surveys/forms', { preHandler: guard('surveys.forms.view'), schema: { querystring: query({ status: v.enum(['draft', 'published', 'closed']) }) } }, async (request) => {
    const values = [request.ctx.orgId];
    let where = 'org_id = $1';
    if (request.query.status) { values.push(request.query.status); where += ` AND status = $${values.length}`; }
    if (request.query.q) { values.push(`%${request.query.q}%`); where += ` AND name ILIKE $${values.length}`; }
    const rows = await db.rows(
      `SELECT id, name, description, status, public_token, create_lead, response_count, last_response_at,
              jsonb_array_length(fields) AS field_count, created_by, created_at, updated_at
         FROM forms WHERE ${where} ORDER BY updated_at DESC`,
      values,
    );
    return { data: rows };
  });

  app.post('/surveys/forms', { preHandler: guard('surveys.forms.create'), schema: { body: body(formFields, ['name']) } }, async (request, reply) => {
    const b = request.body;
    if (!b.name.trim()) throw badRequest('Name the form.');
    const fields = b.fields ?? [
      { key: 'full_name', label: 'Your name', type: 'short_text', required: true, maps_to: 'full_name' },
      { key: 'email', label: 'Email', type: 'email', required: true, maps_to: 'email' },
      { key: 'phone', label: 'Phone', type: 'phone', required: false, maps_to: 'phone' },
      { key: 'message', label: 'How can we help?', type: 'long_text', required: false, maps_to: 'notes' },
    ];
    validateFields(fields);
    await assertLeadOptions(request, b);
    const row = await db.one(
      `INSERT INTO forms (id, org_id, name, description, fields, public_token, create_lead, lead_source, lead_owner_id, thank_you_message, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,false),COALESCE($8,'website'),$9,COALESCE($10,'Thank you — we have received your response.'),$11) RETURNING *`,
      [id('form'), request.ctx.orgId, b.name.trim(), b.description ?? '', JSON.stringify(fields), newToken(), b.create_lead ?? null,
        b.lead_source ?? null, b.lead_owner_id ?? null, b.thank_you_message ?? null, request.ctx.userId],
    );
    return reply.status(201).send({ data: row });
  });

  app.get('/surveys/forms/:formId', { preHandler: guard('surveys.forms.view'), schema: formParams }, async (request) => ({
    data: await form(db, request.ctx.orgId, request.params.formId),
  }));

  app.patch(
    '/surveys/forms/:formId',
    { preHandler: guard('surveys.forms.edit'), schema: { ...formParams, body: body({ ...formFields, status: v.enum(['draft', 'published', 'closed']), rotate_link: v.bool }) } },
    async (request) => {
      const b = request.body;
      if (b.fields) validateFields(b.fields);
      if (b.create_lead) await assertLeadOptions(request, b);
      const row = await db.transaction(async (tx) => {
        const old = await form(tx, request.ctx.orgId, request.params.formId, true);
        const next = { ...old, ...b };
        if (next.status === 'published' && !(next.fields?.length)) throw badRequest('Add at least one field before publishing.');
        return tx.one(
          `UPDATE forms SET name = $3, description = $4, fields = $5, status = $6, create_lead = $7, lead_source = $8,
                  lead_owner_id = $9, thank_you_message = $10, public_token = $11, updated_at = now()
            WHERE org_id = $1 AND id = $2 RETURNING *`,
          [old.org_id, old.id, next.name.trim(), next.description, JSON.stringify(next.fields), next.status, next.create_lead,
            next.lead_source, next.lead_owner_id, next.thank_you_message, b.rotate_link ? newToken() : old.public_token],
        );
      });
      return { data: row };
    },
  );

  app.delete('/surveys/forms/:formId', { preHandler: guard('surveys.forms.delete'), schema: formParams }, async (request) => {
    const row = await db.one(`DELETE FROM forms WHERE org_id = $1 AND id = $2 RETURNING id`, [request.ctx.orgId, request.params.formId]);
    if (!row) throw notFound('Form');
    return { data: { deleted: true } };
  });

  // ═══════════════════════════════════════════════════════════════ RESPONSES
  app.get(
    '/surveys/forms/:formId/responses',
    { preHandler: guard('surveys.responses.view'), schema: { ...formParams, querystring: query({}) } },
    async (request) => {
      const f = await form(db, request.ctx.orgId, request.params.formId);
      const limit = request.query.limit ?? 50;
      const offset = ((request.query.page ?? 1) - 1) * limit;
      const values = [f.org_id, f.id];
      let where = 'org_id = $1 AND form_id = $2';
      if (request.query.q) {
        values.push(`%${request.query.q}%`);
        where += ` AND (contact_name ILIKE $3 OR contact_email ILIKE $3 OR contact_phone ILIKE $3 OR answers::text ILIKE $3)`;
      }
      const [rows, total] = await Promise.all([
        db.rows(`SELECT id, answers, contact_name, contact_email, contact_phone, lead_id, submitted_at FROM form_responses
                  WHERE ${where} ORDER BY submitted_at DESC LIMIT ${limit} OFFSET ${offset}`, values),
        db.one(`SELECT count(*)::int AS n FROM form_responses WHERE ${where}`, values),
      ]);
      return { data: rows, meta: { total: total.n, page: request.query.page ?? 1, limit, pages: Math.ceil(total.n / limit) || 1, fields: f.fields } };
    },
  );

  app.get('/surveys/forms/:formId/responses.csv', { preHandler: guard('surveys.responses.export'), schema: formParams }, async (request, reply) => {
    const f = await form(db, request.ctx.orgId, request.params.formId);
    const rows = await db.rows(`SELECT answers, lead_id, submitted_at FROM form_responses WHERE org_id = $1 AND form_id = $2 ORDER BY submitted_at`, [f.org_id, f.id]);
    const cell = (value) => {
      const text = Array.isArray(value) ? value.join('; ') : value === undefined || value === null ? '' : String(value);
      // Quote everything; neutralise spreadsheet formulas in untrusted input.
      return `"${(/^[=+\-@]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
    };
    const header = ['Submitted at', ...f.fields.map((x) => x.label), 'Lead ID'];
    const lines = [header.map(cell).join(','), ...rows.map((r) => [r.submitted_at.toISOString(), ...f.fields.map((x) => r.answers[x.key]), r.lead_id].map(cell).join(','))];
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${f.name.replace(/[^\w-]+/g, '-').slice(0, 60) || 'responses'}.csv"`);
    return `\uFEFF${lines.join('\n')}`;
  });

  app.delete(
    '/surveys/forms/:formId/responses/:responseId',
    { preHandler: guard('surveys.forms.delete'), schema: { params: params({ formId: v.id('form'), responseId: v.id('fres') }) } },
    async (request) => {
      await db.transaction(async (tx) => {
        const f = await form(tx, request.ctx.orgId, request.params.formId, true);
        const gone = await tx.one(`DELETE FROM form_responses WHERE org_id = $1 AND form_id = $2 AND id = $3 RETURNING id`, [f.org_id, f.id, request.params.responseId]);
        if (!gone) throw notFound('Response');
        await tx.query(`UPDATE forms SET response_count = GREATEST(response_count - 1, 0) WHERE org_id = $1 AND id = $2`, [f.org_id, f.id]);
      });
      return { data: { deleted: true } };
    },
  );

  // ══════════════════════════════════════════════════════════════════ PUBLIC
  const tokenParams = { params: { type: 'object', properties: { token: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,40}$' } }, required: ['token'] } };

  app.get('/public-forms/:token', { schema: tokenParams }, async (request) => {
    const f = await db.one(`SELECT id, name, description, fields, status, thank_you_message FROM forms WHERE public_token = $1`, [request.params.token]);
    if (!f || f.status === 'draft') throw notFound('Form');
    return { data: { name: f.name, description: f.description, fields: f.fields, open: f.status === 'published' } };
  });

  app.post(
    '/public-forms/:token/submit',
    { schema: { ...tokenParams, body: { type: 'object', properties: { answers: { type: 'object', additionalProperties: true }, website: { type: 'string', maxLength: 200 } }, required: ['answers'], additionalProperties: false } } },
    async (request, reply) => {
      // A field real people never see: anything that fills it is a bot. Say
      // thank you and keep nothing.
      if (request.body.website) return reply.status(201).send({ data: { received: true } });

      const f = await db.one(`SELECT * FROM forms WHERE public_token = $1`, [request.params.token]);
      if (!f || f.status === 'draft') throw notFound('Form');
      if (f.status === 'closed') throw badRequest('This form is no longer accepting responses.');

      const { answers, problems } = cleanAnswers(f.fields, request.body.answers);
      if (problems.length) throw badRequest('Please check the highlighted fields.', problems);

      const ipHash = createHash('sha256').update(`${request.ip}:${config.serviceToken}`).digest('hex').slice(0, 32);
      const recent = await db.one(
        `SELECT count(*)::int AS n FROM form_responses WHERE form_id = $1 AND ip_hash = $2 AND submitted_at > now() - interval '10 minutes'`,
        [f.id, ipHash],
      );
      if (recent.n >= 5) throw new ApiError(429, 'rate_limited', 'Too many submissions from this connection. Try again in a few minutes.');

      // Pull the contact out of whichever fields map to it.
      const by = Object.fromEntries(f.fields.filter((x) => x.maps_to && answers[x.key] !== undefined).map((x) => [x.maps_to, answers[x.key]]));
      const fullName = by.full_name ?? [by.first_name, by.last_name].filter(Boolean).join(' ');
      const contact = { name: fullName || null, email: by.email ?? null, phone: by.phone ?? null };

      const message = await db.transaction(async (tx) => {
        let leadId = null;
        if (f.create_lead && (contact.name || contact.email || contact.phone)) {
          // The same person (by email, or by phone number) enquiring again.
          const existing = contact.email || contact.phone
            ? await tx.one(
              `SELECT id FROM leads WHERE org_id = $1 AND status <> 'converted' AND archived_at IS NULL
                  AND (lower(email) = lower($2) OR phone_key = $3) ORDER BY created_at DESC LIMIT 1`,
              [f.org_id, contact.email, phoneKey(contact.phone)],
            )
            : null;
          // Answers that fill one of the workspace's lead fields go there.
          const leadFields = await activeFields(tx, f.org_id);
          const customInput = Object.fromEntries(Object.entries(by).filter(([k]) => k.startsWith('custom.')).map(([k, value]) => [k.slice(7), value]));
          const { values: custom } = cleanCustom(leadFields, customInput, { strict: false });
          const summary = f.fields.filter((x) => answers[x.key] !== undefined && x.maps_to !== 'notes' && !x.maps_to?.startsWith('custom.'))
            .map((x) => `${x.label}: ${Array.isArray(answers[x.key]) ? answers[x.key].join(', ') : answers[x.key]}`).join('\n');
          const notes = [`From the form “${f.name}”.`, by.notes, summary].filter(Boolean).join('\n\n');
          if (existing) {
            // The same person asking again: one lead, with the new enquiry on it.
            leadId = existing.id;
            await tx.query(
              `UPDATE leads SET notes = concat_ws(E'\\n\\n', notes, $3::text), custom = custom || $4::jsonb, updated_at = now() WHERE org_id = $1 AND id = $2`,
              [f.org_id, leadId, notes, JSON.stringify(custom)],
            );
          } else {
            const [first, ...rest] = (by.first_name ? [by.first_name] : (fullName || contact.email?.split('@')[0] || contact.phone || 'Web').split(/\s+/));
            const lead = await insertLead(tx, {
              orgId: f.org_id,
              actorId: null,
              fields: {
                first_name: String(first).slice(0, 80),
                last_name: by.last_name ?? (rest.join(' ') || null),
                email: contact.email, phone: contact.phone,
                company_name: by.company_name ?? null, job_title: by.job_title ?? null, city: by.city ?? null,
                source: f.lead_source, owner_user_id: f.lead_owner_id ?? f.created_by,
                tags: [f.name.slice(0, 40)], notes, custom, source_detail: `Form · ${f.name}`.slice(0, 160),
              },
              // The form's own notification already tells them.
              notifyOwner: false,
            });
            leadId = lead.id;
          }
        }
        const response = await tx.one(
          `INSERT INTO form_responses (id, org_id, form_id, answers, contact_name, contact_email, contact_phone, lead_id, ip_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [id('fres'), f.org_id, f.id, JSON.stringify(answers), contact.name, contact.email, contact.phone, leadId, ipHash],
        );
        await tx.query(`UPDATE forms SET response_count = response_count + 1, last_response_at = now() WHERE org_id = $1 AND id = $2`, [f.org_id, f.id]);
        tx.emit({ type: EVENTS.FORM_SUBMITTED, org_id: f.org_id, actor_id: null, data: { form_id: f.id, form_name: f.name, response_id: response.id, lead_id: leadId, contact_name: contact.name, created_by: f.created_by, lead_owner_id: f.lead_owner_id } });
        return f.thank_you_message;
      });
      return reply.status(201).send({ data: { received: true, message } });
    },
  );
}
