'use client';

import { useState } from 'react';
import { Package, Tags, Plus } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { money, relativeTime } from '@/lib/format';
import { titleCase } from '@/lib/people';
import { useWorkspace } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Badge } from '@/components/ui/primitives';
import { ResourcePage, useOptions, clearOptionCache } from '@/components/data/resource-page';

const TYPES = [
  { value: 'stockable', label: 'Stockable — counted in warehouses' },
  { value: 'consumable', label: 'Consumable — bought and used, not counted' },
  { value: 'service', label: 'Service — no stock' },
];

export const PRODUCT_FIELDS = [
  { key: 'name', label: 'Name', required: true, full: true },
  { key: 'sku', label: 'SKU', placeholder: 'e.g. PEN-BLU' },
  { key: 'barcode', label: 'Barcode', hint: 'Scan it at the till' },
  { key: 'type', label: 'Type', type: 'select', required: true, options: TYPES, default: 'stockable' },
  { key: 'category_id', label: 'Category', type: 'relation', endpoint: '/erp/categories' },
  { key: 'uom', label: 'Unit', default: 'nos', placeholder: 'nos, kg, box…' },
  { key: 'hsn_sac', label: 'HSN / SAC' },
  { key: 'sale_price', label: 'Sale price (before tax)', type: 'money' },
  { key: 'cost_price', label: 'Cost price', type: 'money' },
  { key: 'tax_rate', label: 'GST %', type: 'number', default: '18', step: '0.01' },
  { key: 'reorder_level', label: 'Reorder at', type: 'number', hint: 'Alert when stock falls to this' },
  { key: 'description', label: 'Description', type: 'textarea' },
  { key: 'active', label: 'Active', type: 'checkbox', default: true, hint: 'Inactive products stay in history but cannot be sold or bought.' },
];

export default function ProductsClient() {
  const { can } = useWorkspace();
  const [categories, setCategories] = useState(false);
  return (
    <>
      <ResourcePage
        title="Products"
        description="Everything you buy, make, stock or sell — one catalogue for Purchasing, Manufacturing, the till and the online store."
        endpoint="/erp/products"
        entity="product"
        permissions={{ create: 'erp.products.create', edit: 'erp.products.edit', delete: 'erp.products.delete' }}
        searchPlaceholder="Name, SKU or barcode…"
        headerActions={can('erp.products.edit') && <Button variant="secondary" icon={Tags} onClick={() => setCategories(true)}>Categories</Button>}
        emptyIcon={Package}
        emptyText="Add the products you sell or use. Stock arrives when you receive a purchase order or record a count."
        filters={[
          { key: 'type', label: 'Type', options: TYPES.map((t) => ({ value: t.value, label: titleCase(t.value) })) },
          { key: 'active', label: 'Status', options: [{ value: 'true', label: 'Active' }, { value: 'false', label: 'Archived' }] },
        ]}
        columns={[
          { key: 'name', label: 'Product', render: (r) => <div><p className="font-medium">{r.name}</p><p className="text-xs text-[var(--text-tertiary)]">{[r.sku, r.category_name].filter(Boolean).join(' · ') || '—'}</p></div> },
          { key: 'type', label: 'Type', render: (r) => <Badge size="sm" tone={r.type === 'stockable' ? 'brand' : 'neutral'}>{titleCase(r.type)}</Badge> },
          { key: 'sale_price', label: 'Price', align: 'right', numeric: true, format: 'money' },
          { key: 'cost_price', label: 'Cost', align: 'right', numeric: true, format: 'money' },
          {
            key: 'on_hand', label: 'On hand', align: 'right', numeric: true,
            render: (r) => (r.type === 'service' ? '—' : (
              <span className={Number(r.reorder_level) > 0 && Number(r.on_hand) <= Number(r.reorder_level) ? 'font-medium text-[var(--color-caution-600)]' : ''}>
                {Number(r.on_hand).toLocaleString('en-IN')} {r.uom}
              </span>
            )),
          },
          { key: 'active', label: '', render: (r) => (!r.active ? <Badge size="sm">Archived</Badge> : null) },
        ]}
        fields={PRODUCT_FIELDS}
        drawerWidth="lg"
        subtitleOf={(r) => [r.sku, r.category_name, titleCase(r.type)].filter(Boolean).join(' · ')}
        detail={(r) => (r.type === 'service' ? null : (
          <div className="space-y-5">
            <section>
              <h3 className="mb-2 text-sm font-medium text-[var(--text-secondary)]">Stock by warehouse</h3>
              <ul className="divide-y divide-[var(--border-subtle)] rounded-[var(--radius-lg)] border border-[var(--border-subtle)]">
                {r.stock?.map((s) => (
                  <li key={s.warehouse_id} className="flex justify-between px-3 py-2 text-sm">
                    <span>{s.warehouse_name}</span><span className="tabular">{Number(s.quantity).toLocaleString('en-IN')} {r.uom}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-[var(--text-tertiary)]">Value at cost: {money(Number(r.on_hand) * Number(r.cost_price))}</p>
            </section>
            <section>
              <h3 className="mb-2 text-sm font-medium text-[var(--text-secondary)]">Recent movements</h3>
              {!r.moves?.length ? <p className="text-sm text-[var(--text-tertiary)]">No movements yet.</p> : (
                <ul className="space-y-1.5 text-sm">
                  {r.moves.map((m) => (
                    <li key={m.id} className="flex gap-2">
                      <span className={m.to_warehouse_id && !m.from_warehouse_id ? 'w-16 tabular text-[var(--color-positive-600)]' : m.from_warehouse_id && !m.to_warehouse_id ? 'w-16 tabular text-[var(--color-critical-600)]' : 'w-16 tabular'}>
                        {m.to_warehouse_id && !m.from_warehouse_id ? '+' : m.from_warehouse_id && !m.to_warehouse_id ? '−' : '⇄'}{Number(m.quantity)}
                      </span>
                      <span className="flex-1">{titleCase(m.kind)}{m.reference ? ` · ${m.reference}` : ''}{m.note ? ` · ${m.note}` : ''}</span>
                      <span className="text-xs text-[var(--text-tertiary)]">{relativeTime(m.created_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        ))}
      />
      {categories && <CategoriesModal onClose={() => setCategories(false)} />}
    </>
  );
}

function CategoriesModal({ onClose }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [version, setVersion] = useState(0);
  const list = useOptions('/erp/categories', { limit: 100, _v: version });

  async function add(event) {
    event.preventDefault();
    try {
      await api.post('/erp/categories', { name });
      setName('');
      clearOptionCache();
      setVersion((v) => v + 1);
    } catch (err) {
      toast.error('Could not add', { description: err instanceof ApiError ? err.message : undefined });
    }
  }

  return (
    <Modal open onClose={onClose} title="Product categories" description="Group products for the till, the store and reports.">
      <form onSubmit={add} className="mb-4 flex gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New category" className="flex-1" data-autofocus />
        <Button type="submit" icon={Plus} disabled={!name.trim()}>Add</Button>
      </form>
      <ul className="divide-y divide-[var(--border-subtle)]">
        {list.map((c) => (
          <li key={c.id} className="flex justify-between py-2 text-sm"><span>{c.name}</span><span className="text-[var(--text-tertiary)]">{c.product_count} products</span></li>
        ))}
        {list.length === 0 && <li className="py-3 text-sm text-[var(--text-tertiary)]">No categories yet.</li>}
      </ul>
    </Modal>
  );
}
