'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ArrowLeftRight, ClipboardList, Boxes, TriangleAlert } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { money, relativeTime } from '@/lib/format';
import { Can } from '@/lib/workspace';
import { titleCase } from '@/lib/people';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { StatTile } from '@/components/data/stat-tile';
import { useOptions } from '@/components/data/resource-page';
import { ProductPicker } from '@/components/data/line-items';
import { Table, THead, TBody, TH, TR, TD, TableSkeleton } from '@/components/ui/table';
import { Badge, Card, EmptyState, PageHeader, Alert } from '@/components/ui/primitives';

export default function StockClient() {
  const params = useSearchParams();
  const [tab, setTab] = useState(params.get('tab') === 'moves' ? 'moves' : 'levels');
  const [warehouseId, setWarehouseId] = useState('');
  const [lowOnly, setLowOnly] = useState(params.get('low') === '1');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState(null);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  const [counting, setCounting] = useState(null);
  const [transferring, setTransferring] = useState(false);
  const warehouses = useOptions('/erp/warehouses');

  const load = useCallback(async () => {
    try {
      const r = await api.get('/erp/stock', { query: { warehouse_id: warehouseId || undefined, low: lowOnly || undefined, q: search || undefined } });
      setRows(r.data);
      setMeta(r.meta);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load stock.');
    }
  }, [warehouseId, lowOnly, search]);

  useEffect(() => {
    const timer = setTimeout(load, search ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, search]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Stock"
        description="What is on the shelves, by warehouse. Record a count or move stock between warehouses; every change is kept in the history."
        actions={
          <Can permission="erp.inventory.adjust">
            <div className="flex gap-2">
              <Button variant="secondary" icon={ArrowLeftRight} onClick={() => setTransferring(true)}>Transfer</Button>
              <Button variant="primary" icon={ClipboardList} onClick={() => setCounting({})}>Record a count</Button>
            </div>
          </Can>
        }
      />

      <div className="flex gap-1 border-b border-[var(--border-subtle)] text-sm">
        {[['levels', 'Stock levels'], ['moves', 'Movement history']].map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)} className={cn('-mb-px border-b-2 px-3 py-2 font-medium', tab === key ? 'border-[var(--color-brand-600)]' : 'border-transparent text-[var(--text-secondary)]')}>{label}</button>
        ))}
      </div>

      {tab === 'moves' ? <Moves /> : (
        <>
          {meta && (
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
              <StatTile label="Value at cost" value={meta.total_value} format="money" icon={Boxes} tone="brand" />
              <StatTile label="Products shown" value={rows?.length ?? 0} />
              <StatTile label="At or below reorder level" value={meta.low_count} icon={TriangleAlert} tone={meta.low_count ? 'caution' : 'neutral'} />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, SKU or barcode…" className="w-full max-w-xs" />
            <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className="w-auto" aria-label="Warehouse">
              <option value="">All warehouses</option>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} /> Low stock only</label>
          </div>
          {error && <Alert tone="critical">{error}</Alert>}
          {!rows ? <TableSkeleton rows={6} columns={5} /> : rows.length === 0 ? (
            <Card><EmptyState icon={Boxes} title="Nothing here" description="Stockable products appear once they exist. Receive a purchase order or record a count to put stock on the shelf." /></Card>
          ) : (
            <Table>
              <THead><tr><TH>Product</TH><TH>Category</TH><TH align="right">On hand</TH><TH align="right">Reorder at</TH><TH align="right">Value</TH><TH /></tr></THead>
              <TBody>
                {rows.map((r) => (
                  <TR key={r.id} onClick={() => setCounting({ product: r })}>
                    <TD><Link href={`/erp/products?open=${r.id}`} onClick={(e) => e.stopPropagation()} className="font-medium hover:underline">{r.name}</Link>{r.sku && <p className="text-xs text-[var(--text-tertiary)]">{r.sku}</p>}</TD>
                    <TD className="text-[var(--text-secondary)]">{r.category_name ?? '—'}</TD>
                    <TD align="right" numeric className={r.low ? 'font-medium text-[var(--color-caution-600)]' : ''}>{Number(r.on_hand).toLocaleString('en-IN')} {r.uom}</TD>
                    <TD align="right" numeric>{Number(r.reorder_level) || '—'}</TD>
                    <TD align="right" numeric>{money(r.value)}</TD>
                    <TD>{r.low && <Badge size="sm" tone="caution">Reorder</Badge>}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </>
      )}

      {counting && <CountModal initial={counting.product} warehouses={warehouses} warehouseId={warehouseId} onClose={() => setCounting(null)} onSaved={load} />}
      {transferring && <TransferModal warehouses={warehouses} onClose={() => setTransferring(false)} onSaved={load} />}
    </div>
  );
}

function Moves() {
  const [rows, setRows] = useState(null);
  const [kind, setKind] = useState('');
  useEffect(() => {
    api.get('/erp/moves', { query: { kind: kind || undefined, limit: 100 } }).then((r) => setRows(r.data)).catch(() => setRows([]));
  }, [kind]);
  const kinds = ['receipt', 'delivery', 'transfer', 'adjustment_in', 'adjustment_out', 'production_in', 'production_out', 'pos_sale', 'pos_return', 'online_sale', 'online_return', 'maintenance', 'scrap'];
  return (
    <div className="space-y-3">
      <Select value={kind} onChange={(e) => setKind(e.target.value)} className="w-auto" aria-label="Kind">
        <option value="">All movements</option>
        {kinds.map((k) => <option key={k} value={k}>{titleCase(k)}</option>)}
      </Select>
      {!rows ? <TableSkeleton rows={8} columns={5} /> : (
        <Table>
          <THead><tr><TH>When</TH><TH>Product</TH><TH>Movement</TH><TH>From → to</TH><TH align="right">Qty</TH><TH>Reference</TH></tr></THead>
          <TBody>
            {rows.map((m) => (
              <TR key={m.id}>
                <TD className="whitespace-nowrap text-[var(--text-secondary)]">{relativeTime(m.created_at)}</TD>
                <TD className="font-medium">{m.product_name}</TD>
                <TD><Badge size="sm">{titleCase(m.kind)}</Badge></TD>
                <TD className="text-[var(--text-secondary)]">{m.from_name ?? '—'} → {m.to_name ?? '—'}</TD>
                <TD align="right" numeric>{Number(m.quantity).toLocaleString('en-IN')} {m.uom}</TD>
                <TD className="text-[var(--text-secondary)]">{[m.reference, m.note].filter(Boolean).join(' · ') || '—'}</TD>
              </TR>
            ))}
            {rows.length === 0 && <tr><td colSpan={6} className="py-8 text-center text-sm text-[var(--text-tertiary)]">No movements.</td></tr>}
          </TBody>
        </Table>
      )}
    </div>
  );
}

function CountModal({ initial, warehouses, warehouseId, onClose, onSaved }) {
  const toast = useToast();
  const [product, setProduct] = useState(initial ?? null);
  const [warehouse, setWarehouse] = useState(warehouseId || warehouses.find((w) => w.is_default)?.id || '');
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post('/erp/stock/adjust', { product_id: product.id, warehouse_id: warehouse || undefined, counted_quantity: Number(counted), note });
      toast.success(r.data.changed ? `Stock set to ${r.data.on_hand} (${r.data.difference > 0 ? '+' : ''}${r.data.difference})` : 'Count matches — nothing changed');
      onClose();
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record the count.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Record a stock count" description="Enter what is physically on the shelf. The difference is booked as an adjustment."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!product || counted === ''} onClick={submit}>Save count</Button></>}>
      <div className="space-y-4">
        {error && <Alert tone="critical">{error}</Alert>}
        <Field label="Product">{() => <ProductPicker value={product?.id} label={product?.name} query={{ type: 'stockable' }} onPick={setProduct} autoFocus={!initial} />}</Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Warehouse">{(p) => <Select {...p} value={warehouse} onChange={(e) => setWarehouse(e.target.value)}>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>}</Field>
          <Field label="Counted quantity">{(p) => <Input {...p} type="number" min="0" step="any" value={counted} onChange={(e) => setCounted(e.target.value)} data-autofocus={Boolean(initial)} />}</Field>
        </div>
        <Field label="Note">{(p) => <Textarea {...p} rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Monthly count, 2 damaged" />}</Field>
      </div>
    </Modal>
  );
}

function TransferModal({ warehouses, onClose, onSaved }) {
  const toast = useToast();
  const [product, setProduct] = useState(null);
  const [from, setFrom] = useState(warehouses[0]?.id ?? '');
  const [to, setTo] = useState(warehouses[1]?.id ?? '');
  const [quantity, setQuantity] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/erp/stock/transfer', { product_id: product.id, from_warehouse_id: from, to_warehouse_id: to, quantity: Number(quantity) });
      toast.success('Stock transferred');
      onClose();
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not transfer.');
    } finally {
      setBusy(false);
    }
  }

  if (warehouses.length < 2) {
    return (
      <Modal open onClose={onClose} title="Transfer stock" footer={<Link href="/erp/warehouses?new=1"><Button variant="primary">Add a warehouse</Button></Link>}>
        <p className="text-sm text-[var(--text-secondary)]">You need a second warehouse to transfer between.</p>
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} title="Transfer stock"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!product || !quantity || from === to} onClick={submit}>Transfer</Button></>}>
      <div className="space-y-4">
        {error && <Alert tone="critical">{error}</Alert>}
        <Field label="Product">{() => <ProductPicker value={product?.id} label={product?.name} query={{ type: 'stockable' }} onPick={setProduct} autoFocus />}</Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="From">{(p) => <Select {...p} value={from} onChange={(e) => setFrom(e.target.value)}>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>}</Field>
          <Field label="To">{(p) => <Select {...p} value={to} onChange={(e) => setTo(e.target.value)}>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>}</Field>
          <Field label="Quantity">{(p) => <Input {...p} type="number" min="0" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} />}</Field>
        </div>
      </div>
    </Modal>
  );
}
