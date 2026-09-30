'use client';

import { ListChecks } from 'lucide-react';
import { Badge } from '@/components/ui/primitives';
import { ResourcePage } from '@/components/data/resource-page';

const TRIGGERS = [
  { value: 'receipt', label: 'When goods are received' },
  { value: 'production', label: 'When a batch is finished' },
  { value: 'manual', label: 'Only when started by hand' },
];

export default function PlansClient() {
  return (
    <ResourcePage
      title="Inspection plans"
      description="What to check, and when. A plan can cover one product, a whole category, or everything."
      endpoint="/quality/plans"
      entity="plan"
      permissions={{ create: 'quality.plans.manage', edit: 'quality.plans.manage', delete: 'quality.plans.manage' }}
      emptyIcon={ListChecks}
      emptyText="Create a plan such as “Incoming fabric: colour, GSM, defects” and receipts will raise checks for it."
      columns={[
        { key: 'name', label: 'Plan', render: (r) => <span className="font-medium">{r.name}</span> },
        { key: 'trigger', label: 'Runs', render: (r) => TRIGGERS.find((t) => t.value === r.trigger)?.label },
        { key: 'scope', label: 'Applies to', render: (r) => r.product_name ?? (r.category_name ? `Category: ${r.category_name}` : 'Every product') },
        { key: 'checklist', label: 'Checkpoints', align: 'right', render: (r) => r.checklist.length },
        { key: 'active', label: '', render: (r) => (!r.active ? <Badge size="sm">Paused</Badge> : null) },
      ]}
      fields={[
        { key: 'name', label: 'Name', required: true, full: true },
        { key: 'trigger', label: 'Runs', type: 'select', options: TRIGGERS, default: 'receipt', required: true },
        { key: 'product_id', label: 'Only this product', type: 'relation', endpoint: '/erp/products', query: { active: true, limit: 100 } },
        { key: 'category_id', label: 'Or this category', type: 'relation', endpoint: '/erp/categories' },
        { key: 'checklist', label: 'Checkpoints', type: 'checklist', placeholder: 'e.g. Colour matches the sample' },
        { key: 'active', label: 'Active', type: 'checkbox', default: true },
      ]}
    />
  );
}
