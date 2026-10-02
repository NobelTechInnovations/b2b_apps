import { id } from '@nexus/db-kit';
import { EVENTS } from '@nexus/contracts/events';
import { scoreFor } from './leads.js';
import { activeFields, cleanCustom, ensureStages, suggestMapping } from './lead-fields.js';

export const MAX_IMPORT_ROWS = 20_000;

/**
 * RFC 4180 CSV, as Excel and Google Sheets write it: quoted fields, doubled
 * quotes, line breaks inside quotes, a byte-order mark, and comma, semicolon
 * or tab separators (Excel in many locales saves with semicolons).
 */
export function parseCsv(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const firstLine = source.slice(0, source.indexOf('\n') === -1 ? undefined : source.indexOf('\n'));
  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length]);
  const delimiter = counts.sort((a, b) => b[1] - a[1])[0][0];

  const records = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some((cell) => cell.trim() !== '')) records.push(row);
      row = [];
      if (records.length > MAX_IMPORT_ROWS + 1) break;
    } else field += ch;
  }
  row.push(field);
  if (row.some((cell) => cell.trim() !== '')) records.push(row);

  const [head = [], ...body] = records;
  // Blank or repeated headers still need distinct names to map from.
  const seen = new Map();
  const headers = head.map((h, index) => {
    const base = h.trim() || `Column ${index + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n > 1 ? `${base} (${n})` : base;
  });
  const rows = body.slice(0, MAX_IMPORT_ROWS).map((cells) => Object.fromEntries(headers.map((h, i) => [h, (cells[i] ?? '').trim()])));
  return { headers, rows, truncated: body.length > MAX_IMPORT_ROWS };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const text = (value, max) => {
  if (value === undefined || value === null) return null;
  const out = (Array.isArray(value) ? value.join(', ') : String(value)).trim();
  return out ? out.slice(0, max) : null;
};
export const phoneKey = (phone) => {
  const digits = String(phone ?? '').replace(/[^0-9]/g, '');
  return digits ? digits.slice(-10) : null;
};

/**
 * Turn one incoming record into lead columns, using `mapping` (incoming key →
 * lead field or `custom.<key>`). Keys nobody mapped are kept, readably, in the
 * notes — an answer to "what's your budget?" is never silently dropped.
 */
export function normaliseRow(raw, mapping, { fields, stages, ownersByEmail, keepUnmapped = true }) {
  const lead = { custom: {} };
  const extra = [];
  const customInput = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (key.startsWith('__')) continue;
    const target = mapping[key];
    if (value === undefined || value === null || String(value).trim() === '') continue;
    if (!target || target === 'skip') {
      if (keepUnmapped && target !== 'skip') extra.push(`${key}: ${text(value, 500)}`);
      continue;
    }
    if (target.startsWith('custom.')) customInput[target.slice(7)] = value;
    else lead[target] = value;
  }

  const full = text(lead.full_name, 160);
  let first = text(lead.first_name, 80);
  let last = text(lead.last_name, 80);
  if (!first && full) {
    const [head, ...rest] = full.split(/\s+/);
    first = head;
    last = last ?? (rest.join(' ') || null);
  }
  let email = text(lead.email, 254)?.toLowerCase() ?? null;
  if (email && !EMAIL.test(email)) {
    extra.push(`Email (not valid): ${email}`);
    email = null;
  }
  let phone = text(lead.phone, 32);
  if (phone) {
    // Sheets and Meta send "p:+919876543210"; spreadsheets add spaces and dashes.
    phone = phone.replace(/^p:/i, '').replace(/[^\d+()\- ]/g, '').trim();
    if (phone.replace(/[^0-9]/g, '').length < 6) {
      extra.push(`Phone (not valid): ${text(lead.phone, 32)}`);
      phone = null;
    }
  }
  if (!first) first = email?.split('@')[0] ?? phone ?? null;

  const value = lead.estimated_value !== undefined ? Number(String(lead.estimated_value).replace(/[,₹\s]/g, '')) : NaN;
  const rating = ['hot', 'warm', 'cold'].find((r) => r === String(lead.rating ?? '').trim().toLowerCase()) ?? null;
  const stageName = text(lead.stage, 80)?.toLowerCase();
  const stage = stageName ? stages.find((s) => s.name.toLowerCase() === stageName) : null;
  const owner = lead.owner_email ? ownersByEmail?.get(String(lead.owner_email).trim().toLowerCase()) : null;
  const tags = lead.tags ? String(lead.tags).split(/[;,]/).map((t) => t.trim().slice(0, 40)).filter(Boolean).slice(0, 20) : [];

  const { values: custom, problems } = cleanCustom(fields, customInput, { strict: false });
  for (const problem of problems) {
    const key = problem.field.slice(7);
    extra.push(`${fields.find((f) => f.key === key)?.label ?? key}: ${text(customInput[key], 300)}`);
  }

  const notes = [text(lead.notes, 5000), extra.length ? extra.join('\n') : null].filter(Boolean).join('\n\n') || null;

  return {
    first_name: first ? first.slice(0, 80) : null,
    last_name: last,
    email,
    phone,
    company_name: text(lead.company_name, 160),
    job_title: text(lead.job_title, 120),
    city: text(lead.city, 80),
    estimated_value: Number.isFinite(value) && value >= 0 ? value.toFixed(2) : null,
    rating,
    stage_id: stage?.id ?? null,
    owner_user_id: owner ?? null,
    tags,
    custom,
    notes,
  };
}

/**
 * The one way leads arrive in bulk — CSV, a Google Sheet, Meta, a webhook.
 *
 *   - rows are normalised against `mapping` and the workspace's fields;
 *   - a lead whose source id, email or phone already exists is a duplicate:
 *     skipped, or (`onDuplicate: 'note'`) noted on the existing lead, so a
 *     person who enquires twice stays one lead with both enquiries;
 *   - new leads go to their row's owner, else `ownerId`, else round-robin
 *     through `assignTo`;
 *   - a handful of leads raise one event each; a big import raises one
 *     summary per person it was shared with.
 */
export async function intakeLeads(db, {
  orgId, actorId = null, rows, mapping = null, origin,
  ownerId = null, assignTo = [], assignCursor = 0, stageId = null, tags = [],
  onDuplicate = 'skip', ownersByEmail = null,
}) {
  const fields = await activeFields(db, orgId);
  const stages = await ensureStages(db, orgId);
  const firstOpen = stages.find((s) => s.kind === 'open') ?? stages[0];
  const defaultStage = stages.find((s) => s.id === stageId) ?? firstOpen;

  const result = { total: rows.length, created: 0, duplicates: 0, failed: 0, errors: [], leads: [], updated: [], assignCursor };
  const prepared = [];
  for (const [index, raw] of rows.entries()) {
    const map = mapping ?? suggestMapping(Object.keys(raw ?? {}).filter((k) => !k.startsWith('__')), fields);
    const lead = normaliseRow(raw, map, { fields, stages, ownersByEmail });
    if (!lead.first_name && !lead.phone && !lead.email) {
      result.failed += 1;
      if (result.errors.length < 50) result.errors.push({ row: index + 2, message: 'No name, phone or email.' });
      continue;
    }
    const extKey = origin.extKey?.(raw, lead) ?? null;
    prepared.push({ row: index + 2, raw, lead, extKey: extKey ? String(extKey).slice(0, 200) : null });
  }

  // ── duplicates: against the workspace, then within this batch ────────────
  const emails = [...new Set(prepared.map((p) => p.lead.email).filter(Boolean))];
  const phones = [...new Set(prepared.map((p) => phoneKey(p.lead.phone)).filter(Boolean))];
  const extKeys = [...new Set(prepared.map((p) => p.extKey).filter(Boolean))];
  const existing = (emails.length || phones.length || extKeys.length) ? await db.rows(
    `SELECT id, lower(email) AS email, phone_key, ext_key, owner_user_id FROM leads
      WHERE org_id = $1 AND (ext_key = ANY($4) OR (archived_at IS NULL AND (lower(email) = ANY($2) OR phone_key = ANY($3))))`,
    [orgId, emails, phones, extKeys],
  ) : [];
  const byExt = new Map(existing.filter((e) => e.ext_key).map((e) => [e.ext_key, e]));
  const byEmail = new Map(existing.filter((e) => e.email).map((e) => [e.email, e]));
  const byPhone = new Map(existing.filter((e) => e.phone_key).map((e) => [e.phone_key, e]));

  const fresh = [];
  const repeats = [];
  for (const p of prepared) {
    const pk = phoneKey(p.lead.phone);
    const match = (p.extKey && byExt.get(p.extKey)) || (p.lead.email && byEmail.get(p.lead.email)) || (pk && byPhone.get(pk));
    if (match) {
      result.duplicates += 1;
      // The same Meta/sheet row arriving again is not news; a new enquiry is.
      if (onDuplicate === 'note' && !(p.extKey && byExt.has(p.extKey))) repeats.push({ ...p, existing: match });
      continue;
    }
    const self = { id: null };
    if (p.extKey) byExt.set(p.extKey, self);
    if (p.lead.email) byEmail.set(p.lead.email, self);
    if (pk) byPhone.set(pk, self);
    fresh.push(p);
  }

  // ── owners: the row's, the chosen one, or round-robin ───────────────────
  let cursor = assignCursor;
  const records = fresh.map((p) => {
    let owner = p.lead.owner_user_id ?? ownerId ?? null;
    if (!owner && assignTo.length) {
      owner = assignTo[cursor % assignTo.length];
      cursor += 1;
    }
    return {
      id: id('led'),
      first_name: p.lead.first_name ?? 'Lead',
      last_name: p.lead.last_name,
      company_name: p.lead.company_name,
      email: p.lead.email,
      phone: p.lead.phone,
      job_title: p.lead.job_title,
      city: p.lead.city,
      source: origin.leadSource,
      rating: p.lead.rating,
      score: scoreFor(p.lead),
      estimated_value: p.lead.estimated_value,
      owner_user_id: owner,
      tags: [...new Set([...tags, ...p.lead.tags])].slice(0, 20),
      notes: p.lead.notes,
      custom: p.lead.custom,
      stage_id: p.lead.stage_id ?? defaultStage?.id ?? null,
      source_id: origin.sourceId ?? null,
      // A Meta Page has several forms: each lead names its own.
      source_detail: (origin.detailFor?.(p.raw) ?? origin.detail)?.toString().slice(0, 160) || null,
      ext_key: p.extKey,
    };
  });
  result.assignCursor = assignTo.length ? cursor % assignTo.length : cursor;

  await db.transaction(async (tx) => {
    for (let start = 0; start < records.length; start += 250) {
      const chunk = records.slice(start, start + 250);
      const inserted = await tx.rows(
        `INSERT INTO leads (id, org_id, first_name, last_name, company_name, email, phone, job_title, city, source,
                            rating, score, estimated_value, owner_user_id, tags, notes, custom, stage_id,
                            source_id, source_detail, ext_key, created_by)
         SELECT x.id, $1, x.first_name, x.last_name, x.company_name, x.email, x.phone, x.job_title, x.city, x.source,
                x.rating, x.score, x.estimated_value, x.owner_user_id, COALESCE(x.tags, '{}'), x.notes, COALESCE(x.custom, '{}'),
                x.stage_id, x.source_id, x.source_detail, x.ext_key, $2
           FROM jsonb_to_recordset($3::jsonb) AS x(
                  id text, first_name text, last_name text, company_name text, email text, phone text, job_title text,
                  city text, source text, rating text, score integer, estimated_value numeric, owner_user_id text,
                  tags text[], notes text, custom jsonb, stage_id text, source_id text, source_detail text, ext_key text)
         ON CONFLICT (org_id, ext_key) WHERE ext_key IS NOT NULL DO NOTHING
         RETURNING id, first_name, last_name, owner_user_id, email, company_name`,
        [orgId, actorId, JSON.stringify(chunk)],
      );
      result.leads.push(...inserted);
    }
    result.duplicates += records.length - result.leads.length;
    result.created = result.leads.length;

    for (const r of repeats) {
      await tx.query(
        `INSERT INTO activities (id, org_id, kind, subject, body, related_type, related_id, completed_at, assigned_to, created_by)
         VALUES ($1, $2, 'update', $3, $4, 'lead', $5, now(), $6, $7)`,
        [id('act'), orgId, `Enquired again${origin.detail ? ` · ${String(origin.detail).slice(0, 120)}` : ''}`, r.lead.notes, r.existing.id, r.existing.owner_user_id, actorId],
      );
      await tx.query(`UPDATE leads SET updated_at = now() WHERE org_id = $1 AND id = $2`, [orgId, r.existing.id]);
      result.updated.push(r.existing.id);
    }

    const name = (l) => [l.first_name, l.last_name].filter(Boolean).join(' ');
    if (result.leads.length <= 25) {
      for (const lead of result.leads) {
        tx.emit({
          type: EVENTS.LEAD_CREATED, org_id: orgId, actor_id: actorId,
          data: { lead_id: lead.id, name: name(lead), company_name: lead.company_name, email: lead.email, source: origin.leadSource, owner_user_id: lead.owner_user_id },
        });
        if (lead.owner_user_id && lead.owner_user_id !== actorId) {
          tx.emit({
            type: EVENTS.LEAD_ASSIGNED, org_id: orgId, actor_id: actorId,
            data: { owner_user_id: lead.owner_user_id, count: 1, lead_id: lead.id, name: name(lead), via: origin.detail ?? origin.leadSource },
          });
        }
      }
    } else {
      const perOwner = new Map();
      for (const lead of result.leads) if (lead.owner_user_id) perOwner.set(lead.owner_user_id, (perOwner.get(lead.owner_user_id) ?? 0) + 1);
      tx.emit({
        type: EVENTS.LEADS_IMPORTED, org_id: orgId, actor_id: actorId,
        data: { created: result.created, duplicates: result.duplicates, failed: result.failed, via: origin.detail ?? origin.leadSource, created_by: actorId },
      });
      for (const [owner, count] of perOwner) {
        if (owner === actorId) continue;
        tx.emit({ type: EVENTS.LEAD_ASSIGNED, org_id: orgId, actor_id: actorId, data: { owner_user_id: owner, count, via: origin.detail ?? origin.leadSource } });
      }
    }
  });

  return result;
}

/** Record what an import or sync did, for the history list. */
export async function recordImport(db, { orgId, sourceId = null, kind, name, result, actorId }) {
  return db.one(
    `INSERT INTO lead_imports (id, org_id, source_id, kind, name, total, created, duplicates, failed, errors, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [id('limp'), orgId, sourceId, kind, name ? String(name).slice(0, 160) : null, result.total, result.created,
      result.duplicates, result.failed, JSON.stringify(result.errors.slice(0, 50)), actorId],
  );
}
