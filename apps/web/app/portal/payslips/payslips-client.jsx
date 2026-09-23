'use client';

import { useCallback, useEffect, useState } from 'react';
import { Receipt, Printer, ChevronRight, Wallet } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Drawer } from '@/components/data/drawer';
import { Table, THead, TBody, TH, TR, TD, TableSkeleton } from '@/components/ui/table';
import { Badge, Card, EmptyState, Alert, Skeleton, Divider } from '@/components/ui/primitives';
import { money, date as fmtDate } from '@/lib/format';
import { cn } from '@/lib/cn';

export default function PortalPayslips() {
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await api.get('/payroll/me/payslips');
      setRows(response.data);
      setMeta(response.meta ?? {});
    } catch (err) {
      setError(err instanceof ApiError ? err : null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (error?.status === 403) {
    return (
      <Card>
        <EmptyState
          icon={Wallet}
          title="Payslips aren’t available to you yet"
          description="Either payroll is not set up for this workspace, or your login is not linked to an employee record. Your HR team can sort either one out."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-[-0.02em]">Payslips</h1>
        <p className="mt-1 text-base text-[var(--text-secondary)]">
          Every month you were paid, with the working behind each figure.
        </p>
      </div>

      {error && error.status !== 403 && <Alert tone="critical">{error.message}</Alert>}

      {!loading && meta.ytd?.months > 0 && (
        <div className="grid gap-4 sm:grid-cols-3">
          <Figure label="Gross this financial year" value={money(meta.ytd.gross)} />
          <Figure label="Deductions" value={money(meta.ytd.deductions)} tone="critical" />
          <Figure label="Net received" value={money(meta.ytd.net)} tone="positive" strong />
        </div>
      )}

      <Card>
        {loading ? (
          <TableSkeleton rows={5} columns={5} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Receipt}
            title="No payslips yet"
            description="A payslip appears here once the month's payroll has been approved."
          />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Period</TH>
                <TH align="right">Days paid</TH>
                <TH align="right">Gross</TH>
                <TH align="right">Deductions</TH>
                <TH align="right">Net</TH>
                <TH>{''}</TH>
              </tr>
            </THead>
            <TBody>
              {rows.map((row) => (
                <TR key={row.id} onClick={() => setOpen(row.id)}>
                  <TD>
                    <p className="font-medium">{row.label}</p>
                    <p className="text-xs tabular text-[var(--text-tertiary)]">{row.payslip_number}</p>
                  </TD>
                  <TD align="right" numeric>
                    {Number(row.payable_days)}
                    {Number(row.overtime_hours) > 0 && (
                      <span className="ml-1 text-xs text-[var(--color-positive-600)]">
                        +{Number(row.overtime_hours)}h
                      </span>
                    )}
                  </TD>
                  <TD align="right" numeric>{money(row.gross_earnings)}</TD>
                  <TD align="right" numeric className="text-[var(--text-secondary)]">
                    {money(row.total_deductions)}
                  </TD>
                  <TD align="right" numeric className="font-semibold">{money(row.net_pay)}</TD>
                  <TD>
                    <div className="flex items-center gap-2">
                      <Badge tone={row.run_status === 'paid' ? 'positive' : 'info'} size="sm">
                        {row.run_status === 'paid' ? 'paid' : 'approved'}
                      </Badge>
                      <ChevronRight className="size-4 text-[var(--text-tertiary)]" />
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      {open && <PayslipDrawer payslipId={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Figure({ label, value, tone = 'neutral', strong }) {
  const tones = {
    neutral: 'text-[var(--text-primary)]',
    positive: 'text-[var(--color-positive-600)] dark:text-[var(--color-positive-500)]',
    critical: 'text-[var(--color-critical-600)] dark:text-[var(--color-critical-500)]',
  };
  return (
    <div className="panel p-4">
      <p className="truncate text-sm text-[var(--text-secondary)]">{label}</p>
      <p className={cn(
        'metric mt-2 font-semibold tabular tracking-[-0.025em]',
        strong ? 'text-2xl' : 'text-xl', tones[tone],
      )}>
        {value}
      </p>
    </div>
  );
}

function PayslipDrawer({ payslipId, onClose }) {
  const [slip, setSlip] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get(`/payroll/me/payslips/${payslipId}`)
      .then((r) => setSlip(r.data))
      .catch(() => setSlip(null))
      .finally(() => setLoading(false));
  }, [payslipId]);

  return (
    <Drawer
      open
      onClose={onClose}
      title={slip?.label ?? 'Payslip'}
      subtitle={slip?.payslip_number}
      width="lg"
      footer={
        slip && (
          <Button
            variant="primary"
            icon={Printer}
            className="ml-auto"
            onClick={() => window.print()}
          >
            Print or save as PDF
          </Button>
        )
      }
    >
      {loading ? (
        <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div>
      ) : !slip ? (
        <EmptyState icon={Receipt} title="Payslip not found" />
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Small label="Days in period" value={Number(slip.days_in_period)} />
            <Small label="Days paid" value={Number(slip.payable_days)} />
            <Small label="Loss of pay" value={Number(slip.lop_days)} />
            <Small label="Overtime" value={`${Number(slip.overtime_hours)}h`} />
          </div>

          {slip.notes && <Alert tone="caution">{slip.notes}</Alert>}

          <Lines title="Earnings" lines={slip.earnings} total={slip.gross_earnings} />
          <Lines title="Deductions" lines={slip.deductions} total={slip.total_deductions} tone="critical" />

          <div className="rounded-[var(--radius-lg)] border-2 border-[var(--color-brand-200)] bg-[var(--color-brand-50)] p-4 dark:border-[rgb(99_102_241/0.25)] dark:bg-[rgb(99_102_241/0.08)]">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-semibold">Net pay</span>
              <span className="metric text-xl font-semibold tabular">{money(slip.net_pay)}</span>
            </div>
            <p className="mt-1 text-xs text-[var(--text-secondary)]">{slip.net_pay_words}</p>
          </div>

          {slip.employer?.length > 0 && (
            <>
              <Divider label="Paid by your employer on top" />
              <Lines lines={slip.employer} total={slip.employer_contrib} />
            </>
          )}

          {slip.employer_details?.name && (
            <p className="text-xs text-[var(--text-tertiary)]">
              Issued by {slip.employer_details.name}
              {slip.paid_at && ` · paid ${fmtDate(slip.paid_at)}`}
            </p>
          )}
        </div>
      )}
    </Drawer>
  );
}

function Small({ label, value }) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] p-3">
      <p className="text-xs text-[var(--text-secondary)]">{label}</p>
      <p className="metric mt-1 text-md font-semibold tabular">{value}</p>
    </div>
  );
}

function Lines({ title, lines, total, tone }) {
  if (!lines?.length) return null;
  return (
    <section>
      {title && <h3 className="mb-2 text-sm font-semibold">{title}</h3>}
      <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)]">
        {lines.map((line) => (
          <div
            key={`${line.kind}-${line.code}`}
            className="flex items-start justify-between gap-4 border-b border-[var(--border-subtle)] px-3.5 py-2.5 last:border-0"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium">{line.name}</p>
              {line.basis && <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">{line.basis}</p>}
            </div>
            <span className={cn(
              'metric shrink-0 text-sm font-semibold tabular',
              tone === 'critical' && 'text-[var(--color-critical-600)] dark:text-[var(--color-critical-500)]',
            )}>
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
