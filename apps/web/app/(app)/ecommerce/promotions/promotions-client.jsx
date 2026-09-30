'use client';

import { TicketPercent } from 'lucide-react';
import { money, date } from '@/lib/format';
import { Badge } from '@/components/ui/primitives';
import { ResourcePage } from '@/components/data/resource-page';

export default function PromotionsClient() {
  return (
    <ResourcePage
      title="Promotions"
      description="Discount codes for the online store. The discount lowers the taxable value, so GST is charged on what the customer actually pays."
      endpoint="/ecommerce/promotions"
      entity="promotion"
      permissions={{ create: 'ecommerce.promotions.manage', edit: 'ecommerce.promotions.manage', delete: 'ecommerce.promotions.manage' }}
      emptyIcon={TicketPercent}
      emptyText="Create a code like DIWALI10 and share it."
      titleOf={(r) => r.code}
      columns={[
        { key: 'code', label: 'Code', render: (r) => <span className="font-mono font-medium">{r.code}</span> },
        { key: 'value', label: 'Discount', render: (r) => (r.kind === 'percent' ? `${Number(r.value)}%` : money(r.value)) },
        { key: 'min_order', label: 'Min. order', render: (r) => (Number(r.min_order) ? money(r.min_order) : '—') },
        { key: 'window', label: 'Valid', render: (r) => (r.starts_on || r.ends_on ? `${r.starts_on ? date(r.starts_on, 'short') : '…'} – ${r.ends_on ? date(r.ends_on, 'short') : '…'}` : 'Always') },
        { key: 'used_count', label: 'Used', align: 'right', render: (r) => `${r.used_count}${r.usage_limit ? ` / ${r.usage_limit}` : ''}` },
        { key: 'active', label: '', render: (r) => (!r.active ? <Badge size="sm">Paused</Badge> : null) },
      ]}
      fields={[
        { key: 'code', label: 'Code', required: true, placeholder: 'DIWALI10', hint: 'Letters, numbers, - and _' },
        { key: 'kind', label: 'Type', type: 'select', required: true, default: 'percent', options: [{ value: 'percent', label: 'Percentage off' }, { value: 'amount', label: 'Rupees off' }] },
        { key: 'value', label: 'Value', type: 'money', required: true },
        { key: 'min_order', label: 'Minimum order (₹)', type: 'money' },
        { key: 'starts_on', label: 'Starts', type: 'date' },
        { key: 'ends_on', label: 'Ends', type: 'date' },
        { key: 'usage_limit', label: 'Total uses allowed', type: 'number', hint: 'Leave empty for unlimited' },
        { key: 'active', label: 'Active', type: 'checkbox', default: true },
      ]}
    />
  );
}
