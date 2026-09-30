import { body, validate as v, requireInternal, nullable } from '@nexus/service-kit';
import { createInvoice } from '../lib/invoice-writer.js';

const line = body({
  description: v.text(300, 1), hsn_sac: nullable(v.text(20)), quantity: { type: 'number', exclusiveMinimum: 0, maximum: 1e6 },
  unit: v.text(20, 1), unit_price: { anyOf: [{ type: 'number', minimum: 0 }, v.money] }, discount_percent: { type: 'number', minimum: 0, maximum: 100 },
  tax_rate: { type: 'number', minimum: 0, maximum: 100 },
}, ['description', 'unit_price']);

/**
 * Other services raise invoices here — an accepted quote, a completed field
 * visit — over the internal network with the service token, never from a
 * browser. The invoice writer makes it idempotent on (source, source_ref).
 */
export async function internalRoutes(app) {
  const { db, settings } = app;

  app.post('/internal/invoices', {
    preHandler: requireInternal(),
    schema: {
      body: body({
        org_id: v.text(40, 1), actor_id: nullable(v.text(40)), issue: v.bool,
        customer: body({ id: nullable(v.id('cmp')), name: v.text(200, 1), gstin: nullable(v.text(15)), email: nullable(v.email) }, ['name']),
        lines: { type: 'array', minItems: 1, maxItems: 200, items: line },
        source: v.enum(['quote', 'field_service', 'api']), source_ref: v.text(120, 1), reference: nullable(v.text(80)), notes: nullable(v.text(2000)),
      }, ['org_id', 'customer', 'lines', 'source', 'source_ref']),
    },
  }, async (request, reply) => {
    const b = request.body;
    const invoice = await db.transaction((tx) => createInvoice(tx, {
      settings, orgId: b.org_id, userId: b.actor_id ?? null, customer: b.customer, lines: b.lines,
      source: b.source, sourceRef: b.source_ref, reference: b.reference ?? null, notes: b.notes ?? null, issue: Boolean(b.issue),
    }));
    return reply.status(201).send({ data: { id: invoice.id, number: invoice.number, status: invoice.status, total: invoice.total } });
  });
}
