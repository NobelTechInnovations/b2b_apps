import { id } from '@nexus/db-kit';

/**
 * Employment letters.
 *
 * Generated from the record rather than retyped, because the figures in an
 * offer letter are the same figures payroll will pay — and a letter that
 * disagrees with the system is worse than no letter. Once issued, the rendered
 * body is stored and never re-rendered: a letter must read in five years
 * exactly as it read on the day it was signed.
 */

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** `2026-09-23` → `23 September 2026`. Letters do not print ISO dates. */
export function longDate(value) {
  if (!value) return '';
  const iso = typeof value === 'string' ? value.slice(0, 10) : null;
  if (!iso) return '';
  const [year, month, day] = iso.split('-').map(Number);
  if (!year || !month || !day) return '';
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

export function inr(amount) {
  const value = Number(amount ?? 0);
  if (!Number.isFinite(value)) return '₹0';
  return `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

const DEFAULT_TEMPLATES = [
  {
    kind: 'offer',
    name: 'Offer letter',
    subject: 'Offer of employment — {{designation}}',
    body: `**{{company}}**
{{company_address}}

{{date}}

**Private and confidential**

{{employee_name}}
{{employee_address}}

Dear {{first_name}},

**Offer of employment**

We are pleased to offer you the position of **{{designation}}**{{department_clause}} at
{{company}}, reporting to {{manager}}.

Your employment is expected to begin on **{{joining_date}}**.

| | |
|---|---|
| Position | {{designation}} |
| Employment type | {{employment_type}} |
| Location | {{location}} |
| Annual cost to company | {{annual_ctc}} |
| Monthly gross | {{monthly_gross}} |

A detailed breakdown of your salary, including the statutory deductions that
apply, will be provided with your first payslip.

This offer is subject to verification of the documents and references you have
provided, and to your acceptance of the terms of employment that accompany this
letter.

Please confirm your acceptance by {{valid_until}}.

We are looking forward to working with you.

Yours sincerely,

**{{issued_by}}**
{{company}}`,
  },
  {
    kind: 'appointment',
    name: 'Appointment letter',
    subject: 'Appointment — {{designation}}',
    body: `**{{company}}**
{{company_address}}

{{date}}

{{employee_name}}
Employee code: {{employee_code}}

Dear {{first_name}},

**Appointment as {{designation}}**

Further to your acceptance of our offer, we are pleased to confirm your
appointment as **{{designation}}**{{department_clause}} with effect from
**{{joining_date}}**.

Your annual cost to company is **{{annual_ctc}}**, payable monthly in arrears,
subject to statutory deductions.

Your working hours and leave entitlement are as set out in the employee
handbook. You will report to {{manager}}.

Yours sincerely,

**{{issued_by}}**
{{company}}`,
  },
  {
    kind: 'confirmation',
    name: 'Confirmation letter',
    subject: 'Confirmation of employment',
    body: `**{{company}}**

{{date}}

{{employee_name}}
Employee code: {{employee_code}}

Dear {{first_name}},

**Confirmation of employment**

We are pleased to confirm that you have successfully completed your probation
period as **{{designation}}**. Your employment with {{company}} is confirmed
with effect from {{date}}.

Your continued contribution is valued, and we wish you a long and successful
career with us.

Yours sincerely,

**{{issued_by}}**
{{company}}`,
  },
  {
    kind: 'experience',
    name: 'Experience certificate',
    subject: 'Experience certificate',
    body: `**{{company}}**
{{company_address}}

{{date}}

**TO WHOMSOEVER IT MAY CONCERN**

This is to certify that **{{employee_name}}** (employee code {{employee_code}})
was employed with {{company}} from **{{joining_date}}** to **{{exit_date}}**.

At the time of leaving, {{first_name}} held the position of **{{designation}}**
{{department_clause}}.

During the tenure, conduct and performance were found to be satisfactory.

We wish {{first_name}} every success in future endeavours.

Yours faithfully,

**{{issued_by}}**
{{company}}`,
  },
  {
    kind: 'relieving',
    name: 'Relieving letter',
    subject: 'Relieving letter',
    body: `**{{company}}**
{{company_address}}

{{date}}

{{employee_name}}
Employee code: {{employee_code}}

Dear {{first_name}},

**Relieving letter**

This is to confirm that you have been relieved from your duties as
**{{designation}}** at {{company}} with effect from the close of business on
**{{exit_date}}**.

All company property in your possession has been returned and your full and
final settlement will be processed in the ordinary payroll cycle.

We thank you for your contribution and wish you well.

Yours sincerely,

**{{issued_by}}**
{{company}}`,
  },
];

/** A workspace gets usable letters the first time it opens the screen. */
export async function ensureLetterTemplates(db, orgId) {
  const existing = await db.one(
    `SELECT count(*)::int AS n FROM letter_templates WHERE org_id = $1 AND archived_at IS NULL`,
    [orgId],
  );
  if (existing.n > 0) return;

  await db.transaction(async (tx) => {
    const raced = await tx.one(
      `SELECT count(*)::int AS n FROM letter_templates WHERE org_id = $1`,
      [orgId],
    );
    if (raced.n > 0) return;

    for (const template of DEFAULT_TEMPLATES) {
      await tx.query(
        `INSERT INTO letter_templates (id, org_id, name, kind, subject, body, is_default)
         VALUES ($1,$2,$3,$4,$5,$6,true)`,
        [id('ltp'), orgId, template.name, template.kind, template.subject, template.body],
      );
    }
  });
}

/**
 * Fill a template.
 *
 * Substitution is literal and total: an unknown placeholder becomes an empty
 * string rather than being left on the page as `{{whatever}}`, because a
 * letter that goes out with visible template syntax is an embarrassment the
 * sender only notices after sending.
 */
export function renderLetter(template, context) {
  return String(template).replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, key) => {
    const value = context[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

/** Everything a letter may refer to, from the employee and their salary. */
export function letterContext({ employee, org, salary, issuedBy, validUntil, extra = {} }) {
  const name = [employee.first_name, employee.last_name].filter(Boolean).join(' ');
  const address = employee.address ?? {};

  return {
    company: org?.name ?? '',
    company_address: [address.company_line, org?.address?.line1, org?.address?.city]
      .filter(Boolean)
      .join('\n'),
    date: longDate(new Date().toISOString()),

    employee_name: name,
    first_name: employee.first_name ?? '',
    last_name: employee.last_name ?? '',
    employee_code: employee.employee_code ?? '',
    designation: employee.designation ?? '',
    department: employee.department_name ?? '',
    // Reads as "as Machine Operator in Production" or just "as Machine
    // Operator" — a dangling "in" when there is no department is exactly the
    // kind of thing nobody proofreads out.
    department_clause: employee.department_name ? ` in ${employee.department_name}` : '',
    employment_type: (employee.employment_type ?? 'full_time').replace(/_/g, ' '),
    location: employee.work_location ?? '',
    manager: employee.manager_name ?? 'your reporting manager',
    joining_date: longDate(employee.joined_on),
    exit_date: longDate(employee.exited_on),
    email: employee.email ?? '',
    phone: employee.phone ?? '',
    employee_address: [address.line1, address.line2, address.city, address.state, address.postal_code]
      .filter(Boolean)
      .join('\n'),

    annual_ctc: salary?.annual_ctc ? inr(salary.annual_ctc) : 'as discussed',
    monthly_gross: salary?.monthly_gross ? inr(salary.monthly_gross) : 'as discussed',

    issued_by: issuedBy ?? '',
    valid_until: longDate(validUntil),
    ...extra,
  };
}

/** Letters are numbered so they can be referred to in correspondence. */
export async function nextLetterReference(tx, orgId, kind) {
  const prefix = `${kind.slice(0, 3).toUpperCase()}/${new Date().getFullYear()}/`;

  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`letter:${orgId}:${kind}`]);

  const row = await tx.one(
    `SELECT reference FROM employee_documents
      WHERE org_id = $1 AND reference LIKE $2 || '%'
      ORDER BY reference DESC LIMIT 1`,
    [orgId, prefix],
  );

  const next = row ? Number(row.reference.split('/').pop()) + 1 : 1;
  return `${prefix}${String(next).padStart(4, '0')}`;
}
