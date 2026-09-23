'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Plus, Scale, Users, Pencil, Wallet, Percent, Settings2, History,
  TrendingUp, ShieldCheck, Landmark, ChevronRight,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Can, useWorkspace } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Textarea, Checkbox } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Table, THead, TBody, TH, TR, TD } from '@/components/ui/table';
import { Drawer } from '@/components/data/drawer';
import { StatTile } from '@/components/data/stat-tile';
import {
  Avatar, Badge, Card, EmptyState, PageHeader, Alert, Skeleton, Divider,
} from '@/components/ui/primitives';
import { money, percent as pct, date as fmtDate } from '@/lib/format';
import { cn } from '@/lib/cn';

const PT_STATES = [
  { value: 'MH', label: 'Maharashtra' },
  { value: 'KA', label: 'Karnataka' },
  { value: 'WB', label: 'West Bengal' },
  { value: 'TN', label: 'Tamil Nadu' },
  { value: 'TS', label: 'Telangana' },
  { value: 'GJ', label: 'Gujarat' },
  { value: 'NONE', label: 'Not levied in our state' },
];

const DAYS_BASIS = [
  { value: 'calendar', label: 'Days in the month' },
  { value: 'fixed_26', label: 'Fixed 26 days' },
  { value: 'working', label: 'Scheduled working days' },
];

export default function StructuresClient() {
  const toast = useToast();
  const { can } = useWorkspace();

  const [structures, setStructures] = useState([]);
  const [salaries, setSalaries] = useState([]);
  const [meta, setMeta] = useState({});
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('people');

  const [editingSalary, setEditingSalary] = useState(null);
  const [openStructure, setOpenStructure] = useState(null);
  const [openHistory, setOpenHistory] = useState(null);
  const [editingSettings, setEditingSettings] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [s, sal, set] = await Promise.all([
        api.get('/payroll/structures'),
        api.get('/payroll/salaries'),
        api.get('/payroll/settings'),
      ]);
      setStructures(s.data);
      setSalaries(sal.data);
      setMeta(sal.meta ?? {});
      setSettings(set.data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load salary settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Salary structures"
        description="What a salary is made of, and what each person earns."
        actions={
          <Can permission="payroll.structures.manage">
            <Button variant="secondary" icon={Settings2} onClick={() => setEditingSettings(true)}>
              Statutory settings
            </Button>
          </Can>
        }
      />

      {error && <Alert tone="critical">{error}</Alert>}

      {!loading && meta.not_on_payroll > 0 && (
        <Alert tone="info" icon={Wallet} title={`${meta.not_on_payroll} ${meta.not_on_payroll === 1 ? 'person has' : 'people have'} no salary recorded`}>
          They will be skipped by a payroll run — by name, so nobody goes missing quietly.
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="On payroll" value={meta.on_payroll} icon={Users} loading={loading} />
        <StatTile label="Monthly gross" value={meta.monthly_gross_total} format="money" icon={Wallet} tone="brand" loading={loading} />
        <StatTile label="Annual gross" value={meta.annual_gross_total} format="money" icon={TrendingUp} loading={loading} />
        <StatTile label="Structures" value={structures.length} icon={Scale} loading={loading} />
      </div>

      <div className="flex gap-1 border-b border-[var(--border-subtle)]">
        {[
          { key: 'people', label: 'Who earns what', icon: Users },
          { key: 'structures', label: 'Structures', icon: Scale },
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
            <item.icon className="size-4" />{item.label}
          </button>
        ))}
      </div>

      {loading ? (
        <Skeleton className="h-64 w-full" />
      ) : tab === 'people' ? (
        <SalaryTable
          salaries={salaries}
          can={can}
          onEdit={setEditingSalary}
          onHistory={setOpenHistory}
        />
      ) : (
        <StructureGrid structures={structures} onOpen={setOpenStructure} />
      )}

      {editingSalary && (
        <SalaryModal
          person={editingSalary}
          structures={structures}
          onClose={() => setEditingSalary(null)}
          onDone={async () => { setEditingSalary(null); await load(); }}
        />
      )}

      {openStructure && (
        <StructureDrawer structureId={openStructure} onClose={() => setOpenStructure(null)} />
      )}

      {openHistory && (
        <HistoryDrawer employeeId={openHistory} onClose={() => setOpenHistory(null)} />
      )}

      {editingSettings && settings && (
        <SettingsModal
          initial={settings}
          onClose={() => setEditingSettings(false)}
          onDone={async () => { setEditingSettings(false); await load(); }}
        />
      )}
    </div>
  );
}

/* ── who earns what ─────────────────────────────────────────────────────── */
function SalaryTable({ salaries, can, onEdit, onHistory }) {
  const [only, setOnly] = useState('all');

  const rows = useMemo(() => {
    if (only === 'unassigned') return salaries.filter((s) => !s.on_payroll);
    if (only === 'assigned') return salaries.filter((s) => s.on_payroll);
    return salaries;
  }, [salaries, only]);

  if (!salaries.length) {
    return (
      <Card>
        <EmptyState
          icon={Users}
          title="No people yet"
          description="Payroll reads your roster from HR. Add employees there and they appear here."
        />
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] px-5 py-3">
        <Select value={only} onChange={(e) => setOnly(e.target.value)} className="w-auto min-w-[12rem]">
          <option value="all">Everyone</option>
          <option value="assigned">On payroll</option>
          <option value="unassigned">No salary recorded</option>
        </Select>
        <p className="text-sm text-[var(--text-secondary)]">
          {rows.length} {rows.length === 1 ? 'person' : 'people'}
        </p>
      </div>

      <Table>
        <THead>
          <tr>
            <TH>Person</TH>
            <TH>Structure</TH>
            <TH align="right">Monthly gross</TH>
            <TH align="right">Annual CTC</TH>
            <TH>Since</TH>
            <TH align="right">{''}</TH>
          </tr>
        </THead>
        <TBody>
          {rows.map((row) => (
            <TR key={row.employee_id}>
              <TD>
                <div className="flex items-center gap-2.5">
                  <Avatar name={row.name} size="sm" />
                  <div className="min-w-0">
                    <p className="truncate font-medium">{row.name}</p>
                    <p className="truncate text-xs text-[var(--text-tertiary)]">
                      {row.designation ?? row.employee_code}
                    </p>
                  </div>
                </div>
              </TD>
              <TD>
                {row.structure_name ?? <span className="text-[var(--text-tertiary)]">—</span>}
              </TD>
              <TD align="right" numeric className="font-semibold">
                {row.on_payroll ? money(row.monthly_gross) : <span className="text-[var(--text-tertiary)]">not set</span>}
              </TD>
              <TD align="right" numeric className="text-[var(--text-secondary)]">
                {row.on_payroll ? money(row.annual_ctc) : '—'}
              </TD>
              <TD className="text-[var(--text-tertiary)]">{row.effective_from ?? '—'}</TD>
              <TD align="right">
                <div className="flex justify-end gap-1">
                  {row.on_payroll && (
                    <Button variant="ghost" size="sm" icon={History} onClick={() => onHistory(row.employee_id)} />
                  )}
                  {can('payroll.structures.manage') && (
                    <Button
                      variant={row.on_payroll ? 'ghost' : 'secondary'}
                      size="sm"
                      icon={row.on_payroll ? Pencil : Plus}
                      onClick={() => onEdit(row)}
                    >
                      {row.on_payroll ? '' : 'Set salary'}
                    </Button>
                  )}
                </div>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </Card>
  );
}

/* ── recording a salary, with a live breakdown ──────────────────────────── */
function SalaryModal({ person, structures, onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({
    structure_id: person.structure_id ?? structures.find((s) => s.is_default)?.id ?? '',
    monthly_gross: person.monthly_gross ? String(Number(person.monthly_gross)) : '',
    effective_from: new Date().toISOString().slice(0, 10),
    revision_note: '',
    bank_account: '', bank_ifsc: '', bank_name: '', pan: '', uan: '',
    payment_mode: 'bank',
  });
  const [breakdown, setBreakdown] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const gross = Number(form.monthly_gross) || 0;

  // The split is computed by the same code that will run payroll, so what is
  // shown here is what will actually be paid.
  useEffect(() => {
    if (!form.structure_id || gross <= 0) { setBreakdown(null); return; }
    const timer = setTimeout(() => {
      api.post(`/payroll/structures/${form.structure_id}/breakdown`, {
        monthly_gross: gross.toFixed(2),
      })
        .then((r) => setBreakdown(r.data))
        .catch(() => setBreakdown(null));
    }, 300);
    return () => clearTimeout(timer);
  }, [form.structure_id, gross]);

  async function save() {
    setBusy(true);
    try {
      await api.post('/payroll/salaries', {
        employee_id: person.employee_id,
        structure_id: form.structure_id || undefined,
        monthly_gross: gross.toFixed(2),
        effective_from: form.effective_from,
        revision_note: form.revision_note?.trim() || undefined,
        pan: form.pan?.trim() || undefined,
        uan: form.uan?.trim() || undefined,
        bank_account: form.bank_account?.trim() || undefined,
        bank_ifsc: form.bank_ifsc?.trim() || undefined,
        bank_name: form.bank_name?.trim() || undefined,
        payment_mode: form.payment_mode,
      });
      toast.success(
        person.on_payroll ? `${person.name}'s salary revised` : `${person.name} added to payroll`,
        { description: person.on_payroll ? 'The previous salary is kept for past payslips.' : undefined },
      );
      await onDone();
    } catch (err) {
      toast.error('Could not save that salary', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  const raise = person.on_payroll && gross > 0
    ? ((gross - Number(person.monthly_gross)) / Number(person.monthly_gross)) * 100
    : null;

  return (
    <Modal
      open
      onClose={onClose}
      title={person.on_payroll ? `Revise ${person.name}'s salary` : `Set ${person.name}'s salary`}
      description={
        person.on_payroll
          ? 'The current salary is closed the day before this one starts. Past payslips keep their figures.'
          : 'Enter the monthly gross. The structure splits it into basic, allowances and the rest.'
      }
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={gross <= 0} loading={busy}>
            {person.on_payroll ? 'Record revision' : 'Add to payroll'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Monthly gross" required hint={raise !== null && Number.isFinite(raise) ? `${raise >= 0 ? '+' : ''}${raise.toFixed(1)}% on the current ${money(person.monthly_gross)}` : undefined}>
          <Input
            type="number" min="0" step="100"
            value={form.monthly_gross}
            onChange={(e) => set('monthly_gross', e.target.value)}
            placeholder="50000"
            autoFocus
          />
        </Field>
        <Field label="Structure" required>
          <Select value={form.structure_id} onChange={(e) => set('structure_id', e.target.value)}>
            {structures.map((s) => (
              <option key={s.id} value={s.id}>{s.name}{s.is_default ? ' (default)' : ''}</option>
            ))}
          </Select>
        </Field>
        <Field label="Effective from" required>
          <Input type="date" value={form.effective_from} onChange={(e) => set('effective_from', e.target.value)} />
        </Field>
        <Field label="Payment mode">
          <Select value={form.payment_mode} onChange={(e) => set('payment_mode', e.target.value)}>
            <option value="bank">Bank transfer</option>
            <option value="upi">UPI</option>
            <option value="cheque">Cheque</option>
            <option value="cash">Cash</option>
          </Select>
        </Field>
        {person.on_payroll && (
          <Field label="Why" className="sm:col-span-2">
            <Input
              value={form.revision_note}
              onChange={(e) => set('revision_note', e.target.value)}
              placeholder="Annual increment, promotion to shift lead…"
            />
          </Field>
        )}
      </div>

      {breakdown && (
        <>
          <Divider label="What this becomes" className="my-5" />
          <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)]">
            {breakdown.lines.map((line) => (
              <div
                key={line.code}
                className="flex items-center gap-3 border-b border-[var(--border-subtle)] px-3.5 py-2 last:border-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{line.name}</p>
                  <p className="truncate text-xs text-[var(--text-tertiary)]">{line.basis}</p>
                </div>
                <div
                  className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-[var(--surface-sunken)]"
                  title={`${line.share}% of gross`}
                >
                  <div className="h-full bg-[var(--color-brand-500)]" style={{ width: `${line.share}%` }} />
                </div>
                <span className="metric w-24 shrink-0 text-right text-sm font-semibold tabular">
                  {money(line.amount)}
                </span>
              </div>
            ))}
            <div className="flex items-center justify-between bg-[var(--surface-sunken)] px-3.5 py-2">
              <span className="text-sm font-semibold">Monthly gross</span>
              <span className="metric text-sm font-semibold tabular">{money(breakdown.allocated)}</span>
            </div>
          </div>
          <p className="mt-2 text-xs text-[var(--text-secondary)]">
            Statutory deductions — PF, ESI, professional tax and TDS — are applied when payroll runs,
            using the attendance for that month.
          </p>
        </>
      )}

      <Divider label="For the bank and the returns" className="my-5" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="PAN"><Input value={form.pan} onChange={(e) => set('pan', e.target.value.toUpperCase())} placeholder="ABCDE1234F" className="font-mono" /></Field>
        <Field label="UAN" hint="Provident fund account"><Input value={form.uan} onChange={(e) => set('uan', e.target.value)} placeholder="100200300400" className="font-mono" /></Field>
        <Field label="Bank account"><Input value={form.bank_account} onChange={(e) => set('bank_account', e.target.value)} className="font-mono" /></Field>
        <Field label="IFSC"><Input value={form.bank_ifsc} onChange={(e) => set('bank_ifsc', e.target.value.toUpperCase())} className="font-mono" /></Field>
        <Field label="Bank name" className="sm:col-span-2"><Input value={form.bank_name} onChange={(e) => set('bank_name', e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

/* ── structures ─────────────────────────────────────────────────────────── */
function StructureGrid({ structures, onOpen }) {
  return (
    <div className="stagger grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {structures.map((structure) => (
        <Card key={structure.id} className="panel-hover flex flex-col p-5" interactive onClick={() => onOpen(structure.id)}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="truncate text-md font-semibold">{structure.name}</h3>
                {structure.is_default && <Badge tone="brand" size="sm">Default</Badge>}
              </div>
              {structure.code && <p className="mt-0.5 text-xs tabular text-[var(--text-tertiary)]">{structure.code}</p>}
            </div>
            <span className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-lg)] bg-[var(--color-brand-50)] text-[var(--color-brand-600)] dark:bg-[rgb(99_102_241/0.12)] dark:text-[var(--color-brand-400)]">
              <Scale className="size-4" />
            </span>
          </div>

          {structure.description && (
            <p className="mt-2.5 line-clamp-2 text-sm text-[var(--text-secondary)]">{structure.description}</p>
          )}

          <div className="mt-auto flex items-center gap-3 pt-4 text-sm text-[var(--text-secondary)]">
            <span className="inline-flex items-center gap-1"><Percent className="size-3.5" />{structure.component_count} components</span>
            <span className="inline-flex items-center gap-1"><Users className="size-3.5" />{structure.assigned_count}</span>
            <ChevronRight className="ml-auto size-4 text-[var(--text-tertiary)]" />
          </div>
        </Card>
      ))}
    </div>
  );
}

function StructureDrawer({ structureId, onClose }) {
  const [structure, setStructure] = useState(null);
  const [sample, setSample] = useState('50000');
  const [breakdown, setBreakdown] = useState(null);

  useEffect(() => {
    api.get(`/payroll/structures/${structureId}`).then((r) => setStructure(r.data)).catch(() => setStructure(null));
  }, [structureId]);

  useEffect(() => {
    const gross = Number(sample) || 0;
    if (gross <= 0) { setBreakdown(null); return; }
    const timer = setTimeout(() => {
      api.post(`/payroll/structures/${structureId}/breakdown`, { monthly_gross: gross.toFixed(2) })
        .then((r) => setBreakdown(r.data)).catch(() => setBreakdown(null));
    }, 300);
    return () => clearTimeout(timer);
  }, [structureId, sample]);

  const CALC = {
    fixed: 'Fixed amount',
    percent_of_basic: '% of basic',
    percent_of_gross: '% of gross',
    percent_of_ctc: '% of CTC',
    balance: 'Balance of gross',
  };

  return (
    <Drawer
      open
      onClose={onClose}
      title={structure?.name ?? 'Structure'}
      subtitle={structure?.description}
      badge={structure?.is_default && <Badge tone="brand">Default</Badge>}
      width="lg"
    >
      {!structure ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <div className="space-y-6">
          <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)]">
            <Table>
              <THead>
                <tr>
                  <TH>Component</TH>
                  <TH>How it is worked out</TH>
                  <TH>Counts toward</TH>
                </tr>
              </THead>
              <TBody>
                {structure.components.map((component) => (
                  <TR key={component.id}>
                    <TD>
                      <p className="font-medium">{component.name}</p>
                      <p className="text-xs tabular text-[var(--text-tertiary)]">{component.code}</p>
                    </TD>
                    <TD>
                      {component.calculation === 'balance'
                        ? CALC.balance
                        : component.calculation === 'fixed'
                          ? money(component.value)
                          : `${Number(component.value)}${CALC[component.calculation]?.replace('%', '% ')}`}
                    </TD>
                    <TD>
                      <div className="flex flex-wrap gap-1">
                        {component.pf_applicable && <Badge tone="info" size="sm">PF</Badge>}
                        {component.esi_applicable && <Badge tone="info" size="sm">ESI</Badge>}
                        {component.taxable && <Badge tone="neutral" size="sm">taxable</Badge>}
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>

          <Divider label="Try a figure" />

          <Field label="Monthly gross">
            <Input
              type="number" min="0" step="1000"
              value={sample}
              onChange={(e) => setSample(e.target.value)}
              className="max-w-xs"
            />
          </Field>

          {breakdown && (
            <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)]">
              {breakdown.lines.map((line) => (
                <div key={line.code} className="flex items-center gap-3 border-b border-[var(--border-subtle)] px-3.5 py-2 last:border-0">
                  <span className="min-w-0 flex-1 truncate text-sm">{line.name}</span>
                  <span className="w-12 shrink-0 text-right text-xs tabular text-[var(--text-tertiary)]">
                    {pct(line.share, 1)}
                  </span>
                  <span className="metric w-24 shrink-0 text-right text-sm font-semibold tabular">
                    {money(line.amount)}
                  </span>
                  <span className="metric w-28 shrink-0 text-right text-xs tabular text-[var(--text-secondary)]">
                    {money(line.annual)}/yr
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}

/* ── salary history ─────────────────────────────────────────────────────── */
function HistoryDrawer({ employeeId, onClose }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    api.get(`/payroll/salaries/${employeeId}`).then((r) => setData(r.data)).catch(() => setData(null));
  }, [employeeId]);

  return (
    <Drawer
      open
      onClose={onClose}
      title={data?.employee?.name ?? 'Salary history'}
      subtitle={data?.employee?.designation}
      width="md"
    >
      {!data ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <div className="space-y-6">
          <section>
            <h4 className="mb-2 text-sm font-semibold">Revisions</h4>
            <ol className="relative space-y-4 border-l border-[var(--border-subtle)] pl-5">
              {data.history.map((row) => (
                <li key={row.id} className="relative">
                  <span
                    className={cn(
                      'absolute -left-[1.625rem] top-1 size-2.5 rounded-full ring-4 ring-[var(--surface-raised)]',
                      row.effective_to ? 'bg-[var(--border-default)]' : 'bg-[var(--color-brand-500)]',
                    )}
                  />
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="metric text-md font-semibold tabular">{money(row.monthly_gross)}</span>
                    {row.change_percent !== null && (
                      <Badge tone={row.change_percent >= 0 ? 'positive' : 'critical'} size="sm">
                        {row.change_percent >= 0 ? '+' : ''}{row.change_percent}%
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
                    {row.effective_from} → {row.effective_to ?? 'now'} · {row.structure_name}
                  </p>
                  {row.revision_note && (
                    <p className="mt-1 text-sm text-[var(--text-secondary)]">{row.revision_note}</p>
                  )}
                </li>
              ))}
            </ol>
          </section>

          {data.payslips?.length > 0 && (
            <section>
              <h4 className="mb-2 text-sm font-semibold">Recent payslips</h4>
              <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)]">
                {data.payslips.map((slip) => (
                  <div key={slip.id} className="flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-3.5 py-2 last:border-0">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{slip.label}</p>
                      <p className="truncate text-xs tabular text-[var(--text-tertiary)]">{slip.payslip_number}</p>
                    </div>
                    <span className="metric shrink-0 text-sm font-semibold tabular">{money(slip.net_pay)}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </Drawer>
  );
}

/* ── statutory settings ─────────────────────────────────────────────────── */
function SettingsModal({ initial, onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  async function save() {
    setBusy(true);
    try {
      await api.patch('/payroll/settings', {
        pf_enabled: form.pf_enabled,
        pf_wage_ceiling: String(Number(form.pf_wage_ceiling).toFixed(2)),
        pf_on_actual_wage: form.pf_on_actual_wage,
        esi_enabled: form.esi_enabled,
        esi_gross_ceiling: String(Number(form.esi_gross_ceiling).toFixed(2)),
        pt_enabled: form.pt_enabled,
        pt_state: form.pt_state,
        tds_enabled: form.tds_enabled,
        tds_regime: form.tds_regime,
        overtime_enabled: form.overtime_enabled,
        overtime_multiplier: String(Number(form.overtime_multiplier).toFixed(2)),
        days_basis: form.days_basis,
        payslip_prefix: form.payslip_prefix,
        employer_name: form.employer_name ?? undefined,
        employer_address: form.employer_address ?? undefined,
        employer_pan: form.employer_pan ?? undefined,
        employer_tan: form.employer_tan ?? undefined,
        pf_establishment: form.pf_establishment ?? undefined,
        esi_establishment: form.esi_establishment ?? undefined,
      });
      toast.success('Statutory settings saved', {
        description: 'They apply to the next payroll you process.',
      });
      await onDone();
    } catch (err) {
      toast.error('Could not save those settings', {
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
      title="Statutory settings"
      description="These drive every deduction. They apply to the next run you process, not to runs already computed."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={busy}>Save settings</Button>
        </>
      }
    >
      <div className="space-y-5">
        <section>
          <h4 className="mb-3 flex items-center gap-1.5 text-sm font-semibold">
            <ShieldCheck className="size-4" />Provident fund
          </h4>
          <Checkbox
            label="Deduct provident fund"
            description="12% of basic from the employee, matched by the employer."
            checked={form.pf_enabled}
            onChange={(e) => set('pf_enabled', e.target.checked)}
          />
          {form.pf_enabled && (
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <Field label="Wage ceiling" hint="Statutory limit is ₹15,000">
                <Input type="number" value={form.pf_wage_ceiling} onChange={(e) => set('pf_wage_ceiling', e.target.value)} />
              </Field>
              <div className="flex items-end pb-2">
                <Checkbox
                  label="Contribute on actual wages"
                  description="More generous than the law requires."
                  checked={form.pf_on_actual_wage}
                  onChange={(e) => set('pf_on_actual_wage', e.target.checked)}
                />
              </div>
            </div>
          )}
        </section>

        <Divider />

        <section>
          <h4 className="mb-3 flex items-center gap-1.5 text-sm font-semibold">
            <ShieldCheck className="size-4" />Employees' state insurance
          </h4>
          <Checkbox
            label="Deduct ESI"
            description="0.75% from the employee and 3.25% from the employer, below the gross ceiling."
            checked={form.esi_enabled}
            onChange={(e) => set('esi_enabled', e.target.checked)}
          />
          {form.esi_enabled && (
            <Field label="Gross ceiling" hint="Statutory limit is ₹21,000" className="mt-3 max-w-xs">
              <Input type="number" value={form.esi_gross_ceiling} onChange={(e) => set('esi_gross_ceiling', e.target.value)} />
            </Field>
          )}
        </section>

        <Divider />

        <section>
          <h4 className="mb-3 flex items-center gap-1.5 text-sm font-semibold">
            <Landmark className="size-4" />Taxes
          </h4>
          <div className="space-y-3">
            <Checkbox
              label="Deduct professional tax"
              checked={form.pt_enabled}
              onChange={(e) => set('pt_enabled', e.target.checked)}
            />
            {form.pt_enabled && (
              <Field label="State" hint="Slabs follow the state's own schedule" className="max-w-xs">
                <Select value={form.pt_state} onChange={(e) => set('pt_state', e.target.value)}>
                  {PT_STATES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </Select>
              </Field>
            )}

            <Checkbox
              label="Deduct income tax (TDS)"
              description="Projected over the remaining months of the financial year."
              checked={form.tds_enabled}
              onChange={(e) => set('tds_enabled', e.target.checked)}
            />
            {form.tds_enabled && (
              <Field label="Regime" className="max-w-xs">
                <Select value={form.tds_regime} onChange={(e) => set('tds_regime', e.target.value)}>
                  <option value="new">New regime</option>
                  <option value="old">Old regime</option>
                </Select>
              </Field>
            )}
          </div>
        </section>

        <Divider />

        <section>
          <h4 className="mb-3 text-sm font-semibold">Pay rules</h4>
          <div className="space-y-3">
            <Checkbox
              label="Pay for overtime"
              description="Hours beyond the shift, taken from attendance."
              checked={form.overtime_enabled}
              onChange={(e) => set('overtime_enabled', e.target.checked)}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              {form.overtime_enabled && (
                <Field label="Overtime rate" hint="Multiple of the ordinary hourly rate">
                  <Input type="number" step="0.25" value={form.overtime_multiplier} onChange={(e) => set('overtime_multiplier', e.target.value)} />
                </Field>
              )}
              <Field label="A month is" hint="How a day's pay is worked out">
                <Select value={form.days_basis} onChange={(e) => set('days_basis', e.target.value)}>
                  {DAYS_BASIS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                </Select>
              </Field>
            </div>
          </div>
        </section>

        <Divider />

        <section>
          <h4 className="mb-3 text-sm font-semibold">What appears on a payslip</h4>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Employer name" className="sm:col-span-2">
              <Input value={form.employer_name ?? ''} onChange={(e) => set('employer_name', e.target.value)} />
            </Field>
            <Field label="Address" className="sm:col-span-2">
              <Textarea rows={2} value={form.employer_address ?? ''} onChange={(e) => set('employer_address', e.target.value)} />
            </Field>
            <Field label="PAN"><Input value={form.employer_pan ?? ''} onChange={(e) => set('employer_pan', e.target.value.toUpperCase())} className="font-mono" /></Field>
            <Field label="TAN"><Input value={form.employer_tan ?? ''} onChange={(e) => set('employer_tan', e.target.value.toUpperCase())} className="font-mono" /></Field>
            <Field label="PF establishment code"><Input value={form.pf_establishment ?? ''} onChange={(e) => set('pf_establishment', e.target.value)} className="font-mono" /></Field>
            <Field label="ESI establishment code"><Input value={form.esi_establishment ?? ''} onChange={(e) => set('esi_establishment', e.target.value)} className="font-mono" /></Field>
            <Field label="Payslip number prefix" hint="PS/2026-27/0001">
              <Input value={form.payslip_prefix} onChange={(e) => set('payslip_prefix', e.target.value.toUpperCase())} className="font-mono" maxLength={8} />
            </Field>
          </div>
        </section>
      </div>
    </Modal>
  );
}
