import { id } from '@nexus/db-kit';
import { badRequest, notFound } from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';

/**
 * The stock ledger. Every change to what is on a shelf — a purchase received,
 * a till sale, a machine's spare part, a finished batch — goes through
 * `moveStock`, inside the caller's transaction. Nothing else writes
 * `stock_quants`, which is how the balance and the history cannot disagree.
 */

/** The workspace's default warehouse, created on first use. */
export async function defaultWarehouse(tx, orgId) {
  const existing = await tx.one(`SELECT * FROM warehouses WHERE org_id = $1 AND is_default`, [orgId]);
  if (existing) return existing;
  await tx.query(
    `INSERT INTO warehouses (id, org_id, code, name, is_default) VALUES ($1, $2, 'MAIN', 'Main warehouse', true)
     ON CONFLICT DO NOTHING`,
    [id('wh'), orgId],
  );
  return tx.one(`SELECT * FROM warehouses WHERE org_id = $1 AND is_default`, [orgId]);
}

export async function warehouseOrDefault(tx, orgId, warehouseId) {
  if (!warehouseId) return defaultWarehouse(tx, orgId);
  const row = await tx.one(`SELECT * FROM warehouses WHERE org_id = $1 AND id = $2`, [orgId, warehouseId]);
  if (!row) throw badRequest('Choose one of this workspace’s warehouses.');
  return row;
}

export async function product(tx, orgId, productId, { lock = false } = {}) {
  const row = await tx.one(`SELECT * FROM products WHERE org_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`, [orgId, productId]);
  if (!row) throw notFound('Product');
  return row;
}

export async function onHand(store, orgId, productId, warehouseId) {
  const row = warehouseId
    ? await store.one(`SELECT quantity FROM stock_quants WHERE org_id = $1 AND product_id = $2 AND warehouse_id = $3`, [orgId, productId, warehouseId])
    : await store.one(`SELECT COALESCE(sum(quantity), 0) AS quantity FROM stock_quants WHERE org_id = $1 AND product_id = $2`, [orgId, productId]);
  return Number(row?.quantity ?? 0);
}

const fmt = (n) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 3 });

/**
 * Move `quantity` of a product out of `from`, into `to`, or between them.
 *
 * Services have no stock and consumables are not counted, so both are
 * recorded as a move (for the history) without touching a balance. Stock may
 * not go below zero unless the caller says so: only a till sale rung up
 * offline does, because that sale has already happened — the negative
 * balance is then a count to fix, not a sale to refuse.
 */
export async function moveStock(tx, {
  orgId, userId, productId, fromWarehouseId = null, toWarehouseId = null, quantity, kind,
  reference = null, sourceType = null, sourceId = null, unitCost = null, note = null, allowNegative = false,
}) {
  const qty = Number(quantity);
  if (!(qty > 0)) throw badRequest('Quantity must be more than zero.');
  if (!fromWarehouseId && !toWarehouseId) throw new Error('moveStock needs a source or a destination warehouse');
  const item = await product(tx, orgId, productId);
  if (item.type === 'service') throw badRequest(`${item.name} is a service and has no stock.`);
  const counted = item.type === 'stockable';

  let before = null;
  if (counted) {
    before = await onHand(tx, orgId, productId);
    if (fromWarehouseId) {
      await tx.query(
        `INSERT INTO stock_quants (org_id, product_id, warehouse_id, quantity) VALUES ($1, $2, $3, 0)
         ON CONFLICT DO NOTHING`,
        [orgId, productId, fromWarehouseId],
      );
      const quant = await tx.one(
        `SELECT quantity FROM stock_quants WHERE org_id = $1 AND product_id = $2 AND warehouse_id = $3 FOR UPDATE`,
        [orgId, productId, fromWarehouseId],
      );
      if (!allowNegative && Number(quant.quantity) < qty) {
        throw badRequest(`Only ${fmt(quant.quantity)} ${item.uom} of ${item.name} in stock there; ${fmt(qty)} needed.`, { code: 'insufficient_stock', product_id: productId });
      }
      await tx.query(
        `UPDATE stock_quants SET quantity = quantity - $4, updated_at = now() WHERE org_id = $1 AND product_id = $2 AND warehouse_id = $3`,
        [orgId, productId, fromWarehouseId, qty],
      );
    }
    if (toWarehouseId) {
      await tx.query(
        `INSERT INTO stock_quants (org_id, product_id, warehouse_id, quantity) VALUES ($1, $2, $3, $4)
         ON CONFLICT (org_id, product_id, warehouse_id) DO UPDATE SET quantity = stock_quants.quantity + EXCLUDED.quantity, updated_at = now()`,
        [orgId, productId, toWarehouseId, qty],
      );
    }
  }

  const move = await tx.one(
    `INSERT INTO stock_moves (id, org_id, product_id, from_warehouse_id, to_warehouse_id, quantity, unit_cost, kind,
                              reference, source_type, source_id, note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [id('mov'), orgId, productId, fromWarehouseId, toWarehouseId, qty, unitCost ?? item.cost_price, kind,
      reference, sourceType, sourceId, note, userId ?? null],
  );

  // Crossing the reorder line (not merely being under it) raises one alert.
  if (counted && fromWarehouseId && !toWarehouseId && Number(item.reorder_level) > 0) {
    const after = before - qty;
    if (before > Number(item.reorder_level) && after <= Number(item.reorder_level)) {
      tx.emit({
        type: EVENTS.STOCK_LOW,
        org_id: orgId,
        actor_id: userId ?? null,
        data: { product_id: item.id, name: item.name, sku: item.sku, on_hand: after, reorder_level: Number(item.reorder_level) },
      });
    }
  }
  return move;
}
