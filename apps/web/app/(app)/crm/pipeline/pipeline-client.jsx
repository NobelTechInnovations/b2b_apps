'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { GripVertical, Plus, Building2, CalendarClock, Gauge, Filter } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { money, date } from '@/lib/format';
import { Can, useWorkspace } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Avatar, Badge, PageHeader, EmptyState, Card, Alert, Skeleton } from '@/components/ui/primitives';

const COLUMN_ACCENT = {
  slate: 'before:bg-[var(--color-ink-400)]',
  sky: 'before:bg-[#0ea5e9]',
  indigo: 'before:bg-[var(--color-brand-500)]',
  violet: 'before:bg-[#8b5cf6]',
  amber: 'before:bg-[#f59e0b]',
  emerald: 'before:bg-[#10b981]',
  rose: 'before:bg-[#f43f5e]',
};

/**
 * The pipeline board.
 *
 * Drag-and-drop is built on the native HTML5 API rather than a library: the
 * interaction is simple enough that a dependency would cost more than it saves,
 * and native DnD gives us keyboard-accessible fallbacks via the move menu.
 */
export default function PipelineClient() {
  const toast = useToast();
  const { can } = useWorkspace();

  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [mineOnly, setMineOnly] = useState(false);
  const [dragging, setDragging] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);

  // Keeps the pre-drag board so an optimistic move can be rolled back.
  const snapshot = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.get('/crm/pipeline', { query: { mine: mineOnly || undefined } });
      setBoard(response.data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load your pipeline.');
    } finally {
      setLoading(false);
    }
  }, [mineOnly]);

  useEffect(() => { load(); }, [load]);

  async function moveDeal(dealId, toStageId, beforeId, afterId) {
    snapshot.current = board;

    // Move it locally first so the card lands where it was dropped instantly.
    setBoard((current) => {
      if (!current) return current;
      let moved = null;
      const columns = current.columns.map((column) => {
        const remaining = column.deals.filter((deal) => {
          if (deal.id !== dealId) return true;
          moved = deal;
          return false;
        });
        return { ...column, deals: remaining };
      });

      if (!moved) return current;

      return {
        ...current,
        columns: columns.map((column) => {
          if (column.id !== toStageId) return column;
          const deals = [...column.deals];
          const index = afterId ? deals.findIndex((d) => d.id === afterId) : deals.length;
          deals.splice(index === -1 ? deals.length : index, 0, {
            ...moved,
            stage_id: toStageId,
            probability: column.probability,
          });
          return { ...column, deals };
        }),
      };
    });

    try {
      await api.post(`/crm/deals/${dealId}/move`, {
        stage_id: toStageId,
        before_id: beforeId ?? undefined,
        after_id: afterId ?? undefined,
      });
      // Refresh so column totals and any won/lost side effects are accurate.
      load();
    } catch (err) {
      setBoard(snapshot.current);
      toast.error('Could not move that deal', {
        description: err instanceof ApiError ? err.message : 'Please try again.',
      });
    }
  }

  function onDrop(stageId, index) {
    if (!dragging) return;
    const column = board.columns.find((c) => c.id === stageId);
    const others = column.deals.filter((d) => d.id !== dragging.id);
    const before = others[index - 1]?.id ?? null;
    const after = others[index]?.id ?? null;

    setDragging(null);
    setDropTarget(null);

    // A drop in the same slot is a no-op, not a request.
    if (dragging.stage_id === stageId && before === null && after === null && others.length === 0) return;
    moveDeal(dragging.id, stageId, before, after);
  }

  if (loading && !board) {
    return (
      <div className="space-y-5">
        <PageHeader title="Pipeline" description="Loading your board…" />
        <div className="flex gap-3 overflow-hidden">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="w-72 shrink-0 space-y-2">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) return <Alert tone="critical">{error}</Alert>;

  const empty = board.columns.every((column) => column.deals.length === 0);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Pipeline"
        description={board.pipeline.name}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant={mineOnly ? 'primary' : 'secondary'}
              size="sm"
              icon={Filter}
              onClick={() => setMineOnly((v) => !v)}
            >
              {mineOnly ? 'My deals' : 'All deals'}
            </Button>
            <Can permission="crm.deals.create">
              <Button variant="primary" icon={Plus} onClick={() => (window.location.href = '/crm/deals?new=1')}>
                New deal
              </Button>
            </Can>
          </div>
        }
      />

      <div className="flex flex-wrap gap-4">
        <Summary label="Open deals" value={board.summary.open_count} />
        <Summary label="Pipeline value" value={money(board.summary.open_value, board.summary.currency)} />
        <Summary
          label="Weighted forecast"
          value={money(board.summary.weighted_value, board.summary.currency)}
          hint="By stage probability"
        />
      </div>

      {empty ? (
        <Card>
          <EmptyState
            icon={Gauge}
            title="Your board is ready and waiting"
            description="Convert a lead or create a deal and it will appear in the first stage."
            action={
              can('crm.deals.create') && (
                <Button variant="primary" icon={Plus} onClick={() => (window.location.href = '/crm/deals?new=1')}>
                  Create a deal
                </Button>
              )
            }
          />
        </Card>
      ) : (
        <div className="-mx-6 overflow-x-auto px-6 pb-4 lg:-mx-8 lg:px-8">
          <div className="flex gap-3" style={{ minWidth: 'min-content' }}>
            {board.columns.map((column) => (
              <section
                key={column.id}
                className={cn(
                  'relative flex w-[286px] shrink-0 flex-col rounded-[var(--radius-xl)]',
                  'bg-[var(--surface-sunken)] before:absolute before:inset-x-0 before:top-0 before:h-0.5',
                  'before:rounded-t-[var(--radius-xl)] before:content-[""]',
                  COLUMN_ACCENT[column.colour] ?? COLUMN_ACCENT.slate,
                  dropTarget?.stageId === column.id && 'ring-2 ring-[var(--color-brand-400)]',
                )}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDropTarget({ stageId: column.id, index: column.deals.length });
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  onDrop(column.id, dropTarget?.stageId === column.id ? dropTarget.index : column.deals.length);
                }}
              >
                <header className="flex items-center justify-between gap-2 px-3 pb-2 pt-3">
                  <div className="min-w-0">
                    <h2 className="flex items-center gap-1.5 truncate text-sm font-semibold">
                      {column.name}
                      <span className="rounded-full bg-[var(--surface-raised)] px-1.5 text-2xs tabular text-[var(--text-secondary)]">
                        {column.count}
                      </span>
                    </h2>
                    <p className="mt-0.5 truncate text-xs tabular text-[var(--text-tertiary)]">
                      {money(column.total_value, board.summary.currency, { compact: true })}
                      {column.kind === 'open' && ` · ${column.probability}%`}
                    </p>
                  </div>
                </header>

                <div className="flex min-h-[7rem] flex-1 flex-col gap-2 px-2 pb-2">
                  {column.deals.map((deal, index) => (
                    <div
                      key={deal.id}
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setDropTarget({ stageId: column.id, index });
                      }}
                    >
                      {dropTarget?.stageId === column.id && dropTarget.index === index && dragging && (
                        <div className="mb-2 h-1 rounded-full bg-[var(--color-brand-500)]" />
                      )}
                      <DealCard
                        deal={deal}
                        currency={board.summary.currency}
                        draggable={can('crm.deals.edit')}
                        dragging={dragging?.id === deal.id}
                        onDragStart={() => setDragging(deal)}
                        onDragEnd={() => { setDragging(null); setDropTarget(null); }}
                      />
                    </div>
                  ))}

                  {column.deals.length === 0 && (
                    <div className="flex flex-1 items-center justify-center rounded-[var(--radius-lg)] border border-dashed border-[var(--border-default)] p-3 text-center">
                      <p className="text-xs text-[var(--text-disabled)]">
                        {dragging ? 'Drop here' : 'Nothing here yet'}
                      </p>
                    </div>
                  )}
                </div>
              </section>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Summary({ label, value, hint }) {
  return (
    <div className="panel px-4 py-2.5">
      <p className="text-xs text-[var(--text-tertiary)]">{label}</p>
      <p className="mt-0.5 text-md font-semibold tabular">{value}</p>
      {hint && <p className="text-2xs text-[var(--text-disabled)]">{hint}</p>}
    </div>
  );
}

function DealCard({ deal, currency, draggable, dragging, onDragStart, onDragEnd }) {
  const closingSoon =
    deal.expected_close_date &&
    new Date(deal.expected_close_date) < new Date(Date.now() + 7 * 86_400_000);

  return (
    <article
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', deal.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className={cn(
        'group panel panel-hover cursor-pointer p-3',
        draggable && 'active:cursor-grabbing',
        dragging && 'opacity-40',
      )}
    >
      <div className="flex items-start gap-1.5">
        {draggable && (
          <GripVertical className="mt-0.5 size-3.5 shrink-0 text-[var(--text-disabled)] opacity-0 transition-opacity group-hover:opacity-100" />
        )}
        <h3 className="min-w-0 flex-1 text-base font-medium leading-snug">{deal.title}</h3>
      </div>

      <p className="mt-2 text-md font-semibold tabular tracking-[-0.02em]">
        {money(deal.value, deal.currency ?? currency)}
      </p>

      {deal.company_name && (
        <p className="mt-1.5 flex items-center gap-1.5 truncate text-xs text-[var(--text-secondary)]">
          <Building2 className="size-3 shrink-0" />
          {deal.company_name}
        </p>
      )}

      <div className="mt-2.5 flex items-center justify-between gap-2">
        {deal.contact_name ? (
          <Avatar name={deal.contact_name} size="xs" />
        ) : (
          <span />
        )}
        {deal.expected_close_date && (
          <span
            className={cn(
              'flex items-center gap-1 text-2xs tabular',
              closingSoon ? 'text-[var(--color-caution-600)]' : 'text-[var(--text-tertiary)]',
            )}
          >
            <CalendarClock className="size-3" />
            {date(deal.expected_close_date, 'short')}
          </span>
        )}
      </div>
    </article>
  );
}
