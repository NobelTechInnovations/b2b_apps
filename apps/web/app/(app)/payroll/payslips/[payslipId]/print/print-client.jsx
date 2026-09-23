'use client';

import { useEffect, useState } from 'react';
import { Printer, ArrowLeft, AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { EmptyState, Skeleton } from '@/components/ui/primitives';
import { money, date as fmtDate } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';

/**
 * A payslip on paper.
 *
 * Laid out for A4 and printed from the browser, which produces a real PDF on
 * every platform without a server-side renderer or a headless browser to keep
 * alive. The `print:` rules strip the app chrome so what comes out is the
 * document, not a screenshot of a web page.
 */
export default function PayslipPrint({ payslipId }) {
  const { organization } = useWorkspace();
  const [slip, setSlip] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get(`/payroll/payslips/${payslipId}`)
      .then((r) => setSlip(r.data))
      .catch(() => setSlip(null))
      .finally(() => setLoading(false));
  }, [payslipId]);

  if (loading) return <div className="mx-auto max-w-3xl p-8"><Skeleton className="h-[60vh] w-full" /></div>;
  if (!slip) {
    return (
      <div className="mx-auto max-w-3xl p-8">
        <EmptyState icon={AlertTriangle} title="Payslip not found" />
      </div>
    );
  }

  const employer = slip.employer_details ?? {};
  const employerName = employer.name || organization?.name || 'Your organisation';

  return (
    <>
      <div className="no-print sticky top-0 z-10 flex items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-raised)] px-5 py-3">
        <Link href="/payroll/payslips">
          <Button variant="ghost" icon={ArrowLeft}>Back to payslips</Button>
        </Link>
        <div className="flex-1" />
        <Button variant="primary" icon={Printer} onClick={() => window.print()}>
          Print or save as PDF
        </Button>
      </div>

      <div className="mx-auto my-8 max-w-[820px] bg-white px-10 py-9 text-[#111827] shadow-lg print:my-0 print:max-w-none print:px-0 print:py-0 print:shadow-none">
        {/* ── masthead ─────────────────────────────────────────────────── */}
        <header className="flex items-start justify-between gap-6 border-b-2 border-[#111827] pb-4">
          <div>
            <h1 className="text-lg font-bold tracking-[-0.01em]">{employerName}</h1>
            {employer.address && (
              <p className="mt-1 max-w-sm whitespace-pre-line text-[11px] leading-snug text-[#4b5563]">
                {employer.address}
              </p>
            )}
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5 text-[10px] text-[#6b7280]">
              {employer.pan && <span>PAN {employer.pan}</span>}
              {employer.tan && <span>TAN {employer.tan}</span>}
              {employer.pf_establishment && <span>PF {employer.pf_establishment}</span>}
              {employer.esi_establishment && <span>ESI {employer.esi_establishment}</span>}
            </div>
          </div>
          <div className="text-right">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#6b7280]">
              Payslip
            </p>
            <p className="mt-0.5 text-base font-bold">{slip.label}</p>
            <p className="mt-1 font-mono text-[10px] text-[#6b7280]">{slip.payslip_number}</p>
            {slip.status === 'paid' && slip.paid_at && (
              <p className="mt-2 inline-block rounded border border-[#059669] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[#059669]">
                Paid {fmtDate(slip.paid_at)}
              </p>
            )}
          </div>
        </header>

        {/* ── who and when ─────────────────────────────────────────────── */}
        <section className="grid grid-cols-2 gap-x-10 gap-y-1.5 border-b border-[#e5e7eb] py-4 text-[11px]">
          <Row label="Employee" value={slip.employee_name} strong />
          <Row label="Employee code" value={slip.employee_code} />
          <Row label="Designation" value={slip.designation} />
          <Row label="Department" value={slip.department_name} />
          <Row label="Date of joining" value={slip.joined_on ? fmtDate(slip.joined_on) : null} />
          <Row label="Pay period" value={`${fmtDate(slip.period_start)} – ${fmtDate(slip.period_end)}`} />
          <Row label="PAN" value={slip.pan} mono />
          <Row label="UAN" value={slip.uan} mono />
          {slip.esi_number && <Row label="ESI number" value={slip.esi_number} mono />}
          <Row label="Bank account" value={slip.bank_account} mono />
        </section>

        {/* ── attendance ───────────────────────────────────────────────── */}
        <section className="grid grid-cols-4 gap-4 border-b border-[#e5e7eb] py-3 text-center">
          <Figure label="Days in period" value={slip.days_in_period} />
          <Figure label="Days paid" value={slip.payable_days} />
          <Figure label="Loss of pay" value={slip.lop_days} muted={Number(slip.lop_days) === 0} />
          <Figure label="Overtime hours" value={slip.overtime_hours} muted={Number(slip.overtime_hours) === 0} />
        </section>

        {slip.notes && (
          <p className="mt-3 rounded border border-[#fcd34d] bg-[#fffbeb] px-3 py-1.5 text-[10px] text-[#92400e]">
            {slip.notes}
          </p>
        )}

        {/* ── the money ────────────────────────────────────────────────── */}
        <section className="mt-5 grid grid-cols-2 gap-6">
          <Ledger title="Earnings" lines={slip.earnings} total={slip.gross_earnings} totalLabel="Gross earnings" />
          <Ledger title="Deductions" lines={slip.deductions} total={slip.total_deductions} totalLabel="Total deductions" />
        </section>

        {/* ── net ──────────────────────────────────────────────────────── */}
        <section className="mt-5 border-2 border-[#111827] px-4 py-3">
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-xs font-bold uppercase tracking-[0.1em]">Net pay</span>
            <span className="font-mono text-xl font-bold tabular-nums">{money(slip.net_pay)}</span>
          </div>
          <p className="mt-1 text-[10px] italic text-[#4b5563]">{slip.net_pay_words}</p>
        </section>

        {/* ── employer contributions and YTD ───────────────────────────── */}
        <section className="mt-5 grid grid-cols-2 gap-6">
          {slip.employer?.length > 0 ? (
            <Ledger
              title="Employer contributions"
              subtitle="Paid by the employer, not deducted from you"
              lines={slip.employer}
              total={slip.employer_contrib}
              totalLabel="Total"
            />
          ) : <div />}

          {slip.ytd && (
            <div>
              <h3 className="border-b border-[#111827] pb-1 text-[10px] font-bold uppercase tracking-[0.1em]">
                Year to date
              </h3>
              <p className="mt-1 text-[9px] text-[#6b7280]">
                Across {slip.ytd.months} {Number(slip.ytd.months) === 1 ? 'month' : 'months'} of this financial year
              </p>
              <dl className="mt-2 space-y-1 text-[11px]">
                <LedgerRow label="Gross" value={slip.ytd.gross} />
                <LedgerRow label="Deductions" value={slip.ytd.deductions} />
                <div className="flex justify-between border-t border-[#e5e7eb] pt-1 font-semibold">
                  <span>Net</span>
                  <span className="font-mono tabular-nums">{money(slip.ytd.net)}</span>
                </div>
              </dl>
            </div>
          )}
        </section>

        <footer className="mt-8 border-t border-[#e5e7eb] pt-3 text-[9px] leading-relaxed text-[#6b7280]">
          <p>
            This is a computer-generated payslip and does not require a signature. Every figure above
            is derived from the attendance and salary on record for {slip.label.toLowerCase()}.
          </p>
          <p className="mt-1">
            Cost to company for this period: <strong>{money(slip.ctc_for_period)}</strong> —
            gross earnings plus the employer contributions shown.
          </p>
        </footer>
      </div>

      <style jsx global>{`
        @media print {
          @page { size: A4; margin: 14mm; }
          .no-print, aside, header[data-app-header] { display: none !important; }
          body { background: #fff !important; }
          /* Never split a ledger or the net-pay box across two sheets. */
          section, table { break-inside: avoid; }
        }
      `}</style>
    </>
  );
}

function Row({ label, value, strong, mono }) {
  if (!value) return null;
  return (
    <div className="flex gap-2">
      <span className="w-32 shrink-0 text-[#6b7280]">{label}</span>
      <span className={`${strong ? 'font-semibold' : ''} ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}

function Figure({ label, value, muted }) {
  return (
    <div>
      <p className="text-[9px] uppercase tracking-[0.08em] text-[#6b7280]">{label}</p>
      <p className={`mt-0.5 font-mono text-sm font-semibold tabular-nums ${muted ? 'text-[#9ca3af]' : ''}`}>
        {Number(value)}
      </p>
    </div>
  );
}

function Ledger({ title, subtitle, lines, total, totalLabel }) {
  return (
    <div>
      <h3 className="border-b border-[#111827] pb-1 text-[10px] font-bold uppercase tracking-[0.1em]">
        {title}
      </h3>
      {subtitle && <p className="mt-1 text-[9px] text-[#6b7280]">{subtitle}</p>}
      <dl className="mt-2 space-y-1 text-[11px]">
        {lines.map((line) => (
          <div key={`${line.kind}-${line.code}`}>
            <LedgerRow label={line.name} value={line.amount} />
            {line.basis && <p className="text-[9px] leading-tight text-[#9ca3af]">{line.basis}</p>}
          </div>
        ))}
        <div className="flex justify-between border-t border-[#e5e7eb] pt-1 font-semibold">
          <span>{totalLabel}</span>
          <span className="font-mono tabular-nums">{money(total)}</span>
        </div>
      </dl>
    </div>
  );
}

function LedgerRow({ label, value }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="truncate">{label}</dt>
      <dd className="shrink-0 font-mono tabular-nums">{money(value)}</dd>
    </div>
  );
}
