import { EVENTS } from '@nexus/contracts/events';
import { issueTermInvoice } from './invoices.js';
import { recomputeEntitlements } from './entitlements.js';

/**
 * The billing clock. Once a minute, under a lease row so replicas never
 * double-run it:
 *
 *   1. raise the renewal invoice a week before a paid term ends
 *   2. end trials that were not paid for          → past_due
 *   3. end paid terms whose renewal is unpaid      → past_due
 *   4. flag overdue adjustments                    → past_due
 *   5. honour cancel-at-period-end                 → canceled
 *
 * Entitlements carry their own expiry, so access already stops on time even
 * if this clock stalls — the clock moves the *status* the screens show.
 */
const RENEWAL_NOTICE_DAYS = 7;

export function startBillingClock({ db, logger, intervalMs = 60_000 }) {
  let timer;
  let running = true;
  const holder = `${process.pid}:${Math.random().toString(36).slice(2, 10)}`;

  async function withSubscription(subscriptionId, fn) {
    return db.transaction(async (tx) => {
      const subscription = await tx.one(`SELECT * FROM subscriptions WHERE id = $1 FOR UPDATE`, [subscriptionId]);
      if (!subscription) return;
      await fn(tx, subscription);
    });
  }

  async function tick() {
    try {
      const lease = await db.one(
        `INSERT INTO clock_leases (name, holder, until) VALUES ('billing', $1, now() + interval '5 minutes')
         ON CONFLICT (name) DO UPDATE SET holder = EXCLUDED.holder, until = EXCLUDED.until
          WHERE clock_leases.until < now() OR clock_leases.holder = EXCLUDED.holder
         RETURNING holder`,
        [holder],
      );
      if (!lease) return;
      try {
        // 1 — renewals
        const renewals = await db.rows(
          `SELECT s.id FROM subscriptions s
            WHERE s.status = 'active' AND NOT s.cancel_at_period_end
              AND s.current_period_end < now() + ($1 || ' days')::interval
              AND NOT EXISTS (
                SELECT 1 FROM invoices i
                 WHERE i.subscription_id = s.id AND i.kind = 'renewal'
                   AND i.status IN ('open', 'paid') AND i.period_start >= s.current_period_end)`,
          [RENEWAL_NOTICE_DAYS],
        );
        for (const { id } of renewals) {
          await withSubscription(id, (tx, s) => issueTermInvoice(tx, s));
        }

        // 2, 3 — a term (trial or paid) ended without the next one being paid
        const lapsed = await db.rows(
          `SELECT id FROM subscriptions
            WHERE (status = 'trialing' AND trial_ends_at < now())
               OR (status = 'active' AND current_period_end < now())`,
        );
        for (const { id } of lapsed) {
          await withSubscription(id, async (tx, s) => {
            if (s.cancel_at_period_end) {
              await tx.query(`UPDATE subscriptions SET status = 'canceled', canceled_at = COALESCE(canceled_at, now()) WHERE id = $1`, [s.id]);
              tx.emit({ type: EVENTS.SUBSCRIPTION_CANCELED, org_id: s.org_id, data: { subscription_id: s.id, immediate: false, reason: 'period_end' } });
            } else {
              // A trial's term is the trial itself.
              await tx.query(
                `UPDATE subscriptions SET status = 'past_due',
                        current_period_end = CASE WHEN status = 'trialing' THEN trial_ends_at ELSE current_period_end END
                  WHERE id = $1`,
                [s.id],
              );
              const open = await tx.one(
                `SELECT id, number, total FROM invoices WHERE subscription_id = $1 AND status = 'open' AND kind IN ('subscription','renewal') LIMIT 1`,
                [s.id],
              );
              if (!open) await issueTermInvoice(tx, { ...s, status: s.status === 'trialing' ? 'trialing' : 'active' });
              tx.emit({ type: EVENTS.INVOICE_OVERDUE, org_id: s.org_id, data: { subscription_id: s.id, invoice_id: open?.id ?? null } });
            }
            await recomputeEntitlements(tx, s.org_id);
          });
        }

        // 4 — adjustments left unpaid past their due date
        const overdue = await db.rows(
          `SELECT DISTINCT s.id FROM subscriptions s JOIN invoices i ON i.subscription_id = s.id
            WHERE s.status = 'active' AND i.status = 'open' AND i.kind = 'adjustment' AND i.due_at < now()`,
        );
        for (const { id } of overdue) {
          await withSubscription(id, async (tx, s) => {
            await tx.query(`UPDATE subscriptions SET status = 'past_due' WHERE id = $1`, [s.id]);
            tx.emit({ type: EVENTS.INVOICE_OVERDUE, org_id: s.org_id, data: { subscription_id: s.id } });
            await recomputeEntitlements(tx, s.org_id);
          });
        }
      } finally {
        await db.query(`UPDATE clock_leases SET until = now() WHERE name = 'billing' AND holder = $1`, [holder]).catch(() => {});
      }
    } catch (error) {
      logger.error({ err: error }, 'billing clock tick failed');
    } finally {
      if (running) timer = setTimeout(tick, intervalMs);
    }
  }

  timer = setTimeout(tick, 5_000);
  return {
    tick,
    stop() {
      running = false;
      clearTimeout(timer);
    },
  };
}
