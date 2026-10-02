'use client';

import { useEffect, useMemo, useState } from 'react';
import { Phone, MessageCircle, Inbox } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { tintFor } from '@/lib/app-theme';
import { useWorkspace } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Alert, Avatar, Badge, Skeleton } from '@/components/ui/primitives';
import { OUTCOME_LABEL, OUTCOME_TONE, StageBadge, dueLabel, formName, telLink, whatsappLink } from './lead-kit';

/** What the board's columns are. Form / source keeps each form's leads together. */
export const BOARD_BY = [['form', 'Form / source'], ['stage', 'Stage'], ['owner', 'Owner'], ['followup', 'Follow-up']];

const PAGE = 20;

/**
 * Leads as columns: one per form or source (or stage, person, follow-up).
 * Each column loads its own leads and more on request. Cards move between
 * stage columns (a new stage) and owner columns (assign or hand over).
 */
export function LeadBoard({ by, meta, baseQuery, version, onOpen, onMoved }) {
  const toast = useToast();
  const { can, user } = useWorkspace();
  const [groups, setGroups] = useState(null);
  const [error, setError] = useState(null);
  const [dragging, setDragging] = useState(null);
  const [target, setTarget] = useState(null);

  useEffect(() => {
    let live = true;
    setGroups(null);
    setError(null);
    api.get('/leads/groups', { query: { ...baseQuery, by } })
      .then((r) => { if (live) setGroups(r.data ?? []); })
      .catch((err) => { if (live) { setGroups([]); setError(err instanceof ApiError ? err.message : 'Could not load the board.'); } });
    return () => { live = false; };
    // A changed filter reloads the page, which bumps `version`: one fetch, not two.
  }, [by, version]);

  const columns = useMemo(() => {
    if (!groups) return null;
    if (by === 'stage') {
      // Every stage is a column, empty or not, so a card can be dropped into it.
      const counts = new Map(groups.map((g) => [g.key, g.count]));
      return (meta?.stages ?? [])
        .filter((s) => (!baseQuery.stage_kind || s.kind === baseQuery.stage_kind) && (!baseQuery.stage_id || s.id === baseQuery.stage_id))
        .map((s) => ({ key: s.id, label: s.name, color: s.color, count: counts.get(s.id) ?? 0, filter: { stage_id: s.id } }));
    }
    return groups.map((g) => ({ ...g, label: by === 'form' ? formName({ value: g.key, named: g.label != null, source: g.source }) : g.label }));
  }, [groups, by, meta, baseQuery.stage_kind, baseQuery.stage_id]);

  const canAssign = can('leads.leads.assign');
  const movable = can('leads.leads.edit') && (by === 'stage' || by === 'owner');
  const accepts = (column) => by === 'stage' || (by === 'owner' && (canAssign || (column.key !== 'unassigned' && column.key !== user?.id)));

  async function drop(column, lead) {
    if (!lead || !accepts(column)) return;
    const current = by === 'stage' ? lead.stage_id : lead.owner_user_id ?? 'unassigned';
    if (current === column.key) return;
    try {
      if (by === 'stage') await api.post('/leads/leads/bulk', { ids: [lead.id], action: 'stage', stage_id: column.key });
      else await api.post('/leads/leads/bulk', { ids: [lead.id], action: 'assign', owner_user_id: column.key === 'unassigned' ? null : column.key });
      toast.success(by === 'stage' ? `${lead.name} moved to ${column.label}` : `${lead.name} ${canAssign ? 'assigned to' : 'handed over to'} ${column.label}`);
      onMoved?.();
    } catch (err) {
      toast.error('Could not move that lead', { description: err instanceof ApiError ? err.message : undefined });
    }
  }

  if (!columns) {
    return (
      <div className="flex gap-3 overflow-hidden">
        {[0, 1, 2].map((n) => <Skeleton key={n} className="h-80 w-72 shrink-0 rounded-[var(--radius-lg)]" />)}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {error && <Alert tone="critical">{error}</Alert>}
      {!columns.length && !error ? (
        <p className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border-default)] px-4 py-10 text-center text-sm text-[var(--text-tertiary)]">No leads match.</p>
      ) : (
        <div className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-3 md:mx-0 md:px-0">
          {columns.map((column) => (
            <BoardColumn
              key={`${by}:${column.key}:${version}`}
              column={column}
              by={by}
              baseQuery={baseQuery}
              onOpen={onOpen}
              draggable={movable}
              dropping={target === column.key}
              onDragStart={setDragging}
              onDragEnd={() => { setDragging(null); setTarget(null); }}
              onDragOver={(e) => { if (dragging && accepts(column)) { e.preventDefault(); setTarget(column.key); } }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setTarget(null); }}
              onDrop={(e) => { e.preventDefault(); const lead = dragging; setDragging(null); setTarget(null); drop(column, lead); }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function BoardColumn({ column, by, baseQuery, onOpen, draggable, dropping, onDragStart, onDragEnd, onDragOver, onDragLeave, onDrop }) {
  const [rows, setRows] = useState(null);
  const [page, setPage] = useState(1);
  const [more, setMore] = useState(false);

  useEffect(() => {
    let live = true;
    setMore(true);
    api.get('/leads/leads', { query: { ...baseQuery, ...column.filter, page, limit: PAGE } })
      .then((r) => { if (live) setRows((current) => (page === 1 ? r.data : [...(current ?? []), ...r.data])); })
      .catch(() => { if (live) setRows((current) => current ?? []); })
      .finally(() => { if (live) setMore(false); });
    return () => { live = false; };
    // Columns are rebuilt whenever the filters change, so only `page` moves here.
  }, [page]);

  return (
    <section
      className={cn(
        'flex max-h-[70vh] w-72 shrink-0 snap-start flex-col rounded-[var(--radius-lg)] border bg-[var(--surface-sunken)] transition-colors',
        dropping ? 'border-[var(--color-brand-500)] bg-[var(--color-brand-50)] dark:bg-[rgb(99_102_241/0.10)]' : 'border-[var(--border-subtle)]',
      )}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      aria-label={`${column.label}, ${column.count} lead${column.count === 1 ? '' : 's'}`}
    >
      <header className="flex items-center gap-2 px-3 pb-2 pt-3">
        {by === 'stage'
          ? <span className={cn('truncate rounded-full px-2 py-0.5 text-xs font-medium', tintFor(column.color))}>{column.label}</span>
          : by === 'owner'
            ? <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium"><Avatar name={column.label} size="xs" /><span className="truncate">{column.label}</span></span>
            : <span className={cn('min-w-0 truncate text-sm font-medium', column.key === 'overdue' && 'text-[var(--color-critical-600)]')} title={column.label}>{column.label}</span>}
        <span className="tabular ml-auto text-xs text-[var(--text-tertiary)]">{column.count}</span>
      </header>
      <div className="min-h-24 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
        {!rows ? <><Skeleton className="h-20" /><Skeleton className="h-20" /></> : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-1 py-6 text-center text-xs text-[var(--text-tertiary)]">
            <Inbox className="size-4" />{draggable ? 'Drop a lead here' : 'Nothing here'}
          </div>
        ) : rows.map((lead) => (
          <LeadCard key={lead.id} lead={lead} by={by} onOpen={onOpen} draggable={draggable} onDragStart={onDragStart} onDragEnd={onDragEnd} />
        ))}
        {rows && rows.length < column.count && (
          <Button size="sm" variant="ghost" className="w-full" loading={more} onClick={() => setPage((p) => p + 1)}>
            Show more ({column.count - rows.length})
          </Button>
        )}
      </div>
    </section>
  );
}

function LeadCard({ lead, by, onOpen, draggable, onDragStart, onDragEnd }) {
  const due = dueLabel(lead.next_followup_at);
  const wa = whatsappLink(lead.phone, `Hi ${lead.first_name ?? ''},`.trim());
  return (
    <article
      draggable={draggable}
      onDragStart={(e) => { e.dataTransfer.setData('text/plain', lead.id); onDragStart(lead); }}
      onDragEnd={onDragEnd}
      onClick={() => onOpen(lead.id)}
      className={cn(
        'cursor-pointer rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-2.5 shadow-xs hover:border-[var(--border-default)]',
        draggable && 'active:cursor-grabbing',
      )}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 truncate text-sm font-medium">
            {lead.name}
            {lead.rating === 'hot' && <Badge size="sm" tone="critical">hot</Badge>}
          </p>
          <p className="truncate text-xs text-[var(--text-tertiary)]">{[lead.phone, lead.city, lead.company_name].filter(Boolean).join(' · ') || lead.email || '—'}</p>
        </div>
        <div className="flex shrink-0 gap-0.5" onClick={(e) => e.stopPropagation()}>
          {lead.phone && <a href={telLink(lead.phone)} aria-label={`Call ${lead.name}`} title="Call" className="rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-brand)]"><Phone className="size-3.5" /></a>}
          {wa && <a href={wa} target="_blank" rel="noreferrer" aria-label={`WhatsApp ${lead.name}`} title="WhatsApp" className="rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--color-positive-600)]"><MessageCircle className="size-3.5" /></a>}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-2xs">
        {by !== 'stage' && <StageBadge name={lead.stage_name} color={lead.stage_color} className="text-2xs" />}
        {lead.last_call_outcome && <Badge size="sm" tone={OUTCOME_TONE[lead.last_call_outcome]}>{OUTCOME_LABEL[lead.last_call_outcome]}</Badge>}
        {lead.next_followup_at && (
          <span className={cn(due.overdue ? 'font-medium text-[var(--color-critical-600)]' : due.today ? 'font-medium text-[var(--color-caution-700)]' : 'text-[var(--text-secondary)]')}>{due.text}</span>
        )}
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 text-2xs text-[var(--text-tertiary)]">
        {by !== 'owner' && (lead.owner ? <><Avatar name={lead.owner.name ?? '?'} size="xs" /><span className="truncate">{lead.owner.name}</span></> : <span className="text-[var(--color-caution-700)]">Unassigned</span>)}
        {by !== 'form' && <span className="ml-auto truncate" title={lead.source_detail ?? undefined}>{formName({ value: lead.source_detail ?? lead.source, named: Boolean(lead.source_detail), source: lead.source })}</span>}
      </div>
    </article>
  );
}
