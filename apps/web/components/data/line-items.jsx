'use client';

import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { money } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * Search the catalogue as you type. Picks a product and hands back the whole
 * row (price, tax, unit) so the line can fill itself in.
 */
export function ProductPicker({ value, label, onPick, placeholder = 'Search products…', query = {}, className, autoFocus }) {
  const [text, setText] = useState(label ?? '');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState([]);
  const box = useRef(null);
  const fixed = JSON.stringify(query);

  useEffect(() => { setText(label ?? ''); }, [label]);

  useEffect(() => {
    if (!open) return undefined;
    const timer = setTimeout(() => {
      api.get('/erp/products', { query: { ...JSON.parse(fixed), active: true, q: text && text !== label ? text : undefined, limit: 20, sort: 'name', order: 'asc' } })
        .then((r) => setResults(r.data ?? [])).catch(() => setResults([]));
    }, 200);
    return () => clearTimeout(timer);
  }, [text, open, fixed, label]);

  useEffect(() => {
    const close = (event) => { if (box.current && !box.current.contains(event.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  return (
    <div ref={box} className={cn('relative', className)}>
      <Input
        icon={Search}
        value={text}
        onChange={(e) => { setText(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        aria-label="Product"
        autoFocus={autoFocus}
        className={value ? '' : 'text-[var(--text-secondary)]'}
      />
      {open && (
        <ul className="absolute z-50 mt-1 max-h-64 w-full min-w-[16rem] overflow-auto rounded-[var(--radius-lg)] border border-[var(--border-default)] bg-[var(--surface-raised)] py-1 shadow-lg">
          {results.length === 0 && <li className="px-3 py-2 text-sm text-[var(--text-tertiary)]">No products found</li>}
          {results.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--surface-hover)]"
                onClick={() => { onPick(p); setText(p.name); setOpen(false); }}
              >
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                {p.sku && <span className="text-xs text-[var(--text-tertiary)]">{p.sku}</span>}
                {p.type === 'stockable' && <span className="tabular text-xs text-[var(--text-tertiary)]">{Number(p.on_hand)} {p.uom}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const lineTotal = (l, { discount, tax }) => {
  const gross = Number(l.quantity || 0) * Number(l.unit_price || 0);
  const net = gross * (1 - (discount ? Number(l.discount_percent || 0) : 0) / 100);
  return net * (1 + (tax ? Number(l.tax_rate || 0) : 0) / 100);
};

/**
 * Editable lines for anything priced per item: purchase orders, quotes,
 * bills of materials. Totals here are a preview; the server recomputes them
 * from the catalogue and the numbers it is sent, and its answer is the one
 * that is kept.
 *
 * `priceFrom` picks which catalogue price a new line starts with.
 */
export function LineItems({
  lines, onChange, priceFrom = 'sale_price', showPrice = true, showTax = true, showDiscount = false,
  allowFreeText = false, productQuery, minLines = 1,
}) {
  const update = (index, patch) => onChange(lines.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  const add = () => onChange([...lines, { quantity: 1, unit_price: '', tax_rate: 18, discount_percent: 0 }]);
  const remove = (index) => onChange(lines.filter((_, i) => i !== index));
  const options = { discount: showDiscount, tax: showTax };
  const total = lines.reduce((sum, l) => sum + lineTotal(l, options), 0);

  return (
    <div className="space-y-2">
      <div className="hidden gap-2 px-1 text-xs font-medium text-[var(--text-tertiary)] sm:flex">
        <span className="flex-1">Item</span>
        <span className="w-20 text-right">Qty</span>
        {showPrice && <span className="w-28 text-right">Unit price</span>}
        {showDiscount && <span className="w-16 text-right">Disc %</span>}
        {showTax && <span className="w-16 text-right">Tax %</span>}
        {showPrice && <span className="w-28 text-right">Amount</span>}
        <span className="w-8" />
      </div>
      {lines.map((l, index) => (
        <div key={index} className="flex flex-wrap items-start gap-2 rounded-[var(--radius-md)] sm:flex-nowrap">
          <div className="min-w-[12rem] flex-1 space-y-1">
            <ProductPicker
              value={l.product_id}
              label={l.product_name ?? (l.product_id ? l.description : '')}
              query={productQuery}
              placeholder={allowFreeText ? 'Search products (optional)…' : 'Search products…'}
              onPick={(p) => update(index, {
                product_id: p.id, product_name: p.name, description: l.description || p.name, uom: p.uom,
                unit_price: String(p[priceFrom] ?? ''), tax_rate: Number(p.tax_rate ?? l.tax_rate ?? 0),
              })}
            />
            {allowFreeText && (
              <Input value={l.description ?? ''} onChange={(e) => update(index, { description: e.target.value })} placeholder="Description" aria-label="Description" />
            )}
          </div>
          <Input className="w-20 text-right" type="number" min="0" step="any" value={l.quantity ?? ''} onChange={(e) => update(index, { quantity: e.target.value })} aria-label="Quantity" />
          {showPrice && <Input className="w-28 text-right" type="number" min="0" step="0.01" value={l.unit_price ?? ''} onChange={(e) => update(index, { unit_price: e.target.value })} aria-label="Unit price" />}
          {showDiscount && <Input className="w-16 text-right" type="number" min="0" max="100" step="0.01" value={l.discount_percent ?? 0} onChange={(e) => update(index, { discount_percent: e.target.value })} aria-label="Discount percent" />}
          {showTax && <Input className="w-16 text-right" type="number" min="0" max="100" step="0.01" value={l.tax_rate ?? 0} onChange={(e) => update(index, { tax_rate: e.target.value })} aria-label="Tax percent" />}
          {showPrice && <span className="w-28 pt-2 text-right text-sm tabular">{money(lineTotal(l, options))}</span>}
          <Button type="button" variant="ghost" size="icon-sm" icon={Trash2} aria-label="Remove line" disabled={lines.length <= minLines} onClick={() => remove(index)} className="mt-0.5" />
        </div>
      ))}
      <div className="flex items-center justify-between">
        <Button type="button" size="sm" variant="secondary" icon={Plus} onClick={add}>Add line</Button>
        {showPrice && <p className="text-sm">Total <span className="metric ml-2 text-md font-semibold">{money(total)}</span></p>}
      </div>
    </div>
  );
}

/** Lines as the API wants them: numbers, and only the fields it accepts. */
export function linesPayload(lines, { price = true, tax = true, discount = false, description = true } = {}) {
  return lines.filter((l) => l.product_id || (description && l.description?.trim())).map((l) => {
    const out = { quantity: Number(l.quantity) };
    if (l.product_id) out.product_id = l.product_id;
    if (description && l.description) out.description = l.description;
    if (price && l.unit_price !== '' && l.unit_price !== undefined) out.unit_price = Number(l.unit_price).toFixed(2);
    if (tax) out.tax_rate = Number(l.tax_rate ?? 0);
    if (discount) out.discount_percent = Number(l.discount_percent ?? 0);
    return out;
  });
}
