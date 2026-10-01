import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { badRequest } from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';
import { intakeLeads, parseCsv, phoneKey, recordImport } from './lead-intake.js';

// ── secrets at rest ─────────────────────────────────────────────────────────
// Access tokens are encrypted with a key derived from the service token. If
// that token is ever rotated, connected sources ask to be reconnected.
let key = null;
const keyFor = (serviceToken) => (key ??= scryptSync(serviceToken, 'nexus-lead-sources', 32));

export function sealSecret(plain, serviceToken) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(serviceToken), iv);
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join(':');
}

export function openSecret(sealed, serviceToken) {
  const [version, iv, tag, body] = String(sealed ?? '').split(':');
  if (version !== 'v1') return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyFor(serviceToken), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ── Google Sheets ───────────────────────────────────────────────────────────
/**
 * A sheet's CSV export address, from whatever link someone pastes: the
 * editor link (with its tab's gid) or a "Publish to the web" link. Only
 * docs.google.com is ever fetched — this is a server fetching a URL a user
 * typed, so it must not be able to reach anything else.
 */
export function sheetCsvUrl(link) {
  let url;
  try { url = new URL(String(link).trim()); } catch { throw badRequest('Paste the Google Sheet’s link.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com' || !url.pathname.startsWith('/spreadsheets/')) {
    throw badRequest('That is not a Google Sheets link. It should start with https://docs.google.com/spreadsheets/');
  }
  const gid = url.searchParams.get('gid') ?? url.hash.match(/gid=(\d+)/)?.[1] ?? null;
  const published = url.pathname.match(/^\/spreadsheets\/d\/e\/([\w-]+)\//);
  if (published) return `https://docs.google.com/spreadsheets/d/e/${published[1]}/pub?output=csv${gid ? `&gid=${gid}` : ''}`;
  const sheet = url.pathname.match(/^\/spreadsheets\/d\/([\w-]+)/);
  if (!sheet) throw badRequest('That Google Sheets link is missing the sheet’s id.');
  return `https://docs.google.com/spreadsheets/d/${sheet[1]}/export?format=csv&gid=${gid ?? '0'}`;
}

const SHEET_HOSTS = (host) => host === 'docs.google.com' || host.endsWith('.googleusercontent.com');

export async function fetchSheet(link) {
  let url = sheetCsvUrl(link);
  for (let hop = 0; hop < 4; hop += 1) {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (!response) throw badRequest('Google Sheets did not answer. Try again in a minute.');
    if (response.status >= 300 && response.status < 400) {
      const next = new URL(response.headers.get('location') ?? '', url);
      if (next.protocol !== 'https:' || !SHEET_HOSTS(next.hostname)) throw badRequest('Google Sheets sent us somewhere unexpected.');
      // A sign-in page means the sheet is private.
      if (next.hostname === 'accounts.google.com' || next.pathname.includes('ServiceLogin')) throw sheetIsPrivate();
      url = next.toString();
      continue;
    }
    if (response.status === 401 || response.status === 403 || response.status === 404) throw sheetIsPrivate();
    if (!response.ok) throw badRequest(`Google Sheets answered ${response.status}. Check the link and try again.`);
    if ((response.headers.get('content-type') ?? '').includes('text/html')) throw sheetIsPrivate();
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > 10 * 1024 * 1024) throw badRequest('That sheet is larger than 10 MB. Split it, or import it as CSV files.');
    return parseCsv(await response.text());
  }
  throw badRequest('Google Sheets redirected too many times.');
}

const sheetIsPrivate = () => badRequest(
  'We could not open that sheet. In Google Sheets choose Share → General access → “Anyone with the link” (Viewer), then try again.',
);

// ── Meta lead ads ───────────────────────────────────────────────────────────
const GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? 'v23.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

async function graph(path, token, params = {}) {
  const url = path.startsWith('https://') ? new URL(path) : new URL(`${GRAPH}/${path}`);
  if (url.hostname !== 'graph.facebook.com') throw new Error('unexpected Graph API host');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  url.searchParams.set('access_token', token);
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!response) throw badRequest('Meta did not answer. Try again in a minute.');
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) {
    const message = body.error?.message ?? `Meta answered ${response.status}.`;
    const expired = body.error?.code === 190;
    throw badRequest(expired ? 'The Meta access token has expired or was revoked. Paste a new Page access token.' : `Meta: ${message}`);
  }
  return body;
}

/** Confirm a token can read this Page's lead forms; returns the Page and its forms. */
export async function inspectMetaPage(pageId, token) {
  const page = await graph(encodeURIComponent(pageId), token, { fields: 'id,name' });
  const forms = await graph(`${encodeURIComponent(page.id)}/leadgen_forms`, token, { fields: 'id,name,status', limit: '100' });
  return { page: { id: page.id, name: page.name }, forms: (forms.data ?? []).map((f) => ({ id: f.id, name: f.name, status: f.status })) };
}

/** Meta's answer list → one flat record, ready for field matching. */
export function flattenMetaLead(lead, formName) {
  const record = {};
  for (const answer of lead.field_data ?? []) {
    record[answer.name] = (answer.values ?? []).join(', ');
  }
  const context = [
    lead.campaign_name && `Campaign: ${lead.campaign_name}`,
    lead.ad_name && `Ad: ${lead.ad_name}`,
    lead.platform && `Platform: ${lead.platform === 'ig' ? 'Instagram' : lead.platform === 'fb' ? 'Facebook' : lead.platform}`,
    formName && `Form: ${formName}`,
  ].filter(Boolean).join(' · ');
  if (context) record['Meta ad'] = context;
  return record;
}

const LEAD_FIELDS = 'id,created_time,field_data,ad_name,campaign_name,form_id,platform';

export async function fetchMetaLead(leadgenId, token) {
  return graph(encodeURIComponent(leadgenId), token, { fields: LEAD_FIELDS });
}

/** New leads on each form since the cursor (first sync: the last 90 days, all Meta keeps). */
async function fetchMetaLeads(source, token) {
  const pageId = source.config.page_id;
  const { forms } = await inspectMetaPage(pageId, token);
  const wanted = source.config.form_ids?.length ? forms.filter((f) => source.config.form_ids.includes(f.id)) : forms;
  const cursor = { ...(source.sync_cursor?.forms ?? {}) };
  const records = [];
  for (const form of wanted) {
    const since = cursor[form.id] ?? Math.floor(Date.now() / 1000) - 90 * 86_400;
    let next = `${encodeURIComponent(form.id)}/leads`;
    let params = { fields: LEAD_FIELDS, limit: '100', filtering: [{ field: 'time_created', operator: 'GREATER_THAN', value: since }] };
    let newest = since;
    for (let pageNo = 0; next && pageNo < 50; pageNo += 1) {
      const page = await graph(next, token, params);
      for (const lead of page.data ?? []) {
        records.push({ lead, form });
        newest = Math.max(newest, Math.floor(Date.parse(lead.created_time) / 1000) || 0);
      }
      next = page.paging?.next ?? null;
      params = {};
    }
    cursor[form.id] = newest;
  }
  return { records, cursor: { forms: cursor } };
}

// ── syncing ─────────────────────────────────────────────────────────────────
export function intakeOptions(source) {
  return {
    mapping: Object.keys(source.field_map ?? {}).length ? source.field_map : null,
    assignTo: source.assign_to ?? [],
    assignCursor: source.assign_cursor ?? 0,
    stageId: source.stage_id,
    tags: source.tags ?? [],
  };
}

/** After an intake, move the round-robin on and count what arrived. */
export async function settleSource(db, source, result, extra = {}) {
  await db.query(
    `UPDATE lead_sources SET assign_cursor = $3, lead_count = lead_count + $4, last_synced_at = now(), syncing_at = NULL,
            last_error = NULL, status = CASE WHEN status = 'error' THEN 'active' ELSE status END,
            sync_cursor = COALESCE($5::jsonb, sync_cursor), updated_at = now()
      WHERE org_id = $1 AND id = $2`,
    [source.org_id, source.id, result.assignCursor, result.created, extra.cursor ? JSON.stringify(extra.cursor) : null],
  );
}

/**
 * Pull new leads from one Google Sheet or Meta source.
 *
 * Sheets: every row is identified by its email/phone (or, failing those, its
 * content), so re-reading the whole sheet only ever adds the new rows.
 */
export async function syncSource(db, source, { serviceToken, actorId = null }) {
  let rows;
  let origin;
  let cursor = null;
  if (source.kind === 'google_sheet') {
    const sheet = await fetchSheet(source.config.sheet_url);
    rows = sheet.rows;
    origin = {
      leadSource: 'google_sheet', sourceId: source.id, detail: `Sheet · ${source.name}`,
      extKey: (raw, lead) => `gs:${source.id}:${lead.email ?? phoneKey(lead.phone) ?? JSON.stringify(Object.values(raw)).slice(0, 150)}`,
    };
  } else if (source.kind === 'meta') {
    const token = openSecret(source.secret, serviceToken);
    if (!token) throw badRequest('Reconnect this Meta Page: its access token can no longer be read.');
    const pulled = await fetchMetaLeads(source, token);
    cursor = pulled.cursor;
    // `__` keys travel with the row for its source id but are never mapped.
    rows = pulled.records.map(({ lead, form }) => ({ ...flattenMetaLead(lead, form.name), __meta_id: lead.id }));
    origin = {
      leadSource: 'meta', sourceId: source.id, detail: `Meta · ${source.config.page_name ?? source.name}`,
      extKey: (raw) => `meta:${raw.__meta_id}`,
    };
  } else {
    throw badRequest('Webhook sources receive leads; there is nothing to pull.');
  }

  const result = await intakeLeads(db, {
    orgId: source.org_id, actorId, rows, ...intakeOptions(source), origin,
    onDuplicate: source.kind === 'meta' ? 'note' : 'skip',
  });
  await settleSource(db, source, result, { cursor });
  if (result.created || result.failed || actorId) {
    await recordImport(db, { orgId: source.org_id, sourceId: source.id, kind: source.kind, name: source.name, result, actorId });
  }
  return result;
}

/** Background: every few minutes, pull sources that are due. One runner per source at a time. */
export function startSourceSync(app, { everyMs = 5 * 60_000, intervalMinutes = 15 } = {}) {
  const { db, config } = app;
  const tick = async () => {
    try {
      const due = await db.rows(
        `UPDATE lead_sources SET syncing_at = now()
          WHERE id IN (
            SELECT id FROM lead_sources
             WHERE kind IN ('google_sheet', 'meta') AND auto_sync AND status <> 'paused'
               AND (syncing_at IS NULL OR syncing_at < now() - interval '15 minutes')
               AND (last_synced_at IS NULL OR last_synced_at < now() - make_interval(mins => $1))
             ORDER BY last_synced_at NULLS FIRST LIMIT 10
             FOR UPDATE SKIP LOCKED)
          RETURNING *`,
        [intervalMinutes],
      );
      for (const source of due) {
        try {
          await syncSource(db, source, { serviceToken: config.serviceToken });
        } catch (error) {
          const message = error.expose ? error.message : 'The sync failed. It will be retried.';
          app.log.warn({ err: error, source: source.id }, 'lead source sync failed');
          const wasHealthy = source.status !== 'error';
          await db.query(
            `UPDATE lead_sources SET status = 'error', last_error = $3, syncing_at = NULL, last_synced_at = now(), updated_at = now()
              WHERE org_id = $1 AND id = $2`,
            [source.org_id, source.id, message],
          );
          if (wasHealthy) {
            await db.transaction(async (tx) => {
              tx.emit({ type: EVENTS.LEAD_SOURCE_FAILED, org_id: source.org_id, actor_id: null, data: { source_id: source.id, name: source.name, kind: source.kind, error: message, created_by: source.created_by } });
            });
          }
        }
      }
    } catch (error) {
      app.log.error({ err: error }, 'lead source sync tick failed');
    }
  };
  const timer = setInterval(tick, everyMs);
  timer.unref?.();
  app.addHook('onClose', async () => clearInterval(timer));
}
