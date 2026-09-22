/**
 * All price arithmetic lives here, in one readable place, using strings for
 * money so nothing ever round-trips through a float.
 */
const money = (n) => Math.round(Number(n) * 100) / 100;

export function quote({ plan, apps, seats, cycle = 'monthly' }) {
  const annual = cycle === 'annual';
  const lines = [];

  const base = annual ? Number(plan.base_price_annual) : Number(plan.base_price_monthly);
  lines.push({
    kind: 'platform',
    slug: plan.slug,
    label: `${plan.name} plan`,
    detail: `${plan.included_users} users included`,
    quantity: 1,
    unit_price: money(base),
    amount: money(base),
  });

  // Seats beyond what the plan includes.
  const extraSeats = Math.max(0, seats - plan.included_users);
  if (extraSeats > 0 && Number(plan.extra_user_price) > 0) {
    const unit = Number(plan.extra_user_price) * (annual ? 10 : 1); // 2 months free annually
    lines.push({
      kind: 'seats',
      slug: 'extra_users',
      label: 'Additional users',
      detail: `${extraSeats} × ${plan.included_users}+ `,
      quantity: extraSeats,
      unit_price: money(unit),
      amount: money(unit * extraSeats),
    });
  }

  for (const app of apps) {
    if (app.included_in_plan) {
      lines.push({
        kind: 'app',
        slug: app.slug,
        label: app.name,
        detail: 'Included in plan',
        quantity: 1,
        unit_price: 0,
        amount: 0,
      });
      continue;
    }

    const unit = annual ? Number(app.price_annual) : Number(app.price_monthly);
    const quantity = app.billing_unit === 'user' ? seats : 1;
    lines.push({
      kind: 'app',
      slug: app.slug,
      label: app.name,
      detail: app.billing_unit === 'user' ? `${seats} users × ₹${money(unit)}` : 'Per workspace',
      quantity,
      unit_price: money(unit),
      amount: money(unit * quantity),
    });
  }

  const subtotal = money(lines.reduce((sum, l) => sum + l.amount, 0));
  const taxRate = 0.18; // GST
  const tax = money(subtotal * taxRate);

  return {
    cycle,
    seats,
    lines,
    subtotal: subtotal.toFixed(2),
    tax_rate: taxRate,
    tax_amount: tax.toFixed(2),
    total: money(subtotal + tax).toFixed(2),
    monthly_equivalent: annual ? money((subtotal + tax) / 12).toFixed(2) : money(subtotal + tax).toFixed(2),
    annual_saving: annual ? null : undefined,
  };
}

export function periodEnd(from, cycle) {
  const date = new Date(from);
  if (cycle === 'annual') date.setFullYear(date.getFullYear() + 1);
  else date.setMonth(date.getMonth() + 1);
  return date;
}
