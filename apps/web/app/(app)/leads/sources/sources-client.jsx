'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Sheet, Webhook, ClipboardList, RefreshCw, Pause, Play, Trash2, Copy, Settings2, Plug, AlertTriangle, Link2, KeyRound, Search,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Checkbox } from '@/components/ui/input';
import { Modal, ConfirmModal } from '@/components/ui/modal';
import { Card, CardBody, PageHeader, Alert, Badge, Skeleton } from '@/components/ui/primitives';
import { Chip, useLeadsMeta } from '@/components/leads/lead-kit';

const KINDS = {
  google_sheet: { label: 'Google Sheet', icon: Sheet, blurb: 'New rows become leads every 15 minutes.' },
  meta: { label: 'Meta lead ads', icon: MetaIcon, blurb: 'Facebook and Instagram lead forms.' },
  webhook: { label: 'Webhook', icon: Webhook, blurb: 'Website forms, Zapier, Make, Pabbly, IndiaMART.' },
};

function MetaIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3 15.5c0-4.5 2.2-8.5 4.8-8.5 2.6 0 4.4 4.4 6.2 7.4 1.6 2.6 2.8 3.6 4.2 3.6 1.7 0 2.8-1.6 2.8-4 0-4-2-7-4.6-7-2.3 0-4 2.6-5.4 5.2" />
      <path d="M3 15.5C3 17.4 4 19 5.6 19c1.9 0 3-1.7 4.6-4.6" />
    </svg>
  );
}

export default function SourcesClient() {
  const toast = useToast();
  const { meta } = useLeadsMeta();
  const [sources, setSources] = useState(null);
  const [info, setInfo] = useState({});
  const [error, setError] = useState(null);
  const [connecting, setConnecting] = useState(null);
  const [editing, setEditing] = useState(null);
  const [showing, setShowing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [syncing, setSyncing] = useState(null);

  const load = useCallback(async () => {
    try {
      const response = await api.get('/leads/sources');
      setSources(response.data);
      setInfo(response.meta);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load lead sources.');
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function sync(source) {
    setSyncing(source.id);
    try {
      const result = (await api.post(`/leads/sources/${source.id}/sync`, {})).data;
      toast.success(`${result.created} new lead${result.created === 1 ? '' : 's'}`, { description: result.duplicates ? `${result.duplicates} already in your leads.` : undefined });
    } catch (err) {
      toast.error('Sync failed', { description: err instanceof ApiError ? err.message : undefined });
    } finally {
      setSyncing(null);
      load();
    }
  }

  async function update(source, body, message) {
    try {
      await api.patch(`/leads/sources/${source.id}`, body);
      toast.success(message);
      load();
    } catch (err) {
      toast.error('Could not update it', { description: err instanceof ApiError ? err.message : undefined });
    }
  }

  const people = new Map((meta?.team ?? []).map((m) => [m.user_id, m.name ?? m.email]));
  const stages = new Map((meta?.stages ?? []).map((s) => [s.id, s.name]));

  return (
    <div className="space-y-6">
      <PageHeader title="Lead sources" description="Connect the places your leads come from, and they arrive here by themselves — shared out to your team." />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Object.entries(KINDS).map(([kind, k]) => (
          <Card key={kind} interactive className="cursor-pointer" onClick={() => setConnecting(kind)}>
            <CardBody className="space-y-2">
              <k.icon className="size-6 text-[var(--text-brand)]" />
              <p className="font-medium">{k.label}</p>
              <p className="text-sm text-[var(--text-secondary)]">{k.blurb}</p>
              <p className="text-sm font-medium text-[var(--text-brand)]">Connect →</p>
            </CardBody>
          </Card>
        ))}
        <Link href="/surveys">
          <Card interactive className="h-full">
            <CardBody className="space-y-2">
              <ClipboardList className="size-6 text-[var(--text-brand)]" />
              <p className="font-medium">Survey forms</p>
              <p className="text-sm text-[var(--text-secondary)]">A public form anyone can fill without an account. Turn on “Create a lead”.</p>
              <p className="text-sm font-medium text-[var(--text-brand)]">Open Surveys →</p>
            </CardBody>
          </Card>
        </Link>
      </div>

      {error && <Alert tone="critical">{error}</Alert>}

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-[var(--text-secondary)]">Connected</h2>
        {!sources ? <Skeleton className="h-24" /> : sources.length === 0 && !(info.forms?.length) ? (
          <Card><CardBody className="text-center text-sm text-[var(--text-tertiary)]">Nothing connected yet. Pick a source above.</CardBody></Card>
        ) : (
          <div className="space-y-2">
            {sources.map((s) => {
              const k = KINDS[s.kind];
              return (
                <Card key={s.id}>
                  <CardBody className="flex flex-wrap items-start gap-4">
                    <k.icon className="mt-0.5 size-5 shrink-0 text-[var(--text-secondary)]" />
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="flex flex-wrap items-center gap-2 font-medium">
                        {s.name}
                        <Badge size="sm">{k.label}</Badge>
                        <Badge size="sm" dot tone={s.status === 'active' ? 'positive' : s.status === 'error' ? 'critical' : 'neutral'}>{s.status === 'error' ? 'needs attention' : s.status}</Badge>
                      </p>
                      <p className="text-sm text-[var(--text-secondary)]">
                        {s.lead_count} lead{s.lead_count === 1 ? '' : 's'}
                        {s.last_synced_at ? ` · last ${s.kind === 'webhook' ? 'lead' : 'sync'} ${relativeTime(s.last_synced_at)}` : ''}
                        {s.kind === 'meta' && s.config.page_name ? ` · Page: ${s.config.page_name}` : ''}
                        {s.kind === 'meta' ? ` · ${s.config.form_ids?.length ? `${s.config.form_ids.length} form${s.config.form_ids.length === 1 ? '' : 's'}` : 'all forms'}` : ''}
                      </p>
                      <p className="text-xs text-[var(--text-tertiary)]">
                        {s.assign_to.length ? `Shared between ${s.assign_to.map((id) => people.get(id) ?? 'a former member').join(', ')}` : 'Left unassigned'}
                        {s.stage_id ? ` · into ${stages.get(s.stage_id) ?? 'a stage'}` : ''}
                        {s.tags.length ? ` · tagged ${s.tags.join(', ')}` : ''}
                      </p>
                      {s.status === 'error' && s.last_error && <Alert tone="critical" icon={AlertTriangle} className="mt-2">{s.last_error}</Alert>}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {s.kind !== 'webhook' && <Button size="sm" variant="secondary" icon={RefreshCw} loading={syncing === s.id} onClick={() => sync(s)}>Sync now</Button>}
                      {s.kind === 'webhook' && <Button size="sm" variant="secondary" icon={Link2} onClick={() => setShowing(s)}>Show link</Button>}
                      <Button size="sm" variant="ghost" icon={s.status === 'paused' ? Play : Pause} onClick={() => update(s, { status: s.status === 'paused' ? 'active' : 'paused' }, s.status === 'paused' ? 'Resumed' : 'Paused')}>
                        {s.status === 'paused' ? 'Resume' : 'Pause'}
                      </Button>
                      <Button size="icon-sm" variant="ghost" aria-label="Settings" title="Settings" onClick={() => setEditing(s)}><Settings2 className="size-4" /></Button>
                      <Button size="icon-sm" variant="ghost" aria-label="Remove" title="Remove" onClick={() => setDeleting(s)}><Trash2 className="size-4" /></Button>
                    </div>
                  </CardBody>
                </Card>
              );
            })}
            {(info.forms ?? []).map((f) => (
              <Card key={f.id}>
                <CardBody className="flex items-center gap-4">
                  <ClipboardList className="size-5 text-[var(--text-secondary)]" />
                  <div className="flex-1">
                    <p className="flex items-center gap-2 font-medium">{f.name} <Badge size="sm">Survey form</Badge><Badge size="sm" dot tone={f.status === 'published' ? 'positive' : 'neutral'}>{f.status}</Badge></p>
                    <p className="text-sm text-[var(--text-secondary)]">{f.response_count} response{f.response_count === 1 ? '' : 's'}{f.last_response_at ? ` · last ${relativeTime(f.last_response_at)}` : ''}</p>
                  </div>
                  <Link href={`/surveys?form=${f.id}`}><Button size="sm" variant="ghost">Open form</Button></Link>
                </CardBody>
              </Card>
            ))}
          </div>
        )}
      </section>

      <ConnectModal kind={connecting} meta={meta} onClose={() => setConnecting(null)} onConnected={(source) => { setConnecting(null); load(); if (source.kind === 'webhook') setShowing(source); else sync(source); }} />
      <SettingsModal source={editing} meta={meta} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
      <WebhookModal source={showing} onClose={() => setShowing(null)} onRotated={(s) => { setShowing(s); load(); }} />
      <ConfirmModal
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          try { await api.del(`/leads/sources/${deleting.id}`); toast.success('Source removed'); } catch { toast.error('Could not remove it'); }
          setDeleting(null);
          load();
        }}
        danger
        confirmLabel="Remove"
        title={`Remove ${deleting?.name}?`}
        description="No more leads arrive from it. Leads it already brought in stay."
      />
    </div>
  );
}

/* ── who gets the leads ───────────────────────────────────────────────────── */
function Routing({ meta, value, onChange }) {
  const pool = value.assign_to ?? [];
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1 text-sm font-medium">Share new leads between</p>
        <p className="mb-2 text-xs text-[var(--text-tertiary)]">One after another (round-robin). Choose nobody to leave them unassigned.</p>
        <div className="flex flex-wrap gap-1.5">
          {(meta?.team ?? []).map((m) => (
            <Chip key={m.user_id} active={pool.includes(m.user_id)} onClick={() => onChange({ ...value, assign_to: pool.includes(m.user_id) ? pool.filter((x) => x !== m.user_id) : [...pool, m.user_id] })}>
              {m.name ?? m.email}
            </Chip>
          ))}
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Stage">
          {(p) => (
            <Select {...p} value={value.stage_id ?? ''} onChange={(e) => onChange({ ...value, stage_id: e.target.value || null })}>
              <option value="">First stage</option>
              {(meta?.stages ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Tags" hint="Separate with commas.">
          {(p) => <Input {...p} value={value.tagsText ?? (value.tags ?? []).join(', ')} onChange={(e) => onChange({ ...value, tagsText: e.target.value })} />}
        </Field>
      </div>
    </div>
  );
}
const routingBody = (v) => ({
  assign_to: v.assign_to ?? [], stage_id: v.stage_id ?? null,
  tags: (v.tagsText ?? (v.tags ?? []).join(',')).split(',').map((t) => t.trim()).filter(Boolean),
});

/* ── connect ──────────────────────────────────────────────────────────────── */
function ConnectModal({ kind, meta, onClose, onConnected }) {
  const [form, setForm] = useState({});
  const [page, setPage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  useEffect(() => {
    if (!kind) return;
    setForm({ name: kind === 'webhook' ? 'Website' : '', assign_to: [], form_ids: [] });
    setPage(null);
    setProblem(null);
  }, [kind]);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function inspect() {
    setBusy(true);
    setProblem(null);
    try {
      const found = (await api.post('/leads/sources/meta/inspect', { page_id: form.page_id.trim(), access_token: form.access_token.trim() })).data;
      setPage(found);
      setForm((f) => ({ ...f, name: f.name || found.page.name, form_ids: [] }));
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : 'Could not reach Meta.');
    } finally {
      setBusy(false);
    }
  }

  async function connect() {
    setBusy(true);
    setProblem(null);
    try {
      const body = { kind, name: form.name?.trim() || KINDS[kind].label, ...routingBody(form) };
      if (kind === 'google_sheet') body.sheet_url = form.sheet_url?.trim();
      if (kind === 'meta') Object.assign(body, { page_id: form.page_id.trim(), access_token: form.access_token.trim(), form_ids: form.form_ids });
      const source = (await api.post('/leads/sources', body)).data;
      onConnected(source);
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : 'Could not connect it.');
    } finally {
      setBusy(false);
    }
  }

  if (!kind) return null;
  const ready = kind === 'google_sheet' ? Boolean(form.sheet_url?.trim()) : kind === 'meta' ? Boolean(page) : true;
  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={`Connect ${KINDS[kind].label}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={Plug} loading={busy && (kind !== 'meta' || page)} disabled={!ready} onClick={connect}>Connect</Button></>}
    >
      <div className="space-y-5">
        {problem && <Alert tone="critical">{problem}</Alert>}
        {kind === 'google_sheet' && (
          <>
            <Field label="Sheet link" hint="Share the sheet as “Anyone with the link → Viewer”, open the tab with your leads, and copy the address.">
              {(p) => <Input {...p} icon={Sheet} value={form.sheet_url ?? ''} onChange={set('sheet_url')} placeholder="https://docs.google.com/spreadsheets/d/…" data-autofocus />}
            </Field>
            <Field label="Name">{(p) => <Input {...p} value={form.name ?? ''} onChange={set('name')} placeholder="Website enquiries sheet" />}</Field>
            <p className="text-xs text-[var(--text-tertiary)]">Columns are matched by their headings (Name, Phone, Email, City…). Rows already imported are never imported twice.</p>
          </>
        )}
        {kind === 'meta' && (
          <>
            <Alert tone="info" icon={KeyRound} title="What you need">
              <ol className="mt-1 list-decimal space-y-1 pl-4 text-sm">
                <li>Your Facebook <strong>Page ID</strong> (Meta Business Suite → Settings → Page details).</li>
                <li>A <strong>Page access token</strong> with <code>leads_retrieval</code>, <code>pages_show_list</code>, <code>pages_read_engagement</code>, <code>pages_manage_ads</code>, <code>pages_manage_metadata</code> and <code>ads_management</code>. Create it in Meta’s Graph API Explorer as someone who can advertise on the Page, then make it long-lived in the Access Token Debugger (“Extend”).</li>
                <li>Instagram lead ads run through the same Facebook Page, so they come in too.</li>
              </ol>
            </Alert>
            <div className="grid gap-4 sm:grid-cols-[1fr_2fr]">
              <Field label="Page ID">{(p) => <Input {...p} value={form.page_id ?? ''} onChange={set('page_id')} inputMode="numeric" placeholder="1234567890" />}</Field>
              <Field label="Page access token">{(p) => <Input {...p} type="password" value={form.access_token ?? ''} onChange={set('access_token')} placeholder="EAAG…" autoComplete="off" />}</Field>
            </div>
            <Button variant="secondary" icon={Search} loading={busy && !page} disabled={!form.page_id?.trim() || !form.access_token?.trim()} onClick={inspect}>Check connection</Button>
            {page && (
              <div className="space-y-3 rounded-[var(--radius-lg)] border border-[var(--border-subtle)] p-3">
                <p className="text-sm">Connected to <strong>{page.page.name}</strong>. {page.forms.length ? 'Which lead forms?' : 'This Page has no lead forms yet; new ones will be picked up.'}</p>
                {page.forms.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    <Chip active={!form.form_ids.length} onClick={() => setForm((f) => ({ ...f, form_ids: [] }))}>All forms</Chip>
                    {page.forms.map((f) => (
                      <Chip key={f.id} active={form.form_ids.includes(f.id)} onClick={() => setForm((x) => ({ ...x, form_ids: x.form_ids.includes(f.id) ? x.form_ids.filter((y) => y !== f.id) : [...x.form_ids, f.id] }))}>
                        {f.name}{f.status && f.status !== 'ACTIVE' ? ` (${f.status.toLowerCase()})` : ''}
                      </Chip>
                    ))}
                  </div>
                )}
                <Field label="Name">{(p) => <Input {...p} value={form.name ?? ''} onChange={set('name')} />}</Field>
              </div>
            )}
            <p className="text-xs text-[var(--text-tertiary)]">New leads are checked every 15 minutes (and the last 90 days on the first sync). The token is stored encrypted and never shown again.</p>
          </>
        )}
        {kind === 'webhook' && (
          <>
            <Field label="Name" hint="Where these leads come from — shown on each lead.">{(p) => <Input {...p} value={form.name ?? ''} onChange={set('name')} data-autofocus />}</Field>
            <p className="text-sm text-[var(--text-secondary)]">You get a private link. Anything that can send a web request — your website’s form, Zapier, Make, Pabbly Connect, Google Apps Script, IndiaMART’s Push API — posts leads to it.</p>
          </>
        )}
        <Routing meta={meta} value={form} onChange={setForm} />
      </div>
    </Modal>
  );
}

/* ── settings ─────────────────────────────────────────────────────────────── */
function SettingsModal({ source, meta, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  useEffect(() => {
    if (source) setForm({ name: source.name, assign_to: source.assign_to, stage_id: source.stage_id, tags: source.tags, auto_sync: source.auto_sync });
    setProblem(null);
  }, [source]);
  if (!source) return null;
  async function save() {
    setBusy(true);
    try {
      const body = { name: form.name?.trim(), ...routingBody(form) };
      if (source.kind !== 'webhook') body.auto_sync = form.auto_sync;
      if (source.kind === 'meta' && form.access_token?.trim()) body.access_token = form.access_token.trim();
      if (source.kind === 'google_sheet' && form.sheet_url?.trim()) body.sheet_url = form.sheet_url.trim();
      await api.patch(`/leads/sources/${source.id}`, body);
      toast.success('Saved');
      onSaved();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open onClose={onClose} size="xl" title={`${source.name} settings`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save</Button></>}>
      <div className="space-y-5">
        {problem && <Alert tone="critical">{problem}</Alert>}
        <Field label="Name">{(p) => <Input {...p} value={form.name ?? ''} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />}</Field>
        {source.kind === 'google_sheet' && (
          <Field label="Sheet link" hint={`Now: ${source.config.sheet_url}`}>{(p) => <Input {...p} value={form.sheet_url ?? ''} onChange={(e) => setForm((f) => ({ ...f, sheet_url: e.target.value }))} placeholder="Paste a new link to switch sheets" />}</Field>
        )}
        {source.kind === 'meta' && (
          <Field label="New Page access token" hint="Only when the old one expired or was revoked.">{(p) => <Input {...p} type="password" autoComplete="off" value={form.access_token ?? ''} onChange={(e) => setForm((f) => ({ ...f, access_token: e.target.value }))} />}</Field>
        )}
        {source.kind !== 'webhook' && (
          <Checkbox checked={form.auto_sync ?? true} onChange={(e) => setForm((f) => ({ ...f, auto_sync: e.target.checked }))} label="Check for new leads every 15 minutes" />
        )}
        <Routing meta={meta} value={form} onChange={setForm} />
      </div>
    </Modal>
  );
}

/* ── webhook link and examples ────────────────────────────────────────────── */
function WebhookModal({ source, onClose, onRotated }) {
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  if (!source) return null;
  const url = source.webhook_url;
  const copy = (text, what) => navigator.clipboard.writeText(text).then(() => toast.success(`${what} copied`));
  const curl = `curl -X POST '${url}' \\\n  -H 'content-type: application/json' \\\n  -d '{"name":"Ravi Kumar","phone":"9876543210","email":"ravi@example.com","city":"Pune","message":"Need a quote"}'`;
  const script = `// Google Sheets / Forms: Extensions → Apps Script, paste, then add an
// "On form submit" trigger for sendLead.
function sendLead(e) {
  const answers = {};
  for (const [key, value] of Object.entries(e.namedValues || {})) answers[key] = [].concat(value).join(', ');
  UrlFetchApp.fetch('${url}', {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(answers),
  });
}`;
  return (
    <Modal open onClose={onClose} size="xl" title={`${source.name}: your private link`}
      footer={<><Button variant="ghost" onClick={() => setConfirm(true)}>Replace link</Button><Button variant="primary" onClick={onClose}>Done</Button></>}>
      <div className="space-y-4">
        <div className="flex gap-2">
          <Input readOnly value={url} className="flex-1 font-mono text-xs" onFocus={(e) => e.target.select()} />
          <Button icon={Copy} onClick={() => copy(url, 'Link')}>Copy</Button>
        </div>
        <p className="text-sm text-[var(--text-secondary)]">
          Send a <strong>POST</strong> with the lead as JSON (or as a normal HTML form). Fields named like <code>name</code>, <code>phone</code>/<code>mobile</code>, <code>email</code>, <code>city</code>, <code>company</code>, <code>message</code> are matched automatically, as are your own lead fields by name. Anything else goes into the notes. A list of leads (<code>{'{"leads":[…]}'}</code>) works too, and IndiaMART’s push format is understood.
        </p>
        <Snippet title="Test it from a terminal" text={curl} onCopy={() => copy(curl, 'Command')} />
        <Snippet title="Google Forms or Sheets (Apps Script)" text={script} onCopy={() => copy(script, 'Script')} />
        <Alert tone="caution">Anyone with this link can add leads. Keep it private; if it leaks, replace it.</Alert>
      </div>
      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={async () => {
          setConfirm(false);
          try { onRotated((await api.post(`/leads/sources/${source.id}/rotate`, {})).data); toast.success('New link created — update wherever the old one was used'); } catch { toast.error('Could not replace the link'); }
        }}
        confirmLabel="Replace link"
        title="Replace this link?"
        description="The current link stops working at once. Anything posting to it must be updated."
      />
    </Modal>
  );
}

function Snippet({ title, text, onCopy }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <p className="text-sm font-medium">{title}</p>
        <Button size="xs" variant="ghost" icon={Copy} onClick={onCopy}>Copy</Button>
      </div>
      <pre className="max-h-48 overflow-auto rounded-[var(--radius-md)] bg-[var(--surface-sunken)] p-3 text-xs leading-relaxed">{text}</pre>
    </div>
  );
}
