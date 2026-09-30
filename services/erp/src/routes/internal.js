import { body, validate as v, requireInternal, nullable } from '@nexus/service-kit';
import { moveStock, defaultWarehouse } from '../lib/stock.js';

/**
 * What other services may ask of the stock ledger, over the internal network
 * only. Sales orders confirmed in CRM deliver from the default warehouse;
 * delivering the same order twice moves stock once.
 */
export async function internalRoutes(app) {
  const { db } = app;

  app.post('/internal/erp/deliveries', {
    preHandler: requireInternal(),
    schema: {
      body: body({
        org_id: v.text(40, 1), actor_id: nullable(v.text(40)), reference: v.text(80, 1), source_type: v.text(40, 1), source_id: v.text(80, 1),
        lines: { type: 'array', minItems: 1, maxItems: 200, items: body({ product_id: v.id('prd'), quantity: { type: 'number', exclusiveMinimum: 0 } }, ['product_id', 'quantity']) },
      }, ['org_id', 'reference', 'source_type', 'source_id', 'lines']),
    },
  }, async (request) => {
    const b = request.body;
    const moved = await db.transaction(async (tx) => {
      const done = await tx.one(`SELECT 1 FROM stock_moves WHERE org_id = $1 AND source_type = $2 AND source_id = $3 LIMIT 1`, [b.org_id, b.source_type, b.source_id]);
      if (done) return { already: true, moves: 0 };
      const wh = await defaultWarehouse(tx, b.org_id);
      let count = 0;
      for (const line of b.lines) {
        const product = await tx.one(`SELECT type FROM products WHERE org_id = $1 AND id = $2`, [b.org_id, line.product_id]);
        if (!product || product.type === 'service') continue;
        await moveStock(tx, {
          orgId: b.org_id, userId: b.actor_id ?? null, productId: line.product_id, fromWarehouseId: wh.id, quantity: line.quantity,
          kind: 'delivery', reference: b.reference, sourceType: b.source_type, sourceId: b.source_id,
        });
        count += 1;
      }
      return { already: false, moves: count };
    });
    return { data: moved };
  });
}
