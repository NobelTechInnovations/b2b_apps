'use client';

import Link from 'next/link';
import { MonitorSmartphone, ShoppingBasket } from 'lucide-react';
import { useWorkspace } from '@/lib/workspace';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/primitives';
import { ResourcePage } from '@/components/data/resource-page';

export default function RegistersClient() {
  const { can } = useWorkspace();
  return (
    <ResourcePage
      title="Registers"
      description="Each till and the warehouse it sells from. Open a till to start a shift; it keeps selling if the internet drops and syncs when it is back."
      endpoint="/pos/registers"
      entity="register"
      permissions={{ create: 'pos.registers.manage', edit: 'pos.registers.manage', delete: 'pos.registers.manage' }}
      emptyIcon={MonitorSmartphone}
      emptyText="Add a register for each counter."
      columns={[
        { key: 'name', label: 'Register', render: (r) => <span className="font-medium">{r.name}</span> },
        { key: 'warehouse_name', label: 'Sells from' },
        { key: 'open_session_id', label: 'Shift', render: (r) => (r.open_session_id ? <Badge size="sm" tone="positive" dot>Open</Badge> : <Badge size="sm">Closed</Badge>) },
        {
          key: 'till', label: '', align: 'right',
          render: (r) => (r.active && can('pos.sales.create') ? (
            <Link href={`/pos/till/${r.id}`} onClick={(e) => e.stopPropagation()}><Button size="sm" variant="primary" icon={ShoppingBasket}>Open till</Button></Link>
          ) : null),
        },
      ]}
      fields={[
        { key: 'name', label: 'Name', required: true, placeholder: 'Counter 1' },
        { key: 'warehouse_id', label: 'Sells from', type: 'relation', endpoint: '/erp/warehouses', emptyLabel: 'Default warehouse' },
        { key: 'receipt_footer', label: 'Receipt footer', type: 'textarea', default: 'Thank you for shopping with us!' },
        { key: 'active', label: 'Active', type: 'checkbox', default: true },
      ]}
      actions={(r) => r.active && can('pos.sales.create') && <Link href={`/pos/till/${r.id}`}><Button variant="primary" icon={ShoppingBasket}>Open till</Button></Link>}
    />
  );
}
