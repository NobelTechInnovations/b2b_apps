import { id } from '@nexus/db-kit';
import { badRequest } from '@nexus/service-kit';

export const FIELD_TYPES = ['text', 'long_text', 'number', 'date', 'select', 'multi_select', 'checkbox', 'phone', 'email', 'url'];

/** The lead's own columns an import, form or integration can fill. */
export const STANDARD_FIELDS = [
  { key: 'full_name', label: 'Full name' },
  { key: 'first_name', label: 'First name' },
  { key: 'last_name', label: 'Last name' },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'company_name', label: 'Company' },
  { key: 'job_title', label: 'Job title' },
  { key: 'city', label: 'City' },
  { key: 'estimated_value', label: 'Deal value' },
  { key: 'rating', label: 'Rating (hot/warm/cold)' },
  { key: 'notes', label: 'Notes' },
  { key: 'tags', label: 'Tags' },
  { key: 'owner_email', label: 'Owner (email)' },
  { key: 'stage', label: 'Stage (name)' },
];

/**
 * Header words → field. Matching ignores case, spaces and punctuation, so
 * "Mobile No.", "mobile_number" and "Phone Number" all land on `phone`.
 * Meta's own question keys (full_name, phone_number…) are in here too.
 */
const ALIASES = {
  full_name: ['name', 'fullname', 'leadname', 'customername', 'clientname', 'contactname', 'yourname', 'sendername', 'buyername'],
  first_name: ['firstname', 'fname', 'givenname'],
  last_name: ['lastname', 'lname', 'surname', 'familyname'],
  phone: ['phone', 'phonenumber', 'mobile', 'mobileno', 'mobilenumber', 'contact', 'contactno', 'contactnumber', 'whatsapp', 'whatsappnumber', 'cell', 'tel', 'telephone', 'phoneno', 'workphonenumber', 'sendermobile', 'buyermobile'],
  email: ['email', 'emailaddress', 'emailid', 'mail', 'workemail', 'senderemail', 'buyeremail'],
  company_name: ['company', 'companyname', 'organisation', 'organization', 'business', 'businessname', 'firm', 'sendercompany'],
  job_title: ['jobtitle', 'title', 'designation', 'position', 'role'],
  city: ['city', 'location', 'town', 'district', 'sendercity'],
  estimated_value: ['value', 'budget', 'amount', 'dealvalue', 'estimatedvalue'],
  rating: ['rating', 'temperature', 'priority'],
  notes: ['notes', 'note', 'message', 'comments', 'comment', 'remarks', 'requirement', 'requirements', 'query', 'enquiry', 'inquiry', 'description', 'querymessage'],
  tags: ['tags', 'labels'],
  owner_email: ['owner', 'owneremail', 'assignedto', 'assignee', 'salesperson', 'agent'],
  stage: ['stage', 'status', 'leadstatus'],
};

const squash = (text) => String(text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Best guess of where each incoming column belongs. Unknown columns are skipped. */
export function suggestMapping(headers, customFields = []) {
  const taken = new Set();
  const mapping = {};
  for (const header of headers) {
    const word = squash(header);
    if (!word) continue;
    let target = null;
    const custom = customFields.find((f) => squash(f.key) === word || squash(f.label) === word);
    if (custom) target = `custom.${custom.key}`;
    else {
      for (const [field, words] of Object.entries(ALIASES)) {
        if (field === word || words.includes(word)) { target = field; break; }
      }
    }
    if (target && !taken.has(target)) {
      mapping[header] = target;
      taken.add(target);
    }
  }
  return mapping;
}

export const fieldKey = (label) => {
  const key = String(label).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return /^[a-z]/.test(key) ? key : `f_${key}`.slice(0, 40);
};

export async function activeFields(store, orgId) {
  return store.rows(
    `SELECT id, key, label, type, options, required, show_in_list, position FROM lead_fields
      WHERE org_id = $1 AND archived_at IS NULL ORDER BY position, created_at`,
    [orgId],
  );
}

/**
 * Check values for the workspace's own fields.
 *
 * `strict` (forms people type into) reports every problem; imports and
 * integrations are lenient — a value that does not fit is dropped rather than
 * losing the whole lead over it.
 */
export function cleanCustom(fields, input = {}, { strict = true, partial = false } = {}) {
  const values = {};
  const problems = [];
  const byKey = new Map(fields.map((f) => [f.key, f]));
  for (const key of Object.keys(input ?? {})) {
    if (!byKey.has(key) && strict) problems.push({ field: `custom.${key}`, message: 'That field does not exist.' });
  }
  for (const f of fields) {
    if (partial && !(f.key in (input ?? {}))) continue;
    let value = input?.[f.key];
    if (typeof value === 'string') value = value.trim();
    const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);
    if (empty) {
      if (f.required && strict && !partial) problems.push({ field: `custom.${f.key}`, message: `${f.label} is required.` });
      if (partial) values[f.key] = null;
      continue;
    }
    const fail = (message) => problems.push({ field: `custom.${f.key}`, message });
    switch (f.type) {
      case 'number': {
        const n = Number(String(value).replace(/[,₹\s]/g, ''));
        if (Number.isFinite(n)) values[f.key] = n; else fail(`${f.label} must be a number.`);
        break;
      }
      case 'date': {
        const text = String(value);
        const dmy = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
        const iso = dmy ? `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}` : text.slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(iso) && !Number.isNaN(Date.parse(iso))) values[f.key] = iso; else fail(`${f.label} must be a date.`);
        break;
      }
      case 'select': {
        const match = f.options.find((o) => o.toLowerCase() === String(value).toLowerCase());
        if (match) values[f.key] = match; else fail(`Choose one of the options for ${f.label}.`);
        break;
      }
      case 'multi_select': {
        const list = Array.isArray(value) ? value : String(value).split(/[;,]/).map((x) => x.trim()).filter(Boolean);
        const matched = list.map((x) => f.options.find((o) => o.toLowerCase() === String(x).toLowerCase()));
        if (matched.every(Boolean)) values[f.key] = [...new Set(matched)]; else fail(`Choose from the options for ${f.label}.`);
        break;
      }
      case 'checkbox':
        values[f.key] = value === true || ['true', 'yes', 'y', '1'].includes(String(value).toLowerCase());
        break;
      case 'email':
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value))) values[f.key] = String(value).toLowerCase().slice(0, 254); else fail('Enter a valid email address.');
        break;
      case 'phone':
        if (/^[+0-9 ()-]{6,20}$/.test(String(value))) values[f.key] = String(value); else fail('Enter a valid phone number.');
        break;
      case 'url':
        if (/^https?:\/\/\S+$/i.test(String(value))) values[f.key] = String(value).slice(0, 500); else fail('Enter a web address starting with http.');
        break;
      default:
        values[f.key] = String(value).slice(0, f.type === 'long_text' ? 5000 : 500);
    }
  }
  if (strict && problems.length) throw badRequest('Please check the highlighted fields.', problems);
  return { values, problems };
}

// ── stages ──────────────────────────────────────────────────────────────────
const DEFAULT_STAGES = [
  { name: 'New', color: 'slate', kind: 'open' },
  { name: 'Contacted', color: 'blue', kind: 'open' },
  { name: 'Interested', color: 'amber', kind: 'open' },
  { name: 'Negotiation', color: 'violet', kind: 'open' },
  { name: 'Won', color: 'emerald', kind: 'won' },
  { name: 'Lost', color: 'rose', kind: 'lost' },
];

/**
 * A workspace's stages, created the first time anyone needs them. Leads
 * that existed before (from CRM) are placed by their CRM status once.
 */
export async function ensureStages(db, orgId) {
  const existing = await db.rows(`SELECT * FROM lead_stages WHERE org_id = $1 ORDER BY position, created_at`, [orgId]);
  if (existing.length) return existing;
  return db.transaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`lead_stages:${orgId}`]);
    const again = await tx.rows(`SELECT * FROM lead_stages WHERE org_id = $1 ORDER BY position, created_at`, [orgId]);
    if (again.length) return again;
    const rows = [];
    for (const [index, stage] of DEFAULT_STAGES.entries()) {
      rows.push(await tx.one(
        `INSERT INTO lead_stages (id, org_id, name, color, kind, position) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [id('lstg'), orgId, stage.name, stage.color, stage.kind, index],
      ));
    }
    const by = Object.fromEntries(rows.map((s) => [s.name, s.id]));
    await tx.query(
      `UPDATE leads SET stage_id = CASE status
              WHEN 'converted' THEN $2 WHEN 'unqualified' THEN $3 WHEN 'qualified' THEN $4
              WHEN 'contacted' THEN $5 ELSE $6 END
        WHERE org_id = $1 AND stage_id IS NULL`,
      [orgId, by.Won, by.Lost, by.Interested, by.Contacted, by.New],
    );
    return rows;
  });
}

/** CRM's status follows the stage's kind, so both apps tell the same story. */
export function statusForStage(stage, currentStatus) {
  if (currentStatus === 'converted') return 'converted';
  if (stage.kind === 'lost') return 'unqualified';
  if (stage.kind === 'won') return 'qualified';
  return currentStatus === 'unqualified' ? 'contacted' : currentStatus;
}
