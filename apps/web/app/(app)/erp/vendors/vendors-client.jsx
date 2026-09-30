'use client';

import { Truck } from 'lucide-react';
import { money } from '@/lib/format';
import { Badge } from '@/components/ui/primitives';
import { ResourcePage } from '@/components/data/resource-page';

export default function VendorsClient() {
  return (
    <ResourcePage
      title="Vendors"
      description="Who you buy from, their GSTIN and payment terms. Purchase orders pick from this list."
      endpoint="/erp/vendors"
      entity="vendor"
      permissions={{ create: 'erp.vendors.manage', edit: 'erp.vendors.manage', delete: 'erp.vendors.manage' }}
      searchPlaceholder="Name, contact, phone or GSTIN…"
      emptyIcon={Truck}
      emptyText="Add your suppliers to start raising purchase orders."
      filters={[{ key: 'active', label: 'Status', options: [{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }] }]}
      columns={[
        { key: 'name', label: 'Vendor', render: (r) => <div><p className="font-medium">{r.name}</p><p className="text-xs text-[var(--text-tertiary)]">{r.contact_name ?? r.email ?? '—'}</p></div> },
        { key: 'phone', label: 'Phone' },
        { key: 'gstin', label: 'GSTIN' },
        { key: 'payment_terms_days', label: 'Terms', render: (r) => `${r.payment_terms_days} days` },
        { key: 'order_count', label: 'Orders', align: 'right', numeric: true },
        { key: 'total_ordered', label: 'Bought', align: 'right', numeric: true, render: (r) => money(r.total_ordered) },
        { key: 'active', label: '', render: (r) => (!r.active ? <Badge size="sm">Inactive</Badge> : null) },
      ]}
      fields={[
        { key: 'name', label: 'Name', required: true, full: true },
        { key: 'contact_name', label: 'Contact person' },
        { key: 'phone', label: 'Phone' },
        { key: 'email', label: 'Email', type: 'email' },
        { key: 'gstin', label: 'GSTIN', placeholder: '07AABCS1429B1Z5' },
        { key: 'payment_terms_days', label: 'Payment terms (days)', type: 'number', default: '30' },
        { key: 'address', label: 'Address', type: 'textarea' },
        { key: 'notes', label: 'Notes', type: 'textarea' },
        { key: 'active', label: 'Active', type: 'checkbox', default: true },
      ]}
      subtitleOf={(r) => [r.contact_name, r.phone].filter(Boolean).join(' · ')}
    />
  );
}
