import { randomBytes } from 'node:crypto';
import { id } from '@nexus/db-kit';
import {
  body, params, validate as v, requireApp, requirePermission, badRequest, notFound, nullable, peopleDirectory,
} from '@nexus/service-kit';
import { FIELD_TYPES, STANDARD_FIELDS, activeFields, ensureStages, fieldKey, suggestMapping } from '../lib/lead-fields.js';
import { MAX_IMPORT_ROWS, intakeLeads, parseCsv, recordImport } from '../lib/lead-intake.js';
import { fetchSheet, inspectMetaPage, sealSecret, syncSource, sheetCsvUrl, startSourceSync } from '../lib/lead-sources.js';

const COLORS = ['slate', 'blue', 'sky', 'cyan', 'teal', 'emerald', 'lime', 'amber', 'orange', 'rose', 'pink', 'violet', 'indigo'];
const TARGET = { type: 'string', pattern: '^(skip|full_name|first_name|last_name|phone|email|company_name|job_title|city|estimated_value|rating|notes|tags|owner_email|stage|custom\\.[a-z][a-z0-9_]{0,39})$' };
const mappingSchema = { type: 'object', additionalProperties: TARGET, maxProperties: 200 };
const newToken = () => randomBytes(18).toString('base64url');

/**
 * Leads setup: the workspace's own fields and stages, bulk import, and the
 * sources that feed leads in by themselves (Google Sheets, Meta, webhooks).
 */
export async function leadsAdminRoutes(app) {
  const { db, config } = app;
  const people = peopleDirectory({ tenancyUrl: config.tenancyUrl, serviceToken: config.serviceToken });
  const guard = (permission) => [app.loadContext, requireApp('leads'), requirePermission(permission)];
  const team = (orgId) => people.withPermission(orgId, 'leads.leads.view');

  async function assertTeam(orgId, userIds = []) {
    const ids = userIds.filter(Boolean);
    if (!ids.length) return;
    const members = new Set((await team(orgId)).map((p) => p.user_id));
    if (ids.some((userId) => !members.has(userId))) throw badRequest('Choose people who have access to Leads.');
  }

  async function assertMapping(orgId, mapping = {}) {
    const keys = new Set((await activeFields(db, orgId)).map((f) => `custom.${f.key}`));
    const targets = Object.values(mapping).filter((t) => t !== 'skip');
    const unknown = targets.filter((t) => t.startsWith('custom.') && !keys.has(t));
    if (unknown.length) throw badRequest(`Unknown field: ${unknown.join(', ')}.`);
    const twice = targets.find((t, i) => targets.indexOf(t) !== i);
    if (twice) throw badRequest(`Two columns are going into the same field (${twice.replace('custom.', '')}). Pick one.`);
  }

  async function assertStage(orgId, stageId) {
    if (!stageId) return;
    const stage = await db.one(`SELECT id FROM lead_stages WHERE org_id = $1 AND id = $2`, [orgId, stageId]);
    if (!stage) throw badRequest('That stage does not exist.');
  }

  // ═══════════════════════════════════════════════════════════════ FIELDS
  const fieldBody = {
    label: v.text(80, 1),
    type: v.enum(FIELD_TYPES),
    options: { type: 'array', items: v.text(80, 1), maxItems: 100 },
    required: v.bool,
    show_in_list: v.bool,
  };
  const checkOptions = (type, options) => {
    if (['select', 'multi_select'].includes(type) && !(options?.length >= 1)) throw badRequest('Add at least one option.');
    if (options && new Set(options.map((o) => o.toLowerCase())).size !== options.length) throw badRequest('Each option must be different.');
  };

  app.get('/leads/fields', { preHandler: guard('leads.leads.view') }, async (request) => ({ data: await activeFields(db, request.ctx.orgId) }));

  app.post('/leads/fields', { preHandler: guard('leads.settings.manage'), schema: { body: body(fieldBody, ['label', 'type']) } }, async (request, reply) => {
    const { orgId, userId } = request.ctx;
    const b = request.body;
    checkOptions(b.type, b.options);
    const base = fieldKey(b.label);
    if (STANDARD_FIELDS.some((f) => f.key === base)) throw badRequest(`Leads already have a ${b.label} field.`);
    const taken = new Set((await db.rows(`SELECT key FROM lead_fields WHERE org_id = $1`, [orgId])).map((r) => r.key));
    let key = base;
    for (let n = 2; taken.has(key); n += 1) key = `${base.slice(0, 36)}_${n}`;
    const position = await db.one(`SELECT COALESCE(max(position) + 1, 0) AS n FROM lead_fields WHERE org_id = $1`, [orgId]);
    const row = await db.one(
      `INSERT INTO lead_fields (id, org_id, key, label, type, options, required, show_in_list, position, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [id('lfld'), orgId, key, b.label.trim(), b.type, JSON.stringify(b.options ?? []), b.required ?? false, b.show_in_list ?? false, position.n, userId],
    );
    return reply.status(201).send({ data: row });
  });

  app.patch('/leads/fields/:id', {
    preHandler: guard('leads.settings.manage'),
    schema: { params: params({ id: v.id('lfld') }), body: body({ label: fieldBody.label, options: fieldBody.options, required: v.bool, show_in_list: v.bool }) },
  }, async (request) => {
    const field = await db.one(`SELECT * FROM lead_fields WHERE org_id = $1 AND id = $2 AND archived_at IS NULL`, [request.ctx.orgId, request.params.id]);
    if (!field) throw notFound('Field');
    const b = request.body;
    if (b.options) checkOptions(field.type, b.options);
    const row = await db.one(
      `UPDATE lead_fields SET label = COALESCE($3, label), options = COALESCE($4, options), required = COALESCE($5, required),
              show_in_list = COALESCE($6, show_in_list), updated_at = now()
        WHERE org_id = $1 AND id = $2 RETURNING *`,
      [field.org_id, field.id, b.label?.trim() ?? null, b.options ? JSON.stringify(b.options) : null, b.required ?? null, b.show_in_list ?? null],
    );
    return { data: row };
  });

  // Removing a field hides it; the values already entered stay on each lead.
  app.delete('/leads/fields/:id', { preHandler: guard('leads.settings.manage'), schema: { params: params({ id: v.id('lfld') }) } }, async (request) => {
    const row = await db.one(`UPDATE lead_fields SET archived_at = now() WHERE org_id = $1 AND id = $2 AND archived_at IS NULL RETURNING id`, [request.ctx.orgId, request.params.id]);
    if (!row) throw notFound('Field');
    return { data: { archived: true } };
  });

  const orderSchema = (prefix) => ({ body: body({ ids: { type: 'array', items: v.id(prefix), minItems: 1, maxItems: 200 } }, ['ids']) });
  app.put('/leads/fields/order', { preHandler: guard('leads.settings.manage'), schema: orderSchema('lfld') }, async (request) => {
    await db.query(
      `UPDATE lead_fields f SET position = o.n - 1, updated_at = now() FROM unnest($2::text[]) WITH ORDINALITY AS o(id, n)
        WHERE f.org_id = $1 AND f.id = o.id`,
      [request.ctx.orgId, request.body.ids],
    );
    return { data: await activeFields(db, request.ctx.orgId) };
  });

  // ═══════════════════════════════════════════════════════════════ STAGES
  const stageBody = { name: v.text(60, 1), color: v.enum(COLORS), kind: v.enum(['open', 'won', 'lost']) };
  const stageParams = { params: params({ id: v.id('lstg') }) };

  app.get('/leads/stages', { preHandler: guard('leads.leads.view') }, async (request) => {
    const stages = await ensureStages(db, request.ctx.orgId);
    const counts = await db.rows(`SELECT stage_id, count(*)::int AS n FROM leads WHERE org_id = $1 AND archived_at IS NULL GROUP BY stage_id`, [request.ctx.orgId]);
    const by = new Map(counts.map((c) => [c.stage_id, c.n]));
    return { data: stages.map((s) => ({ ...s, lead_count: by.get(s.id) ?? 0 })) };
  });

  const nameTaken = (error) => {
    if (error.name === 'UniqueViolation') throw badRequest('There is already a stage with that name.');
    throw error;
  };

  app.post('/leads/stages', { preHandler: guard('leads.settings.manage'), schema: { body: body(stageBody, ['name']) } }, async (request, reply) => {
    const { orgId, userId } = request.ctx;
    const stages = await ensureStages(db, orgId);
    // New stages go before Won/Lost, at the end of the open ones.
    const lastOpen = Math.max(-1, ...stages.filter((s) => s.kind === 'open').map((s) => s.position));
    const kind = request.body.kind ?? 'open';
    const position = kind === 'open' ? lastOpen + 1 : Math.max(...stages.map((s) => s.position)) + 1;
    const row = await db.transaction(async (tx) => {
      if (kind === 'open') await tx.query(`UPDATE lead_stages SET position = position + 1 WHERE org_id = $1 AND position >= $2`, [orgId, position]);
      return tx.one(
        `INSERT INTO lead_stages (id, org_id, name, color, kind, position, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [id('lstg'), orgId, request.body.name.trim(), request.body.color ?? 'slate', kind, position, userId],
      );
    }).catch(nameTaken);
    return reply.status(201).send({ data: row });
  });

  app.patch('/leads/stages/:id', { preHandler: guard('leads.settings.manage'), schema: { ...stageParams, body: body(stageBody) } }, async (request) => {
    const { orgId } = request.ctx;
    const stages = await ensureStages(db, orgId);
    const stage = stages.find((s) => s.id === request.params.id);
    if (!stage) throw notFound('Stage');
    if (request.body.kind && request.body.kind !== 'open' && stage.kind === 'open' && stages.filter((s) => s.kind === 'open').length === 1) {
      throw badRequest('Keep at least one open stage for new leads.');
    }
    const row = await db.one(
      `UPDATE lead_stages SET name = COALESCE($3, name), color = COALESCE($4, color), kind = COALESCE($5, kind), updated_at = now()
        WHERE org_id = $1 AND id = $2 RETURNING *`,
      [orgId, stage.id, request.body.name?.trim() ?? null, request.body.color ?? null, request.body.kind ?? null],
    ).catch(nameTaken);
    return { data: row };
  });

  app.delete('/leads/stages/:id', {
    preHandler: guard('leads.settings.manage'),
    schema: { ...stageParams, body: body({ move_to: v.id('lstg') }, ['move_to']) },
  }, async (request) => {
    const { orgId } = request.ctx;
    const stages = await ensureStages(db, orgId);
    const stage = stages.find((s) => s.id === request.params.id);
    const target = stages.find((s) => s.id === request.body.move_to);
    if (!stage) throw notFound('Stage');
    if (!target || target.id === stage.id) throw badRequest('Choose another stage for its leads.');
    if (stage.kind === 'open' && stages.filter((s) => s.kind === 'open').length === 1) throw badRequest('Keep at least one open stage for new leads.');
    await db.transaction(async (tx) => {
      await tx.query(`UPDATE leads SET stage_id = $3, updated_at = now() WHERE org_id = $1 AND stage_id = $2`, [orgId, stage.id, target.id]);
      await tx.query(`UPDATE lead_sources SET stage_id = $3 WHERE org_id = $1 AND stage_id = $2`, [orgId, stage.id, target.id]);
      await tx.query(`DELETE FROM lead_stages WHERE org_id = $1 AND id = $2`, [orgId, stage.id]);
    });
    return { data: { deleted: true } };
  });

  app.put('/leads/stages/order', { preHandler: guard('leads.settings.manage'), schema: orderSchema('lstg') }, async (request) => {
    await db.query(
      `UPDATE lead_stages s SET position = o.n - 1, updated_at = now() FROM unnest($2::text[]) WITH ORDINALITY AS o(id, n)
        WHERE s.org_id = $1 AND s.id = o.id`,
      [request.ctx.orgId, request.body.ids],
    );
    return { data: await ensureStages(db, request.ctx.orgId) };
  });

  // ═══════════════════════════════════════════════════════════════ IMPORT
  const importSource = { csv: { type: 'string', maxLength: 5 * 1024 * 1024 }, sheet_url: v.text(1000) };

  async function readImport(b) {
    if (b.sheet_url) return fetchSheet(b.sheet_url);
    if (!b.csv?.trim()) throw badRequest('Choose a CSV file or paste a Google Sheet link.');
    return parseCsv(b.csv);
  }

  app.post('/leads/import/preview', { preHandler: guard('leads.leads.import'), schema: { body: body(importSource) } }, async (request) => {
    const sheet = await readImport(request.body);
    if (!sheet.headers.length || !sheet.rows.length) throw badRequest('That file has no rows under its header line.');
    const fields = await activeFields(db, request.ctx.orgId);
    return {
      data: {
        headers: sheet.headers, sample: sheet.rows.slice(0, 5), total: sheet.rows.length, truncated: sheet.truncated,
        mapping: suggestMapping(sheet.headers, fields),
        targets: [...STANDARD_FIELDS, ...fields.map((f) => ({ key: `custom.${f.key}`, label: f.label }))],
        max_rows: MAX_IMPORT_ROWS,
      },
    };
  });

  app.post('/leads/import', {
    preHandler: guard('leads.leads.import'),
    schema: {
      body: body({
        ...importSource,
        name: v.text(160),
        mapping: mappingSchema,
        owner_user_id: nullable(v.id('usr')),
        assign_to: { type: 'array', items: v.id('usr'), maxItems: 100 },
        stage_id: nullable(v.id('lstg')),
        tags: { type: 'array', items: v.text(40), maxItems: 10 },
        // Keep a sheet connected, pulling new rows every 15 minutes.
        keep_synced: v.bool,
      }, ['mapping']),
    },
  }, async (request, reply) => {
    const { orgId, userId } = request.ctx;
    const b = request.body;
    await assertMapping(orgId, b.mapping);
    await assertTeam(orgId, [b.owner_user_id, ...(b.assign_to ?? [])]);
    await assertStage(orgId, b.stage_id);
    if (!Object.values(b.mapping).some((t) => ['full_name', 'first_name', 'phone', 'email'].includes(t))) {
      throw badRequest('Match at least one column to Name, Phone or Email.');
    }
    const name = b.name?.trim() || (b.sheet_url ? 'Google Sheet' : 'CSV import');

    let source = null;
    if (b.sheet_url && b.keep_synced) {
      source = await db.one(
        `INSERT INTO lead_sources (id, org_id, kind, name, config, field_map, assign_to, stage_id, tags, created_by)
         VALUES ($1,$2,'google_sheet',$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [id('lsrc'), orgId, name, JSON.stringify({ sheet_url: b.sheet_url.trim(), csv_url: sheetCsvUrl(b.sheet_url) }), JSON.stringify(b.mapping),
          b.assign_to ?? [], b.stage_id ?? null, b.tags ?? [], userId],
      );
    }

    const result = source
      ? await syncSource(db, source, { serviceToken: config.serviceToken, actorId: userId }).catch(async (error) => {
        // The sheet could not be read: do not leave a broken source behind.
        await db.query(`DELETE FROM lead_sources WHERE org_id = $1 AND id = $2`, [orgId, source.id]);
        throw error;
      })
      : await intakeLeads(db, {
        orgId, actorId: userId, rows: (await readImport(b)).rows, mapping: b.mapping,
        origin: { leadSource: b.sheet_url ? 'google_sheet' : 'import', detail: `${b.sheet_url ? 'Sheet' : 'CSV'} · ${name}` },
        ownerId: b.owner_user_id ?? null, assignTo: b.assign_to ?? [], stageId: b.stage_id ?? null, tags: b.tags ?? [],
      });
    const record = source ? null : await recordImport(db, { orgId, kind: b.sheet_url ? 'google_sheet' : 'csv', name, result, actorId: userId });
    return reply.status(201).send({
      data: { id: record?.id ?? null, source_id: source?.id ?? null, total: result.total, created: result.created, duplicates: result.duplicates, failed: result.failed, errors: result.errors },
    });
  });

  app.get('/leads/imports', { preHandler: guard('leads.leads.import') }, async (request) => {
    const rows = await db.rows(`SELECT * FROM lead_imports WHERE org_id = $1 ORDER BY created_at DESC LIMIT 50`, [request.ctx.orgId]);
    const names = await people.lookup(rows.map((r) => r.created_by));
    return { data: rows.map((r) => ({ ...r, by: r.created_by ? names.get(r.created_by) ?? null : null })) };
  });

  // ═══════════════════════════════════════════════════════════════ SOURCES
  const sourceParams = { params: params({ id: v.id('lsrc') }) };
  const webhookUrl = (token) => `${config.appUrl.replace(/\/$/, '')}/api/lead-hooks/in/${token}`;
  const present = (s) => {
    const { secret, token, sync_cursor: _cursor, ...rest } = s;
    return {
      ...rest,
      connected: s.kind !== 'meta' || Boolean(secret),
      webhook_url: s.kind === 'webhook' && token ? webhookUrl(token) : null,
    };
  };

  app.get('/leads/sources', { preHandler: guard('leads.settings.manage') }, async (request) => {
    const rows = await db.rows(`SELECT * FROM lead_sources WHERE org_id = $1 ORDER BY created_at DESC`, [request.ctx.orgId]);
    const forms = await db.rows(
      `SELECT id, name, status, response_count, last_response_at FROM forms WHERE org_id = $1 AND create_lead ORDER BY updated_at DESC`,
      [request.ctx.orgId],
    );
    return {
      data: rows.map(present),
      meta: {
        forms,
        meta_webhook: Boolean(process.env.META_APP_SECRET && process.env.META_VERIFY_TOKEN),
        meta_webhook_url: `${config.appUrl.replace(/\/$/, '')}/api/lead-hooks/meta`,
      },
    };
  });

  /** Check a Page token before saving it, and list the Page's lead forms to pick from. */
  app.post('/leads/sources/meta/inspect', {
    preHandler: guard('leads.settings.manage'),
    schema: { body: body({ page_id: { type: 'string', pattern: '^[0-9]{5,30}$' }, access_token: v.text(1000, 20) }, ['page_id', 'access_token']) },
  }, async (request) => ({ data: await inspectMetaPage(request.body.page_id, request.body.access_token.trim()) }));

  const sourceFields = {
    name: v.text(120, 1),
    sheet_url: v.text(1000),
    page_id: { type: 'string', pattern: '^[0-9]{5,30}$' },
    access_token: v.text(1000, 20),
    form_ids: { type: 'array', items: { type: 'string', pattern: '^[0-9]{5,30}$' }, maxItems: 100 },
    field_map: mappingSchema,
    assign_to: { type: 'array', items: v.id('usr'), maxItems: 100 },
    stage_id: nullable(v.id('lstg')),
    tags: { type: 'array', items: v.text(40), maxItems: 10 },
    auto_sync: v.bool,
  };

  app.post('/leads/sources', {
    preHandler: guard('leads.settings.manage'),
    schema: { body: body({ kind: v.enum(['google_sheet', 'meta', 'webhook']), ...sourceFields }, ['kind', 'name']) },
  }, async (request, reply) => {
    const { orgId, userId } = request.ctx;
    const b = request.body;
    await assertTeam(orgId, b.assign_to);
    await assertStage(orgId, b.stage_id);
    if (b.field_map) await assertMapping(orgId, b.field_map);
    let configJson = {};
    let secret = null;
    let token = null;
    let fieldMap = b.field_map ?? {};
    if (b.kind === 'google_sheet') {
      if (!b.sheet_url) throw badRequest('Paste the Google Sheet’s link.');
      const sheet = await fetchSheet(b.sheet_url);
      if (!Object.keys(fieldMap).length) fieldMap = suggestMapping(sheet.headers, await activeFields(db, orgId));
      configJson = { sheet_url: b.sheet_url.trim(), csv_url: sheetCsvUrl(b.sheet_url), headers: sheet.headers };
    } else if (b.kind === 'meta') {
      if (!b.page_id || !b.access_token) throw badRequest('Enter the Page ID and a Page access token.');
      const { page, forms } = await inspectMetaPage(b.page_id, b.access_token.trim());
      configJson = { page_id: page.id, page_name: page.name, form_ids: b.form_ids ?? [], forms };
      secret = sealSecret(b.access_token.trim(), config.serviceToken);
    } else {
      token = newToken();
    }
    const row = await db.one(
      `INSERT INTO lead_sources (id, org_id, kind, name, config, secret, token, field_map, assign_to, stage_id, tags, auto_sync, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [id('lsrc'), orgId, b.kind, b.name.trim(), JSON.stringify(configJson), secret, token, JSON.stringify(fieldMap),
        b.assign_to ?? [], b.stage_id ?? null, b.tags ?? [], b.auto_sync ?? true, userId],
    );
    return reply.status(201).send({ data: present(row) });
  });

  async function loadSource(orgId, sourceId) {
    const row = await db.one(`SELECT * FROM lead_sources WHERE org_id = $1 AND id = $2`, [orgId, sourceId]);
    if (!row) throw notFound('Lead source');
    return row;
  }

  app.patch('/leads/sources/:id', {
    preHandler: guard('leads.settings.manage'),
    schema: { ...sourceParams, body: body({ ...sourceFields, status: v.enum(['active', 'paused']) }) },
  }, async (request) => {
    const { orgId } = request.ctx;
    const b = request.body;
    const source = await loadSource(orgId, request.params.id);
    await assertTeam(orgId, b.assign_to);
    await assertStage(orgId, b.stage_id);
    if (b.field_map) await assertMapping(orgId, b.field_map);
    let configJson = source.config;
    let secret = source.secret;
    if (source.kind === 'google_sheet' && b.sheet_url) {
      const sheet = await fetchSheet(b.sheet_url);
      configJson = { ...configJson, sheet_url: b.sheet_url.trim(), csv_url: sheetCsvUrl(b.sheet_url), headers: sheet.headers };
    }
    if (source.kind === 'meta' && (b.access_token || b.form_ids)) {
      if (b.access_token) {
        const { page, forms } = await inspectMetaPage(b.page_id ?? source.config.page_id, b.access_token.trim());
        configJson = { ...configJson, page_id: page.id, page_name: page.name, forms };
        secret = sealSecret(b.access_token.trim(), config.serviceToken);
      }
      if (b.form_ids) configJson = { ...configJson, form_ids: b.form_ids };
    }
    const row = await db.one(
      `UPDATE lead_sources SET name = COALESCE($3, name), config = $4, secret = $5, field_map = COALESCE($6, field_map),
              assign_to = COALESCE($7, assign_to), stage_id = CASE WHEN $8 THEN $9 ELSE stage_id END, tags = COALESCE($10, tags),
              auto_sync = COALESCE($11, auto_sync),
              status = COALESCE($12, CASE WHEN $5 IS DISTINCT FROM secret THEN 'active' ELSE status END), updated_at = now()
        WHERE org_id = $1 AND id = $2 RETURNING *`,
      [orgId, source.id, b.name?.trim() ?? null, JSON.stringify(configJson), secret, b.field_map ? JSON.stringify(b.field_map) : null,
        b.assign_to ?? null, b.stage_id !== undefined, b.stage_id ?? null, b.tags ?? null, b.auto_sync ?? null, b.status ?? null],
    );
    return { data: present(row) };
  });

  app.delete('/leads/sources/:id', { preHandler: guard('leads.settings.manage'), schema: sourceParams }, async (request) => {
    const row = await db.one(`DELETE FROM lead_sources WHERE org_id = $1 AND id = $2 RETURNING id`, [request.ctx.orgId, request.params.id]);
    if (!row) throw notFound('Lead source');
    return { data: { deleted: true } };
  });

  app.post('/leads/sources/:id/sync', { preHandler: guard('leads.settings.manage'), schema: sourceParams }, async (request) => {
    const { orgId, userId } = request.ctx;
    const source = await db.one(
      `UPDATE lead_sources SET syncing_at = now() WHERE org_id = $1 AND id = $2
          AND (syncing_at IS NULL OR syncing_at < now() - interval '15 minutes') RETURNING *`,
      [orgId, request.params.id],
    );
    if (!source) {
      await loadSource(orgId, request.params.id);
      throw badRequest('A sync is already running for this source. Give it a minute.');
    }
    try {
      const result = await syncSource(db, source, { serviceToken: config.serviceToken, actorId: userId });
      return { data: { total: result.total, created: result.created, duplicates: result.duplicates, failed: result.failed, errors: result.errors } };
    } catch (error) {
      await db.query(
        `UPDATE lead_sources SET syncing_at = NULL, status = 'error', last_error = $3, updated_at = now() WHERE org_id = $1 AND id = $2`,
        [orgId, source.id, error.expose ? error.message : 'The sync failed.'],
      );
      throw error;
    }
  });

  app.post('/leads/sources/:id/rotate', { preHandler: guard('leads.settings.manage'), schema: sourceParams }, async (request) => {
    const source = await loadSource(request.ctx.orgId, request.params.id);
    if (source.kind !== 'webhook') throw badRequest('Only webhook sources have a link to replace.');
    const row = await db.one(`UPDATE lead_sources SET token = $3, updated_at = now() WHERE org_id = $1 AND id = $2 RETURNING *`, [source.org_id, source.id, newToken()]);
    return { data: present(row) };
  });

  startSourceSync(app);
}
