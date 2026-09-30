'use client';

import { Factory } from 'lucide-react';
import { money } from '@/lib/format';
import { Badge } from '@/components/ui/primitives';
import { ResourcePage } from '@/components/data/resource-page';

export default function WorkCentersClient() {
  return (
    <ResourcePage
      title="Work centers"
      description="Where production happens — a line, a bench, a machine — and how many hours a day it can run. Planning measures load against this."
      endpoint="/manufacturing/work-centers"
      entity="work center"
      permissions={{ create: 'manufacturing.workcenters.manage', edit: 'manufacturing.workcenters.manage', delete: 'manufacturing.workcenters.manage' }}
      emptyIcon={Factory}
      columns={[
        { key: 'name', label: 'Work center', render: (r) => <span className="font-medium">{r.name}</span> },
        { key: 'code', label: 'Code' },
        { key: 'hours_per_day', label: 'Hours / day', align: 'right', numeric: true, format: 'number' },
        { key: 'cost_per_hour', label: 'Cost / hour', align: 'right', numeric: true, render: (r) => money(r.cost_per_hour) },
        { key: 'active_orders', label: 'Active orders', align: 'right', numeric: true },
        { key: 'active', label: '', render: (r) => (!r.active ? <Badge size="sm">Archived</Badge> : null) },
      ]}
      fields={[
        { key: 'name', label: 'Name', required: true },
        { key: 'code', label: 'Code' },
        { key: 'hours_per_day', label: 'Hours per day', type: 'number', default: '8', step: '0.5' },
        { key: 'cost_per_hour', label: 'Cost per hour', type: 'money' },
        { key: 'notes', label: 'Notes', type: 'textarea' },
        { key: 'active', label: 'Active', type: 'checkbox', default: true },
      ]}
    />
  );
}
