import { id } from '@nexus/db-kit';
import { nextNumber } from './numbers.js';

/**
 * Raise the quality checks a receipt or a production run calls for.
 *
 * A plan applies when its trigger matches and it names the product, the
 * product's category, or neither (every product). No plans, no checks — so
 * a workspace without the Quality app is never slowed down by it.
 */
export async function createChecks(tx, { orgId, userId, trigger, items, sourceType, sourceId, sourceRef }) {
  const plans = await tx.rows(`SELECT * FROM quality_plans WHERE org_id = $1 AND active AND trigger = $2`, [orgId, trigger]);
  if (!plans.length) return [];
  const created = [];
  for (const item of items) {
    const product = await tx.one(`SELECT id, category_id FROM products WHERE org_id = $1 AND id = $2`, [orgId, item.product_id]);
    if (!product) continue;
    for (const plan of plans) {
      const applies = (plan.product_id && plan.product_id === product.id)
        || (!plan.product_id && plan.category_id && plan.category_id === product.category_id)
        || (!plan.product_id && !plan.category_id);
      if (!applies) continue;
      const results = (plan.checklist ?? []).map((point) => ({ label: point.label, passed: null, note: '' }));
      created.push(await tx.one(
        `INSERT INTO quality_checks (id, org_id, number, plan_id, product_id, trigger, source_type, source_id, source_ref, quantity, results, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [id('qc'), orgId, await nextNumber(tx, orgId, 'qc', 'QC'), plan.id, product.id, trigger, sourceType, sourceId, sourceRef,
          item.quantity ?? null, JSON.stringify(results), userId ?? null],
      ));
    }
  }
  return created;
}
