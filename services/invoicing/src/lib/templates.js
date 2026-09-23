import { id } from '@nexus/db-kit';

/**
 * Every workspace gets a usable invoice design the first time it looks at one,
 * so nobody has to build a template before sending their first invoice. It is
 * an ordinary row: restyle it, rename it, or replace it as the default.
 */
export async function ensureTemplate(db, orgId) {
  const existing = await db.one(
    `SELECT * FROM invoice_templates WHERE org_id = $1 AND is_default AND archived_at IS NULL`,
    [orgId],
  );
  if (existing) return existing;

  try {
    return await db.one(
      `INSERT INTO invoice_templates
         (id, org_id, name, layout, accent, is_default, terms, footer_note)
       VALUES ($1, $2, 'Standard', 'classic', '#4f46e5', true,
               'Payment due within 30 days of the invoice date. Interest at 18% per annum applies to overdue amounts.',
               'Thank you for your business.')
       RETURNING *`,
      [id('tpl'), orgId],
    );
  } catch {
    // Two first-time requests raced; the partial unique index settled it.
    return db.one(
      `SELECT * FROM invoice_templates WHERE org_id = $1 AND is_default AND archived_at IS NULL`,
      [orgId],
    );
  }
}

/**
 * An amount in words, in the Indian system — lakh and crore, not million.
 * Every invoice carries one, and a wrong one is worse than none.
 */
export function amountInWords(amount, currency = 'INR') {
  const ONES = [
    '', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
    'eighteen', 'nineteen',
  ];
  const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

  const under100 = (n) =>
    n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? `-${ONES[n % 10]}` : ''}`;

  const under1000 = (n) =>
    n < 100
      ? under100(n)
      : `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` and ${under100(n % 100)}` : ''}`;

  const value = Math.abs(Number(amount) || 0);
  const whole = Math.floor(value);
  const fraction = Math.round((value - whole) * 100);

  const major = currency === 'INR' ? 'rupee' : 'unit';
  const minor = currency === 'INR' ? 'paise' : 'cents';

  if (whole === 0 && fraction === 0) return `Zero ${major}s only`;

  const parts = [];
  let rest = whole;
  for (const [unit, name] of [[10_000_000, 'crore'], [100_000, 'lakh'], [1000, 'thousand']]) {
    const count = Math.floor(rest / unit);
    if (count) { parts.push(`${under1000(count)} ${name}`); rest %= unit; }
  }
  if (rest) parts.push(under1000(rest));

  const head = parts.length ? `${parts.join(' ')} ${major}${whole === 1 ? '' : 's'}` : '';
  const tail = fraction ? `${head ? ' and ' : ''}${under100(fraction)} ${minor}` : '';

  const sentence = `${Number(amount) < 0 ? 'minus ' : ''}${head}${tail} only`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
