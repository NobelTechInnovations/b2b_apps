'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Plus, ShoppingCart, CheckCircle2, PackageCheck, XCircle, Pencil, Trash2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { money, date } from '@/lib/format';
import { Can, useWorkspace } from '@/lib/workspace';
import { titleCase } from '@/lib/people';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { Modal, ConfirmModal } from '@/components/ui/modal';
import { Drawer, DetailGrid } from '@/components/data/drawer';
import { ListToolbar, Pagination } from '@/components/data/list-shell';
import { useOptions } from '@/components/data/resource-page';
import { LineItems, linesPayload } from '@/components/data/line-items';
import { Table, THead, TBody, TH, TR, TD, TableSkeleton } from '@/components/ui/table';
import { Badge, Card, EmptyState, PageHeader, Alert } from '@/components/ui/primitives';

const TONE = { draft: 'neutral', approved: 'brand', partially_received: 'caution', received: 'positive', cancelled: 'neutral' };
const STATUSES = ['draft', 'approved', 'partially_received', 'received', 'cancelled'];

export default function PurchaseClient() {
  const router = useRouter();
  const params = useSearchParams();
  const { can } = useWorkspace();
  const [rows, setRows] = useState(null);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({});
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState(null);
  const [openId, setOpenId] = useState(null);

  useEffect(() => {
    if (params.get('new') === '1') setEditing({});
    if (params.get('order')) setOpenId(params.get('order'));
  }, [params]);

  const load = useCallback(async () => {
    try {
      const r = await api.get('/erp/purchase-orders', { query: { ...filters, q: search || undefined, page } });
      setRows(r.data);
      setMeta(r.meta);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load purchase orders.');
    }
  }, [filters, search, page]);
  useEffect(() => {
    const timer = setTimeout(load, search ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, search]);

  const clear = () => { if (params.get('new') || params.get('order')) router.replace('/erp/purchase'); };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Purchase orders"
        description="Order from vendors, get it approved, and receive the goods straight into stock."
        actions={<Can permission="erp.purchase.create"><Button variant="primary" icon={Plus} onClick={() => setEditing({})}>New purchase order</Button></Can>}
      />
      <ListToolbar
        search={search}
        onSearch={(v) => { setSearch(v); setPage(1); }}
        searchPlaceholder="PO number or vendor…"
        filters={[{ key: 'status', label: 'Status', options: [{ value: 'open', label: 'Open' }, ...STATUSES.map((s) => ({ value: s, label: titleCase(s) }))] }]}
        values={filters}
        onFilter={(k, v) => { setFilters(v === undefined ? {} : { [k]: v }); setPage(1); }}
        onClear={() => setFilters({})}
      />
      {error && <Alert tone="critical">{error}</Alert>}
      {!rows ? <TableSkeleton rows={6} columns={6} /> : rows.length === 0 ? (
        <Card><EmptyState icon={ShoppingCart} title="No purchase orders" description="Raise an order to a vendor; receiving it puts the goods in stock." action={can('erp.purchase.create') && <Button variant="primary" icon={Plus} onClick={() => setEditing({})}>New purchase order</Button>} /></Card>
      ) : (
        <>
          <Table>
            <THead><tr><TH>Number</TH><TH>Vendor</TH><TH>Status</TH><TH>Ordered</TH><TH>Expected</TH><TH align="right">Total</TH></tr></THead>
            <TBody>
              {rows.map((r) => (
                <TR key={r.id} onClick={() => setOpenId(r.id)}>
                  <TD className="font-medium">{r.number}</TD>
                  <TD>{r.vendor_name}</TD>
                  <TD><Badge size="sm" tone={TONE[r.status]}>{titleCase(r.status)}</Badge></TD>
                  <TD className="text-[var(--text-secondary)]">{date(r.order_date)}</TD>
                  <TD className="text-[var(--text-secondary)]">{r.expected_date ? date(r.expected_date) : '—'}</TD>
                  <TD align="right" numeric>{money(r.total)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination meta={meta} onPage={setPage} />
        </>
      )}
      {editing && <OrderForm order={editing} onClose={() => { setEditing(null); clear(); }} onSaved={(o) => { load(); setOpenId(o.id); }} />}
      {openId && !editing && <OrderDrawer id={openId} onClose={() => { setOpenId(null); clear(); }} onEdit={setEditing} onChanged={load} />}
    </div>
  );
}

function OrderForm({ order, onClose, onSaved }) {
  const toast = useToast();
  const isNew = !order.id;
  const vendors = useOptions('/erp/vendors', { active: true, limit: 100 });
  const warehouses = useOptions('/erp/warehouses');
  const [form, setForm] = useState({
    vendor_id: order.vendor_id ?? '', warehouse_id: order.warehouse_id ?? '', expected_date: order.expected_date?.slice(0, 10) ?? '', notes: order.notes ?? '',
  });
  const [lines, setLines] = useState(order.lines?.map((l) => ({ ...l, unit_price: String(l.unit_price) })) ?? [{ quantity: 1, unit_price: '', tax_rate: 18 }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit() {
    setBusy(true);
    setError(null);
    const body = { vendor_id: form.vendor_id, warehouse_id: form.warehouse_id || null, expected_date: form.expected_date || null, notes: form.notes, lines: linesPayload(lines, { description: false }) };
    try {
      const r = isNew ? await api.post('/erp/purchase-orders', body) : await api.patch(`/erp/purchase-orders/${order.id}`, body);
      toast.success(isNew ? `${r.data.number} created` : 'Saved');
      onClose();
      onSaved(r.data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={isNew ? 'New purchase order' : `Edit ${order.number}`} size="full"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!form.vendor_id} onClick={submit}>{isNew ? 'Create draft' : 'Save'}</Button></>}>
      <div className="space-y-4">
        {error && <Alert tone="critical">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Vendor" required>{(p) => <Select {...p} value={form.vendor_id} onChange={set('vendor_id')} data-autofocus><option value="">Choose…</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</Select>}</Field>
          <Field label="Deliver to">{(p) => <Select {...p} value={form.warehouse_id} onChange={set('warehouse_id')}><option value="">Default warehouse</option>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>}</Field>
          <Field label="Expected on">{(p) => <Input {...p} type="date" value={form.expected_date} onChange={set('expected_date')} />}</Field>
        </div>
        <LineItems lines={lines} onChange={setLines} priceFrom="cost_price" productQuery={{}} />
        <Field label="Notes for the vendor">{(p) => <Textarea {...p} rows={2} value={form.notes} onChange={set('notes')} />}</Field>
      </div>
    </Modal>
  );
}

function OrderDrawer({ id, onClose, onEdit, onChanged }) {
  const toast = useToast();
  const { can } = useWorkspace();
  const [order, setOrder] = useState(null);
  const [receiving, setReceiving] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.get(`/erp/purchase-orders/${id}`).then((r) => setOrder(r.data)).catch(() => {}), [id]);
  useEffect(() => { load(); }, [load]);

  async function act(path, message, body = {}) {
    setBusy(true);
    try {
      if (path === 'delete') {
        await api.del(`/erp/purchase-orders/${id}`);
        toast.success(message);
        onChanged();
        onClose();
        return;
      }
      const r = await api.post(`/erp/purchase-orders/${id}/${path}`, body);
      setOrder((old) => ({ ...old, ...r.data }));
      toast.success(message);
      await load();
      onChanged();
    } catch (err) {
      toast.error('That did not work', { description: err instanceof ApiError ? err.message : undefined });
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  const o = order;
  return (
    <Drawer open onClose={onClose} width="lg" title={o ? `${o.number} · ${o.vendor_name}` : 'Loading…'} subtitle={o ? `Ordered ${date(o.order_date)}${o.expected_date ? ` · expected ${date(o.expected_date)}` : ''}` : undefined}
      badge={o && <Badge size="sm" tone={TONE[o.status]}>{titleCase(o.status)}</Badge>}
      footer={o && (
        <>
          {o.status === 'draft' && can('erp.purchase.create') && <Button variant="danger-ghost" icon={Trash2} onClick={() => setConfirm('delete')}>Delete</Button>}
          {['draft', 'approved'].includes(o.status) && can('erp.purchase.approve') && <Button variant="ghost" icon={XCircle} onClick={() => setConfirm('cancel')}>Cancel order</Button>}
          <div className="flex-1" />
          {o.status === 'draft' && can('erp.purchase.create') && <Button variant="secondary" icon={Pencil} onClick={() => onEdit(o)}>Edit</Button>}
          {o.status === 'draft' && can('erp.purchase.approve') && <Button variant="primary" icon={CheckCircle2} loading={busy} onClick={() => act('approve', 'Approved')}>Approve</Button>}
          {['approved', 'partially_received'].includes(o.status) && can('erp.inventory.adjust') && (
            <>
              <Button variant="secondary" onClick={() => setReceiving(true)}>Receive part</Button>
              <Button variant="primary" icon={PackageCheck} loading={busy} onClick={() => act('receive', 'All goods received')}>Receive all</Button>
            </>
          )}
        </>
      )}>
      {o && (
        <div className="space-y-5">
          <Table>
            <THead><tr><TH>Product</TH><TH align="right">Ordered</TH><TH align="right">Received</TH><TH align="right">Price</TH><TH align="right">Amount</TH></tr></THead>
            <TBody>
              {o.lines.map((l) => (
                <TR key={l.id}>
                  <TD><p className="font-medium">{l.product_name}</p>{l.sku && <p className="text-xs text-[var(--text-tertiary)]">{l.sku}</p>}</TD>
                  <TD align="right" numeric>{Number(l.quantity)} {l.uom}</TD>
                  <TD align="right" numeric className={Number(l.received_quantity) >= Number(l.quantity) ? 'text-[var(--color-positive-600)]' : ''}>{Number(l.received_quantity)}</TD>
                  <TD align="right" numeric>{money(l.unit_price)}</TD>
                  <TD align="right" numeric>{money(l.line_total)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <DetailGrid items={[
            { label: 'Subtotal', value: money(o.subtotal) }, { label: 'GST', value: money(o.tax_total) },
            { label: 'Total', value: <strong>{money(o.total)}</strong> }, { label: 'Deliver to', value: o.warehouse_name },
            { label: 'Notes', value: o.notes || null, full: true },
          ]} />
        </div>
      )}
      {receiving && o && <ReceiveModal order={o} onClose={() => setReceiving(false)} onReceive={(lines) => { setReceiving(false); act('receive', 'Goods received', { lines }); }} />}
      <ConfirmModal open={confirm === 'cancel'} onClose={() => setConfirm(null)} onConfirm={() => act('cancel', 'Order cancelled')} danger title="Cancel this purchase order?" description="Nothing has been received on it yet." confirmLabel="Cancel order" loading={busy} />
      <ConfirmModal open={confirm === 'delete'} onClose={() => setConfirm(null)} onConfirm={() => act('delete', 'Draft deleted')} danger title="Delete this draft?" confirmLabel="Delete" loading={busy} />
    </Drawer>
  );
}

function ReceiveModal({ order, onClose, onReceive }) {
  const outstanding = order.lines.filter((l) => Number(l.received_quantity) < Number(l.quantity));
  const [qty, setQty] = useState(Object.fromEntries(outstanding.map((l) => [l.id, String(Number(l.quantity) - Number(l.received_quantity))])));
  return (
    <Modal open onClose={onClose} title="Receive goods" description="Enter what actually arrived. The rest stays on order."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={PackageCheck} onClick={() => onReceive(Object.entries(qty).filter(([, v]) => Number(v) > 0).map(([line_id, v]) => ({ line_id, quantity: Number(v) })))}>Receive</Button></>}>
      <div className="space-y-3">
        {outstanding.map((l) => (
          <div key={l.id} className="flex items-center gap-3">
            <span className="min-w-0 flex-1 truncate text-sm">{l.product_name}<span className="ml-2 text-xs text-[var(--text-tertiary)]">{Number(l.quantity) - Number(l.received_quantity)} to come</span></span>
            <Input className="w-28 text-right" type="number" min="0" step="any" value={qty[l.id]} onChange={(e) => setQty((q) => ({ ...q, [l.id]: e.target.value }))} aria-label={`Received ${l.product_name}`} />
          </div>
        ))}
      </div>
    </Modal>
  );
}
