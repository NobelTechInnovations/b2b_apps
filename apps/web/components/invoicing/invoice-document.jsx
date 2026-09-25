'use client';

import { money, date as fmtDate } from '@/lib/format';

/**
 * The invoice document itself.
 *
 * One component, used both by the printable page and by the live preview in
 * the designer — so what somebody designs is exactly what prints, rather than
 * two renderers that drift apart. It draws with literal hex colours rather
 * than theme variables: this is a sheet of paper, not a screen, and it must
 * look the same in dark mode as in light.
 */

const STATUS_STAMP = {
  draft: { label: 'Draft', colour: '#6b7280' },
  overdue: { label: 'Overdue', colour: '#dc2626' },
  paid: { label: 'Paid', colour: '#059669' },
  partially_paid: { label: 'Part paid', colour: '#d97706' },
  void: { label: 'Void', colour: '#dc2626' },
};

export function InvoiceDocumentBody({ doc }) {
  const { invoice, lines, payments, template, amount_in_words: words, tax_groups: taxGroups } = doc;
  const accent = template.accent ?? '#4f46e5';
  const layout = template.layout ?? 'classic';
  const stamp = STATUS_STAMP[invoice.status];

  const seller = {
    name: template.seller_name || doc.workspace?.name || 'Your business',
    address: template.seller_address,
    gstin: template.seller_gstin,
    pan: template.seller_pan,
    email: template.seller_email,
    phone: template.seller_phone,
    website: template.seller_website,
  };

  const interstate = lines.some((l) => Number(l.igst_amount) > 0);

  return (
    <article className="text-[11px] leading-normal">
      {/* ── masthead ───────────────────────────────────────────────────── */}
      <header
        className={layout === 'modern' ? 'px-6 py-5' : 'pb-5'}
        style={
          layout === 'modern' && template.accent_header
            ? { background: accent, color: '#fff', margin: '-2.25rem -2.5rem 1.5rem', padding: '1.75rem 2.5rem' }
            : layout === 'classic'
              ? { borderBottom: `3px solid ${accent}` }
              : { borderBottom: '1px solid #e5e7eb' }
        }
      >
        <div className="flex items-start justify-between gap-8">
          <div className="min-w-0">
            {template.logo_url && (

              <img src={template.logo_url} alt="" className="mb-2 max-h-14 max-w-[180px] object-contain" />
            )}
            <h1 className="text-base font-bold tracking-[-0.01em]">{seller.name}</h1>
            {seller.address && (
              <p className="mt-1 max-w-[16rem] whitespace-pre-line text-[10px] leading-snug opacity-80">
                {seller.address}
              </p>
            )}
            <div className="mt-1.5 flex flex-col gap-0.5 text-[10px] opacity-75">
              {seller.gstin && <span>GSTIN {seller.gstin}</span>}
              {seller.pan && <span>PAN {seller.pan}</span>}
              {seller.email && <span>{seller.email}</span>}
              {seller.phone && <span>{seller.phone}</span>}
              {seller.website && <span>{seller.website}</span>}
            </div>
          </div>

          <div className="shrink-0 text-right">
            <p
              className="text-[11px] font-bold uppercase tracking-[0.18em]"
              style={layout === 'modern' && template.accent_header ? undefined : { color: accent }}
            >
              {invoice.status === 'draft' ? 'Draft invoice' : 'Tax invoice'}
            </p>
            <p className="mt-1 font-mono text-base font-bold">
              {invoice.number ?? '— not yet issued —'}
            </p>
            <dl className="mt-3 space-y-0.5 text-[10px]">
              <MetaRow label="Date" value={invoice.issue_date ? fmtDate(invoice.issue_date) : '—'} />
              <MetaRow label="Due" value={invoice.due_date ? fmtDate(invoice.due_date) : '—'} />
              {invoice.reference && <MetaRow label="Ref" value={invoice.reference} />}
            </dl>
            {stamp && (
              <p
                className="mt-2 inline-block rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
                style={{ color: stamp.colour, borderColor: stamp.colour }}
              >
                {stamp.label}
              </p>
            )}
          </div>
        </div>
      </header>

      {/* ── who it is for ──────────────────────────────────────────────── */}
      <section className="grid grid-cols-2 gap-8 py-4">
        <div>
          <p className="text-[9px] font-bold uppercase tracking-[0.12em] text-[#6b7280]">Billed to</p>
          <p className="mt-1 text-[13px] font-semibold">{invoice.customer_name}</p>
          {invoice.billing_address && (
            <p className="mt-0.5 whitespace-pre-line text-[10px] leading-snug text-[#4b5563]">
              {formatAddress(invoice.billing_address)}
            </p>
          )}
          <div className="mt-1 flex flex-col gap-0.5 text-[10px] text-[#6b7280]">
            {invoice.customer_gstin && <span>GSTIN {invoice.customer_gstin}</span>}
            {invoice.place_of_supply && <span>Place of supply: {invoice.place_of_supply}</span>}
          </div>
        </div>

        <div className="text-right">
          <p className="text-[9px] font-bold uppercase tracking-[0.12em] text-[#6b7280]">
            Amount {Number(invoice.amount_due) > 0 ? 'due' : 'payable'}
          </p>
          <p className="mt-1 font-mono text-2xl font-bold tabular-nums" style={{ color: accent }}>
            {money(Number(invoice.amount_due) > 0 ? invoice.amount_due : invoice.total, invoice.currency)}
          </p>
          {Number(invoice.amount_paid) > 0 && (
            <p className="mt-0.5 text-[10px] text-[#6b7280]">
              {money(invoice.amount_paid, invoice.currency)} of {money(invoice.total, invoice.currency)} received
            </p>
          )}
        </div>
      </section>

      {/* ── the lines ──────────────────────────────────────────────────── */}
      <table className="w-full border-collapse">
        <thead>
          <tr style={{ background: layout === 'minimal' ? '#f9fafb' : accent, color: layout === 'minimal' ? '#111827' : '#fff' }}>
            <th className="px-2.5 py-2 text-left text-[9px] font-bold uppercase tracking-[0.08em]">#</th>
            <th className="px-2.5 py-2 text-left text-[9px] font-bold uppercase tracking-[0.08em]">Description</th>
            {template.show_hsn && (
              <th className="px-2.5 py-2 text-left text-[9px] font-bold uppercase tracking-[0.08em]">HSN/SAC</th>
            )}
            <th className="px-2.5 py-2 text-right text-[9px] font-bold uppercase tracking-[0.08em]">Qty</th>
            <th className="px-2.5 py-2 text-right text-[9px] font-bold uppercase tracking-[0.08em]">Rate</th>
            {lines.some((l) => Number(l.discount_percent) > 0) && (
              <th className="px-2.5 py-2 text-right text-[9px] font-bold uppercase tracking-[0.08em]">Disc.</th>
            )}
            <th className="px-2.5 py-2 text-right text-[9px] font-bold uppercase tracking-[0.08em]">Taxable</th>
            <th className="px-2.5 py-2 text-right text-[9px] font-bold uppercase tracking-[0.08em]">Tax</th>
            <th className="px-2.5 py-2 text-right text-[9px] font-bold uppercase tracking-[0.08em]">Amount</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, index) => (
            <tr key={line.id} className="border-b border-[#e5e7eb]">
              <td className="px-2.5 py-2 align-top text-[#9ca3af]">{index + 1}</td>
              <td className="px-2.5 py-2 align-top">
                <p className="font-medium">{line.description}</p>
              </td>
              {template.show_hsn && (
                <td className="px-2.5 py-2 align-top font-mono text-[10px] text-[#6b7280]">
                  {line.hsn_sac ?? '—'}
                </td>
              )}
              <td className="px-2.5 py-2 text-right align-top tabular-nums">
                {trimZeros(line.quantity)}
                {line.unit && <span className="ml-0.5 text-[9px] text-[#9ca3af]">{line.unit}</span>}
              </td>
              <td className="px-2.5 py-2 text-right align-top tabular-nums">
                {money(line.unit_price, invoice.currency)}
              </td>
              {lines.some((l) => Number(l.discount_percent) > 0) && (
                <td className="px-2.5 py-2 text-right align-top tabular-nums text-[#6b7280]">
                  {Number(line.discount_percent) > 0 ? `${Number(line.discount_percent)}%` : '—'}
                </td>
              )}
              <td className="px-2.5 py-2 text-right align-top tabular-nums">
                {money(line.line_taxable, invoice.currency)}
              </td>
              <td className="px-2.5 py-2 text-right align-top tabular-nums text-[#6b7280]">
                {Number(line.tax_rate) > 0 ? `${Number(line.tax_rate)}%` : '—'}
              </td>
              <td className="px-2.5 py-2 text-right align-top font-medium tabular-nums">
                {money(line.line_total, invoice.currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* ── totals ─────────────────────────────────────────────────────── */}
      <section className="mt-4 flex justify-end">
        <dl className="w-[17rem] space-y-1 text-[11px]">
          <TotalRow label="Subtotal" value={money(invoice.subtotal, invoice.currency)} />
          {Number(invoice.discount_total) > 0 && (
            <TotalRow label="Discount" value={`− ${money(invoice.discount_total, invoice.currency)}`} />
          )}
          <TotalRow label="Taxable value" value={money(invoice.taxable_total, invoice.currency)} />

          {Number(invoice.cgst_total) > 0 && (
            <TotalRow label="CGST" value={money(invoice.cgst_total, invoice.currency)} muted />
          )}
          {Number(invoice.sgst_total) > 0 && (
            <TotalRow label="SGST" value={money(invoice.sgst_total, invoice.currency)} muted />
          )}
          {Number(invoice.igst_total) > 0 && (
            <TotalRow label="IGST" value={money(invoice.igst_total, invoice.currency)} muted />
          )}
          {Number(invoice.round_off) !== 0 && (
            <TotalRow label="Round off" value={money(invoice.round_off, invoice.currency)} muted />
          )}

          <div
            className="flex justify-between gap-3 px-2.5 py-2 text-[13px] font-bold"
            style={{ background: accent, color: '#fff' }}
          >
            <dt>Total</dt>
            <dd className="font-mono tabular-nums">{money(invoice.total, invoice.currency)}</dd>
          </div>

          {Number(invoice.amount_paid) > 0 && (
            <>
              <TotalRow label="Received" value={`− ${money(invoice.amount_paid, invoice.currency)}`} muted />
              <div className="flex justify-between gap-3 border-t-2 border-[#111827] pt-1 font-bold">
                <dt>Balance due</dt>
                <dd className="font-mono tabular-nums">{money(invoice.amount_due, invoice.currency)}</dd>
              </div>
            </>
          )}
        </dl>
      </section>

      {template.show_amount_words && words && (
        <p className="mt-3 border-y border-[#e5e7eb] py-2 text-[10px]">
          <span className="font-semibold">Amount in words: </span>
          <span className="italic">{words}</span>
        </p>
      )}

      {/* ── GST summary ────────────────────────────────────────────────── */}
      {template.show_tax_breakdown && taxGroups?.length > 0 && Number(invoice.tax_total) > 0 && (
        <section className="mt-4">
          <p className="mb-1 text-[9px] font-bold uppercase tracking-[0.12em] text-[#6b7280]">
            Tax summary
          </p>
          <table className="w-full border-collapse text-[10px]">
            <thead>
              <tr className="border-y border-[#e5e7eb] bg-[#f9fafb]">
                <th className="px-2 py-1 text-left font-semibold">Rate</th>
                <th className="px-2 py-1 text-right font-semibold">Taxable value</th>
                {interstate ? (
                  <th className="px-2 py-1 text-right font-semibold">IGST</th>
                ) : (
                  <>
                    <th className="px-2 py-1 text-right font-semibold">CGST</th>
                    <th className="px-2 py-1 text-right font-semibold">SGST</th>
                  </>
                )}
                <th className="px-2 py-1 text-right font-semibold">Total tax</th>
              </tr>
            </thead>
            <tbody>
              {taxGroups.map((group) => (
                <tr key={group.rate} className="border-b border-[#f3f4f6]">
                  <td className="px-2 py-1">{group.rate}%</td>
                  <td className="px-2 py-1 text-right tabular-nums">{money(group.taxable, invoice.currency)}</td>
                  {interstate ? (
                    <td className="px-2 py-1 text-right tabular-nums">{money(group.igst, invoice.currency)}</td>
                  ) : (
                    <>
                      <td className="px-2 py-1 text-right tabular-nums">{money(group.cgst, invoice.currency)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{money(group.sgst, invoice.currency)}</td>
                    </>
                  )}
                  <td className="px-2 py-1 text-right font-medium tabular-nums">
                    {money(group.total, invoice.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* ── payments received ──────────────────────────────────────────── */}
      {payments?.length > 0 && (
        <section className="mt-4">
          <p className="mb-1 text-[9px] font-bold uppercase tracking-[0.12em] text-[#6b7280]">
            Payments received
          </p>
          <ul className="space-y-0.5 text-[10px]">
            {payments.map((payment) => (
              <li key={payment.number} className="flex justify-between gap-3 text-[#4b5563]">
                <span>
                  {fmtDate(payment.received_on)} · {payment.method}
                  {payment.reference && ` · ${payment.reference}`}
                </span>
                <span className="font-mono tabular-nums">{money(payment.amount, invoice.currency)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── the fine print ─────────────────────────────────────────────── */}
      <section className="mt-6 grid grid-cols-2 gap-8">
        <div className="space-y-4">
          {template.show_bank_details && (template.bank_account || template.upi_id) && (
            <div>
              <p className="mb-1 text-[9px] font-bold uppercase tracking-[0.12em] text-[#6b7280]">
                Payment details
              </p>
              <dl className="space-y-0.5 text-[10px]">
                {template.bank_name && <MetaRow label="Bank" value={template.bank_name} align="left" />}
                {template.bank_account && <MetaRow label="Account" value={template.bank_account} align="left" mono />}
                {template.bank_ifsc && <MetaRow label="IFSC" value={template.bank_ifsc} align="left" mono />}
                {template.bank_branch && <MetaRow label="Branch" value={template.bank_branch} align="left" />}
                {template.upi_id && <MetaRow label="UPI" value={template.upi_id} align="left" mono />}
              </dl>
            </div>
          )}

          {(invoice.terms || template.terms) && (
            <div>
              <p className="mb-1 text-[9px] font-bold uppercase tracking-[0.12em] text-[#6b7280]">
                Terms
              </p>
              <p className="whitespace-pre-line text-[10px] leading-snug text-[#4b5563]">
                {invoice.terms || template.terms}
              </p>
            </div>
          )}

          {invoice.notes && (
            <div>
              <p className="mb-1 text-[9px] font-bold uppercase tracking-[0.12em] text-[#6b7280]">Notes</p>
              <p className="whitespace-pre-line text-[10px] leading-snug text-[#4b5563]">{invoice.notes}</p>
            </div>
          )}
        </div>

        {template.show_signature && (
          <div className="flex flex-col items-end justify-end text-right">
            {template.signature_url && (

              <img src={template.signature_url} alt="" className="mb-1 max-h-12 object-contain" />
            )}
            <div className="w-40 border-t border-[#9ca3af] pt-1">
              <p className="text-[10px] font-semibold">{template.signature_name || 'Authorised signatory'}</p>
              <p className="text-[9px] text-[#6b7280]">For {seller.name}</p>
            </div>
          </div>
        )}
      </section>

      <footer className="mt-6 border-t border-[#e5e7eb] pt-2.5 text-center text-[9px] text-[#6b7280]">
        {template.footer_note && <p>{template.footer_note}</p>}
        <p className="mt-0.5">
          This is a computer-generated invoice
          {template.show_signature ? '' : ' and does not require a signature'}.
        </p>
      </footer>
    </article>
  );
}

function MetaRow({ label, value, align = 'right', mono }) {
  return (
    <div className={`flex gap-2 ${align === 'right' ? 'justify-end' : ''}`}>
      <dt className="text-[#6b7280]">{label}</dt>
      <dd className={`font-medium ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  );
}

function TotalRow({ label, value, muted }) {
  return (
    <div className={`flex justify-between gap-3 px-2.5 ${muted ? 'text-[#6b7280]' : ''}`}>
      <dt>{label}</dt>
      <dd className="font-mono tabular-nums">{value}</dd>
    </div>
  );
}

/** Quantities carry three decimals in the database; nobody wants "2.000". */
const trimZeros = (value) => String(Number(value ?? 0));

function formatAddress(address) {
  if (!address) return '';
  if (typeof address === 'string') return address;
  return [address.line1, address.line2, [address.city, address.state].filter(Boolean).join(', '), address.postal_code, address.country]
    .filter(Boolean)
    .join('\n');
}
