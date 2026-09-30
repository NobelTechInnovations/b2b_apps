'use client';

import { useCallback, useEffect, useState } from 'react';
import { Receipt as ReceiptIcon, TrendingUp, IndianRupee, Hash, Undo2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { money, date } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';
import { titleCase } from '@/lib/people';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { StatTile } from '@/components/data/stat-tile';
import { Table, THead, TBody, TH, TR, TD, TableSkeleton } from '@/components/ui/table';
import { Badge, Card, CardHeader, CardBody, PageHeader, Alert } from '@/components/ui/primitives';
import { Receipt } from '../till/[registerId]/till-client';

const iso = (d) => d.toISOString().slice(0, 10);

export default function SalesClient() {
  const toast = useToast();
  const { can } = useWorkspace();
  const [from, setFrom] = useState(iso(new Date(Date.now() - 6 * 86_400_000)));
  const [to, setTo] = useState(iso(new Date()));
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [refunding, setRefunding] = useState(null);

  const load = useCallback(() => {
    api.get('/pos/sales', { query: { from, to } }).then((r) => setData(r)).catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load sales.'));
  }, [from, to]);
  useEffect(() => { load(); }, [load]);

  async function open(sale) {
    const r = await api.get(`/pos/sales/${sale.id}`);
    setReceipt(r.data);
  }

  async function refund(reason) {
    try {
      await api.post(`/pos/sales/${refunding.id}/refund`, { reason });
      toast.success(`${refunding.number} refunded — stock returned`);
      setRefunding(null);
      load();
    } catch (err) {
      toast.error('Could not refund', { description: err instanceof ApiError ? err.message : undefined });
    }
  }

  const m = data?.meta;
  const peak = Math.max(1, ...(m?.by_day ?? []).map((d) => Number(d.revenue)));
  return (
    <div className="space-y-5">
      <PageHeader title="Sales" description="Till sales by day, payment method and product." actions={
        <div className="flex items-center gap-2">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" className="w-40" />
          <span className="text-[var(--text-tertiary)]">to</span>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" className="w-40" />
        </div>
      } />
      {error && <Alert tone="critical">{error}</Alert>}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <StatTile label="Revenue" value={m?.revenue} format="money" loading={!m} icon={IndianRupee} tone="brand" />
        <StatTile label="Sales" value={m?.sales} loading={!m} icon={Hash} />
        <StatTile label="Average sale" value={m?.average} format="money" loading={!m} icon={TrendingUp} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="By day" />
          <CardBody>
            <div className="flex h-40 items-end gap-2">
              {(m?.by_day ?? []).map((d) => (
                <div key={d.day} className="flex flex-1 flex-col items-center gap-1">
                  <div className="w-full rounded-t bg-[var(--color-brand-500)]" style={{ height: `${(Number(d.revenue) / peak) * 100}%` }} title={money(d.revenue)} />
                  <span className="text-2xs text-[var(--text-tertiary)]">{date(d.day, 'short')}</span>
                </div>
              ))}
              {m?.by_day.length === 0 && <p className="w-full self-center text-center text-sm text-[var(--text-tertiary)]">No sales in this period.</p>}
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="By payment method" />
          <CardBody className="space-y-2 text-sm">
            {(m?.by_method ?? []).map((x) => <div key={x.payment_method} className="flex justify-between"><span>{titleCase(x.payment_method)} <span className="text-[var(--text-tertiary)]">({x.sales})</span></span><span className="tabular">{money(x.revenue)}</span></div>)}
            <h4 className="pt-3 text-xs font-medium text-[var(--text-tertiary)]">TOP PRODUCTS</h4>
            {(m?.top_products ?? []).map((p) => <div key={p.name} className="flex justify-between"><span className="truncate">{p.name} × {Number(p.quantity)}</span><span className="tabular">{money(p.revenue)}</span></div>)}
          </CardBody>
        </Card>
      </div>
      {!data ? <TableSkeleton rows={6} columns={5} /> : (
        <Table>
          <THead><tr><TH>Sale</TH><TH>When</TH><TH>Register</TH><TH>Paid by</TH><TH align="right">Total</TH><TH /></tr></THead>
          <TBody>
            {data.data.map((s) => (
              <TR key={s.id} onClick={() => open(s)}>
                <TD className="font-medium">{s.number}{s.customer_name && <p className="text-xs font-normal text-[var(--text-tertiary)]">{s.customer_name}</p>}</TD>
                <TD className="text-[var(--text-secondary)]">{date(s.sold_at, 'datetime')}</TD>
                <TD className="text-[var(--text-secondary)]">{s.register_name}</TD>
                <TD>{titleCase(s.payment_method)}</TD>
                <TD align="right" numeric>{s.status === 'refunded' ? <s className="text-[var(--text-tertiary)]">{money(s.total)}</s> : money(s.total)}</TD>
                <TD align="right">
                  {s.status === 'refunded' ? <Badge size="sm" tone="critical">Refunded</Badge> : can('pos.sales.refund') && (
                    <Button size="xs" variant="ghost" icon={Undo2} onClick={(e) => { e.stopPropagation(); setRefunding(s); }}>Refund</Button>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      {receipt && <Receipt sale={receipt} onClose={() => setReceipt(null)} />}
      {refunding && <RefundModal sale={refunding} onClose={() => setRefunding(null)} onRefund={refund} />}
    </div>
  );
}

function RefundModal({ sale, onClose, onRefund }) {
  const [reason, setReason] = useState('');
  return (
    <Modal open onClose={onClose} title={`Refund ${sale.number}?`} description={`${money(sale.total)} goes back to the customer and the items return to stock.`} size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" icon={ReceiptIcon} disabled={!reason.trim()} onClick={() => onRefund(reason)}>Refund</Button></>}>
      <Field label="Reason" required>{(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} data-autofocus />}</Field>
    </Modal>
  );
}
