import ExcelJS from 'exceljs';
import { id } from '@nexus/db-kit';
import { badRequest } from '@nexus/service-kit';
import { activeFields, ensureStages, fieldKey, suggestMapping, STANDARD_FIELDS } from './lead-fields.js';
import { intakeLeads, phoneKey, recordImport } from './lead-intake.js';

/**
 * A whole spreadsheet in one go: the tab of leads, the tab of follow-ups that
 * points at them (by an ID column), and the tab of dropdown lists.
 *
 * Every column of the leads tab becomes a field without anyone setting it up:
 * matched to a lead field when one fits, otherwise created as the workspace's
 * own field with a type read from the sheet — a dropdown with the sheet's own
 * options, a date, a number. Columns the sheet calculates itself ("(auto)")
 * are left out: Nexus works those out from the follow-ups.
 */

const MAX_ROWS = 20_000;
const squash = (text) => String(text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const isAuto = (header) => /\(auto\)|\bauto\b/i.test(header);

// ── reading ─────────────────────────────────────────────────────────────────
export async function loadWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw badRequest('That file is not an Excel workbook (.xlsx). Save it as .xlsx, or use the CSV import.');
  }
  return workbook;
}

/** A cell as text: formulas give their result, dates an ISO date, rich text its words. */
export function cellText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    const iso = value.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
  }
  if (typeof value === 'object') {
    if ('result' in value) return cellText(value.result);
    if (value.richText) return value.richText.map((part) => part.text).join('');
    if ('text' in value) return cellText(value.text);
    if (value.error) return '';
    return '';
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value).trim();
}

const columnNumber = (letters) => [...letters.toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);

/** `Lists!$A$2:$A$20` or `'Sheet 1'!B2:B9` → the non-empty values of that range. */
function rangeValues(workbook, ref) {
  const match = String(ref).match(/^'?([^'!]+)'?!\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/i);
  if (!match) return { sheet: null, column: null, values: [] };
  const [, sheet, fromCol, fromRow, toCol = fromCol, toRow = fromRow] = match;
  const ws = workbook.getWorksheet(sheet);
  const values = [];
  if (ws) {
    for (let r = Number(fromRow); r <= Math.min(Number(toRow), Number(fromRow) + 500); r += 1) {
      for (let c = columnNumber(fromCol); c <= columnNumber(toCol); c += 1) {
        const text = cellText(ws.getRow(r).getCell(c).value);
        if (text && !values.includes(text)) values.push(text);
      }
    }
  }
  return { sheet, column: columnNumber(fromCol), values };
}

export function readTabs(workbook) {
  return workbook.worksheets.map((ws) => {
    let headerRow = null;
    for (let r = 1; r <= Math.min(ws.rowCount, 10); r += 1) {
      const filled = (ws.getRow(r).values ?? []).slice(1).map(cellText).filter(Boolean);
      if (filled.length >= 2) { headerRow = r; break; }
    }
    const headers = [];
    const columns = [];
    if (headerRow) {
      const seen = new Map();
      ws.getRow(headerRow).eachCell({ includeEmpty: false }, (cell, col) => {
        const base = cellText(cell.value);
        if (!base) return;
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        headers.push(n > 1 ? `${base} (${n})` : base);
        columns.push(col);
      });
    }

    // Dropdowns: a list typed into the rule, or a range on another tab.
    const dropdowns = {};
    let unique = null;
    for (const [address, rule] of Object.entries(ws.dataValidations?.model ?? {})) {
      const col = columnNumber(String(address).match(/^[A-Z]+/i)?.[0] ?? 'A');
      const header = headers[columns.indexOf(col)];
      if (!header || dropdowns[header]) continue;
      const formula = String(rule?.formulae?.[0] ?? '');
      if (rule.type === 'custom' && /COUNTIF/i.test(formula)) unique ??= header;
      if (rule.type !== 'list') continue;
      if (formula.startsWith('"')) dropdowns[header] = { options: formula.replace(/^"|"$/g, '').split(',').map((o) => o.trim()).filter(Boolean) };
      else {
        const range = rangeValues(workbook, formula.replace(/^=/, ''));
        dropdowns[header] = { options: range.values, refSheet: range.sheet, refColumn: range.column };
      }
    }

    const rows = [];
    if (headerRow) {
      for (let r = headerRow + 1; r <= ws.rowCount && rows.length < MAX_ROWS; r += 1) {
        const row = ws.getRow(r);
        const record = {};
        let any = false;
        headers.forEach((header, i) => {
          const text = cellText(row.getCell(columns[i]).value);
          if (text) { record[header] = text; any = true; }
        });
        if (any) rows.push(record);
      }
    }
    return { name: ws.name, headerRow, headers, columns, rows, dropdowns, unique };
  });
}

// ── planning ────────────────────────────────────────────────────────────────
const NAME_EXCLUDE = /universit|course|company|partner|referr|father|mother|parent|guardian|school|college|file|product/i;
const CONTACT_TARGETS = new Set(['full_name', 'first_name', 'phone', 'email']);

function leadScore(tab) {
  const mapping = suggestMapping(tab.headers);
  let score = Object.values(mapping).filter((t) => CONTACT_TARGETS.has(t)).length;
  if (tab.headers.some((h) => /name$/i.test(h.trim()) && !NAME_EXCLUDE.test(h))) score += 1;
  return score;
}

function keyColumn(tab) {
  if (tab.unique) return tab.unique;
  return tab.headers.find((h) => /(^|\s)(id|no\.?|code|ref)$/i.test(h.trim()) && !/phone|mobile|email|aadhaar|passport/i.test(h)) ?? null;
}

const DATE_VALUE = /^(\d{4}-\d{2}-\d{2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{1,2}\s+[a-z]{3,9}\s+\d{4})/i;

/** What kind of field a column should be, from its dropdown, its name and its values. */
function inferType(header, values, dropdown) {
  if (dropdown?.options?.length) return { type: 'select', options: dropdown.options.slice(0, 100) };
  const sample = values.slice(0, 200);
  const share = (test) => (sample.length ? sample.filter(test).length / sample.length : 0);
  if (/e-?mail/i.test(header) || (sample.length && share((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) > 0.9)) return { type: 'email' };
  if (/phone|mobile|whatsapp|contact no/i.test(header)) return { type: 'phone' };
  if (/(^|\s)(url|link|website)(\s|$)/i.test(header) || (sample.length && share((v) => /^https?:\/\//i.test(v)) > 0.9)) return { type: 'url' };
  if (/date|dob|deadline|birth/i.test(header) || (sample.length && share((v) => DATE_VALUE.test(v)) > 0.9)) return { type: 'date' };
  if (!/(^|\s)(id|code|pin|zip|year|no\.?)$/i.test(header) && sample.length && share((v) => /^-?\d+(\.\d+)?$/.test(v.replace(/[,₹\s]/g, ''))) > 0.95) return { type: 'number' };
  if (/remark|summary|note|description|comment|address|discussion|detail/i.test(header) || (sample.length && sample.reduce((n, v) => n + v.length, 0) / sample.length > 120)) return { type: 'long_text' };
  // A handful of distinct values repeated across many rows reads as a dropdown.
  const distinct = [...new Set(sample)];
  if (sample.length >= 20 && distinct.length <= 12 && distinct.every((v) => v.length <= 40)) return { type: 'select', options: distinct };
  return { type: 'text' };
}

const stageKind = (name) => (/convert|won|enrol|admit|success|closed won|joined|paid/i.test(name) ? 'won'
  : /lost|dead|junk|not interested|reject|closed lost|drop/i.test(name) ? 'lost' : 'open');

/**
 * Which tab is what, and what happens to every column. The plan is shown
 * before anything is written; the import then follows it.
 */
export async function planWorkbook(db, orgId, tabs) {
  const fields = await activeFields(db, orgId);
  const stages = await ensureStages(db, orgId);

  const candidates = tabs.filter((t) => t.headers.length >= 2).map((t) => ({ tab: t, score: leadScore(t) }));
  const best = candidates.sort((a, b) => b.score - a.score || b.tab.headers.length - a.tab.headers.length)[0];
  if (!best || best.score === 0) throw badRequest('No tab looks like a list of leads: add a column for the name, phone or email.');
  const leadsTab = best.tab;
  const key = keyColumn(leadsTab);
  const keyColumnNumber = key ? leadsTab.columns[leadsTab.headers.indexOf(key)] : null;

  // Follow-ups: a tab whose rows point at the leads tab's key column.
  const followTab = key ? tabs.find((t) => t !== leadsTab && t.headers.length >= 2
    && (Object.values(t.dropdowns).some((d) => d.refSheet === leadsTab.name && d.refColumn === keyColumnNumber)
      || t.headers.some((h) => squash(h) === squash(key)))
    && t.headers.some((h) => /date|when|time/i.test(h))) : null;

  const referenced = new Set(tabs.flatMap((t) => Object.values(t.dropdowns).map((d) => d.refSheet).filter(Boolean)));
  const tabRoles = tabs.map((t) => ({
    name: t.name,
    role: t === leadsTab ? 'leads' : t === followTab ? 'followups'
      : referenced.has(t.name) || /^(lists?|options|dropdowns?|masters?|settings)$/i.test(t.name) ? 'lists' : 'skipped',
    rows: t.rows.length,
    columns: t.headers.length,
  }));

  // ── the leads tab's columns ──
  const suggested = suggestMapping(leadsTab.headers.filter((h) => !isAuto(h)), fields);
  const used = new Set(Object.values(suggested));
  const columns = leadsTab.headers.map((header) => {
    const values = leadsTab.rows.map((r) => r[header]).filter(Boolean);
    const dropdown = leadsTab.dropdowns[header];
    if (isAuto(header)) return { header, action: 'skip', reason: 'Worked out by the sheet; Nexus counts follow-ups itself.' };
    let target = suggested[header];
    if (!target && !used.has('full_name') && !used.has('first_name') && /name$/i.test(header.trim()) && !NAME_EXCLUDE.test(header)) target = 'full_name';
    if (!target && !used.has('owner_email') && /counsel|owner|assigned|agent|executive|handled by|sales ?person|caller/i.test(header)) target = 'owner_email';
    if (!target && !used.has('stage') && /lead status|stage|pipeline/i.test(header)) target = 'stage';
    if (target && target !== `custom.${fieldKey(header)}` && used.has(target) && suggested[header] !== target) target = null;
    if (target && STANDARD_FIELDS.some((f) => f.key === target)) {
      used.add(target);
      if (target === 'stage') {
        const names = dropdown?.options?.length ? dropdown.options : [...new Set(values)].slice(0, 30);
        const missing = names.filter((n) => !stages.some((s) => s.name.toLowerCase() === n.toLowerCase()));
        return { header, action: 'map', target, label: 'Stage', new_stages: missing.map((n) => ({ name: n, kind: stageKind(n) })) };
      }
      return { header, action: 'map', target, label: STANDARD_FIELDS.find((f) => f.key === target).label };
    }
    if (target?.startsWith('custom.')) {
      const field = fields.find((f) => `custom.${f.key}` === target);
      return { header, action: 'map', target, label: field?.label ?? header, ...(header === key ? { key: true } : {}) };
    }
    const { type, options } = inferType(header, values, dropdown);
    return { header, action: 'create', target: `custom.${fieldKey(header)}`, label: header.replace(/\s*\(.*?\)\s*$/, '').trim() || header, type, options: options ?? [], ...(header === key ? { key: true } : {}) };
  });

  // ── the follow-ups tab's columns ──
  let followups = null;
  if (followTab) {
    const find = (re, not) => followTab.headers.find((h) => !isAuto(h) && re.test(h) && !(not && not.test(h))) ?? null;
    const linkHeader = followTab.headers.find((h) => {
      const d = followTab.dropdowns[h];
      return (d?.refSheet === leadsTab.name && d?.refColumn === keyColumnNumber) || squash(h) === squash(key);
    });
    followups = {
      tab: followTab.name,
      rows: followTab.rows.length,
      roles: {
        link: linkHeader ?? null,
        date: find(/date|when|time/i, /next/i),
        mode: find(/mode|channel|medium|type/i),
        by: find(/done by|(^|\s)by$|counsel|agent|caller|executive|handled/i),
        summary: find(/summary|discussion|details|notes?$/i),
        outcome: find(/outcome|response|result/i),
        remarks: find(/remark|comment/i),
        next_date: find(/next.*(date|follow)/i),
        next_action: find(/next action|action/i, /date/i),
        status: find(/status/i),
        priority: find(/priority/i),
      },
    };
  }

  return {
    tabs: tabRoles,
    leads: { tab: leadsTab.name, rows: leadsTab.rows.length, key, columns },
    followups,
  };
}

// ── importing ───────────────────────────────────────────────────────────────
const OUTCOME_WORDS = [
  [/not interested|no interest/i, 'not_interested'],
  [/interested|positive|hot/i, 'interested'],
  [/no response|no answer|not pick|unanswered|ringing/i, 'no_answer'],
  [/busy/i, 'busy'],
  [/switch(ed)? off|unreachable|not reachable/i, 'switched_off'],
  [/wrong/i, 'wrong_number'],
  [/call back|callback|later|needs time|follow/i, 'call_back'],
];
const callOutcome = (text) => OUTCOME_WORDS.find(([re]) => re.test(text ?? ''))?.[1] ?? 'connected';
const KIND = (mode) => (/whats|sms|text/i.test(mode ?? '') ? 'whatsapp' : /mail/i.test(mode ?? '') ? 'email'
  : /meet|person|visit|video|zoom|office/i.test(mode ?? '') ? 'meeting' : /call|phone/i.test(mode ?? '') || !mode ? 'call' : 'note');
const KIND_LABEL = { call: 'Call', whatsapp: 'WhatsApp', email: 'Email', meeting: 'Meeting', note: 'Update' };

/** A day from the sheet, at 10:00 India time (a follow-up's date rarely has a time). */
export function sheetMoment(text) {
  const value = String(text ?? '').trim();
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return new Date(value);
  let day = null;
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const dmy = value.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (iso) day = `${iso[1]}-${iso[2]}-${iso[3]}`;
  else if (dmy) day = `${dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  else if (!Number.isNaN(Date.parse(value))) day = new Date(`${value} UTC`).toISOString().slice(0, 10);
  if (!day) return null;
  const at = new Date(`${day}T10:00:00+05:30`);
  return Number.isNaN(at.getTime()) ? null : at;
}

export async function importWorkbook(db, { orgId, actorId, tabs, plan, name, team, assignTo = [], ownerId = null }) {
  const leadsTab = tabs.find((t) => t.name === plan.leads.tab);
  if (!leadsTab) throw badRequest('The leads tab is no longer in the file. Upload it again.');
  const columns = plan.leads.columns;
  if (!columns.some((c) => c.action !== 'skip' && ['full_name', 'first_name', 'phone', 'email'].includes(c.target))) {
    throw badRequest('Match at least one column to Name, Phone or Email.');
  }

  // 1. New fields and stages, made once and reused by every later import.
  const created = { fields: [], stages: [] };
  await db.transaction(async (tx) => {
    const existing = await activeFields(tx, orgId);
    const keys = new Set((await tx.rows(`SELECT key FROM lead_fields WHERE org_id = $1`, [orgId])).map((r) => r.key));
    let position = (await tx.one(`SELECT COALESCE(max(position) + 1, 0) AS n FROM lead_fields WHERE org_id = $1`, [orgId])).n;
    for (const column of columns.filter((c) => c.action === 'create')) {
      const base = column.target.slice(7);
      const same = existing.find((f) => f.key === base || f.label.toLowerCase() === column.label.toLowerCase());
      if (same) { column.target = `custom.${same.key}`; continue; }
      let key = STANDARD_FIELDS.some((f) => f.key === base) ? `${base}_1` : base;
      for (let n = 2; keys.has(key); n += 1) key = `${base.slice(0, 36)}_${n}`;
      keys.add(key);
      await tx.query(
        `INSERT INTO lead_fields (id, org_id, key, label, type, options, required, show_in_list, position, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,false,$7,$8,$9)`,
        [id('lfld'), orgId, key, column.label.slice(0, 80), column.type, JSON.stringify(column.options ?? []), Boolean(column.key), position, actorId],
      );
      position += 1;
      column.target = `custom.${key}`;
      created.fields.push({ key, label: column.label, type: column.type });
    }
    const stageColumn = columns.find((c) => c.action === 'map' && c.target === 'stage');
    if (stageColumn?.new_stages?.length) {
      const stages = await ensureStages(tx, orgId);
      let next = Math.max(...stages.filter((s) => s.kind === 'open').map((s) => s.position), 0) + 1;
      for (const stage of stageColumn.new_stages) {
        if (stages.some((s) => s.name.toLowerCase() === stage.name.toLowerCase())) continue;
        await tx.query(
          `INSERT INTO lead_stages (id, org_id, name, color, kind, position) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT DO NOTHING`,
          [id('lstg'), orgId, stage.name.slice(0, 60), stage.kind === 'won' ? 'emerald' : stage.kind === 'lost' ? 'rose' : 'blue', stage.kind, stage.kind === 'open' ? next : next + 50],
        );
        next += 1;
        created.stages.push(stage.name);
      }
    }
  });

  // 2. Leads. People named in an owner column are matched by email or name.
  const mapping = Object.fromEntries(columns.map((c) => [c.header, c.action === 'skip' ? 'skip' : c.target]));
  const owners = new Map();
  for (const person of team) {
    if (person.email) owners.set(person.email.toLowerCase(), person.user_id);
    if (person.name) {
      owners.set(person.name.toLowerCase(), person.user_id);
      const first = person.name.split(/\s+/)[0].toLowerCase();
      if (!owners.has(first)) owners.set(first, person.user_id);
    }
  }
  const key = plan.leads.key;
  const namespace = `xl:${squash(plan.leads.tab)}:${squash(key ?? '')}`;
  const result = await intakeLeads(db, {
    orgId, actorId, rows: leadsTab.rows, mapping, ownersByEmail: owners, ownerId, assignTo,
    origin: {
      leadSource: 'import', detail: `Excel · ${name}`,
      extKey: (raw) => (key && raw[key] ? `${namespace}:${String(raw[key]).trim().toLowerCase()}` : null),
    },
  });

  // 3. Follow-ups, attached to their lead by the key column.
  const followSummary = { imported: 0, scheduled: 0, unmatched: 0, duplicates: 0 };
  const follow = plan.followups;
  const followTab = follow ? tabs.find((t) => t.name === follow.tab) : null;
  if (followTab && follow.roles.link && key) {
    const roles = follow.roles;
    const keys = [...new Set(followTab.rows.map((r) => String(r[roles.link] ?? '').trim().toLowerCase()).filter(Boolean))];
    // By the key first; a student who was already a lead (same phone/email) by their contact details.
    const byExt = new Map((await db.rows(
      `SELECT id, ext_key, owner_user_id FROM leads WHERE org_id = $1 AND ext_key = ANY($2) AND archived_at IS NULL`,
      [orgId, keys.map((k) => `${namespace}:${k}`)],
    )).map((l) => [l.ext_key.slice(namespace.length + 1), l]));
    const contactOf = new Map(leadsTab.rows.filter((r) => r[key]).map((r) => [String(r[key]).trim().toLowerCase(), r]));
    const phoneCol = columns.find((c) => c.target === 'phone')?.header;
    const emailCol = columns.find((c) => c.target === 'email')?.header;
    for (const k of keys.filter((x) => !byExt.has(x))) {
      const row = contactOf.get(k);
      const pk = phoneCol ? phoneKey(row?.[phoneCol]) : null;
      const em = emailCol ? String(row?.[emailCol] ?? '').trim().toLowerCase() : '';
      if (!pk && !em) continue;
      const lead = await db.one(
        `SELECT id, owner_user_id FROM leads WHERE org_id = $1 AND archived_at IS NULL AND (phone_key = $2 OR lower(email) = $3) LIMIT 1`,
        [orgId, pk, em || null],
      );
      if (lead) byExt.set(k, lead);
    }

    const touched = new Set();
    await db.transaction(async (tx) => {
      for (const row of followTab.rows) {
        const lead = byExt.get(String(row[roles.link] ?? '').trim().toLowerCase());
        if (!lead) { followSummary.unmatched += 1; continue; }
        const when = sheetMoment(row[roles.date]);
        const kind = KIND(row[roles.mode]);
        const response = row[roles.outcome] ?? null;
        const by = row[roles.by] ? owners.get(String(row[roles.by]).trim().toLowerCase()) ?? null : null;
        const lines = [
          row[roles.summary],
          response && `Outcome: ${response}`,
          row[roles.remarks] && `Remarks: ${row[roles.remarks]}`,
          row[roles.next_action] && `Next action: ${row[roles.next_action]}`,
          row[roles.priority] && `Priority: ${row[roles.priority]}`,
          row[roles.by] && !by && `By: ${row[roles.by]}`,
        ].filter(Boolean).join('\n') || null;
        if (when) {
          const outcome = kind === 'call' ? callOutcome(response) : (response ? String(response).slice(0, 60) : 'done');
          const subject = `${KIND_LABEL[kind]}${response ? ` · ${response}` : ''}`.slice(0, 300);
          const inserted = await tx.one(
            `INSERT INTO activities (id, org_id, kind, subject, body, related_type, related_id, completed_at, outcome, assigned_to, created_by)
             SELECT $1,$2,$3,$4,$5,'lead',$6,$7,$8,$9,$9
              WHERE NOT EXISTS (SELECT 1 FROM activities WHERE org_id = $2 AND related_type = 'lead' AND related_id = $6
                                  AND kind = $3 AND completed_at = $7 AND subject = $4)
             RETURNING id`,
            [id('act'), orgId, kind, subject, lines, lead.id, when, outcome, by ?? actorId],
          );
          if (inserted) followSummary.imported += 1; else followSummary.duplicates += 1;
          touched.add(lead.id);
        }
        // A next date still ahead, on a follow-up that is not closed, becomes a scheduled one.
        const next = sheetMoment(row[roles.next_date]);
        const closed = /closed|done|complete|cancel/i.test(row[roles.status] ?? '');
        if (next && !closed && next.getTime() > Date.now() - 86_400_000) {
          const subject = `${KIND_LABEL[kind]} · ${row[roles.next_action] ?? 'Follow up'}`.slice(0, 300);
          const scheduled = await tx.one(
            `INSERT INTO activities (id, org_id, kind, subject, body, related_type, related_id, due_at, assigned_to, created_by)
             SELECT $1,$2,$3,$4,$5,'lead',$6,$7,$8,$9
              WHERE NOT EXISTS (SELECT 1 FROM activities WHERE org_id = $2 AND related_type = 'lead' AND related_id = $6
                                  AND due_at = $7 AND completed_at IS NULL)
             RETURNING id`,
            [id('act'), orgId, kind === 'note' ? 'call' : kind, subject, row[roles.priority] ? `Priority: ${row[roles.priority]}` : null,
              lead.id, next, lead.owner_user_id ?? by ?? actorId, by ?? actorId],
          );
          if (scheduled) followSummary.scheduled += 1;
          touched.add(lead.id);
        }
      }
      // Each touched lead's call count, last call and next follow-up, from its timeline.
      if (touched.size) {
        await tx.query(
          `UPDATE leads l SET
             call_count = s.calls, last_call_at = s.last_call, last_contacted_at = GREATEST(l.last_contacted_at, s.last_touch),
             last_call_outcome = COALESCE(s.last_outcome, l.last_call_outcome), next_followup_at = s.next_due, updated_at = now()
           FROM (
             SELECT related_id,
                    count(*) FILTER (WHERE kind = 'call' AND completed_at IS NOT NULL AND due_at IS NULL)::int AS calls,
                    max(completed_at) FILTER (WHERE kind = 'call') AS last_call,
                    max(completed_at) AS last_touch,
                    (array_agg(outcome ORDER BY completed_at DESC) FILTER (WHERE kind = 'call' AND completed_at IS NOT NULL))[1] AS last_outcome,
                    min(due_at) FILTER (WHERE completed_at IS NULL AND due_at IS NOT NULL) AS next_due
               FROM activities WHERE org_id = $1 AND related_type = 'lead' AND related_id = ANY($2)
              GROUP BY related_id
           ) s
           WHERE l.org_id = $1 AND l.id = s.related_id`,
          [orgId, [...touched]],
        );
      }
    });
  }

  const record = await recordImport(db, { orgId, kind: 'csv', name: `Excel · ${name}`, result, actorId });
  return {
    id: record.id, total: result.total, created: result.created, duplicates: result.duplicates, failed: result.failed, errors: result.errors,
    fields_created: created.fields, stages_created: created.stages, followups: followSummary,
  };
}
