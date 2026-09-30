'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Boxes, Package, TriangleAlert, ShoppingCart, Plus, ArrowRight } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { Can } from '@/lib/workspace';
import { titleCase } from '@/lib/people';
import { Button } from '@/components/ui/button';
import { StatTile } from '@/components/data/stat-tile';
import { Card, CardHeader, CardBody, PageHeader, Alert, Badge } from '@/components/ui/primitives';

const MOVE_TONE = { receipt: 'positive', production_in: 'positive', adjustment_in: 'positive', pos_return: 'positive', online_return: 'positive' };

export default function OverviewClient() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get('/erp/overview').then((r) => setData(r.data)).catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load inventory.'));
  }, []);

  if (error) return <Alert tone="critical">{error}</Alert>;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Inventory & Purchasing"
        description="What you hold, what is running low, and what is on its way."
        actions={
          <div className="flex gap-2">
            <Can permission="erp.products.create"><Link href="/erp/products?new=1"><Button variant="secondary" icon={Plus}>New product</Button></Link></Can>
            <Can permission="erp.purchase.create"><Link href="/erp/purchase?new=1"><Button variant="primary" icon={ShoppingCart}>New purchase order</Button></Link></Can>
          </div>
        }
      />

      <div className="stagger grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Stock value" value={data?.stock_value} format="money" loading={!data} icon={Boxes} tone="brand" hint="At cost" />
        <StatTile label="Active products" value={data?.products} loading={!data} icon={Package} />
        <StatTile label="Low stock" value={data?.low_stock} loading={!data} icon={TriangleAlert} tone={data?.low_stock ? 'caution' : 'neutral'} hint="At or below reorder level" />
        <StatTile label="Open purchase orders" value={data?.open_pos} loading={!data} icon={ShoppingCart} hint={data ? `₹${Number(data.incoming_value).toLocaleString('en-IN')} on order` : undefined} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Running low" description="Reorder these before they run out" action={<Link href="/erp/stock?low=1" className="text-sm text-[var(--color-brand-600)]">All stock</Link>} />
          <CardBody>
            {data?.low_items.length === 0 && <p className="py-6 text-center text-sm text-[var(--text-tertiary)]">Nothing is below its reorder level.</p>}
            <ul className="divide-y divide-[var(--border-subtle)]">
              {(data?.low_items ?? []).map((p) => (
                <li key={p.id} className="flex items-center gap-3 py-2 text-sm">
                  <Link href={`/erp/products?open=${p.id}`} className="min-w-0 flex-1 truncate font-medium hover:underline">{p.name}</Link>
                  <span className="tabular text-[var(--color-caution-600)]">{Number(p.on_hand)} {p.uom}</span>
                  <span className="tabular text-xs text-[var(--text-tertiary)]">reorder at {Number(p.reorder_level)}</span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Recent stock movements" action={<Link href="/erp/stock?tab=moves" className="inline-flex items-center gap-1 text-sm text-[var(--color-brand-600)]">History <ArrowRight className="size-3.5" /></Link>} />
          <CardBody>
            {data?.recent_moves.length === 0 && <p className="py-6 text-center text-sm text-[var(--text-tertiary)]">No stock has moved yet. Receive a purchase order or count your stock to begin.</p>}
            <ul className="divide-y divide-[var(--border-subtle)]">
              {(data?.recent_moves ?? []).map((m) => (
                <li key={m.id} className="flex items-center gap-3 py-2 text-sm">
                  <Badge size="sm" tone={MOVE_TONE[m.kind] ?? 'neutral'}>{titleCase(m.kind)}</Badge>
                  <span className="min-w-0 flex-1 truncate">{m.product_name}</span>
                  <span className="tabular">{Number(m.quantity)} {m.uom}</span>
                  <span className="w-24 text-right text-xs text-[var(--text-tertiary)]">{relativeTime(m.created_at)}</span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
