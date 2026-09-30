'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Wrench, Play, CheckCircle2, XCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { date, relativeTime } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';
import { titleCase } from '@/lib/people';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Textarea, Checkbox } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { ResourcePage, renderValue } from '@/components/data/resource-page';
import { LineItems } from '@/components/data/line-items';

const STATUS = { tones: { new: 'info', in_progress: 'caution', repaired: 'positive', scrapped: 'critical', cancelled: 'neutral' } };
const PRIORITY = { tones: { urgent: 'critical', high: 'caution', normal: 'brand', low: 'neutral' } };
const opts = (list) => list.map((v) => ({ value: v, label: titleCase(v) }));

export default function RequestsClient() {
  const params = useSearchParams();
  const { can } = useWorkspace();
  return (
    <ResourcePage
      title="Maintenance requests"
      description="Breakdowns and scheduled service. Close a request with what was done and the spare parts used — they come out of stock."
      endpoint="/maintenance/requests"
      entity="request"
      permissions={{ create: 'maintenance.requests.create', edit: 'maintenance.requests.create', delete: 'maintenance.requests.close' }}
      defaults={{ equipment_id: params.get('equipment') ?? '', kind: 'corrective', priority: 'normal' }}
      emptyIcon={Wrench}
      emptyText="Report a breakdown, or raise preventive work from the equipment list."
      filters={[
        { key: 'status', label: 'Status', options: opts(['new', 'in_progress', 'repaired', 'scrapped', 'cancelled']) },
        { key: 'kind', label: 'Type', options: opts(['corrective', 'preventive']) },
      ]}
      columns={[
        { key: 'number', label: 'Request', render: (r) => <div><p className="font-medium">{r.number} · {r.title}</p><p className="text-xs text-[var(--text-tertiary)]">{r.equipment_name}{r.equipment_location ? ` · ${r.equipment_location}` : ''}</p></div> },
        { key: 'kind', label: 'Type', format: 'label' },
        { key: 'priority', label: 'Priority', format: PRIORITY },
        { key: 'status', label: 'Status', format: STATUS },
        { key: 'scheduled_for', label: 'Scheduled', render: (r) => (r.scheduled_for ? date(r.scheduled_for) : '—') },
        { key: 'created_at', label: 'Raised', render: (r) => relativeTime(r.created_at) },
      ]}
      fields={[
        { key: 'equipment_id', label: 'Machine', type: 'relation', endpoint: '/maintenance/equipment', required: true, createOnly: true, full: true },
        { key: 'title', label: 'What is wrong / what is due', required: true, full: true },
        { key: 'kind', label: 'Type', type: 'select', options: opts(['corrective', 'preventive']), required: true },
        { key: 'priority', label: 'Priority', type: 'select', options: opts(['low', 'normal', 'high', 'urgent']), required: true },
        { key: 'assignee_id', label: 'Technician', type: 'person' },
        { key: 'scheduled_for', label: 'Scheduled for', type: 'date' },
        { key: 'description', label: 'Details', type: 'textarea' },
      ]}
      titleOf={(r) => `${r.number} · ${r.title}`}
      subtitleOf={(r) => `${r.equipment_name} · ${titleCase(r.kind)} · ${titleCase(r.priority)} priority`}
      badgeOf={(r) => renderValue(r.status, STATUS)}
      detailItems={(r) => [
        { label: 'Machine', value: r.equipment_name },
        { label: 'Scheduled', value: r.scheduled_for ? date(r.scheduled_for) : null },
        { label: 'Started', value: r.started_at ? relativeTime(r.started_at) : null },
        { label: 'Completed', value: r.completed_at ? relativeTime(r.completed_at) : null },
        { label: 'Downtime', value: Number(r.downtime_hours) ? `${Number(r.downtime_hours)} hours` : null },
        { label: 'Details', value: r.description || null, full: true },
        { label: 'What was done', value: r.resolution || null, full: true },
        { label: 'Parts used', value: r.parts?.length ? r.parts.map((p) => `${p.name} × ${p.quantity}`).join(', ') : null, full: true },
      ]}
      actions={(r, { act, busy }) => (
        ['new', 'in_progress'].includes(r.status) && (
          <>
            {can('maintenance.requests.close') && <Button variant="ghost" icon={XCircle} disabled={busy} onClick={() => act(() => api.post(`/maintenance/requests/${r.id}/cancel`, {}), 'Request cancelled')}>Cancel</Button>}
            {r.status === 'new' && can('maintenance.requests.create') && <StartButton request={r} act={act} busy={busy} />}
            {can('maintenance.requests.close') && <CompleteButton request={r} act={act} busy={busy} />}
          </>
        )
      )}
    />
  );
}

function StartButton({ request, act, busy }) {
  const [open, setOpen] = useState(false);
  const [down, setDown] = useState(request.kind === 'corrective');
  return (
    <>
      <Button variant="secondary" icon={Play} disabled={busy} onClick={() => setOpen(true)}>Start</Button>
      {open && (
        <Modal open onClose={() => setOpen(false)} title="Start work" size="sm"
          footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" onClick={() => { setOpen(false); act(() => api.post(`/maintenance/requests/${request.id}/start`, { equipment_down: down }), 'Work started'); }}>Start</Button></>}>
          <Checkbox label={`${request.equipment_name} is down`} description="Shows the machine as not available until the request is closed." checked={down} onChange={(e) => setDown(e.target.checked)} />
        </Modal>
      )}
    </>
  );
}

function CompleteButton({ request, act, busy }) {
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState('repaired');
  const [resolution, setResolution] = useState('');
  const [downtime, setDowntime] = useState('');
  const [parts, setParts] = useState([]);
  const submit = () => {
    setOpen(false);
    act(() => api.post(`/maintenance/requests/${request.id}/complete`, {
      outcome, resolution, downtime_hours: downtime ? Number(downtime) : undefined,
      parts: parts.filter((p) => p.product_id && Number(p.quantity) > 0).map((p) => ({ product_id: p.product_id, quantity: Number(p.quantity) })),
    }), outcome === 'repaired' ? 'Closed — machine back in service' : 'Closed — machine retired');
  };
  return (
    <>
      <Button variant="primary" icon={CheckCircle2} disabled={busy} onClick={() => setOpen(true)}>Complete</Button>
      {open && (
        <Modal open onClose={() => setOpen(false)} title={`Close ${request.number}`} size="xl"
          footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" disabled={!resolution.trim()} onClick={submit}>Close request</Button></>}>
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Outcome">{(p) => <Select {...p} value={outcome} onChange={(e) => setOutcome(e.target.value)}><option value="repaired">Repaired — back in service</option><option value="scrapped">Beyond repair — retire it</option></Select>}</Field>
              <Field label="Downtime (hours)">{(p) => <Input {...p} type="number" min="0" step="0.25" value={downtime} onChange={(e) => setDowntime(e.target.value)} />}</Field>
            </div>
            <Field label="What was done" required>{(p) => <Textarea {...p} rows={3} value={resolution} onChange={(e) => setResolution(e.target.value)} data-autofocus />}</Field>
            <div>
              <p className="mb-2 text-sm font-medium">Spare parts used <span className="font-normal text-[var(--text-tertiary)]">(taken out of the default warehouse)</span></p>
              <LineItems lines={parts} onChange={setParts} showPrice={false} showTax={false} minLines={0} />
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
