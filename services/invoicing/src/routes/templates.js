import { id } from '@nexus/db-kit';
import {
  requirePermission, body, params, validate as v, notFound, badRequest, conflict,
} from '@nexus/service-kit';
import { ensureTemplate, amountInWords } from '../lib/templates.js';

const colour = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' };

const EDITABLE = [
  'name', 'layout', 'accent', 'logo_url', 'accent_header',
  'seller_name', 'seller_address', 'seller_gstin', 'seller_pan',
  'seller_email', 'seller_phone', 'seller_website',
  'bank_name', 'bank_account', 'bank_ifsc', 'bank_branch', 'upi_id',
  'show_hsn', 'show_tax_breakdown', 'show_bank_details', 'show_amount_words',
  'show_signature', 'show_qr',
  'terms', 'footer_note', 'signature_name', 'signature_url',
];

const templateBody = {
  name: v.text(80, 1),
  layout: v.enum(['classic', 'modern', 'minimal']),
  accent: colour,
  // A logo is either a hosted image or a small inlined one. Anything larger
  // belongs in Documents, not on every render of every invoice.
  logo_url: { type: 'string', maxLength: 200_000 },
  accent_header: v.bool,
  seller_name: v.text(160), seller_address: v.text(500), seller_gstin: v.text(20),
  seller_pan: v.text(20), seller_email: v.text(160), seller_phone: v.text(40),
  seller_website: v.text(160),
  bank_name: v.text(120), bank_account: v.text(40), bank_ifsc: v.text(20),
  bank_branch: v.text(120), upi_id: v.text(120),
  show_hsn: v.bool, show_tax_breakdown: v.bool, show_bank_details: v.bool,
  show_amount_words: v.bool, show_signature: v.bool, show_qr: v.bool,
  terms: v.text(2000), footer_note: v.text(500),
  signature_name: v.text(120), signature_url: { type: 'string', maxLength: 200_000 },
  is_default: v.bool,
};

export async function templateRoutes(app) {
  const { db, settings } = app;

  app.get(
    '/invoicing/templates',
    { preHandler: [app.loadContext, requirePermission('invoicing.invoices.view')] },
    async (request) => {
      const { orgId } = request.ctx;
      await ensureTemplate(db, orgId);

      const rows = await db.rows(
        `SELECT t.*,
                (SELECT count(*)::int FROM invoices i WHERE i.template_id = t.id) AS used_by
           FROM invoice_templates t
          WHERE t.org_id = $1 AND t.archived_at IS NULL
          ORDER BY t.is_default DESC, t.name`,
        [orgId],
      );

      return { data: rows };
    },
  );

  app.post(
    '/invoicing/templates',
    {
      preHandler: [app.loadContext, requirePermission('invoicing.invoices.edit')],
      schema: { body: body(templateBody, ['name']) },
    },
    async (request, reply) => {
      const { orgId, userId } = request.ctx;
      const b = request.body;
      await ensureTemplate(db, orgId);

      const clash = await db.one(
        `SELECT id FROM invoice_templates WHERE org_id = $1 AND lower(name) = lower($2) AND archived_at IS NULL`,
        [orgId, b.name.trim()],
      );
      if (clash) throw conflict('A template with that name already exists.');

      const fields = EDITABLE.filter((f) => b[f] !== undefined);
      const columns = ['id', 'org_id', 'created_by', 'is_default', ...fields];
      const values = [id('tpl'), orgId, userId, b.is_default ?? false, ...fields.map((f) => b[f])];

      const row = await db.transaction(async (tx) => {
        if (b.is_default) {
          await tx.query(`UPDATE invoice_templates SET is_default = false WHERE org_id = $1 AND is_default`, [orgId]);
        }
        return tx.one(
          `INSERT INTO invoice_templates (${columns.join(', ')})
           VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
          values,
        );
      });

      return reply.status(201).send({ data: { ...row, used_by: 0 } });
    },
  );

  app.patch(
    '/invoicing/templates/:templateId',
    {
      preHandler: [app.loadContext, requirePermission('invoicing.invoices.edit')],
      schema: {
        params: params({ templateId: v.id('tpl') }),
        body: body(templateBody),
      },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const b = request.body;

      const fields = EDITABLE.filter((f) => b[f] !== undefined);
      if (!fields.length && b.is_default === undefined) throw badRequest('Nothing to update.');

      const row = await db.transaction(async (tx) => {
        if (b.is_default === true) {
          await tx.query(
            `UPDATE invoice_templates SET is_default = false WHERE org_id = $1 AND is_default AND id <> $2`,
            [orgId, request.params.templateId],
          );
        }
        if (b.is_default === false) {
          const current = await tx.one(
            `SELECT is_default FROM invoice_templates WHERE id = $1 AND org_id = $2`,
            [request.params.templateId, orgId],
          );
          // A workspace with no default template has nothing to render a new
          // invoice with.
          if (current?.is_default) throw badRequest('Make another template the default before clearing this one.');
        }

        const sets = [...fields.map((f, i) => `${f} = $${i + 3}`)];
        const values = [request.params.templateId, orgId, ...fields.map((f) => b[f])];
        if (b.is_default !== undefined) {
          values.push(b.is_default);
          sets.push(`is_default = $${values.length}`);
        }

        return tx.one(
          `UPDATE invoice_templates SET ${sets.join(', ')}
            WHERE id = $1 AND org_id = $2 AND archived_at IS NULL RETURNING *`,
          values,
        );
      });

      if (!row) throw notFound('Template');
      return { data: row };
    },
  );

  app.delete(
    '/invoicing/templates/:templateId',
    {
      preHandler: [app.loadContext, requirePermission('invoicing.invoices.edit')],
      schema: { params: params({ templateId: v.id('tpl') }) },
    },
    async (request) => {
      const { orgId } = request.ctx;

      const template = await db.one(
        `SELECT * FROM invoice_templates WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
        [request.params.templateId, orgId],
      );
      if (!template) throw notFound('Template');
      if (template.is_default) throw badRequest('The default template cannot be deleted.');

      // Invoices keep pointing at it: an issued invoice must still render the
      // way it was issued, so the row is archived rather than removed.
      await db.query(
        `UPDATE invoice_templates SET archived_at = now() WHERE id = $1 AND org_id = $2`,
        [template.id, orgId],
      );

      return { data: { archived: true } };
    },
  );

  // ══════════════════════════════════════════════════════════════ DOCUMENT
  /**
   * Everything needed to render one invoice as a document, in one read.
   *
   * The template is resolved here rather than in the browser: an invoice that
   * was issued under last year's branding must keep it, and only the server
   * knows which template it was stamped with.
   */
  app.get(
    '/invoicing/invoices/:invoiceId/document',
    {
      preHandler: [app.loadContext, requirePermission('invoicing.invoices.view')],
      schema: {
        params: params({ invoiceId: v.id('inv') }),
        querystring: {
          type: 'object',
          // Previewing a different template without saving anything.
          properties: { template_id: v.id('tpl') },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const { orgId } = request.ctx;

      const invoice = await db.one(
        `SELECT * FROM invoices WHERE id = $1 AND org_id = $2`,
        [request.params.invoiceId, orgId],
      );
      if (!invoice) throw notFound('Invoice');

      const [lines, payments, workspace] = await Promise.all([
        db.rows(
          `SELECT * FROM invoice_lines WHERE org_id = $1 AND invoice_id = $2 ORDER BY position`,
          [orgId, invoice.id],
        ),
        db.rows(
          `SELECT p.number, p.method, p.received_on, p.reference, a.amount
             FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
            WHERE a.org_id = $1 AND a.invoice_id = $2 ORDER BY p.received_on`,
          [orgId, invoice.id],
        ),
        settings.forOrg(orgId),
      ]);

      const requested = request.query.template_id ?? invoice.template_id;
      const template = requested
        ? await db.one(`SELECT * FROM invoice_templates WHERE id = $1 AND org_id = $2`, [requested, orgId])
        : null;

      const resolved = template ?? (await ensureTemplate(db, orgId));

      // Tax is grouped by rate, which is how a GST invoice must present it
      // and what the return expects.
      const taxGroups = new Map();
      for (const line of lines) {
        const rate = Number(line.tax_rate ?? 0);
        const group = taxGroups.get(rate) ?? {
          rate, taxable: 0, cgst: 0, sgst: 0, igst: 0,
        };
        group.taxable += Number(line.line_taxable ?? 0);
        group.cgst += Number(line.cgst_amount ?? 0);
        group.sgst += Number(line.sgst_amount ?? 0);
        group.igst += Number(line.igst_amount ?? 0);
        taxGroups.set(rate, group);
      }

      return {
        data: {
          invoice,
          lines,
          payments,
          template: resolved,
          workspace,
          amount_in_words: amountInWords(invoice.total),
          tax_groups: [...taxGroups.values()]
            .sort((a, b) => a.rate - b.rate)
            .map((g) => ({
              rate: g.rate,
              taxable: g.taxable.toFixed(2),
              cgst: g.cgst.toFixed(2),
              sgst: g.sgst.toFixed(2),
              igst: g.igst.toFixed(2),
              total: (g.cgst + g.sgst + g.igst).toFixed(2),
            })),
        },
      };
    },
  );
}
