'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, Building2, Globe, Mail, Phone, BadgeCheck } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { money, relativeTime, date } from '@/lib/format';
import { Can, useWorkspace } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Textarea } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Drawer, DetailGrid } from '@/components/data/drawer';
import { ListToolbar, Pagination } from '@/components/data/list-shell';
import { Table, THead, TBody, TH, TR, TD, TableSkeleton } from '@/components/ui/table';
import { Avatar, Badge, Card, EmptyState, PageHeader, Alert } from '@/components/ui/primitives';

const FILTERS = [
  {
    key: 'is_customer',
    label: 'Type',
    options: [{ value: 'true', label: 'Customers' }, { value: 'false', label: 'Prospects' }],
  },
];

export default function CompaniesClient() {
  const { can } = useWorkspace();
  const [companies, setCompanies] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({});
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.get('/crm/companies', {
        query: { ...filters, q: search || undefined, page, limit: 25 },
      });
      setCompanies(response.data);
      setMeta(response.meta);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load companies.');
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
        title="Companies"
        description="Your prospects and customers."
        actions={
          <Can permission="crm.companies.create">
            <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>New company</Button>
          </Can>
        }
      />

      <ListToolbar
        search={search}
        onSearch={(v) => { setSearch(v); setPage(1); }}
        searchPlaceholder="Search name, domain or email…"
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
        <TableSkeleton rows={6} columns={5} />
      ) : companies.length === 0 ? (
        <Card>
          <EmptyState
            icon={Building2}
            title={search || Object.keys(filters).length ? 'No companies match' : 'No companies yet'}
            description={
              search || Object.keys(filters).length
                ? 'Try a different search or clear your filters.'
                : 'Companies are created automatically when you convert a lead.'
            }
            action={
              can('crm.companies.create') && (
                <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>Add a company</Button>
              )
            }
          />
        </Card>
      ) : (
        <>
          <Table>
            <THead>
              <tr>
                <TH>Company</TH>
                <TH align="right">Contacts</TH>
                <TH align="right">Open deals</TH>
                <TH align="right">Lifetime value</TH>
                <TH>Added</TH>
              </tr>
            </THead>
            <TBody>
              {companies.map((company) => (
                <TR key={company.id} onClick={() => setSelectedId(company.id)}>
                  <TD>
                    <div className="flex items-center gap-2.5">
                      <Avatar name={company.name} size="md" square />
                      <div className="min-w-0">
                        <p className="flex items-center gap-1.5 truncate font-medium">
                          {company.name}
                          {company.is_customer && (
                            <BadgeCheck className="size-3.5 shrink-0 text-[var(--color-positive-500)]" />
                          )}
                        </p>
                        <p className="truncate text-xs text-[var(--text-tertiary)]">
                          {company.domain ?? company.industry ?? '—'}
                        </p>
                      </div>
                    </div>
                  </TD>
                  <TD align="right" numeric className="text-[var(--text-secondary)]">{company.contact_count}</TD>
                  <TD align="right" numeric className="text-[var(--text-secondary)]">{company.open_deals}</TD>
                  <TD align="right" numeric className="font-medium">
                    {Number(company.lifetime_value) > 0 ? money(company.lifetime_value) : '—'}
                  </TD>
                  <TD className="text-[var(--text-secondary)]">{relativeTime(company.created_at)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination meta={meta} onPage={setPage} />
        </>
      )}

      <CompanyDrawer companyId={selectedId} onClose={() => setSelectedId(null)} />
      <CreateCompanyModal open={creating} onClose={() => setCreating(false)} onCreated={load} />
    </div>
  );
}

function CompanyDrawer({ companyId, onClose }) {
  const [company, setCompany] = useState(null);

  useEffect(() => {
    if (!companyId) { setCompany(null); return; }
    api.get(`/crm/companies/${companyId}`).then((r) => setCompany(r.data)).catch(() => setCompany(null));
  }, [companyId]);

  if (!companyId) return null;

  return (
    <Drawer
      open
      onClose={onClose}
      title={company?.name ?? 'Company'}
      subtitle={company?.domain}
      badge={company?.is_customer && <Badge size="sm" tone="positive">Customer</Badge>}
      width="lg"
    >
      {!company ? (
        <div className="space-y-3">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-14 w-full" />)}</div>
      ) : (
        <div className="space-y-6">
          <div className="flex items-center gap-4">
            <Avatar name={company.name} size="xl" square />
            <div className="flex gap-2">
              {company.website && (
                <a href={company.website} target="_blank" rel="noreferrer noopener">
                  <Button variant="secondary" size="sm" icon={Globe}>Website</Button>
                </a>
              )}
              {company.email && (
                <a href={`mailto:${company.email}`}><Button variant="secondary" size="sm" icon={Mail}>Email</Button></a>
              )}
            </div>
          </div>

          <DetailGrid
            items={[
              { label: 'Domain', value: company.domain },
              { label: 'Industry', value: company.industry },
              { label: 'Phone', value: company.phone },
              { label: 'Email', value: company.email },
              { label: 'GSTIN / Tax ID', value: company.tax_id },
              { label: 'Customer since', value: company.customer_since ? date(company.customer_since) : null },
              { label: 'Notes', value: company.notes, full: true },
            ]}
          />

          <div>
            <h3 className="mb-2 text-sm font-medium text-[var(--text-secondary)]">
              People ({company.contacts?.length ?? 0})
            </h3>
            {(company.contacts?.length ?? 0) === 0 ? (
              <p className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border-default)] px-3 py-5 text-center text-sm text-[var(--text-tertiary)]">
                Nobody linked yet.
              </p>
            ) : (
              <ul className="space-y-2">
                {company.contacts.map((contact) => (
                  <li key={contact.id} className="panel flex items-center gap-3 px-3 py-2.5">
                    <Avatar name={`${contact.first_name} ${contact.last_name ?? ''}`} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 truncate text-base font-medium">
                        {[contact.first_name, contact.last_name].filter(Boolean).join(' ')}
                        {contact.is_primary && <Badge size="sm" tone="brand">Primary</Badge>}
                      </p>
                      <p className="truncate text-xs text-[var(--text-tertiary)]">
                        {contact.job_title ?? contact.email ?? '—'}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h3 className="mb-2 text-sm font-medium text-[var(--text-secondary)]">
              Deals ({company.deals?.length ?? 0})
            </h3>
            {(company.deals?.length ?? 0) === 0 ? (
              <p className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border-default)] px-3 py-5 text-center text-sm text-[var(--text-tertiary)]">
                No deals yet.
              </p>
            ) : (
              <ul className="space-y-2">
                {company.deals.map((deal) => (
                  <li key={deal.id} className="panel flex items-center justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-base font-medium">{deal.title}</p>
                      <p className="text-xs text-[var(--text-tertiary)]">{deal.stage_name}</p>
                    </div>
                    <span className="shrink-0 text-sm font-medium tabular">{money(deal.value, deal.currency)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}

function CreateCompanyModal({ open, onClose, onCreated }) {
  const toast = useToast();
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = { ...form };
      for (const key of Object.keys(payload)) if (payload[key] === '') delete payload[key];
      const response = await api.post('/crm/companies', payload);
      toast.success(`${response.data.name} added`);
      setForm({});
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that company.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New company"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy} icon={Plus}>Add company</Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert tone="critical">{error}</Alert>}

        <Field label="Company name" required>
          {(p) => <Input {...p} icon={Building2} value={form.name ?? ''} onChange={set('name')} required data-autofocus />}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Domain" hint="Used to match future leads automatically.">
            {(p) => <Input {...p} icon={Globe} placeholder="acme.in" value={form.domain ?? ''} onChange={set('domain')} />}
          </Field>
          <Field label="Industry">
            {(p) => <Input {...p} value={form.industry ?? ''} onChange={set('industry')} />}
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Email">
            {(p) => <Input {...p} type="email" icon={Mail} value={form.email ?? ''} onChange={set('email')} />}
          </Field>
          <Field label="Phone">
            {(p) => <Input {...p} icon={Phone} value={form.phone ?? ''} onChange={set('phone')} />}
          </Field>
        </div>

        <Field label="GSTIN / Tax ID">
          {(p) => <Input {...p} placeholder="27AAAAA0000A1Z5" value={form.tax_id ?? ''} onChange={set('tax_id')} />}
        </Field>

        <Field label="Notes">
          {(p) => <Textarea {...p} rows={3} value={form.notes ?? ''} onChange={set('notes')} />}
        </Field>
      </form>
    </Modal>
  );
}
