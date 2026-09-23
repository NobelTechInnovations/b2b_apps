'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Plus, FileSignature, Send, Eye, Ban, Trash2, CheckCircle2, Clock3,
  Users, KeyRound, Mail, ShieldOff, Pencil,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Can, useWorkspace } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Textarea, Checkbox } from '@/components/ui/input';
import { Modal, ConfirmModal } from '@/components/ui/modal';
import { Drawer } from '@/components/data/drawer';
import { ListToolbar, Pagination } from '@/components/data/list-shell';
import { Table, THead, TBody, TH, TR, TD, TableSkeleton } from '@/components/ui/table';
import { Markdown } from '@/components/data/markdown';
import {
  Avatar, Badge, Card, EmptyState, PageHeader, Alert, Skeleton, Divider,
} from '@/components/ui/primitives';
import { date as fmtDate, relativeTime } from '@/lib/format';
import { cn } from '@/lib/cn';

const KINDS = [
  { value: 'offer', label: 'Offer letter' },
  { value: 'appointment', label: 'Appointment letter' },
  { value: 'confirmation', label: 'Confirmation' },
  { value: 'increment', label: 'Increment letter' },
  { value: 'promotion', label: 'Promotion letter' },
  { value: 'experience', label: 'Experience certificate' },
  { value: 'relieving', label: 'Relieving letter' },
  { value: 'warning', label: 'Warning' },
  { value: 'noc', label: 'No-objection certificate' },
  { value: 'contract', label: 'Contract' },
  { value: 'custom', label: 'Other' },
];

const STATUS_TONE = { draft: 'neutral', issued: 'info', acknowledged: 'positive', revoked: 'critical' };

export default function EmployeeDocumentsClient() {
  const { can } = useWorkspace();
  const [tab, setTab] = useState('documents');

  return (
    <div className="space-y-5">
      <PageHeader
        title="Employee documents"
        description="Offer letters, certificates and portal access."
      />

      <div className="flex gap-1 border-b border-[var(--border-subtle)]">
        {[
          { key: 'documents', label: 'Issued documents', icon: FileSignature },
          { key: 'templates', label: 'Letter templates', icon: Pencil },
          { key: 'portal', label: 'Portal access', icon: KeyRound },
        ].map((item) => (
          <button
            key={item.key}
            onClick={() => setTab(item.key)}
            className={cn(
              'relative -mb-px flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors',
              tab === item.key
                ? 'border-b-2 border-[var(--color-brand-500)] text-[var(--text-primary)]'
                : 'border-b-2 border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
            )}
          >
            <item.icon className="size-4" />{item.label}
          </button>
        ))}
      </div>

      {tab === 'documents' && <DocumentsTab can={can} />}
      {tab === 'templates' && <TemplatesTab can={can} />}
      {tab === 'portal' && <PortalTab can={can} />}
    </div>
  );
}

/* ── issued documents ───────────────────────────────────────────────────── */
function DocumentsTab({ can }) {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({});
  const [page, setPage] = useState(1);
  const [issuing, setIssuing] = useState(false);
  const [open, setOpen] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.get('/hr/employee-documents', {
        query: { ...filters, q: search || undefined, page, limit: 25 },
      });
      setRows(response.data);
      setMeta(response.meta ?? {});
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [filters, search, page]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <ListToolbar
        search={search}
        onSearch={(v) => { setSearch(v); setPage(1); }}
        searchPlaceholder="Search by person, title or reference…"
        filters={[
          { key: 'kind', label: 'Type', options: KINDS },
          {
            key: 'status', label: 'Status',
            options: [
              { value: 'draft', label: 'Draft' },
              { value: 'issued', label: 'Issued' },
              { value: 'acknowledged', label: 'Acknowledged' },
              { value: 'revoked', label: 'Revoked' },
            ],
          },
        ]}
        values={filters}
        onFilter={(k, v) => { setFilters((f) => ({ ...f, [k]: v })); setPage(1); }}
        onClear={() => { setFilters({}); setPage(1); }}
        actions={
          <Can permission="hr.documents.manage">
            <Button variant="primary" icon={Plus} onClick={() => setIssuing(true)}>Issue a letter</Button>
          </Can>
        }
      />

      <Card>
        {loading ? (
          <TableSkeleton rows={6} columns={5} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={FileSignature}
            title="No documents issued yet"
            description="Offer letters, confirmations and certificates are generated from the employee record, so the figures in them are the ones payroll will pay."
            action={can('hr.documents.manage') && (
              <Button variant="primary" icon={Plus} onClick={() => setIssuing(true)}>Issue a letter</Button>
            )}
          />
        ) : (
          <>
            <Table>
              <THead>
                <tr>
                  <TH>Person</TH>
                  <TH>Document</TH>
                  <TH>Reference</TH>
                  <TH>Issued</TH>
                  <TH>Status</TH>
                </tr>
              </THead>
              <TBody>
                {rows.map((row) => (
                  <TR key={row.id} onClick={() => setOpen(row.id)}>
                    <TD>
                      <div className="flex items-center gap-2.5">
                        <Avatar name={row.name} size="sm" />
                        <div className="min-w-0">
                          <p className="truncate font-medium">{row.name}</p>
                          <p className="truncate text-xs text-[var(--text-tertiary)]">
                            {row.designation ?? row.employee_code}
                          </p>
                        </div>
                      </div>
                    </TD>
                    <TD>
                      <p className="truncate font-medium">{row.title}</p>
                      <p className="text-xs text-[var(--text-tertiary)]">
                        {KINDS.find((k) => k.value === row.kind)?.label ?? row.kind}
                      </p>
                    </TD>
                    <TD className="font-mono text-xs">{row.reference ?? '—'}</TD>
                    <TD className="text-[var(--text-secondary)]">
                      {row.issued_on ? fmtDate(row.issued_on) : '—'}
                    </TD>
                    <TD>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={STATUS_TONE[row.status]} size="sm">{row.status}</Badge>
                        {row.requires_acknowledgement && !row.acknowledged_at && row.status === 'issued' && (
                          <Badge tone="caution" size="sm">
                            <Clock3 className="size-3" />awaiting
                          </Badge>
                        )}
                        {!row.visible_to_employee && (
                          <Badge tone="neutral" size="sm">
                            <ShieldOff className="size-3" />internal
                          </Badge>
                        )}
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination meta={meta} onPage={setPage} />
          </>
        )}
      </Card>

      {issuing && (
        <IssueModal onClose={() => setIssuing(false)} onDone={async () => { setIssuing(false); await load(); }} />
      )}

      {open && (
        <DocumentDrawer documentId={open} onClose={() => setOpen(null)} onChanged={load} />
      )}
    </div>
  );
}

/* ── issuing a letter, with a live preview ──────────────────────────────── */
function IssueModal({ onClose, onDone }) {
  const toast = useToast();
  const [employees, setEmployees] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [form, setForm] = useState({
    employee_id: '', template_id: '',
    requires_acknowledgement: true, visible_to_employee: true,
    valid_until: '',
  });
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState(false);

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  useEffect(() => {
    Promise.all([
      api.get('/hr/employees', { query: { status: 'active', limit: 100 } }),
      api.get('/hr/letter-templates'),
    ])
      .then(([e, t]) => {
        setEmployees(e.data);
        setTemplates(t.data);
        setForm((f) => ({ ...f, template_id: t.data.find((x) => x.kind === 'offer')?.id ?? t.data[0]?.id ?? '' }));
      })
      .catch(() => {});
  }, []);

  // The preview is rendered by the same code that will freeze the letter at
  // issue, so what you approve is exactly what goes out.
  useEffect(() => {
    if (!form.employee_id || !form.template_id) { setPreview(null); return; }
    setPreviewing(true);
    const timer = setTimeout(() => {
      api.post('/hr/employee-documents/preview', {
        employee_id: form.employee_id,
        template_id: form.template_id,
        valid_until: form.valid_until || undefined,
      })
        .then((r) => setPreview(r.data))
        .catch(() => setPreview(null))
        .finally(() => setPreviewing(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [form.employee_id, form.template_id, form.valid_until]);

  async function issue(andIssue) {
    setBusy(true);
    try {
      await api.post('/hr/employee-documents', {
        employee_id: form.employee_id,
        template_id: form.template_id,
        issue: andIssue,
        requires_acknowledgement: form.requires_acknowledgement,
        visible_to_employee: form.visible_to_employee,
        valid_until: form.valid_until || undefined,
      });
      toast.success(andIssue ? 'Letter issued' : 'Draft saved', {
        description: andIssue && form.visible_to_employee
          ? 'It is now visible in their portal.'
          : undefined,
      });
      await onDone();
    } catch (err) {
      toast.error('Could not issue that letter', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Issue a letter"
      description="Filled in from the employee record and their salary, so nothing is retyped."
      size="xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="secondary" onClick={() => issue(false)} disabled={!preview} loading={busy}>
            Save as draft
          </Button>
          <Button variant="primary" icon={Send} onClick={() => issue(true)} disabled={!preview} loading={busy}>
            Issue
          </Button>
        </>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[18rem_1fr]">
        <div className="space-y-4">
          <Field label="Person" required>
            <Select value={form.employee_id} onChange={(e) => set('employee_id', e.target.value)}>
              <option value="">Choose…</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name ?? `${e.first_name} ${e.last_name ?? ''}`.trim()} · {e.employee_code}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Letter" required>
            <Select value={form.template_id} onChange={(e) => set('template_id', e.target.value)}>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>

          <Field label="Valid until" hint="Used by offer letters as the acceptance deadline">
            <Input type="date" value={form.valid_until} onChange={(e) => set('valid_until', e.target.value)} />
          </Field>

          <Divider />

          <Checkbox
            label="Visible in their portal"
            description="Uncheck for internal notes the employee should not see."
            checked={form.visible_to_employee}
            onChange={(e) => set('visible_to_employee', e.target.checked)}
          />
          <Checkbox
            label="Ask them to acknowledge it"
            description="They confirm they have read it, and the time is recorded."
            checked={form.requires_acknowledgement}
            onChange={(e) => set('requires_acknowledgement', e.target.checked)}
            disabled={!form.visible_to_employee}
          />
        </div>

        <div className="min-w-0">
          <p className="mb-2 text-sm font-medium text-[var(--text-secondary)]">Preview</p>
          <div className="max-h-[26rem] overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-white px-8 py-7 text-[#111827]">
            {previewing ? (
              <Skeleton className="h-64 w-full" />
            ) : preview ? (
              <Markdown>{preview.body}</Markdown>
            ) : (
              <p className="py-12 text-center text-sm text-[#6b7280]">
                Choose a person to see their letter.
              </p>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* ── one document ───────────────────────────────────────────────────────── */
function DocumentDrawer({ documentId, onClose, onChanged }) {
  const toast = useToast();
  const [document, setDocument] = useState(null);
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await api.get(`/hr/employee-documents/${documentId}`);
      setDocument(response.data);
    } catch {
      setDocument(null);
    }
  }, [documentId]);

  useEffect(() => { load(); }, [load]);

  async function issue() {
    setBusy(true);
    try {
      await api.post(`/hr/employee-documents/${documentId}/issue`, {});
      toast.success('Letter issued');
      await load();
      await onChanged();
    } catch (err) {
      toast.error('Could not issue it', { description: err instanceof ApiError ? err.message : undefined });
    } finally {
      setBusy(false);
    }
  }

  async function revoke(reason) {
    setBusy(true);
    try {
      await api.post(`/hr/employee-documents/${documentId}/revoke`, { reason });
      toast.success('Letter revoked', { description: 'It is hidden from their portal, but kept on record.' });
      setRevoking(false);
      await load();
      await onChanged();
    } catch (err) {
      toast.error('Could not revoke it', { description: err instanceof ApiError ? err.message : undefined });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Drawer
        open
        onClose={onClose}
        title={document?.title ?? 'Document'}
        subtitle={document ? `${document.name} · ${document.reference ?? 'draft'}` : undefined}
        badge={document && <Badge tone={STATUS_TONE[document.status]}>{document.status}</Badge>}
        width="lg"
        footer={
          document && (
            <div className="flex w-full items-center gap-2">
              <Can permission="hr.documents.manage">
                {document.status === 'draft' && (
                  <Button variant="primary" icon={Send} onClick={issue} loading={busy}>Issue</Button>
                )}
                {document.status !== 'revoked' && document.status !== 'draft' && (
                  <Button variant="danger-ghost" icon={Ban} onClick={() => setRevoking(true)}>Revoke</Button>
                )}
              </Can>
              <div className="flex-1" />
              {document.body && (
                <Button variant="secondary" onClick={() => window.print()}>Print</Button>
              )}
            </div>
          )
        }
      >
        {!document ? (
          <Skeleton className="h-96 w-full" />
        ) : (
          <div className="space-y-4">
            {document.status === 'revoked' && (
              <Alert tone="critical" title="Revoked">
                {document.revoke_reason} — {relativeTime(document.revoked_at)}
              </Alert>
            )}
            {document.acknowledged_at && (
              <Alert tone="positive" icon={CheckCircle2}>
                Acknowledged by {document.name} on {fmtDate(document.acknowledged_at, 'datetime')}.
              </Alert>
            )}
            {document.requires_acknowledgement && !document.acknowledged_at && document.status === 'issued' && (
              <Alert tone="caution" icon={Clock3}>
                Waiting for {document.name} to acknowledge it in their portal.
              </Alert>
            )}
            {!document.visible_to_employee && (
              <Alert tone="neutral" icon={ShieldOff}>
                Internal — this is not shown in their portal.
              </Alert>
            )}

            {document.body ? (
              <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-white px-8 py-7 text-[#111827]">
                <Markdown>{document.body}</Markdown>
              </div>
            ) : (
              <EmptyState icon={FileSignature} title={document.file_name ?? 'No letter body'} />
            )}
          </div>
        )}
      </Drawer>

      {revoking && (
        <RevokeModal
          title={document.title}
          onClose={() => setRevoking(false)}
          onConfirm={revoke}
          busy={busy}
        />
      )}
    </>
  );
}

function RevokeModal({ title, onClose, onConfirm, busy }) {
  const [reason, setReason] = useState('');
  return (
    <Modal
      open
      onClose={onClose}
      title={`Revoke “${title}”?`}
      description="It is hidden from their portal but kept on record — a revoked letter is part of the employment history."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="danger" onClick={() => onConfirm(reason)} disabled={!reason.trim()} loading={busy}>
            Revoke
          </Button>
        </>
      }
    >
      <Field label="Why" required>
        <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      </Field>
    </Modal>
  );
}

/* ── templates ──────────────────────────────────────────────────────────── */
function TemplatesTab({ can }) {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    try {
      const response = await api.get('/hr/letter-templates');
      setRows(response.data);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <Skeleton className="h-64 w-full" />;

  return (
    <>
      <div className="stagger grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((template) => (
          <Card key={template.id} className="panel-hover flex flex-col p-5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="truncate text-md font-semibold">{template.name}</h3>
                <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">
                  {KINDS.find((k) => k.value === template.kind)?.label ?? template.kind}
                </p>
              </div>
              {template.is_default && <Badge tone="brand" size="sm">Default</Badge>}
            </div>

            <p className="mt-3 line-clamp-3 text-xs leading-relaxed text-[var(--text-secondary)]">
              {String(template.body).replace(/[#*|]/g, '').slice(0, 160)}…
            </p>

            <div className="mt-auto flex items-center gap-2 pt-4 text-sm text-[var(--text-secondary)]">
              <span className="inline-flex items-center gap-1">
                <FileSignature className="size-3.5" />{template.issued_count} issued
              </span>
              {can('hr.documents.manage') && (
                <Button
                  variant="ghost" size="sm" icon={Pencil}
                  className="ml-auto"
                  onClick={() => setEditing(template)}
                >
                  Edit
                </Button>
              )}
            </div>
          </Card>
        ))}
      </div>

      {editing && (
        <TemplateModal
          template={editing}
          onClose={() => setEditing(null)}
          onDone={async () => { setEditing(null); await load(); }}
        />
      )}
    </>
  );
}

function TemplateModal({ template, onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: template.name, subject: template.subject ?? '', body: template.body,
  });
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api.patch(`/hr/letter-templates/${template.id}`, {
        name: form.name.trim(),
        subject: form.subject?.trim() || undefined,
        body: form.body,
      });
      toast.success('Template saved', {
        description: 'Letters already issued keep the words they went out with.',
      });
      await onDone();
    } catch (err) {
      toast.error('Could not save that template', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit ${template.name}`}
      description="Markdown, with {{placeholders}} filled from the employee record when a letter is issued."
      size="xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={busy}>Save template</Button>
        </>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[1fr_16rem]">
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" required>
              <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </Field>
            <Field label="Document title" hint="Becomes the title of each issued letter">
              <Input value={form.subject} onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))} />
            </Field>
          </div>
          <Field label="Body" required>
            <Textarea
              rows={18}
              className="font-mono text-xs"
              value={form.body}
              onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
            />
          </Field>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium">Placeholders</p>
          <div className="space-y-1 rounded-[var(--radius-lg)] bg-[var(--surface-sunken)] p-3 text-xs">
            {[
              ['employee_name', 'Full name'],
              ['first_name', 'First name'],
              ['employee_code', 'EMP-001'],
              ['designation', 'Job title'],
              ['department', 'Department'],
              ['department_clause', '" in Production", or nothing'],
              ['joining_date', 'Date of joining'],
              ['exit_date', 'Last working day'],
              ['annual_ctc', 'From payroll'],
              ['monthly_gross', 'From payroll'],
              ['manager', 'Reporting manager'],
              ['location', 'Work location'],
              ['company', 'Your workspace name'],
              ['company_address', 'Registered address'],
              ['date', "Today's date"],
              ['valid_until', 'Acceptance deadline'],
              ['issued_by', 'Whoever issues it'],
            ].map(([key, hint]) => (
              <div key={key} className="flex items-baseline justify-between gap-2">
                <code className="font-mono text-[var(--color-brand-600)] dark:text-[var(--color-brand-400)]">
                  {`{{${key}}}`}
                </code>
                <span className="truncate text-[var(--text-tertiary)]">{hint}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* ── portal access ──────────────────────────────────────────────────────── */
function PortalTab({ can }) {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState({});
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState(() => new Set());
  const [inviting, setInviting] = useState(false);
  const [revoking, setRevoking] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(null);

  const load = useCallback(async () => {
    try {
      const response = await api.get('/hr/portal/access');
      setRows(response.data);
      setMeta(response.meta ?? {});
      setPicked(new Set());
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function invite() {
    setBusy(true);
    try {
      const response = await api.post('/hr/portal/invite', { employee_ids: [...picked] });
      setInviting(false);
      setSent(response.data);
      await load();
    } catch (err) {
      toast.error('Could not send those invitations', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    setBusy(true);
    try {
      const response = await api.post('/hr/portal/revoke', { employee_id: revoking.id });
      toast.success(`Portal access removed for ${revoking.name}`, {
        description: response.data?.note,
      });
      setRevoking(null);
      await load();
    } catch (err) {
      toast.error('Could not revoke access', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Skeleton className="h-64 w-full" />;

  const counts = meta.counts ?? {};

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-4">
        {[
          { label: 'Using the portal', value: counts.active ?? 0, tone: 'positive' },
          { label: 'Invited', value: counts.invited ?? 0, tone: 'caution' },
          { label: 'No access', value: counts.none ?? 0, tone: 'neutral' },
          { label: 'Suspended', value: counts.suspended ?? 0, tone: 'neutral' },
        ].map((item) => (
          <div key={item.label} className="panel p-4">
            <p className="truncate text-sm text-[var(--text-secondary)]">{item.label}</p>
            <p className="metric mt-2 text-2xl font-semibold tabular">{item.value}</p>
          </div>
        ))}
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] px-5 py-3">
          <p className="text-sm text-[var(--text-secondary)]">
            {picked.size > 0 ? `${picked.size} selected` : `${rows.length} people`}
          </p>
          <div className="flex-1" />
          {can('hr.employees.edit') && (
            <Button
              variant="primary" size="sm" icon={Mail}
              disabled={picked.size === 0}
              onClick={() => setInviting(true)}
            >
              Invite to the portal
            </Button>
          )}
        </div>

        <Table>
          <THead>
            <tr>
              <TH width="2.5rem">{''}</TH>
              <TH>Person</TH>
              <TH>Email</TH>
              <TH>Status</TH>
              <TH align="right">{''}</TH>
            </tr>
          </THead>
          <TBody>
            {rows.map((row) => {
              const selectable = row.portal_status === 'none' || row.portal_status === 'suspended';
              return (
                <TR key={row.id}>
                  <TD>
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--color-brand-600)]"
                      disabled={!selectable || !row.invitable}
                      checked={picked.has(row.id)}
                      onChange={() =>
                        setPicked((set) => {
                          const next = new Set(set);
                          if (next.has(row.id)) next.delete(row.id); else next.add(row.id);
                          return next;
                        })
                      }
                    />
                  </TD>
                  <TD>
                    <div className="flex items-center gap-2.5">
                      <Avatar name={row.name} size="sm" />
                      <div className="min-w-0">
                        <p className="truncate font-medium">{row.name}</p>
                        <p className="truncate text-xs text-[var(--text-tertiary)]">
                          {row.designation ?? row.employee_code}
                        </p>
                      </div>
                    </div>
                  </TD>
                  <TD className="text-[var(--text-secondary)]">
                    {row.email ?? row.personal_email ?? (
                      <span className="text-[var(--color-caution-600)]">no email on record</span>
                    )}
                  </TD>
                  <TD>
                    <Badge
                      tone={{ active: 'positive', invited: 'caution', none: 'neutral', suspended: 'critical' }[row.portal_status]}
                      size="sm"
                    >
                      {row.portal_status === 'none' ? 'no access' : row.portal_status}
                    </Badge>
                    {row.portal_invited_at && row.portal_status === 'invited' && (
                      <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">
                        {relativeTime(row.portal_invited_at)}
                      </p>
                    )}
                  </TD>
                  <TD align="right">
                    {row.linked && can('hr.employees.edit') && (
                      <Button variant="danger-ghost" size="sm" onClick={() => setRevoking(row)}>
                        Revoke
                      </Button>
                    )}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </Card>

      <ConfirmModal
        open={inviting}
        onClose={() => setInviting(false)}
        onConfirm={invite}
        title={`Invite ${picked.size} ${picked.size === 1 ? 'person' : 'people'} to the portal?`}
        description="They get an email invitation. Once they accept, they can see their own attendance, leave, payslips and documents — and nothing else."
        confirmLabel="Send invitations"
        loading={busy}
      />

      <ConfirmModal
        open={Boolean(revoking)}
        onClose={() => setRevoking(null)}
        onConfirm={revoke}
        title={`Remove ${revoking?.name}'s portal access?`}
        description="They stay an employee and their records are untouched — they just cannot sign in to see them. Their workspace membership is separate."
        confirmLabel="Remove access"
        danger
        loading={busy}
      />

      {sent && (
        <Modal
          open
          onClose={() => setSent(null)}
          title="Invitations sent"
          footer={<Button variant="primary" onClick={() => setSent(null)}>Done</Button>}
        >
          <div className="space-y-3">
            {sent.invited.length > 0 && (
              <div>
                <p className="text-sm font-medium">
                  {sent.invited.length} invitation{sent.invited.length === 1 ? '' : 's'} sent
                </p>
                <ul className="mt-1.5 space-y-1 text-sm text-[var(--text-secondary)]">
                  {sent.invited.map((row) => (
                    <li key={row.email} className="truncate">{row.name} · {row.email}</li>
                  ))}
                </ul>
              </div>
            )}
            {sent.skipped.length > 0 && (
              <Alert tone="caution" title={`${sent.skipped.length} skipped`}>
                {sent.skipped.map((row) => `${row.name} — ${row.reason}`).join('; ')}
              </Alert>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
