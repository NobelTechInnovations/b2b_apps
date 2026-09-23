'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Receipt, FileSpreadsheet, Download, Table2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/input';
import { ListToolbar, Pagination } from '@/components/data/list-shell';
import { Table, THead, TBody, TH, TR, TD, TableSkeleton } from '@/components/ui/table';
import {
  Avatar, Badge, Card, EmptyState, PageHeader, Alert,
} from '@/components/ui/primitives';
import { money } from '@/lib/format';
import { PayslipDrawer } from '../payroll-client';

const STATUS_TONE = { draft: 'neutral', approved: 'info', paid: 'positive', held: 'caution' };

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export default function PayslipsClient() {
  const toast = useToast();
  const params = useSearchParams();

  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState({});
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({});
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(null);
  const [register, setRegister] = useState(null);

  // A deep link from a run lands here with a run already chosen. Reading the
  // search params in an effect, not in a useState initializer: under Suspense
  // the initializer runs before they are populated.
  useEffect(() => {
    const runId = params.get('run_id');
    if (runId) setFilters((f) => ({ ...f, run_id: runId }));
  }, [params]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.get('/payroll/payslips', {
        query: { ...filters, q: search || undefined, page, limit: 25 },
      });
      setRows(response.data);
      setMeta(response.meta ?? {});
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load payslips.');
    } finally {
      setLoading(false);
    }
  }, [filters, search, page]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api.get('/payroll/runs', { query: { limit: 24 } })
      .then((r) => setRuns(r.data)).catch(() => setRuns([]));
  }, []);

  async function openRegister() {
    if (!filters.run_id) {
      toast.error('Choose a payroll run first', {
        description: 'The register is a sheet for one run.',
      });
      return;
    }
    try {
      const response = await api.get(`/payroll/runs/${filters.run_id}/register`);
      setRegister(response);
    } catch (err) {
      toast.error('Could not build the register', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Payslips"
        description="Every payslip issued, across every run."
        actions={
          <Button variant="secondary" icon={Table2} onClick={openRegister}>
            Salary register
          </Button>
        }
      />

      {error && <Alert tone="critical">{error}</Alert>}

      <ListToolbar
        search={search}
        onSearch={(value) => { setSearch(value); setPage(1); }}
        searchPlaceholder="Search by name, code or payslip number…"
        filters={[
          {
            key: 'run_id',
            label: 'Run',
            options: runs.map((r) => ({ value: r.id, label: r.label })),
          },
          {
            key: 'status',
            label: 'Status',
            options: [
              { value: 'draft', label: 'Draft' },
              { value: 'approved', label: 'Approved' },
              { value: 'paid', label: 'Paid' },
              { value: 'held', label: 'Held' },
            ],
          },
        ]}
        values={filters}
        onFilter={(key, value) => {
          setFilters((f) => ({ ...f, [key]: value }));
          setPage(1);
        }}
        onClear={() => { setFilters({}); setPage(1); }}
      />

      <Card>
        {loading ? (
          <TableSkeleton rows={6} columns={6} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Receipt}
            title="No payslips yet"
            description="Payslips appear here once a payroll run has been processed."
          />
        ) : (
          <>
            <Table>
              <THead>
                <tr>
                  <TH>Person</TH>
                  <TH>Period</TH>
                  <TH align="right">Days</TH>
                  <TH align="right">Gross</TH>
                  <TH align="right">Deductions</TH>
                  <TH align="right">Net</TH>
                  <TH>Status</TH>
                </tr>
              </THead>
              <TBody>
                {rows.map((row) => (
                  <TR key={row.id} onClick={() => setOpen(row.id)}>
                    <TD>
                      <div className="flex items-center gap-2.5">
                        <Avatar name={row.employee_name} size="sm" />
                        <div className="min-w-0">
                          <p className="truncate font-medium">{row.employee_name}</p>
                          <p className="truncate text-xs tabular text-[var(--text-tertiary)]">
                            {row.payslip_number}
                          </p>
                        </div>
                      </div>
                    </TD>
                    <TD>{row.label}</TD>
                    <TD align="right" numeric>
                      {row.payable_days}
                      {Number(row.lop_days) > 0 && (
                        <span className="ml-1 text-xs text-[var(--color-critical-600)]">−{row.lop_days}</span>
                      )}
                    </TD>
                    <TD align="right" numeric>{money(row.gross_earnings)}</TD>
                    <TD align="right" numeric className="text-[var(--text-secondary)]">{money(row.total_deductions)}</TD>
                    <TD align="right" numeric className="font-semibold">{money(row.net_pay)}</TD>
                    <TD>
                      <Badge tone={STATUS_TONE[row.status]} size="sm">{row.status}</Badge>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination meta={meta} onPage={setPage} />
          </>
        )}
      </Card>

      {open && <PayslipDrawer payslipId={open} onClose={() => setOpen(null)} onChanged={load} />}

      {register && <RegisterSheet register={register} onClose={() => setRegister(null)} />}
    </div>
  );
}

/* ── the salary register ────────────────────────────────────────────────── */
function RegisterSheet({ register, onClose }) {
  const { columns, totals, component_totals: componentTotals, run } = register.meta;
  const all = [...columns.earnings, ...columns.deductions, ...columns.employer];

  /** A CSV of exactly what is on screen, for whoever needs it in a sheet. */
  function download() {
    const header = [
      'Payslip', 'Employee code', 'Name', 'Designation', 'Department',
      'PAN', 'UAN', 'Bank account', 'Paid days', 'LOP days', 'Overtime hours',
      ...all.map((col) => col.name),
      'Gross', 'Deductions', 'Net', 'Employer contribution',
    ];

    const escape = (value) => {
      const text = String(value ?? '');
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };

    const lines = [header.map(escape).join(',')];
    for (const row of register.data) {
      lines.push([
        row.payslip_number, row.employee_code, row.employee_name, row.designation,
        row.department_name, row.pan, row.uan, row.bank_account,
        row.payable_days, row.lop_days, row.overtime_hours,
        ...all.map((col) => row.components[col.code] ?? '0.00'),
        row.gross_earnings, row.total_deductions, row.net_pay, row.employer_contrib,
      ].map(escape).join(','));
    }

    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `salary-register-${run.label.replace(/\s+/g, '-').toLowerCase()}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[var(--surface-base)]">
      <div className="flex flex-wrap items-center gap-3 border-b border-[var(--border-subtle)] px-5 py-3">
        <div>
          <h2 className="text-md font-semibold">Salary register — {run.label}</h2>
          <p className="text-sm text-[var(--text-secondary)]">
            {totals.headcount} people · gross {money(totals.gross)} · net {money(totals.net)}
          </p>
        </div>
        <div className="flex-1" />
        <Button variant="secondary" icon={Download} onClick={download}>Download CSV</Button>
        <Button variant="ghost" onClick={onClose}>Close</Button>
      </div>

      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-[var(--surface-raised)] shadow-[0_1px_0_var(--border-subtle)]">
            <tr>
              <th className="sticky left-0 z-20 bg-[var(--surface-raised)] px-4 py-2.5 text-left text-xs font-semibold">
                Person
              </th>
              <th className="px-3 py-2.5 text-right text-xs font-semibold">Days</th>
              {columns.earnings.map((col) => (
                <th key={col.code} className="whitespace-nowrap px-3 py-2.5 text-right text-xs font-semibold text-[var(--color-positive-700)] dark:text-[var(--color-positive-500)]">
                  {col.name}
                </th>
              ))}
              <th className="whitespace-nowrap px-3 py-2.5 text-right text-xs font-semibold">Gross</th>
              {columns.deductions.map((col) => (
                <th key={col.code} className="whitespace-nowrap px-3 py-2.5 text-right text-xs font-semibold text-[var(--color-critical-700)] dark:text-[var(--color-critical-500)]">
                  {col.name}
                </th>
              ))}
              <th className="whitespace-nowrap px-3 py-2.5 text-right text-xs font-semibold">Net</th>
              {columns.employer.map((col) => (
                <th key={col.code} className="whitespace-nowrap px-3 py-2.5 text-right text-xs font-semibold text-[var(--text-secondary)]">
                  {col.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {register.data.map((row) => (
              <tr key={row.payslip_id} className="border-b border-[var(--border-subtle)]">
                <td className="sticky left-0 z-10 bg-[var(--surface-base)] px-4 py-2">
                  <p className="truncate font-medium">{row.employee_name}</p>
                  <p className="truncate text-xs tabular text-[var(--text-tertiary)]">{row.employee_code}</p>
                </td>
                <td className="px-3 py-2 text-right tabular">{row.payable_days}</td>
                {columns.earnings.map((col) => (
                  <td key={col.code} className="px-3 py-2 text-right tabular">
                    {row.components[col.code] ? money(row.components[col.code]) : '—'}
                  </td>
                ))}
                <td className="px-3 py-2 text-right font-semibold tabular">{money(row.gross_earnings)}</td>
                {columns.deductions.map((col) => (
                  <td key={col.code} className="px-3 py-2 text-right tabular text-[var(--color-critical-600)]">
                    {row.components[col.code] ? money(row.components[col.code]) : '—'}
                  </td>
                ))}
                <td className="px-3 py-2 text-right font-semibold tabular">{money(row.net_pay)}</td>
                {columns.employer.map((col) => (
                  <td key={col.code} className="px-3 py-2 text-right tabular text-[var(--text-secondary)]">
                    {row.components[col.code] ? money(row.components[col.code]) : '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot className="sticky bottom-0 bg-[var(--surface-raised)] shadow-[0_-1px_0_var(--border-subtle)]">
            <tr>
              <td className="sticky left-0 z-10 bg-[var(--surface-raised)] px-4 py-2.5 font-semibold">Total</td>
              <td />
              {columns.earnings.map((col) => (
                <td key={col.code} className="px-3 py-2.5 text-right font-semibold tabular">
                  {money(componentTotals[col.code] ?? 0)}
                </td>
              ))}
              <td className="px-3 py-2.5 text-right font-semibold tabular">{money(totals.gross)}</td>
              {columns.deductions.map((col) => (
                <td key={col.code} className="px-3 py-2.5 text-right font-semibold tabular">
                  {money(componentTotals[col.code] ?? 0)}
                </td>
              ))}
              <td className="px-3 py-2.5 text-right font-semibold tabular">{money(totals.net)}</td>
              {columns.employer.map((col) => (
                <td key={col.code} className="px-3 py-2.5 text-right font-semibold tabular">
                  {money(componentTotals[col.code] ?? 0)}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
