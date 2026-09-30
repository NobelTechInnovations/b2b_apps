'use client';

import { Building2 } from 'lucide-react';
import { money } from '@/lib/format';
import { Badge } from '@/components/ui/primitives';
import { ResourcePage } from '@/components/data/resource-page';

export default function WarehousesClient() {
  return (
    <ResourcePage
      title="Warehouses"
      description="Every place stock is kept — a godown, a shop floor, a van. The default warehouse receives purchases unless an order says otherwise."
      endpoint="/erp/warehouses"
      entity="warehouse"
      permissions={{ create: 'erp.warehouses.manage', edit: 'erp.warehouses.manage', delete: 'erp.warehouses.manage' }}
      emptyIcon={Building2}
      columns={[
        { key: 'name', label: 'Warehouse', render: (r) => <span className="font-medium">{r.name} {r.is_default && <Badge size="sm" tone="brand">Default</Badge>}</span> },
        { key: 'code', label: 'Code' },
        { key: 'address', label: 'Address' },
        { key: 'stock_value', label: 'Stock value', align: 'right', numeric: true, render: (r) => money(r.stock_value) },
        { key: 'active', label: '', render: (r) => (!r.active ? <Badge size="sm">Archived</Badge> : null) },
      ]}
      fields={[
        { key: 'name', label: 'Name', required: true },
        { key: 'code', label: 'Short code', required: true, placeholder: 'SHOP' },
        { key: 'address', label: 'Address', type: 'textarea' },
        { key: 'active', label: 'Active', type: 'checkbox', default: true },
      ]}
    />
  );
}
