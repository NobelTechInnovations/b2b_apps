'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Minus, Plus, Trash2, Banknote, CreditCard, Smartphone, WifiOff, Printer, LogOut, ScanBarcode, CircleDollarSign } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { money, date } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Alert, Badge, Skeleton } from '@/components/ui/primitives';

const METHODS = [['cash', 'Cash', Banknote], ['upi', 'UPI', Smartphone], ['card', 'Card', CreditCard], ['other', 'Other', CircleDollarSign]];
const paise = (v) => Math.round(Number(v || 0) * 100);

/** Same arithmetic as the server, so the screen and the receipt agree. */
function lineMath(line) {
  const gross = Math.round(paise(line.price) * Number(line.quantity));
  const discount = Math.round((gross * Number(line.discount || 0)) / 100);
  const taxable = gross - discount;
  const tax = Math.round((taxable * Number(line.tax_rate)) / 100);
  return { gross, discount, tax, total: taxable + tax };
}

const newRef = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`).replace(/[^A-Za-z0-9_-]/g, '');

/**
 * The till. Built for a counter: big targets, a scanner-friendly search box
 * that adds on Enter, and a queue for sales rung up while offline — each
 * carries its own reference, so syncing twice never charges twice.
 */
export default function TillClient({ registerId }) {
  const toast = useToast();
  const { can } = useWorkspace();
  const queueKey = `nexus-pos-queue-${registerId}`;
  const [till, setTill] = useState(null);
  const [error, setError] = useState(null);
  const [cart, setCart] = useState([]);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [paying, setPaying] = useState(false);
  const [receipt, setReceipt] = useState(null);
  const [closing, setClosing] = useState(false);
  const [queue, setQueue] = useState([]);
  const [online, setOnline] = useState(true);
  const scanRef = useRef(null);

  const load = useCallback(async () => {
    try {
      setTill((await api.get(`/pos/registers/${registerId}/till`)).data);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open the till.');
    }
  }, [registerId]);
  useEffect(() => { load(); }, [load]);

  // ── the offline queue ─────────────────────────────────────────────────────
  const readQueue = useCallback(() => {
    try { return JSON.parse(localStorage.getItem(queueKey) ?? '[]'); } catch { return []; }
  }, [queueKey]);
  const writeQueue = useCallback((items) => {
    try { localStorage.setItem(queueKey, JSON.stringify(items)); } catch { /* private mode: keep in memory */ }
    setQueue(items);
  }, [queueKey]);
  useEffect(() => { setQueue(readQueue()); }, [readQueue]);

  const sync = useCallback(async () => {
    const pending = readQueue();
    if (!pending.length || !navigator.onLine) return;
    const left = [];
    for (const sale of pending) {
      try {
        await api.post('/pos/sales', sale, { retry: true });
      } catch (err) {
        // Rejected by the server (not a network failure): keep it, but visible.
        if (err instanceof ApiError) left.push({ ...sale, error: err.message });
        else left.push(sale);
      }
    }
    writeQueue(left);
    if (left.length < pending.length) { toast.success(`${pending.length - left.length} offline sale${pending.length - left.length === 1 ? '' : 's'} synced`); load(); }
  }, [readQueue, writeQueue, toast, load]);

  useEffect(() => {
    const update = () => { setOnline(navigator.onLine); if (navigator.onLine) sync(); };
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    const timer = setInterval(sync, 15000);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); clearInterval(timer); };
  }, [sync]);

  // ── the cart ──────────────────────────────────────────────────────────────
  const add = (product) => {
    if (!product) return;
    setCart((c) => {
      const existing = c.find((l) => l.product_id === product.id);
      if (existing) return c.map((l) => (l.product_id === product.id ? { ...l, quantity: l.quantity + 1 } : l));
      return [...c, { product_id: product.id, name: product.name, price: product.sale_price, tax_rate: Number(product.tax_rate), quantity: 1, discount: 0, uom: product.uom }];
    });
  };
  const setLine = (id, patch) => setCart((c) => c.map((l) => (l.product_id === id ? { ...l, ...patch } : l)).filter((l) => l.quantity > 0));

  const totals = useMemo(() => {
    const sum = cart.reduce((a, l) => { const m = lineMath(l); return { gross: a.gross + m.gross, discount: a.discount + m.discount, tax: a.tax + m.tax, total: a.total + m.total }; }, { gross: 0, discount: 0, tax: 0, total: 0 });
    return { ...sum, payable: Math.round(sum.total / 100) * 100 };
  }, [cart]);

  const products = till?.products ?? [];
  const categories = [...new Set(products.map((p) => p.category_name).filter(Boolean))];
  const shown = products.filter((p) => (!category || p.category_name === category)
    && (!search || [p.name, p.sku, p.barcode].some((v) => v?.toLowerCase().includes(search.toLowerCase()))));

  function onScan(event) {
    if (event.key !== 'Enter') return;
    const code = search.trim().toLowerCase();
    const hit = products.find((p) => p.barcode?.toLowerCase() === code || p.sku?.toLowerCase() === code) ?? (shown.length === 1 ? shown[0] : null);
    if (hit) { add(hit); setSearch(''); } else toast.error('No product with that code');
  }

  async function openShift(openingCash) {
    try {
      await api.post(`/pos/registers/${registerId}/open`, { opening_cash: Number(openingCash || 0) });
      toast.success('Shift opened');
      load();
    } catch (err) {
      toast.error('Could not open the shift', { description: err instanceof ApiError ? err.message : undefined });
    }
  }

  async function charge({ method, tendered, customer }) {
    const sale = {
      session_id: till.session.id, client_ref: newRef(),
      lines: cart.map((l) => ({ product_id: l.product_id, quantity: l.quantity, discount_percent: Number(l.discount || 0) })),
      payment_method: method, amount_tendered: method === 'cash' && tendered !== '' ? Number(tendered).toFixed(2) : null,
      customer_name: customer.name || null, customer_phone: customer.phone || null,
    };
    const local = { ...sale, total: (totals.payable / 100).toFixed(2), items: cart, sold_at: new Date().toISOString() };
    try {
      const r = await api.post('/pos/sales', sale);
      setReceipt({ ...r.data, footer: till.register.receipt_footer });
      toast.success(`Sale ${r.data.number} — ${money(r.data.total)}`);
      load();
    } catch (err) {
      if (err instanceof ApiError) {
        toast.error('Sale not completed', { description: err.message });
        return false;
      }
      // Network gone: keep the sale, sync it later.
      writeQueue([...readQueue(), { ...sale, offline: true, sold_at: local.sold_at }]);
      setReceipt({ number: 'OFFLINE', ...local, lines: cart.map((l) => ({ name: l.name, quantity: l.quantity, unit_price: l.price, line_total: (lineMath(l).total / 100).toFixed(2) })), subtotal: (totals.gross / 100).toFixed(2), tax_total: (totals.tax / 100).toFixed(2), discount_total: (totals.discount / 100).toFixed(2), payment_method: method, offline: true, footer: till.register.receipt_footer });
      toast.success('Offline — sale saved and will sync');
    }
    setCart([]);
    setPaying(false);
    return true;
  }

  if (error) return <div className="space-y-3"><Link href="/pos"><Button variant="ghost" size="sm" icon={ArrowLeft}>Registers</Button></Link><Alert tone="critical">{error}</Alert></div>;
  if (!till) return <Skeleton className="h-[70vh] w-full" />;

  if (!till.session) {
    return (
      <div className="mx-auto max-w-sm space-y-4 py-16 text-center">
        <h1 className="text-xl font-semibold">{till.register.name}</h1>
        <p className="text-sm text-[var(--text-secondary)]">No shift is open. Count the cash float and open the till.</p>
        {can('pos.sessions.open') ? <OpenShift onOpen={openShift} /> : <Alert tone="info">Ask a manager to open the shift.</Alert>}
        <Link href="/pos" className="text-sm text-[var(--color-brand-600)]">Back to registers</Link>
      </div>
    );
  }

  return (
    <div className="-m-2 grid h-[calc(100vh-7rem)] min-h-[32rem] gap-4 lg:grid-cols-[1fr_24rem]">
      {/* ── catalogue ── */}
      <section className="flex min-h-0 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/pos"><Button variant="ghost" size="sm" icon={ArrowLeft}>{till.register.name}</Button></Link>
          <Input ref={scanRef} icon={ScanBarcode} value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={onScan} placeholder="Scan a barcode or search…" className="min-w-[14rem] flex-1" autoFocus />
          {!online && <Badge tone="caution"><WifiOff className="size-3" /> Offline</Badge>}
          {queue.length > 0 && <Badge tone="caution">{queue.length} to sync</Badge>}
        </div>
        {categories.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {['', ...categories].map((c) => (
              <button key={c || 'all'} onClick={() => setCategory(c)} className={cn('rounded-full px-3 py-1 text-sm ring-1 ring-inset', category === c ? 'bg-[var(--color-brand-600)] text-white ring-transparent' : 'ring-[var(--border-default)] hover:bg-[var(--surface-hover)]')}>{c || 'All'}</button>
            ))}
          </div>
        )}
        <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3 xl:grid-cols-4">
          {shown.map((p) => (
            <button key={p.id} onClick={() => add(p)} className="panel flex flex-col items-start p-3 text-left transition active:scale-[0.98] hover:border-[var(--color-brand-400)]">
              <span className="line-clamp-2 text-sm font-medium">{p.name}</span>
              <span className="mt-auto pt-2 text-md font-semibold">{money(Math.round(paise(p.sale_price) * (1 + Number(p.tax_rate) / 100)) / 100)}</span>
              {p.type === 'stockable' && <span className={cn('text-xs', Number(p.on_hand) <= 0 ? 'text-[var(--color-critical-600)]' : 'text-[var(--text-tertiary)]')}>{Number(p.on_hand)} in stock</span>}
            </button>
          ))}
          {shown.length === 0 && <p className="col-span-full py-10 text-center text-sm text-[var(--text-tertiary)]">No products match.</p>}
        </div>
      </section>

      {/* ── cart ── */}
      <section className="panel flex min-h-0 flex-col">
        <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-3">
          <div>
            <p className="text-sm font-semibold">Current sale</p>
            <p className="text-xs text-[var(--text-tertiary)]">Shift opened {date(till.session.opened_at, 'time')} · {till.totals?.sales ?? 0} sales · {money(till.totals?.revenue ?? 0)}</p>
          </div>
          {can('pos.sessions.close') && <Button size="sm" variant="ghost" icon={LogOut} onClick={() => setClosing(true)}>Close shift</Button>}
        </div>
        <ul className="min-h-0 flex-1 divide-y divide-[var(--border-subtle)] overflow-y-auto">
          {cart.length === 0 && <li className="px-4 py-12 text-center text-sm text-[var(--text-tertiary)]">Tap a product or scan a barcode.</li>}
          {cart.map((l) => (
            <li key={l.product_id} className="px-4 py-2.5">
              <div className="flex items-start gap-2">
                <span className="min-w-0 flex-1 text-sm font-medium">{l.name}</span>
                <span className="tabular text-sm">{money(lineMath(l).total / 100)}</span>
              </div>
              <div className="mt-1.5 flex items-center gap-1.5">
                <Button size="icon-sm" variant="secondary" icon={Minus} aria-label="Less" onClick={() => setLine(l.product_id, { quantity: l.quantity - 1 })} />
                <span className="w-8 text-center tabular text-sm">{l.quantity}</span>
                <Button size="icon-sm" variant="secondary" icon={Plus} aria-label="More" onClick={() => setLine(l.product_id, { quantity: l.quantity + 1 })} />
                <span className="ml-2 text-xs text-[var(--text-tertiary)]">Disc %</span>
                <Input className="h-7 w-14 text-right text-xs" type="number" min="0" max="100" value={l.discount} onChange={(e) => setLine(l.product_id, { discount: e.target.value })} aria-label={`Discount on ${l.name}`} />
                <div className="flex-1" />
                <Button size="icon-sm" variant="ghost" icon={Trash2} aria-label="Remove" onClick={() => setLine(l.product_id, { quantity: 0 })} />
              </div>
            </li>
          ))}
        </ul>
        <div className="space-y-1 border-t border-[var(--border-subtle)] px-4 py-3 text-sm">
          <Row label="Subtotal" value={money(totals.gross / 100)} />
          {totals.discount > 0 && <Row label="Discount" value={`−${money(totals.discount / 100)}`} />}
          <Row label="GST" value={money(totals.tax / 100)} />
          <div className="flex justify-between pt-1 text-lg font-semibold"><span>To pay</span><span className="tabular">{money(totals.payable / 100)}</span></div>
          <Button size="xl" variant="primary" className="mt-2 w-full" disabled={!cart.length} onClick={() => setPaying(true)}>Charge {money(totals.payable / 100)}</Button>
        </div>
      </section>

      {paying && <PayModal total={totals.payable} onClose={() => setPaying(false)} onPay={charge} />}
      {receipt && <Receipt sale={receipt} register={till.register} onClose={() => { setReceipt(null); scanRef.current?.focus(); }} />}
      {closing && <CloseShift session={till.session} totals={till.totals} onClose={() => setClosing(false)} onClosed={load} />}
    </div>
  );
}

const Row = ({ label, value }) => <div className="flex justify-between text-[var(--text-secondary)]"><span>{label}</span><span className="tabular">{value}</span></div>;

function OpenShift({ onOpen }) {
  const [cash, setCash] = useState('');
  return (
    <form onSubmit={(e) => { e.preventDefault(); onOpen(cash); }} className="space-y-3">
      <Field label="Opening cash float (₹)">{(p) => <Input {...p} type="number" min="0" step="1" value={cash} onChange={(e) => setCash(e.target.value)} autoFocus />}</Field>
      <Button type="submit" variant="primary" size="lg" className="w-full">Open shift</Button>
    </form>
  );
}

function PayModal({ total, onClose, onPay }) {
  const [method, setMethod] = useState('cash');
  const [tendered, setTendered] = useState('');
  const [customer, setCustomer] = useState({ name: '', phone: '' });
  const [busy, setBusy] = useState(false);
  const change = method === 'cash' && tendered !== '' ? paise(tendered) - total : null;
  const quick = [...new Set([total / 100, Math.ceil(total / 10000) * 100, Math.ceil(total / 50000) * 500, Math.ceil(total / 200000) * 2000])].filter((v) => v >= total / 100).slice(0, 4);

  async function pay() {
    setBusy(true);
    const done = await onPay({ method, tendered, customer });
    if (done === false) setBusy(false);
  }

  return (
    <Modal open onClose={onClose} title={`Charge ${money(total / 100)}`} size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Back</Button><Button variant="primary" size="lg" loading={busy} disabled={change !== null && change < 0} onClick={pay}>Complete sale</Button></>}>
      <div className="space-y-4">
        <div className="grid grid-cols-4 gap-2">
          {METHODS.map(([key, label, Icon]) => (
            <button key={key} onClick={() => setMethod(key)} className={cn('flex flex-col items-center gap-1 rounded-[var(--radius-lg)] border p-3 text-sm font-medium', method === key ? 'border-[var(--color-brand-600)] bg-[var(--color-brand-50)] text-[var(--color-brand-700)] dark:bg-[rgb(99_102_241/0.12)]' : 'border-[var(--border-default)]')}>
              <Icon className="size-5" />{label}
            </button>
          ))}
        </div>
        {method === 'cash' && (
          <div className="space-y-2">
            <Field label="Cash received">{(p) => <Input {...p} type="number" min="0" step="1" value={tendered} onChange={(e) => setTendered(e.target.value)} autoFocus />}</Field>
            <div className="flex flex-wrap gap-2">{quick.map((q) => <Button key={q} size="sm" variant="secondary" onClick={() => setTendered(String(q))}>{money(q)}</Button>)}</div>
            {change !== null && <p className={cn('text-lg font-semibold', change < 0 ? 'text-[var(--color-critical-600)]' : 'text-[var(--color-positive-600)]')}>{change < 0 ? `Short by ${money(-change / 100)}` : `Change ${money(change / 100)}`}</p>}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Customer name (optional)">{(p) => <Input {...p} value={customer.name} onChange={(e) => setCustomer((c) => ({ ...c, name: e.target.value }))} />}</Field>
          <Field label="Phone (optional)">{(p) => <Input {...p} value={customer.phone} onChange={(e) => setCustomer((c) => ({ ...c, phone: e.target.value }))} />}</Field>
        </div>
      </div>
    </Modal>
  );
}

export function Receipt({ sale, register, onClose }) {
  return (
    <Modal open onClose={onClose} title={sale.offline ? 'Sale saved offline' : `Receipt ${sale.number}`} size="sm"
      footer={<><Button variant="ghost" icon={Printer} onClick={() => window.print()}>Print</Button><Button variant="primary" onClick={onClose} data-autofocus>New sale</Button></>}>
      <div className="print-receipt space-y-2 font-mono text-xs">
        <p className="text-center font-semibold">{register?.name ?? sale.register_name}</p>
        <p className="text-center">{sale.number} · {date(sale.sold_at ?? new Date(), 'datetime')}</p>
        <hr className="border-dashed border-[var(--border-default)]" />
        {sale.lines?.map((l, i) => (
          <div key={i} className="flex justify-between gap-2"><span className="min-w-0 flex-1 truncate">{l.name} × {Number(l.quantity)}</span><span>{money(l.line_total)}</span></div>
        ))}
        <hr className="border-dashed border-[var(--border-default)]" />
        <div className="flex justify-between"><span>Subtotal</span><span>{money(sale.subtotal)}</span></div>
        {Number(sale.discount_total) > 0 && <div className="flex justify-between"><span>Discount</span><span>−{money(sale.discount_total)}</span></div>}
        <div className="flex justify-between"><span>GST</span><span>{money(sale.tax_total)}</span></div>
        <div className="flex justify-between text-sm font-semibold"><span>Total</span><span>{money(sale.total)}</span></div>
        <div className="flex justify-between"><span>Paid by</span><span className="uppercase">{sale.payment_method}</span></div>
        {Number(sale.change_due) > 0 && <div className="flex justify-between"><span>Change</span><span>{money(sale.change_due)}</span></div>}
        <p className="pt-2 text-center">{sale.footer ?? sale.receipt_footer}</p>
      </div>
    </Modal>
  );
}

function CloseShift({ session, totals, onClose, onClosed }) {
  const toast = useToast();
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [result, setResult] = useState(null);
  const expected = paise(session.opening_cash) + paise(totals?.cash ?? 0);

  async function close() {
    try {
      const r = await api.post(`/pos/sessions/${session.id}/close`, { counted_cash: Number(counted).toFixed(2), note });
      setResult(r.data);
    } catch (err) {
      toast.error('Could not close the shift', { description: err instanceof ApiError ? err.message : undefined });
    }
  }

  if (result) {
    const diff = Number(result.difference);
    return (
      <Modal open onClose={() => { onClose(); onClosed(); }} title="Shift closed" size="sm" footer={<Button variant="primary" onClick={() => { onClose(); onClosed(); }}>Done</Button>}>
        <div className="space-y-1 text-sm">
          <Row label="Sales" value={result.totals.sales} />
          <Row label="Revenue" value={money(result.totals.revenue)} />
          <Row label="Cash / UPI / Card" value={`${money(result.totals.cash)} / ${money(result.totals.upi)} / ${money(result.totals.card)}`} />
          <Row label="Expected in drawer" value={money(result.expected_cash)} />
          <Row label="Counted" value={money(result.counted_cash)} />
          <p className={cn('pt-2 text-md font-semibold', diff === 0 ? 'text-[var(--color-positive-600)]' : 'text-[var(--color-critical-600)]')}>{diff === 0 ? 'The drawer balances.' : `${diff > 0 ? 'Over' : 'Short'} by ${money(Math.abs(diff))}`}</p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} title="Close shift" description="Count the cash in the drawer. The difference from what the till expects is recorded."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={counted === ''} onClick={close}>Close shift</Button></>}>
      <div className="space-y-3">
        <p className="text-sm text-[var(--text-secondary)]">Float {money(session.opening_cash)} + cash sales {money(totals?.cash ?? 0)} = expected <strong>{money(expected / 100)}</strong></p>
        <Field label="Cash counted (₹)">{(p) => <Input {...p} type="number" min="0" step="1" value={counted} onChange={(e) => setCounted(e.target.value)} autoFocus />}</Field>
        <Field label="Note">{(p) => <Input {...p} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
      </div>
    </Modal>
  );
}
