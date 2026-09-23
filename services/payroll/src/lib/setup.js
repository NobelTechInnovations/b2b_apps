import { id } from '@nexus/db-kit';

/**
 * A workspace that opens payroll for the first time gets a working salary
 * structure rather than an empty screen. These are the components almost
 * every Indian salary is built from, in the proportions most employers use.
 * They are ordinary rows — rename them, re-weight them, delete them.
 */
const DEFAULT_COMPONENTS = [
  {
    code: 'BASIC', name: 'Basic', kind: 'earning', calculation: 'percent_of_gross', value: 50,
    pf: true, esi: true, taxable: true, position: 10,
  },
  {
    code: 'HRA', name: 'House rent allowance', kind: 'earning', calculation: 'percent_of_basic', value: 40,
    pf: false, esi: true, taxable: true, position: 20,
  },
  {
    code: 'CONV', name: 'Conveyance allowance', kind: 'earning', calculation: 'fixed', value: 1600,
    pf: false, esi: true, taxable: true, position: 30,
  },
  {
    code: 'MED', name: 'Medical allowance', kind: 'earning', calculation: 'fixed', value: 1250,
    pf: false, esi: true, taxable: true, position: 40,
  },
  // Absorbs the remainder, so the earnings always add up to gross exactly.
  {
    code: 'SPECIAL', name: 'Special allowance', kind: 'earning', calculation: 'balance', value: 0,
    pf: false, esi: true, taxable: true, position: 50,
  },
];

export async function ensurePayrollSetup(db, orgId) {
  const settings = await db.one(`SELECT * FROM payroll_settings WHERE org_id = $1`, [orgId]);
  if (settings) return settings;

  return db.transaction(async (tx) => {
    // Two first-time requests can race; the primary key settles it.
    const created = await tx.one(
      `INSERT INTO payroll_settings (org_id) VALUES ($1)
       ON CONFLICT (org_id) DO NOTHING RETURNING *`,
      [orgId],
    );
    if (!created) return tx.one(`SELECT * FROM payroll_settings WHERE org_id = $1`, [orgId]);

    const structure = await tx.one(
      `INSERT INTO salary_structures (id, org_id, name, code, description, is_default)
       VALUES ($1,$2,'Standard salary','STD',
               'Basic 50% of gross, HRA 40% of basic, the rest as special allowance.', true)
       RETURNING *`,
      [id('str'), orgId],
    );

    for (const component of DEFAULT_COMPONENTS) {
      const row = await tx.one(
        `INSERT INTO salary_components
           (id, org_id, name, code, kind, calculation, value,
            part_of_gross, pf_applicable, esi_applicable, taxable, position)
         VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8,$9,$10,$11) RETURNING id`,
        [
          id('cmp'), orgId, component.name, component.code, component.kind,
          component.calculation, component.value,
          component.pf, component.esi, component.taxable, component.position,
        ],
      );

      await tx.query(
        `INSERT INTO structure_components (id, org_id, structure_id, component_id, position)
         VALUES ($1,$2,$3,$4,$5)`,
        [id('scp'), orgId, structure.id, row.id, component.position],
      );
    }

    return created;
  });
}

/** Components of a structure, falling back to the default one. */
export async function structureComponents(db, orgId, structureId) {
  const rows = await db.rows(
    `SELECT c.id, c.name, c.code, c.kind, c.part_of_gross, c.pf_applicable,
            c.esi_applicable, c.taxable, c.statutory_key,
            COALESCE(sc.calculation, c.calculation) AS calculation,
            COALESCE(sc.value, c.value) AS value,
            sc.position
       FROM structure_components sc
       JOIN salary_components c ON c.id = sc.component_id AND c.archived_at IS NULL
      WHERE sc.org_id = $1 AND sc.structure_id = $2
      ORDER BY sc.position`,
    [orgId, structureId],
  );
  return rows;
}

export async function defaultStructure(db, orgId) {
  return db.one(
    `SELECT * FROM salary_structures
      WHERE org_id = $1 AND is_default AND archived_at IS NULL`,
    [orgId],
  );
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** First and last day of a payroll month, as plain `YYYY-MM-DD` strings. */
export function periodFor(year, month) {
  const pad = (n) => String(n).padStart(2, '0');
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    year,
    month,
    start: `${year}-${pad(month)}-01`,
    end: `${year}-${pad(month)}-${pad(lastDay)}`,
    label: `${MONTHS[month - 1]} ${year}`,
    days: lastDay,
  };
}

/**
 * Payslip numbers run PS/2026-27/0001 and never reuse a value.
 *
 * The lock serialises concurrent runs. Without it two payslips created in the
 * same millisecond would both read the same maximum and both claim it.
 */
export async function nextPayslipNumber(tx, orgId, { prefix, fiscalYear }) {
  const pattern = `${prefix}/${fiscalYear}/`;

  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`payslip:${orgId}:${fiscalYear}`]);

  const row = await tx.one(
    `SELECT payslip_number FROM payslips
      WHERE org_id = $1 AND payslip_number LIKE $2 || '%'
      ORDER BY payslip_number DESC LIMIT 1`,
    [orgId, pattern],
  );

  const next = row ? Number(row.payslip_number.split('/').pop()) + 1 : 1;
  return `${pattern}${String(next).padStart(4, '0')}`;
}

/** Indian financial year label for a month: April 2026 → "2026-27". */
export function fiscalYear(year, month) {
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}
