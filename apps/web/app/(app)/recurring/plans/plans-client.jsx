'use client';

import { Layers } from 'lucide-react';
import { money } from '@/lib/format';
import { Badge } from '@/components/ui/primitives';
import { ResourcePage } from '@/components/data/resource-page';

const INTERVALS = [
  { value: 'monthly', label: 'Every month' }, { value: 'quarterly', label: 'Every quarter' },
  { value: 'half_yearly', label: 'Every six months' }, { value: 'yearly', label: 'Every year' },
];

export default function PlansClient() {
  return (
    <ResourcePage
      title="Plans"
      description="What you sell on a cycle — memberships, retainers, maintenance contracts, software seats."
      endpoint="/recurring/plans"
      entity="plan"
      permissions={{ create: 'recurring.plans.manage', edit: 'recurring.plans.manage', delete: 'recurring.plans.manage' }}
      emptyIcon={Layers}
      defaults={{ interval: 'monthly', tax_rate: '18', trial_days: '0' }}
      columns={[
        { key: 'name', label: 'Plan', render: (r) => <span className="font-medium">{r.name} {!r.active && <Badge size="sm">Archived</Badge>}</span> },
        { key: 'amount', label: 'Price', align: 'right', numeric: true, render: (r) => money(r.amount) },
        { key: 'interval', label: 'Billed', render: (r) => INTERVALS.find((i) => i.value === r.interval)?.label },
        { key: 'trial_days', label: 'Trial', render: (r) => (r.trial_days ? `${r.trial_days} days` : '—') },
        { key: 'subscribers', label: 'Subscribers', align: 'right', numeric: true },
      ]}
      fields={[
        { key: 'name', label: 'Name', required: true },
        { key: 'amount', label: 'Price before GST (₹)', type: 'money', required: true },
        { key: 'interval', label: 'Billed', type: 'select', required: true, options: INTERVALS },
        { key: 'trial_days', label: 'Free trial (days)', type: 'number' },
        { key: 'tax_rate', label: 'GST %', type: 'number', step: '0.01' },
        { key: 'hsn_sac', label: 'SAC code' },
        { key: 'description', label: 'Description', type: 'textarea' },
        { key: 'active', label: 'Available for new subscriptions', type: 'checkbox', default: true },
      ]}
    />
  );
}
