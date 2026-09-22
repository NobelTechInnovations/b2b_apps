'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Store, Download, Sparkles, AlertTriangle, TrendingUp } from 'lucide-react';
import { money, date } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Card, CardHeader, CardBody, Badge, PageHeader, EmptyState, Alert } from '@/components/ui/primitives';
import { Button } from '@/components/ui/button';
import { Table, THead, TBody, TH, TR, TD } from '@/components/ui/table';
import { ConfirmModal } from '@/components/ui/modal';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/toast';

const STATUS_TONE = {
  trialing: 'brand',
  active: 'positive',
  past_due: 'caution',
  canceled: 'critical',
  paused: 'neutral',
};

export default function BillingClient({ subscription, plans }) {
  const toast = useToast();
  const [canceling, setCanceling] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!subscription) {
    return (
      <Card>
        <EmptyState
          icon={Sparkles}
          title="No subscription yet"
          description="Pick a plan to start using apps in this workspace."
          action={<Link href="/apps"><Button variant="primary">Choose apps</Button></Link>}
        />
      </Card>
    );
  }

  const currency = subscription.currency ?? 'INR';
  const recurring = subscription.items.reduce(
    (sum, item) => sum + Number(item.unit_price) * item.quantity,
    0,
  );

  async function cancel() {
    setBusy(true);
    try {
      await api.post('/subscriptions/current/cancel', { immediate: false });
      toast.success('Subscription set to cancel', {
        description: `You keep access until ${date(subscription.current_period_end)}.`,
      });
      setCanceling(false);
    } catch {
      toast.error('Could not cancel right now');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Plan & billing"
        description="What you are paying for, and what you can change."
        actions={
          <Link href="/apps">
            <Button variant="secondary" icon={Store}>Manage apps</Button>
          </Link>
        }
      />

      {subscription.status === 'trialing' && (
        <Alert tone={subscription.trial_days_left <= 3 ? 'caution' : 'info'} icon={Sparkles}>
          {subscription.trial_days_left > 0
            ? `${subscription.trial_days_left} days left in your free trial. Nothing has been charged yet.`
            : 'Your trial has ended. Add a payment method to keep your apps running.'}
        </Alert>
      )}

      {subscription.cancel_at_period_end && (
        <Alert tone="caution" icon={AlertTriangle}>
          This subscription ends on {date(subscription.current_period_end)}. Your data is kept for
          90 days after that.
        </Alert>
      )}

      {/* ── current plan ──────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title={`${subscription.plan_name} plan`}
          description={`Billed ${subscription.cycle} · renews ${date(subscription.current_period_end)}`}
          action={<Badge tone={STATUS_TONE[subscription.status]} dot>{subscription.status.replace('_', ' ')}</Badge>}
        />
        <CardBody>
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat label="Recurring total" value={money(recurring, currency)} suffix={`/${subscription.cycle === 'annual' ? 'yr' : 'mo'}`} />
            <Stat label="Seats" value={`${subscription.seats}`} suffix={`of ${subscription.included_users} included`} />
            <Stat label="Storage" value={`${subscription.storage_gb} GB`} />
          </div>
        </CardBody>
      </Card>

      {/* ── what you are paying for ───────────────────────────────────────── */}
      <div>
        <h2 className="mb-3 text-sm font-medium text-[var(--text-secondary)]">
          Apps on this subscription
        </h2>
        <Table>
          <THead>
            <tr>
              <TH>App</TH>
              <TH>Billing</TH>
              <TH align="right">Quantity</TH>
              <TH align="right">Unit price</TH>
              <TH align="right">Subtotal</TH>
            </tr>
          </THead>
          <TBody>
            {subscription.items.map((item) => (
              <TR key={item.id}>
                <TD>
                  <span className="font-medium">{item.name}</span>
                  {item.source === 'plan' && (
                    <Badge size="sm" tone="neutral" className="ml-2">In plan</Badge>
                  )}
                </TD>
                <TD className="text-[var(--text-secondary)]">
                  per {item.billing_unit}
                </TD>
                <TD align="right" numeric>{item.quantity}</TD>
                <TD align="right" numeric>
                  {Number(item.unit_price) === 0 ? '—' : money(item.unit_price, currency)}
                </TD>
                <TD align="right" numeric className="font-medium">
                  {Number(item.unit_price) === 0
                    ? 'Included'
                    : money(Number(item.unit_price) * item.quantity, currency)}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </div>

      {/* ── plan comparison ───────────────────────────────────────────────── */}
      <div>
        <h2 className="mb-3 text-sm font-medium text-[var(--text-secondary)]">Change your plan</h2>
        <div className="grid gap-3 md:grid-cols-3">
          {plans.map((plan) => {
            const current = plan.slug === subscription.plan;
            return (
              <Card key={plan.slug} className={cn('p-4', current && 'border-[var(--color-brand-500)]')}>
                <div className="flex items-start justify-between">
                  <p className="text-md font-semibold">{plan.name}</p>
                  {current && <Badge tone="brand" size="sm">Current</Badge>}
                </div>
                <p className="mt-0.5 text-xs text-[var(--text-secondary)]">{plan.tagline}</p>
                <p className="mt-3 text-xl font-semibold tabular tracking-[-0.02em]">
                  {Number(plan.base_price_monthly) === 0 ? 'Free' : money(plan.base_price_monthly, currency)}
                  {Number(plan.base_price_monthly) > 0 && (
                    <span className="text-xs font-normal text-[var(--text-tertiary)]"> /mo</span>
                  )}
                </p>
                <Button
                  variant={current ? 'ghost' : 'secondary'}
                  size="sm"
                  className="mt-3 w-full"
                  disabled={current}
                  icon={current ? undefined : TrendingUp}
                >
                  {current ? 'Your plan' : 'Switch'}
                </Button>
              </Card>
            );
          })}
        </div>
      </div>

      {/* ── invoices ──────────────────────────────────────────────────────── */}
      <div>
        <h2 className="mb-3 text-sm font-medium text-[var(--text-secondary)]">Invoices</h2>
        {subscription.invoices.length === 0 ? (
          <Card>
            <EmptyState
              icon={Download}
              title="No invoices yet"
              description="Your first invoice is issued when the trial ends."
            />
          </Card>
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Invoice</TH>
                <TH>Period</TH>
                <TH>Status</TH>
                <TH align="right">Amount</TH>
                <TH width={80} />
              </tr>
            </THead>
            <TBody>
              {subscription.invoices.map((invoice) => (
                <TR key={invoice.id}>
                  <TD className="font-medium">{invoice.number}</TD>
                  <TD className="text-[var(--text-secondary)]">
                    {date(invoice.period_start, 'short')} – {date(invoice.period_end, 'short')}
                  </TD>
                  <TD>
                    <Badge size="sm" tone={invoice.status === 'paid' ? 'positive' : 'caution'}>
                      {invoice.status}
                    </Badge>
                  </TD>
                  <TD align="right" numeric>{money(invoice.total, invoice.currency)}</TD>
                  <TD align="right">
                    <Button variant="ghost" size="xs" icon={Download}>PDF</Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </div>

      {!subscription.cancel_at_period_end && (
        <Card className="border-[rgb(239_68_68/0.25)]">
          <CardHeader
            title="Cancel subscription"
            description="You keep access until the end of the current period. Data is retained for 90 days."
            action={
              <Button variant="danger-ghost" size="sm" onClick={() => setCanceling(true)}>
                Cancel subscription
              </Button>
            }
          />
        </Card>
      )}

      <ConfirmModal
        open={canceling}
        onClose={() => setCanceling(false)}
        onConfirm={cancel}
        loading={busy}
        danger
        confirmLabel="Cancel subscription"
        title="Cancel your subscription?"
        description={`Your apps keep working until ${date(subscription.current_period_end)}. After that everyone loses access, though your data is kept for 90 days.`}
      />
    </div>
  );
}

function Stat({ label, value, suffix }) {
  return (
    <div className="rounded-[var(--radius-lg)] bg-[var(--surface-sunken)] px-4 py-3">
      <p className="text-xs text-[var(--text-tertiary)]">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular tracking-[-0.02em]">
        {value}
        {suffix && <span className="ml-1 text-xs font-normal text-[var(--text-tertiary)]">{suffix}</span>}
      </p>
    </div>
  );
}
