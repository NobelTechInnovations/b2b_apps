'use client';

import { useState } from 'react';
import { Landmark, Archive } from 'lucide-react';
import { api } from '@/lib/api';
import { money, date } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';
import { Button } from '@/components/ui/button';
import { Input, Field, Select } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Badge } from '@/components/ui/primitives';
import { ResourcePage } from '@/components/data/resource-page';

export default function RegisterClient() {
  const { can } = useWorkspace();
  return (
    <ResourcePage
      title="Asset register"
      description="What the business owns, what it cost and what it is worth now. Depreciation posts to the ledger each month you run it."
      endpoint="/assets/register"
      entity="asset"
      permissions={{ create: 'assets.register.manage', edit: 'assets.register.manage', delete: 'assets.register.manage' }}
      searchPlaceholder="Name, number, category, serial or custodian…"
      emptyIcon={Landmark}
      emptyText="Register laptops, vehicles, machinery and furniture to track their book value."
      filters={[{ key: 'status', label: 'Status', options: [{ value: 'active', label: 'In use' }, { value: 'disposed', label: 'Disposed' }] }]}
      columns={[
        { key: 'name', label: 'Asset', render: (r) => <div><p className="font-medium">{r.name}</p><p className="text-xs text-[var(--text-tertiary)]">{[r.number, r.category, r.custodian].filter(Boolean).join(' · ')}</p></div> },
        { key: 'purchase_date', label: 'Bought', format: 'date' },
        { key: 'cost', label: 'Cost', align: 'right', numeric: true, format: 'money' },
        { key: 'accumulated_depreciation', label: 'Depreciated', align: 'right', numeric: true, format: 'money' },
        { key: 'book_value', label: 'Book value', align: 'right', numeric: true, render: (r) => <span className="font-medium">{money(r.book_value)}</span> },
        { key: 'status', label: '', render: (r) => (r.status === 'disposed' ? <Badge size="sm">Disposed</Badge> : null) },
      ]}
      defaults={{ method: 'slm', purchase_date: new Date().toISOString().slice(0, 10), paid_from: 'none' }}
      fields={[
        { key: 'name', label: 'Name', required: true, full: true },
        { key: 'category', label: 'Category', placeholder: 'Computers, vehicles, furniture…' },
        { key: 'purchase_date', label: 'Bought on', type: 'date', required: true },
        { key: 'cost', label: 'Cost (₹)', type: 'money', required: true },
        { key: 'salvage_value', label: 'Salvage value (₹)', type: 'money', hint: 'What it will be worth at the end' },
        { key: 'method', label: 'Depreciation', type: 'select', required: true, options: [{ value: 'slm', label: 'Straight line' }, { value: 'wdv', label: 'Written-down value' }] },
        { key: 'useful_life_months', label: 'Useful life (months)', type: 'number', showIf: (f) => f.method !== 'wdv' },
        { key: 'wdv_rate', label: 'Rate per year (%)', type: 'number', step: '0.01', showIf: (f) => f.method === 'wdv', hint: 'Income-tax block rates: computers 40%, furniture 10%' },
        { key: 'location', label: 'Location' },
        { key: 'custodian', label: 'Custodian' },
        { key: 'serial_number', label: 'Serial number' },
        {
          key: 'paid_from', label: 'Post the purchase', type: 'select', createOnly: true, hideInDetail: true, required: true,
          options: [{ value: 'none', label: 'Don’t post (already in the books)' }, { value: 'bank', label: 'Paid from bank' }, { value: 'cash', label: 'Paid in cash' }, { value: 'payable', label: 'On credit (owed to vendor)' }, { value: 'capital', label: 'Brought in by the owner' }],
        },
        { key: 'notes', label: 'Notes', type: 'textarea' },
      ]}
      titleOf={(r) => `${r.number} · ${r.name}`}
      subtitleOf={(r) => `Book value ${money(r.book_value)} · ${r.method === 'slm' ? `straight line over ${r.useful_life_months} months` : `WDV at ${Number(r.wdv_rate)}% a year`}`}
      drawerWidth="lg"
      actions={(r, { act }) => r.status === 'active' && can('assets.register.manage') && <DisposeButton asset={r} act={act} />}
      detail={(r) => (
        <section>
          <h3 className="mb-2 text-sm font-medium text-[var(--text-secondary)]">Depreciation schedule</h3>
          <div className="max-h-72 overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--border-subtle)]">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-[var(--surface-raised)] text-xs text-[var(--text-tertiary)]"><tr><th className="px-3 py-1.5 text-left font-medium">Month</th><th className="px-3 text-right font-medium">Depreciation</th><th className="px-3 text-right font-medium">Book value</th><th /></tr></thead>
              <tbody className="divide-y divide-[var(--border-subtle)]">
                {r.schedule?.map((s) => {
                  const posted = r.posted?.some((p) => String(p.period).slice(0, 7) === s.period.slice(0, 7));
                  return <tr key={s.period}><td className="px-3 py-1.5">{date(s.period, 'short').replace(/^\d+ /, '')} {s.period.slice(0, 4)}</td><td className="px-3 text-right tabular">{money(s.amount)}</td><td className="px-3 text-right tabular">{money(s.book_value)}</td><td className="px-3">{posted && <Badge size="sm" tone="positive">Posted</Badge>}</td></tr>;
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    />
  );
}

function DisposeButton({ asset, act }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ disposed_on: new Date().toISOString().slice(0, 10), amount: '', received_in: 'bank' });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const gain = Number(form.amount || 0) - Number(asset.book_value);
  return (
    <>
      <Button variant="secondary" icon={Archive} onClick={() => setOpen(true)}>Dispose</Button>
      {open && (
        <Modal open onClose={() => setOpen(false)} title={`Dispose of ${asset.name}`} description={`Book value today ${money(asset.book_value)}. Selling or scrapping it posts the gain or loss.`}
          footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" onClick={() => { setOpen(false); act(() => api.post(`/assets/register/${asset.id}/dispose`, { ...form, amount: Number(form.amount || 0).toFixed(2) }), 'Asset disposed'); }}>Dispose</Button></>}>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Date">{(p) => <Input {...p} type="date" value={form.disposed_on} onChange={set('disposed_on')} />}</Field>
            <Field label="Sold for (₹)" hint="0 if scrapped">{(p) => <Input {...p} type="number" min="0" step="0.01" value={form.amount} onChange={set('amount')} data-autofocus />}</Field>
            <Field label="Received in">{(p) => <Select {...p} value={form.received_in} onChange={set('received_in')}><option value="bank">Bank</option><option value="cash">Cash</option></Select>}</Field>
          </div>
          <p className={gain >= 0 ? 'mt-3 text-sm text-[var(--color-positive-600)]' : 'mt-3 text-sm text-[var(--color-critical-600)]'}>{gain >= 0 ? `Gain of ${money(gain)}` : `Loss of ${money(-gain)}`}</p>
        </Modal>
      )}
    </>
  );
}
