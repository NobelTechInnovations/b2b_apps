'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Wrench, CalendarClock } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { date } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';
import { titleCase } from '@/lib/people';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/primitives';
import { ResourcePage, renderValue } from '@/components/data/resource-page';

const STATUS = { tones: { operational: 'positive', down: 'critical', retired: 'neutral' } };
const overdue = (d) => d && new Date(d) < new Date(new Date().toISOString().slice(0, 10));

export default function EquipmentClient() {
  const toast = useToast();
  const { can } = useWorkspace();
  const [key, setKey] = useState(0);

  async function generate() {
    try {
      const r = await api.post('/maintenance/preventive/generate', { within_days: 7 });
      toast.success(r.data.created ? `${r.data.created} preventive request${r.data.created === 1 ? '' : 's'} raised` : 'Nothing is due in the next week');
      setKey((k) => k + 1);
    } catch (err) {
      toast.error('Could not raise requests', { description: err instanceof ApiError ? err.message : undefined });
    }
  }

  return (
    <ResourcePage
      key={key}
      title="Equipment"
      description="Your machines, when each is next due for service, and how much downtime they have cost this year."
      endpoint="/maintenance/equipment"
      entity="machine"
      permissions={{ create: 'maintenance.equipment.manage', edit: 'maintenance.equipment.manage', delete: 'maintenance.equipment.manage' }}
      searchPlaceholder="Name, code, serial or location…"
      emptyIcon={Wrench}
      emptyText="Add a machine with a service interval and preventive work is scheduled for you."
      headerActions={can('maintenance.requests.create') && <Button variant="secondary" icon={CalendarClock} onClick={generate}>Raise due preventive work</Button>}
      filters={[{ key: 'status', label: 'Status', options: ['operational', 'down', 'retired'].map((v) => ({ value: v, label: titleCase(v) })) }]}
      columns={[
        { key: 'name', label: 'Machine', render: (r) => <div><p className="font-medium">{r.name}</p><p className="text-xs text-[var(--text-tertiary)]">{[r.code, r.location].filter(Boolean).join(' · ') || '—'}</p></div> },
        { key: 'status', label: 'Status', format: STATUS },
        { key: 'next_due', label: 'Next service', render: (r) => (r.next_due ? <span className={overdue(r.next_due) ? 'font-medium text-[var(--color-critical-600)]' : ''}>{date(r.next_due)}</span> : '—') },
        { key: 'open_requests', label: 'Open requests', align: 'right', numeric: true },
        { key: 'downtime_year', label: 'Downtime (12 mo)', align: 'right', numeric: true, render: (r) => `${Number(r.downtime_year)} h` },
      ]}
      fields={[
        { key: 'name', label: 'Name', required: true },
        { key: 'code', label: 'Asset code' },
        { key: 'category', label: 'Category', placeholder: 'CNC, compressor, vehicle…' },
        { key: 'location', label: 'Location' },
        { key: 'serial_number', label: 'Serial number' },
        { key: 'work_center_id', label: 'Work center', type: 'relation', endpoint: '/manufacturing/work-centers' },
        { key: 'purchase_date', label: 'Bought on', type: 'date' },
        { key: 'warranty_until', label: 'Warranty until', type: 'date' },
        { key: 'preventive_every_days', label: 'Service every (days)', type: 'number', hint: 'Leave empty for no schedule' },
        { key: 'last_maintained_on', label: 'Last serviced', type: 'date' },
        { key: 'technician_id', label: 'Technician', type: 'person' },
        { key: 'status', label: 'Status', type: 'select', options: ['operational', 'down', 'retired'].map((v) => ({ value: v, label: titleCase(v) })), default: 'operational', required: true },
        { key: 'notes', label: 'Notes', type: 'textarea' },
      ]}
      subtitleOf={(r) => [r.code, r.category, r.location].filter(Boolean).join(' · ')}
      badgeOf={(r) => renderValue(r.status, STATUS)}
      detail={(r) => (
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-medium text-[var(--text-secondary)]">Service history</h3>
            <Link href={`/maintenance/requests?new=1&equipment=${r.id}`} className="text-sm text-[var(--color-brand-600)]">Report a problem</Link>
          </div>
          {!r.history?.length ? <p className="text-sm text-[var(--text-tertiary)]">No requests yet.</p> : (
            <ul className="divide-y divide-[var(--border-subtle)] text-sm">
              {r.history.map((h) => (
                <li key={h.id} className="flex items-center gap-2 py-2">
                  <Link href={`/maintenance/requests?open=${h.id}`} className="min-w-0 flex-1 truncate hover:underline">{h.number} · {h.title}</Link>
                  <Badge size="sm">{titleCase(h.status)}</Badge>
                  <span className="text-xs text-[var(--text-tertiary)]">{date(h.completed_at ?? h.created_at, 'short')}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    />
  );
}
