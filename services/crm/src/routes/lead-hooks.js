import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError, notFound } from '@nexus/service-kit';
import { intakeLeads } from '../lib/lead-intake.js';
import { fetchMetaLead, flattenMetaLead, intakeOptions, openSecret, settleSource } from '../lib/lead-sources.js';

const tokenParams = { params: { type: 'object', properties: { token: { type: 'string', pattern: '^[A-Za-z0-9_-]{16,64}$' } }, required: ['token'] } };

/**
 * Where other systems push leads in. No account: each source is reached by
 * its own unguessable link, and Meta's calls are checked against the app
 * secret's signature.
 *
 * Accepts JSON (one lead, a list, or `{ leads: [...] }`) and plain HTML-form
 * posts, plus IndiaMART's `{ RESPONSE: {...} }` push format.
 */
export async function leadHookRoutes(app) {
  const { db, config } = app;
  const recent = new Map();
  const limited = (key, max) => {
    const now = Date.now();
    const hits = (recent.get(key) ?? []).filter((t) => t > now - 600_000);
    hits.push(now);
    recent.set(key, hits);
    if (recent.size > 5000) recent.clear();
    return hits.length > max;
  };

  await app.register(async (hooks) => {
    // Meta signs the exact bytes it sent, so keep them alongside the parsed body.
    hooks.removeContentTypeParser('application/json');
    hooks.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, raw, done) => {
      request.rawBody = raw;
      try {
        done(null, raw.length ? JSON.parse(raw.toString('utf8')) : {});
      } catch (error) {
        error.statusCode = 400;
        done(error, undefined);
      }
    });
    hooks.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (request, raw, done) => {
      done(null, Object.fromEntries(new URLSearchParams(raw)));
    });
    hooks.addContentTypeParser('text/plain', { parseAs: 'string' }, (request, raw, done) => {
      try { done(null, JSON.parse(raw)); } catch { done(null, { message: raw }); }
    });

    // ── any system: Zapier, Make, Pabbly, Apps Script, IndiaMART, a website ──
    hooks.post('/lead-hooks/in/:token', { schema: tokenParams }, async (request, reply) => {
      const source = await db.one(`SELECT * FROM lead_sources WHERE token = $1 AND kind = 'webhook'`, [request.params.token]);
      if (!source) throw notFound('Lead source');
      if (source.status === 'paused') throw new ApiError(409, 'paused', 'This lead source is paused.');
      if (limited(source.id, 600)) throw new ApiError(429, 'rate_limited', 'Too many leads in ten minutes. Try again shortly.');

      const payload = request.body?.RESPONSE ?? request.body ?? {};
      const rows = (Array.isArray(payload) ? payload : Array.isArray(payload.leads) ? payload.leads : [payload])
        .filter((row) => row && typeof row === 'object' && !Array.isArray(row))
        .slice(0, 100)
        .map((row) => Object.fromEntries(Object.entries(row).filter(([, value]) => value === null || ['string', 'number', 'boolean'].includes(typeof value) || Array.isArray(value))));
      if (!rows.length) throw new ApiError(400, 'bad_request', 'Send the lead as a JSON object with fields such as name, phone and email.');

      const options = intakeOptions(source);
      const result = await intakeLeads(db, {
        orgId: source.org_id, rows, ...options,
        origin: {
          leadSource: 'webhook', sourceId: source.id, detail: source.name,
          // The sender's own id for the lead, when it has one, stops repeats.
          extKey: (raw) => {
            const ref = raw.UNIQUE_QUERY_ID ?? raw.unique_query_id ?? raw.lead_id ?? raw.leadid ?? raw.leadgen_id ?? raw.id;
            return ref === undefined || ref === null || ref === '' ? null : `wh:${source.id}:${ref}`;
          },
        },
        onDuplicate: 'note',
      });
      await settleSource(db, source, result);
      return reply.status(201).send({ received: rows.length, created: result.created, duplicates: result.duplicates, failed: result.failed });
    });

    // ── Meta lead ads, in real time ───────────────────────────────────────
    // One subscription for the whole platform (the Meta app), set in Meta's
    // developer dashboard. Without it, Meta sources are polled instead.
    hooks.get('/lead-hooks/meta', async (request, reply) => {
      const q = request.query ?? {};
      const expected = process.env.META_VERIFY_TOKEN;
      if (!expected || q['hub.mode'] !== 'subscribe' || q['hub.verify_token'] !== expected) {
        return reply.status(403).send({ error: { code: 'forbidden', message: 'Verification failed.' } });
      }
      return reply.type('text/plain').send(String(q['hub.challenge'] ?? ''));
    });

    hooks.post('/lead-hooks/meta', async (request, reply) => {
      const secret = process.env.META_APP_SECRET;
      const signature = String(request.headers['x-hub-signature-256'] ?? '');
      if (!secret || !request.rawBody || !signature.startsWith('sha256=')) {
        return reply.status(401).send({ error: { code: 'invalid_signature', message: 'Bad signature.' } });
      }
      const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(request.rawBody).digest('hex')}`);
      const given = Buffer.from(signature);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
        return reply.status(401).send({ error: { code: 'invalid_signature', message: 'Bad signature.' } });
      }

      const changes = (request.body?.entry ?? []).flatMap((entry) => entry.changes ?? [])
        .filter((change) => change.field === 'leadgen' && change.value?.leadgen_id && change.value?.page_id);
      // Answer Meta at once; fetching each lead happens after.
      reply.status(200).send({ received: changes.length });
      setImmediate(() => processMeta(changes).catch((error) => app.log.error({ err: error }, 'meta lead webhook failed')));
      return reply;
    });
  });

  async function processMeta(changes) {
    for (const change of changes) {
      const { leadgen_id: leadId, page_id: pageId, form_id: formId } = change.value;
      const sources = await db.rows(
        `SELECT * FROM lead_sources WHERE kind = 'meta' AND status <> 'paused' AND config->>'page_id' = $1`,
        [String(pageId)],
      );
      for (const source of sources) {
        const wanted = source.config.form_ids ?? [];
        if (wanted.length && formId && !wanted.includes(String(formId))) continue;
        const token = openSecret(source.secret, config.serviceToken);
        if (!token) continue;
        try {
          const lead = await fetchMetaLead(leadId, token);
          const formName = (source.config.forms ?? []).find((f) => f.id === String(lead.form_id ?? formId))?.name ?? null;
          const result = await intakeLeads(db, {
            orgId: source.org_id, rows: [{ ...flattenMetaLead(lead, formName), __meta_id: lead.id }], ...intakeOptions(source),
            origin: { leadSource: 'meta', sourceId: source.id, detail: `Meta · ${source.config.page_name ?? source.name}`, extKey: (raw) => `meta:${raw.__meta_id}` },
            onDuplicate: 'note',
          });
          await settleSource(db, source, result);
        } catch (error) {
          app.log.warn({ err: error, source: source.id }, 'meta lead fetch failed; the next poll will pick it up');
        }
      }
    }
  }
}
