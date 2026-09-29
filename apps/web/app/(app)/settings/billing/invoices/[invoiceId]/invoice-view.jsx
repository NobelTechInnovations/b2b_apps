'use client';

import { Printer } from 'lucide-react';
import { money, date } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/primitives';

/** A platform invoice, laid out to print (the browser produces the PDF). */
export default function InvoiceView({ invoice, organization }) {
  const currency = invoice.currency ?? 'INR';
  return (
    <div className="mx-auto max-w-3xl space-y-4 print:max-w-none">
      <div className="flex justify-end print:hidden">
        <Button icon={Printer} onClick={() => window.print()}>Print / save as PDF</Button>
      </div>
      <article className="rounded-[var(--radius-xl)] border border-[var(--border-default)] bg-[var(--surface-raised)] p-8 print:border-0 print:p-0">
        <header className="flex flex-wrap items-start justify-between gap-6 border-b border-[var(--border-subtle)] pb-6">
          <div>
            <p className="text-xl font-semibold tracking-[-0.02em]">Tax invoice</p>
            <p className="mt-1 text-sm text-[var(--text-secondary)]">{invoice.number}</p>
          </div>
          <Badge tone={invoice.status === 'paid' ? 'positive' : 'caution'}>{invoice.status}</Badge>
        </header>

        <section className="grid gap-6 py-6 text-sm sm:grid-cols-2">
          <div>
            <p className="text-xs uppercase tracking-wide text-[var(--text-tertiary)]">Billed to</p>
            <p className="mt-1 font-medium">{organization?.legal_name ?? organization?.name}</p>
            {organization?.tax_id && <p className="text-[var(--text-secondary)]">GSTIN {organization.tax_id}</p>}
          </div>
          <div className="sm:text-right">
            <p><span className="text-[var(--text-tertiary)]">Issued</span> {date(invoice.created_at)}</p>
            <p><span className="text-[var(--text-tertiary)]">Due</span> {date(invoice.due_at)}</p>
            <p><span className="text-[var(--text-tertiary)]">Period</span> {date(invoice.period_start)} – {date(invoice.period_end)}</p>
            {invoice.paid_at && <p><span className="text-[var(--text-tertiary)]">Paid</span> {date(invoice.paid_at)}</p>}
          </div>
        </section>

        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--border-default)] text-left text-xs text-[var(--text-tertiary)]">
              <th className="py-2">Description</th>
              <th className="py-2 text-right">Qty</th>
              <th className="py-2 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {(invoice.lines ?? []).map((line) => (
              <tr key={line.slug} className="border-b border-[var(--border-subtle)] align-top">
                <td className="py-2.5">
                  <p className="font-medium">{line.label}</p>
                  {line.detail && <p className="text-xs text-[var(--text-tertiary)]">{line.detail}</p>}
                </td>
                <td className="py-2.5 text-right tabular">{line.quantity}</td>
                <td className="py-2.5 text-right tabular">{Number(line.amount) === 0 ? 'Included' : money(line.amount, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <dl className="ml-auto mt-4 w-64 space-y-1.5 text-sm">
          <div className="flex justify-between"><dt className="text-[var(--text-secondary)]">Subtotal</dt><dd className="tabular">{money(invoice.subtotal, currency)}</dd></div>
          <div className="flex justify-between"><dt className="text-[var(--text-secondary)]">GST</dt><dd className="tabular">{money(invoice.tax_amount, currency)}</dd></div>
          <div className="flex justify-between border-t border-[var(--border-default)] pt-2 text-md font-semibold"><dt>Total</dt><dd className="tabular">{money(invoice.total, currency)}</dd></div>
        </dl>

        {invoice.payments?.some((p) => p.status === 'captured') && (
          <p className="mt-6 text-xs text-[var(--text-tertiary)]">
            Paid via {invoice.payments.find((p) => p.status === 'captured').provider}
            {' · '}reference {invoice.payments.find((p) => p.status === 'captured').provider_payment_id}
          </p>
        )}
      </article>
    </div>
  );
}
