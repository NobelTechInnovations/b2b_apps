'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Plus, Palette, Check, Trash2, Upload, X, FileText, Building2,
  Landmark, PenTool, Settings2, Star,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Can, useWorkspace } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Textarea, Checkbox } from '@/components/ui/input';
import { ConfirmModal } from '@/components/ui/modal';
import {
  Badge, Card, EmptyState, PageHeader, Alert, Skeleton, Divider,
} from '@/components/ui/primitives';
import { InvoiceDocumentBody } from '@/components/invoicing/invoice-document';
import { cn } from '@/lib/cn';

const LAYOUTS = [
  { value: 'classic', label: 'Classic', hint: 'Accent rule under the masthead' },
  { value: 'modern', label: 'Modern', hint: 'Full-bleed coloured header' },
  { value: 'minimal', label: 'Minimal', hint: 'Hairlines and no fill' },
];

const SWATCHES = ['#4f46e5', '#0f766e', '#b45309', '#be123c', '#1d4ed8', '#7c3aed', '#111827', '#059669'];

/** A logo big enough to print well but small enough to inline. */
const MAX_LOGO_BYTES = 180_000;

export default function TemplatesClient() {
  const toast = useToast();
  const { can } = useWorkspace();

  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [draft, setDraft] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [section, setSection] = useState('design');

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await api.get('/invoicing/templates');
      setTemplates(response.data);
      setSelected((current) => current ?? response.data.find((t) => t.is_default)?.id ?? response.data[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load invoice designs.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Switching templates discards nothing silently: the draft is reseeded from
  // whichever one is now selected.
  useEffect(() => {
    const template = templates.find((t) => t.id === selected);
    if (template) { setDraft({ ...template }); setDirty(false); }
  }, [selected, templates]);

  const set = (key, value) => { setDraft((d) => ({ ...d, [key]: value })); setDirty(true); };

  async function save() {
    setBusy(true);
    try {
      const { id, org_id: _o, created_at: _c, updated_at: _u, archived_at: _a, used_by: _b, created_by: _cb, is_default: isDefault, ...fields } = draft;
      await api.patch(`/invoicing/templates/${id}`, { ...fields, is_default: isDefault });
      toast.success(`${draft.name} saved`);
      setDirty(false);
      await load();
    } catch (err) {
      toast.error('Could not save that design', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    setBusy(true);
    try {
      const base = templates.find((t) => t.id === selected);
      const response = await api.post('/invoicing/templates', {
        name: `${base?.name ?? 'Invoice'} copy`,
        layout: base?.layout, accent: base?.accent,
        seller_name: base?.seller_name ?? undefined,
        seller_address: base?.seller_address ?? undefined,
        terms: base?.terms ?? undefined,
      });
      toast.success('Design created');
      await load();
      setSelected(response.data.id);
    } catch (err) {
      toast.error('Could not create that design', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  async function makeDefault(template) {
    try {
      await api.patch(`/invoicing/templates/${template.id}`, { is_default: true });
      toast.success(`${template.name} is now the default`, {
        description: 'New invoices will be issued under it. Invoices already sent keep their own.',
      });
      await load();
    } catch (err) {
      toast.error('Could not change the default', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api.del(`/invoicing/templates/${deleting.id}`);
      toast.success(`${deleting.name} removed`, {
        description: 'Invoices issued under it still render exactly as they were sent.',
      });
      setDeleting(null);
      setSelected(null);
      await load();
    } catch (err) {
      toast.error('Could not remove that design', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-5">
        <PageHeader title="Invoice design" />
        <Skeleton className="h-[70vh] w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Invoice design"
        description="How your invoices look on paper. Changes apply to invoices you issue from now on."
        actions={
          <Can permission="invoicing.invoices.edit">
            <div className="flex items-center gap-2">
              <Button variant="secondary" icon={Plus} onClick={create} loading={busy}>New design</Button>
              {dirty && (
                <Button variant="primary" onClick={save} loading={busy}>Save changes</Button>
              )}
            </div>
          </Can>
        }
      />

      {error && <Alert tone="critical">{error}</Alert>}

      {templates.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {templates.map((template) => (
            <button
              key={template.id}
              onClick={() => setSelected(template.id)}
              className={cn(
                'group flex items-center gap-2 rounded-[var(--radius-md)] border px-3 py-1.5 text-sm transition-colors',
                selected === template.id
                  ? 'border-[var(--color-brand-500)] bg-[var(--color-brand-50)] text-[var(--color-brand-700)] dark:bg-[rgb(99_102_241/0.12)] dark:text-[var(--color-brand-300)]'
                  : 'border-[var(--border-subtle)] hover:border-[var(--border-default)]',
              )}
            >
              <span className="size-3 rounded-full" style={{ background: template.accent }} />
              {template.name}
              {template.is_default && <Star className="size-3 fill-current" />}
              {template.used_by > 0 && (
                <span className="text-xs text-[var(--text-tertiary)]">{template.used_by}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {draft && (
        <div className="grid gap-5 lg:grid-cols-[22rem_1fr]">
          {/* ── the controls ────────────────────────────────────────────── */}
          <div className="space-y-4">
            <Card className="overflow-hidden">
              <div className="flex border-b border-[var(--border-subtle)]">
                {[
                  { key: 'design', label: 'Design', icon: Palette },
                  { key: 'business', label: 'Business', icon: Building2 },
                  { key: 'payment', label: 'Payment', icon: Landmark },
                  { key: 'content', label: 'Content', icon: FileText },
                ].map((item) => (
                  <button
                    key={item.key}
                    onClick={() => setSection(item.key)}
                    title={item.label}
                    className={cn(
                      'flex flex-1 items-center justify-center gap-1.5 px-2 py-2.5 text-xs font-medium transition-colors',
                      section === item.key
                        ? 'border-b-2 border-[var(--color-brand-500)] text-[var(--text-primary)]'
                        : 'border-b-2 border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                    )}
                  >
                    <item.icon className="size-3.5" />
                    <span className="hidden sm:inline lg:hidden xl:inline">{item.label}</span>
                  </button>
                ))}
              </div>

              <div className="space-y-4 p-4">
                {section === 'design' && (
                  <DesignSection draft={draft} set={set} toast={toast} />
                )}
                {section === 'business' && (
                  <div className="grid gap-4">
                    <Field label="Trading name" hint="Leave blank to use the workspace name">
                      <Input value={draft.seller_name ?? ''} onChange={(e) => set('seller_name', e.target.value)} />
                    </Field>
                    <Field label="Address">
                      <Textarea rows={3} value={draft.seller_address ?? ''} onChange={(e) => set('seller_address', e.target.value)} />
                    </Field>
                    <Field label="GSTIN">
                      <Input value={draft.seller_gstin ?? ''} onChange={(e) => set('seller_gstin', e.target.value.toUpperCase())} className="font-mono" />
                    </Field>
                    <Field label="PAN">
                      <Input value={draft.seller_pan ?? ''} onChange={(e) => set('seller_pan', e.target.value.toUpperCase())} className="font-mono" />
                    </Field>
                    <Field label="Email">
                      <Input type="email" value={draft.seller_email ?? ''} onChange={(e) => set('seller_email', e.target.value)} />
                    </Field>
                    <Field label="Phone">
                      <Input value={draft.seller_phone ?? ''} onChange={(e) => set('seller_phone', e.target.value)} />
                    </Field>
                    <Field label="Website">
                      <Input value={draft.seller_website ?? ''} onChange={(e) => set('seller_website', e.target.value)} />
                    </Field>
                  </div>
                )}
                {section === 'payment' && (
                  <div className="grid gap-4">
                    <Checkbox
                      label="Show payment details"
                      checked={draft.show_bank_details}
                      onChange={(e) => set('show_bank_details', e.target.checked)}
                    />
                    <Field label="Bank name">
                      <Input value={draft.bank_name ?? ''} onChange={(e) => set('bank_name', e.target.value)} />
                    </Field>
                    <Field label="Account number">
                      <Input value={draft.bank_account ?? ''} onChange={(e) => set('bank_account', e.target.value)} className="font-mono" />
                    </Field>
                    <Field label="IFSC">
                      <Input value={draft.bank_ifsc ?? ''} onChange={(e) => set('bank_ifsc', e.target.value.toUpperCase())} className="font-mono" />
                    </Field>
                    <Field label="Branch">
                      <Input value={draft.bank_branch ?? ''} onChange={(e) => set('bank_branch', e.target.value)} />
                    </Field>
                    <Field label="UPI id">
                      <Input value={draft.upi_id ?? ''} onChange={(e) => set('upi_id', e.target.value)} className="font-mono" />
                    </Field>
                  </div>
                )}
                {section === 'content' && (
                  <div className="grid gap-4">
                    <Field label="Default terms" hint="An invoice with its own terms overrides this">
                      <Textarea rows={4} value={draft.terms ?? ''} onChange={(e) => set('terms', e.target.value)} />
                    </Field>
                    <Field label="Footer note">
                      <Input value={draft.footer_note ?? ''} onChange={(e) => set('footer_note', e.target.value)} placeholder="Thank you for your business." />
                    </Field>

                    <Divider label="Signature" />
                    <Checkbox
                      label="Show a signature block"
                      checked={draft.show_signature}
                      onChange={(e) => set('show_signature', e.target.checked)}
                    />
                    {draft.show_signature && (
                      <>
                        <Field label="Signatory name">
                          <Input value={draft.signature_name ?? ''} onChange={(e) => set('signature_name', e.target.value)} placeholder="Authorised signatory" />
                        </Field>
                        <ImagePicker
                          label="Signature image"
                          value={draft.signature_url}
                          onChange={(value) => set('signature_url', value)}
                          toast={toast}
                          icon={PenTool}
                        />
                      </>
                    )}
                  </div>
                )}
              </div>
            </Card>

            <Can permission="invoicing.invoices.edit">
              <div className="flex flex-wrap gap-2">
                {!draft.is_default && (
                  <Button variant="secondary" size="sm" icon={Star} onClick={() => makeDefault(draft)}>
                    Make default
                  </Button>
                )}
                {!draft.is_default && (
                  <Button
                    variant="danger-ghost"
                    size="sm"
                    icon={Trash2}
                    onClick={() => setDeleting(draft)}
                  >
                    Remove
                  </Button>
                )}
                <div className="flex-1" />
                {dirty && <Badge tone="caution" size="sm">Unsaved changes</Badge>}
              </div>
            </Can>
          </div>

          {/* ── live preview ────────────────────────────────────────────── */}
          <div className="min-w-0">
            <div className="mb-2 flex items-center gap-2">
              <p className="text-sm font-medium text-[var(--text-secondary)]">Preview</p>
              <p className="text-xs text-[var(--text-tertiary)]">
                Sample figures. This is the same renderer that prints.
              </p>
            </div>
            <div className="overflow-x-auto rounded-[var(--radius-xl)] border border-[var(--border-subtle)] bg-[#e5e7eb] p-5 dark:bg-[#1f2937]">
              <div className="mx-auto w-[820px] max-w-full bg-white px-10 py-9 text-[#111827] shadow-lg">
                <InvoiceDocumentBody doc={sampleDocument(draft)} />
              </div>
            </div>
          </div>
        </div>
      )}

      {templates.length === 0 && (
        <Card>
          <EmptyState
            icon={Palette}
            title="No invoice design yet"
            description="A design decides how your invoices look when printed or sent."
            action={<Button variant="primary" icon={Plus} onClick={create}>Create one</Button>}
          />
        </Card>
      )}

      <ConfirmModal
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={remove}
        title={`Remove ${deleting?.name}?`}
        description="Invoices already issued under this design keep rendering exactly as they were sent. Only new invoices are affected."
        confirmLabel="Remove design"
        danger
        loading={busy}
      />
    </div>
  );
}

/* ── the visual controls ────────────────────────────────────────────────── */
function DesignSection({ draft, set, toast }) {
  return (
    <div className="grid gap-4">
      <Field label="Design name" required>
        <Input value={draft.name} onChange={(e) => set('name', e.target.value)} />
      </Field>

      <Field label="Layout">
        <div className="grid gap-2">
          {LAYOUTS.map((layout) => (
            <button
              key={layout.value}
              type="button"
              onClick={() => set('layout', layout.value)}
              className={cn(
                'flex items-center gap-3 rounded-[var(--radius-md)] border px-3 py-2 text-left transition-colors',
                draft.layout === layout.value
                  ? 'border-[var(--color-brand-500)] bg-[var(--color-brand-50)] dark:bg-[rgb(99_102_241/0.1)]'
                  : 'border-[var(--border-subtle)] hover:border-[var(--border-default)]',
              )}
            >
              <LayoutThumb layout={layout.value} accent={draft.accent} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{layout.label}</span>
                <span className="block truncate text-xs text-[var(--text-tertiary)]">{layout.hint}</span>
              </span>
              {draft.layout === layout.value && <Check className="size-4 text-[var(--color-brand-600)]" />}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Accent colour">
        <div className="flex flex-wrap items-center gap-2">
          {SWATCHES.map((swatch) => (
            <button
              key={swatch}
              type="button"
              onClick={() => set('accent', swatch)}
              aria-label={swatch}
              className={cn(
                'size-7 rounded-full ring-offset-2 ring-offset-[var(--surface-raised)] transition-shadow',
                draft.accent?.toLowerCase() === swatch ? 'ring-2 ring-[var(--text-primary)]' : 'ring-1 ring-[var(--border-subtle)]',
              )}
              style={{ background: swatch }}
            />
          ))}
          <input
            type="color"
            value={draft.accent ?? '#4f46e5'}
            onChange={(e) => set('accent', e.target.value)}
            className="size-7 cursor-pointer rounded-full border border-[var(--border-subtle)] bg-transparent p-0"
            aria-label="Custom colour"
          />
        </div>
      </Field>

      {draft.layout === 'modern' && (
        <Checkbox
          label="Fill the header with the accent colour"
          checked={draft.accent_header}
          onChange={(e) => set('accent_header', e.target.checked)}
        />
      )}

      <ImagePicker
        label="Logo"
        value={draft.logo_url}
        onChange={(value) => set('logo_url', value)}
        toast={toast}
        icon={Upload}
      />

      <Divider label="What to show" />

      <div className="space-y-2">
        <Checkbox label="HSN / SAC codes" description="Required on GST invoices for goods"
          checked={draft.show_hsn} onChange={(e) => set('show_hsn', e.target.checked)} />
        <Checkbox label="Tax summary by rate" description="Grouped CGST/SGST or IGST"
          checked={draft.show_tax_breakdown} onChange={(e) => set('show_tax_breakdown', e.target.checked)} />
        <Checkbox label="Amount in words"
          checked={draft.show_amount_words} onChange={(e) => set('show_amount_words', e.target.checked)} />
      </div>
    </div>
  );
}

function LayoutThumb({ layout, accent }) {
  return (
    <span className="flex h-9 w-7 shrink-0 flex-col overflow-hidden rounded-[var(--radius-xs)] border border-[var(--border-subtle)] bg-white">
      <span
        className="block"
        style={
          layout === 'modern'
            ? { height: 12, background: accent }
            : layout === 'classic'
              ? { height: 10, borderBottom: `2px solid ${accent}` }
              : { height: 10, borderBottom: '1px solid #d1d5db' }
        }
      />
      <span className="flex flex-1 flex-col gap-[2px] p-[3px]">
        {[0, 1, 2].map((i) => <span key={i} className="block h-[2px] rounded-full bg-[#d1d5db]" />)}
        <span className="mt-auto block h-[3px] w-2/3 self-end rounded-full" style={{ background: accent }} />
      </span>
    </span>
  );
}

/** A small inlined image. Bigger artwork belongs in Documents, not on a page
 *  that is rendered on every invoice view. */
function ImagePicker({ label, value, onChange, toast, icon: Icon = Upload }) {
  const input = useRef(null);

  function pick(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast.error('That is not an image');
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      toast.error('That image is too large', {
        description: `Keep it under ${Math.round(MAX_LOGO_BYTES / 1024)} KB — it is embedded in every invoice.`,
      });
      return;
    }

    const reader = new FileReader();
    reader.onload = () => onChange(String(reader.result));
    reader.readAsDataURL(file);
  }

  return (
    <Field label={label}>
      {value ? (
        <div className="flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] p-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={value} alt="" className="max-h-10 max-w-[7rem] object-contain" />
          <div className="flex-1" />
          <Button variant="ghost" size="sm" icon={X} onClick={() => onChange(null)} />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => input.current?.click()}
          className="flex w-full items-center justify-center gap-2 rounded-[var(--radius-md)] border border-dashed border-[var(--border-default)] px-3 py-4 text-sm text-[var(--text-secondary)] transition-colors hover:border-[var(--color-brand-500)] hover:text-[var(--text-primary)]"
        >
          <Icon className="size-4" />
          Choose an image
        </button>
      )}
      <input ref={input} type="file" accept="image/*" onChange={pick} className="hidden" />
    </Field>
  );
}

/**
 * Sample data for the preview.
 *
 * Deliberately a realistic mixed-rate invoice with a part payment, because a
 * design that only looks right on one clean line is not a design that has
 * been checked.
 */
function sampleDocument(template) {
  return {
    template,
    workspace: { name: 'Your business' },
    invoice: {
      number: 'INV/2026-27/0042',
      status: 'partially_paid',
      issue_date: '2026-09-01',
      due_date: '2026-10-01',
      reference: 'PO-88213',
      currency: 'INR',
      customer_name: 'Vertex Laboratories Pvt Ltd',
      customer_gstin: '27AABCV1234N1Z5',
      place_of_supply: 'Maharashtra (27)',
      billing_address: {
        line1: 'Unit 4, Raheja Commerce Park',
        line2: 'Andheri East',
        city: 'Mumbai', state: 'Maharashtra',
        postal_code: '400093', country: 'India',
      },
      subtotal: '184000.00', discount_total: '4000.00', taxable_total: '180000.00',
      cgst_total: '15300.00', sgst_total: '15300.00', igst_total: '0.00',
      tax_total: '30600.00', round_off: '0.00', total: '210600.00',
      amount_paid: '100000.00', amount_due: '110600.00',
      notes: 'Delivered against work order WO-2291. Installation scheduled for 12 October.',
      terms: template.terms,
    },
    lines: [
      {
        id: '1', description: 'Precision lathe tooling set', hsn_sac: '8466',
        quantity: '4.000', unit: 'nos', unit_price: '32000.00', discount_percent: '0.00',
        tax_rate: '18.00', line_taxable: '128000.00', cgst_amount: '11520.00',
        sgst_amount: '11520.00', igst_amount: '0.00', line_total: '151040.00',
      },
      {
        id: '2', description: 'Calibration and installation', hsn_sac: '998719',
        quantity: '16.000', unit: 'hrs', unit_price: '2000.00', discount_percent: '0.00',
        tax_rate: '18.00', line_taxable: '32000.00', cgst_amount: '2880.00',
        sgst_amount: '2880.00', igst_amount: '0.00', line_total: '37760.00',
      },
      {
        id: '3', description: 'Annual maintenance contract', hsn_sac: '998717',
        quantity: '1.000', unit: 'yr', unit_price: '24000.00', discount_percent: '16.67',
        tax_rate: '18.00', line_taxable: '20000.00', cgst_amount: '1800.00',
        sgst_amount: '1800.00', igst_amount: '0.00', line_total: '23600.00',
      },
    ],
    payments: [
      { number: 'PAY-0031', method: 'bank', received_on: '2026-09-12', reference: 'NEFT/8812', amount: '100000.00' },
    ],
    amount_in_words: 'Two lakh ten thousand six hundred rupees only',
    tax_groups: [
      { rate: 18, taxable: '180000.00', cgst: '15300.00', sgst: '15300.00', igst: '0.00', total: '30600.00' },
    ],
  };
}
