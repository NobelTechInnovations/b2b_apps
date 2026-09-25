'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Plus, BadgeIndianRupee, Play, CheckCircle2, Banknote, Users, TrendingUp,
  AlertTriangle, ChevronRight, Landmark, FileSpreadsheet, PauseCircle, Wallet,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Can, useWorkspace } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { Modal, ConfirmModal } from '@/components/ui/modal';
import { Table, THead, TBody, TH, TR, TD } from '@/components/ui/table';
import { Drawer, DetailGrid } from '@/components/data/drawer';
import { StatTile } from '@/components/data/stat-tile';
import {
  Avatar, Badge, Card, EmptyState, PageHeader, Alert, Skeleton, Divider,
} from '@/components/ui/primitives';
import { money, date as fmtDate, number } from '@/lib/format';
import { cn } from '@/lib/cn';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const STATUS = {
  draft: { tone: 'neutral', label: 'Draft' },
  review: { tone: 'caution', label: 'In review' },
  approved: { tone: 'info', label: 'Approved' },
  paid: { tone: 'positive', label: 'Paid' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
};

export default function PayrollClient() {
  const toast = useToast();
  const { can } = useWorkspace();

  const [overview, setOverview] = useState(null);
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [o, r] = await Promise.all([
        api.get('/payroll'),
        api.get('/payroll/runs', { query: { limit: 24 } }),
      ]);
      setOverview(o.data);
      setRuns(r.data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load payroll.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function createRun(form) {
    setBusy(true);
    try {
      const response = await api.post('/payroll/runs', {
        year: Number(form.year),
        month: Number(form.month),
        notes: form.notes?.trim() || undefined,
      });
      setCreating(false);
      toast.success(`${response.data.label} created`, { description: 'Process it to compute payslips.' });
      await load();
      setOpen(response.data.id);
    } catch (err) {
      toast.error('Could not start that run', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  const trend = overview?.trend ?? [];
  const peak = Math.max(1, ...trend.map((t) => Number(t.net_total ?? 0)));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Payroll"
        description="Run the month, check the numbers, approve, pay."
        actions={
          <Can permission="payroll.runs.create">
            <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>New payroll run</Button>
          </Can>
        }
      />

      {error && <Alert tone="critical">{error}</Alert>}

      {!loading && overview?.on_payroll === 0 && (
        <Alert
          tone="info"
          icon={Wallet}
          title="Nobody has a salary recorded yet"
          action={
            <Link href="/payroll/structures">
              <Button variant="secondary" size="sm">Set salaries</Button>
            </Link>
          }
        >
          Payroll reads your people from HR. Record what each of them earns and a run has something to compute.
        </Alert>
      )}

      {!loading && overview?.held_payslips > 0 && (
        <Alert tone="caution" icon={PauseCircle} title={`${overview.held_payslips} payslip${overview.held_payslips === 1 ? ' is' : 's are'} on hold`}>
          Held payslips stay out of the bank advice until they are released.
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="On payroll"
          value={overview?.on_payroll}
          icon={Users}
          loading={loading}
          hint="people with a salary on record"
        />
        <StatTile
          label="Monthly commitment"
          value={overview?.monthly_commitment}
          format="money"
          icon={BadgeIndianRupee}
          loading={loading}
          tone="brand"
        />
        <StatTile
          label="Annual commitment"
          value={overview?.annual_commitment}
          format="money"
          icon={TrendingUp}
          loading={loading}
        />
        <StatTile
          label="Open runs"
          value={overview?.open_runs}
          icon={Play}
          tone={overview?.open_runs ? 'caution' : 'neutral'}
          loading={loading}
          hint={overview?.open_runs ? 'not yet paid' : 'everything settled'}
        />
      </div>

      {trend.length > 1 && (
        <Card className="p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-md font-semibold">Net paid, last {trend.length} runs</h3>
              <p className="mt-0.5 text-sm text-[var(--text-secondary)]">
                Approved and paid runs only.
              </p>
            </div>
            <Badge tone="brand" size="sm">
              {money(trend[trend.length - 1]?.net_total)} latest
            </Badge>
          </div>

          <div className="mt-5 flex items-end gap-1.5" style={{ height: 96 }}>
            {trend.map((point) => {
              const height = Math.max(4, (Number(point.net_total) / peak) * 96);
              return (
                <div
                  key={`${point.period_year}-${point.period_month}`}
                  className="group flex flex-1 flex-col items-center justify-end gap-1.5"
                  title={`${point.label}: ${money(point.net_total)} across ${point.headcount} people`}
                >
                  <div
                    className="w-full rounded-t-[var(--radius-xs)] bg-[var(--color-brand-500)] opacity-70 transition-opacity group-hover:opacity-100"
                    style={{ height }}
                  />
                  <span className="truncate text-2xs text-[var(--text-tertiary)]">
                    {MONTHS[point.period_month - 1]?.slice(0, 3)}
                  </span>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <Card>
        <div className="flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-5 py-3">
          <h3 className="text-md font-semibold">Payroll runs</h3>
          <Link
            href="/payroll/payslips"
            className="inline-flex items-center gap-1 text-sm font-medium text-[var(--color-brand-600)] hover:underline dark:text-[var(--color-brand-400)]"
          >
            All payslips <ChevronRight className="size-3.5" />
          </Link>
        </div>

        {loading ? (
          <div className="space-y-2 p-5">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : runs.length === 0 ? (
          <EmptyState
            icon={BadgeIndianRupee}
            title="No payroll has been run yet"
            description="A run computes a payslip for everyone with a salary, using the attendance recorded for that month."
            action={can('payroll.runs.create') && (
              <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
                Run this month
              </Button>
            )}
          />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Period</TH>
                <TH>People</TH>
                <TH align="right">Gross</TH>
                <TH align="right">Deductions</TH>
                <TH align="right">Net</TH>
                <TH>Status</TH>
              </tr>
            </THead>
            <TBody>
              {runs.map((run) => (
                <TR key={run.id} onClick={() => setOpen(run.id)}>
                  <TD>
                    <p className="font-medium">{run.label}</p>
                    <p className="text-xs text-[var(--text-tertiary)]">
                      {run.processed_at ? `processed ${fmtDate(run.processed_at)}` : 'not processed'}
                    </p>
                  </TD>
                  <TD align="right" numeric>{run.headcount}</TD>
                  <TD align="right" numeric>{money(run.gross_total)}</TD>
                  <TD align="right" numeric className="text-[var(--text-secondary)]">{money(run.deduction_total)}</TD>
                  <TD align="right" numeric className="font-semibold">{money(run.net_total)}</TD>
                  <TD>
                    <Badge tone={STATUS[run.status]?.tone} size="sm">
                      {STATUS[run.status]?.label ?? run.status}
                    </Badge>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      {creating && <NewRunModal busy={busy} onClose={() => setCreating(false)} onSave={createRun} />}

      {open && (
        <RunDrawer
          runId={open}
          onClose={() => setOpen(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}

/* ── starting a run ─────────────────────────────────────────────────────── */
function NewRunModal({ busy, onClose, onSave }) {
  const now = new Date();
  // Payroll for a month is run once that month has ended, so last month is
  // what somebody opening this almost always wants.
  const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  const [form, setForm] = useState({
    year: previous.getFullYear(),
    month: previous.getMonth() + 1,
    notes: '',
  });

  const years = [now.getFullYear(), now.getFullYear() - 1, now.getFullYear() - 2];

  return (
    <Modal
      open
      onClose={onClose}
      title="New payroll run"
      description="One run per month. Attendance for the whole month is read when you process it."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => onSave(form)} loading={busy}>Create run</Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Month" required>
          <Select value={form.month} onChange={(e) => setForm((f) => ({ ...f, month: e.target.value }))}>
            {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </Select>
        </Field>
        <Field label="Year" required>
          <Select value={form.year} onChange={(e) => setForm((f) => ({ ...f, year: e.target.value }))}>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </Select>
        </Field>
        <Field label="Notes" className="sm:col-span-2">
          <Textarea
            rows={2}
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            placeholder="Anything worth recording about this run"
          />
        </Field>
      </div>
    </Modal>
  );
}

/* ── the run itself ─────────────────────────────────────────────────────── */
function RunDrawer({ runId, onClose, onChanged }) {
  const toast = useToast();
  const { can } = useWorkspace();

  const [run, setRun] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(null);
  const [advice, setAdvice] = useState(null);
  const [slip, setSlip] = useState(null);

  const load = useCallback(async () => {
    try {
      const response = await api.get(`/payroll/runs/${runId}`);
      setRun(response.data);
    } catch {
      setRun(null);
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => { load(); }, [load]);

  async function process() {
    setBusy(true);
    try {
      const response = await api.post(`/payroll/runs/${runId}/process`, {});
      const skipped = response.meta?.skipped ?? [];
      toast.success(`${response.meta.processed} payslip${response.meta.processed === 1 ? '' : 's'} computed`, {
        description: skipped.length
          ? `${skipped.length} skipped: ${skipped.slice(0, 2).map((s) => `${s.name} (${s.reason.toLowerCase()})`).join(', ')}${skipped.length > 2 ? '…' : ''}`
          : `Net ${response.meta.totals.net}`,
      });
      await load();
      await onChanged();
    } catch (err) {
      toast.error('Could not process that run', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  async function transition(status) {
    setBusy(true);
    try {
      await api.post(`/payroll/runs/${runId}/status`, { status });
      toast.success(`Run ${status}`);
      setConfirming(null);
      await load();
      await onChanged();
    } catch (err) {
      toast.error('Could not change the run', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  async function openAdvice() {
    try {
      const response = await api.get(`/payroll/runs/${runId}/bank-advice`);
      setAdvice(response);
    } catch (err) {
      toast.error('Could not build the bank advice', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    }
  }

  const next = run?.next_statuses ?? [];

  return (
    <>
      <Drawer
        open
        onClose={onClose}
        title={run?.label ?? 'Payroll run'}
        subtitle={run ? `${run.period_start} → ${run.period_end}` : undefined}
        badge={run && <Badge tone={STATUS[run.status]?.tone}>{STATUS[run.status]?.label}</Badge>}
        width="xl"
        footer={
          run && (
            <div className="flex w-full flex-wrap items-center gap-2">
              <Can permission="payroll.runs.create">
                {run.status !== 'paid' && run.status !== 'cancelled' && (
                  <Button variant="secondary" icon={Play} onClick={process} loading={busy}>
                    {run.processed_at ? 'Re-process' : 'Process payroll'}
                  </Button>
                )}
              </Can>

              {['approved', 'paid'].includes(run.status) && (
                <Button variant="ghost" icon={Landmark} onClick={openAdvice}>Bank advice</Button>
              )}

              <div className="flex-1" />

              <Can permission="payroll.runs.approve">
                {next.includes('approved') && (
                  <Button variant="primary" icon={CheckCircle2} onClick={() => setConfirming('approved')}>
                    Approve
                  </Button>
                )}
                {next.includes('paid') && (
                  <Button variant="primary" icon={Banknote} onClick={() => setConfirming('paid')}>
                    Mark as paid
                  </Button>
                )}
              </Can>
            </div>
          )
        }
      >
        {loading ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
          </div>
        ) : !run ? (
          <EmptyState icon={AlertTriangle} title="Run not found" />
        ) : (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Figure label="People" value={number(run.headcount)} />
              <Figure label="Gross" value={money(run.gross_total)} />
              <Figure label="Deductions" value={money(run.deduction_total)} tone="critical" />
              <Figure label="Net payable" value={money(run.net_total)} tone="positive" strong />
            </div>

            <div className="rounded-[var(--radius-lg)] bg-[var(--surface-sunken)] px-4 py-3 text-sm">
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-[var(--text-secondary)]">
                <span>
                  Employer cost <strong className="tabular text-[var(--text-primary)]">{money(run.employer_cost)}</strong>
                </span>
                {run.processed_at && <span>Processed {fmtDate(run.processed_at, 'datetime')}</span>}
                {run.approved_at && <span>Approved {fmtDate(run.approved_at, 'datetime')}</span>}
                {run.paid_at && <span>Paid {fmtDate(run.paid_at, 'datetime')}</span>}
              </div>
            </div>

            {!run.processed_at ? (
              <EmptyState
                icon={Play}
                title="Not processed yet"
                description="Processing reads this month's attendance from HR, applies each person's salary structure, and computes PF, ESI, professional tax and TDS."
                action={can('payroll.runs.create') && (
                  <Button variant="primary" icon={Play} onClick={process} loading={busy}>
                    Process payroll
                  </Button>
                )}
              />
            ) : (
              <>
                {run.statutory_breakdown?.length > 0 && (
                  <section>
                    <h4 className="mb-2 text-sm font-semibold">Deductions and contributions</h4>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {run.statutory_breakdown.map((line) => (
                        <div
                          key={`${line.kind}-${line.code}`}
                          className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] px-3 py-2"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{line.name}</p>
                            <p className="text-xs text-[var(--text-tertiary)]">
                              {line.kind === 'employer' ? 'employer pays' : 'deducted'} · {line.people} {line.people === 1 ? 'person' : 'people'}
                            </p>
                          </div>
                          <span className="metric shrink-0 text-sm font-semibold tabular">
                            {money(line.total)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                <section>
                  <div className="mb-2 flex items-center justify-between">
                    <h4 className="text-sm font-semibold">Payslips</h4>
                    <Link
                      href={`/payroll/payslips?run_id=${run.id}`}
                      className="inline-flex items-center gap-1 text-xs font-medium text-[var(--color-brand-600)] hover:underline"
                    >
                      <FileSpreadsheet className="size-3.5" /> Salary register
                    </Link>
                  </div>

                  <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)]">
                    <Table>
                      <THead>
                        <tr>
                          <TH>Person</TH>
                          <TH align="right">Days</TH>
                          <TH align="right">Gross</TH>
                          <TH align="right">Net</TH>
                          <TH>{''}</TH>
                        </tr>
                      </THead>
                      <TBody>
                        {run.payslips.map((payslip) => (
                          <TR key={payslip.id} onClick={() => setSlip(payslip.id)}>
                            <TD>
                              <div className="flex items-center gap-2">
                                <Avatar name={payslip.employee_name} size="xs" />
                                <div className="min-w-0">
                                  <p className="truncate font-medium">{payslip.employee_name}</p>
                                  <p className="truncate text-xs text-[var(--text-tertiary)]">
                                    {payslip.designation ?? payslip.employee_code}
                                  </p>
                                </div>
                              </div>
                            </TD>
                            <TD align="right" numeric>
                              {Number(payslip.payable_days)}
                              {Number(payslip.lop_days) > 0 && (
                                <span className="ml-1 text-xs text-[var(--color-critical-600)]">
                                  −{payslip.lop_days}
                                </span>
                              )}
                            </TD>
                            <TD align="right" numeric>{money(payslip.gross_earnings)}</TD>
                            <TD align="right" numeric className="font-semibold">{money(payslip.net_pay)}</TD>
                            <TD>
                              {payslip.status === 'held' && <Badge tone="caution" size="sm">held</Badge>}
                              {Number(payslip.overtime_hours) > 0 && (
                                <Badge tone="info" size="sm">+{payslip.overtime_hours}h OT</Badge>
                              )}
                            </TD>
                          </TR>
                        ))}
                      </TBody>
                    </Table>
                  </div>
                </section>
              </>
            )}
          </div>
        )}
      </Drawer>

      {slip && <PayslipDrawer payslipId={slip} onClose={() => setSlip(null)} onChanged={load} />}

      {advice && (
        <Modal
          open
          onClose={() => setAdvice(null)}
          title="Bank advice"
          description={`${advice.meta.count} payments totalling ${money(advice.meta.total)}`}
          size="lg"
          footer={<Button variant="primary" onClick={() => setAdvice(null)}>Close</Button>}
        >
          {advice.meta.excluded?.length > 0 && (
            <Alert tone="caution" className="mb-4" title={`${advice.meta.excluded.length} not in this advice`}>
              {advice.meta.excluded.map((e) => `${e.name} — ${e.reason}`).join('; ')}
            </Alert>
          )}
          <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)]">
            <Table>
              <THead>
                <tr>
                  <TH>Person</TH>
                  <TH>Account</TH>
                  <TH>IFSC</TH>
                  <TH align="right">Amount</TH>
                </tr>
              </THead>
              <TBody>
                {advice.data.map((row) => (
                  <TR key={row.payslip_number}>
                    <TD>{row.employee_name}</TD>
                    <TD className="font-mono text-xs">{row.bank_account}</TD>
                    <TD className="font-mono text-xs">{row.bank_ifsc ?? '—'}</TD>
                    <TD align="right" numeric className="font-semibold">{money(row.net_pay)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        </Modal>
      )}

      <ConfirmModal
        open={Boolean(confirming)}
        onClose={() => setConfirming(null)}
        onConfirm={() => transition(confirming)}
        title={confirming === 'approved' ? 'Approve this run?' : 'Mark this run as paid?'}
        description={
          confirming === 'approved'
            ? 'Approved payslips become visible and a bank advice can be produced. You can still send it back for review.'
            : 'This is final. A paid run cannot be reopened — corrections go in a later run.'
        }
        confirmLabel={confirming === 'approved' ? 'Approve' : 'Mark paid'}
        danger={confirming === 'paid'}
        loading={busy}
      />
    </>
  );
}

function Figure({ label, value, tone = 'neutral', strong }) {
  const tones = {
    neutral: 'text-[var(--text-primary)]',
    positive: 'text-[var(--color-positive-600)] dark:text-[var(--color-positive-500)]',
    critical: 'text-[var(--color-critical-600)] dark:text-[var(--color-critical-500)]',
  };
  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] p-3">
      <p className="text-xs text-[var(--text-secondary)]">{label}</p>
      <p className={cn('metric mt-1 font-semibold tabular', strong ? 'text-lg' : 'text-md', tones[tone])}>
        {value}
      </p>
    </div>
  );
}

/* ── one payslip ────────────────────────────────────────────────────────── */
export function PayslipDrawer({ payslipId, onClose, onChanged }) {
  const toast = useToast();
  const [slip, setSlip] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await api.get(`/payroll/payslips/${payslipId}`);
      setSlip(response.data);
    } catch {
      setSlip(null);
    } finally {
      setLoading(false);
    }
  }, [payslipId]);

  useEffect(() => { load(); }, [load]);

  async function hold(release) {
    setBusy(true);
    try {
      await api.post(`/payroll/payslips/${payslipId}/hold`, {
        release,
        reason: release ? undefined : 'Held for review',
      });
      toast.success(release ? 'Payslip released' : 'Payslip held');
      await load();
      await onChanged?.();
    } catch (err) {
      toast.error('Could not change that payslip', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open
      onClose={onClose}
      title={slip?.employee_name ?? 'Payslip'}
      subtitle={slip ? `${slip.payslip_number} · ${slip.label}` : undefined}
      badge={slip?.status === 'held' ? <Badge tone="caution">Held</Badge> : undefined}
      width="lg"
      footer={
        slip && (
          <div className="flex w-full items-center gap-2">
            <Can permission="payroll.runs.approve">
              <Button
                variant={slip.status === 'held' ? 'secondary' : 'ghost'}
                icon={PauseCircle}
                onClick={() => hold(slip.status === 'held')}
                loading={busy}
              >
                {slip.status === 'held' ? 'Release' : 'Hold payment'}
              </Button>
            </Can>
            <div className="flex-1" />
            <Link href={`/payroll/payslips/${payslipId}/print`} target="_blank">
              <Button variant="primary">Open printable payslip</Button>
            </Link>
          </div>
        )
      }
    >
      {loading ? (
        <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div>
      ) : !slip ? (
        <EmptyState icon={AlertTriangle} title="Payslip not found" />
      ) : (
        <div className="space-y-6">
          {slip.notes && <Alert tone="caution">{slip.notes}</Alert>}

          <DetailGrid
            items={[
              { label: 'Employee code', value: slip.employee_code },
              { label: 'Designation', value: slip.designation },
              { label: 'Department', value: slip.department_name },
              { label: 'Paid days', value: `${slip.payable_days} of ${slip.days_in_period}` },
              { label: 'Loss of pay', value: Number(slip.lop_days) ? `${slip.lop_days} days` : 'None' },
              { label: 'Overtime', value: Number(slip.overtime_hours) ? `${slip.overtime_hours} hours` : 'None' },
              { label: 'PAN', value: slip.pan },
              { label: 'UAN', value: slip.uan },
            ]}
          />

          <LineTable title="Earnings" lines={slip.earnings} total={slip.gross_earnings} />
          <LineTable title="Deductions" lines={slip.deductions} total={slip.total_deductions} tone="critical" />

          <div className="rounded-[var(--radius-lg)] border-2 border-[var(--color-brand-200)] bg-[var(--color-brand-50)] p-4 dark:border-[rgb(99_102_241/0.25)] dark:bg-[rgb(99_102_241/0.08)]">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-semibold">Net pay</span>
              <span className="metric text-xl font-semibold tabular">{money(slip.net_pay)}</span>
            </div>
            <p className="mt-1 text-xs text-[var(--text-secondary)]">{slip.net_pay_words}</p>
          </div>

          {slip.employer?.length > 0 && (
            <LineTable
              title="What the employer contributes on top"
              lines={slip.employer}
              total={slip.employer_contrib}
            />
          )}

          {slip.ytd && (
            <>
              <Divider label="Year to date" />
              <div className="grid grid-cols-3 gap-3">
                <Figure label="Gross" value={money(slip.ytd.gross)} />
                <Figure label="Deductions" value={money(slip.ytd.deductions)} />
                <Figure label="Net" value={money(slip.ytd.net)} strong />
              </div>
            </>
          )}
        </div>
      )}
    </Drawer>
  );
}

function LineTable({ title, lines, total, tone }) {
  if (!lines?.length) return null;
  return (
    <section>
      <h4 className="mb-2 text-sm font-semibold">{title}</h4>
      <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)]">
        {lines.map((line) => (
          <div
            key={`${line.kind}-${line.code}`}
            className="flex items-start justify-between gap-4 border-b border-[var(--border-subtle)] px-3.5 py-2.5 last:border-0"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium">{line.name}</p>
              {line.basis && (
                <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">{line.basis}</p>
              )}
            </div>
            <span
              className={cn(
                'metric shrink-0 text-sm font-semibold tabular',
                tone === 'critical' && 'text-[var(--color-critical-600)] dark:text-[var(--color-critical-500)]',
              )}
            >
              {money(line.amount)}
            </span>
          </div>
        ))}
        <div className="flex items-center justify-between gap-4 bg-[var(--surface-sunken)] px-3.5 py-2.5">
          <span className="text-sm font-semibold">Total</span>
          <span className="metric text-sm font-semibold tabular">{money(total)}</span>
        </div>
      </div>
    </section>
  );
}
