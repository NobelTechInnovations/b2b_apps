'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, Contact as ContactIcon, Mail, Phone, Building2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { money, relativeTime } from '@/lib/format';
import { Can, useWorkspace } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Drawer, DetailGrid } from '@/components/data/drawer';
import { ListToolbar, Pagination } from '@/components/data/list-shell';
import { Table, THead, TBody, TH, TR, TD, TableSkeleton } from '@/components/ui/table';
import { Avatar, Badge, Card, EmptyState, PageHeader, Alert } from '@/components/ui/primitives';

export default function ContactsClient() {
  const { can } = useWorkspace();
  const [contacts, setContacts] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.get('/crm/contacts', { query: { q: search || undefined, page, limit: 25 } });
      setContacts(response.data);
      setMeta(response.meta);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load contacts.');
    } finally {
      setLoading(false);
    }
  }, [search, page]);

  useEffect(() => {
    const timer = setTimeout(load, search ? 280 : 0);
    return () => clearTimeout(timer);
  }, [load, search]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Contacts"
        description="The people behind your deals."
        actions={
          <Can permission="crm.contacts.create">
            <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>New contact</Button>
          </Can>
        }
      />

      <ListToolbar
        search={search}
        onSearch={(v) => { setSearch(v); setPage(1); }}
        searchPlaceholder="Search name, email or company…"
      />

      {error && <Alert tone="critical">{error}</Alert>}

      {loading ? (
        <TableSkeleton rows={6} columns={5} />
      ) : contacts.length === 0 ? (
        <Card>
          <EmptyState
            icon={ContactIcon}
            title={search ? 'No contacts match' : 'No contacts yet'}
            description={search ? 'Try a different search.' : 'Contacts appear here when you convert a lead, or add one directly.'}
            action={
              can('crm.contacts.create') && (
                <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>Add a contact</Button>
              )
            }
          />
        </Card>
      ) : (
        <>
          <Table>
            <THead>
              <tr>
                <TH>Name</TH>
                <TH>Company</TH>
                <TH>Email</TH>
                <TH>Phone</TH>
                <TH>Added</TH>
              </tr>
            </THead>
            <TBody>
              {contacts.map((contact) => (
                <TR key={contact.id} onClick={() => setSelectedId(contact.id)}>
                  <TD>
                    <div className="flex items-center gap-2.5">
                      <Avatar name={contact.name} size="md" />
                      <div className="min-w-0">
                        <p className="flex items-center gap-1.5 truncate font-medium">
                          {contact.name}
                          {contact.is_primary && <Badge size="sm" tone="brand">Primary</Badge>}
                        </p>
                        {contact.job_title && (
                          <p className="truncate text-xs text-[var(--text-tertiary)]">{contact.job_title}</p>
                        )}
                      </div>
                    </div>
                  </TD>
                  <TD className="text-[var(--text-secondary)]">{contact.company_name ?? '—'}</TD>
                  <TD className="text-[var(--text-secondary)]">{contact.email ?? '—'}</TD>
                  <TD className="text-[var(--text-secondary)]">{contact.phone ?? contact.mobile ?? '—'}</TD>
                  <TD className="text-[var(--text-secondary)]">{relativeTime(contact.created_at)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination meta={meta} onPage={setPage} />
        </>
      )}

      <ContactDrawer contactId={selectedId} onClose={() => setSelectedId(null)} />
      <CreateContactModal open={creating} onClose={() => setCreating(false)} onCreated={load} />
    </div>
  );
}

function ContactDrawer({ contactId, onClose }) {
  const [contact, setContact] = useState(null);

  useEffect(() => {
    if (!contactId) { setContact(null); return; }
    api.get(`/crm/contacts/${contactId}`).then((r) => setContact(r.data)).catch(() => setContact(null));
  }, [contactId]);

  if (!contactId) return null;

  return (
    <Drawer
      open
      onClose={onClose}
      title={contact?.name ?? 'Contact'}
      subtitle={contact?.job_title ? `${contact.job_title}${contact.company_name ? ` · ${contact.company_name}` : ''}` : contact?.company_name}
      badge={contact?.is_primary && <Badge size="sm" tone="brand">Primary</Badge>}
    >
      {!contact ? (
        <div className="space-y-3">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-14 w-full" />)}</div>
      ) : (
        <div className="space-y-6">
          <div className="flex items-center gap-4">
            <Avatar name={contact.name} size="xl" />
            <div className="flex gap-2">
              {contact.email && (
                <a href={`mailto:${contact.email}`}><Button variant="secondary" size="sm" icon={Mail}>Email</Button></a>
              )}
              {(contact.phone || contact.mobile) && (
                <a href={`tel:${contact.phone ?? contact.mobile}`}>
                  <Button variant="secondary" size="sm" icon={Phone}>Call</Button>
                </a>
              )}
            </div>
          </div>

          <DetailGrid
            items={[
              { label: 'Email', value: contact.email },
              { label: 'Phone', value: contact.phone },
              { label: 'Mobile', value: contact.mobile },
              { label: 'Company', value: contact.company_name },
              { label: 'Job title', value: contact.job_title },
              { label: 'Department', value: contact.department },
              { label: 'Added', value: relativeTime(contact.created_at) },
              { label: 'Notes', value: contact.notes, full: true },
            ]}
          />

          <div>
            <h3 className="mb-2 text-sm font-medium text-[var(--text-secondary)]">
              Deals ({contact.deals?.length ?? 0})
            </h3>
            {(contact.deals?.length ?? 0) === 0 ? (
              <p className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border-default)] px-3 py-5 text-center text-sm text-[var(--text-tertiary)]">
                No deals linked to this contact.
              </p>
            ) : (
              <ul className="space-y-2">
                {contact.deals.map((deal) => (
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

function CreateContactModal({ open, onClose, onCreated }) {
  const toast = useToast();
  const [form, setForm] = useState({});
  const [companies, setCompanies] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    api.get('/crm/companies', { query: { limit: 100 } }).then((r) => setCompanies(r.data)).catch(() => setCompanies([]));
  }, [open]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = { ...form };
      for (const key of Object.keys(payload)) if (payload[key] === '') delete payload[key];
      const response = await api.post('/crm/contacts', payload);
      toast.success(`${response.data.name} added`);
      setForm({});
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that contact.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New contact"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy} icon={Plus}>Add contact</Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert tone="critical">{error}</Alert>}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name" required>
            {(p) => <Input {...p} value={form.first_name ?? ''} onChange={set('first_name')} required data-autofocus />}
          </Field>
          <Field label="Last name">
            {(p) => <Input {...p} value={form.last_name ?? ''} onChange={set('last_name')} />}
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

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Company">
            {(p) => (
              <Select {...p} value={form.company_id ?? ''} onChange={set('company_id')}>
                <option value="">No company</option>
                {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Job title">
            {(p) => <Input {...p} value={form.job_title ?? ''} onChange={set('job_title')} />}
          </Field>
        </div>

        <Field label="Notes">
          {(p) => <Textarea {...p} rows={3} value={form.notes ?? ''} onChange={set('notes')} />}
        </Field>
      </form>
    </Modal>
  );
}
