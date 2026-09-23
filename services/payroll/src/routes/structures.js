import { id } from '@nexus/db-kit';
import {
  requirePermission, body, params, validate as v, notFound, badRequest, conflict,
} from '@nexus/service-kit';
import { toPaise, toRupees } from '../lib/money.js';
import { resolveEarnings } from '../lib/payroll.js';
import { ensurePayrollSetup, structureComponents } from '../lib/setup.js';

const CALCULATIONS = ['fixed', 'percent_of_basic', 'percent_of_gross', 'percent_of_ctc', 'balance'];

export async function structureRoutes(app) {
  const { db } = app;

  // ══════════════════════════════════════════════════════════════ SETTINGS
  app.get(
    '/payroll/settings',
    { preHandler: [app.loadContext, requirePermission('payroll.structures.view')] },
    async (request) => {
      const settings = await ensurePayrollSetup(db, request.ctx.orgId);
      return { data: settings };
    },
  );

  app.patch(
    '/payroll/settings',
    {
      preHandler: [app.loadContext, requirePermission('payroll.structures.manage')],
      schema: {
        body: body({
          pf_enabled: v.bool, pf_employee_rate: v.money, pf_employer_rate: v.money,
          pf_wage_ceiling: v.money, pf_on_actual_wage: v.bool,
          esi_enabled: v.bool, esi_employee_rate: v.money, esi_employer_rate: v.money,
          esi_gross_ceiling: v.money,
          pt_enabled: v.bool, pt_state: v.enum(['MH', 'KA', 'WB', 'TN', 'TS', 'GJ', 'NONE']),
          tds_enabled: v.bool, tds_regime: v.enum(['new', 'old']),
          overtime_enabled: v.bool, overtime_multiplier: v.money,
          days_basis: v.enum(['calendar', 'fixed_26', 'working']),
          payslip_prefix: v.text(8), pay_day: v.int(1, 28),
          employer_name: v.text(160), employer_address: v.text(400),
          employer_pan: v.text(20), employer_tan: v.text(20),
          pf_establishment: v.text(40), esi_establishment: v.text(40),
        }),
      },
    },
    async (request) => {
      const { orgId } = request.ctx;
      await ensurePayrollSetup(db, orgId);

      const fields = Object.keys(request.body);
      if (!fields.length) throw badRequest('Nothing to update.');

      const sets = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
      const updated = await db.one(
        `UPDATE payroll_settings SET ${sets} WHERE org_id = $1 RETURNING *`,
        [orgId, ...fields.map((f) => request.body[f])],
      );

      return { data: updated };
    },
  );

  // ════════════════════════════════════════════════════════════ COMPONENTS
  app.get(
    '/payroll/components',
    { preHandler: [app.loadContext, requirePermission('payroll.structures.view')] },
    async (request) => {
      await ensurePayrollSetup(db, request.ctx.orgId);
      const rows = await db.rows(
        `SELECT * FROM salary_components
          WHERE org_id = $1 AND archived_at IS NULL ORDER BY position, name`,
        [request.ctx.orgId],
      );
      return { data: rows };
    },
  );

  app.post(
    '/payroll/components',
    {
      preHandler: [app.loadContext, requirePermission('payroll.structures.manage')],
      schema: {
        body: body(
          {
            name: v.text(80, 1),
            code: { type: 'string', pattern: '^[A-Za-z0-9_]{1,20}$' },
            kind: v.enum(['earning', 'deduction']),
            calculation: v.enum(CALCULATIONS),
            value: v.money,
            pf_applicable: v.bool, esi_applicable: v.bool, taxable: v.bool,
            position: v.int(0, 999),
          },
          ['name', 'code'],
        ),
      },
    },
    async (request, reply) => {
      const { orgId } = request.ctx;
      const b = request.body;
      await ensurePayrollSetup(db, orgId);

      const clash = await db.one(
        `SELECT id FROM salary_components
          WHERE org_id = $1 AND upper(code) = upper($2) AND archived_at IS NULL`,
        [orgId, b.code],
      );
      if (clash) throw conflict(`A component with the code ${b.code.toUpperCase()} already exists.`);

      if (b.calculation === 'balance') {
        const existing = await db.one(
          `SELECT id FROM salary_components
            WHERE org_id = $1 AND calculation = 'balance' AND archived_at IS NULL`,
          [orgId],
        );
        // Two balancing components would each try to absorb the remainder and
        // the earnings would come to more than gross.
        if (existing) throw badRequest('Only one component can absorb the balance of gross.');
      }

      const row = await db.one(
        `INSERT INTO salary_components
           (id, org_id, name, code, kind, calculation, value,
            pf_applicable, esi_applicable, taxable, position)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          id('cmp'), orgId, b.name.trim(), b.code.toUpperCase(), b.kind ?? 'earning',
          b.calculation ?? 'fixed', b.value ?? '0',
          b.pf_applicable ?? false, b.esi_applicable ?? true, b.taxable ?? true,
          b.position ?? 100,
        ],
      );

      return reply.status(201).send({ data: row });
    },
  );

  app.patch(
    '/payroll/components/:componentId',
    {
      preHandler: [app.loadContext, requirePermission('payroll.structures.manage')],
      schema: {
        params: params({ componentId: v.id('cmp') }),
        body: body({
          name: v.text(80, 1), calculation: v.enum(CALCULATIONS), value: v.money,
          pf_applicable: v.bool, esi_applicable: v.bool, taxable: v.bool, position: v.int(0, 999),
        }),
      },
    },
    async (request) => {
      const fields = Object.keys(request.body);
      if (!fields.length) throw badRequest('Nothing to update.');

      const sets = fields.map((f, i) => `${f} = $${i + 3}`).join(', ');
      const row = await db.one(
        `UPDATE salary_components SET ${sets}
          WHERE id = $1 AND org_id = $2 AND archived_at IS NULL RETURNING *`,
        [request.params.componentId, request.ctx.orgId, ...fields.map((f) => request.body[f])],
      );
      if (!row) throw notFound('Component');

      return { data: row };
    },
  );

  app.delete(
    '/payroll/components/:componentId',
    {
      preHandler: [app.loadContext, requirePermission('payroll.structures.manage')],
      schema: { params: params({ componentId: v.id('cmp') }) },
    },
    async (request) => {
      const { orgId } = request.ctx;

      const inUse = await db.one(
        `SELECT count(*)::int AS n FROM structure_components
          WHERE org_id = $1 AND component_id = $2`,
        [orgId, request.params.componentId],
      );
      if (inUse.n > 0) {
        throw badRequest(`This component is part of ${inUse.n} salary structure${inUse.n === 1 ? '' : 's'}. Remove it there first.`);
      }

      const row = await db.one(
        `UPDATE salary_components SET archived_at = now()
          WHERE id = $1 AND org_id = $2 AND archived_at IS NULL AND NOT is_system RETURNING id`,
        [request.params.componentId, orgId],
      );
      if (!row) throw notFound('Component');

      return { data: { archived: true } };
    },
  );

  // ════════════════════════════════════════════════════════════ STRUCTURES
  app.get(
    '/payroll/structures',
    { preHandler: [app.loadContext, requirePermission('payroll.structures.view')] },
    async (request) => {
      const { orgId } = request.ctx;
      await ensurePayrollSetup(db, orgId);

      const rows = await db.rows(
        `SELECT s.*,
                (SELECT count(*)::int FROM structure_components sc WHERE sc.structure_id = s.id) AS component_count,
                (SELECT count(*)::int FROM employee_salaries es
                  WHERE es.structure_id = s.id AND es.effective_to IS NULL) AS assigned_count
           FROM salary_structures s
          WHERE s.org_id = $1 AND s.archived_at IS NULL
          ORDER BY s.is_default DESC, s.name`,
        [orgId],
      );

      return { data: rows };
    },
  );

  app.get(
    '/payroll/structures/:structureId',
    {
      preHandler: [app.loadContext, requirePermission('payroll.structures.view')],
      schema: { params: params({ structureId: v.id('str') }) },
    },
    async (request) => {
      const { orgId } = request.ctx;

      const structure = await db.one(
        `SELECT * FROM salary_structures WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
        [request.params.structureId, orgId],
      );
      if (!structure) throw notFound('Structure');

      const components = await structureComponents(db, orgId, structure.id);

      return { data: { ...structure, components } };
    },
  );

  app.post(
    '/payroll/structures',
    {
      preHandler: [app.loadContext, requirePermission('payroll.structures.manage')],
      schema: {
        body: body(
          {
            name: v.text(80, 1),
            code: v.text(20),
            description: v.text(400),
            is_default: v.bool,
            components: {
              type: 'array',
              maxItems: 40,
              items: {
                type: 'object',
                properties: {
                  component_id: v.id('cmp'),
                  calculation: v.enum(CALCULATIONS),
                  value: v.money,
                  position: v.int(0, 999),
                },
                required: ['component_id'],
                additionalProperties: false,
              },
            },
          },
          ['name'],
        ),
      },
    },
    async (request, reply) => {
      const { orgId, userId } = request.ctx;
      const b = request.body;
      await ensurePayrollSetup(db, orgId);

      const clash = await db.one(
        `SELECT id FROM salary_structures WHERE org_id = $1 AND lower(name) = lower($2) AND archived_at IS NULL`,
        [orgId, b.name.trim()],
      );
      if (clash) throw conflict('A structure with that name already exists.');

      const structure = await db.transaction(async (tx) => {
        if (b.is_default) {
          await tx.query(`UPDATE salary_structures SET is_default = false WHERE org_id = $1 AND is_default`, [orgId]);
        }

        const row = await tx.one(
          `INSERT INTO salary_structures (id, org_id, name, code, description, is_default, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [id('str'), orgId, b.name.trim(), b.code ?? null, b.description ?? null, b.is_default ?? false, userId],
        );

        for (const [index, component] of (b.components ?? []).entries()) {
          await tx.query(
            `INSERT INTO structure_components (id, org_id, structure_id, component_id, calculation, value, position)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [
              id('scp'), orgId, row.id, component.component_id,
              component.calculation ?? null, component.value ?? null,
              component.position ?? index * 10,
            ],
          );
        }

        return row;
      });

      const components = await structureComponents(db, orgId, structure.id);
      return reply.status(201).send({ data: { ...structure, components } });
    },
  );

  app.put(
    '/payroll/structures/:structureId/components',
    {
      preHandler: [app.loadContext, requirePermission('payroll.structures.manage')],
      schema: {
        params: params({ structureId: v.id('str') }),
        body: body(
          {
            components: {
              type: 'array',
              maxItems: 40,
              items: {
                type: 'object',
                properties: {
                  component_id: v.id('cmp'),
                  calculation: v.enum(CALCULATIONS),
                  value: v.money,
                  position: v.int(0, 999),
                },
                required: ['component_id'],
                additionalProperties: false,
              },
            },
          },
          ['components'],
        ),
      },
    },
    async (request) => {
      const { orgId } = request.ctx;

      const structure = await db.one(
        `SELECT * FROM salary_structures WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
        [request.params.structureId, orgId],
      );
      if (!structure) throw notFound('Structure');

      const balancing = request.body.components.filter((c) => c.calculation === 'balance');
      if (balancing.length > 1) throw badRequest('Only one component can absorb the balance of gross.');

      await db.transaction(async (tx) => {
        // Replace wholesale. The editor sends the full list, and a diff would
        // only be a more elaborate way of arriving at the same rows.
        await tx.query(`DELETE FROM structure_components WHERE structure_id = $1 AND org_id = $2`, [structure.id, orgId]);

        for (const [index, component] of request.body.components.entries()) {
          await tx.query(
            `INSERT INTO structure_components (id, org_id, structure_id, component_id, calculation, value, position)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [
              id('scp'), orgId, structure.id, component.component_id,
              component.calculation ?? null, component.value ?? null,
              component.position ?? index * 10,
            ],
          );
        }
      });

      const components = await structureComponents(db, orgId, structure.id);
      return { data: { ...structure, components } };
    },
  );

  app.delete(
    '/payroll/structures/:structureId',
    {
      preHandler: [app.loadContext, requirePermission('payroll.structures.manage')],
      schema: { params: params({ structureId: v.id('str') }) },
    },
    async (request) => {
      const { orgId } = request.ctx;

      const structure = await db.one(
        `SELECT * FROM salary_structures WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
        [request.params.structureId, orgId],
      );
      if (!structure) throw notFound('Structure');
      if (structure.is_default) throw badRequest('The default structure cannot be deleted.');

      const assigned = await db.one(
        `SELECT count(*)::int AS n FROM employee_salaries
          WHERE org_id = $1 AND structure_id = $2 AND effective_to IS NULL`,
        [orgId, structure.id],
      );
      if (assigned.n > 0) {
        throw badRequest(`${assigned.n} ${assigned.n === 1 ? 'salary uses' : 'salaries use'} this structure. Move them first.`);
      }

      await db.query(`UPDATE salary_structures SET archived_at = now() WHERE id = $1 AND org_id = $2`, [structure.id, orgId]);
      return { data: { archived: true } };
    },
  );

  // ══════════════════════════════════════════════════════════════ BREAKDOWN
  /**
   * What a given gross would actually break into under a structure.
   * The screen calls this on every keystroke, so it reads nothing it does not
   * need and writes nothing at all.
   */
  app.post(
    '/payroll/structures/:structureId/breakdown',
    {
      preHandler: [app.loadContext, requirePermission('payroll.structures.view')],
      schema: {
        params: params({ structureId: v.id('str') }),
        body: body({ monthly_gross: v.money, annual_ctc: v.money }, []),
      },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const components = await structureComponents(db, orgId, request.params.structureId);
      if (!components.length) throw badRequest('This structure has no components yet.');

      const annualCtc = toPaise(request.body.annual_ctc ?? 0);
      // Given only a CTC, gross is derived from it — employer contributions
      // are part of CTC but never part of what lands in the bank.
      const monthlyGross = request.body.monthly_gross
        ? toPaise(request.body.monthly_gross)
        : Math.round(annualCtc / 12);

      const resolved = resolveEarnings({ components, monthlyGrossPaise: monthlyGross, annualCtcPaise: annualCtc });

      return {
        data: {
          monthly_gross: toRupees(monthlyGross),
          annual_gross: toRupees(monthlyGross * 12),
          basic: toRupees(resolved.basic),
          allocated: toRupees(resolved.total),
          lines: resolved.lines.map((line) => ({
            code: line.code,
            name: line.name,
            calculation: line.calculation,
            amount: toRupees(line.amount),
            annual: toRupees(line.amount * 12),
            basis: line.basis,
            share: monthlyGross ? Math.round((line.amount / monthlyGross) * 1000) / 10 : 0,
          })),
        },
      };
    },
  );
}
