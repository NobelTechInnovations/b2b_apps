'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Plus, Factory, Play, CheckCircle2, XCircle, TriangleAlert } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { money, date } from '@/lib/format';
import { Can, useWorkspace } from '@/lib/workspace';
import { titleCase } from '@/lib/people';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Drawer, DetailGrid } from '@/components/data/drawer';
import { useOptions } from '@/components/data/resource-page';
import { ProductPicker } from '@/components/data/line-items';
import { Table, THead, TBody, TH, TR, TD, TableSkeleton } from '@/components/ui/table';
import { Badge, Card, EmptyState, PageHeader, Alert } from '@/components/ui/primitives';

export const MO_TONE = { draft: 'neutral', confirmed: 'info', in_progress: 'caution', done: 'positive', cancelled: 'neutral' };
const VIEWS = [['open', 'In progress & planned'], ['done', 'Done'], ['cancelled', 'Cancelled']];

export default function OrdersClient() {
  const router = useRouter();
  const params = useSearchParams();
  const { can } = useWorkspace();
  const [status, setStatus] = useState('open');
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState(null);

  useEffect(() => {
    if (params.get('new') === '1') setCreating(true);
    if (params.get('open')) setOpenId(params.get('open'));
  }, [params]);

  const load = useCallback(() => {
    api.get('/manufacturing/orders', { query: { status } }).then((r) => setRows(r.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load orders.'));
  }, [status]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Manufacturing orders"
        description="Make a batch: confirm it, start it, finish it. Finishing takes the components out of stock and puts the finished goods in."
        actions={<Can permission="manufacturing.orders.create"><Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>New order</Button></Can>}
      />
      <div className="flex gap-1">
        {VIEWS.map(([key, label]) => <Button key={key} size="sm" variant={status === key ? 'primary' : 'ghost'} onClick={() => setStatus(key)}>{label}</Button>)}
      </div>
      {error && <Alert tone="critical">{error}</Alert>}
      {!rows ? <TableSkeleton rows={5} columns={6} /> : rows.length === 0 ? (
        <Card><EmptyState icon={Factory} title="No orders here" description="Create a bill of materials for a product, then an order to make it." action={can('manufacturing.orders.create') && <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>New order</Button>} /></Card>
      ) : (
        <Table>
          <THead><tr><TH>Order</TH><TH>Product</TH><TH align="right">Quantity</TH><TH>Status</TH><TH>Work center</TH><TH>Planned</TH><TH align="right">Hours</TH></tr></THead>
          <TBody>
            {rows.map((r) => (
              <TR key={r.id} onClick={() => setOpenId(r.id)}>
                <TD className="font-medium">{r.number}</TD>
                <TD>{r.product_name}</TD>
                <TD align="right" numeric>{Number(r.status === 'done' ? r.produced_quantity : r.quantity)} {r.uom}</TD>
                <TD><Badge size="sm" tone={MO_TONE[r.status]}>{titleCase(r.status)}</Badge></TD>
                <TD className="text-[var(--text-secondary)]">{r.work_center_name ?? '—'}</TD>
                <TD className="text-[var(--text-secondary)]">{r.planned_start ? `${date(r.planned_start, 'short')}${r.planned_end ? ` – ${date(r.planned_end, 'short')}` : ''}` : '—'}</TD>
                <TD align="right" numeric>{Number(r.planned_hours) || '—'}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      {creating && <CreateOrder onClose={() => { setCreating(false); if (params.get('new')) router.replace('/manufacturing'); }} onCreated={(o) => { load(); setOpenId(o.id); }} />}
      {openId && <OrderDrawer id={openId} onClose={() => { setOpenId(null); if (params.get('open')) router.replace('/manufacturing'); }} onChanged={load} />}
    </div>
  );
}

function CreateOrder({ onClose, onCreated }) {
  const toast = useToast();
  const workCenters = useOptions('/manufacturing/work-centers');
  const [product, setProduct] = useState(null);
  const [form, setForm] = useState({ quantity: '1', work_center_id: '', planned_start: new Date().toISOString().slice(0, 10), planned_end: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post('/manufacturing/orders', {
        product_id: product.id, quantity: Number(form.quantity), work_center_id: form.work_center_id || null,
        planned_start: form.planned_start || null, planned_end: form.planned_end || null, notes: form.notes,
      });
      toast.success(`${r.data.number} created`);
      onClose();
      onCreated(r.data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the order.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="New manufacturing order" description="Uses the product’s active bill of materials."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!product || !(Number(form.quantity) > 0)} onClick={submit}>Create</Button></>}>
      <div className="space-y-4">
        {error && <Alert tone="critical">{error}</Alert>}
        <Field label="Product to make" required>{() => <ProductPicker value={product?.id} label={product?.name} onPick={setProduct} autoFocus />}</Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Quantity" required>{(p) => <Input {...p} type="number" min="0" step="any" value={form.quantity} onChange={set('quantity')} />}</Field>
          <Field label="Work center" hint="Defaults to the recipe’s">{(p) => <Select {...p} value={form.work_center_id} onChange={set('work_center_id')}><option value="">From the recipe</option>{workCenters.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>}</Field>
          <Field label="Start">{(p) => <Input {...p} type="date" value={form.planned_start} onChange={set('planned_start')} />}</Field>
          <Field label="Finish">{(p) => <Input {...p} type="date" value={form.planned_end} onChange={set('planned_end')} />}</Field>
        </div>
        <Field label="Notes">{(p) => <Textarea {...p} rows={2} value={form.notes} onChange={set('notes')} />}</Field>
      </div>
    </Modal>
  );
}

function OrderDrawer({ id, onClose, onChanged }) {
  const toast = useToast();
  const { can } = useWorkspace();
  const [order, setOrder] = useState(null);
  const [completing, setCompleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.get(`/manufacturing/orders/${id}`).then((r) => setOrder(r.data)).catch(() => {}), [id]);
  useEffect(() => { load(); }, [load]);

  async function act(path, message, body = {}) {
    setBusy(true);
    try {
      const r = await api.post(`/manufacturing/orders/${id}/${path}`, body);
      setOrder(r.data);
      toast.success(message);
      onChanged();
    } catch (err) {
      toast.error('That did not work', { description: err instanceof ApiError ? err.message : undefined });
    } finally {
      setBusy(false);
      setCompleting(false);
    }
  }

  const o = order;
  const short = o?.components.some((c) => c.short);
  const editable = can('manufacturing.orders.edit');
  return (
    <Drawer open onClose={onClose} width="lg" title={o ? `${o.number} · ${o.product_name}` : 'Loading…'}
      subtitle={o ? `${Number(o.quantity)} ${o.uom}${o.work_center_name ? ` · ${o.work_center_name}` : ''}` : undefined}
      badge={o && <Badge size="sm" tone={MO_TONE[o.status]}>{titleCase(o.status)}</Badge>}
      footer={o && editable && (
        <>
          {['draft', 'confirmed', 'in_progress'].includes(o.status) && <Button variant="ghost" icon={XCircle} onClick={() => act('cancel', 'Order cancelled')}>Cancel</Button>}
          <div className="flex-1" />
          {o.status === 'draft' && <Button variant="primary" loading={busy} onClick={() => act('confirm', 'Confirmed')}>Confirm</Button>}
          {o.status === 'confirmed' && <Button variant="secondary" icon={Play} loading={busy} onClick={() => act('start', 'Production started')}>Start</Button>}
          {['confirmed', 'in_progress'].includes(o.status) && <Button variant="primary" icon={CheckCircle2} onClick={() => setCompleting(true)}>Finish</Button>}
        </>
      )}>
      {o && (
        <div className="space-y-5">
          {short && ['draft', 'confirmed', 'in_progress'].includes(o.status) && (
            <Alert tone="caution" icon={TriangleAlert}>Some components are short in {o.warehouse_name}. Receive or transfer stock before finishing.</Alert>
          )}
          <section>
            <h3 className="mb-2 text-sm font-medium text-[var(--text-secondary)]">Components for this order</h3>
            <Table>
              <THead><tr><TH>Component</TH><TH align="right">Needed</TH><TH align="right">In stock</TH></tr></THead>
              <TBody>
                {o.components.map((c) => (
                  <TR key={c.product_id}>
                    <TD>{c.product_name}</TD>
                    <TD align="right" numeric>{c.required} {c.uom}</TD>
                    <TD align="right" numeric className={c.short ? 'font-medium text-[var(--color-critical-600)]' : 'text-[var(--color-positive-600)]'}>{c.available === null ? '—' : c.available}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </section>
          <DetailGrid items={[
            { label: 'Planned', value: o.planned_start ? `${date(o.planned_start)}${o.planned_end ? ` – ${date(o.planned_end)}` : ''}` : null },
            { label: 'Warehouse', value: o.warehouse_name },
            { label: 'Produced', value: o.status === 'done' ? `${Number(o.produced_quantity)} ${o.uom}${Number(o.scrap_quantity) ? ` (${Number(o.scrap_quantity)} scrapped)` : ''}` : null },
            { label: 'Unit cost', value: o.unit_cost ? money(o.unit_cost) : null },
            { label: 'Notes', value: o.notes || null, full: true },
          ]} />
        </div>
      )}
      {completing && o && <CompleteModal order={o} busy={busy} onClose={() => setCompleting(false)} onComplete={(body) => act('complete', 'Order finished — stock updated', body)} />}
    </Drawer>
  );
}

function CompleteModal({ order, busy, onClose, onComplete }) {
  const [produced, setProduced] = useState(String(Number(order.quantity)));
  const [scrap, setScrap] = useState('0');
  return (
    <Modal open onClose={onClose} title={`Finish ${order.number}`} description="Components for everything made (including scrap) come out of stock; the good units go in."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => onComplete({ produced_quantity: Number(produced), scrap_quantity: Number(scrap) })}>Finish</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Good units made">{(p) => <Input {...p} type="number" min="0" step="any" value={produced} onChange={(e) => setProduced(e.target.value)} data-autofocus />}</Field>
        <Field label="Scrapped">{(p) => <Input {...p} type="number" min="0" step="any" value={scrap} onChange={(e) => setScrap(e.target.value)} />}</Field>
      </div>
    </Modal>
  );
}
