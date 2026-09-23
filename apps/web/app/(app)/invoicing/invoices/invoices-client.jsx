'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import {
  Plus, FileText, Send, Ban, Trash2, IndianRupee, Percent, Receipt, AlertTriangle, Printer,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { money, date, relativeTime } from '@/lib/format';
import { Can, useWorkspace } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Drawer, DetailGrid } from '@/components/data/drawer';
import { ListToolbar, Pagination } from '@/components/data/list-shell';
import { Table, THead, TBody, TH, TR, TD, TableSkeleton } from '@/components/ui/table';
import { Badge, Card, EmptyState, PageHeader, Alert, Skeleton } from '@/components/ui/primitives';

const STATUS_TONE = {
  draft: 'neutral', issued: 'info', partially_paid: 'caution',
  paid: 'positive', overdue: 'critical', void: 'neutral',
};

const FILTERS = [
  {
    key: 'status',
    label: 'Status',
    options: ['draft', 'issued', 'partially_paid', 'paid', 'overdue', 'void'].map((v) => ({
      value: v, label: v.replace('_', ' ').replace(/^\w/, (m) => m.toUpperCase()),
    })),
  },
];

const blankLine = () => ({
  description: '', quantity: 1, unit_price: '', tax_rate: 18, discount_percent: 0, hsn_sac: '',
});

export default function InvoicesClient() {
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const { can } = useWorkspace();

  const [invoices, setInvoices] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({});
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState(null);

  useEffect(() => {
    if (params.get('new') === '1') setCreating(true);
    const open = params.get('open');
    if (open) setSelectedId(open);
  }, [params]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.get('/invoicing/invoices', {
        query: { ...filters, q: search || undefined, page, limit: 25 },
      });
      setInvoices(response.data);
      setMeta(response.meta);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load invoices.');
    } finally {
      setLoading(false);
    }
  }, [filters, search, page]);

  useEffect(() => {
    const timer = setTimeout(load, search ? 280 : 0);
    return () => clearTimeout(timer);
  }, [load, search]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Invoices"
        description="Drafts can be edited freely. Once issued, an invoice is a legal document."
        actions={
          <Can permission="invoicing.invoices.create">
            <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>New invoice</Button>
          </Can>
        }
      />

      <ListToolbar
        search={search}
        onSearch={(v) => { setSearch(v); setPage(1); }}
        searchPlaceholder="Search number, customer or reference…"
        filters={FILTERS}
        values={filters}
        onFilter={(key, value) => {
          setFilters((c) => {
            const next = { ...c };
            if (value === undefined) delete next[key]; else next[key] = value;
            return next;
          });
          setPage(1);
        }}
        onClear={() => { setFilters({}); setPage(1); }}
      />

      {error && <Alert tone="critical">{error}</Alert>}

      {loading ? (
        <TableSkeleton rows={6} columns={6} />
      ) : invoices.length === 0 ? (
        <Card>
          <EmptyState
            icon={FileText}
            title={search || Object.keys(filters).length ? 'No invoices match' : 'No invoices yet'}
            description={
              search || Object.keys(filters).length
                ? 'Try a different search or clear your filters.'
                : 'Raise one here, or win a deal in CRM and a draft appears automatically.'
            }
            action={
              can('invoicing.invoices.create') && (
                <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
                  Create an invoice
                </Button>
              )
            }
          />
        </Card>
      ) : (
        <>
          <Table>
            <THead>
              <tr>
                <TH>Invoice</TH>
                <TH>Customer</TH>
                <TH>Issued</TH>
                <TH>Due</TH>
                <TH align="right">Total</TH>
                <TH align="right">Outstanding</TH>
                <TH>Status</TH>
              </tr>
            </THead>
            <TBody>
              {invoices.map((invoice) => (
                <TR key={invoice.id} onClick={() => setSelectedId(invoice.id)}>
                  <TD>
                    <p className="flex items-center gap-2 font-medium tabular">
                      {invoice.number ?? <span className="text-[var(--text-tertiary)]">Draft</span>}
                      {invoice.source === 'deal_won' && <Badge size="sm" tone="brand">Auto</Badge>}
                    </p>
                  </TD>
                  <TD className="text-[var(--text-secondary)]">{invoice.customer_name}</TD>
                  <TD className="text-[var(--text-secondary)]">
                    {invoice.issue_date ? date(invoice.issue_date) : '—'}
                  </TD>
                  <TD className={cn(invoice.is_overdue && 'font-medium text-[var(--color-critical-600)]')}>
                    {invoice.due_date ? date(invoice.due_date) : '—'}
                  </TD>
                  <TD align="right" numeric className="font-medium">
                    {money(invoice.total, invoice.currency)}
                  </TD>
                  <TD align="right" numeric className="text-[var(--text-secondary)]">
                    {Number(invoice.amount_due) > 0 ? money(invoice.amount_due, invoice.currency) : '—'}
                  </TD>
                  <TD>
                    <Badge size="sm" tone={STATUS_TONE[invoice.status]}>
                      {invoice.status.replace('_', ' ')}
                    </Badge>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination meta={meta} onPage={setPage} />
        </>
      )}

      <InvoiceDrawer
        invoiceId={selectedId}
        onClose={() => { setSelectedId(null); router.replace('/invoicing/invoices'); }}
        onChanged={load}
      />

      <CreateInvoiceModal
        open={creating}
        onClose={() => { setCreating(false); router.replace('/invoicing/invoices'); }}
        onCreated={load}
      />
    </div>
  );
}

function InvoiceDrawer({ invoiceId, onClose, onChanged }) {
  const toast = useToast();
  const [invoice, setInvoice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [paying, setPaying] = useState(false);

  const load = useCallback(() => {
    if (!invoiceId) { setInvoice(null); return; }
    api.get(`/invoicing/invoices/${invoiceId}`).then((r) => setInvoice(r.data)).catch(() => setInvoice(null));
  }, [invoiceId]);

  useEffect(() => { load(); }, [load]);

  async function issue() {
    setBusy(true);
    try {
      const response = await api.post(`/invoicing/invoices/${invoiceId}/issue`, {});
      toast.success(`Issued as ${response.data.number}`, {
        description: `Due ${date(response.data.due_date)}.`,
      });
      load();
      onChanged?.();
    } catch (err) {
      toast.error('Could not issue that invoice', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  if (!invoiceId) return null;

  const interstate = invoice?.is_interstate;

  return (
    <>
      <Drawer
        open
        onClose={onClose}
        width="lg"
        title={invoice?.number ?? 'Draft invoice'}
        subtitle={invoice?.customer_name}
        badge={invoice && <Badge size="sm" tone={STATUS_TONE[invoice.status]}>{invoice.status.replace('_', ' ')}</Badge>}
        footer={
          invoice && (
            <>
              <Link href={`/invoicing/invoices/${invoice.id}/print`} target="_blank">
                <Button variant="secondary" icon={Printer}>
                  {invoice.status === 'draft' ? 'Preview document' : 'Print or send'}
                </Button>
              </Link>
              <div className="flex-1" />
              {invoice.status === 'draft' && (
                <Can permission="invoicing.invoices.send">
                  <Button variant="primary" icon={Send} loading={busy} onClick={issue}>
                    Issue invoice
                  </Button>
                </Can>
              )}
              {['issued', 'partially_paid', 'overdue'].includes(invoice.status) && (
                <Can permission="invoicing.payments.record">
                  <Button variant="primary" icon={IndianRupee} onClick={() => setPaying(true)}>
                    Record payment
                  </Button>
                </Can>
              )}
            </>
          )
        }
      >
        {!invoice ? (
          <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
        ) : (
          <div className="space-y-6">
            {invoice.source === 'deal_won' && (
              <Alert tone="info" icon={Receipt}>
                Raised automatically when a deal was won in CRM. Review the lines, then issue it.
              </Alert>
            )}

            {invoice.is_overdue && (
              <Alert tone="critical" icon={AlertTriangle}>
                Overdue since {date(invoice.due_date)} · {money(invoice.amount_due, invoice.currency)} outstanding.
              </Alert>
            )}

            <div className="panel p-4">
              <p className="text-xs text-[var(--text-tertiary)]">Invoice total</p>
              <p className="mt-1 text-2xl font-semibold tabular tracking-[-0.025em]">
                {money(invoice.total, invoice.currency)}
              </p>
              {Number(invoice.amount_paid) > 0 && (
                <p className="mt-1 text-xs text-[var(--text-secondary)]">
                  {money(invoice.amount_paid, invoice.currency)} received ·{' '}
                  {money(invoice.amount_due, invoice.currency)} outstanding
                </p>
              )}
            </div>

            <DetailGrid
              items={[
                { label: 'Customer', value: invoice.customer_name },
                { label: 'GSTIN', value: invoice.customer_gstin },
                { label: 'Place of supply', value: invoice.place_of_supply },
                { label: 'Supply type', value: interstate ? 'Inter-state (IGST)' : 'Intra-state (CGST + SGST)' },
                { label: 'Issue date', value: invoice.issue_date ? date(invoice.issue_date) : 'Not issued' },
                { label: 'Due date', value: invoice.due_date ? date(invoice.due_date) : '—' },
                { label: 'Reference', value: invoice.reference },
                { label: 'Notes', value: invoice.notes, full: true },
              ]}
            />

            {/* ── lines ─────────────────────────────────────────────────── */}
            <div>
              <h3 className="mb-2 text-sm font-medium text-[var(--text-secondary)]">Lines</h3>
              <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)]">
                <table className="w-full text-sm">
                  <thead className="bg-[var(--surface-sunken)]">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-medium text-[var(--text-tertiary)]">Description</th>
                      <th className="px-3 py-2 text-right text-xs font-medium text-[var(--text-tertiary)]">Qty</th>
                      <th className="px-3 py-2 text-right text-xs font-medium text-[var(--text-tertiary)]">Rate</th>
                      <th className="px-3 py-2 text-right text-xs font-medium text-[var(--text-tertiary)]">Tax</th>
                      <th className="px-3 py-2 text-right text-xs font-medium text-[var(--text-tertiary)]">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoice.lines.map((line) => (
                      <tr key={line.id} className="border-t border-[var(--border-subtle)]">
                        <td className="px-3 py-2">
                          {line.description}
                          {line.hsn_sac && (
                            <span className="ml-1.5 text-xs text-[var(--text-tertiary)]">HSN {line.hsn_sac}</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular">{Number(line.quantity)}</td>
                        <td className="px-3 py-2 text-right tabular">{money(line.unit_price)}</td>
                        <td className="px-3 py-2 text-right tabular text-[var(--text-secondary)]">
                          {Number(line.tax_rate)}%
                        </td>
                        <td className="px-3 py-2 text-right tabular font-medium">{money(line.line_total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* ── totals ────────────────────────────────────────────────── */}
            <div className="ml-auto max-w-xs space-y-1.5 text-sm">
              <Row label="Subtotal" value={money(invoice.subtotal)} />
              {Number(invoice.discount_total) > 0 && (
                <Row label="Discount" value={`− ${money(invoice.discount_total)}`} />
              )}
              <Row label="Taxable value" value={money(invoice.taxable_total)} />
              {interstate ? (
                <Row label="IGST" value={money(invoice.igst_total)} />
              ) : (
                <>
                  <Row label="CGST" value={money(invoice.cgst_total)} />
                  <Row label="SGST" value={money(invoice.sgst_total)} />
                </>
              )}
              {Number(invoice.round_off) !== 0 && (
                <Row label="Round off" value={money(invoice.round_off)} />
              )}
              <div className="flex justify-between border-t border-[var(--border-subtle)] pt-2 text-md font-semibold">
                <span>Total</span>
                <span className="tabular">{money(invoice.total, invoice.currency)}</span>
              </div>
            </div>

            {invoice.payments?.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-medium text-[var(--text-secondary)]">Payments received</h3>
                <ul className="space-y-2">
                  {invoice.payments.map((payment) => (
                    <li key={payment.id} className="panel flex items-center justify-between gap-3 px-3 py-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-base tabular">{payment.payment_number}</p>
                        <p className="text-xs text-[var(--text-tertiary)]">
                          {payment.method.replace('_', ' ')} · {date(payment.received_on)}
                          {payment.reference ? ` · ${payment.reference}` : ''}
                        </p>
                      </div>
                      <span className="shrink-0 text-sm font-medium tabular">{money(payment.amount)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Drawer>

      <RecordPaymentModal
        open={paying}
        invoice={invoice}
        onClose={() => setPaying(false)}
        onRecorded={() => { setPaying(false); load(); onChanged?.(); }}
      />
    </>
  );
}

const Row = ({ label, value }) => (
  <div className="flex justify-between text-[var(--text-secondary)]">
    <span>{label}</span>
    <span className="tabular">{value}</span>
  </div>
);

function RecordPaymentModal({ open, invoice, onClose, onRecorded }) {
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('bank_transfer');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open && invoice) { setAmount(String(invoice.amount_due)); setError(null); }
  }, [open, invoice]);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await api.post('/invoicing/payments', {
        amount: Number(amount).toFixed(2),
        method,
        reference: reference || undefined,
        customer_id: invoice.customer_id ?? undefined,
        allocations: [{ invoice_id: invoice.id, amount: Number(amount).toFixed(2) }],
      });
      const settled = response.data.settled?.[0];
      toast.success('Payment recorded', {
        description: settled?.status === 'paid'
          ? `${invoice.number} is now fully paid.`
          : `${money(settled?.amount_due)} still outstanding.`,
      });
      onRecorded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record that payment.');
    } finally {
      setBusy(false);
    }
  }

  if (!invoice) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Record payment for ${invoice.number}`}
      description={`${money(invoice.amount_due, invoice.currency)} outstanding.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy} icon={IndianRupee}>
            Record payment
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert tone="critical">{error}</Alert>}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Amount received" required hint="Part payments are fine.">
            {(p) => (
              <Input {...p} type="number" min="0.01" step="0.01" max={invoice.amount_due}
                value={amount} onChange={(e) => setAmount(e.target.value)} required data-autofocus />
            )}
          </Field>
          <Field label="Method">
            {(p) => (
              <Select {...p} value={method} onChange={(e) => setMethod(e.target.value)}>
                {['bank_transfer', 'upi', 'cheque', 'cash', 'card', 'other'].map((m) => (
                  <option key={m} value={m}>{m.replace('_', ' ')}</option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <Field label="Reference" hint="UTR, cheque number, transaction id.">
          {(p) => <Input {...p} value={reference} onChange={(e) => setReference(e.target.value)} />}
        </Field>
      </form>
    </Modal>
  );
}

function CreateInvoiceModal({ open, onClose, onCreated }) {
  const toast = useToast();
  const [customers, setCustomers] = useState([]);
  const [form, setForm] = useState({ terms_days: 30 });
  const [lines, setLines] = useState([blankLine()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    api.get('/invoicing/customers', { query: { limit: 100 } })
      .then((r) => setCustomers(r.data)).catch(() => setCustomers([]));
    setForm({ terms_days: 30 });
    setLines([blankLine()]);
    setError(null);
  }, [open]);

  const setLine = (index, key, value) =>
    setLines((current) => current.map((line, i) => (i === index ? { ...line, [key]: value } : line)));

  // Live preview so nobody has to save to see what it comes to.
  const preview = lines.reduce(
    (totals, line) => {
      const subtotal = Number(line.quantity || 0) * Number(line.unit_price || 0);
      const discount = (subtotal * Number(line.discount_percent || 0)) / 100;
      const taxable = subtotal - discount;
      const tax = (taxable * Number(line.tax_rate || 0)) / 100;
      return {
        subtotal: totals.subtotal + subtotal,
        taxable: totals.taxable + taxable,
        tax: totals.tax + tax,
      };
    },
    { subtotal: 0, taxable: 0, tax: 0 },
  );
  const previewTotal = Math.round(preview.taxable + preview.tax);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = {
        ...form,
        lines: lines
          .filter((line) => line.description.trim() && line.unit_price !== '')
          .map((line) => ({
            description: line.description.trim(),
            hsn_sac: line.hsn_sac || undefined,
            quantity: Number(line.quantity || 1),
            unit_price: Number(line.unit_price).toFixed(2),
            discount_percent: Number(line.discount_percent || 0),
            tax_rate: Number(line.tax_rate || 0),
          })),
      };

      if (!payload.lines.length) {
        setError('Add at least one line with a description and a price.');
        setBusy(false);
        return;
      }

      if (payload.customer_id) {
        const customer = customers.find((c) => c.id === payload.customer_id);
        payload.customer_name = customer?.name;
      }
      for (const key of Object.keys(payload)) if (payload[key] === '') delete payload[key];

      const response = await api.post('/invoicing/invoices', payload);
      toast.success('Draft invoice created', {
        description: `${money(response.data.total)} — review it, then issue.`,
      });
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create that invoice.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="full"
      title="New invoice"
      description="This creates a draft. It gets its number when you issue it."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy} icon={Plus}>Create draft</Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-5">
        {error && <Alert tone="critical">{error}</Alert>}

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Customer" hint={customers.length ? 'Synced from CRM.' : 'No customers yet — type a name.'}>
            {(p) => (
              <Select {...p} value={form.customer_id ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, customer_id: e.target.value || undefined }))}
                disabled={!customers.length}>
                <option value="">Choose…</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Or enter a name">
            {(p) => (
              <Input {...p} value={form.customer_name ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, customer_name: e.target.value }))}
                disabled={Boolean(form.customer_id)} placeholder="Acme Traders" />
            )}
          </Field>
          <Field label="Customer GSTIN" hint="Decides CGST/SGST vs IGST.">
            {(p) => (
              <Input {...p} value={form.customer_gstin ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, customer_gstin: e.target.value }))}
                placeholder="27AAAAA0000A1Z5" />
            )}
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Issue date">
            {(p) => (
              <Input {...p} type="date" value={form.issue_date ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, issue_date: e.target.value }))} />
            )}
          </Field>
          <Field label="Payment terms (days)">
            {(p) => (
              <Input {...p} type="number" min="0" max="365" value={form.terms_days}
                onChange={(e) => setForm((f) => ({ ...f, terms_days: Number(e.target.value) }))} />
            )}
          </Field>
          <Field label="Reference">
            {(p) => (
              <Input {...p} value={form.reference ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, reference: e.target.value }))}
                placeholder="PO-2026-114" />
            )}
          </Field>
        </div>

        {/* ── lines ─────────────────────────────────────────────────────── */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium">Lines</p>
            <Button variant="ghost" size="sm" icon={Plus} type="button"
              onClick={() => setLines((c) => [...c, blankLine()])}>
              Add line
            </Button>
          </div>

          <div className="space-y-2">
            {lines.map((line, index) => (
              <div key={index} className="panel grid gap-2 p-3 sm:grid-cols-[1fr_5rem_7rem_5rem_5rem_2rem]">
                <Input placeholder="Description" value={line.description}
                  onChange={(e) => setLine(index, 'description', e.target.value)} />
                <Input type="number" min="0" step="0.001" placeholder="Qty" value={line.quantity}
                  onChange={(e) => setLine(index, 'quantity', e.target.value)} />
                <Input type="number" min="0" step="0.01" placeholder="Rate" value={line.unit_price}
                  onChange={(e) => setLine(index, 'unit_price', e.target.value)} />
                <Input type="number" min="0" max="100" step="0.01" placeholder="Disc %"
                  value={line.discount_percent}
                  onChange={(e) => setLine(index, 'discount_percent', e.target.value)} />
                <Select value={line.tax_rate} onChange={(e) => setLine(index, 'tax_rate', e.target.value)}
                  aria-label="Tax rate">
                  {[0, 5, 12, 18, 28].map((rate) => <option key={rate} value={rate}>{rate}%</option>)}
                </Select>
                <Button variant="ghost" size="icon-sm" type="button" aria-label="Remove line"
                  disabled={lines.length === 1}
                  onClick={() => setLines((c) => c.filter((_, i) => i !== index))}>
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        </div>

        <div className="ml-auto max-w-xs space-y-1.5 text-sm">
          <Row label="Taxable value" value={money(preview.taxable)} />
          <Row label="Tax" value={money(preview.tax)} />
          <div className="flex justify-between border-t border-[var(--border-subtle)] pt-2 text-md font-semibold">
            <span>Total (approx.)</span>
            <span className="tabular">{money(previewTotal)}</span>
          </div>
          <p className="text-2xs text-[var(--text-tertiary)]">
            Final figures are calculated server-side with exact rounding.
          </p>
        </div>

        <Field label="Notes">
          {(p) => (
            <Textarea {...p} rows={2} value={form.notes ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
          )}
        </Field>
      </form>
    </Modal>
  );
}
