/**
 * IMPORT TARGETS — what a spreadsheet can be turned into.
 *
 * The Documents app parses a file and profiles its columns; this registry says
 * which app can receive those rows, what fields it expects, and how to reach
 * it. Documents never learns CRM's or HR's schema — it reads this, and posts
 * to the declared internal endpoint.
 *
 * Adding a new importable entity is an entry here plus an /internal/import
 * route on the owning service.
 */

/** Field types the validator understands, in the order it tries to coerce. */
export const FIELD_TYPES = ['text', 'email', 'phone', 'number', 'money', 'date', 'boolean', 'enum'];

export const IMPORT_TARGETS = [
  {
    key: 'crm.contacts',
    app: 'crm',
    service: 'crm',
    label: 'CRM contacts',
    description: 'People at the companies you sell to.',
    icon: 'Contact',
    endpoint: '/internal/import/contacts',
    permission: 'crm.contacts.create',
    // The column used to spot a row that already exists.
    dedupeOn: 'email',
    fields: [
      { key: 'first_name', label: 'First name', type: 'text', required: true, aliases: ['first', 'firstname', 'given name', 'name'] },
      { key: 'last_name', label: 'Last name', type: 'text', aliases: ['last', 'lastname', 'surname', 'family name'] },
      { key: 'email', label: 'Email', type: 'email', aliases: ['email address', 'e-mail', 'mail', 'work email'] },
      { key: 'phone', label: 'Phone', type: 'phone', aliases: ['telephone', 'mobile', 'contact number', 'phone number'] },
      { key: 'job_title', label: 'Job title', type: 'text', aliases: ['title', 'designation', 'role', 'position'] },
      { key: 'department', label: 'Department', type: 'text', aliases: ['dept', 'team'] },
      { key: 'company_name', label: 'Company', type: 'text', aliases: ['organisation', 'organization', 'account', 'employer'] },
      { key: 'linkedin', label: 'LinkedIn', type: 'text', aliases: ['linkedin url', 'li'] },
      { key: 'notes', label: 'Notes', type: 'text', aliases: ['comments', 'remarks'] },
    ],
  },
  {
    key: 'crm.leads',
    app: 'crm',
    service: 'crm',
    label: 'CRM leads',
    description: 'Unqualified enquiries to work through your pipeline.',
    icon: 'Sparkles',
    endpoint: '/internal/import/leads',
    permission: 'crm.leads.create',
    dedupeOn: 'email',
    fields: [
      { key: 'first_name', label: 'First name', type: 'text', required: true, aliases: ['first', 'firstname', 'name', 'contact name'] },
      { key: 'last_name', label: 'Last name', type: 'text', aliases: ['last', 'lastname', 'surname'] },
      { key: 'company_name', label: 'Company', type: 'text', aliases: ['organisation', 'organization', 'account'] },
      { key: 'email', label: 'Email', type: 'email', aliases: ['email address', 'e-mail'] },
      { key: 'phone', label: 'Phone', type: 'phone', aliases: ['mobile', 'telephone', 'contact number'] },
      { key: 'job_title', label: 'Job title', type: 'text', aliases: ['title', 'designation', 'role'] },
      {
        key: 'source', label: 'Source', type: 'enum',
        options: ['manual', 'website', 'referral', 'campaign', 'event', 'cold_call', 'import', 'api', 'partner'],
        default: 'import',
        aliases: ['lead source', 'channel', 'origin'],
      },
      {
        key: 'rating', label: 'Rating', type: 'enum', options: ['hot', 'warm', 'cold'],
        aliases: ['priority', 'temperature', 'grade'],
      },
      { key: 'estimated_value', label: 'Estimated value', type: 'money', aliases: ['value', 'deal size', 'opportunity value', 'amount'] },
      { key: 'notes', label: 'Notes', type: 'text', aliases: ['comments', 'remarks'] },
    ],
  },
  {
    key: 'hr.employees',
    app: 'hr',
    service: 'hr',
    label: 'HR employees',
    description: 'Your workforce — leave balances open automatically on import.',
    icon: 'UsersRound',
    endpoint: '/internal/import/employees',
    permission: 'hr.employees.create',
    dedupeOn: 'email',
    fields: [
      { key: 'first_name', label: 'First name', type: 'text', required: true, aliases: ['first', 'firstname', 'given name', 'name', 'employee name'] },
      { key: 'last_name', label: 'Last name', type: 'text', aliases: ['last', 'lastname', 'surname'] },
      { key: 'employee_code', label: 'Employee code', type: 'text', aliases: ['code', 'emp id', 'employee id', 'staff id', 'emp code'] },
      { key: 'email', label: 'Work email', type: 'email', aliases: ['email', 'official email', 'company email'] },
      { key: 'phone', label: 'Phone', type: 'phone', aliases: ['mobile', 'contact number'] },
      { key: 'designation', label: 'Designation', type: 'text', aliases: ['title', 'job title', 'role', 'position'] },
      { key: 'department_name', label: 'Department', type: 'text', aliases: ['dept', 'team', 'division'] },
      {
        key: 'employment_type', label: 'Employment type', type: 'enum',
        options: ['full_time', 'part_time', 'contract', 'intern', 'consultant'],
        default: 'full_time',
        aliases: ['type', 'contract type', 'employment'],
      },
      { key: 'joined_on', label: 'Joining date', type: 'date', aliases: ['doj', 'date of joining', 'start date', 'hire date', 'joined'] },
      { key: 'date_of_birth', label: 'Date of birth', type: 'date', aliases: ['dob', 'birth date', 'birthday'] },
      {
        key: 'gender', label: 'Gender', type: 'enum',
        options: ['female', 'male', 'other', 'undisclosed'],
        aliases: ['sex'],
      },
      { key: 'work_location', label: 'Work location', type: 'text', aliases: ['location', 'office', 'branch', 'site'] },
    ],
  },
];

const BY_KEY = new Map(IMPORT_TARGETS.map((t) => [t.key, t]));

export const importTarget = (key) => BY_KEY.get(key) ?? null;

/** Targets an entitled workspace may actually import into. */
export const importTargetsFor = (entitledApps = []) =>
  IMPORT_TARGETS.filter((t) => entitledApps.includes(t.app));

/**
 * Best-guess mapping from spreadsheet headers to target fields.
 *
 * Exact key match beats an alias, which beats a normalised substring. A
 * confident guess saves a person mapping twenty columns by hand; a wrong one
 * is cheap because the wizard shows every choice before anything is written.
 */
export function suggestMapping(headers, targetKey) {
  const target = BY_KEY.get(targetKey);
  if (!target) return {};

  const normalise = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const mapping = {};
  const claimed = new Set();

  const score = (header, field) => {
    const h = normalise(header);
    if (!h) return 0;
    if (h === normalise(field.key)) return 100;
    if (h === normalise(field.label)) return 95;
    if ((field.aliases ?? []).some((a) => normalise(a) === h)) return 90;
    if (h.replace(/\s/g, '') === normalise(field.key).replace(/\s/g, '')) return 85;
    if ((field.aliases ?? []).some((a) => h.includes(normalise(a)) || normalise(a).includes(h))) return 60;
    if (h.includes(normalise(field.label))) return 50;
    return 0;
  };

  // Highest-confidence pairs win first, so a generic "name" cannot steal the
  // slot that an exact "first_name" header deserves.
  const pairs = [];
  for (const header of headers) {
    for (const field of target.fields) {
      const value = score(header, field);
      if (value >= 50) pairs.push({ header, field: field.key, value });
    }
  }
  pairs.sort((a, b) => b.value - a.value);

  for (const pair of pairs) {
    if (mapping[pair.header] || claimed.has(pair.field)) continue;
    mapping[pair.header] = pair.field;
    claimed.add(pair.field);
  }

  return mapping;
}
