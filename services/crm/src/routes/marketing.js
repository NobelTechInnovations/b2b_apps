import { id } from '@nexus/db-kit';
import {
  body, params, validate as v, requireApp, requirePermission, badRequest, notFound, resource, nullable,
} from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';
import { publicToken, orgProfiles } from '../lib/sales.js';

const MAX_RECIPIENTS = 2000;
const URL_RE = /https?:\/\/[^\s<>"')]+/g;
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

const rulesSchema = body({
  status: { type: 'array', items: v.text(20, 1), maxItems: 10 },
  source: { type: 'array', items: v.text(20, 1), maxItems: 10 },
  rating: { type: 'array', items: v.enum(['hot', 'warm', 'cold']), maxItems: 3 },
  tag: v.text(40, 0),
  created_after: v.date,
});

/**
 * Marketing: segments (live filters over leads or contacts), reusable
 * templates, and email campaigns with open, click and unsubscribe tracking.
 *
 * Every message carries an unsubscribe link, and an unsubscribed address is
 * never mailed again by this workspace — whichever segment it turns up in.
 */
export async function marketingRoutes(app) {
  const { db, config } = app;
  const orgProfile = orgProfiles(config);
  const guard = (permission) => [app.loadContext, requireApp('marketing'), requirePermission(permission)];

  /** Who a segment means right now: people with an email, minus the unsubscribed. */
  async function audience(store, orgId, segment, limit = MAX_RECIPIENTS + 1) {
    const r = segment.rules ?? {};
    const values = [orgId];
    const where = ['t.org_id = $1', `t.email IS NOT NULL`, `t.email <> ''`,
      `NOT EXISTS (SELECT 1 FROM marketing_unsubscribes u WHERE u.org_id = t.org_id AND u.email = lower(t.email))`];
    const add = (sql, value) => { values.push(value); where.push(sql.replace('?', `$${values.length}`)); };
    if (segment.source === 'leads') {
      if (r.status?.length) add('t.status = ANY(?)', r.status);
      if (r.source?.length) add('t.source = ANY(?)', r.source);
      if (r.rating?.length) add('t.rating = ANY(?)', r.rating);
    } else {
      where.push('t.archived_at IS NULL');
    }
    if (r.tag) add('? = ANY(t.tags)', r.tag);
    if (r.created_after) add('t.created_at >= ?::date', r.created_after);
    const table = segment.source === 'leads' ? 'leads' : 'contacts';
    const rows = await store.rows(
      `SELECT DISTINCT ON (lower(t.email)) t.id, lower(t.email) AS email, t.first_name, t.last_name
         FROM ${table} t WHERE ${where.join(' AND ')} ORDER BY lower(t.email), t.created_at DESC LIMIT ${limit}`,
      values,
    );
    return rows.map((row) => ({ ...row, kind: segment.source === 'leads' ? 'lead' : 'contact' }));
  }

  const segments = resource(app, {
    path: '/marketing/segments', table: 'marketing_segments', prefix: 'seg', appSlug: 'marketing', label: 'Segment',
    permissions: { view: 'marketing.segments.view', manage: 'marketing.segments.manage' },
    fields: { name: v.text(120, 1), description: v.text(1000, 0), source: v.enum(['leads', 'contacts']), rules: rulesSchema },
    required: ['name'], json: ['rules'], search: ['name'], defaultSort: 'name ASC',
  });

  app.get('/marketing/segments/:id/preview', { preHandler: guard('marketing.segments.view'), schema: { params: params({ id: v.id('seg') }) } }, async (request) => {
    const segment = await segments.load(db, request.ctx.orgId, request.params.id);
    const people = await audience(db, request.ctx.orgId, segment);
    return { data: { count: Math.min(people.length, MAX_RECIPIENTS), capped: people.length > MAX_RECIPIENTS, sample: people.slice(0, 10).map((p) => ({ email: p.email, name: [p.first_name, p.last_name].filter(Boolean).join(' ') })) } };
  });

  resource(app, {
    path: '/marketing/templates', table: 'marketing_templates', prefix: 'mtpl', appSlug: 'marketing', label: 'Template',
    permissions: { view: 'marketing.campaigns.view', manage: 'marketing.campaigns.edit' },
    fields: { name: v.text(120, 1), subject: v.text(200, 1), body: v.text(20000, 1) },
    required: ['name', 'subject', 'body'], search: ['name', 'subject'], defaultSort: 'name ASC',
  });

  const campaigns = resource(app, {
    path: '/marketing/campaigns', table: 'marketing_campaigns', prefix: 'cmpn', appSlug: 'marketing', label: 'Campaign',
    permissions: { view: 'marketing.campaigns.view', create: 'marketing.campaigns.create', edit: 'marketing.campaigns.edit', delete: 'marketing.campaigns.delete' },
    fields: { name: v.text(160, 1), segment_id: nullable(v.id('seg')), subject: v.text(200, 0), body: v.text(20000, 0) },
    required: ['name'], search: ['name', 'subject'], filters: { status: v.enum(['draft', 'scheduled', 'sending', 'sent', 'cancelled']) },
    defaultSort: 'created_at DESC',
    columns: 't.*, s.name AS segment_name',
    from: 'marketing_campaigns t LEFT JOIN marketing_segments s ON s.id = t.segment_id',
    shape: (row) => ({
      ...row,
      open_rate: row.recipients ? Math.round((1000 * row.opened) / row.recipients) / 10 : null,
      click_rate: row.recipients ? Math.round((1000 * row.clicked) / row.recipients) / 10 : null,
    }),
    hooks: {
      async beforeCreate(tx, data, request) {
        if (data.segment_id && !(await tx.one(`SELECT 1 FROM marketing_segments WHERE org_id = $1 AND id = $2`, [request.ctx.orgId, data.segment_id]))) throw badRequest('Choose one of this workspace’s segments.');
        return data;
      },
      async beforeUpdate(tx, data, old) {
        if (!['draft', 'scheduled'].includes(old.status)) throw badRequest('A sent campaign cannot be changed.');
        return data;
      },
      async beforeDelete(tx, old) {
        if (['sending', 'sent'].includes(old.status)) throw badRequest('Sent campaigns are kept for their results.');
      },
    },
  });

  const merge = (text, person, org) => String(text ?? '')
    .replace(/\{\{\s*first_name\s*\}\}/g, person.first_name || 'there')
    .replace(/\{\{\s*name\s*\}\}/g, [person.first_name, person.last_name].filter(Boolean).join(' ') || 'there')
    .replace(/\{\{\s*company\s*\}\}/g, org.name ?? '');

  /** Send a campaign now. Recipients are fixed at this moment. */
  async function send(campaignId, orgId, actorId) {
    return db.transaction(async (tx) => {
      const c = await campaigns.load(tx, orgId, campaignId, { lock: true });
      if (!['draft', 'scheduled'].includes(c.status)) throw badRequest(`This campaign is ${c.status}.`);
      if (!c.segment_id) throw badRequest('Choose who to send it to.');
      if (!c.subject.trim() || !c.body.trim()) throw badRequest('Write the subject and the message first.');
      const segment = await segments.load(tx, orgId, c.segment_id);
      const people = await audience(tx, orgId, segment);
      if (people.length > MAX_RECIPIENTS) throw badRequest(`This segment has more than ${MAX_RECIPIENTS} people. Narrow it, or split the campaign.`);
      if (!people.length) throw badRequest('Nobody in this segment has an email address (or everyone has unsubscribed).');
      const org = await orgProfile(orgId);
      for (const person of people) {
        const token = publicToken();
        await tx.query(
          `INSERT INTO marketing_recipients (id, org_id, campaign_id, email, name, lead_id, contact_id, token) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
          [id('mrc'), orgId, c.id, person.email, [person.first_name, person.last_name].filter(Boolean).join(' ') || null,
            person.kind === 'lead' ? person.id : null, person.kind === 'contact' ? person.id : null, token],
        );
        // Links are rewritten through the click counter; only these exact
        // links can be followed through it.
        const text = merge(c.body, person, org).replace(URL_RE, (url) => `${config.appUrl}/api/mkt/c/${token}?u=${encodeURIComponent(url)}`);
        tx.emit({
          type: EVENTS.NOTIFICATION_REQUESTED, org_id: orgId, actor_id: actorId,
          data: {
            channel: 'email', to: person.email, template: 'campaign',
            payload: {
              subject: merge(c.subject, person, org), heading: merge(c.subject, person, org), text, company: org.name,
              unsubscribe_url: `${config.appUrl}/unsubscribe/${token}`, pixel_url: `${config.appUrl}/api/mkt/o/${token}`,
            },
          },
        });
      }
      await tx.query(`UPDATE marketing_campaigns SET status = 'sent', sent_at = now(), recipients = $2, updated_at = now() WHERE id = $1`, [c.id, people.length]);
      tx.emit({ type: EVENTS.CAMPAIGN_SENT, org_id: orgId, actor_id: actorId, data: { campaign_id: c.id, name: c.name, recipients: people.length } });
      return campaigns.load(tx, orgId, c.id);
    });
  }

  const cParams = { params: params({ id: v.id('cmpn') }) };
  app.post('/marketing/campaigns/:id/send', { preHandler: guard('marketing.campaigns.send'), schema: cParams }, async (request) => ({
    data: await send(request.params.id, request.ctx.orgId, request.ctx.userId),
  }));

  app.post('/marketing/campaigns/:id/schedule', {
    preHandler: guard('marketing.campaigns.send'), schema: { ...cParams, body: body({ scheduled_at: nullable(v.datetime) }, ['scheduled_at']) },
  }, async (request) => {
    const { orgId } = request.ctx;
    const at = request.body.scheduled_at;
    if (at && new Date(at) < new Date(Date.now() - 60_000)) throw badRequest('Choose a time in the future.');
    const row = await db.one(
      `UPDATE marketing_campaigns SET status = $3, scheduled_at = $4, updated_at = now() WHERE org_id = $1 AND id = $2 AND status IN ('draft', 'scheduled') RETURNING id`,
      [orgId, request.params.id, at ? 'scheduled' : 'draft', at],
    );
    if (!row) throw badRequest('Only a draft can be scheduled.');
    return { data: await campaigns.load(db, orgId, row.id) };
  });

  // A test to yourself, before the real thing.
  app.post('/marketing/campaigns/:id/test', { preHandler: guard('marketing.campaigns.edit'), schema: cParams }, async (request) => {
    const { orgId, userId } = request.ctx;
    const c = await campaigns.load(db, orgId, request.params.id);
    const to = request.auth?.email;
    if (!to) throw badRequest('Your account has no email address.');
    const org = await orgProfile(orgId);
    await db.transaction(async (tx) => {
      tx.emit({
        type: EVENTS.NOTIFICATION_REQUESTED, org_id: orgId, actor_id: userId,
        data: { channel: 'email', to, template: 'campaign', payload: { subject: `[Test] ${merge(c.subject, { first_name: 'Test' }, org)}`, text: merge(c.body, { first_name: 'Test' }, org), company: org.name, unsubscribe_url: `${config.appUrl}/unsubscribe/test` } },
      });
    });
    return { data: { sent_to: to } };
  });

  // Scheduled campaigns go out on their own.
  const timer = setInterval(async () => {
    try {
      const due = await db.rows(`SELECT id, org_id, created_by FROM marketing_campaigns WHERE status = 'scheduled' AND scheduled_at <= now() LIMIT 20`);
      for (const c of due) {
        await send(c.id, c.org_id, c.created_by).catch(async (error) => {
          app.log.warn({ err: error, campaign: c.id }, 'scheduled campaign could not be sent');
          await db.query(`UPDATE marketing_campaigns SET status = 'draft', updated_at = now() WHERE id = $1 AND status = 'scheduled'`, [c.id]);
        });
      }
    } catch (error) {
      app.log.error({ err: error }, 'campaign scheduler failed');
    }
  }, 60_000);
  timer.unref?.();
  app.addHook('onClose', async () => clearInterval(timer));

  app.get('/marketing/performance', { preHandler: guard('marketing.reports.view') }, async (request) => {
    const { orgId } = request.ctx;
    const [recent, totals, leads] = await Promise.all([
      db.rows(`SELECT id, name, sent_at, recipients, opened, clicked, unsubscribed FROM marketing_campaigns WHERE org_id = $1 AND status = 'sent' ORDER BY sent_at DESC LIMIT 20`, [orgId]),
      db.one(
        `SELECT count(*)::int AS campaigns, COALESCE(sum(recipients), 0)::int AS recipients, COALESCE(sum(opened), 0)::int AS opened,
                COALESCE(sum(clicked), 0)::int AS clicked, COALESCE(sum(unsubscribed), 0)::int AS unsubscribed
           FROM marketing_campaigns WHERE org_id = $1 AND status = 'sent' AND sent_at > now() - interval '90 days'`,
        [orgId],
      ),
      db.rows(`SELECT source, count(*)::int AS n FROM leads WHERE org_id = $1 AND created_at > now() - interval '30 days' GROUP BY source ORDER BY n DESC`, [orgId]),
    ]);
    const rate = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);
    return {
      data: {
        totals: { ...totals, open_rate: rate(totals.opened, totals.recipients), click_rate: rate(totals.clicked, totals.recipients) },
        campaigns: recent.map((c) => ({ ...c, open_rate: rate(c.opened, c.recipients), click_rate: rate(c.clicked, c.recipients) })),
        leads_by_source: leads,
      },
    };
  });

  app.get('/marketing/widgets', { preHandler: guard('marketing.campaigns.view') }, async (request) => {
    const { orgId } = request.ctx;
    const [perf, leads] = await Promise.all([
      db.one(`SELECT COALESCE(sum(opened), 0)::int AS opened, COALESCE(sum(recipients), 0)::int AS recipients FROM marketing_campaigns WHERE org_id = $1 AND status = 'sent' AND sent_at > now() - interval '30 days'`, [orgId]),
      db.one(`SELECT count(*)::int AS n FROM leads WHERE org_id = $1 AND created_at > now() - interval '7 days'`, [orgId]),
    ]);
    return { data: { 'marketing.campaign_perf': perf.recipients ? `${Math.round((100 * perf.opened) / perf.recipients)}% opened` : '—', 'marketing.new_leads': leads.n } };
  });

  // ══════════════════════════════════════ TRACKING AND UNSUBSCRIBE (no account)
  const tokenParams = { params: { type: 'object', properties: { token: { type: 'string', pattern: '^[A-Za-z0-9_-]{16,64}$' } }, required: ['token'] } };
  const recipient = (token) => db.one(
    `SELECT r.*, c.body, c.org_id AS campaign_org FROM marketing_recipients r JOIN marketing_campaigns c ON c.id = r.campaign_id WHERE r.token = $1`,
    [token],
  );

  app.get('/mkt/o/:token', { schema: tokenParams }, async (request, reply) => {
    const r = await recipient(request.params.token).catch(() => null);
    if (r && !r.opened_at) {
      const first = await db.one(`UPDATE marketing_recipients SET opened_at = now() WHERE id = $1 AND opened_at IS NULL RETURNING id`, [r.id]);
      if (first) await db.query(`UPDATE marketing_campaigns SET opened = opened + 1 WHERE id = $1`, [r.campaign_id]);
    }
    reply.header('content-type', 'image/gif').header('cache-control', 'no-store, max-age=0');
    return reply.send(PIXEL);
  });

  app.get('/mkt/c/:token', {
    schema: { ...tokenParams, querystring: { type: 'object', properties: { u: { type: 'string', maxLength: 2000 } }, required: ['u'], additionalProperties: false } },
  }, async (request, reply) => {
    const r = await recipient(request.params.token);
    if (!r) throw notFound('Link');
    // Only a link that is really in this campaign may be followed — the
    // counter must never become an open redirect.
    const allowed = new Set(String(r.body).match(URL_RE) ?? []);
    if (!allowed.has(request.query.u)) throw badRequest('This link is not part of the message.');
    if (!r.clicked_at) {
      const first = await db.one(`UPDATE marketing_recipients SET clicked_at = now(), opened_at = COALESCE(opened_at, now()) WHERE id = $1 AND clicked_at IS NULL RETURNING id`, [r.id]);
      if (first) await db.query(`UPDATE marketing_campaigns SET clicked = clicked + 1, opened = opened + CASE WHEN $2 THEN 0 ELSE 1 END WHERE id = $1`, [r.campaign_id, Boolean(r.opened_at)]);
    }
    return reply.redirect(request.query.u, 302);
  });

  app.get('/mkt/u/:token', { schema: tokenParams }, async (request) => {
    const r = await recipient(request.params.token);
    if (!r) throw notFound('Subscription');
    const org = await orgProfile(r.org_id);
    const done = await db.one(`SELECT 1 FROM marketing_unsubscribes WHERE org_id = $1 AND email = $2`, [r.org_id, r.email]);
    const [user, domain] = r.email.split('@');
    return { data: { company: org.name, email: `${user.slice(0, 2)}•••@${domain}`, unsubscribed: Boolean(done) } };
  });

  app.post('/mkt/u/:token', { schema: tokenParams }, async (request) => {
    const r = await recipient(request.params.token);
    if (!r) throw notFound('Subscription');
    const inserted = await db.one(
      `INSERT INTO marketing_unsubscribes (org_id, email, campaign_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING email`,
      [r.org_id, r.email, r.campaign_id],
    );
    if (inserted) await db.query(`UPDATE marketing_campaigns SET unsubscribed = unsubscribed + 1 WHERE id = $1`, [r.campaign_id]);
    return { data: { unsubscribed: true } };
  });
}
