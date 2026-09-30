'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ShoppingBag, Truck, PackageCheck, CheckCircle2, XCircle, BadgeCheck } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { money, date, relativeTime } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';
import { titleCase } from '@/lib/people';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Drawer, DetailGrid } from '@/components/data/drawer';
import { ListToolbar, Pagination } from '@/components/data/list-shell';
import { Table, THead, TBody, TH, TR, TD, TableSkeleton } from '@/components/ui/table';
import { Badge, Card, EmptyState, PageHeader, Alert } from '@/components/ui/primitives';

const TONE = { pending: 'caution', confirmed: 'info', packed: 'brand', shipped: 'brand', delivered: 'positive', cancelled: 'neutral' };
const STATUSES = ['pending', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled'];

export default function OrdersClient() {
  const router = useRouter();
  const params = useSearchParams();
  const [rows, setRows] = useState(null);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({});
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState(null);

  useEffect(() => {
    if (params.get('order')) setOpenId(params.get('order'));
    if (params.get('status')) setFilters({ status: params.get('status') });
  }, [params]);

  const load = useCallback(() => {
    api.get('/ecommerce/orders', { query: { ...filters, q: search || undefined, page } }).then((r) => { setRows(r.data); setMeta(r.meta); })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load orders.'));
  }, [filters, search, page]);
  useEffect(() => { const t = setTimeout(load, search ? 250 : 0); return () => clearTimeout(t); }, [load, search]);

  return (
    <div className="space-y-5">
      <PageHeader title="Online orders" description="Confirm to take the stock, then pack, ship and deliver. Cancelling a confirmed order puts the stock back." />
      <ListToolbar search={search} onSearch={(v) => { setSearch(v); setPage(1); }} searchPlaceholder="Order number, name or phone…"
        filters={[{ key: 'status', label: 'Status', options: [{ value: 'open', label: 'Open' }, ...STATUSES.map((s) => ({ value: s, label: titleCase(s) }))] }]}
        values={filters} onFilter={(k, v) => { setFilters(v === undefined ? {} : { [k]: v }); setPage(1); }} onClear={() => setFilters({})} />
      {error && <Alert tone="critical">{error}</Alert>}
      {!rows ? <TableSkeleton rows={6} columns={6} /> : rows.length === 0 ? (
        <Card><EmptyState icon={ShoppingBag} title="No orders" description="Orders placed on your store appear here." /></Card>
      ) : (
        <>
          <Table>
            <THead><tr><TH>Order</TH><TH>Customer</TH><TH>Status</TH><TH>Payment</TH><TH align="right">Items</TH><TH align="right">Total</TH><TH>Placed</TH></tr></THead>
            <TBody>
              {rows.map((o) => (
                <TR key={o.id} onClick={() => setOpenId(o.id)}>
                  <TD className="font-medium">{o.number}</TD>
                  <TD>{o.customer_name}<p className="text-xs text-[var(--text-tertiary)]">{o.customer_phone}</p></TD>
                  <TD><Badge size="sm" tone={TONE[o.status]}>{titleCase(o.status)}</Badge></TD>
                  <TD className="text-[var(--text-secondary)]">{o.payment_method === 'cod' ? 'Cash on delivery' : 'Prepaid'} · {titleCase(o.payment_status)}</TD>
                  <TD align="right" numeric>{o.items}</TD>
                  <TD align="right" numeric>{money(o.total)}</TD>
                  <TD className="text-[var(--text-secondary)]">{relativeTime(o.placed_at)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination meta={meta} onPage={setPage} />
        </>
      )}
      {openId && <OrderDrawer id={openId} onClose={() => { setOpenId(null); if (params.get('order')) router.replace('/ecommerce/orders'); }} onChanged={load} />}
    </div>
  );
}

function OrderDrawer({ id, onClose, onChanged }) {
  const toast = useToast();
  const { can } = useWorkspace();
  const [order, setOrder] = useState(null);
  const [shipping, setShipping] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get(`/ecommerce/orders/${id}`).then((r) => setOrder(r.data)).catch(() => {}); }, [id]);

  async function move(status, extra = {}) {
    setBusy(true);
    try {
      const r = await api.post(`/ecommerce/orders/${id}/status`, { status, ...extra });
      setOrder(r.data);
      toast.success(`Order ${titleCase(status).toLowerCase()}`);
      onChanged();
    } catch (err) {
      toast.error('Could not update the order', { description: err instanceof ApiError ? err.message : undefined });
    } finally {
      setBusy(false);
      setShipping(false);
    }
  }
  async function markPaid() {
    const r = await api.post(`/ecommerce/orders/${id}/payment`, { payment_status: 'paid' }).catch(() => null);
    if (r) { setOrder((o) => ({ ...o, ...r.data })); toast.success('Marked paid'); onChanged(); }
  }

  const o = order;
  const a = o?.shipping_address ?? {};
  const edit = can('ecommerce.orders.edit');
  const fulfil = can('ecommerce.orders.fulfil');
  return (
    <Drawer open onClose={onClose} width="lg" title={o ? `${o.number} · ${o.customer_name}` : 'Loading…'} subtitle={o ? `Placed ${date(o.placed_at, 'datetime')}` : undefined}
      badge={o && <Badge size="sm" tone={TONE[o.status]}>{titleCase(o.status)}</Badge>}
      footer={o && (
        <>
          {edit && ['pending', 'confirmed', 'packed'].includes(o.status) && <Button variant="ghost" icon={XCircle} disabled={busy} onClick={() => move('cancelled')}>Cancel order</Button>}
          <div className="flex-1" />
          {edit && o.payment_status === 'unpaid' && o.status !== 'cancelled' && <Button variant="ghost" icon={BadgeCheck} onClick={markPaid}>Mark paid</Button>}
          {edit && o.status === 'pending' && <Button variant="primary" icon={CheckCircle2} loading={busy} onClick={() => move('confirmed')}>Confirm</Button>}
          {fulfil && o.status === 'confirmed' && <Button variant="secondary" icon={PackageCheck} loading={busy} onClick={() => move('packed')}>Packed</Button>}
          {fulfil && ['confirmed', 'packed'].includes(o.status) && <Button variant="primary" icon={Truck} onClick={() => setShipping(true)}>Ship</Button>}
          {fulfil && o.status === 'shipped' && <Button variant="primary" icon={CheckCircle2} loading={busy} onClick={() => move('delivered')}>Delivered</Button>}
        </>
      )}>
      {o && (
        <div className="space-y-5">
          <Table>
            <THead><tr><TH>Item</TH><TH align="right">Qty</TH><TH align="right">Price</TH><TH align="right">Amount</TH></tr></THead>
            <TBody>
              {o.lines.map((l) => <TR key={l.id}><TD>{l.name}</TD><TD align="right" numeric>{Number(l.quantity)}</TD><TD align="right" numeric>{money(l.unit_price)}</TD><TD align="right" numeric>{money(l.line_total)}</TD></TR>)}
            </TBody>
          </Table>
          <DetailGrid items={[
            { label: 'Subtotal', value: money(o.subtotal) },
            { label: 'Discount', value: Number(o.discount_total) ? `−${money(o.discount_total)}${o.promo_code ? ` (${o.promo_code})` : ''}` : null },
            { label: 'Shipping', value: money(o.shipping_fee) }, { label: 'GST', value: money(o.tax_total) },
            { label: 'Total', value: <strong>{money(o.total)}</strong> },
            { label: 'Payment', value: `${o.payment_method === 'cod' ? 'Cash on delivery' : 'Prepaid'} · ${titleCase(o.payment_status)}` },
            { label: 'Phone', value: <a href={`tel:${o.customer_phone}`} className="text-[var(--color-brand-600)]">{o.customer_phone}</a> },
            { label: 'Email', value: o.customer_email },
            { label: 'Ship to', value: [a.line1, a.line2, `${a.city ?? ''}, ${a.state ?? ''} ${a.pincode ?? ''}`].filter(Boolean).join(', '), full: true },
            { label: 'Tracking', value: o.tracking_number },
            { label: 'Notes', value: o.notes || null, full: true },
          ]} />
        </div>
      )}
      {shipping && <ShipModal onClose={() => setShipping(false)} onShip={(tracking) => move('shipped', { tracking_number: tracking || null })} />}
    </Drawer>
  );
}

function ShipModal({ onClose, onShip }) {
  const [tracking, setTracking] = useState('');
  return (
    <Modal open onClose={onClose} title="Mark as shipped" size="sm" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => onShip(tracking)}>Shipped</Button></>}>
      <Field label="Tracking number (optional)">{(p) => <Input {...p} value={tracking} onChange={(e) => setTracking(e.target.value)} data-autofocus />}</Field>
    </Modal>
  );
}
