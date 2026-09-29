/**
 * Human numbers per workspace: PO-0001, MO-0001, POS-000001. The counter row
 * is incremented inside the caller's transaction, so a rolled-back order does
 * not burn a number.
 */
export async function nextNumber(tx, orgId, kind, prefix, padding = 4) {
  const row = await tx.one(
    `INSERT INTO counters (org_id, kind, last_value) VALUES ($1, $2, 1)
     ON CONFLICT (org_id, kind) DO UPDATE SET last_value = counters.last_value + 1
     RETURNING last_value`,
    [orgId, kind],
  );
  return `${prefix}-${String(row.last_value).padStart(padding, '0')}`;
}
