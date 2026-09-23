'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Plus, Fingerprint, Copy, Check, KeyRound, RefreshCw, Trash2, Power,
  Activity, AlertTriangle, ScanLine, Link2, Radio,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Can, useWorkspace } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select } from '@/components/ui/input';
import { Modal, ConfirmModal } from '@/components/ui/modal';
import { Table, THead, TBody, TH, TR, TD } from '@/components/ui/table';
import { StatTile } from '@/components/data/stat-tile';
import {
  Avatar, Badge, Card, EmptyState, PageHeader, Alert, Skeleton, Divider,
} from '@/components/ui/primitives';
import { date as fmtDate, relativeTime } from '@/lib/format';
import { cn } from '@/lib/cn';

const KINDS = [
  { value: 'biometric', label: 'Fingerprint' },
  { value: 'face', label: 'Face recognition' },
  { value: 'rfid', label: 'RFID / card' },
  { value: 'mobile', label: 'Mobile app' },
  { value: 'manual', label: 'Manual terminal' },
];

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export default function DevicesClient() {
  const toast = useToast();
  const { can } = useWorkspace();

  const [devices, setDevices] = useState([]);
  const [meta, setMeta] = useState({});
  const [punches, setPunches] = useState([]);
  const [identities, setIdentities] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('devices');

  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState(null);
  const [rotating, setRotating] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [enrolling, setEnrolling] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [d, p, i] = await Promise.all([
        api.get('/hr/devices'),
        api.get('/hr/punches', { query: { limit: 50 } }),
        api.get('/hr/devices/identities'),
      ]);
      setDevices(d.data);
      setMeta(d.meta ?? {});
      setPunches(p.data);
      setIdentities(i.data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load devices.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api.get('/hr/employees', { query: { status: 'active', limit: 100 } })
      .then((r) => setEmployees(r.data)).catch(() => setEmployees([]));
  }, []);

  async function create(form) {
    setBusy(true);
    try {
      const response = await api.post('/hr/devices', {
        name: form.name.trim(),
        location: form.location?.trim() || undefined,
        serial: form.serial?.trim() || undefined,
        kind: form.kind,
      });
      setCreating(false);
      // The plaintext key exists nowhere else, so it is shown immediately and
      // only once. Losing it means rotating, not recovering.
      setRevealed({ device: response.data, key: response.data.api_key, fresh: true });
      await load();
    } catch (err) {
      toast.error('Could not add that device', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  async function rotate() {
    setBusy(true);
    try {
      const response = await api.post(`/hr/devices/${rotating.id}/rotate-key`, {});
      setRotating(null);
      setRevealed({ device: response.data, key: response.data.api_key, rotated: true });
      await load();
    } catch (err) {
      toast.error('Could not rotate that key', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  async function toggle(device) {
    try {
      await api.patch(`/hr/devices/${device.id}`, {
        status: device.status === 'active' ? 'disabled' : 'active',
      });
      toast.success(`${device.name} ${device.status === 'active' ? 'disabled' : 'enabled'}`);
      await load();
    } catch (err) {
      toast.error('Could not change that device', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api.del(`/hr/devices/${deleting.id}`);
      toast.success(`${deleting.name} removed`, {
        description: 'Punches it already sent are kept.',
      });
      setDeleting(null);
      await load();
    } catch (err) {
      toast.error('Could not remove that device', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  const unmatched = useMemo(() => punches.filter((p) => p.status === 'unmatched'), [punches]);
  const online = devices.filter((d) => d.status === 'active').length;
  const todayPunches = devices.reduce((sum, d) => sum + (d.punches_today ?? 0), 0);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Attendance devices"
        description="Punch terminals send in and out times straight into attendance."
        actions={
          <Can permission="hr.devices.manage">
            <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>Add device</Button>
          </Can>
        }
      />

      {error && <Alert tone="critical">{error}</Alert>}

      {meta.unmatched_punches > 0 && (
        <Alert
          tone="caution"
          icon={AlertTriangle}
          title={`${meta.unmatched_punches} punch${meta.unmatched_punches === 1 ? '' : 'es'} could not be matched to anyone`}
          action={
            <Button variant="secondary" size="sm" onClick={() => setTab('enrolment')}>
              Map cards
            </Button>
          }
        >
          A terminal reported an id nobody is enrolled with. Map it to a person and the attendance is
          filled in retrospectively.
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Devices" value={devices.length} icon={Fingerprint} loading={loading} />
        <StatTile label="Active" value={online} icon={Radio} tone={online ? 'positive' : 'neutral'} loading={loading} />
        <StatTile label="Punches today" value={todayPunches} icon={Activity} loading={loading} />
        <StatTile
          label="Unmatched"
          value={meta.unmatched_punches ?? 0}
          icon={AlertTriangle}
          tone={meta.unmatched_punches ? 'caution' : 'neutral'}
          loading={loading}
        />
      </div>

      <div className="flex gap-1 border-b border-[var(--border-subtle)]">
        {[
          { key: 'devices', label: 'Terminals', icon: Fingerprint },
          { key: 'enrolment', label: 'Enrolment', icon: Link2, badge: meta.unmatched_punches },
          { key: 'log', label: 'Punch log', icon: ScanLine },
        ].map((item) => (
          <button
            key={item.key}
            onClick={() => setTab(item.key)}
            className={cn(
              'relative -mb-px flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors',
              tab === item.key
                ? 'border-b-2 border-[var(--color-brand-500)] text-[var(--text-primary)]'
                : 'border-b-2 border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
            )}
          >
            <item.icon className="size-4" />
            {item.label}
            {item.badge > 0 && <Badge tone="caution" size="sm">{item.badge}</Badge>}
          </button>
        ))}
      </div>

      {loading ? (
        <Skeleton className="h-64 w-full" />
      ) : tab === 'devices' ? (
        devices.length === 0 ? (
          <Card>
            <EmptyState
              icon={Fingerprint}
              title="No terminals connected"
              description="Add a device to get an endpoint and a key. Point your punch machine at them and attendance fills itself in."
              action={can('hr.devices.manage') && (
                <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>Add a device</Button>
              )}
            />
          </Card>
        ) : (
          <div className="stagger grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {devices.map((device) => (
              <Card key={device.id} className="panel-hover flex flex-col p-5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate text-md font-semibold">{device.name}</h3>
                    <p className="mt-0.5 truncate text-xs text-[var(--text-tertiary)]">
                      {device.location ?? 'No location'}
                      {device.serial && ` · ${device.serial}`}
                    </p>
                  </div>
                  <Badge tone={device.status === 'active' ? 'positive' : 'neutral'} size="sm" dot>
                    {device.status === 'active' ? 'Active' : 'Disabled'}
                  </Badge>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-xs text-[var(--text-secondary)]">Punches today</p>
                    <p className="metric mt-0.5 text-lg font-semibold tabular">{device.punches_today ?? 0}</p>
                  </div>
                  <div>
                    <p className="text-xs text-[var(--text-secondary)]">Last seen</p>
                    <p className="mt-0.5 truncate text-sm">
                      {device.last_seen_at ? relativeTime(device.last_seen_at) : 'never'}
                    </p>
                  </div>
                </div>

                <div className="mt-4 flex items-center gap-2 rounded-[var(--radius-md)] bg-[var(--surface-sunken)] px-3 py-2">
                  <KeyRound className="size-3.5 shrink-0 text-[var(--text-tertiary)]" />
                  <code className="truncate font-mono text-xs text-[var(--text-secondary)]">
                    {device.api_key_hint}
                  </code>
                  <span className="ml-auto text-2xs text-[var(--text-disabled)]">
                    {KINDS.find((k) => k.value === device.kind)?.label}
                  </span>
                </div>

                <Can permission="hr.devices.manage">
                  <div className="mt-auto flex gap-1 border-t border-[var(--border-subtle)] pt-3">
                    <Button variant="ghost" size="sm" icon={RefreshCw} onClick={() => setRotating(device)}>
                      Rotate key
                    </Button>
                    <Button variant="ghost" size="sm" icon={Power} onClick={() => toggle(device)}>
                      {device.status === 'active' ? 'Disable' : 'Enable'}
                    </Button>
                    <div className="flex-1" />
                    <Button variant="danger-ghost" size="sm" icon={Trash2} onClick={() => setDeleting(device)} />
                  </div>
                </Can>
              </Card>
            ))}
          </div>
        )
      ) : tab === 'enrolment' ? (
        <EnrolmentPanel
          identities={identities}
          unmatched={unmatched}
          employees={employees}
          can={can}
          onEnrol={setEnrolling}
          onReload={load}
        />
      ) : (
        <PunchLog punches={punches} />
      )}

      {creating && (
        <DeviceForm busy={busy} onClose={() => setCreating(false)} onSave={create} />
      )}

      {revealed && (
        <KeyReveal
          reveal={revealed}
          endpoint={`${API_BASE}/api${meta.endpoint ?? '/device-sync/punches'}`}
          onClose={() => setRevealed(null)}
        />
      )}

      {enrolling && (
        <EnrolModal
          ref_={enrolling}
          employees={employees}
          onClose={() => setEnrolling(null)}
          onDone={async () => { setEnrolling(null); await load(); }}
        />
      )}

      <ConfirmModal
        open={Boolean(rotating)}
        onClose={() => setRotating(null)}
        onConfirm={rotate}
        title={`Rotate the key for ${rotating?.name}?`}
        description="The current key stops working immediately. The terminal will need reconfiguring before it can send again."
        confirmLabel="Rotate key"
        danger
        loading={busy}
      />

      <ConfirmModal
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={remove}
        title={`Remove ${deleting?.name}?`}
        description="Punches it already sent are kept, so attendance stays explainable. The key stops working."
        confirmLabel="Remove device"
        danger
        loading={busy}
      />
    </div>
  );
}

/* ── add a terminal ─────────────────────────────────────────────────────── */
function DeviceForm({ busy, onClose, onSave }) {
  const [form, setForm] = useState({ name: '', location: '', serial: '', kind: 'biometric' });
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  return (
    <Modal
      open
      onClose={onClose}
      title="Add an attendance device"
      description="You will get an endpoint and a key to configure on the terminal."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => onSave(form)} disabled={!form.name.trim()} loading={busy}>
            Add device
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" required className="sm:col-span-2">
          <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Main gate terminal" autoFocus />
        </Field>
        <Field label="Location">
          <Input value={form.location} onChange={(e) => set('location', e.target.value)} placeholder="Factory entrance" />
        </Field>
        <Field label="Serial number">
          <Input value={form.serial} onChange={(e) => set('serial', e.target.value)} placeholder="ZK-4500-112" />
        </Field>
        <Field label="Type" className="sm:col-span-2">
          <Select value={form.kind} onChange={(e) => set('kind', e.target.value)}>
            {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

/* ── the one time the key is visible ────────────────────────────────────── */
function KeyReveal({ reveal, endpoint, onClose }) {
  const [copied, setCopied] = useState(null);

  const copy = async (value, what) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      setCopied(null);
    }
  };

  const sample = `curl -X POST ${endpoint} \\
  -H 'content-type: application/json' \\
  -H 'x-device-key: ${reveal.key}' \\
  -d '{"punches":[{"employee_ref":"EMP-001","punched_at":"${new Date().toISOString()}","direction":"in"}]}'`;

  return (
    <Modal
      open
      onClose={onClose}
      title={reveal.rotated ? 'New key issued' : `${reveal.device.name} is ready`}
      description="Copy the key now — it is stored only as a hash and cannot be shown again."
      size="lg"
      footer={<Button variant="primary" onClick={onClose}>Done</Button>}
    >
      <div className="space-y-4">
        <Alert tone="caution" icon={KeyRound}>
          This is the only time this key will be displayed. If it is lost, rotate it and reconfigure the terminal.
        </Alert>

        <Field label="Endpoint">
          <div className="flex gap-2">
            <Input readOnly value={endpoint} className="font-mono text-xs" />
            <Button
              variant="secondary"
              icon={copied === 'endpoint' ? Check : Copy}
              onClick={() => copy(endpoint, 'endpoint')}
            />
          </div>
        </Field>

        <Field label="Device key">
          <div className="flex gap-2">
            <Input readOnly value={reveal.key} className="font-mono text-xs" />
            <Button
              variant="secondary"
              icon={copied === 'key' ? Check : Copy}
              onClick={() => copy(reveal.key, 'key')}
            />
          </div>
        </Field>

        <Divider label="Sending a punch" />

        <div className="relative">
          <pre className="max-h-48 overflow-auto rounded-[var(--radius-lg)] bg-[var(--surface-sunken)] p-3 font-mono text-2xs leading-relaxed text-[var(--text-secondary)]">
            {sample}
          </pre>
          <Button
            variant="ghost"
            size="sm"
            icon={copied === 'curl' ? Check : Copy}
            className="absolute right-2 top-2"
            onClick={() => copy(sample, 'curl')}
          />
        </div>

        <p className="text-xs text-[var(--text-secondary)]">
          <code className="font-mono">employee_ref</code> is whatever the terminal knows a person by —
          their employee code works out of the box; any other id can be mapped under Enrolment.
          Replaying the same punch is safe: duplicates are ignored, not double-counted.
        </p>
      </div>
    </Modal>
  );
}

/* ── mapping device ids to people ───────────────────────────────────────── */
function EnrolmentPanel({ identities, unmatched, employees, can, onEnrol, onReload }) {
  const toast = useToast();

  const unmatchedRefs = useMemo(() => {
    const seen = new Map();
    for (const punch of unmatched) {
      const entry = seen.get(punch.employee_ref) ?? { ref: punch.employee_ref, count: 0, last: null };
      entry.count += 1;
      if (!entry.last || punch.punched_at > entry.last) entry.last = punch.punched_at;
      seen.set(punch.employee_ref, entry);
    }
    return [...seen.values()];
  }, [unmatched]);

  async function unmap(ref) {
    try {
      await api.del(`/hr/devices/identities/${encodeURIComponent(ref)}`);
      toast.success(`${ref} unmapped`);
      await onReload();
    } catch (err) {
      toast.error('Could not unmap that id', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    }
  }

  return (
    <div className="space-y-5">
      {unmatchedRefs.length > 0 && (
        <Card>
          <div className="border-b border-[var(--border-subtle)] px-5 py-3">
            <h3 className="text-md font-semibold">Waiting to be mapped</h3>
            <p className="mt-0.5 text-sm text-[var(--text-secondary)]">
              Ids a terminal reported that nobody is enrolled with. Mapping one adopts every punch it
              already sent.
            </p>
          </div>
          <Table>
            <THead>
              <tr>
                <TH>Device id</TH>
                <TH>Punches</TH>
                <TH>Last seen</TH>
                <TH align="right">{''}</TH>
              </tr>
            </THead>
            <TBody>
              {unmatchedRefs.map((row) => (
                <TR key={row.ref}>
                  <TD><code className="font-mono text-sm">{row.ref}</code></TD>
                  <TD align="right" numeric>{row.count}</TD>
                  <TD className="text-[var(--text-tertiary)]">{relativeTime(row.last)}</TD>
                  <TD align="right">
                    {can('hr.devices.manage') && (
                      <Button variant="secondary" size="sm" icon={Link2} onClick={() => onEnrol(row.ref)}>
                        Map to a person
                      </Button>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}

      <Card>
        <div className="flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-5 py-3">
          <div>
            <h3 className="text-md font-semibold">Enrolled ids</h3>
            <p className="mt-0.5 text-sm text-[var(--text-secondary)]">
              Card numbers, finger ids and anything else a terminal uses.
            </p>
          </div>
          {can('hr.devices.manage') && (
            <Button variant="secondary" size="sm" icon={Plus} onClick={() => onEnrol('')}>
              Enrol an id
            </Button>
          )}
        </div>

        {identities.length === 0 ? (
          <EmptyState
            icon={Link2}
            title="Nothing mapped yet"
            description="Terminals configured with employee codes need no mapping at all — this is for card numbers and finger ids."
          />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Device id</TH>
                <TH>Person</TH>
                <TH>Mapped</TH>
                <TH align="right">{''}</TH>
              </tr>
            </THead>
            <TBody>
              {identities.map((row) => (
                <TR key={row.employee_ref}>
                  <TD><code className="font-mono text-sm">{row.employee_ref}</code></TD>
                  <TD>
                    <div className="flex items-center gap-2">
                      <Avatar name={row.name} size="xs" />
                      <span className="font-medium">{row.name}</span>
                      <span className="text-xs text-[var(--text-tertiary)]">{row.employee_code}</span>
                    </div>
                  </TD>
                  <TD className="text-[var(--text-tertiary)]">{fmtDate(row.created_at)}</TD>
                  <TD align="right">
                    {can('hr.devices.manage') && (
                      <Button variant="danger-ghost" size="sm" icon={Trash2} onClick={() => unmap(row.employee_ref)} />
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function EnrolModal({ ref_, employees, onClose, onDone }) {
  const toast = useToast();
  const [reference, setReference] = useState(ref_ ?? '');
  const [employeeId, setEmployeeId] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const response = await api.post('/hr/devices/identities', {
        employee_ref: reference.trim(),
        employee_id: employeeId,
      });
      toast.success('Id mapped', {
        description: response.data.punches
          ? `${response.data.punches} earlier punch${response.data.punches === 1 ? '' : 'es'} adopted across ${response.data.days} ${response.data.days === 1 ? 'day' : 'days'}.`
          : undefined,
      });
      await onDone();
    } catch (err) {
      toast.error('Could not map that id', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Map a device id to a person"
      description="Punches that already arrived under this id are adopted and their attendance is rebuilt."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={!reference.trim() || !employeeId} loading={busy}>
            Map id
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Device id" required hint="The card number or finger id the terminal reports">
          <Input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="CARD-0042"
            className="font-mono"
            autoFocus={!ref_}
          />
        </Field>
        <Field label="Person" required>
          <Select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">Choose a person…</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name ?? `${e.first_name} ${e.last_name ?? ''}`.trim()} · {e.employee_code}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

/* ── raw punches ────────────────────────────────────────────────────────── */
function PunchLog({ punches }) {
  if (!punches.length) {
    return (
      <Card>
        <EmptyState
          icon={ScanLine}
          title="No punches yet"
          description="Once a terminal is configured, every in and out lands here before it becomes attendance."
        />
      </Card>
    );
  }

  const TONE = { matched: 'positive', unmatched: 'caution', duplicate: 'neutral', ignored: 'neutral' };

  return (
    <Card>
      <div className="border-b border-[var(--border-subtle)] px-5 py-3">
        <h3 className="text-md font-semibold">Punch log</h3>
        <p className="mt-0.5 text-sm text-[var(--text-secondary)]">
          Raw events exactly as the terminals sent them. Attendance is derived from these and can be
          rebuilt from them at any time.
        </p>
      </div>
      <Table>
        <THead>
          <tr>
            <TH>When</TH>
            <TH>Person</TH>
            <TH>Device id</TH>
            <TH>Direction</TH>
            <TH>Terminal</TH>
            <TH>Status</TH>
          </tr>
        </THead>
        <TBody>
          {punches.map((punch) => (
            <TR key={punch.id}>
              <TD className="tabular whitespace-nowrap">{fmtDate(punch.punched_at, 'datetime')}</TD>
              <TD>
                {punch.name ? (
                  <div className="flex items-center gap-2">
                    <Avatar name={punch.name} size="xs" />
                    <span className="truncate">{punch.name}</span>
                  </div>
                ) : (
                  <span className="text-[var(--text-tertiary)]">unmatched</span>
                )}
              </TD>
              <TD><code className="font-mono text-xs">{punch.employee_ref}</code></TD>
              <TD>
                {punch.direction ? (
                  <Badge tone={punch.direction === 'in' ? 'info' : 'neutral'} size="sm">
                    {punch.direction}
                  </Badge>
                ) : (
                  <span className="text-[var(--text-tertiary)]">—</span>
                )}
              </TD>
              <TD className="text-[var(--text-secondary)]">{punch.device_name ?? '—'}</TD>
              <TD><Badge tone={TONE[punch.status]} size="sm">{punch.status}</Badge></TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </Card>
  );
}
