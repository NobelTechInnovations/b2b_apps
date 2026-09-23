/**
 * Invoice numbering.
 *
 * A tax authority reads a missing number as a destroyed invoice, so the
 * sequence must be gap-free and strictly increasing within a financial year.
 * The counter row is locked FOR UPDATE inside the issuing transaction: two
 * concurrent issues serialise rather than colliding, and a rollback returns
 * the number to the pool.
 *
 * This is also why a draft has no number. Numbers are spent at issue, not at
 * creation — otherwise every abandoned draft would punch a hole in the run.
 */

const DEFAULT_PREFIXES = { invoice: 'INV', credit_note: 'CN', payment: 'PAY' };

/**
 * Indian financial year: 1 April to 31 March.
 * 22 Sep 2026 → "2026-27"; 15 Feb 2027 → "2026-27".
 */
export function fiscalYear(date = new Date(), startMonth = 4) {
  const d = typeof date === 'string' ? new Date(`${date}T00:00:00`) : date;
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const start = month >= startMonth ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** Reserve the next number. Must be called inside a transaction. */
export async function nextNumber(tx, { orgId, kind = 'invoice', date, fiscalYearStart = 4 }) {
  const year = fiscalYear(date, fiscalYearStart);
  const prefix = DEFAULT_PREFIXES[kind] ?? 'DOC';

  // Create the counter on first use, then lock it. ON CONFLICT DO UPDATE
  // (rather than DO NOTHING) guarantees a row comes back to lock in one trip.
  const sequence = await tx.one(
    `INSERT INTO number_sequences (org_id, kind, fiscal_year, prefix, next_value)
     VALUES ($1, $2, $3, $4, 1)
     ON CONFLICT (org_id, kind, fiscal_year)
       DO UPDATE SET next_value = number_sequences.next_value
     RETURNING *`,
    [orgId, kind, year, prefix],
  );

  const locked = await tx.one(
    `SELECT * FROM number_sequences
      WHERE org_id = $1 AND kind = $2 AND fiscal_year = $3
      FOR UPDATE`,
    [orgId, kind, year],
  );

  const value = locked.next_value;

  await tx.query(
    `UPDATE number_sequences SET next_value = next_value + 1
      WHERE org_id = $1 AND kind = $2 AND fiscal_year = $3`,
    [orgId, kind, year],
  );

  return {
    number: `${locked.prefix}/${year}/${String(value).padStart(locked.padding, '0')}`,
    fiscal_year: year,
    sequence: value,
  };
}

/**
 * GST state code from a GSTIN — the first two digits.
 * 27AAAAA0000A1Z5 → "27" (Maharashtra).
 */
export function stateCodeFromGstin(gstin) {
  if (!gstin) return null;
  const match = String(gstin).trim().match(/^(\d{2})/);
  return match ? match[1] : null;
}

/**
 * Is this a inter-state supply?
 *
 * Unknown on either side means we cannot claim it is interstate, and the
 * safer default is the intra-state split — an IGST invoice raised wrongly is
 * far harder for a customer to reclaim than a CGST/SGST one.
 */
export function isInterstate(sellerStateCode, buyerStateCode) {
  if (!sellerStateCode || !buyerStateCode) return false;
  return sellerStateCode !== buyerStateCode;
}

/** Ageing bucket for a receivables report. */
export function ageingBucket(dueDate, asOf = new Date()) {
  if (!dueDate) return 'not_due';
  const due = typeof dueDate === 'string' ? new Date(`${dueDate}T00:00:00`) : dueDate;
  const days = Math.floor((asOf - due) / 86_400_000);

  if (days < 0) return 'not_due';
  if (days <= 30) return '1_30';
  if (days <= 60) return '31_60';
  if (days <= 90) return '61_90';
  return 'over_90';
}
