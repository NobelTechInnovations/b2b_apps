'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Plus, Upload, Users, Phone, MessageCircle, Tag, Trash2, BellRing, Sparkles } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { relativeTime } from '@/lib/format';
import { Can, useWorkspace } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { ConfirmModal } from '@/components/ui/modal';
import { ListToolbar, Pagination } from '@/components/data/list-shell';
import { Table, THead, TBody, TH, TR, TD, TableSkeleton } from '@/components/ui/table';
import { Avatar, Badge, Card, EmptyState, PageHeader, Alert } from '@/components/ui/primitives';
import {
  Chip, OUTCOME_LABEL, OUTCOME_TONE, SOURCE_LABEL, StageBadge, TZ, customValue, dueLabel, telLink, useLeadsMeta, whatsappLink,
} from '@/components/leads/lead-kit';
import { LeadDrawer } from '@/components/leads/lead-drawer';
import { LeadFormModal } from '@/components/leads/lead-form';

/** Quick views: the questions a calling team asks all day. */
const VIEWS = [
  { key: 'open', label: 'Open', query: { stage_kind: 'open' }, count: 'all' },
  { key: 'fresh', label: 'Never called', query: { stage_kind: 'open', fresh: true }, count: 'fresh' },
  { key: 'today', label: 'Follow-up today', query: { followup: 'today' }, count: 'today' },
  { key: 'overdue', label: 'Overdue', query: { followup: 'overdue' }, count: 'overdue', tone: 'critical' },
  { key: 'won', label: 'Won', query: { stage_kind: 'won' } },
  { key: 'lost', label: 'Lost', query: { stage_kind: 'lost' } },
  { key: 'all', label: 'Everything', query: {} },
];

export default function LeadsClient() {
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const { can } = useWorkspace();
  const { meta } = useLeadsMeta();

  const [view, setView] = useState('open');
  const [filters, setFilters] = useState({});
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('recent');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState([]);
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tag, setTag] = useState('');

  // Deep links from notifications and the dashboard.
  useEffect(() => {
    if (params.get('open')) setOpenId(params.get('open'));
    if (params.get('new') === '1') setCreating(true);
    if (params.get('owner')) setFilters((f) => ({ ...f, owner: params.get('owner') }));
    if (params.get('fresh') === '1') setView('fresh');
    if (params.get('view') && VIEWS.some((v) => v.key === params.get('view'))) setView(params.get('view'));
  }, [params]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const preset = VIEWS.find((v) => v.key === view)?.query ?? {};
      const response = await api.get('/leads/leads', { query: { ...preset, ...filters, q: search || undefined, view: sort, page, limit: 50, tz: TZ } });
      setRows(response.data);
      setInfo(response.meta);
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load leads.');
    } finally {
      setLoading(false);
    }
  }, [view, filters, search, sort, page]);

  useEffect(() => {
    const timer = setTimeout(load, search ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, search]);

  const setFilter = (key, value) => {
    setFilters((current) => {
      const next = { ...current };
      if (value === undefined) delete next[key]; else next[key] = value;
      return next;
    });
    setPage(1);
  };

  const listed = useMemo(() => (meta?.fields ?? []).filter((f) => f.show_in_list), [meta]);
  const fieldsByKey = useMemo(() => new Map((meta?.fields ?? []).map((f) => [f.key, f])), [meta]);
  const toolbarFilters = useMemo(() => {
    if (!meta) return [];
    const list = [
      { key: 'stage_id', label: 'Stage', options: meta.stages.map((s) => ({ value: s.id, label: s.name })) },
    ];
    if (meta.sees_all) {
      list.push({
        key: 'owner', label: 'Owner',
        options: [{ value: 'me', label: 'Me' }, { value: 'unassigned', label: 'Unassigned' }, ...meta.team.map((m) => ({ value: m.user_id, label: m.name ?? m.email }))],
      });
    }
    list.push(
      { key: 'source', label: 'Source', options: meta.sources.map((s) => ({ value: s, label: SOURCE_LABEL[s] ?? s })) },
      { key: 'outcome', label: 'Last call', options: Object.entries(OUTCOME_LABEL).map(([value, label]) => ({ value, label })) },
      { key: 'created', label: 'Added', options: [{ value: 'today', label: 'Today' }, { value: 'week', label: 'Last 7 days' }, { value: 'month', label: 'Last 30 days' }] },
    );
    return list;
  }, [meta]);

  async function bulk(action, extra = {}) {
    try {
      const response = await api.post('/leads/leads/bulk', { ids: [...selected], action, ...extra });
      toast.success(`${response.data.changed} lead${response.data.changed === 1 ? '' : 's'} updated`);
      setTag('');
      load();
    } catch (err) {
      toast.error('Could not update those leads', { description: err instanceof ApiError ? err.message : undefined });
    }
  }

  const toggle = (leadId) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(leadId)) next.delete(leadId); else next.add(leadId);
    return next;
  });
  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const counts = info?.counts ?? {};

  return (
    <div className="space-y-5">
      <PageHeader
        title="Leads"
        description={meta?.sees_all ? 'Every lead in the workspace, and who is calling them.' : 'The leads assigned to you.'}
        actions={
          <div className="flex gap-2">
            <Can permission="leads.leads.import">
              <Link href="/leads/import"><Button variant="secondary" icon={Upload}>Import</Button></Link>
            </Can>
            <Can permission="leads.leads.create">
              <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>New lead</Button>
            </Can>
          </div>
        }
      />

      <div className="flex flex-wrap gap-1.5">
        {VIEWS.map((v) => (
          <Chip key={v.key} active={view === v.key} tone={v.tone && counts[v.count] ? v.tone : undefined} onClick={() => { setView(v.key); setPage(1); }}>
            {v.label}
            {v.count && counts[v.count] !== undefined && <span className="ml-1.5 tabular opacity-70">{counts[v.count]}</span>}
          </Chip>
        ))}
      </div>

      <ListToolbar
        search={search}
        onSearch={(value) => { setSearch(value); setPage(1); }}
        searchPlaceholder="Name, phone, company, city…"
        filters={toolbarFilters}
        values={filters}
        onFilter={setFilter}
        onClear={() => { setFilters({}); setPage(1); }}
        actions={
          <Select value={sort} onChange={(e) => setSort(e.target.value)} className="w-auto" aria-label="Sort">
            <option value="recent">Newest first</option>
            <option value="followup">Next follow-up</option>
            <option value="last_call">Last called</option>
            <option value="updated">Recently updated</option>
            <option value="name">Name</option>
            <option value="score">Score</option>
          </Select>
        }
      />

      {selected.size > 0 && (
        <Card className="animate-fade flex flex-wrap items-center gap-2 px-4 py-2.5">
          <span className="text-sm font-medium">{selected.size} selected</span>
          <div className="flex-1" />
          <Can permission="leads.leads.assign">
            <Select className="w-auto" value="" aria-label="Assign to" onChange={(e) => e.target.value && bulk('assign', { owner_user_id: e.target.value === 'none' ? null : e.target.value })}>
              <option value="">Assign to…</option>
              <option value="none">Unassigned</option>
              {(meta?.team ?? []).map((m) => <option key={m.user_id} value={m.user_id}>{m.name ?? m.email}</option>)}
            </Select>
          </Can>
          <Select className="w-auto" value="" aria-label="Move to stage" onChange={(e) => e.target.value && bulk('stage', { stage_id: e.target.value })}>
            <option value="">Move to…</option>
            {(meta?.stages ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
          <div className="flex items-center gap-1">
            <Input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="Tag" className="w-28" icon={Tag} />
            <Button size="sm" variant="secondary" disabled={!tag.trim()} onClick={() => bulk('tag', { tag: tag.trim() })}>Add</Button>
          </div>
          <Can permission="leads.leads.delete">
            <Button size="sm" variant="danger-ghost" icon={Trash2} onClick={() => setConfirmDelete(true)}>Delete</Button>
          </Can>
        </Card>
      )}

      {error && <Alert tone="critical">{error}</Alert>}

      {loading && !rows.length ? (
        <TableSkeleton rows={8} columns={6} />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={view === 'today' || view === 'overdue' ? BellRing : Sparkles}
            title={search || Object.keys(filters).length ? 'No leads match' : view === 'today' ? 'No follow-ups today' : view === 'overdue' ? 'Nothing overdue' : 'No leads here yet'}
            description={search || Object.keys(filters).length ? 'Try a broader search or clear a filter.' : 'Add a lead, import a file, or connect Meta ads, a Google Sheet or a form so they arrive by themselves.'}
            action={!search && can('leads.leads.create') && (
              <div className="flex gap-2">
                <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>Add a lead</Button>
                {can('leads.settings.manage') && <Link href="/leads/sources"><Button variant="secondary">Connect a source</Button></Link>}
              </div>
            )}
          />
        </Card>
      ) : (
        <>
          {/* Phones: one card per lead, with the call and WhatsApp buttons in reach. */}
          <ul className="space-y-2 md:hidden">
            {rows.map((lead) => {
              const due = dueLabel(lead.next_followup_at);
              const wa = whatsappLink(lead.phone, `Hi ${lead.first_name ?? ''},`.trim());
              return (
                <li key={lead.id}>
                  <Card className="px-3.5 py-3" onClick={() => setOpenId(lead.id)}>
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-1.5 font-medium">{lead.name}<StageBadge name={lead.stage_name} color={lead.stage_color} /></p>
                        <p className="truncate text-xs text-[var(--text-tertiary)]">{[lead.phone, lead.city, lead.company_name].filter(Boolean).join(' · ') || '—'}</p>
                        <p className="mt-1 text-xs">
                          {lead.next_followup_at
                            ? <span className={cn(due.overdue ? 'font-medium text-[var(--color-critical-600)]' : 'text-[var(--text-secondary)]')}>Next: {due.text}</span>
                            : <span className="text-[var(--text-tertiary)]">No follow-up booked</span>}
                          {lead.last_call_outcome && <span className="text-[var(--text-tertiary)]"> · {OUTCOME_LABEL[lead.last_call_outcome]}</span>}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-1.5" onClick={(e) => e.stopPropagation()}>
                        {lead.phone && <a href={telLink(lead.phone)} aria-label={`Call ${lead.name}`}><Button size="icon" variant="primary"><Phone className="size-4" /></Button></a>}
                        {wa && <a href={wa} target="_blank" rel="noreferrer" aria-label={`WhatsApp ${lead.name}`}><Button size="icon" variant="secondary"><MessageCircle className="size-4" /></Button></a>}
                      </div>
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>
          <div className="hidden md:block">
          <Table>
            <THead>
              <tr>
                <TH width={36}>
                  <input type="checkbox" aria-label="Select all" checked={allChecked} onChange={() => setSelected(allChecked ? new Set() : new Set(rows.map((r) => r.id)))} className="size-4" />
                </TH>
                <TH>Lead</TH>
                <TH>Phone</TH>
                <TH>Stage</TH>
                <TH>Next follow-up</TH>
                <TH>Last call</TH>
                {meta?.sees_all && <TH>Owner</TH>}
                {listed.map((f) => <TH key={f.id}>{f.label}</TH>)}
                <TH>Source</TH>
                <TH>Added</TH>
              </tr>
            </THead>
            <TBody>
              {rows.map((lead) => {
                const due = dueLabel(lead.next_followup_at);
                const wa = whatsappLink(lead.phone, `Hi ${lead.first_name ?? ''},`.trim());
                return (
                  <TR key={lead.id} onClick={() => setOpenId(lead.id)} selected={selected.has(lead.id)}>
                    <TD>
                      <input type="checkbox" aria-label={`Select ${lead.name}`} checked={selected.has(lead.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggle(lead.id)} className="size-4" />
                    </TD>
                    <TD>
                      <div className="flex items-center gap-2.5">
                        <Avatar name={lead.name} size="md" />
                        <div className="min-w-0">
                          <p className="flex items-center gap-1.5 truncate font-medium">
                            {lead.name}
                            {lead.rating === 'hot' && <Badge size="sm" tone="critical">hot</Badge>}
                          </p>
                          <p className="truncate text-xs text-[var(--text-tertiary)]">{[lead.company_name, lead.city].filter(Boolean).join(' · ') || lead.email || '—'}</p>
                        </div>
                      </div>
                    </TD>
                    <TD>
                      {lead.phone ? (
                        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                          <span className="tabular text-sm">{lead.phone}</span>
                          <a href={telLink(lead.phone)} aria-label={`Call ${lead.name}`} title="Call" className="rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-brand)]"><Phone className="size-3.5" /></a>
                          {wa && <a href={wa} target="_blank" rel="noreferrer" aria-label={`WhatsApp ${lead.name}`} title="WhatsApp" className="rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--color-positive-600)]"><MessageCircle className="size-3.5" /></a>}
                        </div>
                      ) : <span className="text-[var(--text-disabled)]">—</span>}
                    </TD>
                    <TD><StageBadge name={lead.stage_name} color={lead.stage_color} /></TD>
                    <TD>
                      {lead.next_followup_at ? (
                        <span className={cn('text-sm', due.overdue ? 'font-medium text-[var(--color-critical-600)]' : due.today ? 'font-medium text-[var(--color-caution-700)]' : 'text-[var(--text-secondary)]')}>
                          {due.text}
                        </span>
                      ) : <span className="text-[var(--text-disabled)]">—</span>}
                    </TD>
                    <TD>
                      {lead.last_call_outcome ? (
                        <div>
                          <Badge size="sm" tone={OUTCOME_TONE[lead.last_call_outcome]}>{OUTCOME_LABEL[lead.last_call_outcome]}</Badge>
                          <p className="mt-0.5 text-2xs text-[var(--text-tertiary)]">{relativeTime(lead.last_call_at)}{lead.call_count > 1 ? ` · ${lead.call_count} calls` : ''}</p>
                        </div>
                      ) : <span className="text-xs text-[var(--text-tertiary)]">Not called</span>}
                    </TD>
                    {meta?.sees_all && (
                      <TD className="text-sm text-[var(--text-secondary)]">
                        {lead.owner ? <span className="flex items-center gap-1.5"><Avatar name={lead.owner.name ?? '?'} size="xs" />{lead.owner.name}</span> : <span className="text-[var(--color-caution-700)]">Unassigned</span>}
                      </TD>
                    )}
                    {listed.map((f) => <TD key={f.id} className="text-sm text-[var(--text-secondary)]">{customValue(fieldsByKey.get(f.key), lead.custom?.[f.key]) ?? '—'}</TD>)}
                    <TD className="text-xs text-[var(--text-secondary)]" title={lead.source_detail ?? undefined}>{SOURCE_LABEL[lead.source] ?? lead.source}</TD>
                    <TD className="text-sm text-[var(--text-secondary)]">{relativeTime(lead.created_at)}</TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
          </div>
          <Pagination meta={info} onPage={setPage} />
        </>
      )}

      {!meta?.sees_all && meta && (
        <p className="flex items-center gap-1.5 text-xs text-[var(--text-tertiary)]"><Users className="size-3.5" /> You see the leads assigned to you. An owner or admin can hand you more.</p>
      )}

      {openId && (
        <LeadDrawer
          leadId={openId}
          meta={meta}
          onClose={() => { setOpenId(null); if (params.get('open')) router.replace('/leads'); }}
          onChanged={load}
        />
      )}
      <LeadFormModal
        open={creating}
        meta={meta}
        onClose={() => { setCreating(false); if (params.get('new')) router.replace('/leads'); }}
        onSaved={(lead) => { load(); setOpenId(lead.id); }}
        onOpenExisting={(leadId) => setOpenId(leadId)}
      />
      <ConfirmModal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={async () => { setConfirmDelete(false); await bulk('delete'); }}
        danger
        confirmLabel="Delete"
        title={`Delete ${selected.size} lead${selected.size === 1 ? '' : 's'}?`}
        description="They disappear from every list and their follow-ups are cancelled."
      />
    </div>
  );
}
