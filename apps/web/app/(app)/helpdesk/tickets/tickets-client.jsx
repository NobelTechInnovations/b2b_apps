'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Plus, Inbox, Mail, Phone, MessageSquareText, StickyNote, Send, Trash2, AlarmClock, History } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { date, relativeTime } from '@/lib/format';
import { Can, useWorkspace } from '@/lib/workspace';
import { usePeople, dueIn, titleCase } from '@/lib/people';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { Modal, ConfirmModal } from '@/components/ui/modal';
import { Drawer, DetailGrid } from '@/components/data/drawer';
import { ListToolbar, Pagination } from '@/components/data/list-shell';
import { SourceTaskButton } from '@/components/tasks/source-task-button';
import { Table, THead, TBody, TH, TR, TD, TableSkeleton } from '@/components/ui/table';
import { Avatar, Badge, Card, EmptyState, PageHeader, Alert } from '@/components/ui/primitives';

const STATUSES = ['open', 'pending', 'on_hold', 'resolved', 'closed'];
const PRIORITIES = ['urgent', 'high', 'normal', 'low'];
const CHANNELS = ['email', 'phone', 'whatsapp', 'web', 'walk_in', 'social', 'other'];

const STATUS_TONE = { open: 'info', pending: 'caution', on_hold: 'neutral', resolved: 'positive', closed: 'neutral' };
const PRIORITY_TONE = { urgent: 'critical', high: 'caution', normal: 'brand', low: 'neutral' };
const SLA_TONE = { breached: 'critical', at_risk: 'caution', ok: 'neutral', met: 'positive', none: 'neutral' };

const VIEWS = [
  { key: 'active', label: 'Active', query: { status: 'active' } },
  { key: 'mine', label: 'Mine', query: { status: 'active', assignee: 'me' } },
  { key: 'unassigned', label: 'Unassigned', query: { status: 'active', assignee: 'unassigned' } },
  { key: 'breached', label: 'SLA breached', query: { sla: 'breached' } },
  { key: 'all', label: 'All', query: {} },
];

const FILTERS = [
  { key: 'priority', label: 'Priority', options: PRIORITIES.map((v) => ({ value: v, label: titleCase(v) })) },
  { key: 'channel', label: 'Channel', options: CHANNELS.map((v) => ({ value: v, label: titleCase(v) })) },
];

export default function TicketsClient() {
  const router = useRouter();
  const params = useSearchParams();
  const { can } = useWorkspace();
  const { people, nameOf } = usePeople('/helpdesk/agents');

  const [view, setView] = useState('active');
  const [filters, setFilters] = useState({});
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [tickets, setTickets] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState(null);

  // Deep links from notifications and the overview: ?ticket=, ?new=1, ?assignee=me, ?priority=.
  useEffect(() => {
    if (params.get('new') === '1') setCreating(true);
    if (params.get('ticket')) setOpenId(params.get('ticket'));
    if (params.get('assignee') === 'me') setView('mine');
    if (params.get('priority')) setFilters({ priority: params.get('priority') });
  }, [params]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const preset = VIEWS.find((v) => v.key === view)?.query ?? {};
      const response = await api.get('/helpdesk/tickets', {
        query: { ...preset, ...filters, q: search || undefined, page, limit: 25 },
      });
      setTickets(response.data);
      setMeta(response.meta);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load tickets.');
    } finally {
      setLoading(false);
    }
  }, [view, filters, search, page]);

  useEffect(() => {
    const timer = setTimeout(load, search ? 280 : 0);
    return () => clearTimeout(timer);
  }, [load, search]);

  const close = () => { setOpenId(null); if (params.get('ticket')) router.replace('/helpdesk/tickets'); };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Tickets"
        description="Sorted by what is due first. Breached tickets float to the top."
        actions={
          <Can permission="helpdesk.tickets.create">
            <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>New ticket</Button>
          </Can>
        }
      />

      <div className="flex flex-wrap gap-1 rounded-[var(--radius-lg)] bg-[var(--surface-sunken)] p-1 text-sm">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            onClick={() => { setView(v.key); setPage(1); }}
            className={cn(
              'rounded-[var(--radius-md)] px-3 py-1.5 font-medium transition-colors',
              view === v.key ? 'bg-[var(--surface-raised)] text-[var(--text-primary)] shadow-xs' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
            )}
          >
            {v.label}
          </button>
        ))}
      </div>

      <ListToolbar
        search={search}
        onSearch={(value) => { setSearch(value); setPage(1); }}
        searchPlaceholder="Subject, requester, phone or #number…"
        filters={FILTERS}
        values={filters}
        onFilter={(key, value) => { setFilters((f) => { const n = { ...f }; if (value === undefined) delete n[key]; else n[key] = value; return n; }); setPage(1); }}
        onClear={() => { setFilters({}); setPage(1); }}
      />

      {error && <Alert tone="critical">{error}</Alert>}

      {loading && tickets.length === 0 ? (
        <TableSkeleton rows={6} columns={6} />
      ) : tickets.length === 0 ? (
        <Card>
          <EmptyState
            icon={Inbox}
            title={view === 'active' && !search ? 'Inbox zero' : 'No tickets here'}
            description={view === 'active' && !search ? 'Nothing is waiting on your team right now.' : 'Try another view or clear the filters.'}
            action={can('helpdesk.tickets.create') && <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>Log a ticket</Button>}
          />
        </Card>
      ) : (
        <>
          <Table>
            <THead>
              <tr>
                <TH width="4.5rem">#</TH>
                <TH>Subject</TH>
                <TH>Priority</TH>
                <TH>Status</TH>
                <TH>Owner</TH>
                <TH>Due</TH>
                <TH>Updated</TH>
              </tr>
            </THead>
            <TBody>
              {tickets.map((t) => (
                <TR key={t.id} onClick={() => setOpenId(t.id)}>
                  <TD numeric className="text-[var(--text-tertiary)]">#{t.number}</TD>
                  <TD>
                    <p className="max-w-md truncate font-medium">{t.subject}</p>
                    <p className="truncate text-xs text-[var(--text-tertiary)]">
                      {t.requester_name ?? t.requester_email ?? t.requester_phone ?? 'No requester'} · {titleCase(t.channel)}
                    </p>
                  </TD>
                  <TD><Badge size="sm" tone={PRIORITY_TONE[t.priority]}>{titleCase(t.priority)}</Badge></TD>
                  <TD><Badge size="sm" tone={STATUS_TONE[t.status]}>{titleCase(t.status)}</Badge></TD>
                  <TD>
                    {t.assignee_id ? (
                      <span className="flex items-center gap-2"><Avatar name={nameOf(t.assignee_id)} size="xs" />{nameOf(t.assignee_id)}</span>
                    ) : <span className="text-[var(--text-disabled)]">Unassigned</span>}
                  </TD>
                  <TD><SlaBadge ticket={t} /></TD>
                  <TD className="text-[var(--text-secondary)]">{relativeTime(t.updated_at)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination meta={meta} onPage={setPage} />
        </>
      )}

      <CreateTicketModal
        open={creating}
        people={people}
        onClose={() => { setCreating(false); if (params.get('new')) router.replace('/helpdesk/tickets'); }}
        onCreated={(t) => { load(); setOpenId(t.id); }}
      />

      {openId && <TicketDrawer ticketId={openId} people={people} nameOf={nameOf} onClose={close} onChanged={load} />}
    </div>
  );
}

function SlaBadge({ ticket }) {
  const state = ticket.sla_state;
  if (state === 'met') return <Badge size="sm" tone="positive">Met</Badge>;
  if (state === 'none' || ['resolved', 'closed'].includes(ticket.status)) return <span className="text-[var(--text-disabled)]">—</span>;
  const due = !ticket.first_response_at && ticket.first_response_due && new Date(ticket.first_response_due) < new Date(ticket.resolution_due)
    ? { at: ticket.first_response_due, what: 'reply' } : { at: ticket.resolution_due, what: 'resolve' };
  return (
    <Badge size="sm" tone={SLA_TONE[state]} dot={state !== 'ok'}>
      {due.what === 'reply' ? 'Reply' : 'Resolve'} {dueIn(due.at)}
    </Badge>
  );
}

/* ── detail ───────────────────────────────────────────────────────────────── */

function TicketDrawer({ ticketId, people, nameOf, onClose, onChanged }) {
  const toast = useToast();
  const { can, user } = useWorkspace();
  const [ticket, setTicket] = useState(null);
  const [error, setError] = useState(null);
  const [kind, setKind] = useState('reply');
  const [body, setBody] = useState('');
  const [nextStatus, setNextStatus] = useState('');
  const [sending, setSending] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await api.get(`/helpdesk/tickets/${ticketId}`);
      setTicket(response.data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open that ticket.');
    }
  }, [ticketId]);

  useEffect(() => { setTicket(null); setError(null); load(); }, [load]);

  async function update(patch, done) {
    try {
      await api.patch(`/helpdesk/tickets/${ticketId}`, patch);
      if (done) toast.success(done);
      await load();
      onChanged();
    } catch (err) {
      toast.error('Could not update the ticket', { description: err instanceof ApiError ? err.message : undefined });
    }
  }

  async function send(event) {
    event?.preventDefault();
    if (!body.trim()) return;
    setSending(true);
    try {
      await api.post(`/helpdesk/tickets/${ticketId}/messages`, { kind, body, status: nextStatus || undefined });
      setBody('');
      setNextStatus('');
      await load();
      onChanged();
    } catch (err) {
      toast.error(kind === 'reply' ? 'Reply not sent' : 'Note not saved', { description: err instanceof ApiError ? err.message : undefined });
    } finally {
      setSending(false);
    }
  }

  async function remove() {
    try {
      await api.del(`/helpdesk/tickets/${ticketId}`);
      toast.success('Ticket deleted');
      onChanged();
      onClose();
    } catch (err) {
      toast.error('Could not delete', { description: err instanceof ApiError ? err.message : undefined });
    }
  }

  const editable = can('helpdesk.tickets.edit');
  const t = ticket;

  return (
    <Drawer
      open
      onClose={onClose}
      width="lg"
      title={t ? t.subject : 'Loading…'}
      subtitle={t ? `#${t.number} · opened ${relativeTime(t.created_at)} via ${titleCase(t.channel)}` : undefined}
      badge={t && <Badge size="sm" tone={STATUS_TONE[t.status]}>{titleCase(t.status)}</Badge>}
      footer={t && can('helpdesk.tickets.delete') && (
        <Button variant="danger-ghost" icon={Trash2} onClick={() => setDeleting(true)}>Delete ticket</Button>
      )}
    >
      {error && <Alert tone="critical">{error}</Alert>}
      {t && (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Status">
              {(p) => (
                <Select {...p} value={t.status} disabled={!editable} onChange={(e) => update({ status: e.target.value })}>
                  {STATUSES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Priority" hint="Changing it resets the SLA clock">
              {(p) => (
                <Select {...p} value={t.priority} disabled={!editable} onChange={(e) => update({ priority: e.target.value })}>
                  {PRIORITIES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Owner">
              {(p) => (
                <Select
                  {...p}
                  value={t.assignee_id ?? ''}
                  disabled={!can('helpdesk.tickets.assign')}
                  onChange={(e) => update({ assignee_id: e.target.value || null }, e.target.value ? `Assigned to ${nameOf(e.target.value)}` : 'Unassigned')}
                >
                  <option value="">Unassigned</option>
                  {people.map((person) => <option key={person.user_id} value={person.user_id}>{person.name}{person.user_id === user?.id ? ' (you)' : ''}</option>)}
                </Select>
              )}
            </Field>
          </div>
          {!can('helpdesk.tickets.assign') && editable && !t.assignee_id && (
            <Button size="sm" variant="secondary" onClick={() => update({ assignee_id: user.id }, 'You own this ticket')}>Take it</Button>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <SlaBadge ticket={t} />
            {t.first_response_at
              ? <span className="text-xs text-[var(--text-tertiary)]">First reply {relativeTime(t.first_response_at)}</span>
              : t.first_response_due && <span className="text-xs text-[var(--text-tertiary)]">Reply due {date(t.first_response_due, 'datetime')}</span>}
            {t.resolution_due && <span className="text-xs text-[var(--text-tertiary)]">· Resolve by {date(t.resolution_due, 'datetime')}</span>}
            <div className="flex-1" />
            <SourceTaskButton app="helpdesk" type="ticket" recordId={t.id} title={`Ticket #${t.number}: ${t.subject}`} />
          </div>

          <DetailGrid
            items={[
              { label: 'Requester', value: t.requester_name },
              { label: 'Email', value: t.requester_email && <a className="text-[var(--color-brand-600)]" href={`mailto:${t.requester_email}`}>{t.requester_email}</a> },
              { label: 'Phone', value: t.requester_phone && <a className="text-[var(--color-brand-600)]" href={`tel:${t.requester_phone}`}>{t.requester_phone}</a> },
              { label: 'Category', value: t.category },
              { label: 'Description', value: t.description || null, full: true },
            ]}
          />

          <section>
            <h3 className="mb-3 text-sm font-medium text-[var(--text-secondary)]">Conversation</h3>
            <ol className="space-y-3">
              {t.messages.length === 0 && (
                <li className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border-default)] px-3 py-5 text-center text-sm text-[var(--text-tertiary)]">
                  No replies yet. The first one stops the response clock.
                </li>
              )}
              {t.messages.map((m) => m.kind === 'event' ? (
                <li key={m.id} className="flex items-center gap-2 pl-1 text-xs text-[var(--text-tertiary)]">
                  <History className="size-3" /> {m.body} · {nameOf(m.author_id) ?? 'System'} · {relativeTime(m.created_at)}
                </li>
              ) : (
                <li
                  key={m.id}
                  className={cn(
                    'rounded-[var(--radius-lg)] border px-3.5 py-3',
                    m.kind === 'note'
                      ? 'border-[rgb(245_158_11/0.3)] bg-[var(--color-caution-50)] dark:bg-[rgb(245_158_11/0.08)]'
                      : 'border-[var(--border-subtle)] bg-[var(--surface-raised)]',
                  )}
                >
                  <div className="mb-1.5 flex items-center gap-2 text-xs text-[var(--text-tertiary)]">
                    <Avatar name={nameOf(m.author_id)} size="xs" />
                    <span className="font-medium text-[var(--text-secondary)]">{nameOf(m.author_id)}</span>
                    {m.kind === 'note' ? <Badge size="sm" tone="caution">Internal note</Badge> : <span>replied</span>}
                    <span className="ml-auto">{relativeTime(m.created_at)}</span>
                  </div>
                  <p className="whitespace-pre-wrap text-base">{m.body}</p>
                </li>
              ))}
            </ol>
          </section>

          {editable && t.status !== 'closed' && (
            <form onSubmit={send} className="space-y-2 rounded-[var(--radius-lg)] border border-[var(--border-default)] p-3">
              <div className="flex gap-1 text-sm">
                {[['reply', 'Reply', MessageSquareText], ['note', 'Internal note', StickyNote]].map(([key, label, Icon]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setKind(key)}
                    className={cn('flex items-center gap-1.5 rounded-[var(--radius-md)] px-2.5 py-1 font-medium',
                      kind === key ? 'bg-[var(--surface-sunken)] text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]')}
                  >
                    <Icon className="size-3.5" /> {label}
                  </button>
                ))}
              </div>
              <Textarea
                rows={4}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder={kind === 'reply' ? 'Write what you told the customer…' : 'Only your team sees notes.'}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(e); }}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Select value={nextStatus} onChange={(e) => setNextStatus(e.target.value)} className="w-auto" aria-label="Then set status">
                  <option value="">Keep status</option>
                  {STATUSES.filter((s) => s !== t.status).map((s) => <option key={s} value={s}>Then: {titleCase(s)}</option>)}
                </Select>
                <div className="flex-1" />
                <Button type="submit" variant="primary" icon={Send} loading={sending} disabled={!body.trim()}>
                  {kind === 'reply' ? 'Log reply' : 'Add note'}
                </Button>
              </div>
            </form>
          )}
          {t.status === 'closed' && editable && (
            <Alert tone="info" action={<Button size="sm" onClick={() => update({ status: 'open' }, 'Ticket reopened')}>Reopen</Button>}>
              This ticket is closed.
            </Alert>
          )}

          {t.requester_history.length > 0 && (
            <section>
              <h3 className="mb-2 text-sm font-medium text-[var(--text-secondary)]">Earlier tickets from this requester</h3>
              <ul className="divide-y divide-[var(--border-subtle)] rounded-[var(--radius-lg)] border border-[var(--border-subtle)]">
                {t.requester_history.map((h) => (
                  <li key={h.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <span className="tabular text-[var(--text-tertiary)]">#{h.number}</span>
                    <span className="min-w-0 flex-1 truncate">{h.subject}</span>
                    <Badge size="sm" tone={STATUS_TONE[h.status]}>{titleCase(h.status)}</Badge>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}

      <ConfirmModal
        open={deleting}
        onClose={() => setDeleting(false)}
        onConfirm={remove}
        danger
        title="Delete this ticket?"
        description="The ticket and its whole conversation are removed. Closing it keeps the history instead."
        confirmLabel="Delete"
      />
    </Drawer>
  );
}

/* ── create ───────────────────────────────────────────────────────────────── */

const BLANK = { priority: 'normal', channel: 'phone' };

function CreateTicketModal({ open, people, onClose, onCreated }) {
  const toast = useToast();
  const { can } = useWorkspace();
  const [form, setForm] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(event) {
    event?.preventDefault();
    setBusy(true);
    setErrors({});
    setFormError(null);
    try {
      const payload = Object.fromEntries(Object.entries(form).filter(([, v]) => v !== '' && v !== undefined));
      const response = await api.post('/helpdesk/tickets', payload);
      toast.success(`Ticket #${response.data.number} created`);
      setForm(BLANK);
      onClose();
      onCreated(response.data);
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fieldErrors).length) setErrors(err.fieldErrors);
      else setFormError(err instanceof ApiError ? err.message : 'Could not create the ticket.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New ticket"
      description="Log a call, a WhatsApp message or a walk-in so it gets an owner and a deadline."
      size="xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" icon={Plus} loading={busy} onClick={submit}>Create ticket</Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {formError && <Alert tone="critical">{formError}</Alert>}
        <Field label="Subject" required error={errors.subject}>
          {(p) => <Input {...p} value={form.subject ?? ''} onChange={set('subject')} placeholder="What do they need?" data-autofocus />}
        </Field>
        <Field label="Details">
          {(p) => <Textarea {...p} rows={3} value={form.description ?? ''} onChange={set('description')} />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Requester name">
            {(p) => <Input {...p} value={form.requester_name ?? ''} onChange={set('requester_name')} />}
          </Field>
          <Field label="Email" error={errors.requester_email}>
            {(p) => <Input {...p} type="email" icon={Mail} value={form.requester_email ?? ''} onChange={set('requester_email')} />}
          </Field>
          <Field label="Phone">
            {(p) => <Input {...p} icon={Phone} value={form.requester_phone ?? ''} onChange={set('requester_phone')} />}
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-4">
          <Field label="Priority">
            {(p) => <Select {...p} value={form.priority} onChange={set('priority')}>{PRIORITIES.map((v) => <option key={v} value={v}>{titleCase(v)}</option>)}</Select>}
          </Field>
          <Field label="Channel">
            {(p) => <Select {...p} value={form.channel} onChange={set('channel')}>{CHANNELS.map((v) => <option key={v} value={v}>{titleCase(v)}</option>)}</Select>}
          </Field>
          <Field label="Category">
            {(p) => <Input {...p} value={form.category ?? ''} onChange={set('category')} placeholder="e.g. Visa" />}
          </Field>
          <Field label="Owner" error={errors.assignee_id}>
            {(p) => (
              <Select {...p} value={form.assignee_id ?? ''} onChange={set('assignee_id')} disabled={!can('helpdesk.tickets.assign')}>
                <option value="">Unassigned</option>
                {people.map((person) => <option key={person.user_id} value={person.user_id}>{person.name}</option>)}
              </Select>
            )}
          </Field>
        </div>
        <p className="flex items-center gap-1.5 text-xs text-[var(--text-tertiary)]">
          <AlarmClock className="size-3.5" /> Response and resolution deadlines are set from the priority’s SLA.
        </p>
      </form>
    </Modal>
  );
}
