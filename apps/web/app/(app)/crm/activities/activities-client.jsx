'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Plus, Phone, Users, Mail, CheckSquare, StickyNote, Check, CalendarClock, AlertTriangle,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { relativeTime, date } from '@/lib/format';
import { Can } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { ListToolbar, Pagination } from '@/components/data/list-shell';
import { StatTile } from '@/components/data/stat-tile';
import { Card, EmptyState, PageHeader, Badge, Alert, Skeleton } from '@/components/ui/primitives';

const KIND_META = {
  call:    { icon: Phone,       label: 'Call',    tint: 'bg-[#eef2ff] text-[#4f46e5] dark:bg-[rgb(99_102_241/0.14)] dark:text-[#a5b4fc]' },
  meeting: { icon: Users,       label: 'Meeting', tint: 'bg-[#f5f3ff] text-[#7c3aed] dark:bg-[rgb(139_92_246/0.14)] dark:text-[#c4b5fd]' },
  email:   { icon: Mail,        label: 'Email',   tint: 'bg-[#f0f9ff] text-[#0284c7] dark:bg-[rgb(14_165_233/0.14)] dark:text-[#7dd3fc]' },
  task:    { icon: CheckSquare, label: 'Task',    tint: 'bg-[#ecfdf5] text-[#059669] dark:bg-[rgb(16_185_129/0.14)] dark:text-[#6ee7b7]' },
  note:    { icon: StickyNote,  label: 'Note',    tint: 'bg-[var(--surface-sunken)] text-[var(--text-secondary)]' },
};

const FILTERS = [
  {
    key: 'kind',
    label: 'Type',
    options: Object.entries(KIND_META).map(([value, meta]) => ({ value, label: meta.label })),
  },
];

export default function ActivitiesClient() {
  const toast = useToast();
  const [activities, setActivities] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({});
  const [scope, setScope] = useState('open');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.get('/crm/activities', {
        query: {
          ...filters,
          q: search || undefined,
          open: scope === 'open' ? true : undefined,
          overdue: scope === 'overdue' ? true : undefined,
          page,
          limit: 25,
          sort: 'due_at',
          order: 'asc',
        },
      });
      setActivities(response.data);
      setMeta(response.meta);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load activities.');
    } finally {
      setLoading(false);
    }
  }, [filters, search, scope, page]);

  useEffect(() => {
    const timer = setTimeout(load, search ? 280 : 0);
    return () => clearTimeout(timer);
  }, [load, search]);

  async function complete(activity) {
    // Optimistic: ticking something off should feel instant.
    setActivities((current) => current.filter((a) => a.id !== activity.id));
    try {
      await api.post(`/crm/activities/${activity.id}/complete`, {});
      toast.success('Marked done');
      load();
    } catch {
      toast.error('Could not mark that done');
      load();
    }
  }

  const counts = meta?.counts;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Activities"
        description="Calls, meetings, tasks and notes across every record."
        actions={
          <Can permission="crm.activities.create">
            <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>Log activity</Button>
          </Can>
        }
      />

      {counts && (
        <div className="grid grid-cols-3 gap-4">
          <StatTile label="Open" value={counts.open} icon={CalendarClock} />
          <StatTile label="Due today" value={counts.due_today} tone="brand" />
          <StatTile
            label="Overdue" value={counts.overdue}
            tone={counts.overdue > 0 ? 'critical' : 'neutral'} icon={AlertTriangle}
          />
        </div>
      )}

      <ListToolbar
        search={search}
        onSearch={(v) => { setSearch(v); setPage(1); }}
        searchPlaceholder="Search subject or notes…"
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
      >
        <div className="inline-flex rounded-[var(--radius-md)] bg-[var(--surface-sunken)] p-0.5">
          {[
            { value: 'open', label: 'Open' },
            { value: 'overdue', label: 'Overdue' },
            { value: 'all', label: 'All' },
          ].map((option) => (
            <button
              key={option.value}
              onClick={() => { setScope(option.value); setPage(1); }}
              className={cn(
                'rounded-[var(--radius-sm)] px-2.5 py-1 text-sm font-medium transition-colors',
                scope === option.value
                  ? 'bg-[var(--surface-raised)] text-[var(--text-primary)] shadow-xs'
                  : 'text-[var(--text-secondary)]',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </ListToolbar>

      {error && <Alert tone="critical">{error}</Alert>}

      {loading ? (
        <div className="space-y-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : activities.length === 0 ? (
        <Card>
          <EmptyState
            icon={CheckSquare}
            title={scope === 'open' ? 'Nothing open' : 'No activities found'}
            description={
              scope === 'open'
                ? 'You are all caught up. Log a call or schedule a follow-up to keep things moving.'
                : 'Try a different filter.'
            }
          />
        </Card>
      ) : (
        <>
          <div className="space-y-2">
            {activities.map((activity) => {
              const kind = KIND_META[activity.kind] ?? KIND_META.note;
              const overdue = !activity.completed_at && activity.due_at && new Date(activity.due_at) < new Date();

              return (
                <div key={activity.id} className="panel panel-hover flex items-start gap-3 p-3.5">
                  <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-md)]', kind.tint)}>
                    <kind.icon className="size-4" strokeWidth={1.75} />
                  </span>

                  <div className="min-w-0 flex-1">
                    <p className={cn('text-base font-medium', activity.completed_at && 'text-[var(--text-tertiary)] line-through')}>
                      {activity.subject}
                    </p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--text-tertiary)]">
                      <span>{kind.label}</span>
                      {activity.related_type && (
                        <>
                          <span>·</span>
                          <span className="capitalize">{activity.related_type}</span>
                        </>
                      )}
                      {activity.due_at && (
                        <>
                          <span>·</span>
                          <span className={overdue ? 'font-medium text-[var(--color-critical-600)]' : undefined}>
                            {overdue ? 'Overdue ' : 'Due '}{relativeTime(activity.due_at)}
                          </span>
                        </>
                      )}
                      {activity.completed_at && (
                        <>
                          <span>·</span>
                          <span className="text-[var(--color-positive-600)]">
                            Done {relativeTime(activity.completed_at)}
                          </span>
                        </>
                      )}
                    </div>
                    {activity.body && (
                      <p className="mt-1.5 line-clamp-2 text-sm text-[var(--text-secondary)]">{activity.body}</p>
                    )}
                  </div>

                  {!activity.completed_at && (
                    <Can permission="crm.activities.create">
                      <Button variant="ghost" size="sm" icon={Check} onClick={() => complete(activity)}>
                        Done
                      </Button>
                    </Can>
                  )}
                </div>
              );
            })}
          </div>
          <Pagination meta={meta} onPage={setPage} />
        </>
      )}

      <LogActivityModal open={creating} onClose={() => setCreating(false)} onCreated={load} />
    </div>
  );
}

function LogActivityModal({ open, onClose, onCreated }) {
  const toast = useToast();
  const [form, setForm] = useState({ kind: 'call' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = { ...form };
      if (payload.due_at) payload.due_at = new Date(payload.due_at).toISOString();
      for (const key of Object.keys(payload)) if (payload[key] === '') delete payload[key];

      await api.post('/crm/activities', payload);
      toast.success('Activity logged');
      setForm({ kind: 'call' });
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not log that activity.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Log an activity"
      description="Record something that happened, or schedule something to do."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy} icon={Plus}>Save</Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert tone="critical">{error}</Alert>}

        <Field label="Type">
          {(p) => (
            <Select {...p} value={form.kind} onChange={set('kind')}>
              {Object.entries(KIND_META).map(([value, m]) => (
                <option key={value} value={value}>{m.label}</option>
              ))}
            </Select>
          )}
        </Field>

        <Field label="Subject" required>
          {(p) => (
            <Input {...p} value={form.subject ?? ''} onChange={set('subject')} required data-autofocus
              placeholder="Follow up on pricing" />
          )}
        </Field>

        <Field label="Due" hint="Leave blank to log something that already happened.">
          {(p) => <Input {...p} type="datetime-local" value={form.due_at ?? ''} onChange={set('due_at')} />}
        </Field>

        <Field label="Notes">
          {(p) => <Textarea {...p} rows={3} value={form.body ?? ''} onChange={set('body')} />}
        </Field>
      </form>
    </Modal>
  );
}
