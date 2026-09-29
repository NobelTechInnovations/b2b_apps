/**
 * All price arithmetic lives here, in one readable place.
 *
 * Money is worked in integer paise and handed out as rupee strings with two
 * decimals, so nothing ever round-trips through a float.
 *
 * A term costs:
 *   plan base
 * + seats beyond the plan's allowance × extra seat price
 * + apps beyond the plan's allowance  × extra app price
 * all × the months in the term (annual = `annual_months`, usually 10 for 12),
 * plus GST.
 */
export const GST_RATE = Number(process.env.BILLING_GST_RATE ?? 0.18);

const paise = (rupees) => Math.round(Number(rupees ?? 0) * 100);
const rupees = (p) => (p / 100).toFixed(2);

export function termMonths(plan, cycle) {
  return cycle === 'annual' ? Number(plan.annual_months ?? 10) : 1;
}

/**
 * The line items for one full term. `apps` is the list of non-core app slugs
 * (or objects with a slug and name) on the subscription.
 */
export function quote({ plan, apps, seats, cycle = 'monthly' }) {
  const months = termMonths(plan, cycle);
  const per = cycle === 'annual' ? `${months} months billed for 12` : 'per month';
  const lines = [];

  const base = paise(plan.base_price_monthly) * months;
  lines.push({
    kind: 'platform',
    slug: plan.slug,
    label: `${plan.name} plan`,
    detail: `${plan.included_users} seats${plan.included_app_count ? ` · ${plan.included_app_count} apps` : ''} · ${per}`,
    quantity: 1,
    unit_price: rupees(base),
    amount: rupees(base),
  });

  const extraSeats = Math.max(0, seats - Number(plan.included_users));
  if (extraSeats > 0) {
    const unit = paise(plan.extra_user_price) * months;
    lines.push({
      kind: 'seats',
      slug: 'extra_seats',
      label: `Extra seats (${extraSeats})`,
      detail: `${extraSeats} × ₹${Number(plan.extra_user_price)} / month`,
      quantity: extraSeats,
      unit_price: rupees(unit),
      amount: rupees(unit * extraSeats),
    });
  }

  const list = apps.map((a) => (typeof a === 'string' ? { slug: a, name: a } : a));
  const allowance = plan.included_app_count === null || plan.included_app_count === undefined
    ? Infinity
    : Number(plan.included_app_count);
  const includedApps = list.slice(0, allowance);
  const extraApps = list.slice(allowance);

  if (includedApps.length) {
    lines.push({
      kind: 'apps',
      slug: 'included_apps',
      label: `Apps included (${includedApps.length}${Number.isFinite(allowance) ? ` of ${allowance}` : ''})`,
      detail: includedApps.map((a) => a.name).join(', '),
      quantity: includedApps.length,
      unit_price: '0.00',
      amount: '0.00',
    });
  }

  if (extraApps.length) {
    const unit = paise(plan.extra_app_price) * months;
    lines.push({
      kind: 'apps',
      slug: 'extra_apps',
      label: `Extra apps (${extraApps.length})`,
      detail: `${extraApps.map((a) => a.name).join(', ')} · ₹${Number(plan.extra_app_price)} each / month`,
      quantity: extraApps.length,
      unit_price: rupees(unit),
      amount: rupees(unit * extraApps.length),
    });
  }

  const subtotal = lines.reduce((sum, l) => sum + paise(l.amount), 0);
  const tax = Math.round(subtotal * GST_RATE);
  const total = subtotal + tax;

  return {
    cycle,
    seats,
    months,
    app_count: list.length,
    included_app_count: Number.isFinite(allowance) ? allowance : null,
    extra_app_count: extraApps.length,
    extra_seat_count: extraSeats,
    lines,
    subtotal: rupees(subtotal),
    tax_rate: GST_RATE,
    tax_amount: rupees(tax),
    total: rupees(total),
    monthly_equivalent: rupees(Math.round(total / (cycle === 'annual' ? 12 : 1))),
  };
}

/**
 * What an increase part-way through a paid term costs: the difference between
 * the new and old term prices, scaled by the share of the term still to run.
 * Decreases return zero — the paid term is not refunded, the next one is cheaper.
 */
export function prorate({ before, after, periodStart, periodEnd, now = new Date() }) {
  const start = new Date(periodStart).getTime();
  const end = new Date(periodEnd).getTime();
  const length = Math.max(1, end - start);
  // A term paid ahead (e.g. during the trial) has not started yet: the whole
  // of it is still to run, never more.
  const remaining = Math.min(length, Math.max(0, end - now.getTime()));
  const delta = paise(after.subtotal) - paise(before.subtotal);
  if (delta <= 0 || remaining === 0) return null;

  const subtotal = Math.round((delta * remaining) / length);
  if (subtotal < 100) return null; // under a rupee is not worth an invoice
  const tax = Math.round(subtotal * GST_RATE);
  const days = Math.ceil(remaining / 86_400_000);
  return {
    subtotal: rupees(subtotal),
    tax_amount: rupees(tax),
    total: rupees(subtotal + tax),
    days_remaining: days,
    fraction: remaining / length,
  };
}

export function periodEnd(from, cycle) {
  const date = new Date(from);
  if (cycle === 'annual') date.setFullYear(date.getFullYear() + 1);
  else date.setMonth(date.getMonth() + 1);
  return date;
}
