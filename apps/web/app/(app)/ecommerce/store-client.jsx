'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Store, ExternalLink, Copy, IndianRupee, ShoppingBag, Clock, Truck, Save } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { money } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';
import { useOrganization } from '@/lib/use-organization';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Checkbox } from '@/components/ui/input';
import { StatTile } from '@/components/data/stat-tile';
import { useOptions } from '@/components/data/resource-page';
import { Table, THead, TBody, TH, TR, TD, TableSkeleton } from '@/components/ui/table';
import { Badge, Card, CardHeader, CardBody, CardFooter, PageHeader, Alert } from '@/components/ui/primitives';

export default function StoreClient() {
  const toast = useToast();
  const { can } = useWorkspace();
  const organization = useOrganization();
  const warehouses = useOptions('/erp/warehouses');
  const [overview, setOverview] = useState(null);
  const [form, setForm] = useState(null);
  const [products, setProducts] = useState(null);
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [origin, setOrigin] = useState('');
  const manage = can('ecommerce.store.manage');

  useEffect(() => { setOrigin(window.location.origin); }, []);
  const loadOverview = useCallback(() => api.get('/ecommerce/overview').then((r) => {
    setOverview(r.data);
    const s = r.data.store;
    setForm((f) => f ?? {
      name: s.name || organization?.name || '', tagline: s.tagline, published: s.published, shipping_fee: String(Number(s.shipping_fee)),
      free_shipping_over: s.free_shipping_over === null ? '' : String(Number(s.free_shipping_over)), cod_enabled: s.cod_enabled,
      contact_email: s.contact_email ?? '', contact_phone: s.contact_phone ?? '', warehouse_id: s.warehouse_id ?? '',
    });
  }).catch(() => {}), [organization]);
  useEffect(() => { loadOverview(); }, [loadOverview]);
  useEffect(() => {
    const timer = setTimeout(() => api.get('/ecommerce/products', { query: { q: search || undefined } }).then((r) => setProducts(r.data)).catch(() => setProducts([])), search ? 250 : 0);
    return () => clearTimeout(timer);
  }, [search]);

  const url = organization?.slug && origin ? `${origin}/shop/${organization.slug}` : '';
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  async function save() {
    setSaving(true);
    try {
      await api.put('/ecommerce/settings', {
        name: form.name, tagline: form.tagline, published: form.published, shipping_fee: Number(form.shipping_fee || 0).toFixed(2),
        free_shipping_over: form.free_shipping_over === '' ? null : Number(form.free_shipping_over).toFixed(2), cod_enabled: form.cod_enabled,
        contact_email: form.contact_email || null, contact_phone: form.contact_phone || null, warehouse_id: form.warehouse_id || null,
      });
      toast.success(form.published ? 'Saved — your store is live' : 'Saved');
      loadOverview();
    } catch (err) {
      toast.error('Could not save', { description: err instanceof ApiError ? err.message : undefined });
    } finally {
      setSaving(false);
    }
  }

  async function toggle(product, online) {
    setProducts((list) => list.map((p) => (p.id === product.id ? { ...p, online } : p)));
    try {
      await api.put(`/ecommerce/products/${product.id}`, { online });
    } catch (err) {
      setProducts((list) => list.map((p) => (p.id === product.id ? { ...p, online: !online } : p)));
      toast.error('Could not update', { description: err instanceof ApiError ? err.message : undefined });
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Online store"
        description="A storefront selling the same products, prices and stock as the rest of your workspace. Orders arrive here; stock is taken when you confirm them."
        actions={url && overview?.store.published && (
          <div className="flex gap-2">
            <Button variant="secondary" icon={Copy} onClick={() => navigator.clipboard.writeText(url).then(() => toast.success('Store link copied'))}>Copy link</Button>
            <a href={url} target="_blank" rel="noreferrer"><Button variant="primary" icon={ExternalLink}>View store</Button></a>
          </div>
        )}
      />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Revenue this month" value={overview?.revenue_month} format="money" loading={!overview} icon={IndianRupee} tone="brand" />
        <StatTile label="Orders today" value={overview?.orders_today} loading={!overview} icon={ShoppingBag} />
        <StatTile label="Waiting to confirm" value={overview?.pending} loading={!overview} icon={Clock} tone={overview?.pending ? 'caution' : 'neutral'} hint={<Link href="/ecommerce/orders?status=pending" className="text-[var(--color-brand-600)]">Review</Link>} />
        <StatTile label="To ship" value={overview?.to_ship} loading={!overview} icon={Truck} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[26rem_1fr]">
        <Card>
          <CardHeader title="Store settings" description={url ? <span className="break-all">{url}</span> : undefined} />
          {form ? (
            <CardBody className="space-y-4">
              <Field label="Store name">{(p) => <Input {...p} value={form.name} onChange={set('name')} disabled={!manage} />}</Field>
              <Field label="Tagline">{(p) => <Input {...p} value={form.tagline} onChange={set('tagline')} disabled={!manage} placeholder="Handmade in Jaipur since 1998" />}</Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Shipping fee (₹)">{(p) => <Input {...p} type="number" min="0" value={form.shipping_fee} onChange={set('shipping_fee')} disabled={!manage} />}</Field>
                <Field label="Free shipping over (₹)">{(p) => <Input {...p} type="number" min="0" value={form.free_shipping_over} onChange={set('free_shipping_over')} disabled={!manage} placeholder="Never" />}</Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Contact phone">{(p) => <Input {...p} value={form.contact_phone} onChange={set('contact_phone')} disabled={!manage} />}</Field>
                <Field label="Contact email">{(p) => <Input {...p} type="email" value={form.contact_email} onChange={set('contact_email')} disabled={!manage} />}</Field>
              </div>
              <Field label="Ship from">{(p) => <Select {...p} value={form.warehouse_id} onChange={set('warehouse_id')} disabled={!manage}><option value="">Default warehouse</option>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>}</Field>
              <Checkbox label="Cash on delivery" description="Customers pay when the order arrives. Online payment can be added from Integrations." checked={form.cod_enabled} onChange={set('cod_enabled')} disabled={!manage} />
              <Checkbox label="Store is live" description="Anyone with the link can browse and order." checked={form.published} onChange={set('published')} disabled={!manage} />
            </CardBody>
          ) : <CardBody><TableSkeleton rows={4} columns={1} /></CardBody>}
          {manage && <CardFooter><Button variant="primary" icon={Save} loading={saving} onClick={save}>Save</Button></CardFooter>}
        </Card>

        <Card>
          <CardHeader title="Products on sale" description={`${overview?.online_products ?? 0} published · prices and stock come from Inventory`} action={<Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…" className="w-48" />} />
          <CardBody>
            {!products ? <TableSkeleton rows={5} columns={4} /> : products.length === 0 ? <Alert tone="info">Add products in Inventory first.</Alert> : (
              <Table>
                <THead><tr><TH>Product</TH><TH align="right">Price incl. GST</TH><TH align="right">In stock</TH><TH>Online</TH></tr></THead>
                <TBody>
                  {products.map((p) => (
                    <TR key={p.id}>
                      <TD className="font-medium">{p.name}<p className="text-xs font-normal text-[var(--text-tertiary)]">{p.category_name ?? ''}</p></TD>
                      <TD align="right" numeric>{money(Number(p.sale_price) * (1 + Number(p.tax_rate) / 100))}</TD>
                      <TD align="right" numeric className={Number(p.on_hand) <= 0 ? 'text-[var(--color-critical-600)]' : ''}>{Number(p.on_hand)}</TD>
                      <TD>{manage ? <input type="checkbox" checked={p.online} onChange={(e) => toggle(p, e.target.checked)} aria-label={`Sell ${p.name} online`} className="size-4" /> : p.online ? <Badge size="sm" tone="positive">Online</Badge> : '—'}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardBody>
        </Card>
      </div>
      {!overview?.store.published && overview && <Alert tone="info" icon={Store}>Your store is not live yet. Name it, publish some products, and tick “Store is live”.</Alert>}
    </div>
  );
}
