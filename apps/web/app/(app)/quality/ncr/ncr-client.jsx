'use client';

import { TriangleAlert } from 'lucide-react';
import { date } from '@/lib/format';
import { ResourcePage, renderValue } from '@/components/data/resource-page';

const STATUS = { tones: { open: 'critical', investigating: 'caution', resolved: 'brand', closed: 'positive' } };
const SEVERITY = { tones: { minor: 'neutral', major: 'caution', critical: 'critical' } };
const opts = (list) => list.map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }));

export default function NcrClient() {
  return (
    <ResourcePage
      title="Non-conformance"
      description="Every failed check or customer complaint, through root cause to corrective action. A report cannot be closed until the fix is written down."
      endpoint="/quality/ncr"
      entity="report"
      permissions={{ create: 'quality.ncr.create', edit: 'quality.ncr.create', delete: 'quality.ncr.close' }}
      emptyIcon={TriangleAlert}
      emptyText="Reports are opened automatically when a quality check fails, or by hand for a complaint."
      filters={[
        { key: 'status', label: 'Status', options: opts(['open', 'investigating', 'resolved', 'closed']) },
        { key: 'severity', label: 'Severity', options: opts(['minor', 'major', 'critical']) },
      ]}
      columns={[
        { key: 'number', label: 'Report', render: (r) => <div><p className="font-medium">{r.number}</p><p className="max-w-md truncate text-xs text-[var(--text-tertiary)]">{r.title}</p></div> },
        { key: 'product_name', label: 'Product' },
        { key: 'severity', label: 'Severity', format: SEVERITY },
        { key: 'status', label: 'Status', format: STATUS },
        { key: 'due_date', label: 'Due', render: (r) => (r.due_date ? date(r.due_date) : '—') },
      ]}
      fields={[
        { key: 'title', label: 'Title', required: true, full: true },
        { key: 'severity', label: 'Severity', type: 'select', options: opts(['minor', 'major', 'critical']), default: 'minor', required: true },
        { key: 'status', label: 'Status', type: 'select', options: opts(['open', 'investigating', 'resolved', 'closed']), default: 'open', required: true },
        { key: 'owner_id', label: 'Owner', type: 'person' },
        { key: 'due_date', label: 'Due by', type: 'date' },
        { key: 'description', label: 'What went wrong', type: 'textarea' },
        { key: 'root_cause', label: 'Root cause', type: 'textarea' },
        { key: 'corrective_action', label: 'Corrective action', type: 'textarea', hint: 'Required to close the report.' },
      ]}
      titleOf={(r) => `${r.number} · ${r.title}`}
      subtitleOf={(r) => [r.product_name, r.check_number && `from ${r.check_number}`].filter(Boolean).join(' · ')}
      badgeOf={(r) => renderValue(r.status, STATUS)}
    />
  );
}
