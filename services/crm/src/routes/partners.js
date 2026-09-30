import { createHash } from 'node:crypto';
import { id } from '@nexus/db-kit';
import {
  body, params, query, validate as v, requireApp, requirePermission, badRequest, notFound, resource, nullable, amount, ApiError,
} from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';
import { insertLead } from '../lib/leads.js';
import { toPaise, toRupees, nextSalesNumber, publicToken, orgProfiles } from '../lib/sales.js';

/**
 * Partner Portal: resellers and referrers register the deals they bring,
 * see where each one stands and what they have earned — from their own
 * private portal link, without a seat in the workspace.
 *
 * An approved registration becomes a CRM lead owned by the partner manager;
 * a won one earns a commission at the partner's rate.
 */
export async function partnerRoutes(app) {
  const { db, config } = app;
  const orgProfile = orgProfiles(config);
  const guard = (permission) => [app.loadContext, requireApp('partners'), requirePermission(permission)];

  const partners = resource(app, {
    path: '/partners/accounts', table: 'partners', prefix: 'ptn', appSlug: 'partners', label: 'Partner',
    permissions: { view: 'partners.accounts.view', manage: 'partners.accounts.manage' },
    fields: {
      name: v.text(160, 1), tier: v.enum(['registered', 'silver', 'gold', 'platinum']), commission_percent: { type: 'number', minimum: 0, maximum: 100 },
      contact_name: nullable(v.text(120)), email: nullable(v.email), phone: nullable(v.text(32)), city: nullable(v.text(80)),
      status: v.enum(['active', 'inactive']), notes: v.text(5000, 0),
    },
    required: ['name'], search: ['name', 'contact_name', 'email', 'city'], filters: { tier: v.enum(['registered', 'silver', 'gold', 'platinum']), status: v.enum(['active', 'inactive']) },
    defaultSort: 'name ASC', uniqueMessage: 'A partner with that name already exists.',
    columns: `t.*,
      (SELECT count(*)::int FROM partner_deals d WHERE d.partner_id = t.id) AS deals,
      (SELECT COALESCE(sum(won_value), 0) FROM partner_deals d WHERE d.partner_id = t.id AND d.status = 'won')::numeric(14,2) AS won_value,
      (SELECT COALESCE(sum(amount), 0) FROM partner_commissions c WHERE c.partner_id = t.id AND c.status <> 'paid')::numeric(14,2) AS commission_due`,
    shape: (row) => ({ ...row, portal_url: `${config.appUrl}/partner/${row.portal_token}` }),
    hooks: {
      beforeCreate: (tx, data) => ({ ...data, portal_token: publicToken() }),
      async beforeDelete(tx, old) {
        if (await tx.one(`SELECT 1 FROM partner_deals WHERE partner_id = $1 LIMIT 1`, [old.id])) throw badRequest('This partner has registered deals. Mark them inactive instead.');
      },
    },
  });

  const partnerParams = { params: params({ id: v.id('ptn') }) };
  app.post('/partners/accounts/:id/rotate-link', { preHandler: guard('partners.accounts.manage'), schema: partnerParams }, async (request) => {
    const row = await db.one(`UPDATE partners SET portal_token = $3, updated_at = now() WHERE org_id = $1 AND id = $2 RETURNING id`, [request.ctx.orgId, request.params.id, publicToken()]);
    if (!row) throw notFound('Partner');
    return { data: await partners.load(db, request.ctx.orgId, row.id).then((r) => ({ ...r, portal_url: `${config.appUrl}/partner/${r.portal_token}` })) };
  });

  app.post('/partners/accounts/:id/send-link', { preHandler: guard('partners.accounts.manage'), schema: partnerParams }, async (request) => {
    const { orgId, userId } = request.ctx;
    const p = await partners.load(db, orgId, request.params.id);
    if (!p.email) throw badRequest('Add the partner’s email first.');
    const org = await orgProfile(orgId);
    await db.transaction(async (tx) => {
      tx.emit({ type: EVENTS.NOTIFICATION_REQUESTED, org_id: orgId, actor_id: userId, data: { channel: 'email', to: p.email, template: 'partner_portal', payload: { company: org.name, link: `${config.appUrl}/partner/${p.portal_token}` } } });
    });
    return { data: { sent: true } };
  });

  // ── deal registrations ────────────────────────────────────────────────────
  const dealParams = { params: params({ id: v.id('pdl') }) };
  async function deal(store, orgId, dealId, lock = false) {
    const row = await store.one(
      `SELECT d.*, p.name AS partner_name, p.commission_percent FROM partner_deals d JOIN partners p ON p.id = d.partner_id
        WHERE d.org_id = $1 AND d.id = $2${lock ? ' FOR UPDATE OF d' : ''}`,
      [orgId, dealId],
    );
    if (!row) throw notFound('Deal registration');
    return row;
  }

  app.get('/partners/deals', {
    preHandler: guard('partners.deals.view'),
    schema: { querystring: query({ status: v.enum(['submitted', 'approved', 'rejected', 'won', 'lost']), partner_id: v.id('ptn') }) },
  }, async (request) => {
    const values = [request.ctx.orgId];
    const where = ['d.org_id = $1'];
    for (const key of ['status', 'partner_id']) if (request.query[key]) { values.push(request.query[key]); where.push(`d.${key} = $${values.length}`); }
    if (request.query.q) { values.push(`%${request.query.q}%`); where.push(`(d.number ILIKE $${values.length} OR d.customer_company ILIKE $${values.length} OR p.name ILIKE $${values.length})`); }
    const rows = await db.rows(
      `SELECT d.*, p.name AS partner_name FROM partner_deals d JOIN partners p ON p.id = d.partner_id WHERE ${where.join(' AND ')}
        ORDER BY CASE d.status WHEN 'submitted' THEN 0 ELSE 1 END, d.created_at DESC LIMIT 200`,
      values,
    );
    return { data: rows };
  });

  app.get('/partners/deals/:id', { preHandler: guard('partners.deals.view'), schema: dealParams }, async (request) => {
    const row = await deal(db, request.ctx.orgId, request.params.id);
    const commission = await db.one(`SELECT * FROM partner_commissions WHERE partner_deal_id = $1`, [row.id]);
    return { data: { ...row, commission } };
  });

  const dealFields = {
    customer_company: v.text(200, 1), customer_contact: nullable(v.text(120)), customer_email: nullable(v.email), customer_phone: nullable(v.text(32)),
    expected_value: amount, expected_close: nullable(v.date), description: v.text(5000, 0),
  };

  async function register(tx, { orgId, partner, b, source, userId = null, ipHash = null }) {
    // The same customer registered twice by the same partner while open is one registration.
    const dup = await tx.one(
      `SELECT id FROM partner_deals WHERE org_id = $1 AND partner_id = $2 AND lower(customer_company) = lower($3) AND status IN ('submitted', 'approved')`,
      [orgId, partner.id, b.customer_company.trim()],
    );
    if (dup) throw new ApiError(409, 'conflict', 'This customer is already registered by you and still open.');
    const row = await tx.one(
      `INSERT INTO partner_deals (id, org_id, number, partner_id, customer_company, customer_contact, customer_email, customer_phone, expected_value, expected_close,
                                  description, source, ip_hash, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [id('pdl'), orgId, await nextSalesNumber(tx, orgId, 'partner_deal', 'PD'), partner.id, b.customer_company.trim(), b.customer_contact ?? null,
        b.customer_email?.toLowerCase() ?? null, b.customer_phone ?? null, toRupees(toPaise(b.expected_value ?? 0)), b.expected_close ?? null, b.description ?? '', source, ipHash, userId],
    );
    tx.emit({ type: EVENTS.PARTNER_DEAL_REGISTERED, org_id: orgId, actor_id: userId, data: { partner_deal_id: row.id, number: row.number, partner_name: partner.name, customer_company: row.customer_company, expected_value: row.expected_value } });
    return row;
  }

  app.post('/partners/deals', {
    preHandler: guard('partners.deals.view'),
    schema: { body: body({ partner_id: v.id('ptn'), ...dealFields }, ['partner_id', 'customer_company']) },
  }, async (request, reply) => {
    const { orgId, userId } = request.ctx;
    const row = await db.transaction(async (tx) => {
      const partner = await partners.load(tx, orgId, request.body.partner_id);
      if (partner.status !== 'active') throw badRequest(`${partner.name} is inactive.`);
      return register(tx, { orgId, partner, b: request.body, source: 'internal', userId });
    });
    return reply.status(201).send({ data: row });
  });

  // Approve (→ CRM lead), reject (with a reason), mark won (→ commission) or lost.
  app.post('/partners/deals/:id/decision', {
    preHandler: guard('partners.deals.approve'),
    schema: { ...dealParams, body: body({ decision: v.enum(['approve', 'reject', 'won', 'lost']), note: v.text(1000, 0), won_value: amount }, ['decision']) },
  }, async (request) => {
    const { orgId, userId } = request.ctx;
    const b = request.body;
    const row = await db.transaction(async (tx) => {
      const d = await deal(tx, orgId, request.params.id, true);
      const allowed = { approve: ['submitted'], reject: ['submitted'], won: ['approved'], lost: ['approved'] }[b.decision];
      if (!allowed.includes(d.status)) throw badRequest(`A registration that is ${d.status} cannot be marked ${b.decision === 'approve' ? 'approved' : b.decision}.`);
      if (b.decision === 'reject' && !b.note?.trim()) throw badRequest('Tell the partner why — they will see this.');
      if (b.decision === 'approve') {
        const [first, ...rest] = (d.customer_contact || d.customer_company).split(/\s+/);
        const lead = await insertLead(tx, {
          orgId, actorId: userId,
          fields: {
            first_name: first, last_name: rest.join(' ') || null, company_name: d.customer_company, email: d.customer_email, phone: d.customer_phone,
            source: 'partner', estimated_value: d.expected_value, owner_user_id: userId,
            notes: `Registered by partner ${d.partner_name} (${d.number}).${d.description ? `\n\n${d.description}` : ''}`,
          },
        });
        await tx.query(`UPDATE partner_deals SET status = 'approved', lead_id = $2, decision_note = $3, decided_by = $4, decided_at = now(), updated_at = now() WHERE id = $1`, [d.id, lead.id, b.note || null, userId]);
        tx.emit({ type: EVENTS.PARTNER_DEAL_APPROVED, org_id: orgId, actor_id: userId, data: { partner_deal_id: d.id, number: d.number, partner_name: d.partner_name, lead_id: lead.id } });
      } else if (b.decision === 'won') {
        const value = toPaise(b.won_value ?? d.expected_value);
        if (value <= 0) throw badRequest('Enter the value of the won deal.');
        const commission = Math.round((value * Number(d.commission_percent)) / 100);
        await tx.query(`UPDATE partner_deals SET status = 'won', won_value = $2, decision_note = COALESCE($3, decision_note), decided_by = $4, decided_at = now(), updated_at = now() WHERE id = $1`, [d.id, toRupees(value), b.note || null, userId]);
        await tx.query(
          `INSERT INTO partner_commissions (id, org_id, partner_id, partner_deal_id, base_amount, percent, amount) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
          [id('pcm'), orgId, d.partner_id, d.id, toRupees(value), d.commission_percent, toRupees(commission)],
        );
      } else {
        await tx.query(`UPDATE partner_deals SET status = $2, decision_note = $3, decided_by = $4, decided_at = now(), updated_at = now() WHERE id = $1`, [d.id, b.decision === 'reject' ? 'rejected' : 'lost', b.note || null, userId]);
      }
      return deal(tx, orgId, d.id);
    });
    return { data: row };
  });

  // ── commissions ───────────────────────────────────────────────────────────
  app.get('/partners/commissions', {
    preHandler: guard('partners.commissions.view'),
    schema: { querystring: query({ status: v.enum(['pending', 'approved', 'paid']), partner_id: v.id('ptn') }) },
  }, async (request) => {
    const values = [request.ctx.orgId];
    const where = ['c.org_id = $1'];
    for (const key of ['status', 'partner_id']) if (request.query[key]) { values.push(request.query[key]); where.push(`c.${key} = $${values.length}`); }
    const [rows, totals] = await Promise.all([
      db.rows(
        `SELECT c.*, p.name AS partner_name, d.number AS deal_number, d.customer_company FROM partner_commissions c
           JOIN partners p ON p.id = c.partner_id JOIN partner_deals d ON d.id = c.partner_deal_id
          WHERE ${where.join(' AND ')} ORDER BY c.created_at DESC LIMIT 200`,
        values,
      ),
      db.one(
        `SELECT COALESCE(sum(amount) FILTER (WHERE status = 'pending'), 0)::numeric(14,2) AS pending,
                COALESCE(sum(amount) FILTER (WHERE status = 'approved'), 0)::numeric(14,2) AS approved,
                COALESCE(sum(amount) FILTER (WHERE status = 'paid'), 0)::numeric(14,2) AS paid
           FROM partner_commissions WHERE org_id = $1`,
        [request.ctx.orgId],
      ),
    ]);
    return { data: rows, meta: totals };
  });

  app.post('/partners/commissions/:id/status', {
    preHandler: guard('partners.commissions.manage'),
    schema: { params: params({ id: v.id('pcm') }), body: body({ status: v.enum(['approved', 'paid']), reference: v.text(120, 0) }, ['status']) },
  }, async (request) => {
    const { orgId, userId } = request.ctx;
    const from = request.body.status === 'approved' ? ['pending'] : ['approved'];
    const row = await db.one(
      `UPDATE partner_commissions SET status = $3, approved_by = CASE WHEN $3 = 'approved' THEN $4 ELSE approved_by END,
              paid_at = CASE WHEN $3 = 'paid' THEN now() ELSE paid_at END, reference = COALESCE(NULLIF($5, ''), reference), updated_at = now()
        WHERE org_id = $1 AND id = $2 AND status = ANY($6) RETURNING *`,
      [orgId, request.params.id, request.body.status, userId, request.body.reference ?? '', from],
    );
    if (!row) throw badRequest(request.body.status === 'paid' ? 'Approve the commission before paying it.' : 'Only a pending commission can be approved.');
    return { data: row };
  });

  resource(app, {
    path: '/partners/collateral', table: 'partner_collateral', prefix: 'pcol', appSlug: 'partners', label: 'Document',
    permissions: { view: 'partners.accounts.view', manage: 'partners.accounts.manage' },
    fields: { title: v.text(160, 1), url: { type: 'string', format: 'uri', maxLength: 1000 }, description: v.text(1000, 0) },
    required: ['title', 'url'], search: ['title'], defaultSort: 'created_at DESC',
  });

  // ══════════════════════════════════════════════════════ THE PARTNER'S PORTAL
  const tokenParams = { params: { type: 'object', properties: { token: { type: 'string', pattern: '^[A-Za-z0-9_-]{16,64}$' } }, required: ['token'] } };
  async function byToken(token) {
    const partner = await db.one(`SELECT * FROM partners WHERE portal_token = $1 AND status = 'active'`, [token]);
    if (!partner) throw notFound('Partner portal');
    return partner;
  }

  app.get('/partner-portal/:token', { schema: tokenParams }, async (request) => {
    const partner = await byToken(request.params.token);
    const [org, deals, commissions, collateral] = await Promise.all([
      orgProfile(partner.org_id),
      db.rows(
        `SELECT number, customer_company, expected_value, expected_close, status, decision_note, won_value, created_at FROM partner_deals
          WHERE partner_id = $1 ORDER BY created_at DESC LIMIT 200`,
        [partner.id],
      ),
      db.rows(
        `SELECT c.amount, c.status, c.paid_at, c.created_at, d.number, d.customer_company FROM partner_commissions c JOIN partner_deals d ON d.id = c.partner_deal_id
          WHERE c.partner_id = $1 ORDER BY c.created_at DESC`,
        [partner.id],
      ),
      db.rows(`SELECT title, url, description FROM partner_collateral WHERE org_id = $1 ORDER BY created_at DESC`, [partner.org_id]),
    ]);
    return {
      data: {
        vendor: { name: org.name, logo_url: org.logo_url ?? null },
        partner: { name: partner.name, tier: partner.tier, commission_percent: partner.commission_percent },
        deals, commissions, collateral,
      },
    };
  });

  app.post('/partner-portal/:token/deals', {
    schema: { ...tokenParams, body: body({ ...dealFields, website: v.text(200, 0) }, ['customer_company']) },
  }, async (request, reply) => {
    if (request.body.website) return reply.status(201).send({ data: { received: true } });
    const partner = await byToken(request.params.token);
    const ipHash = createHash('sha256').update(`${request.ip}:${config.serviceToken}`).digest('hex').slice(0, 32);
    const recent = await db.one(`SELECT count(*)::int AS n FROM partner_deals WHERE partner_id = $1 AND created_at > now() - interval '10 minutes'`, [partner.id]);
    if (recent.n >= 10) throw new ApiError(429, 'rate_limited', 'Too many registrations in a short time. Try again in a few minutes.');
    const row = await db.transaction((tx) => register(tx, { orgId: partner.org_id, partner, b: request.body, source: 'portal', ipHash }));
    return reply.status(201).send({ data: { number: row.number, status: row.status } });
  });
}
