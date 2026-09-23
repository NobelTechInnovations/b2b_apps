import { id } from '@nexus/db-kit';
import { EVENTS } from '@nexus/contracts/events';
import { computeInvoice, toRupees, asRupees } from './money.js';
import { isInterstate, stateCodeFromGstin } from './numbering.js';

/**
 * What invoicing listens for.
 *
 * This is where the platform's claim — that apps are connected, not merely
 * co-located — has to be true. A deal won in CRM raises a draft invoice here,
 * with no polling, no shared table and no direct call from CRM.
 *
 * Delivery is at-least-once, so every handler records the event id and
 * ignores a redelivery. The unique index on (org_id, source, source_ref) is
 * the second line of defence.
 */
export function registerConsumers({ bus, db, settings, logger }) {
  /** Returns false when this event has already been handled. */
  async function claim(tx, event) {
    const row = await tx.one(
      `INSERT INTO consumed_events (event_id, event_type, org_id)
       VALUES ($1, $2, $3) ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [event.id, event.type, event.org_id ?? null],
    );
    return Boolean(row);
  }

  // ── CRM customers are projected here ─────────────────────────────────────
  const upsertCustomer = async (event) => {
    const { org_id: orgId, data } = event;
    if (!orgId || !data?.company_id) return;

    await db.query(
      `INSERT INTO customers (id, org_id, name, email, phone, gstin, place_of_supply, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         email = COALESCE(EXCLUDED.email, customers.email),
         phone = COALESCE(EXCLUDED.phone, customers.phone),
         gstin = COALESCE(EXCLUDED.gstin, customers.gstin),
         place_of_supply = COALESCE(EXCLUDED.place_of_supply, customers.place_of_supply),
         synced_at = now()`,
      [
        data.company_id, orgId, data.name ?? 'Unnamed customer',
        data.email ?? null, data.phone ?? null, data.gstin ?? null,
        stateCodeFromGstin(data.gstin),
      ],
    );

    logger.debug({ customer: data.company_id }, 'customer projection updated');
  };

  bus.subscribe('invoicing', EVENTS.CUSTOMER_CREATED, upsertCustomer);
  bus.subscribe('invoicing', EVENTS.CUSTOMER_UPDATED, upsertCustomer);

  // ── a won deal becomes a draft invoice ───────────────────────────────────
  bus.subscribe('invoicing', EVENTS.DEAL_WON, async (event) => {
    const { org_id: orgId, data, actor_id: actorId } = event;
    if (!orgId || !data?.deal_id) return;

    const value = Number(data.value ?? 0);
    if (value <= 0) {
      logger.info({ deal: data.deal_id }, 'won deal has no value; no invoice raised');
      return;
    }

    const org = await settings.forOrg(orgId);

    await db.transaction(async (tx) => {
      if (!(await claim(tx, event))) {
        logger.debug({ event: event.id }, 'deal.won already handled');
        return;
      }

      // The customer projection may not have arrived yet — events are not
      // ordered across services. Fall back to the name on the deal.
      const customer = data.company_id
        ? await tx.one(`SELECT * FROM customers WHERE id = $1 AND org_id = $2`,
            [data.company_id, orgId])
        : null;

      const buyerState = customer?.place_of_supply ?? stateCodeFromGstin(customer?.gstin);
      const interstate = isInterstate(org.state_code, buyerState);

      const lines = [{
        description: data.title ?? 'Services',
        quantity: 1,
        unit_price: value.toFixed(2),
        tax_rate: org.default_tax_rate,
        position: 0,
      }];

      const { lines: computed, totals } = computeInvoice(lines, { isInterstate: interstate });
      const money = asRupees(totals);

      const invoice = await tx.one(
        `INSERT INTO invoices
           (id, org_id, customer_id, customer_name, customer_gstin, place_of_supply,
            is_interstate, issue_date, terms_days, due_date, currency,
            subtotal, discount_total, taxable_total, cgst_total, sgst_total, igst_total,
            tax_total, round_off, total, amount_due, reference, source, source_ref,
            notes, terms, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7, current_date, $8::integer,
                 current_date + $8::integer, $9,
                 $10,$11,$12,$13,$14,$15,$16,$17,$18,$18,$19,'deal_won',$20,$21,$22,$23)
         ON CONFLICT (org_id, source, source_ref) WHERE source_ref IS NOT NULL
           DO NOTHING
         RETURNING *`,
        [
          id('inv'), orgId, customer?.id ?? null,
          customer?.name ?? data.company_name ?? 'Customer',
          customer?.gstin ?? null, buyerState ?? null, interstate,
          org.default_terms_days, org.currency,
          money.subtotal, money.discount_total, money.taxable_total,
          money.cgst_total, money.sgst_total, money.igst_total,
          money.tax_total, money.round_off, money.total,
          data.title ?? null, data.deal_id,
          `Raised automatically when the deal “${data.title ?? data.deal_id}” was won.`,
          org.default_terms, actorId ?? null,
        ],
      );

      if (!invoice) {
        logger.debug({ deal: data.deal_id }, 'draft invoice already exists for this deal');
        return;
      }

      for (const line of computed) {
        await tx.query(
          `INSERT INTO invoice_lines
             (id, org_id, invoice_id, position, description, quantity, unit, unit_price,
              discount_percent, tax_rate, line_subtotal, line_discount, line_taxable,
              cgst_amount, sgst_amount, igst_amount, line_total)
           VALUES ($1,$2,$3,$4,$5,$6,'nos',$7,0,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [
            id('inl'), orgId, invoice.id, line.position, line.description,
            line.quantity ?? 1, toRupees(line.line_subtotal), line.tax_rate,
            toRupees(line.line_subtotal), toRupees(line.line_discount),
            toRupees(line.line_taxable), toRupees(line.cgst_amount),
            toRupees(line.sgst_amount), toRupees(line.igst_amount),
            toRupees(line.line_total),
          ],
        );
      }

      logger.info(
        { deal: data.deal_id, invoice: invoice.id, total: invoice.total },
        'draft invoice raised from won deal',
      );
    });
  });

  logger.info('listening for crm.customer.* and crm.deal.won');
}
