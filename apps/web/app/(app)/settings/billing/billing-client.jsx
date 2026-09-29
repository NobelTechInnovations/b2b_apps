'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import {
  Store, Sparkles, AlertTriangle, CreditCard, Users, LayoutGrid, Receipt, CheckCircle2,
  Minus, Plus, ArrowUpRight, RotateCcw, FileText,
} from 'lucide-react';
import { money, date } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Card, CardHeader, CardBody, Badge, PageHeader, EmptyState, Alert } from '@/components/ui/primitives';
import { Button } from '@/components/ui/button';
import { Table, THead, TBody, TH, TR, TD } from '@/components/ui/table';
import { ConfirmModal, Modal } from '@/components/ui/modal';
import { api } from '@/lib/api';
import { payInvoice } from '@/lib/payments';
import { useToast } from '@/components/ui/toast';

const STATUS = {
  trialing: { tone: 'brand', label: 'Free trial' },
  incomplete: { tone: 'caution', label: 'Awaiting payment' },
  active: { tone: 'positive', label: 'Active' },
  past_due: { tone: 'critical', label: 'Payment overdue' },
  canceled: { tone: 'critical', label: 'Canceled' },
  paused: { tone: 'neutral', label: 'Paused' },
};

const KIND = { subscription: 'First term', renewal: 'Renewal', adjustment: 'Mid-term change' };

export default function BillingClient({ subscription, plans, usage }) {
  const router = useRouter();
  const toast = useToast();
  const [canceling, setCanceling] = useState(false);
  const [busy, setBusy] = useState(null);
  const [seats, setSeats] = useState(subscription?.seats ?? 0);
  const [seatQuote, setSeatQuote] = useState(null);
  const [testInvoice, setTestInvoice] = useState(null);

  const inUse = (usage?.members ?? 0) + (usage?.invited ?? 0);

  // Live price as the seat count changes, from the same quote the server bills.
  useEffect(() => {
    if (!subscription || seats === subscription.seats) {
      setSeatQuote(null);
      return undefined;
    }
    const timer = setTimeout(() => {
      api
        .post('/subscriptions/quote', {
          plan: subscription.plan_retired ? plans[0]?.slug : subscription.plan,
          app_slugs: subscription.items.map((i) => i.app_slug),
          seats,
          cycle: subscription.cycle,
        })
        .then((r) => setSeatQuote(r.data))
        .catch(() => setSeatQuote(null));
    }, 250);
    return () => clearTimeout(timer);
  }, [seats, subscription, plans]);

  const openInvoices = useMemo(
    () => (subscription?.invoices ?? []).filter((i) => i.status === 'open'),
    [subscription],
  );

  if (!subscription) {
    return (
      <Card>
        <EmptyState
          icon={Sparkles}
          title="No subscription yet"
          description="Pick a plan to start using apps in this workspace."
          action={<Link href="/onboarding"><Button variant="primary">Choose a plan</Button></Link>}
        />
      </Card>
    );
  }

  const currency = subscription.currency ?? 'INR';
  const status = STATUS[subscription.status] ?? STATUS.active;
  const term = subscription.term_quote;
  const perTerm = subscription.cycle === 'annual' ? 'year' : 'month';
  const appCount = subscription.items.filter((i) => i.app_slug !== 'core').length;

  async function run(key, action, success) {
    setBusy(key);
    try {
      const done = await action();
      if (done !== false) {
        if (success) toast.success(success);
        router.refresh();
      }
    } catch (error) {
      toast.error(error.message ?? 'Something went wrong');
    } finally {
      setBusy(null);
    }
  }

  const pay = (invoice) =>
    run(
      `pay:${invoice.id}`,
      () => payInvoice(invoice.id, {
        confirmTest: (inv) => new Promise((resolve) => setTestInvoice({ ...inv, resolve })),
      }),
      `Payment received for ${invoice.number}`,
    );

  const change = (body, message) => run('change', () => api.patch('/subscriptions/current', body), message);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Plan & billing"
        description="Paid in advance, one term at a time. Change seats or apps whenever you need."
        actions={
          <Link href="/apps">
            <Button variant="secondary" icon={Store}>Manage apps</Button>
          </Link>
        }
      />

      {/* ── what needs attention ──────────────────────────────────────────── */}
      {subscription.status === 'trialing' && (
        <Alert tone={subscription.trial_days_left <= 3 ? 'caution' : 'info'} icon={Sparkles}>
          {subscription.trial_days_left > 0
            ? `${subscription.trial_days_left} day${subscription.trial_days_left === 1 ? '' : 's'} left in your free trial. Pay your first term in advance to keep everything running when it ends — paying early never shortens the trial.`
            : 'Your trial has ended. Pay the first term to keep your apps running.'}
        </Alert>
      )}
      {subscription.status === 'incomplete' && (
        <Alert tone="caution" icon={CreditCard}>
          Pay your first term to switch on your apps. Your workspace, members and settings are ready.
        </Alert>
      )}
      {subscription.status === 'past_due' && (
        <Alert tone="critical" icon={AlertTriangle}>
          A payment is overdue. Apps stay available for a short grace period — pay now to avoid an interruption.
        </Alert>
      )}
      {subscription.cancel_at_period_end && subscription.status !== 'canceled' && (
        <Alert
          tone="caution"
          icon={AlertTriangle}
          action={
            <Button size="sm" variant="secondary" icon={RotateCcw} loading={busy === 'resume'}
              onClick={() => run('resume', () => api.post('/subscriptions/current/resume', {}), 'Subscription resumed')}>
              Keep subscription
            </Button>
          }
        >
          This subscription ends on {date(subscription.current_period_end)}. Your data is kept for 90 days after that.
        </Alert>
      )}

      {openInvoices.length > 0 && (
        <Card className="border-[var(--color-brand-300)]">
          <CardBody className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-sm text-[var(--text-secondary)]">Amount due</p>
              <p className="mt-0.5 text-2xl font-semibold tabular tracking-[-0.02em]">
                {money(subscription.amount_due, currency)}
              </p>
              <p className="mt-1 text-xs text-[var(--text-tertiary)]">
                {openInvoices.length} open invoice{openInvoices.length === 1 ? '' : 's'} · next due{' '}
                {date(subscription.next_due_invoice?.due_at)}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {openInvoices.map((invoice) => (
                <Button key={invoice.id} variant="primary" icon={CreditCard}
                  loading={busy === `pay:${invoice.id}`} disabled={Boolean(busy)} onClick={() => pay(invoice)}>
                  Pay {money(invoice.total, currency)} · {KIND[invoice.kind]}
                </Button>
              ))}
            </div>
          </CardBody>
          {!subscription.payments?.provider && (
            <div className="border-t border-[var(--border-subtle)] px-5 py-3 text-xs text-[var(--text-secondary)]">
              Online payment is not switched on for this workspace yet. Contact support to pay by bank transfer.
            </div>
          )}
        </Card>
      )}

      {/* ── current plan ──────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title={`${subscription.plan_name} plan`}
          description={
            subscription.status === 'trialing'
              ? `Trial ends ${date(subscription.trial_ends_at)} · billed ${subscription.cycle}`
              : `Billed ${subscription.cycle} · current term ends ${date(subscription.current_period_end)}`
          }
          action={<Badge tone={status.tone} dot>{status.label}</Badge>}
        />
        <CardBody>
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat icon={Receipt} label={`Price per ${perTerm}`} value={money(term.total, currency)} suffix="incl. GST" />
            <Stat icon={Users} label="Seats in use" value={`${inUse} / ${subscription.seats}`}
              suffix={`${subscription.included_users} included`} />
            <Stat icon={LayoutGrid} label="Apps" value={`${appCount}`}
              suffix={subscription.included_app_count ? `${subscription.included_app_count} included` : 'unlimited'} />
            <Stat icon={FileText} label="Storage" value={`${subscription.storage_gb} GB`} />
          </div>

          <div className="mt-5 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)]">
            {term.lines.map((line) => (
              <div key={line.slug} className="flex items-baseline justify-between gap-4 border-b border-[var(--border-subtle)] px-4 py-2.5 text-sm last:border-b-0">
                <span className="min-w-0">
                  <span className="font-medium">{line.label}</span>
                  <span className="ml-2 text-xs text-[var(--text-tertiary)]">{line.detail}</span>
                </span>
                <span className="shrink-0 tabular">{Number(line.amount) === 0 ? 'Included' : money(line.amount, currency)}</span>
              </div>
            ))}
            <div className="flex justify-between bg-[var(--surface-sunken)] px-4 py-2.5 text-sm">
              <span className="text-[var(--text-secondary)]">GST ({Math.round(term.tax_rate * 100)}%)</span>
              <span className="tabular">{money(term.tax_amount, currency)}</span>
            </div>
          </div>
        </CardBody>
      </Card>

      {/* ── seats ─────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Seats"
          description={`Everyone who signs in uses a seat, including pending invitations. Extra seats are ${money(subscription.extra_user_price, currency)} each per month.`}
        />
        <CardBody className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-1 rounded-[var(--radius-lg)] border border-[var(--border-default)] p-1">
            <Button variant="ghost" size="sm" icon={Minus} aria-label="Fewer seats"
              disabled={seats <= Math.max(subscription.included_users, inUse)} onClick={() => setSeats((s) => s - 1)} />
            <input
              aria-label="Seats"
              type="number"
              className="w-16 bg-transparent text-center text-md font-semibold tabular outline-none"
              value={seats}
              min={Math.max(subscription.included_users, inUse)}
              onChange={(e) => setSeats(Math.max(1, Number(e.target.value) || 1))}
            />
            <Button variant="ghost" size="sm" icon={Plus} aria-label="More seats" onClick={() => setSeats((s) => s + 1)} />
          </div>
          <div className="text-sm text-[var(--text-secondary)]">
            {seatQuote
              ? <>New price <strong className="text-[var(--text-primary)]">{money(seatQuote.total, currency)}</strong> / {perTerm}
                {subscription.status === 'active' && seats > subscription.seats && ' · the rest of this term is charged pro rata today'}</>
              : `${subscription.seats} seats on your plan`}
          </div>
          <Button className="ml-auto" variant="primary" size="sm" disabled={seats === subscription.seats || Boolean(busy)}
            loading={busy === 'change'} onClick={() => change({ seats }, 'Seats updated')}>
            Update seats
          </Button>
        </CardBody>
      </Card>

      {/* ── plans and cycle ───────────────────────────────────────────────── */}
      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-[var(--text-secondary)]">Plans</h2>
          <div className="inline-flex rounded-[var(--radius-lg)] bg-[var(--surface-sunken)] p-0.5">
            {['monthly', 'annual'].map((cycle) => (
              <button
                key={cycle}
                disabled={Boolean(busy)}
                onClick={() => cycle !== subscription.cycle && change({ cycle }, `Switched to ${cycle} billing from your next term`)}
                className={cn(
                  'rounded-[var(--radius-md)] px-3 py-1 text-sm font-medium capitalize',
                  subscription.cycle === cycle ? 'bg-[var(--surface-raised)] shadow-xs' : 'text-[var(--text-secondary)]',
                )}
              >
                {cycle}
                {cycle === 'annual' && <span className="ml-1.5 text-2xs font-semibold text-[var(--color-positive-600)]">2 months free</span>}
              </button>
            ))}
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {plans.map((plan) => {
            const current = plan.slug === subscription.plan;
            return (
              <Card key={plan.slug} className={cn('p-5', current && 'border-[var(--color-brand-500)]')}>
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-md font-semibold">{plan.name}</p>
                    <p className="mt-0.5 text-xs text-[var(--text-secondary)]">{plan.tagline}</p>
                  </div>
                  {current && <Badge tone="brand" size="sm">Current</Badge>}
                </div>
                <p className="mt-3 text-xl font-semibold tabular tracking-[-0.02em]">
                  {money(plan.base_price_monthly, currency)}
                  <span className="text-xs font-normal text-[var(--text-tertiary)]"> / month + GST</span>
                </p>
                <ul className="mt-3 space-y-1.5">
                  {(plan.features ?? []).slice(0, 4).map((feature) => (
                    <li key={feature} className="flex items-start gap-1.5 text-xs text-[var(--text-secondary)]">
                      <CheckCircle2 className="mt-0.5 size-3 shrink-0 text-[var(--color-positive-500)]" />
                      {feature}
                    </li>
                  ))}
                </ul>
                <Button
                  variant={current ? 'ghost' : 'secondary'}
                  size="sm"
                  className="mt-4 w-full"
                  disabled={current || Boolean(busy)}
                  icon={current ? undefined : ArrowUpRight}
                  onClick={() => change({ plan: plan.slug, seats: Math.max(subscription.seats, plan.included_users) }, `Switched to ${plan.name}`)}
                >
                  {current ? 'Your plan' : `Switch to ${plan.name}`}
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
            <EmptyState icon={Receipt} title="No invoices yet" description="Your first term is invoiced as soon as you subscribe." />
          </Card>
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Invoice</TH>
                <TH>For</TH>
                <TH>Period</TH>
                <TH>Status</TH>
                <TH align="right">Amount</TH>
                <TH width={170} />
              </tr>
            </THead>
            <TBody>
              {subscription.invoices.map((invoice) => (
                <TR key={invoice.id}>
                  <TD className="font-medium">{invoice.number}</TD>
                  <TD className="text-[var(--text-secondary)]">{KIND[invoice.kind] ?? invoice.kind}</TD>
                  <TD className="text-[var(--text-secondary)]">
                    {date(invoice.period_start, 'short')} – {date(invoice.period_end, 'short')}
                  </TD>
                  <TD>
                    <Badge size="sm" tone={invoice.status === 'paid' ? 'positive' : 'caution'}>
                      {invoice.status === 'open' ? `due ${date(invoice.due_at, 'short')}` : invoice.status}
                    </Badge>
                  </TD>
                  <TD align="right" numeric>{money(invoice.total, invoice.currency)}</TD>
                  <TD align="right">
                    <div className="flex justify-end gap-1.5">
                      {invoice.status === 'open' && (
                        <Button variant="primary" size="xs" loading={busy === `pay:${invoice.id}`} disabled={Boolean(busy)}
                          onClick={() => pay(invoice)}>
                          Pay
                        </Button>
                      )}
                      <Link href={`/settings/billing/invoices/${invoice.id}`} target="_blank">
                        <Button variant="ghost" size="xs" icon={FileText}>View</Button>
                      </Link>
                    </div>
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
            description={
              subscription.status === 'active'
                ? 'You keep access until the end of the paid term. Data is retained for 90 days.'
                : 'Nothing has been paid yet, so this ends the subscription now. Data is retained for 90 days.'
            }
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
        onConfirm={() => run('cancel', async () => {
          await api.post('/subscriptions/current/cancel', { immediate: false });
          setCanceling(false);
        }, 'Subscription canceled')}
        loading={busy === 'cancel'}
        danger
        confirmLabel="Cancel subscription"
        title="Cancel your subscription?"
        description={
          subscription.status === 'active'
            ? `Your apps keep working until ${date(subscription.current_period_end)}. After that everyone loses access, though your data is kept for 90 days.`
            : 'Your apps stop now. Your data is kept for 90 days.'
        }
      />

      <Modal
        open={Boolean(testInvoice)}
        onClose={() => { testInvoice?.resolve(false); setTestInvoice(null); }}
        title="Test payment"
        description="Razorpay keys are not configured, so this local environment settles invoices without moving money."
        footer={
          <>
            <Button variant="ghost" onClick={() => { testInvoice?.resolve(false); setTestInvoice(null); }}>Cancel</Button>
            <Button variant="primary" onClick={() => { testInvoice?.resolve(true); setTestInvoice(null); }}>
              Mark {testInvoice ? money(testInvoice.total, currency) : ''} as paid
            </Button>
          </>
        }
      >
        <p className="text-sm text-[var(--text-secondary)]">
          Invoice {testInvoice?.number}. In production, set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET on the billing service and this button opens Razorpay Checkout instead.
        </p>
      </Modal>
    </div>
  );
}

function Stat({ icon: StatIcon, label, value, suffix }) {
  return (
    <div className="rounded-[var(--radius-lg)] bg-[var(--surface-sunken)] px-4 py-3">
      <p className="flex items-center gap-1.5 text-xs text-[var(--text-tertiary)]">
        {StatIcon && <StatIcon className="size-3.5" />}
        {label}
      </p>
      <p className="mt-1 text-lg font-semibold tabular tracking-[-0.02em]">
        {value}
        {suffix && <span className="ml-1.5 text-xs font-normal text-[var(--text-tertiary)]">{suffix}</span>}
      </p>
    </div>
  );
}
