'use client';

import { useEffect, useMemo, useState } from 'react';
import { ShoppingBag, Plus, Minus, Trash2, CheckCircle2, Phone, Mail, ArrowLeft } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { money } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Input, Field, Textarea } from '@/components/ui/input';
import { Alert, Badge } from '@/components/ui/primitives';

/**
 * The public storefront. The cart lives in this browser only; every price,
 * discount and total shown at checkout comes back from the server, which
 * re-reads the catalogue — the browser is never trusted with money.
 */
export default function ShopClient({ slug, store, products }) {
  const cartKey = `nexus-cart-${slug}`;
  const [cart, setCart] = useState({});
  const [category, setCategory] = useState('');
  const [view, setView] = useState('shop'); // shop | cart | done
  const [placed, setPlaced] = useState(null);

  useEffect(() => {
    try { setCart(JSON.parse(localStorage.getItem(cartKey) ?? '{}')); } catch { /* empty cart */ }
  }, [cartKey]);
  const save = (next) => {
    setCart(next);
    try { localStorage.setItem(cartKey, JSON.stringify(next)); } catch { /* private mode */ }
  };
  const add = (id, delta) => {
    const next = { ...cart, [id]: Math.max(0, (cart[id] ?? 0) + delta) };
    if (!next[id]) delete next[id];
    save(next);
  };

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const items = Object.entries(cart).filter(([id]) => byId.has(id)).map(([id, quantity]) => ({ product: byId.get(id), quantity }));
  const count = items.reduce((s, i) => s + i.quantity, 0);
  const estimate = items.reduce((s, i) => s + Number(i.product.price_with_tax) * i.quantity, 0);
  const categories = [...new Set(products.map((p) => p.category_name).filter(Boolean))];
  const shown = products.filter((p) => !category || p.category_name === category);

  return (
    <div className="mx-auto w-full max-w-6xl">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-[-0.03em]">{store.name}</h1>
          {store.tagline && <p className="mt-1 text-[var(--text-secondary)]">{store.tagline}</p>}
          <p className="mt-2 flex flex-wrap gap-x-4 text-sm text-[var(--text-tertiary)]">
            {store.contact_phone && <a href={`tel:${store.contact_phone}`} className="inline-flex items-center gap-1"><Phone className="size-3.5" />{store.contact_phone}</a>}
            {store.contact_email && <a href={`mailto:${store.contact_email}`} className="inline-flex items-center gap-1"><Mail className="size-3.5" />{store.contact_email}</a>}
          </p>
        </div>
        {view !== 'done' && (
          <Button variant={view === 'cart' ? 'secondary' : 'primary'} icon={view === 'cart' ? ArrowLeft : ShoppingBag} onClick={() => setView(view === 'cart' ? 'shop' : 'cart')}>
            {view === 'cart' ? 'Keep shopping' : `Cart${count ? ` · ${count}` : ''}`}
          </Button>
        )}
      </header>

      {view === 'done' && placed && (
        <div className="panel mx-auto max-w-lg p-8 text-center">
          <CheckCircle2 className="mx-auto size-12 text-[var(--color-positive-600)]" />
          <h2 className="mt-4 text-xl font-semibold">Order {placed.number} placed</h2>
          <p className="mt-2 text-[var(--text-secondary)]">Total {money(placed.total)}, to pay on delivery. {store.name} will call you to confirm.</p>
          <Button className="mt-6" variant="secondary" onClick={() => { setPlaced(null); setView('shop'); }}>Continue shopping</Button>
        </div>
      )}

      {view === 'shop' && (
        <>
          {categories.length > 0 && (
            <div className="mb-5 flex flex-wrap gap-2">
              {['', ...categories].map((c) => (
                <button key={c || 'all'} onClick={() => setCategory(c)} className={cn('rounded-full px-3.5 py-1.5 text-sm ring-1 ring-inset', category === c ? 'bg-[var(--color-brand-600)] text-white ring-transparent' : 'ring-[var(--border-default)] hover:bg-[var(--surface-hover)]')}>{c || 'Everything'}</button>
              ))}
            </div>
          )}
          {shown.length === 0 ? <p className="py-16 text-center text-[var(--text-secondary)]">Nothing is on sale here yet.</p> : (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
              {shown.map((p) => (
                <article key={p.id} className="panel flex flex-col overflow-hidden">
                  <div className="flex aspect-square items-center justify-center bg-[var(--surface-sunken)]">
                    {p.image_url
                      ? <img src={p.image_url} alt={p.name} className="h-full w-full object-cover" loading="lazy" />
                      : <span className="text-4xl font-semibold text-[var(--text-disabled)]">{p.name.slice(0, 1)}</span>}
                  </div>
                  <div className="flex flex-1 flex-col p-3">
                    <h2 className="line-clamp-2 text-sm font-medium">{p.name}</h2>
                    {p.description && <p className="mt-1 line-clamp-2 text-xs text-[var(--text-tertiary)]">{p.description}</p>}
                    <div className="mt-auto flex items-center justify-between gap-2 pt-3">
                      <span className="font-semibold">{money(p.price_with_tax)}</span>
                      {!p.in_stock ? <Badge size="sm">Sold out</Badge> : cart[p.id] ? (
                        <span className="flex items-center gap-1">
                          <Button size="icon-sm" variant="secondary" icon={Minus} aria-label="Less" onClick={() => add(p.id, -1)} />
                          <span className="w-6 text-center text-sm tabular">{cart[p.id]}</span>
                          <Button size="icon-sm" variant="secondary" icon={Plus} aria-label="More" onClick={() => add(p.id, 1)} />
                        </span>
                      ) : <Button size="sm" variant="primary" onClick={() => add(p.id, 1)}>Add</Button>}
                    </div>
                    {p.low_stock && <p className="mt-1 text-xs text-[var(--color-caution-600)]">Only {p.low_stock} left</p>}
                  </div>
                </article>
              ))}
            </div>
          )}
          {count > 0 && (
            <div className="sticky bottom-4 mt-6 flex justify-center">
              <Button size="lg" variant="primary" icon={ShoppingBag} onClick={() => setView('cart')}>View cart · {count} item{count === 1 ? '' : 's'} · about {money(estimate)}</Button>
            </div>
          )}
        </>
      )}

      {view === 'cart' && <Checkout slug={slug} store={store} items={items} onChange={add} onPlaced={(o) => { save({}); setPlaced(o); setView('done'); }} />}
    </div>
  );
}

function Checkout({ slug, store, items, onChange, onPlaced }) {
  const [promo, setPromo] = useState('');
  const [applied, setApplied] = useState('');
  const [quote, setQuote] = useState(null);
  const [quoteError, setQuoteError] = useState(null);
  const [form, setForm] = useState({ name: '', phone: '', email: '', line1: '', line2: '', city: '', state: '', pincode: '', notes: '' });
  const [trap, setTrap] = useState('');
  const [errors, setErrors] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const payloadItems = items.map((i) => ({ product_id: i.product.id, quantity: i.quantity }));
  const itemsKey = JSON.stringify(payloadItems);

  useEffect(() => {
    if (!payloadItems.length) { setQuote(null); return; }
    api.post(`/store/${slug}/quote`, { items: payloadItems, promo_code: applied || undefined }, { retry: false, redirectOnUnauthorized: false })
      .then((r) => { setQuote(r.data); setQuoteError(null); })
      .catch((err) => {
        setQuoteError(err instanceof ApiError ? err.message : 'Could not price your cart.');
        if (err instanceof ApiError && err.details?.code === 'invalid_promo') setApplied('');
      });
  }, [itemsKey, applied, slug]);

  async function place(event) {
    event.preventDefault();
    setBusy(true);
    setErrors({});
    setError(null);
    try {
      const r = await api.post(`/store/${slug}/checkout`, {
        items: payloadItems, promo_code: applied || undefined, notes: form.notes, website: trap || undefined,
        customer: { name: form.name, phone: form.phone, email: form.email || null },
        address: { line1: form.line1, line2: form.line2, city: form.city, state: form.state, pincode: form.pincode },
      }, { retry: false, redirectOnUnauthorized: false });
      onPlaced(r.data);
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fieldErrors).length) setErrors(err.fieldErrors);
      setError(err instanceof ApiError ? (err.code === 'validation_failed' ? 'Please check your name, mobile number, address and 6-digit PIN code.' : err.message) : 'Could not place the order. Check your connection.');
    } finally {
      setBusy(false);
    }
  }

  if (!items.length) return <p className="py-16 text-center text-[var(--text-secondary)]">Your cart is empty.</p>;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <form onSubmit={place} className="panel space-y-4 p-6" noValidate>
        <h2 className="text-lg font-semibold">Delivery details</h2>
        {error && <Alert tone="critical">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Full name" required error={errors['customer/name']}>{(p) => <Input {...p} autoComplete="name" value={form.name} onChange={set('name')} />}</Field>
          <Field label="Mobile number" required error={errors['customer/phone']}>{(p) => <Input {...p} type="tel" autoComplete="tel" value={form.phone} onChange={set('phone')} />}</Field>
          <Field label="Email" hint="For your order updates" className="sm:col-span-2">{(p) => <Input {...p} type="email" autoComplete="email" value={form.email} onChange={set('email')} />}</Field>
          <Field label="Address" required className="sm:col-span-2">{(p) => <Input {...p} autoComplete="address-line1" value={form.line1} onChange={set('line1')} placeholder="House, street" />}</Field>
          <Field label="Area / landmark" className="sm:col-span-2">{(p) => <Input {...p} autoComplete="address-line2" value={form.line2} onChange={set('line2')} />}</Field>
          <Field label="City" required>{(p) => <Input {...p} autoComplete="address-level2" value={form.city} onChange={set('city')} />}</Field>
          <Field label="State" required>{(p) => <Input {...p} autoComplete="address-level1" value={form.state} onChange={set('state')} />}</Field>
          <Field label="PIN code" required error={errors['address/pincode']}>{(p) => <Input {...p} inputMode="numeric" autoComplete="postal-code" value={form.pincode} onChange={set('pincode')} />}</Field>
        </div>
        <Field label="Note for the store">{(p) => <Textarea {...p} rows={2} value={form.notes} onChange={set('notes')} />}</Field>
        <div aria-hidden="true" className="absolute left-[-10000px] h-px w-px overflow-hidden"><label>Website <input tabIndex={-1} autoComplete="off" value={trap} onChange={(e) => setTrap(e.target.value)} /></label></div>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={!quote || !store.cod_enabled}>
          {store.cod_enabled ? `Place order · pay ${quote ? money(quote.total) : ''} on delivery` : 'Ordering is not open yet'}
        </Button>
      </form>

      <aside className="panel h-fit space-y-3 p-5">
        <h2 className="font-semibold">Your order</h2>
        <ul className="space-y-2 text-sm">
          {items.map(({ product, quantity }) => (
            <li key={product.id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{product.name}</span>
              <Button size="icon-sm" variant="ghost" icon={Minus} aria-label="Less" onClick={() => onChange(product.id, -1)} />
              <span className="w-5 text-center tabular">{quantity}</span>
              <Button size="icon-sm" variant="ghost" icon={Plus} aria-label="More" onClick={() => onChange(product.id, 1)} />
              <Button size="icon-sm" variant="ghost" icon={Trash2} aria-label="Remove" onClick={() => onChange(product.id, -quantity)} />
            </li>
          ))}
        </ul>
        <form onSubmit={(e) => { e.preventDefault(); setApplied(promo.trim()); }} className="flex gap-2">
          <Input value={promo} onChange={(e) => setPromo(e.target.value.toUpperCase())} placeholder="Promo code" className="flex-1" />
          <Button type="submit" variant="secondary" disabled={!promo.trim()}>Apply</Button>
        </form>
        {quoteError && <p className="text-sm text-[var(--color-critical-600)]">{quoteError}</p>}
        {quote && (
          <div className="space-y-1 border-t border-[var(--border-subtle)] pt-3 text-sm">
            <div className="flex justify-between"><span>Subtotal</span><span className="tabular">{money(quote.subtotal)}</span></div>
            {Number(quote.discount) > 0 && <div className="flex justify-between text-[var(--color-positive-600)]"><span>Discount {quote.promo_code && `(${quote.promo_code})`}</span><span className="tabular">−{money(quote.discount)}</span></div>}
            <div className="flex justify-between"><span>GST</span><span className="tabular">{money(quote.tax)}</span></div>
            <div className="flex justify-between"><span>Delivery</span><span className="tabular">{Number(quote.shipping) ? money(quote.shipping) : 'Free'}</span></div>
            <div className="flex justify-between pt-1 text-md font-semibold"><span>Total</span><span className="tabular">{money(quote.total)}</span></div>
            {store.free_shipping_over && Number(quote.shipping) > 0 && <p className="text-xs text-[var(--text-tertiary)]">Free delivery on orders over {money(store.free_shipping_over)}.</p>}
          </div>
        )}
      </aside>
    </div>
  );
}
