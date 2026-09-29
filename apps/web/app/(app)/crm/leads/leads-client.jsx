'use client';
import { SourceTaskButton } from '@/components/tasks/source-task-button';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Plus, Sparkles, UserRoundCheck, Phone, Mail, Building2, Flame } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { money, relativeTime } from '@/lib/format';
import { Can, useWorkspace } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Drawer, DetailGrid } from '@/components/data/drawer';
import { ListToolbar, Pagination } from '@/components/data/list-shell';
import { StatTile } from '@/components/data/stat-tile';
import { Table, THead, TBody, TH, TR, TD, TableSkeleton } from '@/components/ui/table';
import { Avatar, Badge, Card, EmptyState, PageHeader, Alert } from '@/components/ui/primitives';

const STATUS_TONE = {
  new: 'info', contacted: 'caution', qualified: 'brand',
  converted: 'positive', unqualified: 'neutral',
};

const RATING_TONE = { hot: 'critical', warm: 'caution', cold: 'info' };

const FILTERS = [
  {
    key: 'status',
    label: 'Status',
    options: ['new', 'contacted', 'qualified', 'unqualified', 'converted'].map((v) => ({
      value: v, label: v[0].toUpperCase() + v.slice(1),
    })),
  },
  {
    key: 'rating',
    label: 'Rating',
    options: [
      { value: 'hot', label: 'Hot' }, { value: 'warm', label: 'Warm' }, { value: 'cold', label: 'Cold' },
    ],
  },
  {
    key: 'source',
    label: 'Source',
    options: ['website', 'referral', 'campaign', 'event', 'cold_call', 'manual', 'partner'].map((v) => ({
      value: v, label: v.replace('_', ' ').replace(/^\w/, (m) => m.toUpperCase()),
    })),
  },
];

export default function LeadsClient() {
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const { can } = useWorkspace();

  const [leads, setLeads] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({});
  const [page, setPage] = useState(1);

  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState(null);
  const [converting, setConverting] = useState(null);

  // Under Suspense the search params are not populated when the useState
  // initialiser runs, so deep links like /crm/leads?new=1 have to be applied
  // in an effect or they silently do nothing.
  useEffect(() => {
    if (params.get('new') === '1') setCreating(true);
    // From a form response or a notification: open that lead's panel.
    if (params.get('open')) setSelected({ id: params.get('open'), name: 'Loading…' });
  }, [params]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.get('/crm/leads', {
        query: { ...filters, q: search || undefined, page, limit: 25 },
      });
      setLeads(response.data);
      setMeta(response.meta);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load leads.');
    } finally {
      setLoading(false);
    }
  }, [filters, search, page]);

  // Debounce the search so typing does not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(load, search ? 280 : 0);
    return () => clearTimeout(timer);
  }, [load, search]);

  const setFilter = (key, value) => {
    setFilters((current) => {
      const next = { ...current };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });
    setPage(1);
  };

  const stats = meta?.stats;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Leads"
        description="Every enquiry, from first touch to qualified opportunity."
        actions={
          <Can permission="crm.leads.create">
            <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>New lead</Button>
          </Can>
        }
      />

      {stats && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatTile label="New" value={stats.new} icon={Sparkles} tone="brand" />
          <StatTile label="Contacted" value={stats.contacted} icon={Phone} />
          <StatTile label="Qualified" value={stats.qualified} icon={UserRoundCheck} tone="positive" />
          <StatTile label="Pipeline potential" value={stats.open_value} format="money" hint="Estimated value" />
        </div>
      )}

      <ListToolbar
        search={search}
        onSearch={(value) => { setSearch(value); setPage(1); }}
        searchPlaceholder="Search name, company or email…"
        filters={FILTERS}
        values={filters}
        onFilter={setFilter}
        onClear={() => { setFilters({}); setPage(1); }}
      />

      {error && <Alert tone="critical">{error}</Alert>}

      {loading ? (
        <TableSkeleton rows={6} columns={6} />
      ) : leads.length === 0 ? (
        <Card>
          <EmptyState
            icon={Sparkles}
            title={search || Object.keys(filters).length ? 'No leads match those filters' : 'No leads yet'}
            description={
              search || Object.keys(filters).length
                ? 'Try clearing a filter or searching for something broader.'
                : 'Add your first lead, or connect a form so they arrive automatically.'
            }
            action={
              can('crm.leads.create') && (
                <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>Add a lead</Button>
              )
            }
          />
        </Card>
      ) : (
        <>
          <Table>
            <THead>
              <tr>
                <TH>Lead</TH>
                <TH>Company</TH>
                <TH>Status</TH>
                <TH>Rating</TH>
                <TH align="right">Score</TH>
                <TH align="right">Value</TH>
                <TH>Added</TH>
              </tr>
            </THead>
            <TBody>
              {leads.map((lead) => (
                <TR key={lead.id} onClick={() => setSelected(lead)}>
                  <TD>
                    <div className="flex items-center gap-2.5">
                      <Avatar name={lead.name} size="md" />
                      <div className="min-w-0">
                        <p className="truncate font-medium">{lead.name}</p>
                        <p className="truncate text-xs text-[var(--text-tertiary)]">
                          {lead.email ?? lead.phone ?? '—'}
                        </p>
                      </div>
                    </div>
                  </TD>
                  <TD className="text-[var(--text-secondary)]">{lead.company_name ?? '—'}</TD>
                  <TD><Badge size="sm" tone={STATUS_TONE[lead.status]}>{lead.status}</Badge></TD>
                  <TD>
                    {lead.rating ? (
                      <Badge size="sm" tone={RATING_TONE[lead.rating]} dot>{lead.rating}</Badge>
                    ) : (
                      <span className="text-[var(--text-disabled)]">—</span>
                    )}
                  </TD>
                  <TD align="right" numeric>
                    <span className={cn('font-medium', lead.score >= 70 && 'text-[var(--color-positive-600)]')}>
                      {lead.score}
                    </span>
                  </TD>
                  <TD align="right" numeric>
                    {lead.estimated_value ? money(lead.estimated_value, lead.currency) : '—'}
                  </TD>
                  <TD className="text-[var(--text-secondary)]">{relativeTime(lead.created_at)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination meta={meta} onPage={setPage} />
        </>
      )}

      <CreateLeadModal
        open={creating}
        onClose={() => { setCreating(false); router.replace('/crm/leads'); }}
        onCreated={(lead) => { setLeads((c) => [lead, ...c]); load(); }}
      />

      <LeadDrawer
        lead={selected}
        onClose={() => setSelected(null)}
        onConvert={() => setConverting(selected)}
        onChanged={load}
      />

      <ConvertModal
        lead={converting}
        onClose={() => setConverting(null)}
        onConverted={(result) => {
          toast.success('Lead converted', {
            description: result.deal_id ? 'Contact, company and deal created.' : 'Contact and company created.',
          });
          setConverting(null);
          setSelected(null);
          load();
        }}
      />
    </div>
  );
}

/* ── detail ───────────────────────────────────────────────────────────────── */

function LeadDrawer({ lead, onClose, onConvert, onChanged }) {
  const toast = useToast();
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!lead) { setDetail(null); return; }
    api.get(`/crm/leads/${lead.id}`).then((r) => setDetail(r.data)).catch(() => setDetail(lead));
  }, [lead]);

  async function setStatus(status) {
    setBusy(true);
    try {
      await api.patch(`/crm/leads/${lead.id}`, { status });
      toast.success(`Marked as ${status}`);
      onChanged?.();
      onClose();
    } catch (error) {
      toast.error('Could not update that lead', {
        description: error instanceof ApiError ? error.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  if (!lead) return null;
  const record = detail ?? lead;

  return (
    <Drawer
      open
      onClose={onClose}
      title={record.name}
      subtitle={record.job_title ? `${record.job_title}${record.company_name ? ` · ${record.company_name}` : ''}` : record.company_name}
      badge={<Badge size="sm" tone={STATUS_TONE[record.status]}>{record.status}</Badge>}
      footer={
        record.status !== 'converted' && (
          <>
            <Can permission="crm.leads.edit">
              <Button variant="ghost" onClick={() => setStatus('unqualified')} disabled={busy}>
                Disqualify
              </Button>
            </Can>
            <Can permission="crm.leads.edit">
              <Button variant="primary" icon={UserRoundCheck} onClick={onConvert} disabled={busy}>
                Convert
              </Button>
            </Can>
          </>
        )
      }
    >
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Avatar name={record.name} size="xl" />
          <div className="flex gap-2">
<SourceTaskButton app="crm" type="lead" recordId={record.id} title={`Follow up: ${record.name}`} />
            {record.email && (
              <a href={`mailto:${record.email}`}>
                <Button variant="secondary" size="sm" icon={Mail}>Email</Button>
              </a>
            )}
            {record.phone && (
              <a href={`tel:${record.phone}`}>
                <Button variant="secondary" size="sm" icon={Phone}>Call</Button>
              </a>
            )}
          </div>
        </div>

        <DetailGrid
          items={[
            { label: 'Email', value: record.email },
            { label: 'Phone', value: record.phone },
            { label: 'Company', value: record.company_name },
            { label: 'Job title', value: record.job_title },
            { label: 'Source', value: record.source?.replace('_', ' ') },
            { label: 'Rating', value: record.rating },
            { label: 'Score', value: `${record.score} / 100` },
            {
              label: 'Estimated value',
              value: record.estimated_value ? money(record.estimated_value, record.currency) : null,
            },
            { label: 'Last contacted', value: record.last_contacted_at ? relativeTime(record.last_contacted_at) : 'Never' },
            { label: 'Added', value: relativeTime(record.created_at) },
            { label: 'Notes', value: record.notes, full: true },
          ]}
        />

        {record.status === 'converted' && (
          <Alert tone="positive" icon={UserRoundCheck}>
            Converted {relativeTime(record.converted_at)}. The contact, company and deal now live in your CRM.
          </Alert>
        )}

        <div>
          <h3 className="mb-2 text-sm font-medium text-[var(--text-secondary)]">Timeline</h3>
          {(record.activities?.length ?? 0) === 0 ? (
            <p className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border-default)] px-3 py-6 text-center text-sm text-[var(--text-tertiary)]">
              Nothing logged yet.
            </p>
          ) : (
            <ul className="space-y-2.5">
              {record.activities.map((activity) => (
                <li key={activity.id} className="flex gap-2.5">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-[var(--color-brand-400)]" />
                  <div className="min-w-0">
                    <p className="text-base">{activity.subject}</p>
                    <p className="text-xs text-[var(--text-tertiary)]">
                      {activity.kind} · {relativeTime(activity.created_at)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Drawer>
  );
}

/* ── create ───────────────────────────────────────────────────────────────── */

function CreateLeadModal({ open, onClose, onCreated }) {
  const toast = useToast();
  const [form, setForm] = useState({ source: 'manual', rating: 'warm' });
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setErrors({});
    setFormError(null);

    try {
      const payload = { ...form };
      if (payload.estimated_value) payload.estimated_value = Number(payload.estimated_value).toFixed(2);
      for (const key of Object.keys(payload)) if (payload[key] === '') delete payload[key];

      const response = await api.post('/crm/leads', payload);
      toast.success(`${response.data.name} added`);
      onCreated(response.data);
      setForm({ source: 'manual', rating: 'warm' });
      onClose();
    } catch (error) {
      if (error instanceof ApiError) {
        const fields = error.fieldErrors;
        if (Object.keys(fields).length) setErrors(fields);
        else setFormError(error.message);
      } else setFormError('Could not save that lead.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New lead"
      description="Only a first name is required — fill in what you know."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy} icon={Plus}>Add lead</Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {formError && <Alert tone="critical">{formError}</Alert>}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name" required error={errors.first_name}>
            {(p) => <Input {...p} value={form.first_name ?? ''} onChange={set('first_name')} required data-autofocus />}
          </Field>
          <Field label="Last name">
            {(p) => <Input {...p} value={form.last_name ?? ''} onChange={set('last_name')} />}
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Email" error={errors.email}>
            {(p) => <Input {...p} type="email" icon={Mail} value={form.email ?? ''} onChange={set('email')} />}
          </Field>
          <Field label="Phone">
            {(p) => <Input {...p} icon={Phone} value={form.phone ?? ''} onChange={set('phone')} />}
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Company">
            {(p) => <Input {...p} icon={Building2} value={form.company_name ?? ''} onChange={set('company_name')} />}
          </Field>
          <Field label="Job title">
            {(p) => <Input {...p} value={form.job_title ?? ''} onChange={set('job_title')} />}
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Source">
            {(p) => (
              <Select {...p} value={form.source} onChange={set('source')}>
                {['manual', 'website', 'referral', 'campaign', 'event', 'cold_call', 'partner'].map((s) => (
                  <option key={s} value={s}>{s.replace('_', ' ')}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Rating">
            {(p) => (
              <Select {...p} value={form.rating} onChange={set('rating')}>
                <option value="hot">Hot</option><option value="warm">Warm</option><option value="cold">Cold</option>
              </Select>
            )}
          </Field>
          <Field label="Estimated value" hint="In rupees">
            {(p) => <Input {...p} type="number" min="0" step="0.01" value={form.estimated_value ?? ''} onChange={set('estimated_value')} />}
          </Field>
        </div>

        <Field label="Notes">
          {(p) => <Textarea {...p} rows={3} value={form.notes ?? ''} onChange={set('notes')} placeholder="Where did they come from? What do they need?" />}
        </Field>
      </form>
    </Modal>
  );
}

/* ── convert ──────────────────────────────────────────────────────────────── */

function ConvertModal({ lead, onClose, onConverted }) {
  const [createDeal, setCreateDeal] = useState(true);
  const [title, setTitle] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!lead) return;
    setTitle(`${lead.company_name ?? lead.name} opportunity`);
    setValue(lead.estimated_value ?? '');
    setCreateDeal(true);
    setError(null);
  }, [lead]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const response = await api.post(`/crm/leads/${lead.id}/convert`, {
        create_deal: createDeal,
        deal_title: createDeal ? title : undefined,
        deal_value: createDeal && value ? Number(value).toFixed(2) : undefined,
      });
      onConverted(response.data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not convert that lead.');
    } finally {
      setBusy(false);
    }
  }

  if (!lead) return null;

  return (
    <Modal
      open
      onClose={onClose}
      title={`Convert ${lead.name}`}
      description="This creates the customer records and, optionally, an open deal."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy} icon={UserRoundCheck}>Convert</Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="critical">{error}</Alert>}

        <div className="space-y-2 rounded-[var(--radius-lg)] bg-[var(--surface-sunken)] px-3.5 py-3 text-sm">
          <p className="flex items-center gap-2">
            <Building2 className="size-3.5 text-[var(--text-tertiary)]" />
            Company <strong>{lead.company_name ?? '—'}</strong>
            {lead.email && <span className="text-[var(--text-tertiary)]">matched on domain if it already exists</span>}
          </p>
          <p className="flex items-center gap-2">
            <Avatar name={lead.name} size="xs" />
            Contact <strong>{lead.name}</strong>
          </p>
        </div>

        <label className="flex cursor-pointer items-start gap-2.5">
          <input
            type="checkbox"
            checked={createDeal}
            onChange={(e) => setCreateDeal(e.target.checked)}
            className="mt-0.5 size-4 rounded-[var(--radius-xs)] border-[var(--border-strong)] text-[var(--color-brand-600)]"
          />
          <span>
            <span className="block text-base">Also open a deal</span>
            <span className="block text-xs text-[var(--text-tertiary)]">
              Starts in the first stage of your default pipeline.
            </span>
          </span>
        </label>

        {createDeal && (
          <div className="animate-fade grid gap-4 sm:grid-cols-2">
            <Field label="Deal title">
              {(p) => <Input {...p} value={title} onChange={(e) => setTitle(e.target.value)} />}
            </Field>
            <Field label="Deal value">
              {(p) => <Input {...p} type="number" min="0" step="0.01" value={value} onChange={(e) => setValue(e.target.value)} />}
            </Field>
          </div>
        )}
      </div>
    </Modal>
  );
}
