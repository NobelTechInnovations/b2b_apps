'use client';

import { useEffect, useState } from 'react';
import { Save, Timer } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { minutesLabel, titleCase } from '@/lib/people';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Card, CardHeader, CardBody, CardFooter, PageHeader, Alert, Badge, Skeleton } from '@/components/ui/primitives';

const PRIORITY_TONE = { urgent: 'critical', high: 'caution', normal: 'brand', low: 'neutral' };
const UNITS = [{ value: 1, label: 'minutes' }, { value: 60, label: 'hours' }, { value: 1440, label: 'days' }];

// Show 240 as "4 hours" and 2880 as "2 days" rather than a wall of minutes.
const split = (minutes) => {
  const unit = [...UNITS].reverse().find((u) => minutes % u.value === 0) ?? UNITS[0];
  return { amount: String(minutes / unit.value), unit: unit.value };
};

export default function SlaClient() {
  const toast = useToast();
  const { can } = useWorkspace();
  const [rows, setRows] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const hydrate = (policies) => setRows(policies.map((p) => ({
    priority: p.priority,
    first: split(p.first_response_minutes),
    resolve: split(p.resolution_minutes),
  })));

  useEffect(() => {
    api.get('/helpdesk/sla').then((r) => hydrate(r.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load SLA policies.'));
  }, []);

  const editable = can('helpdesk.sla.manage');
  const setField = (index, key, part) => (e) => setRows((current) => current.map((row, i) => (
    i === index ? { ...row, [key]: { ...row[key], [part]: part === 'unit' ? Number(e.target.value) : e.target.value } } : row
  )));

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const policies = rows.map((row) => ({
        priority: row.priority,
        first_response_minutes: Math.round(Number(row.first.amount) * row.first.unit),
        resolution_minutes: Math.round(Number(row.resolve.amount) * row.resolve.unit),
      }));
      const response = await api.put('/helpdesk/sla', { policies });
      hydrate(response.data);
      toast.success('SLA targets saved', { description: 'New tickets use them straight away.' });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader
        title="SLA policies"
        description="How fast your team promises to reply and to resolve, by priority. Deadlines are set when a ticket opens and reset if its priority changes."
      />
      {error && <Alert tone="critical">{error}</Alert>}
      <Card>
        <CardHeader title="Targets" description="Clocks run around the clock — set targets your team can keep." />
        <CardBody>
          {!rows ? <Skeleton className="h-40 w-full" /> : (
            <div className="divide-y divide-[var(--border-subtle)]">
              {rows.map((row, index) => (
                <div key={row.priority} className="grid items-center gap-3 py-3 sm:grid-cols-[7rem_1fr_1fr]">
                  <Badge tone={PRIORITY_TONE[row.priority]} className="w-fit">{titleCase(row.priority)}</Badge>
                  {[['first', 'First reply within'], ['resolve', 'Resolve within']].map(([key, label]) => (
                    <div key={key}>
                      <p className="mb-1 text-xs text-[var(--text-tertiary)]">{label}</p>
                      <div className="flex gap-2">
                        <Input type="number" min="1" value={row[key].amount} onChange={setField(index, key, 'amount')} disabled={!editable} className="w-24" aria-label={`${label} (${row.priority})`} />
                        <Select value={row[key].unit} onChange={setField(index, key, 'unit')} disabled={!editable} className="w-auto" aria-label="Unit">
                          {UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
                        </Select>
                      </div>
                      <p className="mt-1 text-2xs text-[var(--text-tertiary)]">= {minutesLabel(Math.round(Number(row[key].amount || 0) * row[key].unit))}</p>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </CardBody>
        {editable && (
          <CardFooter>
            <Button variant="primary" icon={Save} onClick={save} loading={saving} disabled={!rows}>Save targets</Button>
          </CardFooter>
        )}
      </Card>
      <p className="flex items-center gap-1.5 text-xs text-[var(--text-tertiary)]">
        <Timer className="size-3.5" /> A ticket is “at risk” in the last quarter of its window, or its last hour.
      </p>
    </div>
  );
}
