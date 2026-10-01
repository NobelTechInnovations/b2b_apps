'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Plus, ClipboardList, ArrowLeft, ArrowUp, ArrowDown, Trash2, Copy, Download, Globe, Lock, RefreshCw, Save, ExternalLink, Code2,
  MessageCircle, Mail,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { date, relativeTime } from '@/lib/format';
import { Can, useWorkspace } from '@/lib/workspace';
import { titleCase } from '@/lib/people';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Textarea, Checkbox } from '@/components/ui/input';
import { Modal, ConfirmModal } from '@/components/ui/modal';
import { Pagination } from '@/components/data/list-shell';
import { Table, THead, TBody, TH, TR, TD, TableSkeleton } from '@/components/ui/table';
import { Badge, Card, CardHeader, CardBody, EmptyState, PageHeader, Alert } from '@/components/ui/primitives';
import { PublicForm } from '@/components/forms/public-form';

const STATUS_TONE = { draft: 'neutral', published: 'positive', closed: 'caution' };
const FIELD_TYPES = [
  ['short_text', 'Short text'], ['long_text', 'Paragraph'], ['email', 'Email'], ['phone', 'Phone'], ['number', 'Number'],
  ['date', 'Date'], ['select', 'Dropdown'], ['multi_select', 'Checkboxes (many)'], ['checkbox', 'Single checkbox'],
];
const MAPS_TO = [
  ['full_name', 'Lead name'], ['first_name', 'First name'], ['last_name', 'Last name'], ['email', 'Email'],
  ['phone', 'Phone'], ['company_name', 'Company'], ['job_title', 'Job title'], ['city', 'City'], ['notes', 'Notes'],
];
const TEMPLATES = {
  enquiry: { name: 'Enquiry form', create_lead: true },
  feedback: {
    name: 'Customer feedback',
    create_lead: false,
    fields: [
      { key: 'full_name', label: 'Your name', type: 'short_text', required: false, maps_to: null },
      { key: 'rating', label: 'How likely are you to recommend us?', type: 'select', required: true, options: ['10', '9', '8', '7', '6', '5', '4', '3', '2', '1', '0'], maps_to: null },
      { key: 'liked', label: 'What did we do well?', type: 'long_text', required: false, maps_to: null },
      { key: 'improve', label: 'What should we do better?', type: 'long_text', required: false, maps_to: null },
    ],
  },
  blank: { name: 'Untitled form', create_lead: false, fields: [] },
};

const slugKey = (label, taken) => {
  const base = (label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f_$1') || 'field').slice(0, 36);
  let key = /^[a-z]/.test(base) ? base : `f_${base}`;
  for (let n = 2; taken.has(key); n += 1) key = `${base.slice(0, 34)}_${n}`;
  return key;
};

export default function FormsClient() {
  const params = useSearchParams();
  const router = useRouter();
  const openId = params.get('form');

  if (openId) return <FormEditor formId={openId} onBack={() => router.push('/surveys')} />;
  return <FormsList onOpen={(id) => router.push(`/surveys?form=${id}`)} />;
}

/* ── list ─────────────────────────────────────────────────────────────────── */

function FormsList({ onOpen }) {
  const toast = useToast();
  const { can } = useWorkspace();
  const [forms, setForms] = useState(null);
  const [error, setError] = useState(null);
  const [choosing, setChoosing] = useState(false);

  useEffect(() => {
    api.get('/surveys/forms').then((r) => setForms(r.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load forms.'));
  }, []);

  async function create(template) {
    try {
      const response = await api.post('/surveys/forms', TEMPLATES[template]);
      onOpen(response.data.id);
    } catch (err) {
      toast.error('Could not create the form', { description: err instanceof ApiError ? err.message : undefined });
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Surveys & Forms"
        description="Enquiry forms that drop straight into CRM as leads, and surveys that collect answers you can export."
        actions={<Can permission="surveys.forms.create"><Button variant="primary" icon={Plus} onClick={() => setChoosing(true)}>New form</Button></Can>}
      />
      {error && <Alert tone="critical">{error}</Alert>}
      {!forms ? <TableSkeleton rows={4} columns={4} /> : forms.length === 0 ? (
        <Card>
          <EmptyState
            icon={ClipboardList}
            title="No forms yet"
            description="Put an enquiry form on your website or WhatsApp bio. Every response becomes a lead with an owner."
            action={can('surveys.forms.create') && <Button variant="primary" icon={Plus} onClick={() => setChoosing(true)}>Create a form</Button>}
          />
        </Card>
      ) : (
        <Table>
          <THead>
            <tr><TH>Form</TH><TH>Status</TH><TH>Creates leads</TH><TH align="right">Responses</TH><TH>Last response</TH></tr>
          </THead>
          <TBody>
            {forms.map((f) => (
              <TR key={f.id} onClick={() => onOpen(f.id)}>
                <TD>
                  <p className="font-medium">{f.name}</p>
                  <p className="text-xs text-[var(--text-tertiary)]">{f.field_count} fields · updated {relativeTime(f.updated_at)}</p>
                </TD>
                <TD><Badge size="sm" tone={STATUS_TONE[f.status]}>{titleCase(f.status)}</Badge></TD>
                <TD>{f.create_lead ? <Badge size="sm" tone="brand">Creates leads</Badge> : <span className="text-[var(--text-tertiary)]">—</span>}</TD>
                <TD align="right" numeric>{f.response_count}</TD>
                <TD className="text-[var(--text-secondary)]">{f.last_response_at ? relativeTime(f.last_response_at) : '—'}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      <Modal open={choosing} onClose={() => setChoosing(false)} title="Start from" size="lg">
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            ['enquiry', 'Enquiry → CRM lead', 'Name, email, phone and a message. Each response becomes a lead.'],
            ['feedback', 'Customer feedback', 'A recommend score and two open questions.'],
            ['blank', 'Blank form', 'Build it field by field.'],
          ].map(([key, title, text]) => (
            <button
              key={key}
              onClick={() => { setChoosing(false); create(key); }}
              className="rounded-[var(--radius-lg)] border border-[var(--border-default)] p-4 text-left transition hover:border-[var(--color-brand-400)] hover:bg-[var(--surface-hover)]"
            >
              <p className="font-medium">{title}</p>
              <p className="mt-1 text-sm text-[var(--text-secondary)]">{text}</p>
            </button>
          ))}
        </div>
      </Modal>
    </div>
  );
}

/* ── editor ───────────────────────────────────────────────────────────────── */

function FormEditor({ formId, onBack }) {
  const toast = useToast();
  const { can, hasApp } = useWorkspace();
  const [form, setForm] = useState(null);
  const [draft, setDraft] = useState(null);
  const [tab, setTab] = useState('build');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(null); // 'delete' | 'rotate'
  const [leadFields, setLeadFields] = useState([]);
  // Leads land in the Leads app or CRM — the same records either way.
  const leadsOn = hasApp('leads') || hasApp('crm');

  // The workspace's own lead fields can be filled straight from an answer.
  useEffect(() => {
    if (hasApp('leads')) api.get('/leads/fields').then((r) => setLeadFields(r.data)).catch(() => {});
  }, [hasApp]);

  const load = useCallback(async () => {
    try {
      const response = await api.get(`/surveys/forms/${formId}`);
      setForm(response.data);
      setDraft(response.data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open that form.');
    }
  }, [formId]);

  useEffect(() => { load(); }, [load]);

  const editable = can('surveys.forms.edit');
  const dirty = form && draft && JSON.stringify(pick(form)) !== JSON.stringify(pick(draft));

  async function save(extra = {}, message = 'Form saved') {
    setSaving(true);
    setError(null);
    try {
      const response = await api.patch(`/surveys/forms/${formId}`, { ...pick(draft), ...extra });
      setForm(response.data);
      setDraft(response.data);
      toast.success(message);
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    try {
      await api.del(`/surveys/forms/${formId}`);
      toast.success('Form deleted');
      onBack();
    } catch (err) {
      toast.error('Could not delete', { description: err instanceof ApiError ? err.message : undefined });
    }
  }

  if (error && !form) return <Alert tone="critical">{error}</Alert>;
  if (!draft) return <TableSkeleton rows={4} columns={2} />;

  const setField = (index, patch) => setDraft((d) => ({ ...d, fields: d.fields.map((f, i) => (i === index ? { ...f, ...patch } : f)) }));
  const move = (index, delta) => setDraft((d) => {
    const fields = [...d.fields];
    const [item] = fields.splice(index, 1);
    fields.splice(index + delta, 0, item);
    return { ...d, fields };
  });
  const addField = () => setDraft((d) => {
    const taken = new Set(d.fields.map((f) => f.key));
    const label = 'New question';
    return { ...d, fields: [...d.fields, { key: slugKey(label, taken), label, type: 'short_text', required: false, maps_to: null, options: [] }] };
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={onBack}>Forms</Button>
        <h1 className="min-w-0 flex-1 truncate text-xl font-semibold tracking-[-0.02em]">{form.name}</h1>
        <Badge tone={STATUS_TONE[form.status]}>{titleCase(form.status)}</Badge>
        {editable && form.status !== 'published' && (
          <Button variant="primary" icon={Globe} loading={saving} onClick={() => save({ status: 'published' }, 'Published — the link is live')}>Publish</Button>
        )}
        {editable && form.status === 'published' && (
          <Button variant="secondary" icon={Lock} loading={saving} onClick={() => save({ status: 'closed' }, 'Closed to new responses')}>Close</Button>
        )}
        {editable && dirty && <Button variant="primary" icon={Save} loading={saving} onClick={() => save()}>Save changes</Button>}
      </div>

      {error && <Alert tone="critical">{error}</Alert>}

      <div className="flex gap-1 border-b border-[var(--border-subtle)] text-sm">
        {[['build', 'Build'], ['responses', `Responses (${form.response_count})`], ['share', 'Share']].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cn('-mb-px border-b-2 px-3 py-2 font-medium', tab === key ? 'border-[var(--color-brand-600)] text-[var(--text-primary)]' : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]')}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'build' && (
        <div className="grid gap-6 xl:grid-cols-[1fr_26rem]">
          <div className="space-y-4">
            <Card>
              <CardBody className="space-y-4 pt-5">
                <Field label="Form name">{(p) => <Input {...p} value={draft.name} disabled={!editable} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />}</Field>
                <Field label="Intro text" hint="Shown above the questions">
                  {(p) => <Textarea {...p} rows={2} value={draft.description} disabled={!editable} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} />}
                </Field>
              </CardBody>
            </Card>

            {draft.fields.map((f, index) => (
              <Card key={f.key} className="p-4">
                <div className="flex flex-wrap items-start gap-3">
                  <span className="mt-2 w-5 text-center text-xs tabular text-[var(--text-tertiary)]">{index + 1}</span>
                  <div className="min-w-0 flex-1 space-y-3">
                    <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
                      <Input value={f.label} disabled={!editable} onChange={(e) => setField(index, { label: e.target.value })} aria-label="Question" />
                      <Select value={f.type} disabled={!editable} onChange={(e) => setField(index, { type: e.target.value })} aria-label="Answer type">
                        {FIELD_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </Select>
                    </div>
                    {['select', 'multi_select'].includes(f.type) && (
                      <Textarea
                        rows={3}
                        disabled={!editable}
                        value={(f.options ?? []).join('\n')}
                        onChange={(e) => setField(index, { options: e.target.value.split('\n').map((o) => o.trimStart()).filter((o, i, all) => o || i === all.length - 1) })}
                        placeholder="One option per line"
                        aria-label="Options"
                      />
                    )}
                    <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                      <Checkbox label="Required" checked={Boolean(f.required)} disabled={!editable} onChange={(e) => setField(index, { required: e.target.checked })} />
                      {draft.create_lead && (
                        <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                          Fills the lead’s
                          <Select value={f.maps_to ?? ''} disabled={!editable} onChange={(e) => setField(index, { maps_to: e.target.value || null })} className="w-auto">
                            <option value="">— nothing —</option>
                            {MAPS_TO.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                            {leadFields.length > 0 && (
                              <optgroup label="Your lead fields">
                                {leadFields.map((lf) => <option key={lf.key} value={`custom.${lf.key}`}>{lf.label}</option>)}
                              </optgroup>
                            )}
                          </Select>
                        </label>
                      )}
                      <Input value={f.help ?? ''} disabled={!editable} onChange={(e) => setField(index, { help: e.target.value })} placeholder="Help text (optional)" className="min-w-[12rem] flex-1" aria-label="Help text" />
                    </div>
                  </div>
                  {editable && (
                    <div className="flex flex-col gap-1">
                      <Button size="icon-sm" variant="ghost" icon={ArrowUp} disabled={index === 0} onClick={() => move(index, -1)} aria-label="Move up" />
                      <Button size="icon-sm" variant="ghost" icon={ArrowDown} disabled={index === draft.fields.length - 1} onClick={() => move(index, 1)} aria-label="Move down" />
                      <Button size="icon-sm" variant="ghost" icon={Trash2} onClick={() => setDraft((d) => ({ ...d, fields: d.fields.filter((_, i) => i !== index) }))} aria-label="Remove question" />
                    </div>
                  )}
                </div>
              </Card>
            ))}
            {editable && <Button variant="secondary" icon={Plus} onClick={addField} disabled={draft.fields.length >= 40}>Add question</Button>}

            <Card>
              <CardHeader title="After someone submits" />
              <CardBody className="space-y-4">
                <Field label="Thank-you message">
                  {(p) => <Input {...p} value={draft.thank_you_message} disabled={!editable} onChange={(e) => setDraft((d) => ({ ...d, thank_you_message: e.target.value }))} />}
                </Field>
                <Checkbox
                  label="Create a lead from each response"
                  description={leadsOn ? 'It appears in Leads with every answer. The same email or phone again adds to the existing lead instead of making a duplicate.' : 'Turn on the Leads or CRM app to use this.'}
                  checked={Boolean(draft.create_lead)}
                  disabled={!editable || !leadsOn}
                  onChange={(e) => setDraft((d) => ({ ...d, create_lead: e.target.checked }))}
                />
                {draft.create_lead && (
                  <Field label="Lead source">
                    {(p) => (
                      <Select {...p} value={draft.lead_source} disabled={!editable} onChange={(e) => setDraft((d) => ({ ...d, lead_source: e.target.value }))} className="max-w-xs">
                        {['website', 'campaign', 'event', 'referral', 'partner'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
                      </Select>
                    )}
                  </Field>
                )}
              </CardBody>
            </Card>

            {can('surveys.forms.delete') && (
              <Button variant="danger-ghost" icon={Trash2} onClick={() => setConfirm('delete')}>Delete form</Button>
            )}
          </div>

          <div className="xl:sticky xl:top-4 xl:h-fit">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--text-tertiary)]">Preview</p>
            <div className="panel p-5">
              <h2 className="text-lg font-semibold">{draft.name}</h2>
              {draft.description && <p className="mt-1 whitespace-pre-wrap text-sm text-[var(--text-secondary)]">{draft.description}</p>}
              <div className="mt-5">
                <PublicForm key={JSON.stringify(draft.fields)} form={{ ...draft, open: true, fields: draft.fields.map((f) => ({ ...f, options: (f.options ?? []).filter(Boolean) })) }} preview />
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === 'responses' && <Responses form={form} />}
      {tab === 'share' && <Share form={form} editable={editable} onRotate={() => setConfirm('rotate')} />}

      <ConfirmModal open={confirm === 'delete'} onClose={() => setConfirm(null)} onConfirm={remove} danger title="Delete this form?" description="Its responses are deleted too. Leads it already created stay in CRM." confirmLabel="Delete" />
      <ConfirmModal
        open={confirm === 'rotate'}
        onClose={() => setConfirm(null)}
        onConfirm={async () => { setConfirm(null); await save({ rotate_link: true }, 'New link created — the old one no longer works'); }}
        title="Replace the link?"
        description="Anyone using the old link or embed will see “not found”. Use this if spam found your form."
        confirmLabel="Replace link"
      />
    </div>
  );
}

// The fields the editor can change — what "unsaved changes" compares.
function pick(f) {
  return {
    name: f.name, description: f.description ?? '', thank_you_message: f.thank_you_message,
    create_lead: f.create_lead, lead_source: f.lead_source,
    fields: f.fields.map((x) => ({
      key: x.key, label: x.label, type: x.type, required: Boolean(x.required), maps_to: x.maps_to ?? null,
      ...(['select', 'multi_select'].includes(x.type) ? { options: (x.options ?? []).filter(Boolean) } : {}),
      ...(x.help ? { help: x.help } : {}),
    })),
  };
}

function Responses({ form }) {
  const { can } = useWorkspace();
  const [rows, setRows] = useState(null);
  const [meta, setMeta] = useState(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [error, setError] = useState(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      api.get(`/surveys/forms/${form.id}/responses`, { query: { page, limit: 25, q: search || undefined } })
        .then((r) => { setRows(r.data); setMeta(r.meta); })
        .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load responses.'));
    }, search ? 280 : 0);
    return () => clearTimeout(timer);
  }, [form.id, page, search]);

  const columns = form.fields.slice(0, 5);
  const show = (v) => (Array.isArray(v) ? v.join(', ') : v === true ? 'Yes' : v === false ? 'No' : v ?? '—');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Search answers…" className="w-full max-w-xs" />
        <div className="flex-1" />
        {can('surveys.responses.export') && (
          <a href={`/api/surveys/forms/${form.id}/responses.csv`}><Button variant="secondary" icon={Download}>Export CSV</Button></a>
        )}
      </div>
      {error && <Alert tone="critical">{error}</Alert>}
      {!rows ? <TableSkeleton rows={5} columns={4} /> : rows.length === 0 ? (
        <Card><EmptyState icon={ClipboardList} title="No responses yet" description={form.status === 'published' ? 'Share the link and they will appear here.' : 'Publish the form to start collecting responses.'} /></Card>
      ) : (
        <>
          <Table>
            <THead>
              <tr>
                <TH>Submitted</TH>
                {columns.map((c) => <TH key={c.key}>{c.label}</TH>)}
                {form.create_lead && <TH>Lead</TH>}
              </tr>
            </THead>
            <TBody>
              {rows.map((r) => (
                <TR key={r.id}>
                  <TD className="whitespace-nowrap text-[var(--text-secondary)]">{date(r.submitted_at, 'datetime')}</TD>
                  {columns.map((c) => <TD key={c.key}><span className="line-clamp-2 max-w-xs">{show(r.answers[c.key])}</span></TD>)}
                  {form.create_lead && (
                    <TD>{r.lead_id ? <a className="text-[var(--color-brand-600)] hover:underline" href={`/crm/leads?open=${r.lead_id}`}>Open lead</a> : '—'}</TD>
                  )}
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination meta={meta} onPage={setPage} />
        </>
      )}
    </div>
  );
}

function Share({ form, editable, onRotate }) {
  const toast = useToast();
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const link = `${origin}/f/${form.public_token}`;
  const embed = `<iframe src="${link}" title="${form.name.replace(/"/g, '&quot;')}" style="width:100%;min-height:640px;border:0" loading="lazy"></iframe>`;

  const copy = async (text, what) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${what} copied`);
    } catch {
      toast.error('Copy failed');
    }
  };

  return (
    <div className="max-w-2xl space-y-4">
      {form.status !== 'published' && (
        <Alert tone="caution">This form is {form.status}. {form.status === 'draft' ? 'Publish it' : 'Reopen it by publishing again'} before sharing — until then the link shows “not accepting responses” or “not found”.</Alert>
      )}
      <Card>
        <CardHeader title="Link" description="Anyone with the link can respond. Paste it in WhatsApp, Instagram bio, emails or ads." />
        <CardBody className="space-y-3">
          <div className="flex gap-2">
            <Input value={link} readOnly className="flex-1 font-mono text-xs" aria-label="Form link" />
            <Button icon={Copy} onClick={() => copy(link, 'Link')}>Copy</Button>
            <a href={link} target="_blank" rel="noreferrer"><Button variant="ghost" icon={ExternalLink} aria-label="Open" /></a>
          </div>
          <div className="flex flex-wrap gap-2">
            <a href={`https://wa.me/?text=${encodeURIComponent(`${form.name}: ${link}`)}`} target="_blank" rel="noreferrer">
              <Button variant="secondary" size="sm" icon={MessageCircle}>Share on WhatsApp</Button>
            </a>
            <a href={`mailto:?subject=${encodeURIComponent(form.name)}&body=${encodeURIComponent(link)}`}>
              <Button variant="secondary" size="sm" icon={Mail}>Email it</Button>
            </a>
          </div>
          <p className="text-xs text-[var(--text-tertiary)]">No account or sign-in needed to fill it in. Each response is checked against your questions, and spam bots are filtered out.</p>
          {editable && <Button variant="ghost" size="sm" icon={RefreshCw} onClick={onRotate}>Replace link</Button>}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Embed on your website" description="Paste this where the form should appear." />
        <CardBody className="space-y-3">
          <pre className="overflow-x-auto rounded-[var(--radius-md)] bg-[var(--surface-sunken)] p-3 text-xs"><code>{embed}</code></pre>
          <Button icon={Code2} onClick={() => copy(embed, 'Embed code')}>Copy embed code</Button>
        </CardBody>
      </Card>
    </div>
  );
}
