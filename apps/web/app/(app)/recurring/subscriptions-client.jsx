'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Repeat, Pause, Play, XCircle, ArrowRightLeft, RefreshCw } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { money, date } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';
import { titleCase } from '@/lib/people';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Checkbox } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Badge } from '@/components/ui/primitives';
import { ResourcePage, renderValue, useOptions } from '@/components/data/resource-page';

const STATUS = { tones: { trialing: 'info', active: 'positive', past_due: 'critical', paused: 'caution', cancelled: 'neutral' } };
const INTERVAL = { monthly: 'month', quarterly: 'quarter', half_yearly: 'half-year', yearly: 'year' };

export default function SubscriptionsClient() {
  const toast = useToast();
  const { can } = useWorkspace();
  const [key, setKey] = useState(0);
  const manage = can('recurring.customers.manage');

  async function runNow() {
    try {
      const r = await api.post('/recurring/run', {});
      toast.success(r.data.invoices ? `${r.data.invoices} renewal invoice${r.data.invoices === 1 ? '' : 's'} raised` : 'Nothing is due today');
      setKey((k) => k + 1);
    } catch (err) {
      toast.error('Billing run failed', { description: err instanceof ApiError ? err.message : undefined });
    }
  }

  return (
    <ResourcePage
      key={key}
      title="Subscriptions"
      description="Who is on which plan and when they renew. Renewal invoices are raised automatically every few minutes; overdue ones mark the subscription past due."
      endpoint="/recurring/subscriptions"
      entity="subscription"
      permissions={{ create: 'recurring.customers.manage', edit: 'recurring.customers.manage', delete: 'recurring.customers.manage' }}
      headerActions={manage && <Button variant="secondary" icon={RefreshCw} onClick={runNow}>Bill what is due</Button>}
      searchPlaceholder="Customer or subscription number…"
      emptyIcon={Repeat}
      emptyText="Create a plan, then put customers on it."
      filters={[{ key: 'status', label: 'Status', options: Object.keys(STATUS.tones).map((s) => ({ value: s, label: titleCase(s) })) }]}
      defaults={{ quantity: '1', auto_issue: true, start_date: new Date().toISOString().slice(0, 10) }}
      columns={[
        { key: 'customer_name', label: 'Customer', render: (r) => <div><p className="font-medium">{r.customer_name}</p><p className="text-xs text-[var(--text-tertiary)]">{r.number}</p></div> },
        { key: 'plan_name', label: 'Plan', render: (r) => <span>{r.plan_name}{r.quantity > 1 ? ` × ${r.quantity}` : ''}{r.next_plan_name && <span className="text-xs text-[var(--text-tertiary)]"> → {r.next_plan_name}</span>}</span> },
        { key: 'status', label: 'Status', render: (r) => <span className="flex gap-1">{renderValue(r.status, STATUS)}{r.cancel_at_period_end && <Badge size="sm" tone="caution">Ends at renewal</Badge>}</span> },
        { key: 'mrr', label: 'MRR', align: 'right', numeric: true, format: 'money' },
        { key: 'next_billing_date', label: 'Next bill', render: (r) => (r.next_billing_date ? date(r.next_billing_date) : '—') },
      ]}
      fields={[
        { key: 'customer_name', label: 'Customer name', required: true },
        { key: 'customer_email', label: 'Email', type: 'email' },
        { key: 'customer_gstin', label: 'GSTIN' },
        { key: 'plan_id', label: 'Plan', type: 'relation', endpoint: '/recurring/plans', query: { active: true, limit: 100 }, required: true, createOnly: true, labelOf: (p) => `${p.name} · ${money(p.amount)}/${INTERVAL[p.interval]}` },
        { key: 'quantity', label: 'Quantity', type: 'number', min: 1, step: 1 },
        { key: 'price_override', label: 'Special price (₹)', type: 'money', hint: 'Leave empty for the plan price' },
        { key: 'start_date', label: 'Starts', type: 'date', createOnly: true },
        { key: 'auto_issue', label: 'Issue renewal invoices automatically', type: 'checkbox', hint: 'Untick to have them created as drafts for review.' },
        { key: 'notes', label: 'Notes', type: 'textarea' },
      ]}
      titleOf={(r) => `${r.customer_name} · ${r.plan_name}`}
      subtitleOf={(r) => `${r.number} · since ${date(r.start_date)}${r.trial_ends_on ? ` · trial to ${date(r.trial_ends_on)}` : ''}`}
      badgeOf={(r) => renderValue(r.status, STATUS)}
      detailItems={(r) => [
        { label: 'Plan', value: `${r.plan_name} · ${money(r.price_override ?? r.plan_amount)} per ${INTERVAL[r.plan_interval]}${r.quantity > 1 ? ` × ${r.quantity}` : ''}` },
        { label: 'Monthly value', value: money(r.mrr) },
        { label: 'Next bill', value: r.next_billing_date ? date(r.next_billing_date) : null },
        { label: 'Changes to', value: r.next_plan_name ? `${r.next_plan_name} at the next renewal` : null },
        { label: 'Email', value: r.customer_email },
        { label: 'Cancellation', value: r.cancel_at_period_end ? `At the next renewal${r.cancel_reason ? ` · ${r.cancel_reason}` : ''}` : r.cancelled_at ? `${date(r.cancelled_at)}${r.cancel_reason ? ` · ${r.cancel_reason}` : ''}` : null, full: true },
      ]}
      detail={(r) => (
        <section>
          <h3 className="mb-2 text-sm font-medium text-[var(--text-secondary)]">Invoices</h3>
          {!r.invoices?.length ? <p className="text-sm text-[var(--text-tertiary)]">None yet{r.status === 'trialing' ? ' — the first comes when the trial ends.' : '.'}</p> : (
            <ul className="divide-y divide-[var(--border-subtle)] text-sm">
              {r.invoices.map((i) => (
                <li key={i.id} className="flex items-center gap-2 py-2">
                  <Link href={`/invoicing/invoices?open=${i.id}`} className="w-40 font-medium hover:underline">{i.number ?? 'Draft'}</Link>
                  <span className="flex-1 text-[var(--text-tertiary)]">{date(i.period_start, 'short')} – {date(i.period_end, 'short')}</span>
                  <Badge size="sm" tone={i.status === 'paid' ? 'positive' : i.status === 'overdue' ? 'critical' : 'neutral'}>{titleCase(i.status)}</Badge>
                  <span className="w-24 text-right tabular">{money(i.total)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      actions={(r, { act, busy }) => manage && r.status !== 'cancelled' && (
        <>
          {['active', 'past_due', 'trialing'].includes(r.status) && <Button variant="ghost" icon={Pause} disabled={busy} onClick={() => act(() => api.post(`/recurring/subscriptions/${r.id}/pause`, {}), 'Paused')}>Pause</Button>}
          {r.status === 'paused' && <Button variant="secondary" icon={Play} disabled={busy} onClick={() => act(() => api.post(`/recurring/subscriptions/${r.id}/resume`, {}), 'Resumed')}>Resume</Button>}
          <ChangePlan sub={r} act={act} />
          <Cancel sub={r} act={act} />
        </>
      )}
    />
  );
}

function ChangePlan({ sub, act }) {
  const [open, setOpen] = useState(false);
  const plans = useOptions(open ? '/recurring/plans' : null, { active: true, limit: 100 });
  const [planId, setPlanId] = useState(sub.next_plan_id ?? sub.plan_id);
  return (
    <>
      <Button variant="ghost" icon={ArrowRightLeft} onClick={() => setOpen(true)}>Change plan</Button>
      {open && (
        <Modal open onClose={() => setOpen(false)} title="Change plan" description="The new plan starts at the next renewal, so nobody is billed twice for the same days." size="sm"
          footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" onClick={() => { setOpen(false); act(() => api.post(`/recurring/subscriptions/${sub.id}/change-plan`, { plan_id: planId }), 'Plan change scheduled'); }}>Save</Button></>}>
          <Field label="Plan">{(p) => <Select {...p} value={planId} onChange={(e) => setPlanId(e.target.value)}>{plans.map((pl) => <option key={pl.id} value={pl.id}>{pl.name} · {money(pl.amount)}/{INTERVAL[pl.interval]}</option>)}</Select>}</Field>
        </Modal>
      )}
    </>
  );
}

function Cancel({ sub, act }) {
  const [open, setOpen] = useState(false);
  const [atEnd, setAtEnd] = useState(true);
  const [reason, setReason] = useState('');
  return (
    <>
      <Button variant="danger-ghost" icon={XCircle} onClick={() => setOpen(true)}>Cancel</Button>
      {open && (
        <Modal open onClose={() => setOpen(false)} title={`Cancel ${sub.customer_name}’s subscription?`} size="sm"
          footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Keep it</Button><Button variant="danger" onClick={() => { setOpen(false); act(() => api.post(`/recurring/subscriptions/${sub.id}/cancel`, { at_period_end: atEnd, reason }), atEnd ? 'Will end at the next renewal' : 'Cancelled'); }}>Cancel subscription</Button></>}>
          <div className="space-y-3">
            <Checkbox label="At the end of the paid period" description="Recommended: they keep what they paid for." checked={atEnd} onChange={(e) => setAtEnd(e.target.checked)} />
            <Field label="Reason">{(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Price, moved away, switched to…" />}</Field>
          </div>
        </Modal>
      )}
    </>
  );
}
